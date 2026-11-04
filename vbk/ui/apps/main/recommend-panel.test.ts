import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRecommendPanel, nearRecommendEnd, recommendCountText, shouldAutoFill, visibleRecommendProducts, type RecommendState } from './recommend-panel.ts';
import type { ReplyScope } from './quick-replies.ts';
import { UiCommands } from '../../packages/ipc/src/client.ts';
import type { UiRecommendProducts } from '../../packages/ipc/src/recommend.ts';

const city = { id: 2, name: '上海' };
const products = (page = 0, expires = 1000): UiRecommendProducts => ({ kind: 'ready', items: [{ id: 'p1', name: '行程', image_url: '', departure_city: '上海', destination_city: '北京', detail_url: '', price_text: '100', sendable: true }], page_index: page, has_more: page === 0, total: 2, selection_token: `token-${page}`, expires_at_ms: expires });
function deferred() { let resolve!: (value: unknown) => void; return { promise: new Promise<unknown>(r => { resolve = r; }), resolve }; }
function fixture() {
  let scope: ReplyScope = { account: { account_id: 'a', environment: 'synthetic', session_generation: 1 }, gid: 'chat-a', revision: 'visit-1' };
  let state: RecommendState | null = null, now = 0, canSend = true;
  const calls: { command: string; payload: unknown }[] = [], refreshed: ReplyScope[] = [], queue = new Map<string, unknown[]>();
  const controller = createRecommendPanel({ current: () => scope, canSend: () => canSend, now: () => now, publish: value => { state = value; }, refresh: async value => { refreshed.push(value); },
    async invoke(command, payload) { calls.push({ command, payload }); const value = await (queue.get(command)?.shift() ?? (command === UiCommands.IM_RECOMMEND_PRODUCTS ? products((payload as { page_index: number }).page_index) : command === UiCommands.IM_RECOMMEND_CITIES ? { items: [city] } : { kind: 'confirmed', confirmed: true })); if (value instanceof Error) throw value; return value; },
  });
  return { controller, calls, refreshed, get state() { return state; }, get scope() { return scope; }, patch(patch: Partial<ReplyScope>) { scope = { ...scope, ...patch }; }, time(value: number) { now = value; }, permit(value: boolean) { canSend = value; }, queue(command: string, value: unknown) { queue.set(command, [...queue.get(command) ?? [], value]); }, count(command: string) { return calls.filter(c => c.command === command).length; } };
}

test('product queries use trimmed filters, explicit city candidates and requested page', async () => {
  const f = fixture(); await f.controller.open(); assert.equal(f.state?.result?.page_index, 0);
  f.controller.query('  行程  '); f.controller.cityText('departure', '上海'); await f.controller.search();
  assert.match(f.state?.error ?? '', /城市候选/); assert.equal(f.count(UiCommands.IM_RECOMMEND_PRODUCTS), 1);
  await f.controller.findCities('departure'); assert.deepEqual(f.state?.cities, [city]);
  assert.deepEqual(f.calls.at(-1)?.payload, { account: f.scope.account, query: '上海' });
  f.controller.chooseCity('departure', { id: 999, name: '伪造城市' }); assert.equal(f.state?.departure, null);
  f.controller.chooseCity('departure', city); assert.deepEqual(f.state?.departure, city); assert.deepEqual(f.state?.cities, []);
  await f.controller.search(1); assert.deepEqual(f.calls.at(-1)?.payload, { account: f.scope.account, gid: 'chat-a', query: '行程', departure_city_id: 2, destination_city_id: -1, page_index: 1 });
  assert.equal(f.state?.result?.page_index, 1); assert.equal(f.state?.result?.has_more, false);
  f.controller.chooseCity('departure', null); assert.equal(f.state?.result, null); assert.equal(f.state?.departureText, '');
});

test('changing filters clears old results and rejects in-flight product and city responses', async () => {
  for (const change of ['query', 'city']) {
    const f = fixture(); await f.controller.open(); const pending = deferred(); f.queue(UiCommands.IM_RECOMMEND_PRODUCTS, pending.promise); const old = f.controller.search();
    if (change === 'query') f.controller.query('new'); else f.controller.cityText('destination', '北京');
    assert.equal(f.state?.result, null); pending.resolve(products()); await old; assert.equal(f.state?.result, null); assert.equal(f.state?.busy, false);
    await f.controller.send('p1'); assert.equal(f.count(UiCommands.IM_SEND_PRODUCT_CARD), 0);
  }
  const f = fixture(); await f.controller.open(); f.controller.cityText('departure', '上'); const pending = deferred(); f.queue(UiCommands.IM_RECOMMEND_CITIES, pending.promise); const old = f.controller.findCities('departure');
  f.controller.cityText('departure', '北京'); pending.resolve({ items: [city] }); await old; assert.deepEqual(f.state?.cities, []); assert.equal(f.state?.cityBusy, false);
});

test('conversation, revision and account changes discard late query/city results and prevent sends', async () => {
  for (const patch of [{ gid: 'chat-b' }, { revision: 'visit-2' }, { account: { account_id: 'b', environment: 'synthetic', session_generation: 1 } }]) {
    const f = fixture(), pending = deferred(); f.queue(UiCommands.IM_RECOMMEND_PRODUCTS, pending.promise); const old = f.controller.open(); const expected = f.state;
    f.patch(patch); pending.resolve(products()); await old; assert.equal(f.state, expected); await f.controller.send('p1'); assert.equal(f.count(UiCommands.IM_SEND_PRODUCT_CARD), 0);
    await f.controller.open(); f.controller.cityText('departure', '上海'); const cities = deferred(); f.queue(UiCommands.IM_RECOMMEND_CITIES, cities.promise); const lookup = f.controller.findCities('departure');
    f.patch({ revision: 'another-visit' }); const searching = f.state; cities.resolve({ items: [city] }); await lookup; assert.equal(f.state, searching);
  }
});

test('an expired selection refreshes in the background and the same click sends an unchanged product', async () => {
  const f = fixture(); f.queue(UiCommands.IM_RECOMMEND_PRODUCTS, products(1, 10)); await f.controller.open(); f.time(10);
  await f.controller.send('p1');
  assert.equal(f.count(UiCommands.IM_RECOMMEND_PRODUCTS), 2); assert.equal(f.count(UiCommands.IM_SEND_PRODUCT_CARD), 1); assert.equal(f.state?.result?.page_index, 1);
  assert.equal((f.calls.at(-1)?.payload as { selection_token: string }).selection_token, 'token-1'); assert.equal(f.state?.error, null); assert.equal(f.state?.preparing, null);
  assert.equal(f.state?.writes.p1?.kind, 'confirmed'); assert.equal(f.refreshed.length, 1);
});

test('a refresh that changes any visible field or drops the product requires a new explicit send', async () => {
  const base = products().items[0]!;
  const changes: Partial<typeof base>[] = [{ name: '新名称' }, { image_url: 'https://x/new.png' }, { departure_city: '杭州' }, { destination_city: '东京' }, { detail_url: 'https://x/new' }, { price_text: '200' }, { sendable: false }];
  for (const change of changes) {
    const f = fixture(); f.queue(UiCommands.IM_RECOMMEND_PRODUCTS, products(0, 10)); await f.controller.open(); f.time(10);
    f.queue(UiCommands.IM_RECOMMEND_PRODUCTS, { ...products(0, 1000), items: [{ ...base, ...change }] }); await f.controller.send('p1');
    assert.equal(f.count(UiCommands.IM_SEND_PRODUCT_CARD), 0, JSON.stringify(change)); assert.match(f.state?.error ?? '', /再次选择/); assert.equal(f.state?.preparing, null);
    if (change.sendable !== false) { await f.controller.send('p1'); assert.equal(f.count(UiCommands.IM_SEND_PRODUCT_CARD), 1, '第二次点击针对的是新内容'); }
  }
  const f = fixture(); f.queue(UiCommands.IM_RECOMMEND_PRODUCTS, products(0, 10)); await f.controller.open(); f.time(10);
  f.queue(UiCommands.IM_RECOMMEND_PRODUCTS, { ...products(0, 1000), items: [] }); await f.controller.send('p1');
  assert.equal(f.count(UiCommands.IM_SEND_PRODUCT_CARD), 0); assert.match(f.state?.error ?? '', /再次选择/);
});

test('a background refresh does not send after permission loss or a condition change', async () => {
  const f = fixture(); f.queue(UiCommands.IM_RECOMMEND_PRODUCTS, products(0, 10)); await f.controller.open(); f.time(10);
  const lost = deferred(); f.queue(UiCommands.IM_RECOMMEND_PRODUCTS, lost.promise); const first = f.controller.send('p1'); assert.equal(f.state?.preparing, 'p1');
  f.permit(false); lost.resolve(products()); await first; assert.equal(f.count(UiCommands.IM_SEND_PRODUCT_CARD), 0); assert.equal(f.state?.preparing, null);
  f.permit(true); f.queue(UiCommands.IM_RECOMMEND_PRODUCTS, products(0, 10)); await f.controller.search();
  const pending = deferred(); f.queue(UiCommands.IM_RECOMMEND_PRODUCTS, pending.promise); const second = f.controller.send('p1');
  f.controller.query('new'); assert.equal(f.state?.preparing, null); pending.resolve(products()); await second; assert.equal(f.count(UiCommands.IM_SEND_PRODUCT_CARD), 0); assert.equal(f.state?.result, null);
});

test('an expired product with a recorded attempt is neither refreshed nor resent', async () => {
  const f = fixture(); f.queue(UiCommands.IM_RECOMMEND_PRODUCTS, products(0, 10)); await f.controller.open();
  f.queue(UiCommands.IM_SEND_PRODUCT_CARD, { kind: 'unknown', confirmed: false }); await f.controller.send('p1'); f.time(10);
  await f.controller.send('p1'); assert.equal(f.count(UiCommands.IM_RECOMMEND_PRODUCTS), 1); assert.equal(f.count(UiCommands.IM_SEND_PRODUCT_CARD), 1);
});

test('double clicks are single-flight and unknown outcomes remain blocked after close/reopen', async () => {
  for (const outcome of [{ kind: 'unknown', confirmed: false }, { kind: 'accepted', confirmed: false }, new Error('connection lost')]) {
    const f = fixture(); await f.controller.open(); const pending = deferred(); f.queue(UiCommands.IM_SEND_PRODUCT_CARD, pending.promise);
    const first = f.controller.send('p1'); await f.controller.send('p1'); assert.equal(f.count(UiCommands.IM_SEND_PRODUCT_CARD), 1);
    f.controller.close(); await f.controller.open(); await f.controller.send('p1'); assert.equal(f.count(UiCommands.IM_SEND_PRODUCT_CARD), 1);
    pending.resolve(outcome); await first; await f.controller.open(); assert.equal(f.state?.writes.p1?.kind, 'unknown'); await f.controller.send('p1'); assert.equal(f.count(UiCommands.IM_SEND_PRODUCT_CARD), 1); assert.equal(f.refreshed.length, 0);
  }
});

test('not_submitted can be corrected and retried; confirmed refreshes history and stays blocked', async () => {
  const f = fixture(); await f.controller.open(); f.queue(UiCommands.IM_SEND_PRODUCT_CARD, { kind: 'not_submitted', confirmed: false, reason: '请修正条件' });
  await f.controller.send('p1'); assert.equal(f.state?.writes.p1?.kind, 'not_submitted'); assert.equal(f.refreshed.length, 0);
  f.controller.query('corrected'); await f.controller.search(); await f.controller.send('p1');
  assert.equal(f.count(UiCommands.IM_SEND_PRODUCT_CARD), 2); assert.equal(f.state?.writes.p1?.kind, 'confirmed'); assert.deepEqual(f.refreshed, [f.scope]);
  assert.deepEqual(f.calls.filter(c => c.command === UiCommands.IM_SEND_PRODUCT_CARD).at(-1)?.payload, { account: f.scope.account, gid: 'chat-a', selection_token: 'token-0', product_id: 'p1' });
  await f.controller.send('p1'); await f.controller.open(); await f.controller.send('p1'); assert.equal(f.count(UiCommands.IM_SEND_PRODUCT_CARD), 2);
});

test('permission, forbidden and unavailable products cannot send', async () => {
  const f = fixture(); await f.controller.open(); f.permit(false); await f.controller.send('p1'); assert.equal(f.count(UiCommands.IM_SEND_PRODUCT_CARD), 0);
  f.permit(true); f.queue(UiCommands.IM_RECOMMEND_PRODUCTS, { ...products(), kind: 'forbidden' }); await f.controller.search(); await f.controller.send('p1');
  f.queue(UiCommands.IM_RECOMMEND_PRODUCTS, { ...products(), items: products().items.map(p => ({ ...p, sendable: false })) }); await f.controller.search(); await f.controller.send('p1'); assert.equal(f.count(UiCommands.IM_SEND_PRODUCT_CARD), 0);
});

test('expired refresh cannot annotate a reopened panel for a different conversation', async () => {
  const f = fixture(); f.queue(UiCommands.IM_RECOMMEND_PRODUCTS, products(0, 10)); await f.controller.open(); f.time(10);
  const pending = deferred(); f.queue(UiCommands.IM_RECOMMEND_PRODUCTS, pending.promise); const old = f.controller.send('p1');
  f.controller.close(); f.patch({ gid: 'chat-b', revision: 'visit-2' }); await f.controller.open(); const expected = f.state;
  pending.resolve(products()); await old; assert.equal(f.state, expected); assert.equal(f.count(UiCommands.IM_SEND_PRODUCT_CARD), 0);
});


test('local filters combine words, preserve selection and original ordering, and exclude blocked sends', async () => {
  const f = fixture();
  const base = products().items[0]!;
  const items = [
    { ...base, id: '2', name: 'eSIM 20天', destination_city: '香港' },
    { ...base, id: '1', name: 'eSIM 3天', destination_city: '香港' },
    { ...base, id: '3', name: 'eSIM 5天', destination_city: '日本', sendable: false },
  ];
  f.queue(UiCommands.IM_RECOMMEND_PRODUCTS, { ...products(), items });
  await f.controller.open(); const original = f.state!.result;
  f.controller.filter({ text: '  ESIM 香港  ', sort: 'name' });
  assert.deepEqual(visibleRecommendProducts(f.state!).map(p => p.id), ['1', '2']);
  assert.equal(f.state!.result, original); assert.deepEqual(original!.items.map(p => p.id), ['2', '1', '3']);
  assert.equal(f.count(UiCommands.IM_RECOMMEND_PRODUCTS), 1);
  await f.controller.send('1');
  f.controller.filter({ text: '', sendableOnly: true });
  assert.deepEqual(visibleRecommendProducts(f.state!).map(p => p.id), ['2']);
  f.controller.filter({ text: 'missing' }); assert.equal(visibleRecommendProducts(f.state!).length, 0);
  assert.equal(f.state!.result!.has_more, true);
});

test('reset clears all conditions and ignores an older city lookup', async () => {
  const f = fixture(); await f.controller.open();
  f.controller.query('old'); f.controller.filter({ text: 'local', sort: 'name', sendableOnly: true });
  f.controller.cityText('departure', '上海');
  const pending = deferred(); f.queue(UiCommands.IM_RECOMMEND_CITIES, pending.promise);
  const lookup = f.controller.findCities('departure');
  await f.controller.reset(); pending.resolve({ items: [city] }); await lookup;
  assert.equal(f.state!.query, ''); assert.equal(f.state!.departureText, '');
  assert.deepEqual(f.state!.filters, { text: '', sort: 'default', sendableOnly: false });
  assert.deepEqual(f.state!.cities, []); assert.equal(f.state!.cityBusy, false);
  assert.equal(f.state!.result!.page_index, 0);
  assert.deepEqual(f.calls.at(-1)!.payload, { account: f.scope.account, gid: 'chat-a', query: '', departure_city_id: -1, destination_city_id: -1, page_index: 0 });
});

const paged = (page: number, ids: readonly string[], hasMore: boolean, expires = 1000): UiRecommendProducts => ({ ...products(page, expires), items: ids.map(id => ({ ...products().items[0]!, id, name: `产品${id}` })), has_more: hasMore, total: 5, selection_token: `token-${page}` });
async function twoPages(f: ReturnType<typeof fixture>, firstExpires = 1000) {
  f.queue(UiCommands.IM_RECOMMEND_PRODUCTS, paged(0, ['a', 'b'], true, firstExpires)); await f.controller.open();
  f.queue(UiCommands.IM_RECOMMEND_PRODUCTS, paged(1, ['c', 'd'], true)); await f.controller.loadMore();
}

test('loadMore appends the next page with the applied conditions and drops products repeated across pages', async () => {
  const f = fixture(); f.queue(UiCommands.IM_RECOMMEND_PRODUCTS, paged(0, ['a', 'b'], true)); await f.controller.open();
  f.controller.query('  行程 '); f.queue(UiCommands.IM_RECOMMEND_PRODUCTS, paged(0, ['a', 'b'], true)); await f.controller.search();
  f.queue(UiCommands.IM_RECOMMEND_PRODUCTS, paged(1, ['b', 'c'], false)); await f.controller.loadMore();
  assert.deepEqual(f.calls.at(-1)?.payload, { account: f.scope.account, gid: 'chat-a', query: '行程', departure_city_id: -1, destination_city_id: -1, page_index: 1 });
  assert.deepEqual(f.state!.result!.items.map(p => p.id), ['a', 'b', 'c']); assert.equal(f.state!.result!.page_index, 1);
  const count = f.count(UiCommands.IM_RECOMMEND_PRODUCTS); await f.controller.loadMore(); assert.equal(f.count(UiCommands.IM_RECOMMEND_PRODUCTS), count, 'has_more=false 不再请求');
});

test('loadMore is single-flight, waits for a running send and never starts without results', async () => {
  const f = fixture(); f.queue(UiCommands.IM_RECOMMEND_PRODUCTS, paged(0, ['a'], true)); await f.controller.open();
  const pending = deferred(); f.queue(UiCommands.IM_RECOMMEND_PRODUCTS, pending.promise); const first = f.controller.loadMore(); await f.controller.loadMore();
  assert.equal(f.count(UiCommands.IM_RECOMMEND_PRODUCTS), 2); assert.equal(f.state!.loadingMore, true); pending.resolve(paged(1, ['b'], true)); await first; assert.equal(f.state!.loadingMore, false);
  const sending = deferred(); f.queue(UiCommands.IM_SEND_PRODUCT_CARD, sending.promise); const send = f.controller.send('a');
  await f.controller.loadMore(); assert.equal(f.count(UiCommands.IM_RECOMMEND_PRODUCTS), 2);
  sending.resolve({ kind: 'confirmed', confirmed: true }); await send; assert.equal(f.state!.sending, null);
  f.controller.query('new'); await f.controller.loadMore(); assert.equal(f.count(UiCommands.IM_RECOMMEND_PRODUCTS), 2);
});

test('a send started during loadMore keeps its result and both finish', async () => {
  const f = fixture(); f.queue(UiCommands.IM_RECOMMEND_PRODUCTS, paged(0, ['a'], true)); await f.controller.open();
  const page = deferred(), sent = deferred(); f.queue(UiCommands.IM_RECOMMEND_PRODUCTS, page.promise); f.queue(UiCommands.IM_SEND_PRODUCT_CARD, sent.promise);
  const more = f.controller.loadMore(), send = f.controller.send('a');
  page.resolve(paged(1, ['b'], false)); await more; assert.equal(f.state!.sending, 'a'); assert.deepEqual(f.state!.result!.items.map(p => p.id), ['a', 'b']);
  sent.resolve({ kind: 'confirmed', confirmed: true }); await send; assert.equal(f.state!.writes.a?.kind, 'confirmed'); assert.equal(f.state!.sending, null);
});

test('late pages are discarded after the conditions change or the conversation moves', async () => {
  for (const change of ['query', 'city', 'conversation', 'close']) {
    const f = fixture(); f.queue(UiCommands.IM_RECOMMEND_PRODUCTS, paged(0, ['a'], true)); await f.controller.open();
    const pending = deferred(); f.queue(UiCommands.IM_RECOMMEND_PRODUCTS, pending.promise); const more = f.controller.loadMore();
    if (change === 'query') f.controller.query('new'); else if (change === 'city') f.controller.cityText('departure', '北'); else if (change === 'conversation') f.patch({ gid: 'chat-b' }); else f.controller.close();
    const expected = f.state; pending.resolve(paged(1, ['b'], false)); await more; assert.equal(f.state, expected);
    if (change === 'query' || change === 'city') { assert.equal(f.state!.loadingMore, false); assert.equal(f.state!.result, null); }
  }
});

test('send uses the token of the page holding the product', async () => {
  const f = fixture(); await twoPages(f);
  await f.controller.send('a'); assert.equal((f.calls.at(-1)?.payload as { selection_token: string }).selection_token, 'token-0');
  await f.controller.send('c'); assert.equal((f.calls.at(-1)?.payload as { selection_token: string }).selection_token, 'token-1');
});

test('an expired page refreshes in place, keeps other pages and blocks other sends meanwhile', async () => {
  const f = fixture(); await twoPages(f, 10); await f.controller.send('c'); f.time(10);
  const refresh = deferred(); f.queue(UiCommands.IM_RECOMMEND_PRODUCTS, refresh.promise); const old = f.controller.send('a');
  assert.deepEqual(f.state!.result!.items.map(p => p.id), ['a', 'b', 'c', 'd'], '刷新期间列表不清空'); assert.equal(f.state!.busy, true);
  await f.controller.send('d'); assert.equal(f.count(UiCommands.IM_SEND_PRODUCT_CARD), 1, '刷新期间不能发送');
  refresh.resolve(paged(0, ['a', 'x'], true)); await old;
  assert.deepEqual((f.calls.filter(c => c.command === UiCommands.IM_RECOMMEND_PRODUCTS).at(-1)?.payload as { page_index: number }).page_index, 0);
  assert.deepEqual(f.state!.result!.items.map(p => p.id), ['a', 'x', 'c', 'd']); assert.equal(f.state!.result!.page_index, 1, '末页不变');
  assert.equal(f.state!.writes.c?.kind, 'confirmed'); assert.equal(f.state!.writes.a?.kind, 'confirmed'); assert.equal(f.state!.error, null); assert.equal(f.count(UiCommands.IM_SEND_PRODUCT_CARD), 2);
  await f.controller.send('c'); assert.equal(f.count(UiCommands.IM_SEND_PRODUCT_CARD), 2, '已确认的产品不重发');
});

test('a failed refresh keeps the list, reports the failure and does not claim success', async () => {
  const f = fixture(); await twoPages(f, 10); f.time(10);
  f.queue(UiCommands.IM_RECOMMEND_PRODUCTS, new Error('网络失败')); await f.controller.send('a');
  assert.equal(f.state!.error, '网络失败'); assert.equal(f.state!.busy, false); assert.equal(f.state!.result!.items.length, 4); assert.equal(f.count(UiCommands.IM_SEND_PRODUCT_CARD), 0);
});

test('a failed page stops automatic loading until an explicit retry', async () => {
  const f = fixture(); f.queue(UiCommands.IM_RECOMMEND_PRODUCTS, paged(0, ['a'], true)); await f.controller.open();
  f.queue(UiCommands.IM_RECOMMEND_PRODUCTS, new Error('网络失败')); await f.controller.loadMore();
  assert.equal(f.state!.moreError, '网络失败'); assert.equal(f.state!.loadingMore, false); assert.equal(f.state!.result!.items.length, 1); assert.equal(shouldAutoFill(f.state!), false);
  const before = f.count(UiCommands.IM_RECOMMEND_PRODUCTS); await f.controller.loadMore(); assert.equal(f.count(UiCommands.IM_RECOMMEND_PRODUCTS), before);
  f.queue(UiCommands.IM_RECOMMEND_PRODUCTS, paged(1, ['b'], false)); await f.controller.loadMore(true);
  assert.equal(f.state!.moreError, null); assert.deepEqual(f.state!.result!.items.map(p => p.id), ['a', 'b']);
});

test('a page that lost permission replaces the list and blocks sends', async () => {
  const f = fixture(); f.queue(UiCommands.IM_RECOMMEND_PRODUCTS, paged(0, ['a'], true)); await f.controller.open();
  f.queue(UiCommands.IM_RECOMMEND_PRODUCTS, { ...paged(1, [], false), kind: 'forbidden' }); await f.controller.loadMore();
  assert.equal(f.state!.result!.kind, 'forbidden'); assert.equal(f.state!.result!.items.length, 0); await f.controller.send('a'); assert.equal(f.count(UiCommands.IM_SEND_PRODUCT_CARD), 0);
});

test('auto fill only runs on an idle unfiltered list with more pages', async () => {
  const f = fixture(); f.queue(UiCommands.IM_RECOMMEND_PRODUCTS, paged(0, ['a'], true)); await f.controller.open();
  assert.equal(shouldAutoFill(f.state!), true);
  f.controller.filter({ text: '冷门词' }); assert.equal(shouldAutoFill(f.state!), false);
  await f.controller.autoFill(); assert.equal(f.count(UiCommands.IM_RECOMMEND_PRODUCTS), 1, '排队中的补页遇到筛选词就放弃');
  f.controller.filter({ text: '', sendableOnly: true }); assert.equal(shouldAutoFill(f.state!), false);
  f.controller.filter({ sendableOnly: false, sort: 'name' }); assert.equal(shouldAutoFill(f.state!), true);
  f.queue(UiCommands.IM_RECOMMEND_PRODUCTS, paged(1, ['b'], false)); await f.controller.loadMore(); assert.equal(shouldAutoFill(f.state!), false);
});

test('scroll threshold and count text', () => {
  assert.equal(nearRecommendEnd({ scrollTop: 0, clientHeight: 500, scrollHeight: 500 }), true);
  assert.equal(nearRecommendEnd({ scrollTop: 260, clientHeight: 500, scrollHeight: 1000 }), true);
  assert.equal(nearRecommendEnd({ scrollTop: 259, clientHeight: 500, scrollHeight: 1000 }), false);
  const result = paged(0, ['a', 'b'], true);
  assert.equal(recommendCountText(result, 2, false), '已加载 2 / 5 项');
  assert.equal(recommendCountText({ ...result, total: null }, 1, true), '匹配 1 · 已加载 2 项');
});
