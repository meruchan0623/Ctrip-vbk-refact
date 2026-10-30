/**
 * Notice centre (IQ) reads/writes.
 *
 * - `11679/getIQConversations {lastMsgTime, head}` → `categoryList[].categorySubList[]`
 *   with `categoryId, categoryName, unreadCount, lastMsgTime, lastMsgId, unreadTimeline`
 *   (docs/api/endpoints/m.ctrip.com-11679-getIQConversations-post.md, live sample 60).
 *   The only sample was taken on the order page (head `appId:"1001"`); on the
 *   IM page this module sends the IM business head (unverified, U06-like).
 * - `11679/getIQMessages {categoryId, categorySubId, lastMsgTime, pageSize:100}` →
 *   `iqMessages[]`, and `11679/putAdviceofreadIQMessage {categoryId, categorySubId, msgId}`:
 *   STATIC call sites only (docs/research/evidence/web-message-notice-static-20261030.json,
 *   excerpt `iq-list-and-read`); no live request/response sample exists. The
 *   per-row shape of `iqMessages[]` is unknown, so the mapper is tolerant and
 *   reads the `lastMsg`-style JSON (`ext.title/desc/extendInfo.toJumpUrlOnline`).
 * - Category ids on the wire are numbers; the UI id is `"<categoryId>:<subId>"`.
 *
 * This chat-unrelated read receipt is NOT `PutAdviceOfReadByMsgId`; never mix them.
 */

import type { UiNotice, UiNoticeCategory } from '../../ipc/src/client.ts';
import type { AdapterDeps } from './deps.ts';
import { Endpoints } from './endpoints.ts';
import { businessHead } from './heads.ts';
import { recordOrNull, type SoaClient, type SoaOutcome } from './soa.ts';
import { normalizeTimeMs } from './facts.ts';

export const IQ_PAGE_SIZE = 100;

export interface NoticeCategoryRef {
  readonly categoryId: number;
  readonly categorySubId: number;
}

export interface NoticeCategoryInfo extends UiNoticeCategory {
  readonly ref: NoticeCategoryRef;
  readonly lastMsgTime: number;
  readonly lastMsgId: string | null;
}

export function noticeCategoryId(ref: NoticeCategoryRef): string {
  return `${ref.categoryId}:${ref.categorySubId}`;
}

export function parseNoticeCategoryId(id: string): NoticeCategoryRef | null {
  const m = /^(\d{1,9}):(\d{1,9})$/.exec(id);
  if (!m) return null;
  return { categoryId: Number(m[1]), categorySubId: Number(m[2]) };
}

function s(x: unknown): string | null {
  return typeof x === 'string' && x !== '' ? x : null;
}

function n(x: unknown): number | null {
  return typeof x === 'number' && Number.isFinite(x) ? x : typeof x === 'string' && /^\d+$/.test(x) ? Number(x) : null;
}

function idStr(x: unknown): string | null {
  return typeof x === 'string' && x !== '' ? x : typeof x === 'number' && Number.isFinite(x) ? String(x) : null;
}

/** Flattens `categoryList[].categorySubList[]`; parents without sub-categories are skipped (getIQMessages needs a sub id). */
export function flattenCategories(body: unknown): NoticeCategoryInfo[] {
  const list = recordOrNull(body)?.['categoryList'];
  const out: NoticeCategoryInfo[] = [];
  if (!Array.isArray(list)) return out;
  for (const c of list) {
    const parent = recordOrNull(c);
    const pid = n(parent?.['categoryId']);
    if (!parent || pid === null) continue;
    const subs = Array.isArray(parent['categorySubList']) ? parent['categorySubList'] : [];
    for (const sub of subs) {
      const r = recordOrNull(sub);
      const sid = n(r?.['categoryId']);
      if (!r || sid === null) continue;
      const ref = { categoryId: pid, categorySubId: sid };
      const unread = n(r['unreadCount']);
      out.push({
        id: noticeCategoryId(ref),
        name: s(r['categoryName']) ?? s(parent['categoryName']) ?? noticeCategoryId(ref),
        unread: unread !== null && unread >= 0 ? Math.floor(unread) : 0,
        ref,
        lastMsgTime: n(r['lastMsgTime']) ?? 0,
        lastMsgId: idStr(r['lastMsgId']),
      });
    }
  }
  return out;
}

export async function fetchNoticeCategories(deps: AdapterDeps, soa: SoaClient): Promise<{ readonly ok: true; readonly items: NoticeCategoryInfo[] } | { readonly ok: false; readonly outcome: SoaOutcome<unknown> }> {
  const outcome = await soa.post<unknown>(Endpoints.IQ_CONVERSATIONS, { lastMsgTime: 0, head: businessHead(deps.context) });
  if (outcome.kind !== 'success') return { ok: false, outcome };
  return { ok: true, items: flattenCategories(outcome.body) };
}

function jsonObject(x: unknown): Record<string, unknown> | null {
  if (typeof x === 'string') {
    try {
      return recordOrNull(JSON.parse(x));
    } catch {
      return null;
    }
  }
  return recordOrNull(x);
}

/** Only absolute https URLs are kept; the host re-validates before opening. */
function httpsUrl(x: unknown): string {
  const v = s(x);
  return v !== null && /^https:\/\/[^\s]+$/i.test(v) ? v : '';
}

export function iqMessageToNotice(row: unknown, categoryId: string, unreadTimeline: number | null): UiNotice | null {
  const r = recordOrNull(row);
  if (!r) return null;
  const id = idStr(r['msgId']) ?? idStr(r['messageId']) ?? idStr(r['id']);
  if (id === null) return null;
  const content = jsonObject(r['messageBody']) ?? jsonObject(r['content']) ?? jsonObject(r['lastMsg']) ?? jsonObject(r['body']) ?? r;
  const ext = recordOrNull(content['ext']) ?? {};
  const extend = recordOrNull(ext['extendInfo']) ?? {};
  const time = normalizeTimeMs(r['createTime']) ?? normalizeTimeMs(r['msgTime']) ?? 0;
  const explicitRead = typeof r['isread'] === 'boolean' ? r['isread'] : typeof r['isRead'] === 'boolean' ? r['isRead'] : null;
  return {
    id,
    category_id: categoryId,
    title: s(ext['title']) ?? s(content['title']) ?? '',
    body: s(ext['desc']) ?? s(content['desc']) ?? s(content['content']) ?? '',
    time_ms: time,
    unread: explicitRead !== null ? !explicitRead : unreadTimeline !== null && time > unreadTimeline,
    url: httpsUrl(extend['toJumpUrlOnline']) || httpsUrl(extend['toJumpUrl']),
  };
}

export async function fetchNoticeList(
  deps: AdapterDeps,
  soa: SoaClient,
  ref: NoticeCategoryRef,
  lastMsgTime: number,
): Promise<{ readonly ok: true; readonly items: UiNotice[]; readonly rows: readonly unknown[] } | { readonly ok: false; readonly outcome: SoaOutcome<unknown> }> {
  const outcome = await soa.post<{ iqMessages?: unknown }>(Endpoints.IQ_MESSAGES, {
    categoryId: ref.categoryId,
    categorySubId: ref.categorySubId,
    lastMsgTime,
    pageSize: IQ_PAGE_SIZE,
    head: businessHead(deps.context),
  });
  if (outcome.kind !== 'success') return { ok: false, outcome };
  const rows = Array.isArray(outcome.body.iqMessages) ? outcome.body.iqMessages : [];
  const cid = noticeCategoryId(ref);
  const items: UiNotice[] = [];
  for (const row of rows) {
    const x = iqMessageToNotice(row, cid, null);
    if (x) items.push(x);
  }
  return { ok: true, items, rows };
}

/** Write; an unknown outcome is reported as such and never replayed. */
export async function markNoticeRead(deps: AdapterDeps, soa: SoaClient, ref: NoticeCategoryRef, msgId: string): Promise<SoaOutcome<unknown>> {
  return soa.post<unknown>(Endpoints.PUT_ADVICE_READ_IQ, { categoryId: ref.categoryId, categorySubId: ref.categorySubId, msgId, head: businessHead(deps.context) });
}
