import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRpc, type RpcContext } from './rpc.ts';
import { ConversationStore, RoleBook } from './stores.ts';
import { SoaClient } from './soa.ts';
import { FakePageSdk, OK_STATUS, flush, jsonResponse, makeDeps, sampleRow } from './testing.ts';

const gid = '123456', localId = 'synthetic-local';
const rowA = { sessionId: 'session-A', threadId: 'thread-A', uid: 'customer-A', conversationKey: 'key-A', serviceType: '1513', conversationType: 'B2C', id: 9001 };
function fixture(options: { changeAfterHistory?: Record<string, unknown>; cached?: boolean; echoFailure?: boolean } = {}) {
  const base = makeDeps(call => jsonResponse(call.url.includes('getMessageList')
    ? { ResponseStatus: OK_STATUS, rangeMessage: { isDone: true, messages: [{ msgId: 'history', messageBody: 'history', fromJid: `${gid}@muc.synthetic/customer`, toJid: 'me@synthetic', createTime: 1700000000500, msgtype: 0 }] } }
    : { ResponseStatus: OK_STATUS, members: [] }));
  const sdk = new FakePageSdk(), deps = { ...base, sdk }, store = new ConversationStore();
  store.update([sampleRow(gid, { ...rowA, ...(!options.cached ? { lastMessageJsonString: '' } : {}) })]);
  let switched = false;
  const ctx: RpcContext = { deps, sdk, store, soa: new SoaClient(deps), roles: new RoleBook('me'), pushFact() {}, pushDisplay(payload) {
    if (payload.kind === 'messages' && !switched && options.changeAfterHistory) {
      switched = true;
      // This is the independent review's actual race: after the history
      // handler's final check, before sendOnce resumes its await continuation.
      queueMicrotask(() => store.update([sampleRow(gid, { ...rowA, ...options.changeAfterHistory })]));
    }
    if (options.echoFailure && payload.kind === 'messages' && payload.items.some(item => item.local_id === localId)) throw new Error('synthetic projection failure after SDK confirmation');
  }, agent: { current: () => null, set() {} }, captureWriteGuard: () => () => true, sendAckTimeoutMs: 1000 };
  const rpc = createRpc(ctx);
  const request = { req_id: 'send', op: 'im.send_text', args: { gid, local_id: localId, text: 'synthetic body', original: null, quote_id: null } };
  const wait = async () => { for (let i = 0; i < 8; i++) await flush(); };
  const ack = () => sdk.emit('send_result', { error: 0, localid: localId, tid: 'synthetic-server', create_time: '1700000000999' });
  return { base, sdk, store, ctx, rpc, request, wait, ack };
}

test('send identity: actual history projection microtask switches same gid to another service session; no old-thread or redirected send', async () => {
  const f = fixture({ changeAfterHistory: { sessionId: 'session-B', threadId: 'thread-B', uid: 'customer-new' } });
  const pending = f.rpc.handle(f.request); await f.wait();
  assert.equal(f.store.view(gid)?.sessionId, 'session-B');
  if (f.sdk.sent.length) f.ack(); // Settle the unsafe baseline before asserting.
  const reply = await pending;
  assert.equal(f.sdk.sent.length, 0, 'neither captured thread-A nor a redirected thread-B may be submitted');
  assert.ok(reply && !reply.ok); assert.equal(reply.error.code, 'adapter.not_ready');
});

test('send identity: each captured service/target field is rechecked after history without changing the user intent', async () => {
  for (const change of [{ sessionId: 'session-B' }, { uid: 'customer-new' }, { threadId: 'thread-B' }, { serviceType: '2384' }, { conversationType: 'C2C' }, { conversationKey: 'key-B' }, { id: 9002 }]) {
    const f = fixture({ changeAfterHistory: change }); const pending = f.rpc.handle(f.request); await f.wait();
    if (f.sdk.sent.length) f.ack(); const reply = await pending;
    assert.equal(f.sdk.sent.length, 0, `changed ${Object.keys(change)[0]} must stop the original send`);
    assert.ok(reply && !reply.ok); assert.equal(reply.error.code, 'adapter.not_ready');
  }
});

test('send identity: cached-target path also validates the captured row immediately before submission', async () => {
  const f = fixture({ cached: true });
  Object.defineProperty(f.sdk, 'canSend', { get() { f.store.update([sampleRow(gid, { ...rowA, threadId: 'thread-B' })]); return true; } });
  const pending = f.rpc.handle(f.request); await f.wait(); if (f.sdk.sent.length) f.ack(); const reply = await pending;
  assert.equal(f.sdk.sent.length, 0); assert.ok(reply && !reply.ok); assert.equal(reply.error.code, 'adapter.not_ready');
});

test('send identity: unchanged identity may learn its room from real history and sends only once', async () => {
  const f = fixture(); const pending = f.rpc.handle(f.request); await f.wait();
  assert.equal(f.sdk.sent.length, 1); assert.equal(f.sdk.sent[0]?.body.threadid, 'thread-A'); assert.equal(f.sdk.sent[0]?.body.biztype, '1513');
  f.ack(); const first = await pending; assert.ok(first?.ok); assert.equal((first.data as { kind: string }).kind, 'confirmed');
  assert.deepEqual(await f.rpc.handle({ ...f.request, req_id: 'duplicate' }), { ...first, req_id: 'duplicate' }); assert.equal(f.sdk.sent.length, 1);
});

test('send identity: an already-known room target cannot silently change before submission', async () => {
  const f = fixture({ cached: true }); f.sdk.rememberPartnerJid(gid, `${gid}@muc.original`);
  Object.defineProperty(f.sdk, 'canSend', { get() { f.sdk.rememberPartnerJid(gid, `${gid}@muc.changed`); return true; } });
  const pending = f.rpc.handle(f.request); await f.wait(); if (f.sdk.sent.length) f.ack(); const reply = await pending;
  assert.equal(f.sdk.sent.length, 0); assert.ok(reply && !reply.ok); assert.equal(reply.error.code, 'adapter.not_ready');
});

test('send identity: projection failure after submission stays unknown and never clears the local-id barrier', async () => {
  const f = fixture({ echoFailure: true });
  const pending = f.rpc.handle(f.request); await f.wait(); f.ack(); const first = await pending;
  const repeated = f.rpc.handle({ ...f.request, req_id: 'duplicate' }); await f.wait();
  if (f.sdk.sent.length > 1) f.ack(); const second = await repeated;
  assert.equal(f.sdk.sent.length, 1, 'a post-submit exception must not delete the send memo');
  assert.ok(first?.ok && second?.ok); assert.equal((first.data as { kind: string }).kind, 'unknown'); assert.equal((second.data as { kind: string }).kind, 'unknown');
});
