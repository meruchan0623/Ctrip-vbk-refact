/**
 * Message pane window controller (I-28a / I-08). Owns the mounted-range
 * decision, the measured-height cache and the reading anchor, with no DOM:
 * main.ts feeds it scroll geometry and measured rows and applies the result.
 *
 * Coordinates: `y` is a position inside the row model (row 0 starts at y=0);
 * the pane's own scrollTop is `header + y`, where `header` is whatever sits
 * above the first row (load-earlier button, status line, padding).
 */
import type { HistoryKey, KeyedMessage } from './history-key.ts';
import { historyKeyOf } from './history-key.ts';
import type { Layout, MessageAnchor, WindowRange } from './message-window.ts';
import { RowHeights, buildLayout, captureAnchor, findAnchorIndex, layoutTotal, rowId, sameRange, scrollTopFor, windowRange } from './message-window.ts';

export type PaneMessage = KeyedMessage & { readonly create_time_ms: number; readonly kind: string; readonly text: string };

export interface PaneGeometry { readonly scrollTop: number; readonly clientHeight: number; readonly scrollHeight: number }
export interface MeasuredPane { readonly header: number; readonly rows: readonly { readonly id: string; readonly height: number }[] }

export interface PaneWindow {
  readonly range: WindowRange;
  /** Spacer heights that stand in for the unmounted rows. */
  readonly topSpacer: number;
  readonly bottomSpacer: number;
}

export interface PaneView { readonly scope: string; readonly top: number; readonly height: number; readonly anchor: MessageAnchor | null; readonly rev: number }

export type CaptureSkip = 'no_pane' | 'wrong_scope' | 'pinned' | 'no_anchor';
export type Capture = { readonly anchor: MessageAnchor } | { readonly skip: CaptureSkip };

export interface SyncResult {
  /** New pane scrollTop when the anchor moved; null leaves it alone. */
  readonly scrollTo: number | null;
  /** True when the mounted range or a spacer no longer matches the model. */
  readonly rerender: boolean;
  readonly measuredChanged: boolean;
  /** The window as it should be now (for the persisted view). */
  readonly top: number;
}

/** Same mounted range and the same spacer heights: the rendered pane would be identical. */
export function sameWindow(a: PaneWindow, b: PaneWindow): boolean {
  return sameRange(a.range, b.range) && a.topSpacer === b.topSpacer && a.bottomSpacer === b.bottomSpacer;
}

/** Bottom-pinned when within this many pixels of the end. */
export const PIN_THRESHOLD = 48;
export const DEFAULT_VIEWPORT = 800;

export function createMessagePane() {
  const heights = new RowHeights();
  let current: { scope: string; list: readonly PaneMessage[]; layout: Layout; layoutRev: number; range: WindowRange; header: number } | null = null;

  /** The O(n) prefix sum is rebuilt only when the list or a cached height changed (every render calls this). */
  const relayout = (scope: string, list: readonly PaneMessage[]): Layout => {
    heights.use(scope);
    if (current && current.scope === scope && current.list === list && current.layoutRev === heights.rev) return current.layout;
    return buildLayout(list.length, i => heights.get(rowId(list[i]!)));
  };

  return {
    /** Decide the window for a render. `anchor` wins over the stored `view.top`; `pinned` wins over both. */
    plan(input: { scope: string; list: readonly PaneMessage[]; view: PaneView | undefined; pinned: boolean; anchor: MessageAnchor | null }): PaneWindow {
      const { scope, list } = input;
      const layout = relayout(scope, list);
      const viewport = input.view?.height || DEFAULT_VIEWPORT;
      const header = current?.scope === scope ? current.header : 0;
      let y: number;
      const anchor = !input.pinned && input.anchor?.scope === scope ? input.anchor : null;
      const index = anchor ? findAnchorIndex(list, anchor) : -1;
      if (input.pinned) y = Math.max(0, layoutTotal(layout) - viewport);
      else if (anchor && index >= 0) y = scrollTopFor(layout, index, anchor.offset);
      else y = input.view?.top ?? 0;
      const range = windowRange(layout, y, viewport);
      current = { scope, list, layout, layoutRev: heights.rev, range, header };
      return { range, topSpacer: layout.tops[range.start]!, bottomSpacer: layoutTotal(layout) - layout.tops[range.end]! };
    },

    /** Capture the reading row from the model. Returns why it could not, for diagnostics. */
    capture(scope: string | null, geometry: PaneGeometry | null): Capture {
      if (!geometry || !current) return { skip: 'no_pane' };
      if (!scope || current.scope !== scope) return { skip: 'wrong_scope' };
      if (geometry.scrollHeight - geometry.clientHeight - geometry.scrollTop < PIN_THRESHOLD) return { skip: 'pinned' };
      const list = current.list;
      const anchor = captureAnchor(current.layout, geometry.scrollTop - current.header, scope, i => {
        const message = list[i]!;
        return message.message_id || message.local_id ? historyKeyOf(scope, message) : null;
      });
      return anchor ? { anchor } : { skip: 'no_anchor' };
    },

    /**
     * After mounting (or after media resized a row): learn real heights, then
     * put the anchor row back where it was and say whether the window moved.
     */
    sync(scope: string, geometry: PaneGeometry, measured: MeasuredPane, anchor: MessageAnchor | null, pinned: boolean): SyncResult | null {
      if (!current || current.scope !== scope) return null;
      let measuredChanged = false;
      for (const row of measured.rows) if (heights.set(row.id, row.height)) measuredChanged = true;
      current.header = measured.header;
      current.layout = relayout(scope, current.list);
      current.layoutRev = heights.rev;
      let scrollTo: number | null = null;
      if (!pinned && anchor?.scope === scope) {
        const index = findAnchorIndex(current.list, anchor);
        if (index >= 0) {
          const want = current.header + scrollTopFor(current.layout, index, anchor.offset);
          if (Math.abs(geometry.scrollTop - want) >= 1) scrollTo = want;
        }
      }
      const top = Math.max(0, (scrollTo ?? geometry.scrollTop) - current.header);
      const range = windowRange(current.layout, top, geometry.clientHeight);
      // Spacers stand in for unmounted rows only, so a measured (mounted) row never invalidates them:
      // the window needs a re-render exactly when the row range it should mount changed.
      return { scrollTo, rerender: !sameRange(range, current.range), measuredChanged, top };
    },

    /** Window needed for a scroll position, without touching the model. */
    rangeFor(geometry: PaneGeometry): { range: WindowRange; top: number; changed: boolean } | null {
      if (!current) return null;
      const top = Math.max(0, geometry.scrollTop - current.header);
      const range = windowRange(current.layout, top, geometry.clientHeight);
      return { range, top, changed: !sameRange(range, current.range) };
    },

    /** Row ids that should currently be mounted, in order. */
    mountedIds(): string[] {
      if (!current) return [];
      return current.list.slice(current.range.start, current.range.end).map(rowId);
    },
    layoutTotal: (): number => (current ? layoutTotal(current.layout) : 0),
    header: (): number => current?.header ?? 0,
    measuredCount: (): number => heights.size,
  };
}

export type MessagePane = ReturnType<typeof createMessagePane>;
export type { HistoryKey };
