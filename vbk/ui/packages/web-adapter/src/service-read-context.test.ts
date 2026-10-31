import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AdapterFact } from '../../ipc/src/contracts.ts';
import type { AdapterDisplayPayload } from '../../ipc/src/adapterProtocol.ts';
import { ConversationStore, RoleBook } from './stores.ts';
import { createRpc } from './rpc.ts';
import { SoaClient } from './soa.ts';
import { FakePageSdk, OK_STATUS, flush, jsonResponse, makeDeps, sampleRow } from './testing.ts';

const GID = '123456';
const HIGH = 1700000000900;
const LOW = 1700000000100;
function row(customer: string, id: string, time: number) {
  return sampleRow(GID, { uid: customer, sessionId: `session-${customer}`, lastMessageTime: time,
    lastMessageJsonString: JSON.stringify({ msgId: id, fromJid: `${customer}@im.x`, toJid: `${GID}@conf.x`, createTime: time, msgtype: 0 }) });
}

test('service read: lower-time replacement resets latest and A → B → A never reuses epoch or revision', () => {
  const store = new ConversationStore();
  store.update([row('A', 'A-high', HIGH)]);
  const epochA = store.messageContext(GID);
  const revisionA = store.assistantContextRevision(GID, 'me', `${GID}@conf.x`);
  store.update([row('B', 'B-low', LOW)]);
  assert.equal(store.latestMessage(GID)?.msgId, 'B-low');
  assert.notEqual(store.messageContext(GID), epochA);
  const epochB = store.messageContext(GID);
  store.update([row('A', 'A-return', LOW + 1)]);
  assert.equal(store.latestMessage(GID)?.msgId, 'A-return');
  assert.notEqual(store.messageContext(GID), epochA);
  assert.notEqual(store.messageContext(GID), epochB);
  assert.notEqual(store.assistantContextRevision(GID, 'me', `${GID}@conf.x`), revisionA);
});

test('service read: duplicate-gid batch leaves only final customer target despite former higher time', () => {
  const store = new ConversationStore();
  store.update([row('A', 'A-high', HIGH), row('B', 'B-low', LOW)]);
  assert.equal(store.view(GID)?.customerUid, 'B');
  assert.deepEqual(store.latestMessage(GID), { msgId: 'B-low', createTime: LOW });
});

test('service read: real high-time history cannot advance reused gid frontier; authoritative rows can', async () => {
  const base = makeDeps(call => call.url.includes('getMessageList')
    ? jsonResponse({ ResponseStatus: OK_STATUS, rangeMessage: { isDone: true, messages: [{ msgId: 'unbound-high-history', fromJid: 'A@im.x', toJid: `${GID}@conf.x`, createTime: HIGH + 1000, msgtype: 0 }] } })
    : jsonResponse({ ResponseStatus: OK_STATUS, members: [] }));
  const sdk = new FakePageSdk(), store = new ConversationStore();
  store.update([row('A', 'A-low', LOW)]);
  store.update([row('B', 'B-high', HIGH)]);
  const rpc = createRpc({ deps: { ...base, sdk }, soa: new SoaClient(base), sdk, store, roles: new RoleBook('me'),
    agent: { current: () => null, set() {} }, pushFact() {}, pushDisplay() {} });
  const result = await rpc.handle({ req_id: 'reused-history', op: 'im.messages', args: { gid: GID } });
  assert.equal(result?.ok, true);
  assert.deepEqual(store.latestMessage(GID), { msgId: 'B-high', createTime: HIGH });
  store.update([row('B', 'B-authoritative-new', HIGH + 2)]);
  assert.deepEqual(store.latestMessage(GID), { msgId: 'B-authoritative-new', createTime: HIGH + 2 });
});

for (const op of ['im.messages', 'im.message_page'] as const) {
  test(`service read: pending real RPC ${op} rejects A → B → A before history note or publication`, async () => {
    let release!: (response: ReturnType<typeof jsonResponse>) => void;
    const base = makeDeps(call => call.url.includes('getMessageList')
      ? new Promise(resolve => { release = resolve; })
      : jsonResponse({ ResponseStatus: OK_STATUS, members: [] }));
    const sdk = new FakePageSdk();
    const store = new ConversationStore();
    const originalA = row('A', 'A-high', HIGH);
    store.update([originalA]);
    const facts: AdapterFact[] = [];
    const displays: AdapterDisplayPayload[] = [];
    const rpc = createRpc({ deps: { ...base, sdk }, soa: new SoaClient(base), sdk, store, roles: new RoleBook('me'),
      agent: { current: () => null, set() {} }, pushFact: f => facts.push(f), pushDisplay: d => displays.push(d) });
    const pending = rpc.handle({ req_id: 'held-history', op, args: { gid: GID } });
    await flush();
    assert.equal(typeof release, 'function', 'the real history transport is pending before the service switches');
    store.update([row('B', 'B-low', LOW)]);
    store.update([originalA]); // byte-identical identity returns, but the service epoch differs
    const beforeRelease = store.latestMessage(GID);
    release(jsonResponse({ ResponseStatus: OK_STATUS, rangeMessage: { isDone: true, messages: [
      { msgId: 'old-history-arriving-late', messageBody: 'synthetic old body', fromJid: 'A@im.x', toJid: `${GID}@conf.x`, createTime: HIGH + 1000, msgtype: 0 },
    ] } }));
    const result = await pending;
    assert.equal(result?.ok, false, 'old history must not be accepted after A → B → A');
    if (result && !result.ok) assert.equal(result.error.code, 'adapter.not_ready');
    assert.deepEqual(store.latestMessage(GID), beforeRelease);
    assert.deepEqual(facts, []);
    assert.deepEqual(displays, []);
    assert.equal(sdk.readReceipts.length, 0);
  });
}
