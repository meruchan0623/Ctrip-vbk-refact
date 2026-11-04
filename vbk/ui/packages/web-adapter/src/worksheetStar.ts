/**
 * Conversation colour mark: `POST 16037/setWorkSheetStar`
 * `{head, sessionId?, groupId:number, worksheetId?, action}`.
 * Official desktop setConversationStar passes sessionId/id through unchanged;
 * absent properties are omitted by JSON serialization. Do not require a numeric
 * worksheet ID from the stricter send/member projection (2026-11-03 evidence).
 *
 * action 0 = clear, 1 orange, 2 green, 3 blue, 4 purple, 5 pink (the
 * official five colours; no sixth colour, no separate "star" feature).
 * Success only when `bizResponseStatus.resultCode === 'SUCCESS'`; on any
 * other outcome the caller keeps its old value (`applied: false`).
 * Cross-device propagation is unverified.
 */

import type { ConversationListItem } from './conversationList.ts';
import type { AdapterDeps } from './deps.ts';
import { Endpoints } from './endpoints.ts';
import { businessHead } from './heads.ts';
import { isBizSuccess, type SoaClient, type SoaOutcome } from './soa.ts';

export type StarAction = 0 | 1 | 2 | 3 | 4 | 5;

export const STAR_COLOURS: Readonly<Record<StarAction, 'none' | 'orange' | 'green' | 'blue' | 'purple' | 'pink'>> = {
  0: 'none',
  1: 'orange',
  2: 'green',
  3: 'blue',
  4: 'purple',
  5: 'pink',
};

export interface WorkSheetStarRequest {
  readonly sessionId?: string | number | null;
  /** This endpoint sends `groupId` as a number (other 16037 calls use the string gid). */
  readonly groupId: number;
  readonly worksheetId?: string | number | null;
  readonly action: StarAction;
}

export type WorkSheetStarResult =
  | { readonly applied: true; readonly action: StarAction }
  | { readonly applied: false; readonly reason: 'biz_failure' | 'unknown' | 'failed'; readonly outcome: SoaOutcome<unknown> };

/**
 * Match official setConversationStar's `groupId: +gid`, including its Number
 * precision for long IDs. This is this endpoint's wire representation only:
 * retain the original string gid for cache keys, UI updates and identity guards.
 * Do not reuse this conversion for other endpoints or conversation lookup.
 */
export function numericGid(gid: string): number | null {
  if (!/^\d+$/.test(gid)) return null;
  const value = Number(gid);
  return Number.isFinite(value) && Number.isInteger(value) && value > 0 ? value : null;
}

/** Match the shipped desktop call site, not the send/member identity requirements. */
export function workSheetStarRequest(row: ConversationListItem, action: StarAction): WorkSheetStarRequest | null {
  const groupId = typeof row.gid === 'string' ? numericGid(row.gid) : null;
  if (groupId === null) return null;
  const id = (row as ConversationListItem & { id?: unknown }).id;
  const wireId = (value: unknown): value is string | number | null | undefined => value == null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value));
  if (!wireId(row.sessionId) || !wireId(id)) return null;
  return { ...(row.sessionId !== undefined ? { sessionId: row.sessionId } : {}), groupId, ...(id !== undefined ? { worksheetId: id } : {}), action };
}

export async function setWorkSheetStar(deps: AdapterDeps, soa: SoaClient, req: WorkSheetStarRequest): Promise<WorkSheetStarResult> {
  const body = { head: businessHead(deps.context), sessionId: req.sessionId, groupId: req.groupId, worksheetId: req.worksheetId, action: req.action };
  const outcome = await soa.post<unknown>(Endpoints.SET_WORKSHEET_STAR, body);
  if (outcome.kind === 'success') {
    if (isBizSuccess(outcome.body)) return { applied: true, action: req.action };
    return { applied: false, reason: 'biz_failure', outcome };
  }
  if (outcome.kind === 'unknown') return { applied: false, reason: 'unknown', outcome };
  return { applied: false, reason: 'failed', outcome };
}
