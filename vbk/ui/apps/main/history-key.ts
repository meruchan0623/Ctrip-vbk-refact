/**
 * Pre-parsed history row key (I-28a). The string form is still written to
 * `data-history-key` (visible-read matches on it), but every comparison that
 * used to `JSON.parse` both sides per row now works on this struct.
 */
export interface HistoryKey {
  readonly scope: string;
  readonly mid: string | null;
  readonly lid: string | null;
  readonly role: string;
  readonly sender: string | null;
}

/** Fields of a message that take part in row identity. */
export interface KeyedMessage {
  readonly message_id: string | null;
  readonly local_id: string | null;
  readonly sender_role: string;
  readonly sender_id?: string | undefined;
}

const normalizeSender = (value: string | undefined): string | null => value?.trim().toLowerCase() || null;

export function historyKeyOf(scope: string, message: KeyedMessage): HistoryKey {
  return { scope, mid: message.message_id || null, lid: message.local_id || null, role: message.sender_role, sender: normalizeSender(message.sender_id) };
}

/** Byte-identical to the legacy `messageHistoryKey` payload. */
export function historyKeyString(key: HistoryKey): string {
  return JSON.stringify([key.scope, key.mid, key.lid, key.role, key.sender]);
}

const PARSE_CACHE_LIMIT = 256;
const parsed = new Map<string, HistoryKey | null>();

/** Parse a `data-history-key` string once; the bounded cache makes repeats free. */
export function parseHistoryKey(raw: string): HistoryKey | null {
  if (!raw) return null;
  const hit = parsed.get(raw);
  if (hit !== undefined) return hit;
  let key: HistoryKey | null = null;
  try {
    const a: unknown = JSON.parse(raw);
    if (Array.isArray(a) && a.length === 5 && typeof a[0] === 'string' && a[0] && typeof a[3] === 'string'
      && (a[1] === null || typeof a[1] === 'string') && (a[2] === null || typeof a[2] === 'string') && (a[4] === null || typeof a[4] === 'string')) {
      key = { scope: a[0], mid: a[1] || null, lid: a[2] || null, role: a[3], sender: a[4] || null };
    }
  } catch { key = null; }
  if (parsed.size >= PARSE_CACHE_LIMIT) parsed.clear();
  parsed.set(raw, key);
  return key;
}

/** Sparse enrichment is compatible; explicit sender or server conflicts are never aliases. */
export function historyKeysMatch(a: HistoryKey | null, b: HistoryKey | null): boolean {
  if (!a || !b || !a.scope || a.scope !== b.scope || a.role !== b.role) return false;
  if (a.sender && b.sender && a.sender !== b.sender) return false;
  if (a.mid && b.mid) return a.mid === b.mid;
  return !!a.lid && a.lid === b.lid;
}

/** Same rule as {@link historyKeysMatch}, against a live message in the anchor's own scope. */
export function historyKeyMatchesMessage(key: HistoryKey, message: KeyedMessage): boolean {
  if (key.role !== message.sender_role) return false;
  const sender = normalizeSender(message.sender_id);
  if (key.sender && sender && key.sender !== sender) return false;
  if (key.mid && message.message_id) return key.mid === message.message_id;
  return !!key.lid && key.lid === message.local_id;
}
