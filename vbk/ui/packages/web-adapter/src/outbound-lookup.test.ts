import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRpc, type RpcContext } from './rpc.ts';
import { ConversationStore, RoleBook } from './stores.ts';
import { SoaClient } from './soa.ts';
import { FakePageSdk, FAKE_CONTEXT, OK_STATUS, jsonResponse, makeDeps, sampleRow } from './testing.ts';
const gid = '123456';
function fixture(change: 'none' | 'thread' | 'generation' | 'context' = 'none') {
  let live = true;
  const context = { ...FAKE_CONTEXT };
  const store = new ConversationStore(); store.update([sampleRow(gid, { threadId: 'synthetic-A' })]);
  const facts: unknown[] = [], displays: unknown[] = [];
  const sdk = new FakePageSdk();
  const base = makeDeps(call => {
    assert.ok(call.url.includes('getMessageList'), 'lookup performs only one history read');
    const body = JSON.parse(String(call.init.body)); assert.equal(body.direction, undefined); assert.equal(body.endTime, undefined); assert.equal(body.pageSize, 30);
    if (change === 'thread') store.update([sampleRow(gid, { threadId: 'synthetic-B' })]);
    if (change === 'generation') live = false;
    if (change === 'context') context.cid = 'synthetic-changed';
    return jsonResponse({ ResponseStatus: OK_STATUS, rangeMessage: { isDone: false, messages: [{ msgId: '900719925474099312345', localId: 'synthetic-local', fromJid: `${gid}@muc.synthetic/me`, toJid: 'me@synthetic', createTime: 1700000000100, msgtype: 0, messageBody: 'SYNTHETIC PRIVATE BODY' }] } });
  }, context);
  const deps = { ...base, sdk }, ctx: RpcContext = { deps, sdk, store, soa: new SoaClient(deps), roles: new RoleBook('me'), pushFact: f => facts.push(f), pushDisplay: d => displays.push(d), agent: { current: () => null, set() {} }, captureWriteGuard: () => () => live };
  return { rpc: createRpc(ctx), base, sdk, store, facts, displays };
}
test('outbound lookup returns identity metadata only and never mutates shared caches or publishes facts', async () => {
  const f = fixture(), before = f.store.latestMessage(gid);
  const reply = await f.rpc.handle({ req_id: 'lookup', op: 'im.outbound_lookup', args: { gid } });
  assert.ok(reply?.ok); assert.deepEqual(reply.data, { items: [{ gid, message_id: '900719925474099312345', local_id: 'synthetic-local', sender_role: 'merchant_self' }] });
  assert.equal(JSON.stringify(reply).includes('PRIVATE'), false); assert.equal(f.base.fakeFetch.calls.length, 1);
  assert.deepEqual(f.store.latestMessage(gid), before); assert.deepEqual(f.facts, []); assert.deepEqual(f.displays, []); assert.equal(f.sdk.sent.length, 0); assert.equal(f.sdk.readReceipts.length, 0); assert.equal(f.sdk.partnerJidOf(gid), null);
});
test('outbound lookup drops replies after service, lifecycle or sender-context changes without publication', async () => {
  for (const change of ['thread', 'generation', 'context'] as const) {
    const f = fixture(change); const reply = await f.rpc.handle({ req_id: 'lookup', op: 'im.outbound_lookup', args: { gid } });
    assert.ok(reply && !reply.ok); assert.equal(reply.error.code, 'adapter.not_ready'); assert.deepEqual(f.facts, []); assert.deepEqual(f.displays, []); assert.equal(f.sdk.sent.length, 0); assert.equal(f.sdk.readReceipts.length, 0);
  }
});
