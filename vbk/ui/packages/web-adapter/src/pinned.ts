/**
 * Local "置顶" (pin) map. The official page keeps `isTop` in local
 * conversation storage only; there is no server endpoint and therefore no
 * cross-device promise. Pinning affects display order only, never
 * conversation status, unread counts or waiting rounds (dev/10-im.md).
 */

export interface PinnedMap {
  pin(gid: string, atMs: number): void;
  unpin(gid: string): void;
  isPinned(gid: string): boolean;
  /** Sort key: pinned first (most recently pinned first), then the given secondary key. */
  compare(aGid: string, bGid: string, secondary: (a: string, b: string) => number): number;
  /** Serializable snapshot for per-account local persistence (gid → pinned-at ms). */
  snapshot(): Readonly<Record<string, number>>;
}

export function createPinnedMap(initial: Readonly<Record<string, number>> = {}): PinnedMap {
  const map = new Map<string, number>(Object.entries(initial));
  return {
    pin(gid, atMs) {
      map.set(gid, atMs);
    },
    unpin(gid) {
      map.delete(gid);
    },
    isPinned(gid) {
      return map.has(gid);
    },
    compare(a, b, secondary) {
      const pa = map.get(a);
      const pb = map.get(b);
      if (pa !== undefined && pb !== undefined) return pb - pa || secondary(a, b);
      if (pa !== undefined) return -1;
      if (pb !== undefined) return 1;
      return secondary(a, b);
    },
    snapshot() {
      return Object.fromEntries(map.entries());
    },
  };
}
