/**
 * Read receipt through the official SDK:
 * `putAdviceOfReadByMsgId({partnerJid, msgId, conversationType: 'groupchat'})`
 * → HTTP `11679/PutAdviceOfReadByMsgId.json` (evidence 71).
 *
 * This is the chat read receipt. The notice-center `putAdviceofreadIQMessage`
 * is a different endpoint with different spelling and parameters; never
 * route one through the other. Marking read is a consumption fact only: it
 * never ends a waiting round (strong-alert §4.5).
 */

import type { ImSdkHandle, SdkCallOutcome } from './deps.ts';

export interface MarkReadRequest {
  /** SDK-generated target JID for the group; taken from the SDK/conversation, not built here. */
  readonly partnerJid: string;
  readonly msgId: string;
}

export type MarkReadResult = { readonly kind: 'acked' } | { readonly kind: 'failed'; readonly raw: unknown } | { readonly kind: 'unknown' };

export async function markRead(sdk: ImSdkHandle, req: MarkReadRequest): Promise<MarkReadResult> {
  if (req.partnerJid === '' || req.msgId === '') return { kind: 'failed', raw: 'empty target' };
  let outcome: SdkCallOutcome;
  try {
    outcome = await sdk.putAdviceOfReadByMsgId({ partnerJid: req.partnerJid, msgId: req.msgId, conversationType: 'groupchat' });
  } catch {
    return { kind: 'unknown' };
  }
  return outcome.kind === 'success' ? { kind: 'acked' } : { kind: 'failed', raw: outcome.raw };
}
