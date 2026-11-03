/**
 * I-30b active recall and re-edit (FE-34), main-window half.
 *
 * Rules (docs/reviews/2026-11-02-desktop-live-capture-verification.md round 4):
 * - only the agent's own, server-confirmed message (19-digit server id) inside
 *   the 2-minute window judged on SERVER time; an unanchored clock hides the
 *   action instead of guessing;
 * - recall is irreversible, so it always goes through a danger confirmation;
 * - one request per message: while pending, and after an `unknown` outcome
 *   (never replayed), the action is hidden; the user re-checks the
 *   conversation instead;
 * - nothing is shown as recalled until the server said so (success reply or
 *   the inbound `recalled` fact).
 *
 * `recalled(gid, id)` is what the message renderer should call to show
 * 「消息已撤回」; the render hook itself is an integration change request.
 * Re-edit of the recalled text is `reeditText(message)`: it only returns the
 * original text for the caller to put in the draft; it never sends.
 */

import type { UiMessage } from '../../../packages/ipc/src/client.ts';
import type { FeatureContext, FeatureFact, FeatureModule, FeatureScope } from './context.ts';

export const RECALL_COMMAND = 'im_recall_message';
export const RECALL_WINDOW_MS = 120_000;
export const RECALL_FUTURE_TOLERANCE_MS = 5_000;

export type RecallEligibility =
  | { readonly kind: 'ok'; readonly remainingMs: number }
  | { readonly kind: 'not_own' | 'no_server_id' | 'not_recallable' | 'expired' | 'clock_unknown' };

/** Mirrors `core_im::feature_rules::recall_verdict`; the host re-judges before it forwards. */
export function recallEligibility(message: UiMessage, serverNowMs: number | null): RecallEligibility {
  if (message.sender_role !== 'merchant_self') return { kind: 'not_own' };
  if (message.kind === 'system' || message.recalled_message_id) return { kind: 'not_recallable' };
  if (message.disposition !== null && message.disposition.kind !== 'confirmed') return { kind: 'not_recallable' };
  if (message.message_id === null || !/^\d{19}$/.test(message.message_id)) return { kind: 'no_server_id' };
  if (serverNowMs === null) return { kind: 'clock_unknown' };
  const age = serverNowMs - message.create_time_ms;
  if (age < -RECALL_FUTURE_TOLERANCE_MS) return { kind: 'clock_unknown' };
  if (age > RECALL_WINDOW_MS) return { kind: 'expired' };
  return { kind: 'ok', remainingMs: RECALL_WINDOW_MS - Math.max(0, age) };
}

/** Text to put back into the composer for 「重新编辑」: plain text messages only. */
export function reeditText(message: UiMessage): string | null {
  return message.sender_role === 'merchant_self' && message.kind === 'text' && message.text.trim() !== '' ? message.text : null;
}

export type RecallReply =
  | { readonly outcome: 'recalled' }
  | { readonly outcome: 'rejected'; readonly code: number; readonly message: string | null }
  | { readonly outcome: 'refused'; readonly reason: 'invalid_id' | 'expired' | 'clock_unknown' | 'unknown_conversation' }
  | { readonly outcome: 'unknown' }
  | { readonly outcome: 'failed'; readonly reason: 'auth' | 'network' | 'timeout' };

const key = (scope: FeatureScope, gid: string, id: string): string => `${scope.account.environment}|${scope.account.account_id}|${scope.account.session_generation}|${gid}|${id}`;

/**
 * Classifies an IPC rejection. Only an error raised AFTER the page may have
 * sent `recallMessage` is an unknown outcome (host `adapter.timeout`, lost
 * reply, anything unclassified). Refusals the host or page raise before any
 * request (window/argument gates, ACL, unknown op, contract mismatch) mean
 * "nothing sent": the action stays available and no replay lock is set.
 */
export function classifyIpcFailure(error: unknown): 'not_sent' | 'expired' | 'clock_unknown' | 'unknown' {
  const code = typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code : null;
  if (code === null) return 'unknown';
  if (code === 'im.recall_expired') return 'expired';
  if (code === 'im.recall_clock_unknown') return 'clock_unknown';
  if (code.startsWith('im.recall_') || code.startsWith('im.feature_') || code === 'adapter.failed' || code.startsWith('host.') || code.startsWith('account.')) return 'not_sent';
  return 'unknown';
}

export interface RecallModule extends FeatureModule {
  /** True once the server confirmed the recall of `messageId` in the active account's conversation `gid`. */
  recalled(gid: string, messageId: string): boolean;
}

export function createRecall(): RecallModule {
  const recalledSet = new Set<string>();
  const inflight = new Set<string>();
  const settledUnknown = new Set<string>();
  let ctx: FeatureContext | null = null;
  let scopeNow: (() => FeatureScope | null) | null = null;

  function eligible(m: UiMessage, scope: FeatureScope): boolean {
    const k = key(scope, m.gid, m.message_id ?? '');
    if (recalledSet.has(k) || inflight.has(k) || settledUnknown.has(k)) return false;
    return recallEligibility(m, ctx?.serverNowMs() ?? null).kind === 'ok';
  }

  async function run(c: FeatureContext, m: UiMessage, scope: FeatureScope): Promise<void> {
    const check = recallEligibility(m, c.serverNowMs());
    if (check.kind !== 'ok' || m.message_id === null) {
      c.toast(check.kind === 'expired' ? c.t('recall.expired') : c.t('recall.clockUnknown'));
      return;
    }
    const k = key(scope, m.gid, m.message_id);
    if (inflight.has(k) || recalledSet.has(k) || settledUnknown.has(k)) return;
    const confirmed = await c.confirm({
      title: c.t('recall.confirmTitle'),
      message: c.t('recall.confirmBody'),
      confirmLabel: c.t('recall.confirmOk'),
      cancelLabel: c.t('recall.cancel'),
      danger: true,
    });
    if (!confirmed || !c.isCurrent(scope.account)) return;
    // the window may have closed while the dialog was open
    const again = recallEligibility(m, c.serverNowMs());
    if (again.kind !== 'ok') {
      c.toast(again.kind === 'expired' ? c.t('recall.expired') : c.t('recall.clockUnknown'));
      return;
    }
    inflight.add(k);
    c.requestRender();
    try {
      const reply = await c.invoke<RecallReply>(RECALL_COMMAND, { gid: m.gid, message_id: m.message_id, created_ms: m.create_time_ms });
      if (!c.isCurrent(scope.account)) return;
      switch (reply.outcome) {
        case 'recalled':
          recalledSet.add(k);
          c.toast(c.t('recall.done'));
          break;
        case 'rejected':
          c.toast(c.t('recall.rejected', { msg: reply.message ?? String(reply.code) }));
          break;
        case 'refused':
          c.toast(reply.reason === 'expired' ? c.t('recall.expired') : c.t('recall.clockUnknown'));
          break;
        case 'unknown':
          settledUnknown.add(k);
          c.toast(c.t('recall.unknown'));
          break;
        default:
          c.toast(c.t('recall.failed'));
      }
    } catch (e: unknown) {
      // A rejection raised before any request was sent keeps the action; anything that
      // may have reached the server is "unknown": never replayed, user re-checks the conversation.
      const verdict = classifyIpcFailure(e);
      if (verdict === 'unknown') settledUnknown.add(k);
      if (c.isCurrent(scope.account)) {
        c.toast(
          verdict === 'unknown' ? c.t('recall.unknown')
            : verdict === 'expired' ? c.t('recall.expired')
              : verdict === 'clock_unknown' ? c.t('recall.clockUnknown')
                : c.t('recall.failed'),
        );
      }
    } finally {
      inflight.delete(k);
      c.requestRender();
    }
  }

  return {
    id: 'recall',
    commands: [RECALL_COMMAND],
    mount(c) {
      ctx = c;
      scopeNow = () => c.scope();
      c.registerMessageAction({
        id: 'recall',
        label: () => c.t('recall.action'),
        visible: (m, scope) => eligible(m, scope),
        run: (m, scope) => run(c, m, scope),
      });
    },
    onFact(fact: FeatureFact) {
      if (!ctx || fact.kind !== 'recalled' || !ctx.isCurrent(fact.account)) return;
      const scope = scopeNow?.();
      if (!scope) return;
      recalledSet.add(key({ ...scope, account: fact.account }, fact.gid, fact.message_id));
      ctx.requestRender();
    },
    recalled(gid, messageId) {
      const scope = scopeNow?.();
      return !!scope && recalledSet.has(key(scope, gid, messageId));
    },
    dispose() {
      recalledSet.clear();
      inflight.clear();
      settledUnknown.clear();
      ctx = null;
      scopeNow = null;
    },
  };
}
