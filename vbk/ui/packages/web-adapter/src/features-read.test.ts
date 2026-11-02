/**
 * I-23 B2/B3 adapter reads and writes added in this item, plus the
 * dispatcher contract. Bodies follow docs/api/endpoints and the 2026-11-02
 * live capture; nothing here talks to a network.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SoaClient } from './soa.ts';
import { FAILURE_STATUS, OK_STATUS, flush, jsonResponse, makeDeps } from './testing.ts';
import { FeatureOpError, createFeatureDispatcher, type AdapterFeature } from './features.ts';
import { createAdapterFeatures } from './index.ts';
import { TRANSLATE_IQ_MESSAGE, translateNoticeMessage } from './notice.ts';
import { SCRIPT_SUGGEST_DEBOUNCE_MS, createScriptSuggester, getQuickReplyCategories, quickReplyCategoriesBody, type ScriptSuggestion } from './settings.ts';
import { finishConversation, searchConversations, transferVenMaster, type PeripheralConversation } from './peripheral.ts';
import { setWorkSheetStar } from './worksheetStar.ts';
import { makeCtx } from './featureTesting.ts';

const accepted = { ResponseStatus: OK_STATUS, bizResponseStatus: { resultCode: 'SUCCESS' } };

// ------------------------------------------------------------------ dispatcher

test('dispatcher: ops must live under the feature id; duplicates are programming errors', () => {
  const noop = async (): Promise<unknown> => null;
  assert.throws(() => createFeatureDispatcher([{ id: 'a', ops: { 'b.x': noop } }]), /may not register/);
  assert.throws(() => createFeatureDispatcher([{ id: 'a', ops: {} }, { id: 'a', ops: {} }]), /duplicate adapter feature/);
  assert.throws(() => createFeatureDispatcher([{ id: 'a', ops: { 'a.Bad': noop } }]), /may not register/);
});

test('dispatcher: unknown op fails, a throwing onSdkMessage cannot starve other features, dispose reaches all', async () => {
  const seen: string[] = [];
  const bad: AdapterFeature = { id: 'bad', ops: {}, onSdkMessage: () => { throw new Error('x'); } };
  const good: AdapterFeature = { id: 'good', ops: { 'good.ping': async () => 'pong' }, onSdkMessage: () => { seen.push('good'); }, dispose: () => { seen.push('disposed'); } };
  const d = createFeatureDispatcher([bad, good]);
  const ctx = makeCtx();
  d.onSdkMessage({}, ctx);
  assert.deepEqual(seen, ['good']);
  assert.equal(await d.call('good.ping', {}, ctx), 'pong');
  await assert.rejects(d.call('good.nope', {}, ctx), FeatureOpError);
  d.dispose();
  assert.deepEqual(seen, ['good', 'disposed']);
});

test('the registered adapter features expose exactly the planned ops', () => {
  const d = createFeatureDispatcher(createAdapterFeatures());
  for (const op of ['typing.send', 'recall.message', 'queue.status', 'queue.drop_out']) assert.equal(d.has(op), true, op);
  assert.equal(d.has('voice.play'), false, 'playback is local to the UI');
  // fresh state per call: two adapters never share a throttle
  assert.notEqual(createAdapterFeatures()[0], createAdapterFeatures()[0]);
});

// ------------------------------------------------------------------ notice

test('translateIQMessage is unsupported and sends nothing (request shape never captured)', async () => {
  assert.equal(TRANSLATE_IQ_MESSAGE.path, '11679/translateIQMessage');
  assert.deepEqual(await translateNoticeMessage(), { kind: 'unsupported', reason: 'request_shape_not_captured' });
});

// ------------------------------------------------------------------ quick replies

const categories = {
  ResponseStatus: OK_STATUS,
  categories: [
    {
      id: 11, name: 'Greetings', code: 'CS1', subCategories: [{ id: 12, name: 'Sub', customerScripts: [{ id: 5, content: 'sub text', shortCut: '', type: 'VAGENT', sortNo: 0 }] }],
      customerScripts: [
        { id: 2, shortCut: 'hi', content: 'second', type: 'VAGENT', sortNo: 10 },
        { id: 1, shortCut: '', content: 'first', type: 'VAGENT', sortNo: 0 },
        { id: 'x', content: 'dropped: id not numeric' },
        { id: 3, content: '   ' },
        'junk',
      ],
    },
    { name: 'dropped: no id' },
  ],
};

test('getCategories: exact request body, scripts ordered by sortNo, malformed rows dropped', async () => {
  const deps = makeDeps(() => jsonResponse(categories));
  const soa = new SoaClient(deps);
  const r = await getQuickReplyCategories(deps, soa);
  assert.equal(r.kind, 'ok');
  if (r.kind !== 'ok') return;
  assert.equal(r.value.length, 1);
  assert.deepEqual(r.value[0]!.scripts.map((s) => s.content), ['first', 'second']);
  assert.equal(r.value[0]!.scripts[1]!.shortCut, 'hi');
  assert.equal(r.value[0]!.subCategories[0]!.scripts[0]!.id, '5');
  const call = deps.fakeFetch.calls[0]!;
  assert.match(call.url, /\/16037\/getCategories\?/);
  const { head: _h, ...body } = call.bodyJson as Record<string, unknown>;
  assert.deepEqual(body, { typeList: ['VAGENT'], categoryType: 'CUSTOMSCRIPT', status: 'ACTIVE' });
  assert.deepEqual(Object.keys(quickReplyCategoriesBody(deps)), ['head', 'typeList', 'categoryType', 'status']);
});

test('getCategories: bad typeList is refused locally; non-array response fails closed', async () => {
  const deps = makeDeps(() => jsonResponse({ ResponseStatus: OK_STATUS }));
  const soa = new SoaClient(deps);
  assert.equal((await getQuickReplyCategories(deps, soa, [])).kind, 'failed');
  assert.equal((await getQuickReplyCategories(deps, soa, ['bad type'])).kind, 'failed');
  assert.equal(deps.fakeFetch.calls.length, 0);
  assert.equal((await getQuickReplyCategories(deps, soa)).kind, 'failed');
});

test('script suggestions: 200 ms debounce, latest query wins, empty query only cancels', async () => {
  const deps = makeDeps((c) => jsonResponse({ ResponseStatus: OK_STATUS, customerScripts: [{ id: 1, content: `re:${(c.bodyJson as { content: string }).content}`, sortNo: 0 }] }));
  const soa = new SoaClient(deps);
  const got: ScriptSuggestion[] = [];
  const s = createScriptSuggester(deps, soa, (x) => got.push(x));
  s.query('h');
  await deps.clock.advance(100);
  s.query('he');
  await deps.clock.advance(100);
  s.query('hel');
  assert.equal(deps.fakeFetch.calls.length, 0, 'typing faster than 200 ms sends nothing');
  await deps.clock.advance(SCRIPT_SUGGEST_DEBOUNCE_MS);
  await flush();
  assert.equal(deps.fakeFetch.calls.length, 1);
  assert.equal(got.length, 1);
  assert.equal(got[0]!.query, 'hel');
  assert.equal(got[0]!.result.kind === 'ok' && got[0]!.result.value[0]!.content, 're:hel');
  s.query('  ');
  s.query('x');
  s.cancel();
  await deps.clock.advance(1000);
  await flush();
  assert.equal(deps.fakeFetch.calls.length, 1);
});

// ------------------------------------------------------------------ search

const searchBody = {
  ...accepted,
  customerSearchList: [
    {
      conversation: { gid: '111', id: 77, sessionId: 's1', conversationKey: 'k1', conversationType: 'C2B', serviceType: '1513', status: 4, groupTitle: 'T', lastMessageTime: 1700000000000, ext: { token: 'secret' } },
      message: { msgId: 'm1', messageBody: 'hello there', msgtype: 0, createTime: 1700000000000, fromJid: 'a@b' },
    },
    { conversation: { groupTitle: 'no gid' } },
    'junk',
  ],
};

test('searchConversation: samples\' body shape; only identity + preview survive, conversationType is not forced', async () => {
  const deps = makeDeps(() => jsonResponse(searchBody));
  const soa = new SoaClient(deps);
  const r = await searchConversations(deps, soa, { searchType: 3, searchValue: 'abc', pageNo: 1 });
  assert.equal(r.kind, 'success');
  if (r.kind !== 'success') return;
  assert.equal(r.value.length, 1);
  assert.deepEqual(r.value[0], {
    gid: '111', sessionId: 's1', conversationKey: 'k1', conversationType: 'C2B', worksheetId: 77, serviceType: '1513', status: 4,
    title: 'T', lastMessageTime: 1700000000000, messageId: 'm1', preview: 'hello there',
  });
  assert.equal(JSON.stringify(r.value).includes('secret'), false, 'ext/token never leaves the mapper');
  const { head: _h, ...body } = deps.fakeFetch.calls[0]!.bodyJson as Record<string, unknown>;
  assert.deepEqual(body, { searchType: 3, searchValue: 'abc', pageNo: 1 });
  await searchConversations(deps, soa, { searchType: 3, searchValue: 'abc', pageNo: 2, startTime: 10, endTime: 20 });
  const { head: _h2, ...body2 } = deps.fakeFetch.calls[1]!.bodyJson as Record<string, unknown>;
  assert.deepEqual(body2, { searchType: 3, searchValue: 'abc', pageNo: 2, startTime: 10, endTime: 20 });
});

test('searchConversation: invalid arguments are refused before any request; failures keep their class', async () => {
  const deps = makeDeps((_, i) => jsonResponse(i === 0 ? { ResponseStatus: OK_STATUS } : { ResponseStatus: FAILURE_STATUS }));
  const soa = new SoaClient(deps);
  const bad = [
    { searchType: -1, searchValue: 'a', pageNo: 1 },
    { searchType: 3, searchValue: ' ', pageNo: 1 },
    { searchType: 3, searchValue: 'x'.repeat(101), pageNo: 1 },
    { searchType: 3, searchValue: 'a', pageNo: 0 },
    { searchType: 3, searchValue: 'a', pageNo: 1, startTime: 5, endTime: 1 },
    { searchType: 3.5, searchValue: 'a', pageNo: 1 },
  ];
  for (const b of bad) assert.equal((await searchConversations(deps, soa, b)).kind, 'invalid');
  assert.equal(deps.fakeFetch.calls.length, 0);
  assert.equal((await searchConversations(deps, soa, { searchType: 3, searchValue: 'a', pageNo: 1 })).kind, 'biz_failure', 'Ack alone is not success');
  assert.equal((await searchConversations(deps, soa, { searchType: 3, searchValue: 'a', pageNo: 1 })).kind, 'failed');
});

// ------------------------------------------------------------------ B3 write shapes (live capture round 6)

const row: PeripheralConversation = {
  gid: '1234567890123456789', conversationKey: 'ck', sessionId: 's', worksheetId: 456, serviceType: '1513', threadId: '', conversationType: 'C2B', customerUid: null, orderId: null, lastMessage: null,
};

test('round 6: groupId is a NUMBER for setWorkSheetStar and a STRING for transferVenMaster; finish keeps the row conversationType', async () => {
  const deps = makeDeps(() => jsonResponse(accepted));
  const soa = new SoaClient(deps);
  assert.deepEqual(await setWorkSheetStar(deps, soa, { sessionId: 's', groupId: 123456789, worksheetId: 456, action: 3 }), { applied: true, action: 3 });
  assert.deepEqual(await transferVenMaster(deps, soa, row, { targetVenAgentUid: 'agent-uid' }), { kind: 'accepted', requiresReadBack: true });
  assert.deepEqual(await finishConversation(deps, soa, row), { kind: 'accepted', requiresReadBack: true });
  const [star, transfer, finish] = deps.fakeFetch.calls.map((c) => c.bodyJson as Record<string, unknown>);
  assert.equal(typeof star!['groupId'], 'number');
  assert.equal(typeof star!['worksheetId'], 'number');
  assert.equal(typeof transfer!['groupId'], 'string');
  assert.equal(finish!['conversationType'], 'C2B', 'B2C/C2B come from the row, never hard-coded');
  assert.equal(typeof finish!['workSheetId'], 'number');
});

test('round 6: success is bizResponseStatus.resultCode === SUCCESS, never Ack alone', async () => {
  const deps = makeDeps((_, i) => jsonResponse(i === 0 ? { ResponseStatus: OK_STATUS } : i === 1 ? { ...accepted, bizResponseStatus: { resultCode: 'FAIL' } } : accepted));
  const soa = new SoaClient(deps);
  assert.equal((await transferVenMaster(deps, soa, row, { targetVenAgentUid: 'a' })).kind, 'unknown', 'Ack without resultCode is not accepted');
  assert.equal((await finishConversation(deps, soa, row)).kind, 'biz_failure');
  assert.equal((await finishConversation(deps, soa, row)).kind, 'accepted');
});
