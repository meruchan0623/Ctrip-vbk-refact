/**
 * Platform message translation: `11679/batchTranslateByMsgIds`
 * `{head, source:'AUTO', target, chatType?, sessionId, groupId, bizType, appId, messageIdList}`.
 * The response `translateMessageList[]` carries one row per translated
 * message (`msgId`, translated `messageBody`). `idWithTranslatedMap[id] === true`
 * marks a row the official client does not present as translated. The main window
 * asks explicitly through `im.translate_messages` and shows the translation under
 * the original; ids missing from the response keep their original text (partial
 * failure is not an error). This is the platform's message translation for both
 * directions, unrelated to TSim draft translation.
 */

import type { UiMessageTranslation, UiMessageTranslations } from '../../ipc/src/client.ts';
import type { AdapterDeps } from './deps.ts';
import { messageText } from './display.ts';
import { Endpoints } from './endpoints.ts';
import { businessHead } from './heads.ts';
import { getVenAgentByUid } from './settings.ts';
import { recordOrNull, type SoaClient, type SoaOutcome } from './soa.ts';

export interface TranslateRequest {
  readonly sessionId: string;
  readonly groupId: string;
  readonly bizType: number;
  readonly messageIdList: readonly string[];
  /** Target locale; redacted in evidence ("待追溯"), so it is injected from the page's agent locale setting. */
  readonly target: string;
  readonly source?: string;
  /** Observed in one sample; omitted when not provided. */
  readonly chatType?: string;
}

export interface TranslatedMessage {
  readonly msgId: string;
  /** Translated body (text for msgtype 0, JSON string for cards); never logged. */
  readonly messageBody: string;
  readonly msgtype: number | null;
}

export type TranslateResult =
  | { readonly kind: 'translated'; readonly byMsgId: ReadonlyMap<string, TranslatedMessage>; readonly missing: readonly string[]; readonly unneeded: readonly string[]; readonly supplier: string | null }
  | { readonly kind: 'failed'; readonly outcome: SoaOutcome<unknown> };

interface TranslateResponse {
  readonly status?: unknown;
  readonly supplier?: unknown;
  readonly translateMessageList?: unknown;
  readonly idWithTranslatedMap?: unknown;
}

export function translateBody(deps: AdapterDeps, req: TranslateRequest): Record<string, unknown> {
  const body: Record<string, unknown> = { head: businessHead(deps.context), source: req.source ?? 'AUTO', target: req.target };
  if (req.chatType !== undefined) body['chatType'] = req.chatType;
  body['sessionId'] = req.sessionId;
  body['groupId'] = req.groupId;
  body['bizType'] = req.bizType;
  body['appId'] = '100017720';
  body['messageIdList'] = [...req.messageIdList];
  return body;
}

export async function translateMessages(deps: AdapterDeps, soa: SoaClient, req: TranslateRequest): Promise<TranslateResult> {
  if (req.messageIdList.length === 0) return { kind: 'translated', byMsgId: new Map(), missing: [], unneeded: [], supplier: null };
  const outcome = await soa.post<TranslateResponse>(Endpoints.BATCH_TRANSLATE, translateBody(deps, req));
  if (outcome.kind !== 'success') return { kind: 'failed', outcome };
  const byMsgId = new Map<string, TranslatedMessage>();
  const requested = new Set(req.messageIdList);
  const unneeded = new Set<string>();
  const rows = Array.isArray(outcome.body.translateMessageList) ? outcome.body.translateMessageList : [];
  for (const r of rows) {
    const row = recordOrNull(r);
    if (!row || typeof row['msgId'] !== 'string' || typeof row['messageBody'] !== 'string') continue;
    if (!requested.has(row['msgId'])) continue;
    if (recordOrNull(outcome.body.idWithTranslatedMap)?.[row['msgId']] === true) unneeded.add(row['msgId']);
    byMsgId.set(row['msgId'] as string, {
      msgId: row['msgId'] as string,
      messageBody: row['messageBody'] as string,
      msgtype: typeof row['msgtype'] === 'number' ? (row['msgtype'] as number) : null,
    });
  }
  const missing = req.messageIdList.filter((id) => !byMsgId.has(id));
  return { kind: 'translated', byMsgId, missing, unneeded: [...unneeded], supplier: typeof outcome.body.supplier === 'string' ? outcome.body.supplier : null };
}

/** `venAgentOption.serviceTypeOptionList[].venOptionList[]`, read like the official INIT_VEN_INFO. */
function serviceTypeAllowsTranslation(venAgentOption: Readonly<Record<string, unknown>> | null, serviceType: string): boolean | null {
  const owners = venAgentOption?.['serviceTypeOptionList'];
  if (!Array.isArray(owners) || owners.length === 0) return null;
  const owner = owners.map(recordOrNull).find(row => String(row?.['ownerCode'] ?? '') === serviceType);
  const options = owner?.['venOptionList'];
  if (!Array.isArray(options)) return false;
  return options.map(recordOrNull).find(row => row?.['optionCode'] === 'translate_message')?.['optionValue'] === 'Y';
}

/** Successful reads only: a failed option read must not disable translation for this page. */
const translationOptions = new WeakMap<SoaClient, Readonly<Record<string, unknown>> | null>();

async function translationAllowed(deps: AdapterDeps, soa: SoaClient, serviceType: string): Promise<boolean> {
  if (!translationOptions.has(soa)) {
    const agent = await getVenAgentByUid(deps, soa);
    if (agent.kind !== 'ok') return true;
    translationOptions.set(soa, agent.value.venAgentOption);
  }
  return serviceTypeAllowsTranslation(translationOptions.get(soa) ?? null, serviceType) ?? true;
}

const MAX_SUPPLIER_LENGTH = 40;

/**
 * One explicit answer per requested ID. A row marked `idWithTranslatedMap[id]`
 * is what the official client treats as `isTranslated: false` and hides. Its text
 * body still goes up marked `flagged`, because only the main window knows the
 * original: new foreign messages have stayed untranslated under this flag.
 */
export async function translateForDisplay(
  deps: AdapterDeps, soa: SoaClient,
  view: { readonly gid: string; readonly sessionId: string; readonly serviceType: string; readonly chatType?: string },
  messageIds: readonly string[],
): Promise<UiMessageTranslations | { readonly failed: SoaOutcome<unknown> }> {
  if (!await translationAllowed(deps, soa, view.serviceType)) {
    return { items: messageIds.map(message_id => ({ message_id, status: 'unsupported', translation: null, source_kind: null, reason: 'option_off' })), supplier: null };
  }
  const result = await translateMessages(deps, soa, {
    sessionId: view.sessionId, groupId: view.gid, bizType: Number(view.serviceType), target: deps.context.locale, messageIdList: messageIds,
    ...(view.chatType ? { chatType: view.chatType } : {}),
  });
  if (result.kind !== 'translated') return { failed: result.outcome };
  const items = messageIds.map((message_id): UiMessageTranslation => {
    const row = result.byMsgId.get(message_id);
    if (!row) return { message_id, status: 'missing', translation: null, source_kind: null, reason: 'no_row' };
    const flagged = result.unneeded.includes(message_id);
    const type = row.msgtype ?? 0;
    const source_kind = type === 0 ? 'text' : type === 1007 || type === 1009 ? 'system' : null;
    if (!source_kind) return { message_id, status: 'not_needed', translation: null, source_kind: null, reason: 'card' };
    if (flagged && source_kind !== 'text') return { message_id, status: 'not_needed', translation: null, source_kind: null, reason: 'flagged' };
    const translation = messageText(type, row.messageBody);
    if (!translation.trim()) return flagged ? { message_id, status: 'not_needed', translation: null, source_kind: null, reason: 'flagged' } : { message_id, status: 'missing', translation: null, source_kind: null, reason: 'blank' };
    return { message_id, status: 'translated', translation, source_kind, ...(flagged ? { reason: 'flagged' as const } : {}) };
  });
  return { items, supplier: result.supplier?.slice(0, MAX_SUPPLIER_LENGTH) || null };
}
