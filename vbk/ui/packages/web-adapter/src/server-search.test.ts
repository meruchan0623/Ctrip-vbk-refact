import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRpc } from './rpc.ts';
import { ConversationStore, RoleBook } from './stores.ts';
import { SoaClient } from './soa.ts';
import { SearchError, createServerSearch, serverSearchBody } from './search.ts';
import { FakePageSdk, flush, jsonResponse, makeDeps, OK_STATUS, type FetchScript } from './testing.ts';
import type { UiServerSearchPage, UiSearchHistoryPage, UiServerSearchQuery } from '../../ipc/src/server-search.ts';

const t = 1700000000000;
const accepted = { ResponseStatus: OK_STATUS, bizResponseStatus: { resultCode: 'SUCCESS' } };
const hit = (id = 'm1', gid = '9223372036854775806') => ({ conversation: { gid, conversationType: 'B2C', uid: 'customer', groupTitle: 'Product', lastUpdateTime: t - 1000 }, message: { msgId: id, msgtype: 0, messageBody: 'matched text', createTime: t } });
const query = (extra: Partial<UiServerSearchQuery> = {}): UiServerSearchQuery => ({ query_id: 'q1', search_type: 3, search_value: 'find', page_no: 1, ...extra });

function setup(script: FetchScript) {
  const base = makeDeps(script), sdk = new FakePageSdk(), deps = { ...base, sdk };
  const store = new ConversationStore(), roles = new RoleBook('me');
  let current = true;
  const facts: unknown[] = [], displays: unknown[] = [];
  const rpc = createRpc({ deps, soa: new SoaClient(deps), sdk, store, roles, pushFact: x => facts.push(x), pushDisplay: x => displays.push(x), agent: { current: () => null, set() {} }, captureWriteGuard: () => () => current });
  const search = async (q = query()) => {
    const reply = await rpc.handle({ req_id: `search-${q.page_no}`, op: 'im.server_search', args: q });
    assert.ok(reply?.ok, JSON.stringify(reply)); return reply.data as UiServerSearchPage;
  };
  return { base, sdk, store, facts, displays, rpc, search, invalidate() { current = false; } };
}

test('five exact search modes serialize text or date fields, never date searchValue', () => {
  const deps = makeDeps();
  for (const search_type of [0, 1, 2, 3] as const) {
    const body = serverSearchBody(deps, query({ search_type }));
    assert.deepEqual({ ...body, head: undefined }, { head: undefined, searchType: search_type, searchValue: 'find', pageNo: 1 });
  }
  assert.deepEqual({ ...serverSearchBody(deps, query({ search_type: 4, search_value: 'must be omitted', start_ms: t, end_ms: t + 999 })), head: undefined }, { head: undefined, searchType: 4, pageNo: 1, startTime: t, endTime: t + 999 });
  for (const bad of [query({ search_type: 4 }), query({ search_type: 4, start_ms: t + 1, end_ms: t }), query({ search_value: '' }), query({ page_no: 0 }), query({ search_type: 5 as never })]) assert.throws(() => serverSearchBody(deps, bad));
});

test('actual RPC returns all four groups, long identifiers and pageCount instead of page-length guesses', async () => {
  const h = setup(() => jsonResponse({ ...accepted, customerSearchList: [hit('customer')], contentSearchList: [hit('content')], orderSearchList: [hit('order')], dateSearchList: [hit('date')], pageInfo: { pageCount: 4 } }));
  const result = await h.search(query({ search_type: 0 }));
  assert.deepEqual(Object.keys(result.groups), ['customer', 'content', 'order', 'date']);
  assert.equal(result.has_more, true);
  assert.equal(result.groups.content[0]?.gid, '9223372036854775806');
  assert.ok(result.groups.content[0]?.selection_token);
  assert.equal((await h.search()).has_more, false, 'all has per-category view-all, not mixed pagination');
  assert.equal(h.facts.length, 0); assert.equal(h.displays.length, 0);
});

test('same-query pagination preserves earlier selections; changed query revokes old history tokens', async () => {
  const h = setup(call => jsonResponse(call.url.includes('searchConversation') ? { ...accepted, contentSearchList: [hit(String((call.bodyJson as { pageNo: number }).pageNo))], pageInfo: { pageCount: 2 } } : { ...accepted, rangeMessage: { isDone: true, messages: [{ msgId: 'history', msgtype: 0, fromJid: '9223372036854775806@conf/customer', messageBody: 'old history', createTime: t - 1000 }] } }));
  const first = await h.search(query({ search_type: 0 })), token = first.groups.content[0]!.selection_token;
  await h.search(query({ search_type: 0, page_no: 2 }));
  const history = await h.rpc.handle({ req_id: 'history', op: 'im.search_history', args: { selection_token: token, direction: 'prev' } });
  assert.ok(history?.ok);
  const value = history.data as UiSearchHistoryPage;
  assert.equal(value.items[0]?.sender_role, 'customer');
  await h.search(query({ query_id: 'q2', search_type: 0, search_value: 'changed' }));
  const before = h.base.fakeFetch.calls.length;
  const stale = await h.rpc.handle({ req_id: 'old', op: 'im.search_history', args: { selection_token: token, direction: 'prev' } });
  assert.equal(stale?.ok, false); assert.equal(h.base.fakeFetch.calls.length, before);
});

test('independent history uses hit anchor plus/minus 2000 and exact type, without read, reopen, cache or facts', async () => {
  const h = setup(call => jsonResponse(call.url.includes('searchConversation') ? { ...accepted, customerSearchList: [hit()], pageInfo: { pageCount: 1 } } : { ...accepted, rangeMessage: { isDone: true, messages: [] } }));
  const result = await h.search(), token = result.groups.customer[0]!.selection_token;
  for (const direction of ['prev', 'next'] as const) assert.ok((await h.rpc.handle({ req_id: direction, op: 'im.search_history', args: { selection_token: token, direction } }))?.ok);
  const history = h.base.fakeFetch.calls.filter(c => c.url.includes('getMessageList'));
  assert.equal((history[0]?.bodyJson as { endTime: number }).endTime, t + 2000);
  assert.equal((history[1]?.bodyJson as { beginTime: number }).beginTime, t - 2000);
  for (const call of history) assert.deepEqual({ ...(call.bodyJson as object), head: undefined, endTime: undefined, beginTime: undefined, direction: undefined }, { head: undefined, showTargetIsRead: true, groupId: '9223372036854775806', conversationType: 'B2C', pageSize: 50, endTime: undefined, beginTime: undefined, direction: undefined });
  assert.equal(h.facts.length, 0); assert.equal(h.displays.length, 0); assert.equal(h.store.has('9223372036854775806'), false);
  assert.equal(h.sdk.readReceipts.length, 0); assert.equal(h.sdk.sent.length, 0);
  assert.equal(h.base.fakeFetch.calls.length, 3);
});

test('search and history reject stale account generations and out-of-order conditions', async () => {
  const releases: ((value: ReturnType<typeof jsonResponse>) => void)[] = [];
  const h = setup(() => new Promise(resolve => releases.push(resolve)));
  const first = h.rpc.handle({ req_id: 'first', op: 'im.server_search', args: query() });
  await flush();
  const second = h.rpc.handle({ req_id: 'second', op: 'im.server_search', args: query({ query_id: 'q2', search_value: 'new' }) });
  await flush();
  releases[1]!(jsonResponse({ ...accepted, contentSearchList: [hit()], pageInfo: { pageCount: 1 } }));
  assert.ok((await second)?.ok);
  releases[0]!(jsonResponse({ ...accepted, customerSearchList: [hit('stale')] }));
  assert.equal((await first)?.ok, false);
  h.invalidate();
  assert.equal((await h.rpc.handle({ req_id: 'expired', op: 'im.server_search', args: query() }))?.ok, false);
  assert.equal(h.base.fakeFetch.calls.length, 2);
});

test('malformed groups or pageCount fail closed; absent pageCount has no inferred next page', async () => {
  const deps = makeDeps(), soa = new SoaClient(deps), search = createServerSearch(deps, soa, 'me', 'test');
  for (const body of [{}, { contentSearchList: {} }, { contentSearchList: null }, { contentSearchList: [null] }, { contentSearchList: [hit()], pageInfo: { pageCount: '2' } }, { contentSearchList: [hit()], pageInfo: null }]) {
    deps.fakeFetch.set(() => jsonResponse({ ...accepted, ...body }));
    await assert.rejects(search.search(query(), () => true));
  }
  deps.fakeFetch.set(() => jsonResponse({ ...accepted, contentSearchList: [hit()] }));
  assert.equal((await search.search(query({ search_type: 0 }), () => true)).has_more, false);
});


test('pending history cannot return after another search query replaces its selected token', async () => {
  let release!: (value: ReturnType<typeof jsonResponse>) => void;
  const h = setup(call => call.url.includes('searchConversation') ? jsonResponse({ ...accepted, customerSearchList: [hit()], pageInfo: { pageCount: 1 } }) : new Promise(resolve => { release = resolve; }));
  const first = await h.search(), token = first.groups.customer[0]!.selection_token;
  const pending = h.rpc.handle({ req_id: 'history-held', op: 'im.search_history', args: { selection_token: token, direction: 'next' } });
  await flush();
  await h.search(query({ query_id: 'replacement' }));
  release(jsonResponse({ ...accepted, rangeMessage: { messages: [], isDone: true } }));
  assert.equal((await pending)?.ok, false);
  assert.equal(h.facts.length, 0); assert.equal(h.displays.length, 0);
});


test('foreign room history rows fail before projection, even if selected gid would otherwise overwrite them', async () => {
  for (const foreign of [
    { partner: 'foreign@conf' }, { fromJid: 'foreign@conf/customer' }, { fromJid: 'customer@x', toJid: 'foreign@conf' },
  ]) {
    const h = setup(call => jsonResponse(call.url.includes('searchConversation') ? { ...accepted, customerSearchList: [hit()] } : { ...accepted, rangeMessage: { isDone: true, messages: [{ msgId: 'foreign', createTime: t, msgtype: 0, messageBody: 'must not leak', ...foreign }] } }));
    const result = await h.search();
    const reply = await h.rpc.handle({ req_id: 'foreign', op: 'im.search_history', args: { selection_token: result.groups.customer[0]!.selection_token, direction: 'prev' } });
    assert.equal(reply?.ok, false);
    assert.equal(JSON.stringify(reply).includes('must not leak'), false);
    assert.equal(h.facts.length, 0); assert.equal(h.displays.length, 0);
  }
});


test('short incomplete history keeps pagination; non-progressing incomplete pages fail instead of claiming completion', async () => {
  let stalled = false;
  const h = setup(call => jsonResponse(call.url.includes('searchConversation') ? { ...accepted, customerSearchList: [hit()] } : { ...accepted, rangeMessage: { isDone: false, lastMessageTime: stalled ? t + 2000 : t - 1000, messages: [{ msgId: 'one', createTime: t - 1000, msgtype: 0, messageBody: 'short page' }] } }));
  const result = await h.search(), token = result.groups.customer[0]!.selection_token;
  const query = { selection_token: token, direction: 'prev' as const };
  const first = await h.rpc.handle({ req_id: 'short', op: 'im.search_history', args: query });
  assert.ok(first?.ok);
  assert.equal((first.data as UiSearchHistoryPage).has_more, true);
  assert.equal((first.data as UiSearchHistoryPage).cursor_ms, t - 1000);
  stalled = true;
  const second = await h.rpc.handle({ req_id: 'stalled', op: 'im.search_history', args: query });
  assert.equal(second?.ok, false);
});

test('order supplement resolves the actual returned gid before reading a conversation and never treats order text as gid', async () => {
  const h = setup(call => jsonResponse(call.url.includes('searchConversation') ? { ...accepted, orderSearchList: [], pageInfo: { pageCount: 1 } } : call.url.includes('queryGroupInfo') ? { ResponseStatus: OK_STATUS, gid: 'actual-room' } : { ...accepted, conversation: { ...hit().conversation, gid: 'actual-room' } }));
  const result = await h.search(query({ search_type: 2, search_value: '000123' }));
  assert.equal(result.groups.order[0]?.gid, 'actual-room');
  assert.equal((h.base.fakeFetch.calls[1]?.bodyJson as { orderId: string }).orderId, '000123');
  assert.equal((h.base.fakeFetch.calls[2]?.bodyJson as { gid: string }).gid, 'actual-room');
  assert.equal(h.base.fakeFetch.calls.length, 3);
  assert.equal(h.facts.length, 0); assert.equal(h.displays.length, 0);
});

test('order supplement null gid stays empty, rounded gid fails, and unrelated latest conversation is rejected', async () => {
  for (const mode of ['null', 'unsafe', 'foreign'] as const) {
    const h = setup(call => jsonResponse(call.url.includes('searchConversation') ? { ...accepted, orderSearchList: [] } : call.url.includes('queryGroupInfo') ? { ResponseStatus: OK_STATUS, gid: mode === 'null' ? null : mode === 'unsafe' ? 9223372036854775806 : 'actual-room' } : { ...accepted, conversation: { ...hit().conversation, gid: 'foreign-room' } }));
    const reply = await h.rpc.handle({ req_id: mode, op: 'im.server_search', args: query({ search_type: 2, search_value: '000123' }) });
    if (mode === 'null') { assert.ok(reply?.ok); assert.equal((reply.data as UiServerSearchPage).groups.order.length, 0); }
    else assert.equal(reply?.ok, false);
    assert.equal(h.base.fakeFetch.calls.some(call => call.url.includes('getLatestConversationByGid')), mode === 'foreign');
  }
});

test('actual search history RPC retains type4 audio and malformed audio as rows without fact writes', async () => {
  const room = '9223372036854775806', voice = JSON.stringify({ btype: 4, audio: { url: 'https://x.ctrip.com/voice.mp3', secret: null, duration: 12000 } });
  const h = setup(call => jsonResponse(call.url.includes('searchConversation') ? { ...accepted, contentSearchList: [hit('voice-hit')], pageInfo: { pageCount: 1 } } : { ...accepted, rangeMessage: { messages: [voice, '{private malformed'].map((messageBody, i) => ({ msgId: `voice-${i}`, msgtype: 4, messageBody, partner: `${room}@muc.example`, fromJid: 'customer@im.example', createTime: t - i * 1000 })), hasMore: false } }));
  const result = await h.search(); const selection = result.groups.content[0]!;
  const reply = await h.rpc.handle({ req_id: 'voice-history', op: 'im.search_history', args: { selection_token: selection.selection_token, direction: 'prev' } });
  assert.ok(reply?.ok, JSON.stringify(reply)); const page = reply.data as UiSearchHistoryPage;
  assert.equal(page.items.length, 2); assert.ok(page.items.every(row => row.kind === 'voice'));
  assert.equal(page.items.find(row => row.message_id === 'voice-0')?.media_url, 'https://x.ctrip.com/voice.mp3');
  assert.equal(page.items.find(row => row.message_id === 'voice-1')?.media_url, null);
  assert.deepEqual(h.facts, []); assert.deepEqual(h.displays, []);
});


test('catalogued search validation preserves SearchError detail and RPC classification before transport', async () => {
  const deps = makeDeps();
  assert.throws(() => serverSearchBody(deps, query({ search_value: '' })), error => {
    assert.ok(error instanceof SearchError);
    assert.equal(error.detail, '请输入不超过100字的搜索内容');
    assert.equal(error.message, error.detail); return true;
  });
  const h = setup(() => { throw new Error('must not fetch invalid query'); });
  const reply = await h.rpc.handle({ req_id: 'catalog-invalid', op: 'im.server_search', args: query({ search_value: '' }) });
  assert.deepEqual(reply, { req_id: 'catalog-invalid', ok: false, error: { code: 'adapter.failed', message: '请输入不超过100字的搜索内容', retryable: false } });
  assert.equal(h.base.fakeFetch.calls.length, 0);
});
