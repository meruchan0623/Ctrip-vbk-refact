/**
 * Conversation colour mark: `POST 16037/setWorkSheetStar`
 * `{head, sessionId, groupId:number, worksheetId:number, action}` (evidence 72/74).
 *
 * action 0 = clear, 1 orange, 2 green, 3 blue, 4 purple, 5 pink (the
 * official five colours; no sixth colour, no separate "star" feature).
 * Success only when `bizResponseStatus.resultCode === 'SUCCESS'`; on any
 * other outcome the caller keeps its old value (`applied: false`).
 * Cross-device propagation is unverified.
 */

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
  readonly sessionId: string;
  /** This endpoint sends `groupId` as a number (other 16037 calls use the string gid). */
  readonly groupId: number;
  readonly worksheetId: number;
  readonly action: StarAction;
}

export type WorkSheetStarResult =
  | { readonly applied: true; readonly action: StarAction }
  | { readonly applied: false; readonly reason: 'biz_failure' | 'unknown' | 'failed'; readonly outcome: SoaOutcome<unknown> };

/** Digits-only gid → number for this endpoint; `null` otherwise (never guess). */
export function numericGid(gid: string): number | null {
  if (!/^\d{1,15}$/.test(gid)) return null;
  return Number(gid);
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
