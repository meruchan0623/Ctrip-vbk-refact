/**
 * Platform translation of messages already on screen, driven per message.
 * Mirrors the official client: unresolved IDs of the current thread go out in
 * batches of 20; a row never shows anything until a translation exists, unless
 * the user asked for it or every bounded attempt ended without a result.
 * Rows the platform marks as not needing translation stay silent and are not
 * asked again, unless the row is new and foreign: the platform can answer that
 * before it has translated, so such a row keeps its retries, and any later
 * message asks about it again. A superseded scope can never publish a late result.
 */
import type { UiMessage, UiMessageTranslations } from '../../packages/ipc/src/client.ts';
import type { AccountContext } from '../../packages/ipc/src/contracts.ts';
import { suggestLanguage } from '../../packages/ipc/src/customer-language.ts';

export interface InboundTranslationScope {
  readonly key: string;
  readonly account: AccountContext;
  readonly gid: string;
}

export type InboundTranslationOutcome = 'translated' | 'not_needed' | 'unsupported' | 'missing' | 'failed';
export type InboundTranslationView =
  | { readonly status: 'pending' }
  | { readonly status: 'missing' }
  | { readonly status: 'failed'; readonly error: string };

type Status = 'queued' | 'inflight' | 'waiting' | 'not_needed' | 'unsupported' | 'missing' | 'failed';
interface Entry {
  status: Status;
  attempts: number;
  dueAt: number;
  manual: boolean;
  error: string;
  waiters: ((outcome: InboundTranslationOutcome) => void)[];
}

export interface InboundTranslationDeps {
  readonly invoke: (command: string, payload: unknown) => Promise<unknown>;
  readonly now: () => number;
  readonly setTimeout: (run: () => void, ms: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
  readonly apply: (scope: InboundTranslationScope, messageId: string, translation: string) => void;
  readonly changed: () => void;
  readonly describeError: (error: unknown) => string;
}

export const TRANSLATE_COMMAND = 'im_translate_messages';
export const TRANSLATE_BATCH = 20;
const CONCURRENCY = 2;
const REQUEST_TIMEOUT_MS = 30_000;
/** Indexing can lag a just-delivered message, so an unanswered ID is asked again on this schedule. */
const RETRY_DELAYS_MS = [1_000, 3_000, 8_000] as const;
/** A just-delivered row may lag further: the first message of a new session has stayed untranslated past the base schedule. */
const RECENT_RETRY_DELAYS_MS = [...RETRY_DELAYS_MS, 15_000, 30_000] as const;
const RECENT_MS = 10 * 60_000;
const MAX_ENTRIES = 5_000;
const MAX_SUPPLIERS = 500;
const TRANSLATABLE_ROLES = new Set(['customer', 'merchant_self', 'merchant_other']);

export function isTranslatableMessage(m: UiMessage): boolean {
  if (!m.message_id || m.translation || !m.text.trim()) return false;
  return m.kind === 'system' || (m.kind === 'text' && TRANSLATABLE_ROLES.has(m.sender_role));
}

export function createInboundTranslation(deps: InboundTranslationDeps) {
  let scope: InboundTranslationScope | null = null;
  let messages: readonly UiMessage[] | null = null;
  let epoch = 0;
  let inflight = 0;
  let queue: string[] = [];
  let timer: unknown = null;
  const entries = new Map<string, Entry>();
  const known = new Map<string, UiMessage>();
  const suppliers = new Map<string, string>();
  const entryKey = (id: string) => `${scope?.key ?? ''}\0${id}`;

  const fresh = (): Entry => ({ status: 'queued', attempts: 0, dueAt: 0, manual: false, error: '', waiters: [] });
  const settle = (key: string, entry: Entry, outcome: InboundTranslationOutcome): void => {
    const waiters = entry.waiters;
    entry.waiters = [];
    entry.manual = false;
    for (const resolve of waiters) resolve(outcome);
    if (outcome === 'translated') entries.delete(key);
  };

  function prune(): void {
    if (entries.size <= MAX_ENTRIES) return;
    for (const [key, entry] of entries) {
      if (entries.size <= MAX_ENTRIES) return;
      if (!entry.waiters.length && entry.status !== 'inflight' && entry.status !== 'queued') entries.delete(key);
    }
  }

  function arm(): void {
    if (timer !== null) { deps.clearTimeout(timer); timer = null; }
    let due = Infinity;
    for (const id of known.keys()) {
      const entry = entries.get(entryKey(id));
      if (entry?.status === 'waiting') due = Math.min(due, entry.dueAt);
    }
    if (due === Infinity) return;
    timer = deps.setTimeout(() => { timer = null; wake(); }, Math.max(0, due - deps.now()));
  }

  function wake(): void {
    const now = deps.now();
    for (const id of known.keys()) {
      const entry = entries.get(entryKey(id));
      if (entry?.status === 'waiting' && entry.dueAt <= now) { entry.status = 'queued'; queue.push(id); }
    }
    pump();
    arm();
  }

  const isRecent = (m: UiMessage): boolean => Math.abs(deps.now() - m.create_time_ms) < RECENT_MS;
  /** "Nothing to show" is only believed at once for old rows and for text already in the display language. */
  const mayStillTranslate = (m: UiMessage): boolean => m.kind === 'text' && isRecent(m) && suggestLanguage(m.text) !== 'zh';

  /** Records one unanswered attempt and schedules the next, or ends visibly when attempts run out. */
  function retryOrEnd(id: string, outcome: 'missing' | 'failed' | 'not_needed' | 'unsupported', error: string): boolean {
    const key = entryKey(id), entry = entries.get(key);
    if (!entry) return false;
    const message = known.get(id);
    // A user waiting on "正在翻译…" gets the short schedule.
    const schedule: readonly number[] = !entry.manual && message && isRecent(message) ? RECENT_RETRY_DELAYS_MS : RETRY_DELAYS_MS;
    const delay = schedule[entry.attempts];
    entry.attempts++;
    if (delay !== undefined) {
      entry.status = 'waiting';
      entry.dueAt = deps.now() + delay;
      entry.error = error;
      return false;
    }
    entry.status = outcome;
    entry.error = error;
    settle(key, entry, outcome);
    return true;
  }

  /** A foreign row that never gets a translation ends with the visible retry offer rather than in silence. */
  function answerNothing(id: string, key: string, entry: Entry, message: UiMessage | undefined): boolean {
    const wasManual = entry.manual;
    if (!wasManual && message && mayStillTranslate(message)) return retryOrEnd(id, suggestLanguage(message.text) ? 'missing' : 'not_needed', '');
    entry.status = 'not_needed';
    settle(key, entry, 'not_needed');
    return wasManual;
  }

  function accept(ids: readonly string[], result: UiMessageTranslations, owner: InboundTranslationScope): boolean {
    let visible = false;
    const answered = new Map(result.items.map(item => [item.message_id, item]));
    for (const id of ids) {
      const key = entryKey(id), entry = entries.get(key), message = known.get(id), item = answered.get(id);
      if (!entry) continue;
      const wasManual = entry.manual;
      if (!message) {
        // The row left the list while this was in flight; forget it so its return asks again.
        settle(key, entry, 'failed');
        entries.delete(key);
        continue;
      }
      const text = item?.translation?.trim() ?? '';
      if (item?.status === 'translated' && text) {
        const compatible = message.kind === 'system' || item.source_kind === 'text';
        const flaggedChinese = item.reason === 'flagged' && suggestLanguage(message.text) === 'zh';
        if (compatible && !flaggedChinese && text !== message.text.trim()) {
          if (result.supplier) {
            if (suppliers.size >= MAX_SUPPLIERS) suppliers.clear();
            suppliers.set(key, result.supplier);
          }
          settle(key, entry, 'translated');
          deps.apply(owner, id, item.translation!);
          visible = visible || wasManual;
          continue;
        }
        visible = answerNothing(id, key, entry, message) || visible;
      } else if (item?.status === 'not_needed') {
        visible = answerNothing(id, key, entry, message) || visible;
      } else if (item?.status === 'unsupported') {
        // Judged from the conversation row, which a new session's first message can outrun.
        if (!wasManual && mayStillTranslate(message)) {
          retryOrEnd(id, 'unsupported', '');
          continue;
        }
        entry.status = item.status;
        settle(key, entry, item.status);
        visible = visible || wasManual;
      } else {
        visible = retryOrEnd(id, 'missing', '') || visible;
      }
    }
    return visible;
  }

  function pump(): void {
    const owner = scope;
    if (!owner) return;
    while (inflight < CONCURRENCY && queue.length) {
      const ids: string[] = [];
      while (ids.length < TRANSLATE_BATCH && queue.length) {
        const id = queue.shift()!, entry = entries.get(entryKey(id));
        if (entry?.status === 'queued' && !ids.includes(id)) { entry.status = 'inflight'; ids.push(id); }
      }
      if (!ids.length) continue;
      inflight++;
      void request(owner, epoch, ids);
    }
  }

  async function request(owner: InboundTranslationScope, requestEpoch: number, ids: readonly string[]): Promise<void> {
    let handle: unknown = null;
    let result: UiMessageTranslations | null = null;
    let failure: unknown = null;
    try {
      result = await Promise.race([
        deps.invoke(TRANSLATE_COMMAND, { account: owner.account, gid: owner.gid, message_ids: ids }) as Promise<UiMessageTranslations>,
        new Promise<never>((_, reject) => { handle = deps.setTimeout(() => reject(new Error('翻译请求超时')), REQUEST_TIMEOUT_MS); }),
      ]);
      if (!Array.isArray(result?.items)) { result = null; failure = new Error('翻译结果无效'); }
    } catch (error) {
      failure = error;
    } finally {
      if (handle !== null) deps.clearTimeout(handle);
    }
    if (requestEpoch !== epoch) return;
    inflight--;
    let visible: boolean;
    if (result) {
      visible = accept(ids, result, owner);
    } else {
      const error = deps.describeError(failure);
      visible = false;
      for (const id of ids) visible = retryOrEnd(id, 'failed', error) || visible;
    }
    pump();
    arm();
    if (visible) deps.changed();
  }

  /** Like the official client, a new row is also the moment to ask again about recent rows that ended without a result. */
  function reopenRecent(): boolean {
    let visible = false;
    for (const [id, message] of known) {
      const entry = entries.get(entryKey(id));
      if (!entry || !isRecent(message)) continue;
      const shown = entry.status === 'missing' || entry.status === 'failed';
      if (!shown && !((entry.status === 'not_needed' || entry.status === 'unsupported') && mayStillTranslate(message))) continue;
      entry.status = 'queued';
      entry.attempts = 0;
      entry.error = '';
      queue.push(id);
      visible = visible || shown;
    }
    return visible;
  }

  function scan(list: readonly UiMessage[]): boolean {
    known.clear();
    const add: string[] = [];
    for (const m of list) {
      const id = m.message_id;
      if (!id) continue;
      if (m.translation) { entries.delete(entryKey(id)); continue; }
      if (!isTranslatableMessage(m)) continue;
      known.set(id, m);
      const key = entryKey(id);
      if (!entries.has(key)) { entries.set(key, fresh()); add.push(id); }
    }
    // Newest rows are the ones on screen when a thread opens.
    if (add.length) queue = [...add.reverse(), ...queue];
    const visible = add.length > 0 && reopenRecent();
    prune();
    return visible;
  }

  return {
    sync(next: InboundTranslationScope | null, list: readonly UiMessage[] | null): void {
      if (next?.key !== scope?.key) {
        epoch++;
        inflight = 0;
        queue = [];
        known.clear();
        if (timer !== null) { deps.clearTimeout(timer); timer = null; }
        const visible = [...entries.values()].some(entry => entry.manual || entry.status === 'failed' || entry.status === 'missing');
        // Terminal "no translation" answers stay cached; everything else is asked again on return.
        for (const [key, entry] of entries) {
          if (entry.status === 'not_needed' || entry.status === 'unsupported') continue;
          const waiters = entry.waiters;
          entries.delete(key);
          for (const resolve of waiters) resolve('failed');
        }
        scope = next;
        messages = null;
        if (visible) deps.changed();
      }
      if (!next || !list || list === messages) return;
      messages = list;
      const visible = scan(list);
      pump();
      arm();
      if (visible) deps.changed();
    },
    /** A user request starts over with a fresh attempt budget and is shown while it runs. */
    retry(message: UiMessage): Promise<InboundTranslationOutcome> {
      const id = message.message_id;
      if (!scope || !id || message.translation || message.gid !== scope.gid || !isTranslatableMessage(message)) return Promise.resolve('failed');
      known.set(id, message);
      const key = entryKey(id);
      const entry = entries.get(key) ?? fresh();
      entries.set(key, entry);
      entry.manual = true;
      entry.attempts = 0;
      entry.error = '';
      if (entry.status !== 'inflight') {
        entry.status = 'queued';
        queue.unshift(id);
      }
      const outcome = new Promise<InboundTranslationOutcome>(resolve => { entry.waiters.push(resolve); });
      pump();
      arm();
      deps.changed();
      return outcome;
    },
    /** Silent while automatic; only a user request or an exhausted budget is drawn on the row. */
    view(message: UiMessage): InboundTranslationView | null {
      if (!message.message_id || message.translation) return null;
      const entry = entries.get(entryKey(message.message_id));
      if (!entry) return null;
      if (entry.status === 'missing') return { status: 'missing' };
      if (entry.status === 'failed') return { status: 'failed', error: entry.error };
      return entry.manual ? { status: 'pending' } : null;
    },
    supplier(message: UiMessage): string | null {
      return message.message_id ? suppliers.get(entryKey(message.message_id)) ?? null : null;
    },
    stop(): void {
      this.sync(null, null);
    },
  };
}
