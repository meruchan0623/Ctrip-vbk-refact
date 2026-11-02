/**
 * I-30b active recall (FE-34): `POST 11679/recallMessage {messageId, partnerId}`.
 *
 * Live capture round 4: both ids are 19-digit STRINGS (a JSON number would
 * lose precision above 2^53), the response is `{status:{code,msg}, ResponseStatus}`
 * and the recall is broadcast back as an inbound `groupchat` frame with
 * `ext`; there is no outbound XMPP frame. The official client refuses a
 * message older than 2 minutes; the window is judged on SERVER time and an
 * unanchored clock is a refusal, not a pass (the server remains the final
 * arbiter either way).
 *
 * Unverified, flagged for the C-class sample run: `partnerId` is taken as the
 * conversation gid (rea: "fromGid || toJid"; the captured value is also a
 * 19-digit id), and `status.code === 0` as success (same convention as
 * `checkMemberStatus`). Anything else is reported, never guessed.
 *
 * A recall is irreversible and is a write: an unknown outcome is surfaced as
 * `unknown` and never replayed. The host/UI asks for a second confirmation
 * before this op is called.
 */

import type { AdapterDeps } from './deps.ts';
import { argNumber, argRecord, argString, FeatureOpError, type AdapterFeature, type FeatureOpContext } from './features.ts';
import { businessHead } from './heads.ts';
import { endpoint, recordOrNull, type EndpointSpec, type SoaClient } from './soa.ts';
import { M } from './endpoints.ts';

export const RECALL_MESSAGE: EndpointSpec = endpoint('recallMessage', M, '11679/recallMessage', 'write');
export const RECALL_WINDOW_MS = 120_000;
export const RECALL_FUTURE_TOLERANCE_MS = 5_000;

export type RecallVerdict =
  | { readonly kind: 'allowed'; readonly remainingMs: number }
  | { readonly kind: 'expired' }
  | { readonly kind: 'clock_unknown' }
  | { readonly kind: 'future_timestamp' };

/** Mirrors `core_im::feature_rules::recall_verdict`. */
export function recallVerdict(createdMs: number, serverNowMs: number | null): RecallVerdict {
  if (serverNowMs === null) return { kind: 'clock_unknown' };
  const age = serverNowMs - createdMs;
  if (age < -RECALL_FUTURE_TOLERANCE_MS) return { kind: 'future_timestamp' };
  if (age > RECALL_WINDOW_MS) return { kind: 'expired' };
  return { kind: 'allowed', remainingMs: RECALL_WINDOW_MS - Math.max(0, age) };
}

export function isWireId(v: unknown): v is string {
  return typeof v === 'string' && /^\d{19}$/.test(v);
}

export interface RecallRequest {
  /** Server message id (never a localId). */
  readonly messageId: string;
  /** Conversation group id. */
  readonly partnerId: string;
}

export type RecallResult =
  | { readonly outcome: 'recalled' }
  | { readonly outcome: 'rejected'; readonly code: number; readonly message: string | null }
  | { readonly outcome: 'refused'; readonly reason: 'invalid_id' | 'expired' | 'clock_unknown' | 'unknown_conversation' }
  | { readonly outcome: 'unknown' }
  | { readonly outcome: 'failed'; readonly reason: 'auth' | 'network' | 'timeout' };

/** The wire body, exactly `{head, messageId, partnerId}` with both ids as strings. */
export function recallBody(deps: AdapterDeps, req: RecallRequest): Record<string, unknown> {
  return { head: businessHead(deps.context), messageId: req.messageId, partnerId: req.partnerId };
}

export async function recallMessage(deps: AdapterDeps, soa: SoaClient, req: RecallRequest): Promise<RecallResult> {
  if (!isWireId(req.messageId) || !isWireId(req.partnerId)) return { outcome: 'refused', reason: 'invalid_id' };
  const out = await soa.post<unknown>(RECALL_MESSAGE, recallBody(deps, req));
  switch (out.kind) {
    case 'success': {
      const status = recordOrNull(recordOrNull(out.body)?.['status']);
      const code = status?.['code'];
      if (code === 0) return { outcome: 'recalled' };
      if (typeof code === 'number' && Number.isFinite(code)) {
        const msg = status?.['msg'];
        return { outcome: 'rejected', code, message: typeof msg === 'string' && msg !== '' ? msg : null };
      }
      return { outcome: 'unknown' };
    }
    case 'auth_invalid':
      return { outcome: 'failed', reason: 'auth' };
    case 'network_error':
      return { outcome: 'failed', reason: 'network' };
    case 'timeout':
      return { outcome: 'failed', reason: 'timeout' };
    case 'business_failure':
      // an explicit Failure ack is a rejection before any effect; anything else may have been applied
      return out.ack === 'Failure' ? { outcome: 'rejected', code: -1, message: null } : { outcome: 'unknown' };
    default:
      return { outcome: 'unknown' };
  }
}

/** Whole op: window check on server time, then the write. `createdMs` comes from the UI row and is re-judged here. */
export async function recallWithWindow(ctx: FeatureOpContext, gid: string, messageId: string, createdMs: number): Promise<RecallResult> {
  // partnerId is the gid, so it must satisfy the same 19-digit wire form
  if (!isWireId(gid) || !isWireId(messageId)) return { outcome: 'refused', reason: 'invalid_id' };
  if (!ctx.conversation(gid)) return { outcome: 'refused', reason: 'unknown_conversation' };
  const verdict = recallVerdict(createdMs, ctx.serverNowMs());
  if (verdict.kind === 'expired') return { outcome: 'refused', reason: 'expired' };
  if (verdict.kind !== 'allowed') return { outcome: 'refused', reason: 'clock_unknown' };
  const result = await recallMessage(ctx.deps, ctx.soa, { messageId, partnerId: gid });
  if (result.outcome === 'recalled') ctx.emit({ kind: 'recalled', gid, message_id: messageId });
  return result;
}

export const recallFeature: AdapterFeature = {
  id: 'recall',
  ops: {
    'recall.message': async (args, ctx) => {
      const a = argRecord(args);
      const created = argNumber(a, 'created_ms');
      if (!Number.isSafeInteger(created) || created <= 0) throw new FeatureOpError('adapter.failed', 'created_ms must be a positive integer');
      return recallWithWindow(ctx, argString(a, 'gid'), argString(a, 'message_id'), created);
    },
  },
};
