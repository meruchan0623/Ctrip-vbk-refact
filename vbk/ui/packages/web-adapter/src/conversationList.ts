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
 * Status mapping is explicit and defaults to `unknown`; `transferred_out`
 * has no observed numeric code yet.
 */

import type { AdapterFact, ConversationFact, ConversationStatus } from '../../ipc/src/contracts.ts';
import type { AdapterDeps } from './deps.ts';
import { Endpoints } from './endpoints.ts';
import { businessHead } from './heads.ts';
import type { EndpointSpec, SoaClient, SoaOutcome } from './soa.ts';
import { normalizeTimeMs } from './facts.ts';
import type { PageRequestObserver } from './pageContext.ts';

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

export type ConversationListVariant = 'plain' | 'json';

export interface ConversationListPollerOptions {
  readonly variant: ConversationListVariant;
  readonly emit: (fact: AdapterFact) => void;
  readonly intervalMs?: number;
  readonly maxBackoffMs?: number;
  readonly officialRequests?: PageRequestObserver;
  /** Official loop lease; default three nominal intervals (15 seconds). */
  readonly officialLeaseMs?: number;
  readonly visibility?: { visible(): boolean; subscribe(cb: () => void): () => void };
  /** Send `locale` in the body (imvendor entry); default false (vbooking entry). */
  readonly includeLocale?: boolean;
  readonly unread?: UnreadLookup;
  /** Raw rows for callers that need `sessionId`/`uid`/`serviceType` (never logged). */
  readonly onRows?: (rows: readonly ConversationListItem[], full: boolean) => void;
  readonly onRequest?: () => unknown;
  readonly onOutcome?: (outcome: SoaOutcome<ConversationListResponse>, ticket?: unknown) => void;
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
}

export function createConversationListPoller(deps: AdapterDeps, soa: SoaClient, opts: ConversationListPollerOptions): ConversationListPoller {
  const finite = (v: number | undefined, fallback: number): number => typeof v === 'number' && Number.isFinite(v) && v >= 5000 ? v : fallback;
  const intervalMs = finite(opts.intervalMs, 5000);
  const maxBackoffMs = Math.max(intervalMs, finite(opts.maxBackoffMs, 60000));
  const officialLeaseMs = finite(opts.officialLeaseMs, 15000);
  const spec = specFor(opts.variant);
  let running = false;
  let generation = 0;
  let cursor: number | null = null;
  let timer: unknown = null;
  let unsubscribe: (() => void) | null = null;
  let unvisibility: (() => void) | null = null;
  let failures = 0;
  let lastAttempt = -Infinity;
  let inFlight = false;
  let latestOfficialId = 0;
  const tickets = new Map<number, unknown>();
  let started = false;
  const officialActive = (): boolean => {
    const last = opts.officialRequests?.lastOfficial(spec.path);
    return last !== undefined && last !== null && deps.now() - last < officialLeaseMs;
  };
  const clearTimer = (): void => { if (timer !== null) deps.clearTimeout(timer); timer = null; };
  const schedule = (gen: number, delay = intervalMs): void => {
    clearTimer();
    if (!running || gen !== generation) return;
    timer = deps.setTimeout(() => { timer = null; void tick(gen); }, delay);
  };
  const consume = (outcome: SoaOutcome<ConversationListResponse>, startTime: number | null, ticket: unknown): void => {
    // Session's projection reads cursor here to distinguish full/incremental responses.
    cursor = startTime;
    opts.onOutcome?.(outcome, ticket);
    if (!running) return;
    if (outcome.kind === 'auth_invalid') { running = false; opts.emit({ kind: 'auth_invalid' }); return; }
    if (outcome.kind !== 'success') return;
    const full = startTime === null;
    const rows = Array.isArray(outcome.body.conversationList) ? outcome.body.conversationList as ConversationListItem[] : [];
    const serverCursor = normalizeTimeMs(outcome.body.lastUpdateTime);
    for (const row of rows) { const fact = toConversationFact(row, full, opts.unread); if (fact) opts.emit({ kind: 'conversation', fact }); }
    if (rows.length > 0) opts.onRows?.(rows, full);
    if (serverCursor !== null) cursor = serverCursor;
    opts.emit({ kind: 'conversation_list_sync', full, last_update_time_ms: serverCursor });
  };
  const tick = async (gen: number): Promise<void> => {
    if (!running || gen !== generation) return;
    if (opts.visibility && !opts.visibility.visible()) return; // visibility event rearms; no background timer
    if (officialActive() || inFlight) { schedule(gen); return; }
    const remaining = intervalMs - (deps.now() - lastAttempt);
    if (remaining > 0) { schedule(gen, remaining); return; }
    const startTime = cursor;
    const ticket = opts.onRequest?.();
    const officialId = latestOfficialId;
    lastAttempt = deps.now();
    inFlight = true;
    // SoaClient normally retries transport reads immediately. Keep retries inside
    // this scheduler so even failures respect the five-second lower bound.
    const outcome = await soa.post<ConversationListResponse>(spec, conversationListBody(deps, startTime, opts.includeLocale ?? false), { retryNetworkErrors: false });
    inFlight = false;
    if (!running || gen !== generation) return;
    if (officialId === latestOfficialId) consume(outcome, startTime, ticket);
    failures = outcome.kind === 'success' ? 0 : Math.min(failures + 1, 16);
    schedule(gen, Math.min(maxBackoffMs, intervalMs * 2 ** Math.max(0, failures - 1)));
  };
  return {
    start(): void {
      if (running) return;
      running = true;
      const gen = ++generation;
      cursor = null;
      failures = 0;
      latestOfficialId = 0;
      tickets.clear();
      unsubscribe = opts.officialRequests?.subscribe(event => {
        if (!running || gen !== generation || event.initiator !== 'official' || event.path !== spec.path) return;
        if (event.phase === 'request') {
          latestOfficialId = event.id;
          tickets.clear(); // only newest official response may update this epoch
          tickets.set(event.id, opts.onRequest?.());
          if (officialActive()) schedule(gen);
        } else if (event.id === latestOfficialId && tickets.has(event.id) && event.outcome) {
          const ticket = tickets.get(event.id); tickets.delete(event.id);
          consume(event.outcome as SoaOutcome<ConversationListResponse>, event.startTime, ticket);
        }
      }) ?? null;
      unvisibility = opts.visibility?.subscribe(() => {
        clearTimer();
        if (running && opts.visibility?.visible()) schedule(gen, intervalMs);
      }) ?? null;
      // A boot-time full snapshot belongs to this document/first epoch only.
      const initial = !started ? opts.officialRequests?.latestOfficial(spec.path) : null;
      started = true;
      if (initial) {
        latestOfficialId = initial.id;
        const ticket = opts.onRequest?.();
        if (initial.phase === 'response' && initial.outcome) consume(initial.outcome as SoaOutcome<ConversationListResponse>, initial.startTime, ticket);
        else tickets.set(initial.id, ticket);
      }
      // Give the official page one nominal interval to establish its loop.
      if (opts.officialRequests) schedule(gen); else void tick(gen);
    },
    stop(): void {
      running = false;
      generation += 1;
      clearTimer();
      unsubscribe?.(); unsubscribe = null;
      unvisibility?.(); unvisibility = null;
      tickets.clear();
    },
    get running(): boolean { return running; },
    get cursor(): number | null { return cursor; },
  };
}
