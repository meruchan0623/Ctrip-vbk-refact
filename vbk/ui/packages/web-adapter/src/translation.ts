/**
 * Inbound platform translation: `11679/batchTranslateByMsgIds`
 * `{head, source:'AUTO', target, chatType?, sessionId, groupId, bizType, messageIdList}`.
 * The response `translateMessageList[]` carries one row per translated
 * message (`msgId`, translated `messageBody`). The UI shows the
 * translation under the original; ids missing from the response keep their
 * original text (partial failure is not an error). This is the platform's
 * inbound translation, unrelated to TSim outbound translation.
 */

import type { AdapterDeps } from './deps.ts';
import { Endpoints } from './endpoints.ts';
import { businessHead } from './heads.ts';
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
  | { readonly kind: 'translated'; readonly byMsgId: ReadonlyMap<string, TranslatedMessage>; readonly missing: readonly string[]; readonly supplier: string | null }
  | { readonly kind: 'failed'; readonly outcome: SoaOutcome<unknown> };

interface TranslateResponse {
  readonly status?: unknown;
  readonly supplier?: unknown;
  readonly translateMessageList?: unknown;
}

export function translateBody(deps: AdapterDeps, req: TranslateRequest): Record<string, unknown> {
  const body: Record<string, unknown> = { head: businessHead(deps.context), source: req.source ?? 'AUTO', target: req.target };
  if (req.chatType !== undefined) body['chatType'] = req.chatType;
  body['sessionId'] = req.sessionId;
  body['groupId'] = req.groupId;
  body['bizType'] = req.bizType;
  body['messageIdList'] = [...req.messageIdList];
  return body;
}

export async function translateMessages(deps: AdapterDeps, soa: SoaClient, req: TranslateRequest): Promise<TranslateResult> {
  if (req.messageIdList.length === 0) return { kind: 'translated', byMsgId: new Map(), missing: [], supplier: null };
  const outcome = await soa.post<TranslateResponse>(Endpoints.BATCH_TRANSLATE, translateBody(deps, req));
  if (outcome.kind !== 'success') return { kind: 'failed', outcome };
  const byMsgId = new Map<string, TranslatedMessage>();
  const rows = Array.isArray(outcome.body.translateMessageList) ? outcome.body.translateMessageList : [];
  for (const r of rows) {
    const row = recordOrNull(r);
    if (!row || typeof row['msgId'] !== 'string' || typeof row['messageBody'] !== 'string') continue;
    byMsgId.set(row['msgId'] as string, {
      msgId: row['msgId'] as string,
      messageBody: row['messageBody'] as string,
      msgtype: typeof row['msgtype'] === 'number' ? (row['msgtype'] as number) : null,
    });
  }
  const missing = req.messageIdList.filter((id) => !byMsgId.has(id));
  return { kind: 'translated', byMsgId, missing, supplier: typeof outcome.body.supplier === 'string' ? outcome.body.supplier : null };
}
