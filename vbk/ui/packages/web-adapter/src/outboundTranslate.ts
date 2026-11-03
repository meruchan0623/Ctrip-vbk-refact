/**
 * I-15 (code part) outbound "write-and-translate" candidate:
 * `POST 11679/getMessageTranslate`
 * `{head, sessionId, groupId, messageTxt, source:"AUTO", target, appId:"900004", bizType, timeoutInSeconds:10}`
 * debounced 500 ms after the last keystroke (desktop baseline 09-assistant,
 * `uOt = 500`; a stale answer for a changed draft is discarded).
 *
 * This is a CANDIDATE: the request shape comes from the official client's
 * static builder and was never captured live, and `translate.translateText`
 * is the response path recorded in the baseline notes. It is not wired into
 * the product path (vbk's current outbound translation is the TSim route in
 * `core-assistant`); `send.ts` and `translate.rs` are untouched.
 *
 * Invariants:
 * - the result only ever REPLACES THE DRAFT for the agent to confirm and
 *   send; nothing in this module can send a message (plan C10 / R11, X7);
 * - `bizType` is passed through exactly as the caller got it (it is numeric
 *   in `batchTranslateByMsgIds` captures, unknown here), `groupId` is the
 *   string gid;
 * - a write-free read: safe to retry once on transport errors by the SOA
 *   client; the debouncer itself never retries.
 */

import type { AdapterDeps, TimerHandle } from './deps.ts';
import { M } from './endpoints.ts';
import { businessHead } from './heads.ts';
import { endpoint, recordOrNull, type EndpointSpec, type SoaClient, type SoaOutcome } from './soa.ts';

export const GET_MESSAGE_TRANSLATE: EndpointSpec = endpoint('getMessageTranslate', M, '11679/getMessageTranslate', 'read');
export const OUTBOUND_TRANSLATE_DEBOUNCE_MS = 500;
export const OUTBOUND_TRANSLATE_TIMEOUT_S = 10;
export const OUTBOUND_TRANSLATE_APP_ID = '900004';
/** Product default: the translation replaces the draft; sending stays a human action. */
export const OUTBOUND_TRANSLATE_DEFAULT_MODE = 'replace_draft' as const;
/** Draft text beyond this is not translated (bounded request size). */
export const OUTBOUND_TRANSLATE_MAX_CHARS = 2000;

export interface OutboundTranslateRequest {
  readonly sessionId: string;
  readonly groupId: string;
  readonly messageTxt: string;
  readonly target: string;
  readonly bizType: number | string;
}

export function outboundTranslateBody(deps: AdapterDeps, req: OutboundTranslateRequest): Record<string, unknown> {
  return {
    head: businessHead(deps.context),
    sessionId: req.sessionId,
    groupId: req.groupId,
    messageTxt: req.messageTxt,
    source: 'AUTO',
    target: req.target,
    appId: OUTBOUND_TRANSLATE_APP_ID,
    bizType: req.bizType,
    timeoutInSeconds: OUTBOUND_TRANSLATE_TIMEOUT_S,
  };
}

export type OutboundTranslateResult =
  | { readonly kind: 'translated'; readonly text: string }
  | { readonly kind: 'refused'; readonly reason: 'empty' | 'too_long' | 'invalid_target' }
  | { readonly kind: 'failed'; readonly outcome: SoaOutcome<unknown> };

export async function translateDraft(deps: AdapterDeps, soa: SoaClient, req: OutboundTranslateRequest): Promise<OutboundTranslateResult> {
  if (req.messageTxt.trim() === '') return { kind: 'refused', reason: 'empty' };
  if (req.messageTxt.length > OUTBOUND_TRANSLATE_MAX_CHARS) return { kind: 'refused', reason: 'too_long' };
  if (!/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(req.target)) return { kind: 'refused', reason: 'invalid_target' };
  const outcome = await soa.post<unknown>(GET_MESSAGE_TRANSLATE, outboundTranslateBody(deps, req));
  if (outcome.kind !== 'success') return { kind: 'failed', outcome };
  const text = recordOrNull(recordOrNull(outcome.body)?.['translate'])?.['translateText'];
  if (typeof text !== 'string' || text === '') return { kind: 'failed', outcome: { kind: 'malformed', detail: 'missing translate.translateText' } };
  return { kind: 'translated', text };
}

export interface DraftTranslation {
  readonly draftVersion: number;
  readonly request: OutboundTranslateRequest;
  readonly result: OutboundTranslateResult;
}

export interface DraftTranslator {
  /** Schedules a translation 500 ms after the last call; older pending work is discarded. */
  schedule(draftVersion: number, request: OutboundTranslateRequest): void;
  /** Invalidates pending/in-flight work (conversation switch, draft cleared, send). */
  cancel(): void;
}

/**
 * Debounced translator. `onResult` fires only for the newest scheduled
 * request: any later `schedule`/`cancel` makes an in-flight answer stale.
 */
export function createDraftTranslator(deps: AdapterDeps, soa: SoaClient, onResult: (t: DraftTranslation) => void): DraftTranslator {
  let timer: TimerHandle | null = null;
  let generation = 0;
  const clear = (): void => {
    if (timer !== null) deps.clearTimeout(timer);
    timer = null;
  };
  return {
    schedule(draftVersion, request) {
      clear();
      const mine = ++generation;
      timer = deps.setTimeout(() => {
        timer = null;
        void translateDraft(deps, soa, request).then((result) => {
          if (mine === generation) onResult({ draftVersion, request, result });
        });
      }, OUTBOUND_TRANSLATE_DEBOUNCE_MS);
    },
    cancel() {
      clear();
      generation++;
    },
  };
}
