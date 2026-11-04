/**
 * Message pane windowing (I-28a). Pure geometry, no DOM: row heights are
 * measured after render and cached by a stable row id; unmeasured rows use an
 * estimate. Only the rows near the viewport are mounted, between two spacers.
 *
 * The reading anchor is `{scope, key, offset}`: `key` is the pre-parsed
 * {@link HistoryKey} of the first visible row and `offset` is the distance
 * from the viewport top to that row's top (<= 0 for a partly scrolled row, > 0 only inside the history runway).
 * It is resolved against the *model* (message list + layout), so it survives
 * a re-render, a page prepend or a window change without reading the DOM.
 */
import type { HistoryKey, KeyedMessage } from './history-key.ts';
import { historyKeyMatchesMessage, historyKeyString } from './history-key.ts';

export const ROW_ESTIMATE = 76;
/** Rows mounted beyond the viewport on each side when a window is (re)computed. */
export const ROW_OVERSCAN = 12;
/**
 * Hysteresis: a mounted window is kept while it still has at least this many
 * rows of buffer before and after the viewport, so scrolling swaps windows
 * about every `ROW_OVERSCAN - ROW_MARGIN` rows instead of every row.
 */
export const ROW_MARGIN = 4;

export interface Layout {
  readonly count: number;
  /** `tops[i]` is the top of row i; `tops[count]` is the total height. */
  readonly tops: Float64Array;
}

export interface WindowRange { readonly start: number; readonly end: number }

export interface MessageAnchor {
  readonly scope: string;
  readonly key: HistoryKey;
  readonly offset: number;
}

export function buildLayout(count: number, heightAt: (index: number) => number): Layout {
  const tops = new Float64Array(count + 1);
  for (let i = 0; i < count; i++) {
    const height = heightAt(i);
    tops[i + 1] = tops[i]! + (Number.isFinite(height) && height > 0 ? height : ROW_ESTIMATE);
  }
  return { count, tops };
}

export function layoutTotal(layout: Layout): number { return layout.tops[layout.count]!; }

/** Index of the row containing `y` (clamped to a valid row; -1 for an empty layout). */
export function rowIndexAt(layout: Layout, y: number): number {
  if (layout.count === 0) return -1;
  let lo = 0, hi = layout.count - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (layout.tops[mid]! <= y) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/** Rows intersecting [top, top + height) plus overscan on both sides. */
export function windowRange(layout: Layout, top: number, height: number, overscan = ROW_OVERSCAN): WindowRange {
  if (layout.count === 0) return { start: 0, end: 0 };
  const y = Math.max(0, top);
  const first = rowIndexAt(layout, y);
  const last = rowIndexAt(layout, y + Math.max(1, height) - 1);
  return { start: Math.max(0, first - overscan), end: Math.min(layout.count, last + 1 + overscan) };
}

export function sameRange(a: WindowRange | undefined, b: WindowRange | undefined): boolean {
  return !!a && !!b && a.start === b.start && a.end === b.end;
}

/**
 * True when the mounted `range` still covers [top, top + height) with at least
 * `margin` rows of buffer on each side (clamped at the list ends), so the
 * window can stay as it is. A range that no longer fits the layout is never
 * kept.
 */
export function coversViewport(layout: Layout, range: WindowRange, top: number, height: number, margin = ROW_MARGIN): boolean {
  if (layout.count === 0) return range.start === 0 && range.end === 0;
  if (range.start < 0 || range.end > layout.count || range.start >= range.end) return false;
  const y = Math.max(0, top);
  const first = rowIndexAt(layout, y);
  const last = rowIndexAt(layout, y + Math.max(1, height) - 1);
  if (range.start > first || last >= range.end) return false;
  return range.start <= Math.max(0, first - margin) && range.end >= Math.min(layout.count, last + 1 + margin);
}

/** Anchor on the first row whose bottom edge is below the viewport top. */
export function captureAnchor(layout: Layout, scrollTop: number, scope: string, keyAt: (index: number) => HistoryKey | null): MessageAnchor | null {
  // The offset is not clamped: above row 0 (the history runway) the row sits below the viewport top, offset > 0.
  for (let i = rowIndexAt(layout, Math.max(0, scrollTop)); i >= 0 && i < layout.count; i++) {
    const key = keyAt(i);
    if (key) return { scope, key, offset: layout.tops[i]! - scrollTop };
    // An unkeyed row (no identity) cannot anchor; fall through to the next one.
  }
  return null;
}

// Immutable snapshots own bounded lookup results, including absent/ambiguous
// identities. Offsets do not affect identity; both scopes prevent cross-pane reuse.
const anchorIndexes = new WeakMap<readonly KeyedMessage[], Map<string, number>>();
const ANCHOR_CACHE_LIMIT = 256;

/**
 * Resolve the anchor row in a (possibly changed) list. Exactly one match is
 * required: identity is unique by the core guarantee, so zero or several
 * matches mean the row is gone or the key is stale and nothing is guessed.
 */
export function findAnchorIndex(messages: readonly KeyedMessage[], anchor: MessageAnchor): number {
  let cache = anchorIndexes.get(messages);
  const identity = JSON.stringify([anchor.scope, historyKeyString(anchor.key)]);
  const cached = cache?.get(identity);
  if (cached !== undefined) return cached;
  let found = -1;
  for (let i = 0; i < messages.length; i++) {
    if (!historyKeyMatchesMessage(anchor.key, messages[i]!)) continue;
    if (found >= 0) { found = -1; break; }
    found = i;
  }
  if (!cache) { cache = new Map(); anchorIndexes.set(messages, cache); }
  if (cache.size >= ANCHOR_CACHE_LIMIT) cache.clear();
  cache.set(identity, found);
  return found;
}

/** Scroll position that puts row `index` at `offset` below the viewport top. */
export function scrollTopFor(layout: Layout, index: number, offset: number): number {
  return Math.max(0, layout.tops[index]! - offset);
}

/** Measured row heights for one pane scope. */
export class RowHeights {
  #scope = '';
  #rev = 0;
  readonly #heights = new Map<string, number>();
  /** Switching scope drops the cache so conversations never share geometry. */
  use(scope: string): void {
    if (scope === this.#scope) return;
    this.#scope = scope;
    this.#heights.clear();
    this.#rev++;
  }
  get(id: string): number { return this.#heights.get(id) ?? ROW_ESTIMATE; }
  /** Returns true when the cached value moved by more than half a pixel. */
  set(id: string, height: number): boolean {
    if (!(height > 0) || !Number.isFinite(height)) return false;
    const previous = this.#heights.get(id);
    if (previous !== undefined && Math.abs(previous - height) <= 0.5) return false;
    this.#heights.set(id, height);
    this.#rev++;
    return true;
  }
  get size(): number { return this.#heights.size; }
  /** Changes whenever any cached height changes; a layout built at the same rev over the same list is still valid. */
  get rev(): number { return this.#rev; }
}

/** Stable per-row id for the height cache (local id survives server confirmation). */
export function rowId(message: { readonly message_id: string | null; readonly local_id: string | null; readonly create_time_ms: number; readonly kind: string; readonly text: string }): string {
  if (message.local_id) return `l:${message.local_id}`;
  if (message.message_id) return `m:${message.message_id}`;
  return `s:${message.create_time_ms}:${message.kind}:${message.text.length}`;
}
