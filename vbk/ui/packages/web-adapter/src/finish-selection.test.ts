import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { UiMembers, UiPeripheralWrite } from '../../ipc/src/client.ts';
import { createRpc, PERIPHERAL_SELECTION_TTL_MS } from './rpc.ts';
import { ConversationStore, RoleBook } from './stores.ts';
import { SoaClient } from './soa.ts';
import { FakePageSdk, OK_STATUS, jsonResponse, makeDeps, sampleRow } from './testing.ts';

function fixture(options: { unknownWrite?: boolean } = {}) {
  const store = new ConversationStore();
  const row = (extra = {}) => sampleRow('123456', { sessionId: 'session-a', conversationKey: 'key-a', ...extra });
  store.update([row()]);
  const base = makeDeps(call => {
    if (call.url.includes('/finishConversation') && options.unknownWrite) return new Error('synthetic lost response');
    if (call.url.includes('checkMemberStatus')) return jsonResponse({ ResponseStatus: OK_STATUS, status: { code: 0 }, members: [] });
    if (call.url.includes('getLatestConversationByGid')) return jsonResponse({ ResponseStatus: OK_STATUS, bizResponseStatus: { resultCode: 'SUCCESS' }, conversation: { gid: '123456', sessionId: store.view('123456')?.sessionId, status: options.unknownWrite ? 2 : 4, inGroup: options.unknownWrite ? 1 : -1 } });
    return jsonResponse({ ResponseStatus: OK_STATUS, bizResponseStatus: { resultCode: 'SUCCESS' } });
  });
  let generation = 1;
  const sdk = new FakePageSdk(), deps = { ...base, sdk };
  const ctx = { deps, soa: new SoaClient(deps), sdk, store, roles: new RoleBook('me'), pushFact() {}, pushDisplay() {}, agent: { current: () => null, set() {} }, captureWriteGuard: () => { const run = generation; return () => generation === run; } };
  const rpc = createRpc(ctx);
  const selection = async () => { const r = await rpc.handle({ req_id: 'read', op: 'im.members', args: { gid: '123456' } }); assert.ok(r?.ok); return (r.data as UiMembers).selection_token; };
  const finish = async (token?: string) => { const r = await rpc.handle({ req_id: 'write', op: 'im.finish', args: { gid: '123456', selection_token: token } }); assert.ok(r?.ok); return r.data as UiPeripheralWrite; };
  const writes = () => base.fakeFetch.calls.filter(c => c.url.includes('/finishConversation'));
  return { base, store, row, ctx, rpc, selection, finish, writes, changeRun: () => { generation += 2; } };
}

test('finish confirmation: same gid new service session cannot consume an old dialog token', async () => {
  const f = fixture(); const token = await f.selection();
  f.store.update([f.row({ sessionId: 'session-b', conversationKey: 'key-b' })]);
  assert.equal((await f.finish(token)).kind, 'not_submitted');
  assert.equal(f.writes().length, 0);
  const fresh = await f.selection();
  assert.equal((await f.finish(fresh)).kind, 'confirmed');
  assert.equal(f.writes().length, 1);
  assert.equal((f.writes()[0]?.bodyJson as Record<string, unknown>)['sessionId'], 'session-b');
});

test('finish confirmation: missing/expired/stale-run/rebuilt-RPC tokens cannot enter the write path', async () => {
  const f = fixture(); assert.equal((await f.finish()).kind, 'not_submitted');
  const expired = await f.selection(); await f.base.clock.advance(PERIPHERAL_SELECTION_TTL_MS);
  assert.equal((await f.finish(expired)).kind, 'not_submitted');
  const stale = await f.selection(); f.changeRun();
  assert.equal((await f.finish(stale)).kind, 'not_submitted');
  const other = createRpc(f.ctx);
  await other.handle({ req_id: 'newread', op: 'im.members', args: { gid: '123456' } });
  const reply = await other.handle({ req_id: 'oldwrite', op: 'im.finish', args: { gid: '123456', selection_token: stale } });
  assert.ok(reply?.ok); assert.equal((reply.data as UiPeripheralWrite).kind, 'not_submitted');
  assert.equal(f.writes().length, 0);
});

test('finish not_submitted: missing real key is a proven zero-write result and metadata completion can be freshly confirmed', async () => {
  const f = fixture(); f.store.update([f.row({ conversationKey: null })]);
  const first = await f.finish(await f.selection());
  assert.equal(first.kind, 'not_submitted'); assert.equal(f.writes().length, 0);
  f.store.update([f.row()]);
  assert.equal((await f.finish(await f.selection())).kind, 'confirmed');
  assert.equal(f.writes().length, 1);
});

test('finish confirmation: a submitted unknown is never converted to not_submitted or replayed by a newer token', async () => {
  const f = fixture({ unknownWrite: true });
  f.store.update([f.row({ sessionId: 'uncertain-session' })]);
  const token = await f.selection();
  assert.equal((await f.finish(token)).kind, 'unknown');
  f.store.update([f.row({ sessionId: 'uncertain-session', conversationKey: 'enriched-key' })]);
  assert.equal((await f.finish(await f.selection())).kind, 'unknown');
  assert.equal(f.writes().length, 1);
});

test('finish confirmation: page context changes invalidate the captured selection even with stable gid/session', async () => {
  const f = fixture(); const token = await f.selection();
  Object.assign(f.ctx.deps.context, { cid: 'different-page-context' });
  assert.equal((await f.finish(token)).kind, 'not_submitted');
  assert.equal(f.writes().length, 0);
});

test('finish not_submitted: an unclassified local exception is never a trusted permission to clear the UI fence', async () => {
  const f = fixture();
  const rpc = createRpc({ ...f.ctx, captureWriteGuard() { throw new Error('synthetic local exception'); } });
  const reply = await rpc.handle({ req_id: 'unexpected', op: 'im.finish', args: { gid: '123456', selection_token: 'unclassified' } });
  assert.ok(reply && !reply.ok);
  assert.equal(reply.error.code, 'adapter.failed');
  assert.equal(f.writes().length, 0);
});
