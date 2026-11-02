/**
 * I-30d queue state (FE-44): the official client only polls
 * `checkManualAgentStatus` while a queue system message (`action` `NBZ11`) is
 * mounted (live capture round 1 correction of F-06); it is NOT a global
 * agent-status loop. This module therefore exposes ONE-SHOT ops; the 3 s
 * cadence, its backoff and its stop conditions belong to the UI feature
 * (`queue-banner.ts`), which runs it only for the open conversation while the
 * `NBZ11` message is present and the window is visible.
 *
 * - `queue.status`: `checkManualAgentStatus` is a client wrapper around
 *   `POST 16037/checkSessionStatus {gid, customerUid}` (rea static call site,
 *   im-peripheral-static-20261030). The captured response only carries
 *   `bizResponseStatus.{resultCode,resultMessage}`; no queue-length field was
 *   ever observed, so none is invented here.
 *   DISCREPANCY to settle on a real queued session: the official source fills
 *   `customerUid` from the AGENT's `venAgent.ctripUid`, while the endpoint doc
 *   labels it the conversation customer's uid. The op takes an explicit
 *   `customer_uid` and otherwise falls back to the cached row's customer uid.
 * - `queue.drop_out` (`dropOutManual`): the endpoint and body were never
 *   captured (only the function name is known), so the op reports
 *   `unsupported` and sends nothing.
 */

import { M } from './endpoints.ts';
import { argRecord, argString, FeatureOpError, validGid, type AdapterFeature, type FeatureOpContext } from './features.ts';
import { businessHead } from './heads.ts';
import { bizResultCode, endpoint, recordOrNull, type EndpointSpec, type SoaClient } from './soa.ts';
import type { AdapterDeps } from './deps.ts';

/** `messageBody.action` of the queue system message; exact match (NBZ112 etc. are other notices). */
export const QUEUE_NOTICE_ACTION = 'NBZ11';
export const CHECK_SESSION_STATUS: EndpointSpec = endpoint('checkSessionStatus', M, '16037/checkSessionStatus', 'read');

/** True for a message body (JSON string or object) that is the queue notice. */
export function isQueueNotice(body: unknown): boolean {
  let v: unknown = body;
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v);
    } catch {
      return false;
    }
  }
  return recordOrNull(v)?.['action'] === QUEUE_NOTICE_ACTION;
}

export type QueueStatusResult =
  | { readonly kind: 'ok'; readonly resultCode: string | null; readonly resultMessage: string | null }
  | { readonly kind: 'unsupported'; readonly reason: 'no_customer_uid' | 'unknown_conversation' }
  | { readonly kind: 'failed'; readonly reason: 'auth' | 'network' | 'timeout' | 'rejected' | 'malformed' };

export async function checkManualAgentStatus(deps: AdapterDeps, soa: SoaClient, gid: string, customerUid: string): Promise<QueueStatusResult> {
  const out = await soa.post<unknown>(CHECK_SESSION_STATUS, { head: businessHead(deps.context), gid, customerUid });
  switch (out.kind) {
    case 'success': {
      const biz = recordOrNull(recordOrNull(out.body)?.['bizResponseStatus']);
      const message = biz?.['resultMessage'];
      return { kind: 'ok', resultCode: bizResultCode(out.body), resultMessage: typeof message === 'string' && message !== '' ? message : null };
    }
    case 'auth_invalid':
      return { kind: 'failed', reason: 'auth' };
    case 'network_error':
      return { kind: 'failed', reason: 'network' };
    case 'timeout':
      return { kind: 'failed', reason: 'timeout' };
    case 'business_failure':
      return { kind: 'failed', reason: 'rejected' };
    default:
      return { kind: 'failed', reason: 'malformed' };
  }
}

export async function queueStatusOp(ctx: FeatureOpContext, gid: string, explicitCustomerUid: string | null): Promise<QueueStatusResult> {
  if (!validGid(gid)) throw new FeatureOpError('adapter.failed', 'invalid gid');
  const view = ctx.conversation(gid);
  if (!view) return { kind: 'unsupported', reason: 'unknown_conversation' };
  const uid = explicitCustomerUid ?? view.customerUid;
  if (uid === null || uid === '') return { kind: 'unsupported', reason: 'no_customer_uid' };
  // No fact is emitted: what resultCode means for a queued session is not captured yet.
  return checkManualAgentStatus(ctx.deps, ctx.soa, gid, uid);
}

export const queueFeature: AdapterFeature = {
  id: 'queue',
  ops: {
    'queue.status': async (args, ctx) => {
      const a = argRecord(args);
      const explicit = typeof a['customer_uid'] === 'string' && a['customer_uid'] !== '' ? (a['customer_uid'] as string) : null;
      return queueStatusOp(ctx, argString(a, 'gid'), explicit);
    },
    'queue.drop_out': async (args) => {
      argString(argRecord(args), 'gid');
      return { kind: 'unsupported', reason: 'endpoint_not_captured' };
    },
  },
};
