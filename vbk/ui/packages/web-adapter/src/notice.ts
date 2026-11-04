/**
 * IQ notice reads. Desktop call sites and reducer/card mapping are recorded in
 * docs/research/2026-11-03-notification-query-desktop.md.
 * The category latest-message timestamp is metadata, never the first list cursor.
 * IQ read receipts are unrelated to chat PutAdviceOfReadByMsgId.
 */

import type { UiNotice, UiNoticeCategory } from '../../ipc/src/client.ts';
import type { AdapterDeps } from './deps.ts';
import { Endpoints, M } from './endpoints.ts';
import { endpoint, recordOrNull, type SoaClient, type SoaOutcome } from './soa.ts';

export const IQ_PAGE_SIZE = 100;

export interface NoticeCategoryRef {
  readonly categoryId: number;
  readonly categorySubId: number;
}

export interface NoticeCategoryInfo extends UiNoticeCategory {
  readonly ref: NoticeCategoryRef;
  readonly lastMsgTime: number;
  readonly lastMsgId: string | null;
  readonly unreadTimeline: number | null;
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
  const value = typeof x === 'number' ? x : typeof x === 'string' && /^\d+$/.test(x) ? Number(x) : NaN;
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function idStr(x: unknown): string | null {
  return typeof x === 'string' && x !== '' ? x : typeof x === 'number' && Number.isSafeInteger(x) && x >= 0 ? String(x) : null;
}

/** Flattens `categoryList[].categorySubList[]`; parents without sub-categories are skipped (getIQMessages needs a sub id). */
export function flattenCategories(body: unknown): NoticeCategoryInfo[] | null {
  const list = recordOrNull(body)?.['categoryList'];
  const out: NoticeCategoryInfo[] = [];
  if (!Array.isArray(list)) return null;
  const seen = new Set<string>();
  for (const c of list) {
    const parent = recordOrNull(c);
    const pid = n(parent?.['categoryId']);
    if (!parent || pid === null || pid > 999999999) return null;
    if (parent['categorySubList'] !== undefined && !Array.isArray(parent['categorySubList'])) return null;
    const subs = Array.isArray(parent['categorySubList']) ? parent['categorySubList'] : [];
    for (const sub of subs) {
      const r = recordOrNull(sub);
      const sid = n(r?.['categoryId']);
      if (!r || sid === null || sid > 999999999) return null;
      const ref = { categoryId: pid, categorySubId: sid };
      const unread = n(r['unreadCount']);
      for (const field of ['unreadCount', 'unreadTimeline', 'lastMsgTime']) {
        if (r[field] !== undefined && r[field] !== null && n(r[field]) === null) return null;
      }
      const id = noticeCategoryId(ref);
      if (seen.has(id)) continue;
      seen.add(id);
      if (r['lastMsgId'] !== undefined && r['lastMsgId'] !== null && idStr(r['lastMsgId']) === null) return null;
      out.push({
        id,
        name: s(r['categoryName']) ?? s(parent['categoryName']) ?? noticeCategoryId(ref),
        unread: unread !== null && unread >= 0 ? Math.floor(unread) : 0,
        ref,
        lastMsgTime: n(r['lastMsgTime']) ?? 0,
        lastMsgId: idStr(r['lastMsgId']),
        unreadTimeline: n(r['unreadTimeline']),
      });
    }
  }
  return out;
}

/** IQ categories use getHead('1001'), not the IM business app id. */
export function noticeConversationsHead(deps: AdapterDeps) {
  return {
    cver: '2',
    appId: '1001',
    extension: [
      { name: 'cpc', value: 'pc' },
      { name: 'protocal', value: 'https' },
      { name: 'amp-product-type', value: 'IM' },
      { name: 'amp-account-source', value: 'VBK' },
      { name: 'client-source', value: 'pc-1001' },
      { name: 'locale', value: deps.context.locale || 'zh-CN' },
    ],
  };
}

/** IQ list/read omit an explicit head and the official wrapper adds getVBKHead(). */
export function noticeMessageHead(deps: AdapterDeps) {
  return { cid: deps.context.cid, ctok: '', cver: '1.0', lang: '01', sid: '8888', syscode: '09', auth: '', extension: [] };
}

/** The official checkResponse also rejects these business flags after Ack Success. */
function iqOutcome(outcome: SoaOutcome<unknown>): SoaOutcome<unknown> {
  if (outcome.kind !== 'success') return outcome;
  const body = recordOrNull(outcome.body);
  if (body?.['returnCode'] === 0 || body?.['success'] === true || body?.['isSuccess'] === true) return outcome;
  if (body?.['success'] === false || body?.['isSuccess'] === false) return { kind: 'business_failure', ack: 'Success', errors: [], body: outcome.body };
  return outcome;
}

export async function fetchNoticeCategories(deps: AdapterDeps, soa: SoaClient): Promise<{ readonly ok: true; readonly items: NoticeCategoryInfo[] } | { readonly ok: false; readonly outcome: SoaOutcome<unknown> }> {
  const outcome = iqOutcome(await soa.post<unknown>(Endpoints.IQ_CONVERSATIONS, { lastMsgTime: 0, head: noticeConversationsHead(deps) }));
  if (outcome.kind !== 'success') return { ok: false, outcome };
  const items = flattenCategories(outcome.body);
  return items === null ? { ok: false, outcome: { kind: 'malformed', detail: 'invalid IQ categoryList' } } : { ok: true, items };
}

function jsonObject(x: unknown): Record<string, unknown> | null {
  if (typeof x === 'string') {
    try {
      return recordOrNull(JSON.parse(x));
    } catch {
      try {
        return recordOrNull(JSON.parse(x.replace(/[\n\f\r\t]/g, c => JSON.stringify(c).slice(1, -1))));
      } catch {
        return null;
      }
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
  const id = idStr(r['msgId']);
  const time = n(r['createTime']);
  const content = jsonObject(r['messageBody']);
  if (id === null || time === null || content === null) return null;
  const ext = jsonObject(content['ext']) ?? {};
  const extend = jsonObject(ext['extendInfo']) ?? {};
  return {
    id,
    category_id: categoryId,
    title: s(ext['title']) ?? '',
    body: s(ext['desc']) ?? '',
    time_ms: time,
    // The official UI clears a category as a whole. This per-row UI indicator is
    // derived locally from the category boundary; status/isRead are not evidence.
    unread: unreadTimeline !== null && time > unreadTimeline,
    url: httpsUrl(extend['toJumpUrlOnline']) || httpsUrl(extend['toJumpUrl']),
  };
}

export async function fetchNoticeList(
  deps: AdapterDeps,
  soa: SoaClient,
  ref: NoticeCategoryRef,
  lastMsgTime: number,
  unreadTimeline: number | null = null,
): Promise<{ readonly ok: true; readonly items: UiNotice[]; readonly rows: readonly unknown[] } | { readonly ok: false; readonly outcome: SoaOutcome<unknown> }> {
  const outcome = iqOutcome(await soa.post<unknown>(Endpoints.IQ_MESSAGES, {
    categoryId: ref.categoryId,
    categorySubId: ref.categorySubId,
    lastMsgTime,
    pageSize: IQ_PAGE_SIZE,
    head: noticeMessageHead(deps),
  }));
  if (outcome.kind !== 'success') return { ok: false, outcome };
  const rows = recordOrNull(outcome.body)?.['iqMessages'];
  if (!Array.isArray(rows)) return { ok: false, outcome: { kind: 'malformed', detail: 'invalid IQ iqMessages' } };
  const cid = noticeCategoryId(ref);
  const items: UiNotice[] = [];
  // Preserve the raw page length through the array IPC. The UI merges by exact
  // ID after using this length to determine whether another page may exist.
  for (const row of rows) {
    const item = iqMessageToNotice(row, cid, unreadTimeline);
    if (item === null) return { ok: false, outcome: { kind: 'malformed', detail: 'invalid IQ message row' } };
    items.push(item);
  }
  items.sort((a, b) => a.time_ms - b.time_ms);
  return { ok: true, items, rows };
}

/** Official noticeWindow translateMessages: getHead('1001'), title/desc rules. */
export const TRANSLATE_IQ_MESSAGE = endpoint('translateIQMessage', M, '11679/translateIQMessage', 'read');

export type NoticeTranslateResult =
  | { readonly kind: 'translated' | 'unchanged'; readonly items: readonly UiNotice[] }
  | { readonly kind: 'failed'; readonly items: readonly UiNotice[]; readonly outcome: SoaOutcome<unknown> };

/**
 * A partial/failed translation always keeps each original field. Match exact
 * message ids and requested keys only; upstream links and metadata cannot
 * replace the source notice's navigation or account/category identity.
 */
export async function translateNoticeMessage(
  deps: AdapterDeps,
  soa: SoaClient,
  items: readonly UiNotice[],
  targetLocale = deps.context.locale,
): Promise<NoticeTranslateResult> {
  if (!items.length || !targetLocale || targetLocale === 'zh-CN') return { kind: 'unchanged', items };
  const requested = new Map<string, { title?: string; desc?: string }>();
  for (const item of items) {
    if (!item.id || requested.has(item.id)) continue;
    const fields = { ...(item.title ? { title: item.title } : {}), ...(item.body ? { desc: item.body } : {}) };
    if (Object.keys(fields).length) requested.set(item.id, fields);
  }
  if (!requested.size) return { kind: 'unchanged', items };
  const outcome = iqOutcome(await soa.post<unknown>(TRANSLATE_IQ_MESSAGE, {
    head: noticeConversationsHead(deps), originLocale: 'zh-CN', targetLocale,
    rules: [...requested].map(([msgId, fields]) => ({ msgId, items: fields })),
  }));
  if (outcome.kind !== 'success') return { kind: 'failed', items, outcome };
  const results = recordOrNull(outcome.body)?.['results'];
  if (!Array.isArray(results)) return { kind: 'failed', items, outcome: { kind: 'malformed', detail: 'invalid IQ translation results' } };
  const translated = new Map<string, Record<string, unknown>>();
  const seen = new Set<string>();
  for (const result of results) {
    const row = recordOrNull(result), id = idStr(row?.['msgId']);
    if (id === null || !requested.has(id)) continue;
    // Ambiguous duplicate results must not attach an arbitrary translation.
    if (seen.has(id)) { translated.delete(id); continue; }
    seen.add(id);
    const fields = recordOrNull(row?.['translateItems']);
    if (fields) translated.set(id, fields);
  }
  let changed = false;
  const mapped = items.map(item => {
    const fields = translated.get(item.id), source = requested.get(item.id);
    const title = source?.title === item.title ? s(fields?.['title']) : null;
    const body = source?.desc === item.body ? s(fields?.['desc']) : null;
    if (title === null && body === null) return item;
    changed = true;
    return { ...item, title: title ?? item.title, body: body ?? item.body };
  });
  return { kind: changed ? 'translated' : 'unchanged', items: mapped };
}

/** Write; an unknown outcome is reported as such and never replayed. */
export async function markNoticeRead(deps: AdapterDeps, soa: SoaClient, ref: NoticeCategoryRef, msgId: string): Promise<SoaOutcome<unknown>> {
  return iqOutcome(await soa.post<unknown>(Endpoints.PUT_ADVICE_READ_IQ, { categoryId: ref.categoryId, categorySubId: ref.categorySubId, msgId, head: noticeMessageHead(deps) }));
}
