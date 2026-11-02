/**
 * `16037/getConversationList[.json]` poller (docs/research/2026-10-30-web-im-transport-and-polling.md §4).
 *
 * - first body `{head, needTodoList: 1}` (+ `locale` when enabled; the
 *   imvendor entry sent `needTodoList, locale, head`, the vbooking entry
 *   only `head, needTodoList`)
 * - after each response wait `intervalMs` (5000) then POST again with
 *   `startTime = previous lastUpdateTime`
 * - `needTodoList` must stay the number 1: `true` was observed to fail
 * - the two URL variants are separate specs and separate pollers
 * - an empty increment emits only `conversation_list_sync`
 * - `auth_invalid` stops the loop and emits `auth_invalid`
 *
 * Pacing (I-06, docs/api/transports.md): the official page runs its own
 * 5 s `startLoopConvList`. While the fetch hook sees that loop active, this
 * poller sends nothing and consumes the official responses (`official`
 * option); otherwise it self-runs, `visibilityState`-gated (x6 interval while
 * hidden) with exponential backoff after failures (never below 5 s).
 * "Active" is judged per URL variant and requires observed response bodies
 * (`OfficialConversationFeed.active`), so an unreadable official loop can
 * never leave the poller with zero requests and zero data.
 *
 * Status mapping is explicit and defaults to `unknown`; `transferred_out`
 * has no observed numeric code yet.
 */

import type { AdapterFact, ConversationFact, ConversationStatus } from '../../ipc/src/contracts.ts';
import type { AdapterDeps } from './deps.ts';
import { Endpoints } from './endpoints.ts';
import { businessHead } from './heads.ts';
import { classifySoaBody, type EndpointSpec, type SoaClient, type SoaOutcome } from './soa.ts';
import { normalizeTimeMs } from './facts.ts';
import type { OfficialConversationEntry, OfficialConversationFeed, OfficialFeedAttachment, OfficialListVariant } from './pageContext.ts';

/** Official desktop ACTIVE.values=[1,2]: autoActive=1/manualActive=2; FINISH=[4]. */
export const CONVERSATION_STATUS_TABLE: Readonly<Record<number, ConversationStatus>> = {
  1: 'active',
  2: 'active',
  4: 'finished',
};

export function mapConversationStatus(raw: unknown): ConversationStatus {
  return typeof raw === 'number' ? (CONVERSATION_STATUS_TABLE[raw] ?? 'unknown') : 'unknown';
}

export interface ConversationListItem {
  readonly gid?: unknown;
  readonly status?: unknown;
  readonly inGroup?: unknown;
  readonly isOwner?: unknown;
  readonly serviceType?: unknown;
  readonly lastMessageTime?: unknown;
  readonly lastUpdateTime?: unknown;
  readonly uid?: unknown;
  readonly sessionId?: unknown;
  readonly conversationType?: unknown;
  readonly conversationKey?: unknown;
  readonly threadId?: unknown;
  readonly star?: unknown;
  readonly isRead?: unknown;
}

export interface ConversationListResponse {
  readonly conversationList?: unknown;
  readonly currentStatus?: unknown;
  readonly lastUpdateTime?: unknown;
  readonly haveRest?: unknown;
}

export interface UnreadLookup {
  /** From `getConversationInfoByGidList.conversationInfoList[].unreadCount`; `null` when not known. */
  unreadOf(gid: string): number | null;
}

export const NO_UNREAD: UnreadLookup = { unreadOf: () => null };

/**
 * Maps one `conversationList[]` row. The list has no unread count field
 * (only `isRead`), so `unread_count` comes from the injected lookup and is
 * 0 when unknown — see the contract change request in the module report.
 */
export function toConversationFact(item: ConversationListItem, isFullSnapshot: boolean, unread: UnreadLookup = NO_UNREAD): ConversationFact | null {
  if (typeof item !== 'object' || item === null) return null;
  if (typeof item.gid !== 'string' || item.gid === '') return null;
  return {
    gid: item.gid,
    status: mapConversationStatus(item.status),
    agent_in_group: item.inGroup === 1,
    is_owner: item.isOwner === true,
    service_type: typeof item.serviceType === 'string' ? item.serviceType : typeof item.serviceType === 'number' ? String(item.serviceType) : '',
    last_message_time_ms: normalizeTimeMs(item.lastMessageTime),
    last_update_time_ms: normalizeTimeMs(item.lastUpdateTime),
    unread_count: unread.unreadOf(item.gid) ?? 0,
    is_full_snapshot: isFullSnapshot,
  };
}

export type ConversationListVariant = OfficialListVariant;

/**
 * Page visibility as the poller needs it. Injected (never reads `document`);
 * the boot code adapts `document.visibilityState` / `visibilitychange`.
 */
export interface VisibilityGate {
  isVisible(): boolean;
  /** Called on every visibility change; returns an unsubscribe. */
  subscribe(cb: () => void): () => void;
}

export interface ConversationListPollerOptions {
  readonly variant: ConversationListVariant;
  readonly emit: (fact: AdapterFact) => void;
  readonly intervalMs?: number;
  /** Send `locale` in the body (imvendor entry); default false (vbooking entry). */
  readonly includeLocale?: boolean;
  readonly unread?: UnreadLookup;
  /** Raw rows for callers that need `sessionId`/`uid`/`serviceType` (never logged). */
  readonly onRows?: (rows: readonly ConversationListItem[], full: boolean) => void;
  readonly onRequest?: () => unknown;
  readonly onOutcome?: (outcome: SoaOutcome<ConversationListResponse>, ticket?: unknown) => void;
  /**
   * The official page's own `startLoopConvList` as observed by the fetch hook.
   * While that loop is active the poller sends **no** request of its own and
   * only consumes the official responses (I-06). Without it, or while the
   * official loop is not running, the poller self-runs.
   */
  readonly official?: OfficialConversationFeed;
  /** Self-run requests slow down by `hiddenIntervalMultiplier` while hidden. Default: always visible. */
  readonly visibility?: VisibilityGate;
  /** Hidden interval = `intervalMs x` this (6 => 30 s, ~17% of the foreground request count; the acceptance bound is 20%). */
  readonly hiddenIntervalMultiplier?: number;
  /** Cap of the exponential backoff after failed self-run requests. */
  readonly maxBackoffMs?: number;
  /** With the official loop active but no official full snapshot seen, wait this long before the one bootstrap pull. */
  readonly bootstrapGraceMs?: number;
  /** Fired once per bootstrap full snapshot the poller itself requested while the official loop was active. */
  readonly onBootstrap?: () => void;
}

export interface ConversationListRequestBody {
  readonly head: ReturnType<typeof businessHead>;
  readonly needTodoList: 1;
  readonly locale?: string;
  readonly startTime?: number;
}

export function conversationListBody(deps: AdapterDeps, startTime: number | null, includeLocale: boolean): ConversationListRequestBody {
  const body: { head: ReturnType<typeof businessHead>; needTodoList: 1; locale?: string; startTime?: number } = {
    head: businessHead(deps.context),
    needTodoList: 1,
  };
  if (includeLocale) body.locale = deps.context.locale;
  if (startTime !== null) body.startTime = startTime;
  return body;
}

export function specFor(variant: ConversationListVariant): EndpointSpec {
  return variant === 'json' ? Endpoints.CONVERSATION_LIST_JSON : Endpoints.CONVERSATION_LIST;
}

export interface ConversationListPoller {
  start(): void;
  stop(): void;
  readonly running: boolean;
  /** Last `lastUpdateTime` the server returned (next `startTime`). */
  readonly cursor: number | null;
  /** How the latest facts were obtained; `official` = consumed, no request of ours. */
  readonly source: 'idle' | 'official' | 'self';
}

export const DEFAULT_LIST_INTERVAL_MS = 5000;
export const DEFAULT_HIDDEN_MULTIPLIER = 6;
export const DEFAULT_MAX_BACKOFF_MS = 60_000;
export const DEFAULT_BOOTSTRAP_GRACE_MS = 7000;

/** Delay after `failures` consecutive failed self-run requests: `base x 2^(failures-1)`, capped; the first retry keeps the base. */
export function listBackoffMs(baseMs: number, failures: number, capMs: number): number {
  if (failures <= 1) return baseMs;
  return Math.min(Math.max(capMs, baseMs), baseMs * 2 ** Math.min(failures - 1, 20));
}

export function createConversationListPoller(deps: AdapterDeps, soa: SoaClient, opts: ConversationListPollerOptions): ConversationListPoller {
  const intervalMs = opts.intervalMs ?? DEFAULT_LIST_INTERVAL_MS;
  const hiddenMultiplier = Math.max(1, opts.hiddenIntervalMultiplier ?? DEFAULT_HIDDEN_MULTIPLIER);
  const maxBackoffMs = opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const graceMs = opts.bootstrapGraceMs ?? DEFAULT_BOOTSTRAP_GRACE_MS;
  const spec = specFor(opts.variant);
  let running = false;
  let generation = 0;
  let cursor: number | null = null;
  let timer: unknown = null;
  let failures = 0;
  let source: 'idle' | 'official' | 'self' = 'idle';
  let startedAt = 0;
  let lastScheduledFrom = 0;
  let attachment: OfficialFeedAttachment | null = null;
  let unsubscribeVisibility: (() => void) | null = null;

  const hidden = (): boolean => opts.visibility !== undefined && !opts.visibility.isVisible();

  const delayMs = (): number => {
    const base = hidden() ? intervalMs * hiddenMultiplier : intervalMs;
    const raw = listBackoffMs(base, failures, maxBackoffMs);
    // Jitter only on real backoff steps, only lengthens (<= +10%, below the doubling), and stays inside the cap,
    // so the sequence of waits during a failure streak is non-decreasing.
    return failures >= 2 ? Math.min(Math.max(maxBackoffMs, base), Math.round(raw * (1 + 0.1 * deps.random()))) : raw;
  };

  const schedule = (gen: number): void => {
    if (timer !== null) deps.clearTimeout(timer);
    lastScheduledFrom = deps.now();
    timer = deps.setTimeout(() => {
      timer = null;
      void tick(gen);
    }, delayMs());
  };

  /** Common tail of a self-run response and an official response. Returns `false` when the poller stopped. */
  const apply = (outcome: SoaOutcome<ConversationListResponse>, startTime: number | null, ticket: unknown, fromOfficial: boolean): boolean => {
    opts.onOutcome?.(outcome, ticket);
    if (outcome.kind === 'auth_invalid') {
      running = false;
      opts.emit({ kind: 'auth_invalid' });
      return false;
    }
    if (outcome.kind !== 'success') return true;
    const full = startTime === null;
    const rows = Array.isArray(outcome.body.conversationList) ? (outcome.body.conversationList as ConversationListItem[]) : [];
    const serverCursor = normalizeTimeMs(outcome.body.lastUpdateTime);
    for (const row of rows) {
      const fact = toConversationFact(row, full, opts.unread);
      if (fact) opts.emit({ kind: 'conversation', fact });
    }
    if (rows.length > 0) opts.onRows?.(rows, full);
    if (serverCursor !== null && (!fromOfficial || cursor === null || serverCursor >= cursor)) cursor = serverCursor;
    opts.emit({ kind: 'conversation_list_sync', full, last_update_time_ms: serverCursor });
    return true;
  };

  const consume = (entry: OfficialConversationEntry, ticket: unknown): void => {
    if (!running) return;
    // An increment can only be applied on top of a snapshot we already hold.
    if (!entry.full && cursor === null) return;
    let outcome: SoaOutcome<ConversationListResponse>;
    if (entry.status !== 200) {
      outcome = { kind: 'http_error', httpStatus: entry.status };
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(entry.text);
      } catch {
        parsed = null;
      }
      outcome = classifySoaBody<ConversationListResponse>(parsed, entry.status);
    }
    // The session reads `cursor === null` as "this response is a full snapshot".
    if (entry.full && outcome.kind === 'success') cursor = null;
    source = 'official';
    if (!apply(outcome, entry.full && outcome.kind === 'success' ? null : cursor, ticket, true)) {
      source = 'idle';
      stopInternal();
    }
  };

  const stopInternal = (): void => {
    generation += 1;
    if (timer !== null) {
      deps.clearTimeout(timer);
      timer = null;
    }
    attachment?.detach();
    attachment = null;
    unsubscribeVisibility?.();
    unsubscribeVisibility = null;
  };

  const tick = async (gen: number): Promise<void> => {
    if (!running || gen !== generation) return;
    let bootstrap = false;
    // Per variant, and only while official response bodies actually reach us: a loop we cannot read is no feed.
    if (opts.official?.active(deps.now(), opts.variant)) {
      if (cursor !== null) {
        // The official loop feeds us; asking again would double its request rate.
        source = 'official';
        schedule(gen);
        return;
      }
      if (deps.now() - startedAt < graceMs) {
        schedule(gen);
        return;
      }
      bootstrap = true; // official loop is running but no full snapshot was observed: one pull, reported
    }
    source = 'self';
    const startTime = cursor;
    const ticket = opts.onRequest?.();
    if (bootstrap) opts.onBootstrap?.();
    const outcome = await soa.post<ConversationListResponse>(spec, conversationListBody(deps, startTime, opts.includeLocale ?? false));
    if (!running || gen !== generation) return;
    failures = outcome.kind === 'success' ? 0 : failures + 1;
    if (!apply(outcome, startTime, ticket, false)) {
      source = 'idle';
      stopInternal();
      return;
    }
    schedule(gen);
  };

  const onVisibility = (): void => {
    if (!running || timer === null) return;
    // Becoming visible must not skip the minimum interval; becoming hidden stretches the pending one.
    const gen = generation;
    deps.clearTimeout(timer);
    const wait = Math.max(0, lastScheduledFrom + delayMs() - deps.now());
    timer = deps.setTimeout(() => {
      timer = null;
      void tick(gen);
    }, wait);
  };

  return {
    start(): void {
      if (running) return;
      running = true;
      generation += 1;
      failures = 0;
      startedAt = deps.now();
      // U02: every run (= every adapter epoch) begins with a full snapshot so the host can rebuild after epoch_changed
      cursor = null;
      if (opts.official) {
        attachment = opts.official.attach(opts.variant, { onRequest: () => opts.onRequest?.(), onResponse: consume });
      }
      if (!running) {
        // the replay hit auth_invalid before the attachment handle existed
        attachment?.detach();
        attachment = null;
        return;
      }
      unsubscribeVisibility = opts.visibility?.subscribe(onVisibility) ?? null;
      void tick(generation);
    },
    stop(): void {
      running = false;
      source = 'idle';
      stopInternal();
    },
    get running(): boolean {
      return running;
    },
    get cursor(): number | null {
      return cursor;
    },
    get source(): 'idle' | 'official' | 'self' {
      return source;
    },
  };
}
