/**
 * `16037/getMessageList` pager (evidence 70, docs/api/transports.md "历史、已读与同步").
 *
 * Base body `{head, showTargetIsRead: true, groupId, conversationType, pageSize}`;
 * `direction: 'prev'` pairs with `endTime`, `direction: 'next'` with
 * `beginTime`; cursors are 13-digit ms numbers. The response is
 * `rangeMessage.{isDone, lastMessageTime, messages}` — never the top-level
 * `messages`. The sample excluded the boundary itself; same-timestamp full
 * pages are untested, so completeness is claimed only through `isDone`.
 */

import type { MessageFact } from '../../ipc/src/contracts.ts';
import type { AdapterDeps } from './deps.ts';
import { Endpoints } from './endpoints.ts';
import { businessHead } from './heads.ts';
import type { SoaClient, SoaOutcome } from './soa.ts';
import { is13DigitMs, normalizeHttpMessage, normalizeTimeMs, type HttpMessageObject, type MemberRoles, type MsgTypeOverrides } from './facts.ts';

export type HistoryCursor =
  | { readonly direction: 'prev'; readonly endTime: number }
  | { readonly direction: 'next'; readonly beginTime: number };

export interface HistoryRequest {
  readonly gid: string;
  /** `conversation.conversationType`, e.g. `B2C`. */
  readonly conversationType: string;
  readonly pageSize: number;
  readonly cursor?: HistoryCursor;
}

export interface HistoryPage {
  readonly facts: readonly MessageFact[];
  readonly isDone: boolean;
  readonly lastMessageTime: number | null;
  /** Raw rows (for translation/quote lookups); never logged. */
  readonly rows: readonly HttpMessageObject[];
}

export type HistoryResult =
  | { readonly kind: 'page'; readonly page: HistoryPage }
  | { readonly kind: 'invalid_cursor' }
  | { readonly kind: 'failed'; readonly outcome: SoaOutcome<unknown> };

export interface MessageListBody {
  readonly head: ReturnType<typeof businessHead>;
  readonly showTargetIsRead: true;
  readonly groupId: string;
  readonly conversationType: string;
  readonly pageSize: number;
  readonly endTime?: number;
  readonly beginTime?: number;
  readonly direction?: 'prev' | 'next';
}

export function messageListBody(deps: AdapterDeps, req: HistoryRequest): MessageListBody | null {
  const body: {
    head: ReturnType<typeof businessHead>;
    showTargetIsRead: true;
    groupId: string;
    conversationType: string;
    pageSize: number;
    endTime?: number;
    beginTime?: number;
    direction?: 'prev' | 'next';
  } = {
    head: businessHead(deps.context),
    showTargetIsRead: true,
    groupId: req.gid,
    conversationType: req.conversationType,
    pageSize: req.pageSize,
  };
  const c = req.cursor;
  if (c) {
    if (c.direction === 'prev') {
      if (!is13DigitMs(c.endTime)) return null;
      body.endTime = c.endTime;
      body.direction = 'prev';
    } else {
      if (!is13DigitMs(c.beginTime)) return null;
      body.beginTime = c.beginTime;
      body.direction = 'next';
    }
  }
  return body;
}

interface MessageListResponse {
  readonly rangeMessage?: { readonly isDone?: unknown; readonly lastMessageTime?: unknown; readonly messages?: unknown };
}

export async function fetchHistoryPage(
  deps: AdapterDeps,
  soa: SoaClient,
  req: HistoryRequest,
  roles: MemberRoles,
  msgTypeOverrides?: MsgTypeOverrides,
): Promise<HistoryResult> {
  const body = messageListBody(deps, req);
  if (!body) return { kind: 'invalid_cursor' };
  const outcome = await soa.post<MessageListResponse>(Endpoints.MESSAGE_LIST, body);
  if (outcome.kind !== 'success') return { kind: 'failed', outcome };
  const range = outcome.body.rangeMessage;
  const rows = range && Array.isArray(range.messages) ? (range.messages as HttpMessageObject[]) : [];
  const facts: MessageFact[] = [];
  for (const row of rows) {
    const f = normalizeHttpMessage(row, { gid: req.gid, roles, source: 'history', ...(msgTypeOverrides ? { msgTypeOverrides } : {}) });
    if (f) facts.push(f);
  }
  return {
    kind: 'page',
    page: {
      facts,
      isDone: range?.isDone === true,
      lastMessageTime: normalizeTimeMs(range?.lastMessageTime),
      rows,
    },
  };
}
