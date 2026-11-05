// Bounded per-conversation message cache for the main window.
//
// Only rows the host display cache can serve again are dropped: reopening an
// evicted conversation takes the ordinary first-page read. Drafts, waiting
// rounds and unread state live elsewhere and are never touched here.

/** Conversations kept besides the open one while the window is in use. */
export const MESSAGE_CACHE_RECENT = 12;
/** After this long hidden, only the open conversation keeps its rows. */
export const MESSAGE_CACHE_HIDDEN_MS = 5 * 60_000;

export interface CachedRow {
  readonly message_id: string | null;
  readonly disposition?: { readonly kind: string } | null;
}
export interface CachedHistory {
  readonly busy: boolean;
  readonly firstPage?: 'loading' | 'loaded' | 'error';
}
export interface MessageCacheState<M extends CachedRow, H extends CachedHistory> {
  readonly messages: Readonly<Record<string, readonly M[]>>;
  readonly history: Readonly<Record<string, H>>;
}

/** A local row or an unsettled send exists only here; its conversation must stay. */
export function hasUnsettledRow(rows: readonly CachedRow[]): boolean {
  return rows.some(row => row.message_id === null || row.disposition?.kind === 'unknown');
}

/** Most recently opened last; bounded so the order itself cannot grow. */
export function touchRecent(order: readonly string[], gid: string, limit = MESSAGE_CACHE_RECENT): string[] {
  const next = order.filter(item => item !== gid);
  next.push(gid);
  return next.slice(Math.max(0, next.length - limit - 1));
}

/**
 * Drops cached rows and paging state of conversations outside `keep`.
 * Returns `null` when nothing is evicted, so callers skip the state update.
 */
export function trimMessageCache<M extends CachedRow, H extends CachedHistory>(
  state: MessageCacheState<M, H>,
  keep: ReadonlySet<string>,
): MessageCacheState<M, H> | null {
  const evict = new Set<string>();
  for (const gid of new Set([...Object.keys(state.messages), ...Object.keys(state.history)])) {
    if (keep.has(gid)) continue;
    const history = state.history[gid];
    // An in-flight page compares its request object on return; leave it alone.
    if (history?.busy || history?.firstPage === 'loading') continue;
    if (hasUnsettledRow(state.messages[gid] ?? [])) continue;
    evict.add(gid);
  }
  if (evict.size === 0) return null;
  const without = <T>(source: Readonly<Record<string, T>>): Record<string, T> =>
    Object.fromEntries(Object.entries(source).filter(([gid]) => !evict.has(gid)));
  return { messages: without(state.messages), history: without(state.history) };
}

/** The conversations that keep their rows: the open one, plus recent ones unless long hidden. */
export function keptConversations(activeGid: string | null, recent: readonly string[], hiddenLong: boolean, limit = MESSAGE_CACHE_RECENT): Set<string> {
  const keep = new Set<string>(hiddenLong ? [] : recent.filter(gid => gid !== activeGid).slice(-limit));
  if (activeGid) keep.add(activeGid);
  return keep;
}
