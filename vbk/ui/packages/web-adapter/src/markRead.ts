/**
 * Read receipt through the official SDK:
 * `putAdviceOfReadByMsgId({partnerJid, msgId, conversationType: 'groupchat'})`
 * → HTTP `11679/PutAdviceOfReadByMsgId.json` (evidence 71).
 *
 * This is the chat read receipt. The notice-center `putAdviceofreadIQMessage`
 * is a different endpoint with different spelling and parameters; never
 * route one through the other. Marking read is a consumption fact only: it
 * never ends a waiting round (strong-alert §4.5).
 *
 * Pacing (I-06, official desktop capture round 5): the receipt is
 * cursor-like — one receipt per conversation carrying the **last
 * counterpart** message's `msgId`, not one per message. The official client
 * even repeats it twice per opening; this adapter must not:
 *
 * - {@link selectReadTarget} picks that message from a conversation's messages;
 * - {@link markRead} sends a given `(partnerJid, msgId)` at most once per SDK
 *   handle (concurrent calls share one request; `acked` and `unknown`
 *   outcomes are remembered, a definite `failed` may be retried).
 */

import type { ImSdkHandle, SdkCallOutcome } from './deps.ts';

export interface MarkReadRequest {
  /** SDK-generated target JID for the group; taken from the SDK/conversation, not built here. */
  readonly partnerJid: string;
  readonly msgId: string;
}

export type MarkReadResult = { readonly kind: 'acked'; readonly deduped?: true } | { readonly kind: 'failed'; readonly raw: unknown } | { readonly kind: 'unknown' };

/** Minimal message view for target selection. */
export interface ReadCandidate {
  readonly msgId: string | null | undefined;
  readonly createTimeMs: number;
  /** Sent by this agent. */
  readonly fromSelf: boolean;
  /** System / notice rows never carry a read receipt. */
  readonly system?: boolean;
  /** Already read according to the server (`isread`). */
  readonly read?: boolean;
}

/**
 * The newest counterpart message that still needs a receipt, or `null`.
 * Like the official client it ignores own and system messages, and returns
 * `null` when the newest counterpart message is already read (nothing to send).
 */
export function selectReadTarget(messages: readonly ReadCandidate[]): string | null {
  let best: ReadCandidate | null = null;
  for (const m of messages) {
    if (m.fromSelf || m.system === true) continue;
    if (typeof m.msgId !== 'string' || m.msgId === '') continue;
    if (!Number.isFinite(m.createTimeMs)) continue;
    if (best === null || m.createTimeMs >= best.createTimeMs) best = m;
  }
  return best === null || best.read === true ? null : (best.msgId as string);
}

const MAX_REMEMBERED = 256;
const sent = new WeakMap<object, Map<string, Promise<MarkReadResult>>>();

function ledgerOf(sdk: ImSdkHandle): Map<string, Promise<MarkReadResult>> {
  let ledger = sent.get(sdk);
  if (!ledger) {
    ledger = new Map();
    sent.set(sdk, ledger);
  }
  return ledger;
}

export async function markRead(sdk: ImSdkHandle, req: MarkReadRequest): Promise<MarkReadResult> {
  if (req.partnerJid === '' || req.msgId === '') return { kind: 'failed', raw: 'empty target' };
  const ledger = ledgerOf(sdk);
  const key = JSON.stringify([req.partnerJid, req.msgId]);
  const previous = ledger.get(key);
  if (previous) {
    const r = await previous;
    return r.kind === 'acked' ? { kind: 'acked', deduped: true } : r;
  }
  const attempt = send(sdk, req);
  ledger.set(key, attempt);
  if (ledger.size > MAX_REMEMBERED) {
    const oldest = ledger.keys().next();
    if (!oldest.done) ledger.delete(oldest.value);
  }
  const result = await attempt;
  // Only a definite rejection may be retried; an uncertain write must not be repeated blindly.
  if (result.kind === 'failed' && ledger.get(key) === attempt) ledger.delete(key);
  return result;
}

async function send(sdk: ImSdkHandle, req: MarkReadRequest): Promise<MarkReadResult> {
  let outcome: SdkCallOutcome;
  try {
    outcome = await sdk.putAdviceOfReadByMsgId({ partnerJid: req.partnerJid, msgId: req.msgId, conversationType: 'groupchat' });
  } catch {
    return { kind: 'unknown' };
  }
  return outcome.kind === 'success' ? { kind: 'acked' } : { kind: 'failed', raw: outcome.raw };
}
