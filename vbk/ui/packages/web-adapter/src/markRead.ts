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
import { jidLocal, normalizeTimeMs } from './facts.ts';
import type { ConversationStore, LatestMessage } from './stores.ts';

export interface MarkReadRequest {
  /** SDK-generated target JID for the group; taken from the SDK/conversation, not built here. */
  readonly partnerJid: string;
  readonly msgId: string;
  /** Service/context revision, keeping reused rooms in separate receipt scopes. */
  readonly contextRevision?: string;
}

export type MarkReadResult = { readonly kind: 'acked' } | { readonly kind: 'failed'; readonly raw: unknown } | { readonly kind: 'unknown' };

const receipts = new WeakMap<ImSdkHandle, Map<string, Promise<MarkReadResult>>>();

export function markRead(sdk: ImSdkHandle, req: MarkReadRequest): Promise<MarkReadResult> {
  if (req.partnerJid === '' || req.msgId === '') return Promise.resolve({ kind: 'failed', raw: 'empty target' });
  let cache = receipts.get(sdk);
  if (!cache) { cache = new Map(); receipts.set(sdk, cache); }
  const key = JSON.stringify([req.partnerJid, req.contextRevision ?? '', req.msgId]);
  const previous = cache.get(key);
  if (previous) return previous;
  const result = submitRead(sdk, req);
  cache.set(key, result); // include unknown/failure: never silently replay a receipt
  return result;
}

async function submitRead(sdk: ImSdkHandle, req: MarkReadRequest): Promise<MarkReadResult> {
  if (req.partnerJid === '' || req.msgId === '') return { kind: 'failed', raw: 'empty target' };
  let outcome: SdkCallOutcome;
  try {
    outcome = await sdk.putAdviceOfReadByMsgId({ partnerJid: req.partnerJid, msgId: req.msgId, conversationType: 'groupchat' });
  } catch {
    return { kind: 'unknown' };
  }
  return outcome.kind === 'success' ? { kind: 'acked' } : { kind: 'failed', raw: outcome.raw };
}

// Only authoritative list rows may advance this cursor. Gid-only history or
// realtime messages do not establish the service/customer association.
const peerTargets = new WeakMap<ConversationStore, Map<string, { revision: number | null; target: LatestMessage | null }>>();
export function latestPeerReadTarget(store: ConversationStore, gid: string): LatestMessage | null {
  let targets = peerTargets.get(store);
  if (!targets) { targets = new Map(); peerTargets.set(store, targets); }
  const revision = store.messageContext(gid);
  let entry = targets.get(gid);
  if (!entry || entry.revision !== revision) { entry = { revision, target: null }; targets.set(gid, entry); }
  const view = store.view(gid);
  const message = view?.lastMessage;
  const sender = typeof message?.fromJid === 'string' ? jidLocal(message.fromJid).toLowerCase() : '';
  const customer = view?.customerUid?.toLowerCase();
  const time = normalizeTimeMs(message?.createTime);
  const id = message?.msgId;
  if (customer && sender === customer && typeof id === 'string' && id !== '' && time !== null && (!entry.target || time >= entry.target.createTime)) {
    entry.target = { msgId: id, createTime: time };
  }
  return entry.target;
}
