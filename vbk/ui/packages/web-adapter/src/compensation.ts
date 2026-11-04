/**
 * `11679/getRecentMessages` compensation loop (SDK head).
 *
 * Body `{beginMsgTime, pageSize: 100, head}`; `beginMsgTime` ← previous
 * `lastMessageTimestamp`. Response has `lastMessageTimestamp` and, when
 * there is anything new, `messages[]` and `localIds[]`.
 *
 * Cadence mirrors the static SDK policy (docs/research/2026-10-30-web-im-transport-and-polling.md §5):
 * - transport `connected`: normal loop, 10 000 ms, and the SDK stops that
 *   loop 300 000 ms after it started. Configurable (`normalLoopStopAfterMs`,
 *   `null` = never); the 300 s default is the static SDK value and NOT
 *   fault-injection verified, so the production session sets it explicitly
 * - any other transport state: frequent loop, 5 000 ms (half of normal)
 *
 * Pacing guards (docs/api/transports.md "请求节奏"): at most one request in
 * flight; never two requests closer than {@link MIN_REQUEST_INTERVAL_MS},
 * even across transport changes (a flapping socket cannot burst); failures
 * back off exponentially up to {@link MAX_BACKOFF_MS}; messages are emitted
 * once per `(gid, message_id)` per run; the cursor only moves forward.
 *
 * Every message becomes `MessageFact(source: 'compensation')`; each round
 * ends with `compensation_sync`.
 */

import type { AdapterFact, TransportState } from '../../ipc/src/contracts.ts';
import type { AdapterDeps } from './deps.ts';
import { Endpoints } from './endpoints.ts';
import { sdkHead } from './heads.ts';
import type { SoaClient, SoaOutcome } from './soa.ts';
import { normalizeHttpMessage, normalizeTimeMs, type HttpMessageObject, type MemberRoles, type MsgTypeOverrides } from './facts.ts';

export const OBSERVED_PAGE_SIZE = 100;
/** Static SDK policy: the normal loop stops 300 s after it started. Unverified by fault injection. */
export const DEFAULT_NORMAL_LOOP_STOP_AFTER_MS = 300_000;
/** Request floor: no two `getRecentMessages` requests closer than this, whatever the mode or transport. */
export const MIN_REQUEST_INTERVAL_MS = 5_000;
/** Ceiling of the failure backoff. */
export const MAX_BACKOFF_MS = 60_000;
const MAX_BACKOFF_EXPONENT = 4;
const MAX_SEEN = 4096;

/** `null` = never stop. Non-finite or non-positive values are configuration errors and fall back to the default. */
export function resolveNormalLoopStopAfterMs(opts: Pick<CompensationOptions, 'normalLoopStopAfterMs' | 'stopNormalLoopAfterLimit'>): number | null {
  if (opts.stopNormalLoopAfterLimit === false) return null;
  const v = opts.normalLoopStopAfterMs;
  if (v === null) return null;
  return v !== undefined && Number.isFinite(v) && v > 0 ? v : DEFAULT_NORMAL_LOOP_STOP_AFTER_MS;
}

export interface RecentMessagesResponse {
  readonly lastMessageTimestamp?: unknown;
  readonly messages?: unknown;
  readonly localIds?: unknown;
}

export interface CompensationOptions {
  readonly emit: (fact: AdapterFact) => void;
  readonly roles: MemberRoles;
  /** Persisted watermark; the first request sends it as `beginMsgTime`. */
  readonly initialBeginMsgTime: number;
  readonly normalIntervalMs?: number;
  readonly frequentIntervalMs?: number;
  /**
   * Stop the normal (connected) loop this long after it started. `null` = never
   * stop. Omitted = {@link DEFAULT_NORMAL_LOOP_STOP_AFTER_MS}, the static SDK
   * value, which has NOT been fault-injection verified; the production default
   * is decided after that test (I-06), so callers choose explicitly.
   */
  readonly normalLoopStopAfterMs?: number | null;
  /** Legacy switch: `false` = never stop (same as `normalLoopStopAfterMs: null`) and wins over it. */
  readonly stopNormalLoopAfterLimit?: boolean;
  readonly pageSize?: number;
  readonly msgTypeOverrides?: MsgTypeOverrides;
  /** Captured right before each request; handed back to `onOutcome` so a late response can be bound to the state it was issued in. */
  readonly onRequest?: () => unknown;
  readonly onOutcome?: (outcome: SoaOutcome<RecentMessagesResponse>, ticket?: unknown) => void;
}

export interface CompensationLoop {
  start(transport: TransportState): void;
  stop(): void;
  setTransport(state: TransportState): void;
  readonly running: boolean;
  readonly cursor: number;
  readonly mode: 'normal' | 'frequent' | 'stopped';
}

export function recentMessagesBody(deps: AdapterDeps, beginMsgTime: number, pageSize: number): { beginMsgTime: number; pageSize: number; head: ReturnType<typeof sdkHead> } {
  return { beginMsgTime, pageSize, head: sdkHead(deps.context) };
}

export function createCompensationLoop(deps: AdapterDeps, soa: SoaClient, opts: CompensationOptions): CompensationLoop {
  const interval = (value: number | undefined, fallback: number): number =>
    Math.max(MIN_REQUEST_INTERVAL_MS, typeof value === 'number' && Number.isFinite(value) ? value : fallback);
  const normalMs = interval(opts.normalIntervalMs, 10000);
  const frequentMs = interval(opts.frequentIntervalMs, 5000);
  const stopAfterMs = resolveNormalLoopStopAfterMs(opts);
  const stopNormal = stopAfterMs !== null;
  const pageSize = typeof opts.pageSize === 'number' && Number.isInteger(opts.pageSize) && opts.pageSize > 0 && opts.pageSize <= OBSERVED_PAGE_SIZE ? opts.pageSize : OBSERVED_PAGE_SIZE;

  let running = false;
  let generation = 0;
  let cursor = Number.isFinite(opts.initialBeginMsgTime) && opts.initialBeginMsgTime >= 0 ? opts.initialBeginMsgTime : 0;
  let transport: TransportState = 'disconnected';
  let mode: 'normal' | 'frequent' | 'stopped' = 'stopped';
  let timer: unknown = null;
  let limitTimer: unknown = null;
  /** Run (start → stop) whose request is in flight; a stopped run's request never blocks the next run. */
  let run = 0;
  let inFlightRun: number | null = null;
  let lastAttemptAt = Number.NEGATIVE_INFINITY;
  let failures = 0;
  const seen = new Set<string>();

  const clearTimers = (): void => {
    if (timer !== null) deps.clearTimeout(timer);
    if (limitTimer !== null) deps.clearTimeout(limitTimer);
    timer = null;
    limitTimer = null;
  };

  const backoff = (base: number): number => (failures === 0 ? base : Math.min(MAX_BACKOFF_MS, base * 2 ** failures));
  /** Earliest time the next request may start; a transport change cannot pull it earlier. */
  const earliestNext = (): number => lastAttemptAt + backoff(MIN_REQUEST_INTERVAL_MS);

  const arm = (gen: number, delayMs: number): void => {
    if (timer !== null) deps.clearTimeout(timer);
    timer = deps.setTimeout(() => {
      timer = null;
      void tick(gen);
    }, Math.max(0, delayMs));
  };

  const schedule = (gen: number): void => {
    if (mode === 'stopped') return;
    arm(gen, Math.max(backoff(mode === 'normal' ? normalMs : frequentMs), earliestNext() - deps.now()));
  };

  const stopped = (): boolean => mode === 'stopped';
  const tick = async (gen: number): Promise<void> => {
    if (!running || gen !== generation || mode === 'stopped') return;
    // Single flight: the pending request schedules the next round when it settles.
    if (inFlightRun === run) return;
    const wait = earliestNext() - deps.now();
    if (wait > 0) { arm(gen, wait); return; }
    const myRun = run;
    inFlightRun = myRun;
    lastAttemptAt = deps.now();
    const ticket = opts.onRequest?.();
    let outcome: SoaOutcome<RecentMessagesResponse>;
    try {
      outcome = await soa.post<RecentMessagesResponse>(Endpoints.RECENT_MESSAGES, recentMessagesBody(deps, cursor, pageSize));
    } finally {
      if (inFlightRun === myRun) inFlightRun = null;
    }
    if (!running || myRun !== run || stopped()) return;
    // A response that straddled a restart is dropped (the next round re-reads
    // from the unchanged cursor), but the current generation still needs its round.
    if (gen !== generation) { if (timer === null) schedule(generation); return; }
    opts.onOutcome?.(outcome, ticket);
    if (outcome.kind === 'auth_invalid') {
      running = false;
      mode = 'stopped';
      clearTimers();
      opts.emit({ kind: 'auth_invalid' });
      return;
    }
    if (outcome.kind === 'success') {
      failures = 0;
      const rows = Array.isArray(outcome.body.messages) ? (outcome.body.messages as HttpMessageObject[]) : [];
      for (const row of rows) {
        const fact = normalizeHttpMessage(row, { roles: opts.roles, source: 'compensation', ...(opts.msgTypeOverrides ? { msgTypeOverrides: opts.msgTypeOverrides } : {}) });
        if (!fact) continue;
        if (fact.message_id !== null) {
          const key = JSON.stringify([fact.gid, fact.message_id]);
          if (seen.has(key)) continue;
          seen.add(key);
          if (seen.size > MAX_SEEN) {
            const oldest = seen.values().next();
            if (!oldest.done) seen.delete(oldest.value);
          }
        }
        opts.emit({ kind: 'message', fact });
      }
      const ts = normalizeTimeMs(outcome.body.lastMessageTimestamp);
      if (ts !== null) cursor = Math.max(cursor, ts);
      opts.emit({ kind: 'compensation_sync', last_message_timestamp_ms: ts });
    } else {
      failures = Math.min(failures + 1, MAX_BACKOFF_EXPONENT);
    }
    schedule(gen);
  };

  const restart = (): void => {
    clearTimers();
    generation += 1;
    const gen = generation;
    if (transport === 'connected') {
      mode = 'normal';
      if (stopNormal) {
        limitTimer = deps.setTimeout(() => {
          limitTimer = null;
          if (gen === generation && mode === 'normal') {
            mode = 'stopped';
            if (timer !== null) deps.clearTimeout(timer);
            timer = null;
          }
        }, stopAfterMs ?? 0);
      }
    } else {
      mode = 'frequent';
    }
    // Immediate only when the request floor / backoff allows it; otherwise armed for that moment.
    void tick(gen);
  };

  return {
    start(initial: TransportState): void {
      if (running) return;
      running = true;
      run += 1;
      lastAttemptAt = Number.NEGATIVE_INFINITY;
      failures = 0;
      seen.clear();
      transport = initial;
      restart();
    },
    stop(): void {
      running = false;
      mode = 'stopped';
      generation += 1;
      clearTimers();
    },
    setTransport(state: TransportState): void {
      if (state === transport) return;
      transport = state;
      if (running) restart();
    },
    get running(): boolean {
      return running;
    },
    get cursor(): number {
      return cursor;
    },
    get mode(): 'normal' | 'frequent' | 'stopped' {
      return mode;
    },
  };
}
