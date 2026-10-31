import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConversationStore } from './stores.ts';
import { sampleRow, makeDeps, FakePageSdk, OK_STATUS, jsonResponse } from './testing.ts';
import { createRpc } from './rpc.ts';
import { SoaClient } from './soa.ts';
import { RoleBook } from './stores.ts';
import { createPageSession } from './session.ts';
import type { AdapterDisplayPayload } from '../../ipc/src/adapterProtocol.ts';

test('assistant context revision is stable for display updates and changes for every real service identity field', () => {
  const store = new ConversationStore(); const row = sampleRow('123456');
  store.update([row]);
  const token = store.assistantContextRevision('123456', 'synthetic-self', '123456@room');
  assert.equal(typeof token, 'string'); assert.ok(token);
  store.update([{ ...row, groupTitle: 'updated label', lastMessageTime: 1800000000000, star: 2 }]);
  assert.equal(store.assistantContextRevision('123456', 'synthetic-self', '123456@room'), token);
  for (const [key, value] of Object.entries({ sessionId: 'changed-session', uid: 'changed-customer', conversationType: 'changed-type', serviceType: 'changed-service', threadId: 'changed-thread', conversationKey: 'changed-key', id: 7654, relationOrderId: '0000000001' })) {
    store.update([row]); const before = store.assistantContextRevision('123456', 'synthetic-self', '123456@room');
    store.update([{ ...row, [key]: value }]);
    assert.notEqual(store.assistantContextRevision('123456', 'synthetic-self', '123456@room'), before, key);
  }
  store.update([row]); const before = store.assistantContextRevision('123456', 'synthetic-self', '123456@room');
  assert.notEqual(store.assistantContextRevision('123456', 'changed-self', '123456@room'), before);
  assert.notEqual(store.assistantContextRevision('123456', 'synthetic-self', 'changed@room'), before);
  assert.notEqual(new ConversationStore().assistantContextRevision('missing', 's', 'r'), token);
  assert.equal(store.assistantContextRevision('123456', '', '123456@room'), null);
  assert.equal(store.assistantContextRevision('123456', 'synthetic-self', null), null);
});

test('assistant.scope checks the exact captured revision without HTTP or SDK writes', async () => {
  const base = makeDeps(() => { throw new Error('scope must never perform HTTP'); }), sdk = new FakePageSdk(), store = new ConversationStore();
  store.update([sampleRow('123456')]); const roles = new RoleBook('synthetic-self');
  const rpc = createRpc({ deps: base, sdk, store, roles, soa: new SoaClient(base), pushFact: () => assert.fail('no facts'), pushDisplay: () => assert.fail('no display'), agent: { current: () => null, set: () => assert.fail('no agent change') } });
  const revision = store.assistantContextRevision('123456', roles.selfUid, '123456@conf.x')!;
  const result = await rpc.handle({ req_id: 'scope-1', op: 'assistant.scope', args: { gid: '123456', context_revision: revision } });
  assert.ok(result?.ok); assert.deepEqual(result.data, { context_revision: revision, order_id: '1234567890' });
  store.update([sampleRow('123456', { uid: 'replacement-customer' })]);
  const stale = await rpc.handle({ req_id: 'scope-2', op: 'assistant.scope', args: { gid: '123456', context_revision: revision } });
  assert.equal(stale?.ok, false); assert.equal(sdk.sent.length, 0); assert.equal(base.fakeFetch.calls.length, 0);
});

test('real page-session display retains revision on messages and changes it on same-gid service replacement', async () => {
  let row = sampleRow('123456');
  const base = makeDeps(call => call.url.includes('getConversationList') ? jsonResponse({ ResponseStatus: OK_STATUS, conversationList: [row], currentStatus: 2, lastUpdateTime: 1700000000600, haveRest: false }) : jsonResponse({ ResponseStatus: OK_STATUS }));
  const sdk = new FakePageSdk(), displays: AdapterDisplayPayload[] = [];
  const session = createPageSession({ ...base, sdk }, { account: { account_id: 'synthetic-account', environment: 'production', session_generation: 1 }, selfUid: 'synthetic-self', beginMsgTime: 1700000000000, initialEpoch: 1, sdk, pushDisplay: p => { displays.push(p); return Promise.resolve(null); } });
  const latest = () => displays.filter((p): p is Extract<AdapterDisplayPayload, { kind: 'conversations' }> => p.kind === 'conversations').at(-1)?.items[0]?.assistant_context_revision;
  session.start(); await base.clock.advance(50);
  const first = latest(); assert.ok(first && /^[0-9a-f-]{36}$/.test(first));
  sdk.emit('message', { id: 'synthetic-id', type: 'groupchat', msgtype: '0', create_time: '1700000009000', from: '123456@conf.x/cust-123456', to: 'synthetic-self@x', body: 'synthetic display-only update' });
  await session.adapter.bridge.flush(); assert.equal(latest(), first);
  row = sampleRow('123456', { sessionId: 'replacement-service-session' });
  await base.clock.advance(5100); assert.notEqual(latest(), first);
  assert.equal(sdk.sent.length, 0); session.stop(); assert.equal(base.clock.pendingCount(), 0);
});

test('observed missing identity and A-to-other-to-A transitions permanently revoke old scope capabilities', async () => {
  for (const missing of ['session', 'customer', 'self', 'jid', 'unprojected-row-transition']) {
    const base = makeDeps(() => { throw new Error('no upstream call'); }), sdk = new FakePageSdk(), store = new ConversationStore(), roles = new RoleBook('synthetic-self');
    const row = sampleRow('123456'); store.update([row]);
    const rpc = createRpc({ deps: base, sdk, store, roles, soa: new SoaClient(base), pushFact: () => assert.fail(), pushDisplay: () => assert.fail(), agent: { current: () => null, set: () => assert.fail() } });
    const before = store.assistantContextRevision('123456', roles.selfUid, '123456@conf.x')!;
    if (missing === 'session' || missing === 'customer') {
      store.update([{ ...row, [missing === 'session' ? 'sessionId' : 'uid']: '' }]);
      assert.equal(store.assistantContextRevision('123456', roles.selfUid, '123456@conf.x'), null);
    } else if (missing === 'self') assert.equal(store.assistantContextRevision('123456', '', '123456@conf.x'), null);
    else if (missing === 'jid') assert.equal(store.assistantContextRevision('123456', roles.selfUid, null), null);
    else store.update([{ ...row, sessionId: 'intermediate-service-never-projected' }]);
    store.update([row]);
    const reply = await rpc.handle({ req_id: `restore-${missing}`, op: 'assistant.scope', args: { gid: '123456', context_revision: before } });
    assert.equal(reply?.ok, false, missing);
    assert.notEqual(store.assistantContextRevision('123456', roles.selfUid, '123456@conf.x'), before);
    assert.equal(base.fakeFetch.calls.length, 0); assert.equal(sdk.sent.length, 0);
  }
});
