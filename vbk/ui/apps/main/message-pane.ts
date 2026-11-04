/**
 * Message pane window controller (I-28a / I-08). Owns the mounted-range
 * decision, the measured-height cache and the reading anchor, with no DOM:
 * main.ts feeds it scroll geometry and measured rows and applies the result.
 *
 * Coordinates: `y` is a position inside the row model (row 0 starts at y=0);
 * the pane's own scrollTop is `header + slack + y`, where `header` is the fixed
 * content above the first row (load-earlier button, status line, padding) and
 * `slack` is the free height of the top spacer.
 *
 * scrollTop belongs to the user. A mounted pane may be mid-gesture with the
 * compositor ahead of the main thread, so writing the offset to compensate for
 * layout throws that motion away and the content visibly snaps back. Whatever
 * moves content above the viewport (a prepended page, an estimate replaced by a
 * real height, media resolving) is absorbed by `slack`: rows keep their document
 * position and the offset stays untouched. While older history exists, `slack`
 * also holds a runway, so the top of the loaded rows is not a wall. The offset
 * is rewritten only by `rebase`, when the slack itself has to be reset.
 */
import type { HistoryKey, KeyedMessage } from './history-key.ts';
import { historyKeyOf } from './history-key.ts';
import type { Layout, MessageAnchor, WindowRange } from './message-window.ts';
import { RowHeights, buildLayout, captureAnchor, coversViewport, findAnchorIndex, layoutTotal, rowId, sameRange, scrollTopFor, windowRange } from './message-window.ts';

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
  /** New pane scrollTop; null (the normal case for a retained pane) leaves it alone. */
  readonly scrollTo: number | null;
  /** Top spacer height that keeps the rows in place. Apply it before `scrollTo`. */
  readonly topSpacer: number;
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
/** Scrollable height reserved above row 0 while older history exists. */
export const HISTORY_RUNWAY = 16_000;
/** Start reading the next page while the first row is still this far above the viewport. */
export function historyPrefetchDistance(viewport: number): number { return Math.max(3000, viewport * 4); }

/**
 * The scrollTop change needed to reset `slack` to `target`; 0 leaves the offset alone.
 * Rewriting the offset is the one thing that can disturb a gesture, so it waits for `idle`
 * unless the layout leaves no choice: the spacer cannot go negative, rows must not become
 * unreachable above the scroll origin, and a gap above the real first row must not show.
 */
function rebase(slack: number, target: number, scrollTop: number, header: number, rowsAbove: number, viewport: number, idle: boolean): number {
  // Whole pixels: the browser may snap the offset, and a fraction lost there would nudge every row.
  const shift = Math.round(target - slack);
  if (shift === 0) return 0;
  if (slack + rowsAbove < 0) return shift;
  if (slack < target && scrollTop < viewport) return shift;
  if (target === 0) return idle || (slack > 0 && scrollTop - header - slack < viewport) ? shift : 0;
  return idle && (slack < target / 2 || slack > target * 2) ? shift : 0;
}

export function createMessagePane() {
  const heights = new RowHeights();
  let current: { scope: string; list: readonly PaneMessage[]; layout: Layout; layoutRev: number; range: WindowRange; header: number; slack: number; runway: number; retained: boolean } | null = null;

  /** The O(n) prefix sum is rebuilt only when the list or a cached height changed (every render calls this). */
  const relayout = (scope: string, list: readonly PaneMessage[]): Layout => {
    heights.use(scope);
    if (current && current.scope === scope && current.list === list && current.layoutRev === heights.rev) return current.layout;
    return buildLayout(list.length, i => heights.get(rowId(list[i]!)));
  };

  return {
    /**
     * Decide the window for a render. `anchor` wins over the stored `view.top`; `pinned` wins over both.
     * The mounted window is kept (hysteresis) while the same list still has it covering the viewport
     * with a row margin; a different list identity (history prepend shifts every index) always recomputes.
     */
    plan(input: { scope: string; list: readonly PaneMessage[]; view: PaneView | undefined; pinned: boolean; anchor: MessageAnchor | null; retained?: boolean; runway?: number }): PaneWindow {
      const { scope, list } = input;
      const runway = input.runway ?? 0;
      // A retained pane keeps its offset, so its slack carries over; a new pane starts clean and `sync` positions it.
      const retained = input.retained === true && current?.scope === scope;
      const layout = relayout(scope, list);
      const viewport = input.view?.height || DEFAULT_VIEWPORT;
      const header = current?.scope === scope ? current.header : 0;
      let y: number;
      const anchor = !input.pinned && input.anchor?.scope === scope ? input.anchor : null;
      const index = anchor ? findAnchorIndex(list, anchor) : -1;
      if (input.pinned) y = Math.max(0, layoutTotal(layout) - viewport);
      else if (anchor && index >= 0) y = scrollTopFor(layout, index, anchor.offset);
      else y = input.view?.top ?? 0;
      let slack = retained ? current!.slack : runway;
      if (input.pinned) slack = runway;
      else if (retained && anchor && index >= 0) {
        // Same row, same document position: whatever was added above it comes out of the slack.
        const before = findAnchorIndex(current!.list, anchor);
        if (before >= 0) slack += current!.layout.tops[before]! - layout.tops[index]!;
      }
      const keep = !!current && current.scope === scope && current.list === list && coversViewport(layout, current.range, y, viewport);
      const range = keep ? current!.range : windowRange(layout, y, viewport);
      current = { scope, list, layout, layoutRev: heights.rev, range, header, slack, runway, retained };
      return { range, topSpacer: Math.max(0, slack + layout.tops[range.start]!), bottomSpacer: layoutTotal(layout) - layout.tops[range.end]! };
    },

    /** Capture the reading row from the model. Returns why it could not, for diagnostics. */
    capture(scope: string | null, geometry: PaneGeometry | null): Capture {
      if (!geometry || !current) return { skip: 'no_pane' };
      if (!scope || current.scope !== scope) return { skip: 'wrong_scope' };
      if (geometry.scrollHeight - geometry.clientHeight - geometry.scrollTop < PIN_THRESHOLD) return { skip: 'pinned' };
      const list = current.list;
      const anchor = captureAnchor(current.layout, geometry.scrollTop - current.header - current.slack, scope, i => {
        const message = list[i]!;
        return message.message_id || message.local_id ? historyKeyOf(scope, message) : null;
      });
      return anchor ? { anchor } : { skip: 'no_anchor' };
    },

    /**
     * After mounting (or after media resized a row): learn real heights, then
     * hold the anchor row where it is and say whether the window moved. A retained
     * pane holds it through the top spacer; only a new pane is positioned by scrollTop.
     * `idle` means no scrolling is in flight, so a pending rebase is safe to apply.
     */
    sync(scope: string, geometry: PaneGeometry, measured: MeasuredPane, anchor: MessageAnchor | null, pinned: boolean, idle = false): SyncResult | null {
      if (!current || current.scope !== scope) return null;
      let measuredChanged = false;
      for (const row of measured.rows) if (heights.set(row.id, row.height)) measuredChanged = true;
      current.header = measured.header;
      current.layout = relayout(scope, current.list);
      current.layoutRev = heights.rev;
      let scrollTo: number | null = null;
      const target = current.runway;
      let slack = current.retained ? current.slack : target;
      const index = !pinned && anchor?.scope === scope ? findAnchorIndex(current.list, anchor) : -1;
      if (pinned) slack = target;
      else if (index >= 0) {
        const fixed = current.header + current.layout.tops[index]! - anchor!.offset;
        if (current.retained) slack = geometry.scrollTop - fixed;
        else if (Math.abs(geometry.scrollTop - Math.max(0, fixed + slack)) >= 1) scrollTo = Math.max(0, fixed + slack);
      }
      if (!pinned) {
        // Deep in the runway nothing but placeholders is visible: keep the first row at the viewport's lower
        // edge, so a page that lands now shows up immediately instead of somewhere far below.
        const ahead = (scrollTo ?? geometry.scrollTop) - current.header - slack + geometry.clientHeight;
        if (ahead < 0) slack += ahead;
        const shift = rebase(slack, target, scrollTo ?? geometry.scrollTop, current.header, current.layout.tops[current.range.start]!, geometry.clientHeight, idle);
        if (shift !== 0) { scrollTo = Math.max(0, (scrollTo ?? geometry.scrollTop) + shift); slack += shift; }
      }
      current.slack = slack;
      current.retained = true;
      const top = Math.max(0, (scrollTo ?? geometry.scrollTop) - current.header - slack);
      // Spacers stand in for unmounted rows only, so a measured (mounted) row never invalidates them:
      // the window needs a re-render exactly when the mounted range no longer covers the viewport with its margin.
      return { scrollTo, topSpacer: Math.max(0, slack + current.layout.tops[current.range.start]!), rerender: !coversViewport(current.layout, current.range, top, geometry.clientHeight), measuredChanged, top };
    },

    /** Window needed for a scroll position, without touching the model. `changed` is false while the mounted window still has its margin. */
    rangeFor(geometry: PaneGeometry): { range: WindowRange; top: number; changed: boolean } | null {
      if (!current) return null;
      const top = Math.max(0, geometry.scrollTop - current.header - current.slack);
      const changed = !coversViewport(current.layout, current.range, top, geometry.clientHeight);
      return { range: changed ? windowRange(current.layout, top, geometry.clientHeight) : current.range, top, changed };
    },

    /** Row ids that should currently be mounted, in order. */
    mountedIds(): string[] {
      if (!current) return [];
      return current.list.slice(current.range.start, current.range.end).map(rowId);
    },
    layoutTotal: (): number => (current ? layoutTotal(current.layout) : 0),
    header: (): number => current?.header ?? 0,
    /** Model position of the viewport top: how far the first row is above it (negative inside the runway). */
    distanceToHead: (scrollTop: number): number => (current ? scrollTop - current.header - current.slack : scrollTop),
    /** The gesture has run into something only `sync` can resolve: the first row left the viewport below, or a rebase can no longer wait. */
    outOfBand(geometry: PaneGeometry): boolean {
      if (!current) return false;
      return geometry.scrollTop - current.header - current.slack < -geometry.clientHeight
        || rebase(current.slack, current.runway, geometry.scrollTop, current.header, current.layout.tops[current.range.start]!, geometry.clientHeight, false) !== 0;
    },
    /** False until the current pane has been positioned once; a stored anchor only applies before that. */
    retained: (): boolean => current?.retained ?? false,
    measuredCount: (): number => heights.size,
  };
}

export type MessagePane = ReturnType<typeof createMessagePane>;
export type { HistoryKey };
