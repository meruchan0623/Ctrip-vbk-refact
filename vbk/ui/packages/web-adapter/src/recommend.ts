/** Native product recommendations. Evidence 38/39 and peripheral research §4.
 * City names and customer-card branches additionally match official sidebar
 * 6-7b0c231aee.js (modules 1363/1364), inspected 2026-11-03. */
import type { RpcContext } from './rpc.ts';
import type { UiRecommendCities, UiRecommendProduct, UiRecommendProducts, UiRecommendSend } from '../../ipc/src/recommend.ts';
import type { AppError } from '../../ipc/src/contracts.ts';
import { ErrorCodes } from '../../ipc/src/contracts.ts';
import { ONLINE } from './endpoints.ts';
import { platformHead, businessHead } from './heads.ts';
import { endpoint, isBizSuccess, recordOrNull, type SoaOutcome } from './soa.ts';
import { LATEST_CONVERSATION } from './peripheral.ts';
import { sendProductCard, type ProductCardRequest } from './send.ts';

export const RECOMMEND_SELECTION_TTL_MS = 30_000;
export const RecommendEndpoints = {
  QUERY: endpoint('queryRecommendProductList', ONLINE, '15529/queryRecommendProductList', 'read'),
  CITIES: endpoint('queryIMSuggestCityList', ONLINE, '15529/queryIMSuggestCityList', 'read'),
} as const;
let instanceSequence = 0;
const PRICE = 'key_v2_api_product_recommend_price';
const nonempty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const productId = (v: unknown): string | null => nonempty(v) ? v : integer(v) && v >= 0 ? String(v) : null;
export class RecommendRpcError extends Error {
  readonly appError: AppError;
  constructor(message: string, code: string = ErrorCodes.ADAPTER_FAILED) { super(message); this.appError = { code, message, retryable: false }; }
}
function fail(message: string): never { throw new RecommendRpcError(message); }
function text(args: Record<string, unknown>, key: string): string { const v = args[key]; return nonempty(v) ? v : fail(`invalid argument: ${key}`); }
function successful<T>(outcome: SoaOutcome<T>, ctx: RpcContext): T {
  if (outcome.kind === 'success') return outcome.body;
  if (outcome.kind === 'auth_invalid') { ctx.pushFact({ kind: 'auth_invalid' }); throw new RecommendRpcError('recommendation login expired', ErrorCodes.ACCOUNT_TICKET_EXPIRED); }
  return fail(`recommendation read failed: ${outcome.kind}`);
}
function validUrl(value: unknown): string | null {
  if (!nonempty(value)) return null;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; } catch { return null; }
}
function state(row: Record<string, unknown>): string {
  if (!integer(row['status']) || !integer(row['inGroup'])) return fail('conversation state missing');
  return JSON.stringify([row['status'], row['inGroup']]);
}
/** Raw fields avoid rowView defaults hiding absent threadId or rounded IDs. */
function identity(row: Record<string, unknown>): string {
  for (const field of ['gid', 'sessionId', 'uid', 'serviceType', 'conversationType', 'conversationKey']) if (!nonempty(row[field])) fail(`conversation field missing: ${field}`);
  if (typeof row['threadId'] !== 'string' || !(integer(row['id']) && row['id'] >= 0)) fail('conversation threadId or worksheet id missing');
  return JSON.stringify(['gid', 'sessionId', 'uid', 'serviceType', 'conversationType', 'conversationKey', 'threadId', 'id'].map(k => row[k]));
}
function active(row: Record<string, unknown>): boolean { return row['status'] === 2 && (row['inGroup'] === 1 || row['inGroup'] === 4); }
interface Scope { readonly identity: string; readonly status: string; readonly account: string; readonly epoch: number | null; readonly row: Record<string, unknown> }
interface Selection { readonly scope: Scope; readonly expires: number; readonly current: () => boolean; readonly cards: ReadonlyMap<string, ProductCardRequest> }
function cardFor(body: Record<string, unknown>, display: Record<string, unknown>, customer: Record<string, unknown> | undefined, uid: string): ProductCardRequest | string {
  const biz = body['bizType'];
  if (!integer(biz) || biz <= 0) return 'recommendation business type missing';
  const template = body['cardTemplateId'];
  if (!nonempty(template)) return 'card template missing';
  const localized = biz === 1513 || biz === 2384;
  if (localized && !customer) return 'customer-language product missing';
  if (localized && (!nonempty(body['customerLocale']) || !nonempty(body['currency']))) return 'customer language or currency missing';
  const product = localized ? customer! : display;
  const group = biz === 2508 || biz === 2510 ? body['relatedCustomerUid'] : display['providerId'];
  if (!nonempty(group)) return biz === 2508 || biz === 2510 ? 'related customer identity missing' : 'product provider missing';
  const image = validUrl(product['productImageUrl']), jump = validUrl(product['jumpUrl']);
  if (!nonempty(product['productName']) || !image || !jump) return 'customer product name, image or detail URL missing';
  const url = new URL(jump); url.searchParams.set('recommend', '1');
  const card: Record<string, string> = { productName: product['productName'], productImageUrl: image, jumpUrl: url.href };
  const extensions = product['recommendProductExtList'];
  if (!Array.isArray(extensions)) return 'product extension fields missing';
  const seen = new Set(Object.keys(card));
  for (const item of extensions) {
    const ext = recordOrNull(item), key = ext?.['extendInfoKey'], value = ext?.['extendInfoValue'], name = ext?.['extendInfoName'];
    if (!nonempty(key) || !nonempty(value) || (localized && !nonempty(name))) return 'product extension incomplete';
    const keys = localized ? [key, `${key}_name`] : [key];
    if (keys.some(k => seen.has(k) || ['__proto__', 'prototype', 'constructor'].includes(k))) return 'product extension conflicts with card fields';
    keys.forEach(k => seen.add(k));
    card[key] = localized && key === PRICE ? `${body['currency']}${value}` : value;
    if (localized) card[`${key}_name`] = name as string;
  }
  return { bizType: biz, templateId: template, groupIdentity: group, uid, card, inSession: true };
}

export function createRecommendRpc(ctx: RpcContext) {
  const selections = new Map<string, Selection>();
  // Lifetime tombstones include unknown results and survive new query tokens.
  const writes = new Map<string, Promise<UiRecommendSend>>();
  const namespace = `${ctx.deps.now()}-${ctx.deps.random()}-${++instanceSequence}`;
  const pageCounts = new Map<string, Map<number, number>>();
  let sequence = 0;
  const account = () => JSON.stringify([ctx.roles.selfUid, ctx.deps.context]);
  function scope(gid: string): Scope {
    if (!nonempty(ctx.roles.selfUid)) fail('account identity missing');
    const row = recordOrNull(ctx.store.row(gid));
    if (!row) return fail('conversation not in page cache');
    return { identity: identity(row), status: state(row), account: account(), epoch: ctx.store.messageContext(gid), row };
  }
  function same(gid: string, old: Scope): boolean {
    const now = scope(gid); return now.identity === old.identity && now.status === old.status && now.account === old.account && now.epoch === old.epoch;
  }
  function ensure(gid: string, selected: Selection): void {
    if (!selected.current() || selected.expires <= ctx.deps.now() || !same(gid, selected.scope)) fail('product selection expired or conversation changed; reload products');
  }
  return {
    async query(args: unknown): Promise<UiRecommendProducts> {
      const a = recordOrNull(args) ?? {}, gid = text(a, 'gid'), query = a['query'], page = a['page_index'];
      if (typeof query !== 'string' || query.length > 500 || !integer(page) || page < 0 || page > 10000) fail('invalid product query or page index');
      const city = (key: string) => { const v = a[key]; return v === undefined ? -1 : integer(v) && v >= -1 ? v : fail(`invalid argument: ${key}`); };
      const owner = scope(gid), current = ctx.captureWriteGuard?.() ?? (() => true);
      if (!current()) fail('adapter session changed');
      const body = recordOrNull(successful(await ctx.soa.post(RecommendEndpoints.QUERY, { contentType: 'json', head: platformHead(ctx.deps.context), groupId: gid, locale: ctx.deps.context.locale, queryValue: query, departureCityId: city('departure_city_id'), destinationCityId: city('destination_city_id'), pageIndex: page, pageSize: 10 }), ctx));
      if (!current() || !same(gid, owner)) fail('conversation changed during product query');
      if (body?.['hasRecommendProductPrivilege'] === false) return { kind: 'forbidden', items: [], page_index: page, has_more: false, total: null, selection_token: '', expires_at_ms: 0, reason: 'product recommendation permission denied' };
      if (body?.['hasRecommendProductPrivilege'] !== true || !Array.isArray(body['recommendProductList'])) fail('recommendation permission or product list missing');
      const products = body['recommendProductList'], customers = Array.isArray(body['customerRecommendProductList']) ? body['customerRecommendProductList'] : [];
      const cards = new Map<string, ProductCardRequest>(), ids = new Set<string>(), items: UiRecommendProduct[] = [];
      for (const raw of products) {
        const product = recordOrNull(raw), id = productId(product?.['productId']);
        if (!product || !id || ids.has(id)) fail('missing or duplicate product identity');
        ids.add(id);
        const matches = customers.map(recordOrNull).filter(p => p && productId(p['productId']) === id);
        const built = matches.length > 1 ? 'duplicate customer product identity' : !active(owner.row) ? 'conversation is not active' : cardFor(body, product, matches[0] ?? undefined, owner.row['uid'] as string);
        if (typeof built !== 'string') cards.set(id, built);
        const ext = Array.isArray(product['recommendProductExtList']) ? product['recommendProductExtList'].map(recordOrNull).find(e => e?.['extendInfoKey'] === PRICE) : null;
        items.push({ id, name: typeof product['productName'] === 'string' ? product['productName'] : '', image_url: validUrl(product['productImageUrl']) ?? '', departure_city: typeof product['departureCity'] === 'string' ? product['departureCity'] : '', destination_city: typeof product['destinationCity'] === 'string' ? product['destinationCity'] : '', detail_url: validUrl(product['jumpUrl']) ?? '', price_text: typeof ext?.['extendInfoValue'] === 'string' ? ext['extendInfoValue'] : '', sendable: typeof built !== 'string', ...(typeof built === 'string' ? { unavailable_reason: built } : {}) });
      }
      const total = integer(body['totalNum']) && body['totalNum'] >= 0 ? body['totalNum'] : null;
      // Sequential pages count actual returned rows; a five-row page with more
      // total is never mistaken for the final page merely because pageSize=10.
      const pageKey = JSON.stringify([owner.identity, owner.account, owner.epoch, query, city('departure_city_id'), city('destination_city_id')]);
      let counts = pageCounts.get(pageKey);
      if (!counts || page === 0) { counts = new Map(); pageCounts.set(pageKey, counts); }
      counts.set(page, products.length);
      let received = 0, contiguous = true;
      for (let i = 0; i <= page; i++) { const count = counts.get(i); if (count === undefined) { contiguous = false; break; } received += count; }
      const hasMore = products.length > 0 && (total === null ? products.length >= 5 : !contiguous || received < total);
      if (pageCounts.size > 128) pageCounts.delete(pageCounts.keys().next().value!);
      const token = `recommend-${namespace}-${++sequence}`, expires = ctx.deps.now() + RECOMMEND_SELECTION_TTL_MS;
      for (const [key, old] of selections) if (old.expires <= ctx.deps.now()) selections.delete(key);
      if (selections.size >= 128) selections.delete(selections.keys().next().value!);
      selections.set(token, { scope: owner, current, expires, cards });
      return { kind: 'ready', items, page_index: page, total, has_more: hasMore, selection_token: token, expires_at_ms: expires };
    },
    async cities(args: unknown): Promise<UiRecommendCities> {
      const a = recordOrNull(args) ?? {}, query = text(a, 'query');
      if (query.length > 100) fail('city query too long');
      const current = ctx.captureWriteGuard?.() ?? (() => true), owner = account();
      if (!current()) fail('adapter session changed');
      const body = recordOrNull(successful(await ctx.soa.post(RecommendEndpoints.CITIES, { contentType: 'json', head: platformHead(ctx.deps.context), queryKeyWord: query, queryNum: 10 }), ctx));
      if (!current() || account() !== owner) fail('account changed during city query');
      if (!Array.isArray(body?.['iMCityInfo'])) fail('city suggestions schema missing');
      return { items: body['iMCityInfo'].map(raw => { const row = recordOrNull(raw), id = row?.['cityId'], name = row?.[ctx.deps.context.locale === 'zh-CN' ? 'cityName' : 'cityEName']; if (!integer(id) || id < 0 || !nonempty(name)) return fail('city suggestion identity or localized name missing'); return { id, name }; }) };
    },
    send(args: unknown): Promise<UiRecommendSend> {
      const a = recordOrNull(args) ?? {};
      let gid: string, selected: Selection, card: ProductCardRequest, key: string;
      try {
        gid = text(a, 'gid'); const token = text(a, 'selection_token'), id = text(a, 'product_id');
        const entry = selections.get(token); if (!entry) fail('product selection missing; reload products');
        selected = entry; ensure(gid, selected);
        const cached = selected.cards.get(id); if (!cached) fail('product is not sendable from this selection'); card = cached;
        key = JSON.stringify([selected.scope.account, selected.scope.identity, selected.scope.epoch, id]);
        const prior = writes.get(key); if (prior) return prior;
        if (writes.size >= 4096) fail('product send journal full; reload adapter');
      } catch (error) { return Promise.resolve({ kind: 'not_submitted', confirmed: false, reason: error instanceof Error ? error.message : 'invalid product selection' }); }
      let started = false;
      const attempt = (async (): Promise<UiRecommendSend> => {
        const body = successful(await ctx.soa.post(LATEST_CONVERSATION, { head: businessHead(ctx.deps.context), gid }), ctx);
        ensure(gid, selected);
        if (!isBizSuccess(body)) fail('fresh conversation read rejected');
        const fresh = recordOrNull(recordOrNull(body)?.['conversation']);
        if (!fresh || identity(fresh) !== selected.scope.identity || state(fresh) !== selected.scope.status || !active(fresh)) fail('fresh conversation identity or state changed');
        ensure(gid, selected);
        started = true;
        const result = await sendProductCard(ctx.deps, ctx.soa, card);
        if (result.kind === 'confirmed' && nonempty(result.localId) && nonempty(result.msgId)) return { kind: 'confirmed', confirmed: true, local_id: result.localId, message_id: result.msgId };
        if (result.kind === 'confirmed' || result.kind === 'unknown' || (result.kind === 'rejected' && result.outcome.kind !== 'business_failure' && result.outcome.kind !== 'auth_invalid')) return { kind: 'unknown', confirmed: false, reason: 'product card outcome unknown; do not resend' };
        return { kind: 'not_submitted', confirmed: false, reason: 'product card rejected by server' };
      })().catch((error: unknown): UiRecommendSend => {
        return { kind: started ? 'unknown' : 'not_submitted', confirmed: false, reason: started ? 'product card outcome unknown; do not resend' : error instanceof Error ? error.message : 'conversation validation failed' };
      }).then(result => {
        // Explicit refusal/rejection permits a new user attempt after refresh.
        // Confirmed and unknown outcomes remain lifetime tombstones.
        if (result.kind === 'not_submitted') writes.delete(key);
        return result;
      });
      writes.set(key, attempt);
      return attempt;
    },
  };
}
