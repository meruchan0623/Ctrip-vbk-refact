/**
 * `11679/getRecentMessages` compensation loop (SDK head).
 *
 * Body `{beginMsgTime, pageSize: 100, head}`; `beginMsgTime` ← previous
 * `lastMessageTimestamp`. Response has `lastMessageTimestamp` and, when
 * there is anything new, `messages[]` and `localIds[]`.
 *
 * Cadence mirrors the static SDK policy (docs/research/2026-10-30-web-im-transport-and-polling.md §5):
 * - transport `connected`: normal loop, 10 000 ms, and the SDK stops that
 *   loop 300 000 ms after it started (`normalLoopStopAfterMs`, configurable,
 *   finite by default; target-machine recovery acceptance remains pending)
 * - any other transport state: frequent loop, 5 000 ms (half of normal)
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
  readonly normalLoopStopAfterMs?: number;
  /** Mirror the SDK's "stop normal loop after 5 minutes" (unverified); default true. */
  readonly stopNormalLoopAfterLimit?: boolean;
  readonly pageSize?: number;
  readonly msgTypeOverrides?: MsgTypeOverrides;
  readonly onOutcome?: (outcome: SoaOutcome<RecentMessagesResponse>) => void;
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
  const finite = (value: number | undefined, fallback: number, minimum: number): number => typeof value === 'number' && Number.isFinite(value) && value >= minimum ? value : fallback;
  const normalMs = finite(opts.normalIntervalMs, 10000, 5000);
  const frequentMs = finite(opts.frequentIntervalMs, 5000, 5000);
  const stopAfterMs = finite(opts.normalLoopStopAfterMs, 300000, 1);
  const stopNormal = opts.stopNormalLoopAfterLimit ?? true;
  const pageSize = Number.isInteger(opts.pageSize) && opts.pageSize! > 0 && opts.pageSize! <= OBSERVED_PAGE_SIZE ? opts.pageSize! : OBSERVED_PAGE_SIZE;

  let running = false;
  let generation = 0;
  let cursor = Number.isFinite(opts.initialBeginMsgTime) && opts.initialBeginMsgTime >= 0 ? opts.initialBeginMsgTime : 0;
  let lastAttempt = -Infinity;
  let inFlight = false;
  let failures = 0;
  const seen = new Set<string>();
  let transport: TransportState = 'disconnected';
  let mode: 'normal' | 'frequent' | 'stopped' = 'stopped';
  let timer: unknown = null;
  let limitTimer: unknown = null;

  const clearTimers = (): void => {
    if (timer !== null) deps.clearTimeout(timer);
    if (limitTimer !== null) deps.clearTimeout(limitTimer);
    timer = null;
    limitTimer = null;
  };

  const schedule = (gen: number): void => {
    if (mode === 'stopped') return;
    timer = deps.setTimeout(() => {
      timer = null;
      void tick(gen);
    }, Math.min(60000, (mode === 'normal' ? normalMs : frequentMs) * 2 ** Math.min(failures, 4)));
  };

  const stopped = (): boolean => mode === 'stopped';
  const tick = async (gen: number): Promise<void> => {
    if (!running || gen !== generation || stopped()) return;
    if (inFlight || deps.now() - lastAttempt < 5000) { schedule(gen); return; }
    lastAttempt = deps.now();
    inFlight = true;
    const outcome = await soa.post<RecentMessagesResponse>(Endpoints.RECENT_MESSAGES, recentMessagesBody(deps, cursor, pageSize), { retryNetworkErrors: false });
    inFlight = false;
    if (!running || gen !== generation || stopped()) return;
    failures = outcome.kind === 'success' ? 0 : Math.min(failures + 1, 4);
    opts.onOutcome?.(outcome);
    if (outcome.kind === 'auth_invalid') {
      running = false;
      mode = 'stopped';
      opts.emit({ kind: 'auth_invalid' });
      return;
    }
    if (outcome.kind === 'success') {
      const rows = Array.isArray(outcome.body.messages) ? (outcome.body.messages as HttpMessageObject[]) : [];
      for (const row of rows) {
        const fact = normalizeHttpMessage(row, { roles: opts.roles, source: 'compensation', ...(opts.msgTypeOverrides ? { msgTypeOverrides: opts.msgTypeOverrides } : {}) });
        if (fact) {
          const key = JSON.stringify([fact.gid, fact.message_id]);
          if (seen.has(key)) continue;
          seen.add(key);
          if (seen.size > 4096) seen.delete(seen.values().next().value!);
          opts.emit({ kind: 'message', fact });
        }
      }
      const ts = normalizeTimeMs(outcome.body.lastMessageTimestamp);
      if (ts !== null) cursor = Math.max(cursor, ts);
      opts.emit({ kind: 'compensation_sync', last_message_timestamp_ms: ts });
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
        }, stopAfterMs);
      }
    } else {
      mode = 'frequent';
    }
    void tick(gen);
  };

  return {
    start(initial: TransportState): void {
      if (running) return;
      running = true;
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
