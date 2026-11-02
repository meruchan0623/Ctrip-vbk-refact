/**
 * I-30d queue banner (FE-44), main-window half.
 *
 * The official client polls `checkManualAgentStatus` only while the queue
 * system message (`action` `NBZ11`) is on screen (live capture round 1
 * correction of F-06). This module keeps that bound:
 * - polling starts when a `queue_notice` fact arrives for a conversation and
 *   runs ONLY for the conversation that is open, while the window is visible;
 * - cadence 3 s, doubling on failures up to 30 s, and it stops for good on an
 *   auth failure, an `unsupported` answer, after 200 polls (about 10 min), or
 *   when the user dismisses the banner. There is no global agent-status loop;
 * - the banner shows only what the server sent (`resultMessage`); the queue
 *   length is not shown because no field for it was ever captured;
 * - 「退出排队」 (`dropOutManual`) is disabled with an explanation: its
 *   endpoint was never captured, so the command reports `unsupported` and the
 *   button is not wired to any write.
 */

import { h } from '../../../packages/ui-kit/src/h.ts';
import type { AccountContext } from '../../../packages/ipc/src/contracts.ts';
import type { FeatureContext, FeatureFact, FeatureModule, TimerHandle } from './context.ts';

export const QUEUE_STATUS_COMMAND = 'im_queue_status';
export const QUEUE_DROP_OUT_COMMAND = 'im_queue_drop_out';
export const QUEUE_POLL_MS = 3000;
export const QUEUE_POLL_MAX_MS = 30_000;
export const QUEUE_MAX_POLLS = 200;
export const QUEUE_MAX_TRACKED = 64;

export type QueueReply =
  | { readonly kind: 'ok'; readonly resultCode: string | null; readonly resultMessage: string | null }
  | { readonly kind: 'unsupported'; readonly reason: string }
  | { readonly kind: 'failed'; readonly reason: 'auth' | 'network' | 'timeout' | 'rejected' | 'malformed' };

export function queueDelay(consecutiveFailures: number): number {
  return Math.min(QUEUE_POLL_MS * 2 ** Math.max(0, Math.min(consecutiveFailures, 10)), QUEUE_POLL_MAX_MS);
}

export interface QueueEntry {
  readonly account: AccountContext;
  readonly gid: string;
  polls: number;
  failures: number;
  detail: string | null;
  stopped: boolean;
  dismissed: boolean;
}

const sameAccount = (a: AccountContext, b: AccountContext): boolean => a.account_id === b.account_id && a.environment === b.environment && a.session_generation === b.session_generation;

/** Pure poll bookkeeping; the module only adds timers and rendering. */
export class QueueTracker {
  readonly #entries = new Map<string, QueueEntry>();

  start(account: AccountContext, gid: string): QueueEntry {
    const k = `${account.environment}|${account.account_id}|${account.session_generation}|${gid}`;
    const existing = this.#entries.get(k);
    if (existing) return existing;
    if (this.#entries.size >= QUEUE_MAX_TRACKED) this.#entries.clear();
    const entry: QueueEntry = { account, gid, polls: 0, failures: 0, detail: null, stopped: false, dismissed: false };
    this.#entries.set(k, entry);
    return entry;
  }

  find(account: AccountContext, gid: string): QueueEntry | null {
    for (const e of this.#entries.values()) if (e.gid === gid && sameAccount(e.account, account)) return e;
    return null;
  }

  /** Applies a reply; returns the delay until the next poll or null when polling is over. */
  settle(entry: QueueEntry, reply: QueueReply | null): number | null {
    entry.polls++;
    if (reply === null) entry.failures++;
    else if (reply.kind === 'ok') {
      entry.failures = 0;
      entry.detail = reply.resultMessage;
    } else if (reply.kind === 'unsupported' || (reply.kind === 'failed' && reply.reason === 'auth')) {
      entry.stopped = true;
      return null;
    } else entry.failures++;
    if (entry.polls >= QUEUE_MAX_POLLS || entry.dismissed) {
      entry.stopped = true;
      return null;
    }
    return queueDelay(entry.failures);
  }

  dismiss(entry: QueueEntry): void {
    entry.dismissed = true;
    entry.stopped = true;
  }

  clear(): void {
    this.#entries.clear();
  }
}

export function createQueueBanner(): FeatureModule {
  const tracker = new QueueTracker();
  let ctx: FeatureContext | null = null;
  let timer: TimerHandle | null = null;
  let inflight = false;
  let off: (() => void) | null = null;

  function cancelTimer(): void {
    if (ctx && timer !== null) ctx.clearTimer(timer);
    timer = null;
  }

  function schedule(ms: number): void {
    if (!ctx) return;
    cancelTimer();
    timer = ctx.setTimer(() => {
      timer = null;
      void tick();
    }, ms);
  }

  /** Next action for the currently open conversation (called by timer and by scope changes). */
  async function tick(): Promise<void> {
    const c = ctx;
    if (!c || inflight) return;
    const scope = c.scope();
    const entry = scope && scope.gid !== null ? tracker.find(scope.account, scope.gid) : null;
    if (!scope || !entry || entry.stopped) return;
    if (!c.visible()) {
      schedule(QUEUE_POLL_MS); // wake-up only; no request while hidden
      return;
    }
    inflight = true;
    let reply: QueueReply | null = null;
    try {
      reply = await c.invoke<QueueReply>(QUEUE_STATUS_COMMAND, { gid: entry.gid });
    } catch {
      reply = null;
    } finally {
      inflight = false;
    }
    if (!ctx) return;
    const next = tracker.settle(entry, reply);
    c.requestRender();
    const now = c.scope();
    // the conversation may have changed while the request was in flight
    if (next !== null && now && now.gid === entry.gid && sameAccount(now.account, entry.account)) schedule(next);
  }

  function onScopeChange(): void {
    if (!ctx || inflight) return;
    const scope = ctx.scope();
    const entry = scope && scope.gid !== null ? tracker.find(scope.account, scope.gid) : null;
    if (!entry || entry.stopped) {
      cancelTimer();
      return;
    }
    if (timer === null) schedule(0);
  }

  return {
    id: 'queue-banner',
    commands: [QUEUE_STATUS_COMMAND, QUEUE_DROP_OUT_COMMAND],
    mount(c) {
      ctx = c;
      off = c.subscribe(onScopeChange);
      c.registerSlot('conversation-banner', (scope) => {
        const entry = scope.gid === null ? null : tracker.find(scope.account, scope.gid);
        if (!entry || entry.dismissed) return null;
        return h(
          'div',
          { class: 'queue-banner notice-box', role: 'status', dataset: { feature: 'queue' } },
          h('span', null, c.t('queue.banner')),
          entry.detail ? h('span', { class: 'muted' }, ' · ', c.t('queue.detail', { msg: entry.detail })) : null,
          h('button', { class: 'btn sm', disabled: true, title: c.t('queue.dropOutUnsupported'), dataset: { queue: 'drop-out' } }, c.t('queue.dropOut')),
          h('button', { class: 'link', dataset: { queue: 'dismiss' }, onclick: () => { tracker.dismiss(entry); cancelTimer(); c.requestRender(); } }, c.t('queue.dismiss')),
        );
      });
    },
    onFact(fact: FeatureFact) {
      if (!ctx || fact.kind !== 'queue_notice' || !ctx.isCurrent(fact.account)) return;
      tracker.start(fact.account, fact.gid);
      onScopeChange();
      ctx.requestRender();
    },
    dispose() {
      cancelTimer();
      off?.();
      off = null;
      tracker.clear();
      ctx = null;
    },
  };
}
