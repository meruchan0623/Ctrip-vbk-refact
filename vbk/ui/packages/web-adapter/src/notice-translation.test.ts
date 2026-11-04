import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { UiNotice } from '../../ipc/src/client.ts';
import { translateNoticeMessage } from './notice.ts';
import { createRpc, type RpcContext } from './rpc.ts';
import { ConversationStore, RoleBook } from './stores.ts';
import { SoaClient } from './soa.ts';
import { FakePageSdk, flush, jsonResponse, makeDeps, OK_STATUS, type FetchScript } from './testing.ts';

const original: UiNotice = { id: '9223372036854775806', category_id: '3:112', title: '订单通知', body: '请查看订单', time_ms: 1700000000000, unread: true, url: 'https://vbooking.ctrip.com/order/1' };
const foreign = (script: FetchScript) => {
  const base = makeDeps(script);
  return { ...base, context: { ...base.context, locale: 'en-US' } };
};

test('notice translation matches desktop getHead(1001), locale, exact ids and title/desc rules', async () => {
  const deps = foreign(() => jsonResponse({ ResponseStatus: OK_STATUS, results: [{ msgId: original.id, translateItems: { title: 'Order notice', desc: 'View your order', url: 'https://evil.example/' } }] }));
  const result = await translateNoticeMessage(deps, new SoaClient(deps), [original]);
  assert.deepEqual(result, { kind: 'translated', items: [{ ...original, title: 'Order notice', body: 'View your order' }] });
  assert.equal(deps.fakeFetch.calls.length, 1);
  assert.equal(new URL(deps.fakeFetch.calls[0]!.url).pathname, '/restapi/soa2/11679/translateIQMessage');
  const request = deps.fakeFetch.calls[0]!.bodyJson as { head: { appId: string; extension: { name: string; value: string }[] }; originLocale: string; targetLocale: string; rules: unknown[] };
  assert.equal(request.head.appId, '1001');
  assert.deepEqual(request.head.extension.at(-1), { name: 'locale', value: 'en-US' });
  assert.deepEqual({ ...request, head: undefined }, { head: undefined, originLocale: 'zh-CN', targetLocale: 'en-US', rules: [{ msgId: original.id, items: { title: original.title, desc: original.body } }] });
});

test('notice translation skips Chinese/empty content and only translates requested nonempty fields', async () => {
  const base = makeDeps();
  assert.equal((await translateNoticeMessage(base, new SoaClient(base), [original])).kind, 'unchanged');
  assert.equal(base.fakeFetch.calls.length, 0);
  const deps = foreign(() => jsonResponse({ ResponseStatus: OK_STATUS, results: [{ msgId: original.id, translateItems: { title: 'Order', desc: 'invented body' } }] }));
  const empty = { ...original, title: '', body: '' };
  assert.equal((await translateNoticeMessage(deps, new SoaClient(deps), [empty])).kind, 'unchanged');
  assert.equal(deps.fakeFetch.calls.length, 0);
  const result = await translateNoticeMessage(deps, new SoaClient(deps), [{ ...original, body: '' }]);
  assert.deepEqual(result.items, [{ ...original, title: 'Order', body: '' }]);
});

test('partial, unrelated, ambiguous and malformed translation fields preserve originals', async () => {
  for (const results of [
    [{ msgId: 'other', translateItems: { title: 'wrong' } }],
    [{ msgId: Number(original.id), translateItems: { title: 'rounded id' } }],
    [{ msgId: original.id, translateItems: { title: '', desc: {} } }],
    [{ msgId: original.id, translateItems: { title: 'first' } }, { msgId: original.id, translateItems: { title: 'second' } }],
  ]) {
    const deps = foreign(() => jsonResponse({ ResponseStatus: OK_STATUS, results }));
    assert.deepEqual((await translateNoticeMessage(deps, new SoaClient(deps), [original])).items, [original]);
  }
  const deps = foreign(() => jsonResponse({ ResponseStatus: OK_STATUS, results: [{ msgId: original.id, translateItems: { title: 'Order' } }] }));
  assert.deepEqual((await translateNoticeMessage(deps, new SoaClient(deps), [original])).items, [{ ...original, title: 'Order' }]);
});

test('translation failure never loses the loaded notice list', async () => {
  for (const response of [
    { ResponseStatus: OK_STATUS },
    { ResponseStatus: OK_STATUS, results: {} },
    { ResponseStatus: OK_STATUS, success: false, results: [] },
    { ResponseStatus: { Ack: 'Failure', Errors: [] } },
  ]) {
    const deps = foreign(() => jsonResponse(response));
    const result = await translateNoticeMessage(deps, new SoaClient(deps), [original]);
    assert.equal(result.kind, 'failed');
    assert.deepEqual(result.items, [original]);
  }
});

function rpcSetup(script: FetchScript) {
  const deps = foreign(script), sdk = new FakePageSdk();
  let current = true;
  const ctx: RpcContext = { deps, soa: new SoaClient(deps), sdk, store: new ConversationStore(), roles: new RoleBook('me'), pushFact: () => undefined, pushDisplay: () => undefined, agent: { current: () => null, set: () => undefined }, captureWriteGuard: () => () => current };
  return { deps, rpc: createRpc(ctx), invalidate: () => { current = false; } };
}
const listRequest = { req_id: 'list', op: 'notice.list', args: { category_id: '3:112' } };
const listBody = { ResponseStatus: OK_STATUS, iqMessages: [{ msgId: original.id, createTime: original.time_ms, messageBody: JSON.stringify({ ext: { title: original.title, desc: original.body } }) }] };

test('actual notice.list RPC translates foreign locales and falls back to source on translation failure', async () => {
  for (const success of [true, false]) {
    const h = rpcSetup(call => jsonResponse(call.url.includes('getIQMessages') ? listBody : success ? { ResponseStatus: OK_STATUS, results: [{ msgId: original.id, translateItems: { title: 'Order' } }] } : { ResponseStatus: { Ack: 'Failure', Errors: [] } }));
    const reply = await h.rpc.handle(listRequest);
    assert.ok(reply?.ok);
    assert.equal((reply.data as UiNotice[])[0]?.title, success ? 'Order' : original.title);
    assert.equal(h.deps.fakeFetch.calls.length, 2);
    assert.equal(h.deps.fakeFetch.calls.some(c => c.url.includes('putAdvice')), false);
  }
});

test('actual notice.list RPC rejects translation completed after account lifecycle changes', async () => {
  let release!: (value: ReturnType<typeof jsonResponse>) => void;
  const h = rpcSetup(call => call.url.includes('getIQMessages') ? jsonResponse(listBody) : new Promise(resolve => { release = resolve; }));
  const pending = h.rpc.handle(listRequest);
  await flush();
  assert.equal(h.deps.fakeFetch.calls.length, 2);
  h.invalidate();
  release(jsonResponse({ ResponseStatus: OK_STATUS, results: [{ msgId: original.id, translateItems: { title: 'old account' } }] }));
  const result = await pending;
  assert.equal(result?.ok, false);
});
