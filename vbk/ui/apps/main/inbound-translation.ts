/**
 * Fetch platform translations for every eligible row in the open thread.
 * Fast retries cover indexing delays; unanswered text stays on a capped slow
 * backfill schedule, including history, without needing focus or another message.
 * Account/scope changes discard late results. Requests stay batched and bounded.
 */
import type { UiMessage, UiMessageTranslations } from '../../packages/ipc/src/client.ts';
import type { AccountContext } from '../../packages/ipc/src/contracts.ts';
import { suggestLanguage } from '../../packages/ipc/src/customer-language.ts';
import { t } from '../../packages/ui-kit/src/i18n.ts';

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
  backfills: number;
  dueAt: number;
  manual: boolean;
  /** Ended without a result although the row looks foreign: asked again on the next trigger. */
  reask: boolean;
  settledAt: number;
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
  /** Counts only: never include bodies, IDs or credentials in diagnostics. */
  readonly report?: (event: 'request' | 'response' | 'failed', counts: Record<string, number>) => void;
}

export const TRANSLATE_COMMAND = 'im_translate_messages';
export const TRANSLATE_BATCH = 20;
const CONCURRENCY = 2;
const REQUEST_TIMEOUT_MS = 30_000;
/** Indexing can lag a just-delivered message, so an unanswered ID is asked again on this schedule. */
const RETRY_DELAYS_MS = [1_000, 3_000, 8_000] as const;
/** A just-delivered row may lag further: the first message of a new session has stayed untranslated past the base schedule. */
const RECENT_RETRY_DELAYS_MS = [...RETRY_DELAYS_MS, 15_000, 30_000, 60_000, 120_000] as const;
/** All external triggers honour this cooldown as well as the backfill due time. */
const REOPEN_COOLDOWN_MS = 30_000;
const BACKFILL_DELAYS_MS = [30_000, 60_000, 120_000, 300_000] as const;
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

  const fresh = (): Entry => ({ status: 'queued', attempts: 0, backfills: 0, dueAt: 0, manual: false, reask: false, settledAt: 0, error: '', waiters: [] });
  const settle = (key: string, entry: Entry, outcome: InboundTranslationOutcome): void => {
    const waiters = entry.waiters;
    entry.waiters = [];
    entry.manual = false;
    entry.settledAt = deps.now();
    for (const resolve of waiters) resolve(outcome);
    if (outcome === 'translated') entries.delete(key);
  };

  function prune(): void {
    if (entries.size <= MAX_ENTRIES) return;
    for (const [key, entry] of entries) {
      if (entries.size <= MAX_ENTRIES) return;
      if (!entry.waiters.length && !known.has(key.slice(key.lastIndexOf('\0') + 1)) && entry.status !== 'inflight' && entry.status !== 'queued') entries.delete(key);
    }
  }

  function arm(): void {
    if (timer !== null) { deps.clearTimeout(timer); timer = null; }
    let due = Infinity;
    for (const id of known.keys()) {
      const entry = entries.get(entryKey(id));
      if (entry && (entry.status === 'waiting' || (entry.reask && entry.status !== 'queued' && entry.status !== 'inflight'))) due = Math.min(due, entry.dueAt);
    }
    if (due === Infinity) return;
    timer = deps.setTimeout(() => { timer = null; wake(); }, Math.max(0, due - deps.now()));
  }

  function wake(): void {
    const now = deps.now();
    for (const id of known.keys()) {
      const entry = entries.get(entryKey(id));
      if (entry && (entry.status === 'waiting' || entry.reask) && entry.status !== 'queued' && entry.status !== 'inflight' && entry.dueAt <= now) { entry.status = 'queued'; queue.push(id); }
    }
    pump();
    arm();
  }

  const isRecent = (m: UiMessage): boolean => Math.abs(deps.now() - m.create_time_ms) < RECENT_MS;
  /** "Nothing to show" is only believed at once for Chinese text or nonlinguistic content; short and unrecognized scripts still retry. */
  const mayStillTranslate = (m: UiMessage): boolean => {
    if (m.kind !== 'text') return false;
    const lang = suggestLanguage(m.text);
    return lang !== 'zh' && /\p{L}/u.test(m.text.replace(/https?:\/\/\S+|\b[\w.+-]+@[\w.-]+\.[A-Za-z]+/g, ''));
  };

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
    entry.reask = outcome === 'missing' || outcome === 'failed' || !!(message && mayStillTranslate(message));
    settle(key, entry, outcome);
    if (entry.reask) {
      entry.dueAt = deps.now() + BACKFILL_DELAYS_MS[Math.min(entry.backfills++, BACKFILL_DELAYS_MS.length - 1)]!;
    }
    return true;
  }

  /** A foreign row that never gets a translation ends with the visible retry offer rather than in silence. */
  function answerNothing(id: string, key: string, entry: Entry, message: UiMessage | undefined): boolean {
    const wasManual = entry.manual;
    // Age and a manual request cannot turn untranslated foreign text into a terminal success.
    if (message && mayStillTranslate(message)) return retryOrEnd(id, 'missing', '');
    entry.status = 'not_needed';
    entry.reask = false;
    settle(key, entry, 'not_needed');
    return wasManual;
  }

  function accept(ids: readonly string[], result: UiMessageTranslations, owner: InboundTranslationScope): boolean {
    let visible = false, applied = 0, echoes = 0;
    const answered = new Map(result.items.map(item => [item.message_id, item]));
    for (const id of ids) {
      const key = entryKey(id), entry = entries.get(key), message = known.get(id), item = answered.get(id);
      if (!entry) continue;
      const wasManual = entry.manual;
      if (!message || message.translation) {
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
          applied++;
          deps.apply(owner, id, item.translation!);
          visible = visible || wasManual;
          continue;
        }
        if (text === message.text.trim()) echoes++;
        visible = answerNothing(id, key, entry, message) || visible;
      } else if (item?.status === 'not_needed') {
        visible = answerNothing(id, key, entry, message) || visible;
      } else if (item?.status === 'unsupported') {
        // Judged from the conversation row, which a new session's first message can outrun.
        if (mayStillTranslate(message)) {
          visible = retryOrEnd(id, 'missing', '') || visible;
          continue;
        }
        entry.status = item.status;
        entry.reask = false;
        settle(key, entry, item.status);
        visible = visible || wasManual;
      } else {
        visible = retryOrEnd(id, 'missing', '') || visible;
      }
    }
    deps.report?.('response', { requested: ids.length, applied, echoes,
      not_needed: result.items.filter(item => item.status === 'not_needed').length,
      unsupported: result.items.filter(item => item.status === 'unsupported').length,
      missing: ids.filter(id => !answered.has(id) || answered.get(id)?.status === 'missing').length,
      card: result.items.filter(item => item.reason === 'card').length,
    });
    return visible;
  }

  function pump(): void {
    const owner = scope;
    if (!owner) return;
    while (inflight < CONCURRENCY && queue.length) {
      const ids: string[] = [];
      while (ids.length < TRANSLATE_BATCH && queue.length) {
        const id = queue.shift()!, entry = entries.get(entryKey(id));
        if (known.has(id) && entry?.status === 'queued' && !ids.includes(id)) { entry.status = 'inflight'; ids.push(id); }
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
      deps.report?.('request', { requested: ids.length, history: ids.filter(id => { const m = known.get(id); return m && !isRecent(m); }).length });
      result = await Promise.race([
        deps.invoke(TRANSLATE_COMMAND, { account: owner.account, gid: owner.gid, message_ids: ids }) as Promise<UiMessageTranslations>,
        new Promise<never>((_, reject) => { handle = deps.setTimeout(() => reject(new Error(t('orderMisc.translate.requestTimeout'))), REQUEST_TIMEOUT_MS); }),
      ]);
      if (!Array.isArray(result?.items)) { result = null; failure = new Error(t('orderMisc.translate.invalidResult')); }
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
      deps.report?.('failed', { requested: ids.length });
      const error = deps.describeError(failure);
      visible = false;
      for (const id of ids) visible = retryOrEnd(id, 'failed', error) || visible;
    }
    pump();
    arm();
    if (visible) deps.changed();
  }

  /**
   * Like the official client, a new row is also the moment to ask again about rows that ended without a result:
   * only after their scheduled backfill time and cooldown, so frequent messages cannot create a retry storm.
   */
  function reopenEnded(): boolean {
    let visible = false;
    const now = deps.now();
    for (const [id, message] of known) {
      const entry = entries.get(entryKey(id));
      if (!entry) continue;
      const shown = entry.status === 'missing' || entry.status === 'failed';
      const ended = shown || entry.status === 'not_needed' || entry.status === 'unsupported';
      if (!ended) continue;
      const recent = isRecent(message);
      const wanted = recent
        ? shown || mayStillTranslate(message)
        : shown || (entry.reask && mayStillTranslate(message));
      if (!wanted) continue;
      if (now < Math.max(entry.dueAt, entry.settledAt + REOPEN_COOLDOWN_MS)) continue;
      entry.status = 'queued';
      entry.error = '';
      entry.reask = false;
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
      if (m.translation) {
        const key = entryKey(id), entry = entries.get(key);
        if (entry) settle(key, entry, 'translated');
        continue;
      }
      if (!isTranslatableMessage(m)) continue;
      known.set(id, m);
      const key = entryKey(id);
      if (!entries.has(key)) { entries.set(key, fresh()); add.push(id); }
    }
    // A queued/waiting row can leave a history window before being requested.
    // Forget its slot so loading that row again enqueues it instead of stranding it.
    for (const [key, entry] of entries) {
      if (!key.startsWith(`${scope?.key ?? ''}\0`) || entry.status === 'inflight') continue;
      const id = key.slice((scope?.key.length ?? 0) + 1);
      if (!known.has(id)) { settle(key, entry, 'failed'); entries.delete(key); }
    }
    // Newest rows are the ones on screen when a thread opens.
    if (add.length) queue = [...add.reverse(), ...queue];
    const visible = add.length > 0 && reopenEnded();
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
        // Believed "no translation" answers stay cached; everything else (failures, foreign rows with no result) is asked again on return.
        for (const [key, entry] of entries) {
          if ((entry.status === 'not_needed' || entry.status === 'unsupported') && !entry.reask) continue;
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
    /** Window back in view or another backfill trigger: asks again about ended rows whose cooldown has passed. */
    recheck(): void {
      if (!scope || !messages) return;
      const visible = reopenEnded();
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
      entry.backfills = 0;
      entry.reask = false;
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
