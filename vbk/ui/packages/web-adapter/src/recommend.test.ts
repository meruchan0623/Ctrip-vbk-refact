import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRecommendRpc, RECOMMEND_SELECTION_TTL_MS } from './recommend.ts';
import { createRpc, type RpcContext } from './rpc.ts';
import { ConversationStore, RoleBook } from './stores.ts';
import { SoaClient } from './soa.ts';
import { FakePageSdk, OK_STATUS, FAILURE_STATUS, makeDeps, sampleRow, jsonResponse, flush, type FetchScript } from './testing.ts';

const GID = '123456';
const PRICE = 'key_v2_api_product_recommend_price';
const product = (id = 1, name = 'agent product') => ({ productId: id, providerId: 'provider-1', productName: name, productImageUrl: 'https://images.ctrip.com/product.jpg', jumpUrl: 'https://www.trip.com/product?foo=bar#detail', departureCity: 'Shanghai', destinationCity: 'Tokyo', recommendProductExtList: [{ extendInfoKey: PRICE, extendInfoName: 'From', extendInfoValue: '123' }] });
const response = (extra: Record<string, unknown> = {}) => ({ ResponseStatus: OK_STATUS, hasRecommendProductPrivilege: true, bizType: 1513, cardTemplateId: 'template', currency: 'HKD', customerLocale: 'en-HK', totalNum: 1, recommendProductList: [product()], customerRecommendProductList: [product(1, 'customer product')], ...extra });
function setup(extra: Record<string, unknown> = {}, custom?: (call: Parameters<FetchScript>[0], index: number) => ReturnType<FetchScript> | undefined) {
  let readRow = sampleRow(GID), queryBody = response(extra), live = true;
  const base = makeDeps((call, index) => {
    if (custom) { const r = custom(call, index); if (r !== undefined) return r; }
    if (call.url.includes('queryRecommendProductList')) return jsonResponse(queryBody);
    if (call.url.includes('getLatestConversationByGid')) return jsonResponse({ ResponseStatus: OK_STATUS, bizResponseStatus: { resultCode: 'SUCCESS' }, conversation: readRow });
    if (call.url.includes('queryIMSuggestCityList')) return jsonResponse({ ResponseStatus: OK_STATUS, iMCityInfo: [{ cityId: 2, cityName: '上海', cityEName: 'Shanghai' }] });
    return jsonResponse({ ResponseStatus: OK_STATUS, data: { localId: 'local-1', msgId: 'message-1' } });
  });
  const sdk = new FakePageSdk(), deps = { ...base, sdk, context: { ...base.context } }, store = new ConversationStore(); store.update([readRow]);
  const ctx: RpcContext = { deps, soa: new SoaClient(deps), sdk, store, roles: new RoleBook('agent'), agent: { current: () => null, set: () => undefined }, pushFact: () => undefined, pushDisplay: () => undefined, captureWriteGuard: () => () => live };
  const rpc = createRecommendRpc(ctx);
  const query = (page_index = 0, args: Record<string, unknown> = {}) => rpc.query({ gid: GID, query: '', page_index, ...args });
  return { base, ctx, rpc, store, query, setReadRow: (row: Record<string, unknown>) => { readRow = row; }, setQueryBody: (body: ReturnType<typeof response>) => { queryBody = body; }, invalidate: () => { live = false; } };
}
const selectionSend = (selection_token: string) => ({ gid: GID, selection_token, product_id: '1' });

test('query uses sampled native parameters and returns a narrow DTO', async () => {
  const { query, base } = setup(); const result = await query(0, { query: 'island', departure_city_id: 2, destination_city_id: 3 });
  const body = base.fakeFetch.calls[0]?.bodyJson as Record<string, unknown>;
  assert.deepEqual(body, { contentType: 'json', head: { cid: '{{cid}}', ctok: '', cver: '1.0', lang: '01', sid: '{{sid}}', syscode: '09', auth: '', xsid: '', extension: [] }, groupId: GID, locale: 'zh-CN', queryValue: 'island', departureCityId: 2, destinationCityId: 3, pageIndex: 0, pageSize: 10 });
  assert.equal(result.items[0]?.name, 'agent product'); assert.equal(result.items[0]?.sendable, true); assert.equal(result.has_more, false);
  assert.equal('providerId' in result.items[0]!, false); assert.equal('card' in result.items[0]!, false);
});

test('1513/2384 send customer language, names, currency and recommend=1 without UI card overrides', async () => {
  for (const bizType of [1513, 2384]) {
    const { query, rpc, base } = setup({ bizType }); const list = await query();
    const sent = await rpc.send({ ...selectionSend(list.selection_token), card: { productName: 'injected' }, uid: 'attacker' });
    assert.equal(sent.kind, 'confirmed'); assert.equal(sent.message_id, 'message-1');
    const body = base.fakeFetch.calls.find(c => c.url.includes('sendCardMessageForOffline'))?.bodyJson as Record<string, unknown>;
    assert.equal(body['uid'], `cust-${GID}`); assert.equal(body['groupIdentity'], 'provider-1'); assert.equal(body['bizType'], bizType);
    assert.equal(body['templateId'], 'template'); assert.equal(body['inSession'], true); assert.equal(body['senderRole'], 'Advisor'); assert.equal(body['platformId'], 0);
    const card = JSON.parse(body['extendJson'] as string); assert.equal(card.productName, 'customer product'); assert.equal(card[PRICE], 'HKD123'); assert.equal(card[`${PRICE}_name`], 'From');
    assert.equal(new URL(card.jumpUrl).searchParams.get('recommend'), '1'); assert.equal(new URL(card.jumpUrl).hash, '#detail');
  }
});

test('2508/2510 use related customer identity and ordinary products', async () => {
  for (const bizType of [2508, 2510]) {
    const { query, rpc, base } = setup({ bizType, relatedCustomerUid: 'related', customerRecommendProductList: [] }); const list = await query();
    assert.equal((await rpc.send(selectionSend(list.selection_token))).kind, 'confirmed');
    const body = base.fakeFetch.calls.at(-1)?.bodyJson as Record<string, unknown>;
    assert.equal(body['groupIdentity'], 'related'); assert.equal(JSON.parse(body['extendJson'] as string).productName, 'agent product');
  }
});

test('missing template, customer product, language, currency, related identity and conflicting extension fail closed', async () => {
  for (const extra of [{ cardTemplateId: '' }, { customerRecommendProductList: [] }, { customerLocale: '' }, { currency: '' }, { bizType: 2508, relatedCustomerUid: null }, { customerRecommendProductList: [{ ...product(), recommendProductExtList: [{ extendInfoKey: 'jumpUrl', extendInfoValue: 'https://evil.test', extendInfoName: 'name' }] }] }]) {
    const { query, rpc, base } = setup(extra); const list = await query(); assert.equal(list.items[0]?.sendable, false); assert.ok(list.items[0]?.unavailable_reason);
    assert.equal((await rpc.send(selectionSend(list.selection_token))).kind, 'not_submitted'); assert.equal(base.fakeFetch.calls.length, 1);
  }
});

test('explicit forbidden remains distinct from empty authorized results and malformed permission', async () => {
  const denied = await setup({ hasRecommendProductPrivilege: false }).query(); assert.equal(denied.kind, 'forbidden'); assert.equal(denied.selection_token, '');
  const empty = await setup({ recommendProductList: [], totalNum: 0 }).query(); assert.equal(empty.kind, 'ready'); assert.deepEqual(empty.items, []);
  await assert.rejects(setup({ hasRecommendProductPrivilege: undefined }).query(), /permission/);
});

test('pagination counts actual results, continues five-item special pages, and ends partial final pages', async () => {
  const { query, setQueryBody } = setup({ recommendProductList: Array.from({ length: 5 }, (_, i) => product(i + 1)), totalNum: 11 });
  assert.equal((await query()).has_more, true);
  assert.equal((await query(1)).has_more, true);
  setQueryBody(response({ recommendProductList: [product()], totalNum: 11 })); assert.equal((await query(2)).has_more, false);
  setQueryBody(response({ recommendProductList: [], totalNum: 11 })); assert.equal((await query(3)).has_more, false);
});

test('cities maps statically verified localized city fields and exact parameters', async () => {
  const { rpc, base } = setup(); assert.deepEqual(await rpc.cities({ query: 'sh' }), { items: [{ id: 2, name: '上海' }] });
  const body = base.fakeFetch.calls[0]?.bodyJson as Record<string, unknown>; assert.equal(body['queryKeyWord'], 'sh'); assert.equal(body['queryNum'], 10);
});

test('malformed city fields are rejected without guessed identity or names', async () => {
  const x = setup({}, () => jsonResponse({ ResponseStatus: OK_STATUS, iMCityInfo: [{ id: 2, name: 'Shanghai' }] }));
  await assert.rejects(x.rpc.cities({ query: 'sh' }), /city suggestion identity/);
});

test('expired and forged product selections submit nothing', async () => {
  const { query, rpc, base } = setup(); const list = await query(); await base.clock.advance(RECOMMEND_SELECTION_TTL_MS);
  assert.equal((await rpc.send(selectionSend(list.selection_token))).kind, 'not_submitted');
  assert.equal((await rpc.send(selectionSend('forged'))).kind, 'not_submitted'); assert.equal(base.fakeFetch.calls.length, 1);
});

test('concurrent duplicate sends share one validation and one submission', async () => {
  const { query, rpc, base } = setup(); const list = await query(); const args = selectionSend(list.selection_token);
  const first = rpc.send(args), second = rpc.send(args); assert.equal(first, second); assert.equal((await first).kind, 'confirmed');
  assert.equal(base.fakeFetch.calls.filter(c => c.url.includes('sendCardMessageForOffline')).length, 1);
});

test('unknown sends remain tombstoned across new selections', async () => {
  const { query, rpc, base } = setup({}, call => call.url.includes('sendCardMessageForOffline') ? 'hang' : undefined);
  const list = await query(); const p = rpc.send(selectionSend(list.selection_token)); await flush(); await base.clock.advance(15000); assert.equal((await p).kind, 'unknown');
  const next = await query(); assert.equal((await rpc.send(selectionSend(next.selection_token))).kind, 'unknown');
  assert.equal(base.fakeFetch.calls.filter(c => c.url.includes('sendCardMessageForOffline')).length, 1);
});

test('fresh full identity changes and finished state refuse the card', async () => {
  for (const changed of [{ sessionId: 'new-session' }, { uid: 'other-customer' }, { conversationKey: 'new-key' }, { threadId: 'new-thread' }, { status: 4 }, { inGroup: -1 }]) {
    const { query, rpc, setReadRow, base } = setup(); const list = await query(); setReadRow(sampleRow(GID, changed));
    assert.equal((await rpc.send(selectionSend(list.selection_token))).kind, 'not_submitted'); assert.equal(base.fakeFetch.calls.length, 2);
  }
});

test('cache A to B to A epoch and account/lifecycle changes revoke selections', async () => {
  for (const mode of ['epoch', 'account', 'lifecycle']) {
    const { query, rpc, store, ctx, invalidate, base } = setup(); const list = await query();
    if (mode === 'epoch') { store.update([sampleRow(GID, { sessionId: 'B' })]); store.update([sampleRow(GID)]); }
    if (mode === 'account') (ctx.deps.context as { cid: string }).cid = 'changed';
    if (mode === 'lifecycle') invalidate();
    assert.equal((await rpc.send(selectionSend(list.selection_token))).kind, 'not_submitted'); assert.equal(base.fakeFetch.calls.length, 1);
  }
});

test('async conversation change while validating prevents submission', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const { query, rpc, store, base } = setup({}, call => call.url.includes('getLatestConversationByGid') ? gate.then(() => jsonResponse({ ResponseStatus: OK_STATUS, bizResponseStatus: { resultCode: 'SUCCESS' }, conversation: sampleRow(GID) })) : undefined);
  const list = await query(); const pending = rpc.send(selectionSend(list.selection_token)); await flush(); store.update([sampleRow(GID, { sessionId: 'changed' })]); release();
  assert.equal((await pending).kind, 'not_submitted'); assert.equal(base.fakeFetch.calls.length, 2);
});

test('malformed write success and transport errors remain unknown, explicit rejection permits another attempt', async () => {
  for (const reply of [jsonResponse({ ResponseStatus: OK_STATUS, data: {} }), jsonResponse({ ResponseStatus: OK_STATUS, data: { localId: '', msgId: '' } }), new Error('network'), jsonResponse({ ResponseStatus: FAILURE_STATUS })]) {
    const { query, rpc, base } = setup({}, call => call.url.includes('sendCardMessageForOffline') ? reply : undefined);
    const list = await query(); const args = selectionSend(list.selection_token); const result = await rpc.send(args);
    assert.equal(result.kind, reply instanceof Error || 'data' in JSON.parse(await reply.text()) ? 'unknown' : 'not_submitted');
    await rpc.send(args); assert.equal(base.fakeFetch.calls.filter(c => c.url.includes('sendCardMessageForOffline')).length, result.kind === 'not_submitted' ? 2 : 1);
  }
});

test('query does not publish a selection after an asynchronous conversation change', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const { query, store } = setup({}, call => call.url.includes('queryRecommendProductList') ? gate.then(() => jsonResponse(response())) : undefined);
  const pending = query(); await flush(); store.update([sampleRow(GID, { uid: 'other' })]); release(); await assert.rejects(pending, /conversation changed/);
});

test('missing raw session fields and unsafe product IDs cannot create a sendable option', async () => {
  for (const missing of [{ threadId: undefined }, { sessionId: null }, { id: Number.MAX_SAFE_INTEGER + 1 }, { status: undefined }]) {
    const { query, store } = setup(); store.update([sampleRow(GID, missing)]); await assert.rejects(query(), /conversation/);
  }
  await assert.rejects(setup({ recommendProductList: [product(Number.MAX_SAFE_INTEGER + 1)] }).query(), /product identity/);
});

test('city locale uses English source fields outside zh-CN and does not substitute guessed names', async () => {
  const { rpc, ctx } = setup(); (ctx.deps.context as { locale: string }).locale = 'en-HK';
  assert.deepEqual(await rpc.cities({ query: 'sh' }), { items: [{ id: 2, name: 'Shanghai' }] });
});

test('selection tokens cannot cross adapter instances with identical clock and random dependencies', async () => {
  const first = setup(), second = setup(); const one = await first.query(), two = await second.query();
  assert.notEqual(one.selection_token, two.selection_token);
  assert.equal((await second.rpc.send(selectionSend(one.selection_token))).kind, 'not_submitted');
});

test('real RPC permits a refreshed selection after preflight failure or explicit card rejection', async () => {
  for (const failedStep of ['preflight', 'card']) {
    let failed = false;
    const { ctx, base } = setup({}, call => {
      const target = failedStep === 'preflight' ? 'getLatestConversationByGid' : 'sendCardMessageForOffline';
      if (!failed && call.url.includes(target)) { failed = true; return jsonResponse({ ResponseStatus: FAILURE_STATUS }); }
      return undefined;
    });
    const rpc = createRpc(ctx);
    let sequence = 0;
    const query = async () => {
      const reply = await rpc.handle({ req_id: `query-${++sequence}`, op: 'im.recommend_products', args: { gid: GID, query: '', page_index: 0 } });
      assert.ok(reply?.ok); return (reply.data as { selection_token: string }).selection_token;
    };
    const send = async (token: string) => {
      const reply = await rpc.handle({ req_id: `send-${++sequence}`, op: 'im.send_product_card', args: selectionSend(token) });
      assert.ok(reply?.ok); return reply.data as { kind: string };
    };
    const oldToken = await query(); assert.equal((await send(oldToken)).kind, 'not_submitted');
    const nextToken = await query(); assert.notEqual(nextToken, oldToken);
    assert.equal((await send(nextToken)).kind, 'confirmed');
    assert.equal(base.fakeFetch.calls.filter(c => c.url.includes('getLatestConversationByGid')).length, 2);
    assert.equal(base.fakeFetch.calls.filter(c => c.url.includes('sendCardMessageForOffline')).length, failedStep === 'preflight' ? 1 : 2);
    // Confirmation still blocks a third attempt, including a fresh query token.
    assert.equal((await send(await query())).kind, 'confirmed');
    assert.equal(base.fakeFetch.calls.filter(c => c.url.includes('getLatestConversationByGid')).length, 2);
  }
});
