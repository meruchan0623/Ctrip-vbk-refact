/**
 * I-30a typing state (FE-30).
 *
 * Outbound: XMPP `<message type="input_state">` (desktop capture round 3:
 * attributes `from,to,type,id,isGroup,xmlns`; never HTTP), at most one per 3 s
 * per conversation. The throttle lives here AND in the UI feature so a second
 * caller cannot multiply it. This module sends nothing by itself: the frame
 * is handed to `ctx.sdk.sendInputState`, a capability the page glue provides
 * once the web facade is verified. Without it the op reports `unsupported`
 * and does not consume the throttle.
 *
 * Inbound: `input_state` frames (msgtype 9901) from someone other than the
 * agent become `typing` facts that expire on their own (`TYPING_VISIBLE_MS`);
 * the tracker keeps no timers.
 */

import type { SdkMessageEvent } from './deps.ts';
import { argRecord, argString, FeatureOpError, validGid, type AdapterFeature, type FeatureOpContext } from './features.ts';
import { resolveSdkAddress } from './facts.ts';

export const TYPING_THROTTLE_MS = 3000;
/** How long an inbound typing frame keeps the indicator on (UI decision; the wire carries no duration). */
export const TYPING_VISIBLE_MS = 5000;
export const TYPING_MAX_TRACKED = 256;

export type TypingSendResult =
  | { readonly sent: true }
  | { readonly sent: false; readonly reason: 'throttled' | 'unsupported' | 'not_sent' | 'unknown_conversation' };

/** Per-gid send throttle; pure, the caller supplies the clock. */
export class TypingThrottle {
  readonly #last = new Map<string, number>();

  /** True (and recorded) when a frame for `gid` may go out at `nowMs`. */
  admit(gid: string, nowMs: number): boolean {
    const last = this.#last.get(gid);
    if (last !== undefined && nowMs >= last && nowMs - last < TYPING_THROTTLE_MS) return false;
    if (last === undefined && this.#last.size >= TYPING_MAX_TRACKED) {
      let oldest: string | null = null;
      let oldestAt = Infinity;
      for (const [k, v] of this.#last) {
        if (v < oldestAt) {
          oldest = k;
          oldestAt = v;
        }
      }
      if (oldest !== null) this.#last.delete(oldest);
    }
    this.#last.set(gid, nowMs);
    return true;
  }

  /** Releases a slot recorded by `admit` when the frame was not actually sent. */
  release(gid: string): void {
    this.#last.delete(gid);
  }

  clear(): void {
    this.#last.clear();
  }

  get size(): number {
    return this.#last.size;
  }
}

export async function sendTypingState(throttle: TypingThrottle, ctx: FeatureOpContext, gid: string): Promise<TypingSendResult> {
  if (!validGid(gid)) throw new FeatureOpError('adapter.failed', 'invalid gid');
  const view = ctx.conversation(gid);
  if (!view) return { sent: false, reason: 'unknown_conversation' };
  const send = ctx.sdk.sendInputState;
  if (typeof send !== 'function') return { sent: false, reason: 'unsupported' };
  if (!throttle.admit(gid, ctx.deps.now())) return { sent: false, reason: 'throttled' };
  let ok = false;
  try {
    ok = (await send.call(ctx.sdk, { gid, partnerJid: null })) === true;
  } catch {
    ok = false;
  }
  if (!ok) {
    throttle.release(gid);
    return { sent: false, reason: 'not_sent' };
  }
  return { sent: true };
}

/** Pure parse of an inbound frame; `null` unless it is somebody else's typing state. */
export function parseInboundTyping(evt: SdkMessageEvent, selfUid: string | null): { readonly gid: string; readonly from: string } | null {
  if (typeof evt !== 'object' || evt === null || evt.type !== 'input_state') return null;
  // same address rules as the message facts (facts.ts), so gid/sender agree with them
  const roles = { selfUid: selfUid ?? '', roleOf: () => 'unknown' as const };
  const address = resolveSdkAddress(evt, roles);
  if (!address || address.gid === '' || address.senderId === '') return null;
  if (selfUid !== null && address.senderId.toLowerCase() === selfUid.toLowerCase()) return null;
  return { gid: address.gid, from: address.senderId };
}

/** Expiring set of "who is typing where"; no timers, queried with the current time. */
export class TypingTracker {
  readonly #until = new Map<string, { from: string; until: number }>();

  observe(gid: string, from: string, nowMs: number): { readonly gid: string; readonly from: string; readonly until_ms: number } {
    const until = nowMs + TYPING_VISIBLE_MS;
    if (!this.#until.has(gid) && this.#until.size >= TYPING_MAX_TRACKED) this.prune(nowMs);
    if (!this.#until.has(gid) && this.#until.size >= TYPING_MAX_TRACKED) {
      const first = this.#until.keys().next();
      if (!first.done) this.#until.delete(first.value);
    }
    this.#until.set(gid, { from, until });
    return { gid, from, until_ms: until };
  }

  /** Who is typing in `gid` right now, if anyone. */
  active(gid: string, nowMs: number): string | null {
    const e = this.#until.get(gid);
    if (!e) return null;
    if (e.until <= nowMs) {
      this.#until.delete(gid);
      return null;
    }
    return e.from;
  }

  /** A real message from the typist ends the indicator immediately. */
  clear(gid: string): void {
    this.#until.delete(gid);
  }

  prune(nowMs: number): void {
    for (const [k, v] of this.#until) if (v.until <= nowMs) this.#until.delete(k);
  }

  get size(): number {
    return this.#until.size;
  }
}

export function createTypingFeature(): AdapterFeature & { readonly throttle: TypingThrottle; readonly tracker: TypingTracker } {
  const throttle = new TypingThrottle();
  const tracker = new TypingTracker();
  return {
    id: 'typing',
    throttle,
    tracker,
    ops: {
      'typing.send': async (args, ctx) => sendTypingState(throttle, ctx, argString(argRecord(args), 'gid')),
    },
    onSdkMessage(evt, ctx) {
      const parsed = parseInboundTyping(evt, ctx.selfUid());
      if (!parsed) return;
      const f = tracker.observe(parsed.gid, parsed.from, ctx.deps.now());
      ctx.emit({ kind: 'typing', gid: f.gid, from: f.from, until_ms: f.until_ms });
    },
    dispose() {
      throttle.clear();
      tracker.prune(Infinity);
    },
  };
}
