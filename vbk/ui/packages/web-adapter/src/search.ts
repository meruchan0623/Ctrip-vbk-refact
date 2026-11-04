import { adapterStrings } from './strings.ts';
/** Isolated server search/history. No shared conversation/role cache or fact writes. */
import type { UiSearchHistoryPage, UiSearchHistoryRequest, UiServerSearchHit, UiServerSearchPage, UiServerSearchQuery, ServerSearchGroup } from '../../ipc/src/server-search.ts';
import type { AdapterDeps } from './deps.ts';
import { SEARCH_CONVERSATION, SEARCH_MAX_PAGE, SEARCH_VALUE_MAX_CHARS, LATEST_CONVERSATION } from './peripheral.ts';
import { businessHead } from './heads.ts';
import { M } from './endpoints.ts';
const QUERY_GROUP_INFO = endpoint('queryGroupInfo', M, '15529/queryGroupInfo', 'read');
import { endpoint, isBizSuccess, recordOrNull, type SoaClient } from './soa.ts';
import { buildMemberRoles, is13DigitMs, normalizeTimeMs, jidLocal, type HttpMessageObject } from './facts.ts';
import { httpMessageToUi, previewOf } from './display.ts';
import { fetchHistoryPage } from './history.ts';

const fields: Readonly<Record<ServerSearchGroup, string>> = { customer: 'customerSearchList', content: 'contentSearchList', order: 'orderSearchList', date: 'dateSearchList' };
const groups = Object.keys(fields) as ServerSearchGroup[];
export class SearchError extends Error { readonly detail: string; constructor(detail: string) { super(detail); this.detail = detail; } }
interface Selection { readonly gid: string; readonly type: string; readonly customer: string | null; readonly time: number; readonly messageId: string | null; readonly generation: number; readonly current: () => boolean; readonly expires: number }
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value : null;
const positive = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;

/** Reject explicit foreign room evidence before applying the selected gid. */
function assertMessageRoom(row: HttpMessageObject, gid: string): void {
  const partner = text(row.partner), from = text(row.fromJid), to = text(row.toJid);
  if (partner && jidLocal(partner) !== gid) throw new SearchError(adapterStrings['search.roomMismatch']);
  if (from?.includes('/') && jidLocal(from) !== gid) throw new SearchError(adapterStrings['search.roomMismatch']);
  if (!partner && !from?.includes('/') && to && jidLocal(to) !== gid) throw new SearchError(adapterStrings['search.roomMismatch']);
}

export function serverSearchBody(deps: AdapterDeps, query: UiServerSearchQuery): Record<string, unknown> {
  if (!text(query.query_id) || query.query_id.length > 128) throw new SearchError(adapterStrings['search.queryInvalidated']);
  if (!positive(query.search_type, 0, 4) || !positive(query.page_no, 1, SEARCH_MAX_PAGE)) throw new SearchError(adapterStrings['search.rangeInvalid']);
  const body: Record<string, unknown> = { head: businessHead(deps.context), searchType: query.search_type, pageNo: query.page_no };
  if (query.search_type === 4) {
    if (!is13DigitMs(query.start_ms) || !is13DigitMs(query.end_ms) || query.start_ms > query.end_ms) throw new SearchError(adapterStrings['search.dateRangeInvalid']);
    body['startTime'] = query.start_ms; body['endTime'] = query.end_ms;
  } else {
    if (!text(query.search_value) || query.search_value!.length > SEARCH_VALUE_MAX_CHARS) throw new SearchError(adapterStrings['search.queryTextInvalid']);
    body['searchValue'] = query.search_value!.trim();
  }
  return body;
}

export function createServerSearch(deps: AdapterDeps, soa: SoaClient, selfUid: string, namespace: string) {
  let identity = '', generation = 0, request = 0, sequence = 0;
  const selections = new Map<string, Selection>();
  const validSelection = (token: string, current: () => boolean) => {
    const hit = selections.get(token);
    if (!hit || hit.generation !== generation || !hit.current() || !current() || hit.expires <= deps.now()) throw new SearchError(adapterStrings['search.searchExpired']);
    return hit;
  };
  return {
    async search(query: UiServerSearchQuery, current: () => boolean): Promise<UiServerSearchPage> {
      const body = serverSearchBody(deps, query);
      const key = JSON.stringify([query.query_id, query.search_type, query.search_type === 4 ? [query.start_ms, query.end_ms] : query.search_value?.trim()]);
      if (identity !== key) { identity = key; generation++; selections.clear(); }
      const visit = generation, ticket = ++request;
      const valid = () => current() && visit === generation && ticket === request;
      if (!valid()) throw new SearchError(adapterStrings['search.accountChanged']);
      const result = await soa.post<unknown>(SEARCH_CONVERSATION, body);
      if (!valid()) throw new SearchError(adapterStrings['search.queryOrAccountChanged']);
      if (result.kind !== 'success' || !isBizSuccess(result.body)) throw new SearchError(result.kind === 'auth_invalid' ? adapterStrings['search.loginExpired'] : adapterStrings['search.requestFailed']);
      const data = { ...recordOrNull(result.body)! };
      if (!groups.some(group => Array.isArray(data[fields[group]]))) throw new SearchError(adapterStrings['search.responseInvalid']);
      for (const group of groups) if (data[fields[group]] !== undefined && !Array.isArray(data[fields[group]])) throw new SearchError(adapterStrings['search.responseInvalid']);
      const info = recordOrNull(data['pageInfo']);
      // Official reducer defaults absent pageCount to zero, never infers pages
      // from result count. Reject present malformed pagination metadata.
      const count = info?.['pageCount'] ?? 0;
      if (!positive(count, 0, SEARCH_MAX_PAGE) || (data['pageInfo'] !== undefined && info === null)) throw new SearchError(adapterStrings['search.pageInfoInvalid']);
      // Official kyt supplements only the first order / numeric-all search.
      // Never interpret the entered order number as a gid: resolve it first.
      const value = query.search_value?.trim() ?? '';
      const orders = data['orderSearchList'];
      if (query.page_no === 1 && (query.search_type === 2 || (query.search_type === 3 && /^\d+$/.test(value))) &&
        !(Array.isArray(orders) && orders.some(row => recordOrNull(recordOrNull(row)?.['conversation'])?.['gid'] === value))) {
        const resolved = await soa.post<unknown>(QUERY_GROUP_INFO, { head: businessHead(deps.context), orderId: value });
        if (!valid()) throw new SearchError(adapterStrings['search.queryOrAccountChanged']);
        if (resolved.kind !== 'success') throw new SearchError(adapterStrings['search.orderResolutionFailed']);
        const resolvedBody = recordOrNull(resolved.body);
        if (!resolvedBody || ('bizResponseStatus' in resolvedBody && !isBizSuccess(resolvedBody))) throw new SearchError(adapterStrings['search.orderResolutionFailed']);
        if (resolvedBody?.['success'] === false || resolvedBody?.['isSuccess'] === false) throw new SearchError(adapterStrings['search.orderResolutionFailed']);
        const gid = text(resolvedBody?.['gid']);
        if (resolvedBody?.['gid'] !== undefined && resolvedBody['gid'] !== null && !gid) throw new SearchError(adapterStrings['search.orderConversationInvalid']);
        if (gid && !(Array.isArray(orders) && orders.some(row => recordOrNull(recordOrNull(row)?.['conversation'])?.['gid'] === gid))) {
          const latest = await soa.post<unknown>(LATEST_CONVERSATION, { head: businessHead(deps.context), gid });
          if (!valid()) throw new SearchError(adapterStrings['search.queryOrAccountChanged']);
          if (latest.kind !== 'success' || !isBizSuccess(latest.body)) throw new SearchError(adapterStrings['search.orderConversationReadFailed']);
          const conversation = recordOrNull(recordOrNull(latest.body)?.['conversation']);
          if (!conversation || conversation['gid'] !== gid) throw new SearchError(adapterStrings['search.orderConversationMismatch']);
          data['orderSearchList'] = [...(Array.isArray(orders) ? orders : []), { conversation }];
        }
      }
      const mapped: Record<ServerSearchGroup, UiServerSearchHit[]> = { customer: [], content: [], order: [], date: [] };
      const pending = new Map<string, Selection>();
      for (const group of groups) {
        const raw = data[fields[group]] === undefined ? [] : data[fields[group]];
        if (!Array.isArray(raw) || raw.length > 500) throw new SearchError(adapterStrings['search.responseInvalid']);
        for (const entry of raw) {
          const e = recordOrNull(entry), c = recordOrNull(e?.['conversation']), m = recordOrNull(e?.['message']);
          if (e?.['message'] !== undefined && e['message'] !== null && m === null) throw new SearchError(adapterStrings['search.messageInvalid']);
          const gid = text(c?.['gid']), type = text(c?.['conversationType']);
          if (!gid || !type || gid.length > 256 || type.length > 64) throw new SearchError(adapterStrings['search.conversationIncomplete']);
          if (m) assertMessageRoom(m as HttpMessageObject, gid);
          const time = normalizeTimeMs(m?.['createTime']) ?? normalizeTimeMs(c?.['lastUpdateTime']) ?? deps.now();
          const messageId = text(m?.['msgId']);
          const token = `search-${namespace}-${++sequence}`;
          pending.set(token, { gid, type, customer: text(c?.['uid']), time, messageId, generation: visit, current, expires: deps.now() + 10 * 60_000 });
          mapped[group].push({ selection_token: token, gid, title: text(c?.['groupTitle']) ?? text(c?.['uid']) ?? gid, preview: m ? previewOf(m as HttpMessageObject) : '', message_id: messageId, time_ms: time });
        }
      }
      for (const [token, hit] of selections) if (hit.expires <= deps.now()) selections.delete(token);
      if (selections.size + pending.size > 5000) throw new SearchError(adapterStrings['search.tooManyResults']);
      for (const [token, hit] of pending) selections.set(token, hit);
      return { query_id: query.query_id, search_type: query.search_type, page_no: query.page_no, page_count: count, has_more: query.search_type !== 3 && query.page_no < count, groups: mapped };
    },
    async history(query: UiSearchHistoryRequest, current: () => boolean): Promise<UiSearchHistoryPage> {
      const hit = validSelection(query.selection_token, current);
      if (query.direction !== 'prev' && query.direction !== 'next') throw new SearchError(adapterStrings['search.historyDirectionInvalid']);
      const cursor = query.cursor_ms ?? (query.direction === 'prev' ? hit.time + 2000 : hit.time - 2000);
      if (!is13DigitMs(cursor)) throw new SearchError(adapterStrings['search.historyCursorInvalid']);
      const roles = buildMemberRoles({ selfUid, customerUid: hit.customer, members: [] });
      const response = await fetchHistoryPage(deps, soa, { gid: hit.gid, conversationType: hit.type, pageSize: 50, cursor: query.direction === 'prev' ? { direction: 'prev', endTime: cursor } : { direction: 'next', beginTime: cursor } }, roles);
      if (validSelection(query.selection_token, current) !== hit) throw new SearchError(adapterStrings['search.selectionChanged']);
      if (response.kind !== 'page') throw new SearchError(adapterStrings['search.historyFailed']);
      const page = response.page;
      for (const row of page.rows) assertMessageRoom(row, hit.gid);
      const items = page.rows.map(row => httpMessageToUi(row, roles, hit.gid)).filter((m): m is NonNullable<typeof m> => m !== null);
      const times = page.rows.map(row => normalizeTimeMs(row.createTime)).filter((v): v is number => v !== null);
      const boundary = page.lastMessageTime ?? (times.length ? (query.direction === 'prev' ? Math.min(...times) : Math.max(...times)) : null);
      const progresses = boundary !== null && (query.direction === 'prev' ? boundary < cursor : boundary > cursor);
      if (!page.isDone && !progresses) throw new SearchError(adapterStrings['search.historyCursorStalled']);
      return { selection_token: query.selection_token, direction: query.direction, items, cursor_ms: progresses ? boundary : null, has_more: !page.isDone && progresses, anchor_message_id: hit.messageId };
    },
  };
}
