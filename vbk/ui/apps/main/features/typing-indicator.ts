/**
 * I-30a typing state (FE-30), main-window half.
 *
 * Outbound: when the agent edits the draft of the open conversation, ask the
 * host (`im_send_input_state`, XMPP via the page SDK) to emit a typing frame,
 * at most once per 3 s per conversation. Only a CHANGE of the draft while the
 * conversation stays open counts: switching conversations, restoring a saved
 * draft or sending never emits a frame. If the host says the capability is
 * unsupported (the web facade is not verified yet) the feature stops asking
 * for this session instead of retrying; any other failure backs off 30 s.
 *
 * Inbound: `typing` facts show "对方正在输入…" for the open conversation until
 * `until_ms`; the indicator removes itself through one runtime timer, never a
 * polling loop.
 */

import { h } from '../../../packages/ui-kit/src/h.ts';
import type { AccountContext } from '../../../packages/ipc/src/contracts.ts';
import type { FeatureContext, FeatureFact, FeatureModule, TimerHandle } from './context.ts';

export const TYPING_COMMAND = 'im_send_input_state';
export const TYPING_THROTTLE_MS = 3000;
export const TYPING_FAILURE_BACKOFF_MS = 30_000;
const MAX_TRACKED = 256;

export interface TypingReply {
  readonly sent: boolean;
  readonly reason?: 'throttled' | 'unsupported' | 'not_sent' | 'unknown_conversation';
}

/** Decides whether a draft change should emit a typing frame. Pure; the module owns the state. */
export class OutboundTyping {
  readonly #lastText = new Map<string, string>();
  readonly #lastSent = new Map<string, number>();
  #blockedUntil = 0;
  #unsupported = false;

  /** Returns true when a frame should be requested now for `gid` with draft `text`. */
  observe(gid: string, text: string, nowMs: number): boolean {
    const previous = this.#lastText.get(gid);
    if (this.#lastText.size >= MAX_TRACKED && previous === undefined) this.#lastText.clear();
    this.#lastText.set(gid, text);
    if (previous === undefined || previous === text) return false; // first sight (switch/restore) or no change
    if (text.trim() === '') return false; // deleting everything is not typing
    if (this.#unsupported || nowMs < this.#blockedUntil) return false;
    const last = this.#lastSent.get(gid);
    if (last !== undefined && nowMs >= last && nowMs - last < TYPING_THROTTLE_MS) return false;
    if (this.#lastSent.size >= MAX_TRACKED && last === undefined) this.#lastSent.clear();
    this.#lastSent.set(gid, nowMs);
    return true;
  }

  /** Conversation closed or sent: the next sight is a first sight again. */
  forget(gid: string): void {
    this.#lastText.delete(gid);
  }

  /** Host answered. `unsupported` is final for the session; other failures back off. */
  settle(reply: TypingReply | null, nowMs: number): void {
    if (reply === null) this.#blockedUntil = nowMs + TYPING_FAILURE_BACKOFF_MS;
    else if (reply.sent === false && reply.reason === 'unsupported') this.#unsupported = true;
  }

  get unsupported(): boolean {
    return this.#unsupported;
  }
}

interface Indicator {
  readonly account: AccountContext;
  readonly from: string;
  readonly untilMs: number;
}

/** Who is typing in `gid` at `nowMs` for `account`, or null. */
export function typingNow(map: ReadonlyMap<string, Indicator>, account: AccountContext, gid: string, nowMs: number): string | null {
  const e = map.get(gid);
  if (!e || e.untilMs <= nowMs) return null;
  return e.account.account_id === account.account_id && e.account.environment === account.environment && e.account.session_generation === account.session_generation ? e.from : null;
}

export function createTypingIndicator(): FeatureModule {
  const outbound = new OutboundTyping();
  const inbound = new Map<string, Indicator>();
  let ctx: FeatureContext | null = null;
  let expiry: TimerHandle | null = null;
  let off: (() => void) | null = null;

  function scheduleExpiry(): void {
    if (!ctx) return;
    if (expiry !== null) ctx.clearTimer(expiry);
    expiry = null;
    const now = ctx.nowMs();
    let next = Infinity;
    for (const [gid, e] of inbound) {
      if (e.untilMs <= now) inbound.delete(gid);
      else next = Math.min(next, e.untilMs);
    }
    if (next !== Infinity) {
      expiry = ctx.setTimer(() => {
        expiry = null;
        scheduleExpiry();
        ctx?.requestRender();
      }, Math.max(50, next - now));
    }
  }

  function onStoreChange(): void {
    if (!ctx) return;
    const scope = ctx.scope();
    const draft = ctx.draft();
    if (!scope || scope.gid === null || draft.gid !== scope.gid) return;
    const gid = scope.gid;
    if (!outbound.observe(gid, draft.text, ctx.nowMs())) return;
    const c = ctx;
    c.invoke<TypingReply>(TYPING_COMMAND, { gid })
      .then((reply) => outbound.settle(reply, c.nowMs()))
      .catch(() => outbound.settle(null, c.nowMs()));
  }

  return {
    id: 'typing-indicator',
    commands: [TYPING_COMMAND],
    mount(c) {
      ctx = c;
      off = c.subscribe(onStoreChange);
      c.registerSlot('composer-hint', (scope) => {
        if (scope.gid === null) return null;
        const who = typingNow(inbound, scope.account, scope.gid, c.nowMs());
        return who === null ? null : h('div', { class: 'typing-hint', role: 'status', dataset: { feature: 'typing' } }, c.t('typing.indicator'));
      });
    },
    onFact(fact: FeatureFact) {
      if (!ctx || fact.kind !== 'typing') return;
      if (!ctx.isCurrent(fact.account)) return;
      if (inbound.size >= MAX_TRACKED && !inbound.has(fact.gid)) inbound.clear();
      inbound.set(fact.gid, { account: fact.account, from: fact.from, untilMs: fact.until_ms });
      scheduleExpiry();
      ctx.requestRender();
    },
    dispose() {
      off?.();
      off = null;
      if (ctx && expiry !== null) ctx.clearTimer(expiry);
      expiry = null;
      inbound.clear();
      ctx = null;
    },
  };
}
