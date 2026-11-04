/**
 * Order → conversation entry (docs/dev/04-business-pages.md,
 * docs/research/2026-10-30-web-order-conversation.md).
 *
 * Both 14361 requests carry the platform head (`cver:"1.0"`, empty
 * extension, no appId) exactly as sampled, not the IM business head.
 *
 * - `searchOrderExact(ttdOrderId)`: `sec-m.ctrip.com/14361/searchorderlist`
 *   with `ttdOrderId` as a STRING; the other observed fields are copied as
 *   defaults where the doc recorded a value (`contentType:"json",
 *   pageIndex:1, pageSize:20, aggSortType.direction:"desc", vbkVer:3,
 *   datablockType:0`). `page:"0"` and `aggSortType.property:"orderDate"` were verified
 *   on the official all-orders tab on 2026-11-03.
 * - `createImChat(ttdOrderId)`: `14361/createimchat` — may create or
 *   activate a conversation; a timeout is `unknown_may_have_created` and is
 *   never replayed.
 * - `validateImUrl(url)`: exact https origin, allowed path, typed params,
 *   unknown params preserved (never rebuilt into a "look-alike" URL).
 * - `orderDetailUrl(orderId)`: the official web detail page for advanced ops.
 * - `searchConversationByOrder`: `16037/searchConversation`; the
 *   `searchType` for order numbers was not recorded, so it is a parameter.
 */

import type { AdapterDeps } from './deps.ts';
import { Endpoints } from './endpoints.ts';
import { businessHead, platformHead } from './heads.ts';
import { isBizSuccess, recordOrNull, type SoaClient, type SoaOutcome } from './soa.ts';
import { mapConversationStatus } from './conversationList.ts';
import type { ConversationStatus } from '../../ipc/src/contracts.ts';

// ------------------------------------------------------------- searchorderlist

export interface OrderSearchParams {
  /** Official order tab selector; "0" means all orders. */
  readonly page: string;
  /** Official sort field; exact lookup uses orderDate. */
  readonly sortProperty: string;
  readonly direction?: 'asc' | 'desc';
  readonly pageIndex?: number;
  readonly pageSize?: number;
  readonly vbkVer?: number;
  readonly datablockType?: number;
}

/** Official all-orders tab, verified by exact-order request on 2026-11-03. */
export const ORDER_EXACT_SEARCH_PARAMS: OrderSearchParams = { page: '0', sortProperty: 'orderDate' };

export const ORDER_SEARCH_DEFAULTS = { contentType: 'json', pageIndex: 1, pageSize: 20, direction: 'desc', vbkVer: 3, datablockType: 0 } as const;

export function searchOrderListBody(deps: AdapterDeps, ttdOrderId: string, p: OrderSearchParams): Record<string, unknown> {
  return {
    contentType: ORDER_SEARCH_DEFAULTS.contentType,
    head: platformHead(deps.context),
    page: p.page,
    ttdOrderId,
    pageIndex: p.pageIndex ?? ORDER_SEARCH_DEFAULTS.pageIndex,
    pageSize: p.pageSize ?? ORDER_SEARCH_DEFAULTS.pageSize,
    aggSortType: { property: p.sortProperty, direction: p.direction ?? ORDER_SEARCH_DEFAULTS.direction },
    vbkVer: p.vbkVer ?? ORDER_SEARCH_DEFAULTS.vbkVer,
    datablockType: p.datablockType ?? ORDER_SEARCH_DEFAULTS.datablockType,
  };
}

export type OrderSearchResult =
  | { readonly kind: 'one'; readonly order: Readonly<Record<string, unknown>> }
  | { readonly kind: 'none' }
  | { readonly kind: 'multiple'; readonly count: number }
  | { readonly kind: 'forbidden'; readonly errorCode: number; readonly errorMsg: string }
  | { readonly kind: 'error'; readonly outcome: SoaOutcome<unknown> | null; readonly detail: string };

interface OrderListResponse {
  readonly response?: unknown;
  readonly orderList?: unknown;
  readonly totalCount?: unknown;
}

/** Digits only; the official page accepts a 4-digit suffix search but this client never does. */
export function isValidOrderId(id: string): boolean {
  return /^\d{1,32}$/.test(id);
}

export async function searchOrderExact(deps: AdapterDeps, soa: SoaClient, ttdOrderId: string, params: OrderSearchParams = ORDER_EXACT_SEARCH_PARAMS): Promise<OrderSearchResult> {
  if (typeof ttdOrderId !== 'string' || !isValidOrderId(ttdOrderId)) return { kind: 'error', outcome: null, detail: 'invalid order id' };
  const outcome = await soa.post<OrderListResponse>(Endpoints.SEARCH_ORDER_LIST, searchOrderListBody(deps, ttdOrderId, params));
  if (outcome.kind !== 'success') return { kind: 'error', outcome, detail: outcome.kind };
  const resp = recordOrNull(outcome.body.response);
  const errorCode = typeof resp?.['errorCode'] === 'number' ? (resp['errorCode'] as number) : null;
  const errorMsg = typeof resp?.['errorMsg'] === 'string' ? (resp['errorMsg'] as string) : '';
  if (errorCode !== null && errorCode !== 0) {
    // "No permission" wording is from a sibling endpoint (14735); treated as a heuristic, documented as unverified.
    if (/permission/i.test(errorMsg)) return { kind: 'forbidden', errorCode, errorMsg };
    return { kind: 'error', outcome, detail: `errorCode ${errorCode}` };
  }
  if (errorCode !== 0 || !Array.isArray(outcome.body.orderList)) return { kind: 'error', outcome, detail: 'order response malformed' };
  const list = outcome.body.orderList;
  const total = outcome.body.totalCount ?? list.length;
  if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0) return { kind: 'error', outcome, detail: 'order count malformed' };
  const count = Math.max(total, list.length);
  if (count === 0) return { kind: 'none' };
  if (count > 1) return { kind: 'multiple', count };
  const order = recordOrNull(list[0]);
  if (!order || orderIdentifier(order['ttdOrderId']) !== ttdOrderId) return { kind: 'error', outcome, detail: 'order identity mismatch' };
  return { kind: 'one', order };
}

/** Reject rounded JSON numbers; never authorize another order by a lossy ID. */
function orderIdentifier(value: unknown): string | null {
  if (typeof value === 'string' && isValidOrderId(value)) return value;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
}

/** Only bounded display fields cross the adapter boundary; no uid, phone or email. */
export function searchedOrderSummary(order: Readonly<Record<string, unknown>>): import('../../ipc/src/client.ts').UiOrderSummary | null {
  const id = orderIdentifier(order['ttdOrderId']);
  const rows = Array.isArray(order['orderInfoList']) ? order['orderInfoList'].map(recordOrNull) : [];
  if (!id || rows.length === 0 || rows.some(r => !r || orderIdentifier(r['ttdOrderId']) !== id)) return null;
  const text = (v: unknown): string => typeof v === 'string' ? v.slice(0, 500) : '';
  const joined = (key: string): string => [...new Set(rows.map(r => text(r?.[key])).filter(Boolean))].join(' / ').slice(0, 1000);
  const product = joined('resourceName') || joined('productName');
  const status = joined('orderStatus');
  if (!product.trim() || !status.trim()) return null;
  const names = rows.map(r => text(r?.['customerName']).trim()).filter(Boolean);
  return {
    order_id: id,
    product,
    use_date: joined('useDateShow') || joined('useDateDisp'),
    quantity: rows.map(r => typeof r?.['quantity'] === 'number' && Number.isFinite(r['quantity']) ? String(r['quantity']) : '').join(' / '),
    status,
    contact: [...new Set(names.map(n => [...n][0] + '***'))].join(' / '),
    source_channel: joined('channelName'),
  };
}

// ------------------------------------------------------------- createimchat

export type CreateImChatResult =
  | { readonly kind: 'ok'; readonly url: string }
  | { readonly kind: 'rejected'; readonly outcome: SoaOutcome<unknown>; readonly errorCode: number | null; readonly errorMsg: string }
  | { readonly kind: 'unknown_may_have_created' };

interface CreateImChatResponse {
  readonly response?: unknown;
  readonly url?: unknown;
}

export async function createImChat(deps: AdapterDeps, soa: SoaClient, ttdOrderId: string): Promise<CreateImChatResult> {
  const body = { contentType: 'json', head: platformHead(deps.context), ttdOrderId };
  const outcome = await soa.post<CreateImChatResponse>(Endpoints.CREATE_IM_CHAT, body);
  if (outcome.kind === 'unknown') return { kind: 'unknown_may_have_created' };
  if (outcome.kind !== 'success') return { kind: 'rejected', outcome, errorCode: null, errorMsg: '' };
  const resp = recordOrNull(outcome.body.response);
  const errorCode = typeof resp?.['errorCode'] === 'number' ? (resp['errorCode'] as number) : null;
  const errorMsg = typeof resp?.['errorMsg'] === 'string' ? (resp['errorMsg'] as string) : '';
  const url = outcome.body.url;
  if (errorCode === 0 && typeof url === 'string' && url !== '') return { kind: 'ok', url };
  return { kind: 'rejected', outcome, errorCode, errorMsg };
}

// ------------------------------------------------------------- url validation

export const IM_URL_ALLOWED: Readonly<Record<string, readonly string[]>> = {
  'imvendor.ctrip.com': ['/main'],
  'vbooking.ctrip.com': ['/vbk/im/main'],
};

export interface ImUrlParams {
  readonly initChat: number | null;
  readonly serviceType: string | null;
  readonly vendorRole: string | null;
  readonly currentTab: string | null;
  readonly accountsource: string | null;
  readonly clientSource: string | null;
  readonly lang: string | null;
  readonly vendorRefId: string | null;
  readonly threadId: string | null;
  readonly orderNo: string | null;
  readonly extParams: string | null;
  readonly targetGid: string | null;
}

export type ImUrlValidation =
  | { readonly ok: true; readonly origin: string; readonly path: string; readonly params: ImUrlParams; readonly unknownParams: Readonly<Record<string, string>>; readonly href: string }
  | { readonly ok: false; readonly reason: string };

const KNOWN_PARAMS = ['initChat', 'serviceType', 'vendorRole', 'currentTab', 'accountsource', 'client-source', 'lang', 'vendorRefId', 'threadId', 'orderNo', 'extParams', 'targetGid'];

const ALNUM = /^[A-Za-z0-9_-]*$/;
const DIGITS = /^\d*$/;
const LOCALE = /^([a-z]{2}([-_][A-Za-z]{2,4})?)?$/;

interface ParamReader {
  (name: string, re: RegExp): string | null;
  readonly invalid: string[];
}

function paramReader(sp: URLSearchParams): ParamReader {
  const invalid: string[] = [];
  const read = ((name: string, re: RegExp): string | null => {
    if (!sp.has(name)) return null;
    const v = sp.get(name) ?? '';
    if (!re.test(v)) invalid.push(name);
    return v;
  }) as ParamReader;
  Object.defineProperty(read, 'invalid', { value: invalid });
  return read;
}

export function validateImUrl(raw: string): ImUrlValidation {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: 'unparsable' };
  }
  if (u.protocol !== 'https:') return { ok: false, reason: 'scheme' };
  if (u.username !== '' || u.password !== '') return { ok: false, reason: 'userinfo' };
  if (u.port !== '') return { ok: false, reason: 'port' };
  const host = u.hostname;
  const paths = IM_URL_ALLOWED[host];
  if (!paths || !Object.prototype.hasOwnProperty.call(IM_URL_ALLOWED, host)) return { ok: false, reason: 'host' };
  if (!paths.includes(u.pathname)) return { ok: false, reason: 'path' };
  if (u.hash !== '') return { ok: false, reason: 'fragment' };

  const sp = u.searchParams;
  for (const name of KNOWN_PARAMS) if (sp.getAll(name).length > 1) return { ok: false, reason: `duplicate:${name}` };
  const read = paramReader(sp);
  const initChatRaw = read('initChat', DIGITS);
  const params: ImUrlParams = {
    initChat: initChatRaw === null || initChatRaw === '' ? null : Number(initChatRaw),
    serviceType: read('serviceType', DIGITS),
    vendorRole: read('vendorRole', ALNUM),
    currentTab: read('currentTab', ALNUM),
    accountsource: read('accountsource', ALNUM),
    clientSource: read('client-source', ALNUM),
    lang: read('lang', LOCALE),
    vendorRefId: read('vendorRefId', ALNUM),
    threadId: read('threadId', ALNUM),
    orderNo: read('orderNo', DIGITS),
    extParams: sp.has('extParams') ? sp.get('extParams') : null,
    targetGid: read('targetGid', ALNUM),
  };
  const firstInvalid = read.invalid[0];
  if (firstInvalid !== undefined) return { ok: false, reason: `param:${firstInvalid}` };

  const unknownParams: Record<string, string> = {};
  for (const [k, v] of sp.entries()) if (!KNOWN_PARAMS.includes(k)) unknownParams[k] = v;

  return { ok: true, origin: u.origin, path: u.pathname, href: u.href, params, unknownParams };
}

// ------------------------------------------------------------- order B2C initialization

/** Current loaded official legacy web createChat builder; no card/robot follow-ups. */
export type OrderImPlan =
  | { readonly kind: 'target'; readonly gid: string }
  | { readonly kind: 'start_b2c'; readonly params: ImUrlParams; readonly body: Readonly<Record<string, unknown>> }
  | { readonly kind: 'invalid'; readonly reason: string };

/** Numeric identifiers remain strings; an unsafe JSON number can never identify a group. */
export function preciseGroupId(value: unknown): string | null {
  if (typeof value === 'string' && /^\d{1,32}$/.test(value) && !/^0+$/.test(value)) return value;
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : null;
}

export function orderImPlan(rawUrl: string, orderId: string): OrderImPlan {
  const valid = validateImUrl(rawUrl);
  if (!valid.ok) return { kind: 'invalid', reason: valid.reason };
  const p = valid.params;
  if (!isValidOrderId(orderId) || p.orderNo !== orderId) return { kind: 'invalid', reason: 'order_mismatch' };
  if (p.initChat !== 2) return { kind: 'invalid', reason: 'unsupported_init_chat' };
  if (p.accountsource !== 'VBK') return { kind: 'invalid', reason: 'unsupported_account_source' };
  if (!p.serviceType) return { kind: 'invalid', reason: 'missing_service_type' };
  if (p.targetGid) {
    const gid = preciseGroupId(p.targetGid);
    return gid === null ? { kind: 'invalid', reason: 'invalid_target_gid' } : { kind: 'target', gid };
  }
  let ext: Record<string, unknown> = {};
  if (p.extParams) {
    try { ext = recordOrNull(JSON.parse(p.extParams)) ?? {}; } catch { /* Official builder falls back to {}. */ }
  }
  // A URL must not silently bind the requested order to a second order identity.
  if (ext['orderId'] !== undefined && orderIdentifier(ext['orderId']) !== orderId) return { kind: 'invalid', reason: 'ext_order_mismatch' };
  const languageInfo: Record<string, unknown> = {};
  if (p.lang) languageInfo['lang'] = p.lang;
  const body: Record<string, unknown> = { source: 'h5', pageCode: '', serviceType: p.serviceType, languageInfo };
  if (p.vendorRefId) body['vendorRefId'] = p.vendorRefId;
  if (p.vendorRole) body['role'] = p.vendorRole;
  if (p.threadId) body['threadId'] = p.threadId;
  body['orderNo'] = orderId;
  body['extParams'] = { ...ext, orderId };
  return { kind: 'start_b2c', params: p, body };
}

/** Current web wrapper cver2 head (cookie branch), verified independently of desktop heads. */
export function orderB2cHead(deps: AdapterDeps, p: ImUrlParams) {
  return { cver: '2', extension: [
    { name: 'cpc', value: 'pc' },
    { name: 'protocal', value: 'https' },
    { name: 'amp-product-type', value: 'IM' },
    { name: 'amp-account-source', value: 'VBK' },
    { name: 'client-source', value: p.clientSource || '' },
    { name: 'locale', value: deps.context.locale || 'zh-CN' },
  ] };
}

export type StartOrderB2cResult =
  | { readonly kind: 'ok'; readonly gid: string }
  | { readonly kind: 'rejected'; readonly outcome: SoaOutcome<unknown> }
  | { readonly kind: 'unknown_may_have_created' };

export async function startOrderB2c(deps: AdapterDeps, soa: SoaClient, plan: Extract<OrderImPlan, { kind: 'start_b2c' }>): Promise<StartOrderB2cResult> {
  const outcome = await soa.post<unknown>(Endpoints.START_CHAT_B2C, { ...plan.body, head: orderB2cHead(deps, plan.params) });
  if (outcome.kind === 'unknown' || outcome.kind === 'malformed' || outcome.kind === 'http_error') return { kind: 'unknown_may_have_created' };
  if (outcome.kind !== 'success') return { kind: 'rejected', outcome };
  const body = recordOrNull(outcome.body);
  if (body?.['success'] === false || body?.['isSuccess'] === false || (recordOrNull(body?.['bizResponseStatus'])?.['resultCode'] !== undefined && !isBizSuccess(body))) {
    return { kind: 'rejected', outcome: { kind: 'business_failure', ack: 'Success', errors: [], body: outcome.body } };
  }
  const worksheet = body?.['workSheetId'] || body?.['sWorkSheetId'];
  const worksheetId = typeof worksheet === 'string' && worksheet.trim() !== '' ? worksheet : typeof worksheet === 'number' && Number.isSafeInteger(worksheet) && worksheet > 0 ? String(worksheet) : null;
  const gid = preciseGroupId(body?.['groupId']);
  // A response without usable identities cannot prove creation failed. Keep a tombstone.
  if (!worksheetId || /^0+$/.test(worksheetId) || !gid) return { kind: 'unknown_may_have_created' };
  return { kind: 'ok', gid };
}

// ------------------------------------------------------------- detail url

export const ORDER_DETAIL_BASE = 'https://vbooking.ctrip.com/ticket_order/order/detail?orderId=';

/** `null` for anything but a plain alphanumeric id. */
export function orderDetailUrl(orderId: string): string | null {
  if (!/^[A-Za-z0-9]{1,64}$/.test(orderId)) return null;
  return ORDER_DETAIL_BASE + encodeURIComponent(orderId);
}

// ------------------------------------------------------------- searchConversation

/** Observed `searchType` when searching the controlled conversation by name/uid (samples 49/19/27). The order-number type was not recorded. */
export const SEARCH_TYPE_OBSERVED_CONVERSATION = 3;

export interface ConversationSearchHit {
  readonly gid: string;
  readonly sessionId: string | null;
  readonly status: ConversationStatus;
  readonly serviceType: string | null;
  readonly inGroup: number | null;
  readonly conversationType: string | null;
  readonly threadId: string | null;
}

export type ConversationSearchResult =
  | { readonly kind: 'hits'; readonly hits: readonly ConversationSearchHit[] }
  | { readonly kind: 'biz_failure'; readonly resultCode: string | null }
  | { readonly kind: 'failed'; readonly outcome: SoaOutcome<unknown> };

interface SearchConversationResponse {
  readonly customerSearchList?: unknown;
}

export async function searchConversationByOrder(deps: AdapterDeps, soa: SoaClient, orderNo: string, searchType: number, pageNo = 1): Promise<ConversationSearchResult> {
  const body = { head: businessHead(deps.context), searchType, searchValue: orderNo, pageNo };
  const outcome = await soa.post<SearchConversationResponse>(Endpoints.SEARCH_CONVERSATION, body);
  if (outcome.kind !== 'success') return { kind: 'failed', outcome };
  if (!isBizSuccess(outcome.body)) {
    const biz = recordOrNull(recordOrNull(outcome.body)?.['bizResponseStatus']);
    return { kind: 'biz_failure', resultCode: typeof biz?.['resultCode'] === 'string' ? (biz['resultCode'] as string) : null };
  }
  const list = Array.isArray(outcome.body.customerSearchList) ? outcome.body.customerSearchList : [];
  const hits: ConversationSearchHit[] = [];
  for (const entry of list) {
    const conv = recordOrNull(recordOrNull(entry)?.['conversation']);
    if (!conv || typeof conv['gid'] !== 'string') continue;
    hits.push({
      gid: conv['gid'] as string,
      sessionId: typeof conv['sessionId'] === 'string' ? (conv['sessionId'] as string) : null,
      status: mapConversationStatus(conv['status']),
      serviceType: typeof conv['serviceType'] === 'string' ? (conv['serviceType'] as string) : null,
      inGroup: typeof conv['inGroup'] === 'number' ? (conv['inGroup'] as number) : null,
      conversationType: typeof conv['conversationType'] === 'string' ? (conv['conversationType'] as string) : null,
      threadId: typeof conv['threadId'] === 'string' ? (conv['threadId'] as string) : null,
    });
  }
  return { kind: 'hits', hits };
}
