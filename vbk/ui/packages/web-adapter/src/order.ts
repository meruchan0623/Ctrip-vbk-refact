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
 *   datablockType:0`). `page` and `aggSortType.property` were redacted in
 *   the evidence ("待追溯"), so they are injected, not guessed.
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
  /** Observed as a string placeholder; value source not closed — inject from the official page context. */
  readonly page: string;
  /** `aggSortType.property`, also redacted in evidence. */
  readonly sortProperty: string;
  readonly direction?: 'asc' | 'desc';
  readonly pageIndex?: number;
  readonly pageSize?: number;
  readonly vbkVer?: number;
  readonly datablockType?: number;
}

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

export async function searchOrderExact(deps: AdapterDeps, soa: SoaClient, ttdOrderId: string, params: OrderSearchParams): Promise<OrderSearchResult> {
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
  const list = Array.isArray(outcome.body.orderList) ? outcome.body.orderList : [];
  const total = typeof outcome.body.totalCount === 'number' ? outcome.body.totalCount : list.length;
  const count = Math.max(total, list.length);
  if (count === 0) return { kind: 'none' };
  if (count > 1) return { kind: 'multiple', count };
  const order = recordOrNull(list[0]);
  if (!order) return { kind: 'error', outcome, detail: 'order row malformed' };
  return { kind: 'one', order };
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
  if ((errorCode === 0 || errorCode === null) && typeof url === 'string' && url !== '') return { kind: 'ok', url };
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
