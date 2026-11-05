import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPageSession } from './session.ts';
import { FakePageSdk, OK_STATUS, jsonResponse, makeDeps, sampleRow, flush } from './testing.ts';
import type { AdapterDisplayPayload } from '../../ipc/src/adapterProtocol.ts';
const GID = '123456', TIME = 1700000009000;
const event = (gid = GID, extra: Record<string, unknown> = {}) => ({ id: `early-${gid}`, type: 'groupchat', msgtype: '0', create_time: String(TIME), from: `${gid}@conf.x/cust-${gid}`, to: 'me@x', body: 'SYNTHETIC NEW PREVIEW', ...extra });
function fixture(compensation: unknown[] = []) {
  const lists: ((value: ReturnType<typeof jsonResponse>) => void)[] = [];
  let offset = 0;
  const base = makeDeps(call => call.url.includes('getConversationList') ? new Promise(resolve => lists.push(resolve))
    : call.url.includes('getRecentMessages') ? jsonResponse({ ResponseStatus: OK_STATUS, messages: compensation, lastMessageTimestamp: 1700000000000 })
    : jsonResponse({ ResponseStatus: OK_STATUS, members: [], bizResponseStatus: { resultCode: 'SUCCESS' }, conversationInfoList: [] }));
  const sdk = new FakePageSdk(), displays: AdapterDisplayPayload[] = [];
  const session = createPageSession({ ...base, now: () => base.clock.now() + offset, sdk }, { account: { account_id: 'synthetic', environment: 'production', session_generation: 1 }, selfUid: 'me', beginMsgTime: 1700000000000, initialEpoch: 1, sdk, pushDisplay: async p => { displays.push(p); } });
  const start = async () => { session.start(); await flush(); };
  const release = async (rows: unknown[]) => { const done = lists.shift(); assert.ok(done); done(jsonResponse({ ResponseStatus: OK_STATUS, conversationList: rows, currentStatus: 0, lastUpdateTime: 1700000000600, haveRest: false })); await flush(); };
  const last = (gid = GID) => displays.flatMap(d => d.kind === 'conversations' ? d.items : []).filter(d => d.gid === gid).at(-1);
  return { base, sdk, session, displays, start, release, last, expire: () => { offset = 60_001; } };
}

test('first list retains newer customer SDK preview, with no additional HTTP or SDK write', async () => {
  const f = fixture(); await f.start(); try {
    const calls = f.base.fakeFetch.calls.length;
    f.sdk.emit('message', event()); await flush(); assert.equal(f.base.fakeFetch.calls.length, calls);
    await f.release([sampleRow(GID)]);
    assert.equal(f.session.store.latestMessage(GID)?.msgId, 'm-' + GID, 'preview evidence is not a current-service read frontier');
    assert.equal(f.last()?.last_message_time_ms, TIME); assert.equal(f.last()?.preview, 'SYNTHETIC NEW PREVIEW');
  } finally { f.session.stop(); }
});

test('first list retains newer compensation preview using the same customer, room and snapshot fence', async () => {
  const f = fixture([{ msgId: 'comp', createTime: TIME, fromJid: `cust-${GID}@x`, toJid: `${GID}@conf.x`, msgtype: 0, messageBody: 'SYNTHETIC COMPENSATION PREVIEW' }]);
  await f.start(); try { await f.release([sampleRow(GID)]); assert.equal(f.last()?.last_message_time_ms, TIME); assert.equal(f.last()?.preview, 'SYNTHETIC COMPENSATION PREVIEW'); } finally { f.session.stop(); }
});

for (const [label, changes] of [
  ['customer', { uid: 'different-customer' }],
  ['room domain', { lastMessageJsonString: JSON.stringify({ msgId: 'row', createTime: 1700000000500, toJid: `${GID}@other.x`, fromJid: `cust-${GID}@x`, msgtype: 0, messageBody: 'row' }) }],
  ['thread', { threadId: 'other-thread' }],
  ['snapshot after message', { lastUpdateTime: TIME + 1 }],
  ['missing snapshot fence', { lastUpdateTime: null }],
  ['missing session', { sessionId: null }],
] as const) test(`pending preview is not guessed across ${label}`, async () => {
  const f = fixture(); await f.start(); try { f.sdk.emit('message', event()); await f.release([sampleRow(GID, changes)]); assert.notEqual(f.last()?.preview, 'SYNTHETIC NEW PREVIEW'); } finally { f.session.stop(); }
});

test('self/unknown customer evidence cannot bind a pending preview merely by gid', async () => {
  const f = fixture(); await f.start(); try { f.sdk.emit('message', event(GID, { from: `${GID}@conf.x/me` })); await f.release([sampleRow(GID)]); assert.notEqual(f.last()?.preview, 'SYNTHETIC NEW PREVIEW'); } finally { f.session.stop(); }
});

test('pending preview TTL and 256-room bound prevent indefinite retention', async () => {
  const f = fixture(); await f.start(); try {
    f.sdk.emit('message', event()); f.expire(); await f.release([sampleRow(GID)]); assert.notEqual(f.last()?.preview, 'SYNTHETIC NEW PREVIEW');
  } finally { f.session.stop(); }
  const g = fixture(); await g.start(); try {
    for (let i = 0; i < 257; i++) g.sdk.emit('message', event(String(100000 + i)));
    await g.release([sampleRow('100000'), sampleRow('100001')]);
    assert.notEqual(g.last('100000')?.preview, 'SYNTHETIC NEW PREVIEW'); assert.equal(g.last('100001')?.preview, 'SYNTHETIC NEW PREVIEW');
  } finally { g.session.stop(); }
});

for (const [label, changes] of [
  ['session', { sessionId: 'new-session' }], ['customer', { uid: 'new-customer' }], ['service', { serviceType: 'other' }],
  ['thread', { threadId: 'new-thread' }], ['key', { conversationKey: 'new-key' }], ['worksheet', { id: 9002 }],
  ['order', { relationOrderId: '9988776655', ext: { orderId: '9988776655' } }],
] as const) test(`accepted preview is revoked when the same gid changes ${label}`, async () => {
  const f = fixture(); await f.start(); try {
    f.sdk.emit('message', event()); await f.release([sampleRow(GID)]); assert.equal(f.last()?.preview, 'SYNTHETIC NEW PREVIEW');
    await f.base.clock.advance(5000); await f.release([sampleRow(GID, changes)]); assert.notEqual(f.last()?.preview, 'SYNTHETIC NEW PREVIEW');
  } finally { f.session.stop(); }
});


test('stop/restart clears unbound pending evidence before a new first snapshot', async () => {
  const f = fixture(); await f.start(); try {
    f.sdk.emit('message', event()); f.session.stop(); f.session.start(); await flush();
    await f.release([sampleRow(GID)]); // the old lifecycle response is ignored
    await f.release([sampleRow(GID)]);
    assert.notEqual(f.last()?.preview, 'SYNTHETIC NEW PREVIEW');
  } finally { f.session.stop(); }
});

test('first mismatching customer consumes pending evidence; a later matching row cannot resurrect it', async () => {
  const f = fixture(); await f.start(); try {
    f.sdk.emit('message', event()); await f.release([sampleRow(GID, { uid: 'other-customer' })]);
    await f.base.clock.advance(5000); await f.release([sampleRow(GID)]);
    assert.notEqual(f.last()?.preview, 'SYNTHETIC NEW PREVIEW');
  } finally { f.session.stop(); }
});

test('matching explicit thread can bind and retained content is restricted to 200 preview characters', async () => {
  const f = fixture(); await f.start(); try {
    f.sdk.emit('message', event(GID, { threadid: 'synthetic-thread', body: 'X'.repeat(5000) }));
    await f.release([sampleRow(GID, { threadId: 'synthetic-thread' })]);
    assert.equal(f.last()?.last_message_time_ms, TIME); assert.equal(f.last()?.preview, 'X'.repeat(200));
  } finally { f.session.stop(); }
});


test('pending order-card preview cannot cross the row order identity', async () => {
  const f = fixture(); await f.start(); try {
    const body = JSON.stringify({ action: 'CTL01', ext: { dataInfoList: [{ Id: 'orderid', text: '9988776655' }, { Id: 'productName', text: 'SYNTHETIC OTHER ORDER' }] } });
    f.sdk.emit('message', event(GID, { msgtype: 7, body })); await f.release([sampleRow(GID)]);
    assert.notEqual(f.last()?.preview, 'SYNTHETIC OTHER ORDER');
  } finally { f.session.stop(); }
});


test('duplicate gid rows cannot combine an earlier snapshot fence with a later service identity', async () => {
  const f = fixture(); await f.start(); try {
    f.sdk.emit('message', event());
    await f.release([sampleRow(GID), sampleRow(GID, { sessionId: 'new-service', lastUpdateTime: TIME + 1 })]);
    assert.notEqual(f.last()?.preview, 'SYNTHETIC NEW PREVIEW');
  } finally { f.session.stop(); }
});


test('duplicate embedded rows cannot stamp customer A preview with customer B identity', async () => {
  const f = fixture(); await f.start(); try {
    const a = sampleRow(GID, { uid: 'customer-A', sessionId: 'session-A', groupTitle: 'CUSTOMER A', lastMessageTime: TIME,
      lastMessageJsonString: JSON.stringify({ msgId: 'a', fromJid: 'customer-A@x', toJid: `${GID}@conf.x`, createTime: TIME, msgtype: 0, messageBody: 'SYNTHETIC PRIVATE A' }) });
    const b = sampleRow(GID, { uid: 'customer-B', sessionId: 'session-B', groupTitle: 'CUSTOMER B', lastUpdateTime: TIME + 1000,
      lastMessageJsonString: JSON.stringify({ msgId: 'b', fromJid: 'customer-B@x', toJid: `${GID}@conf.x`, createTime: 1700000000500, msgtype: 0, messageBody: 'SYNTHETIC CUSTOMER B' }) });
    await f.release([a, b]);
    assert.equal(f.last()?.title, 'customer-B'); assert.equal(f.last()?.preview, 'SYNTHETIC CUSTOMER B');
    assert.equal(f.last()?.last_message_time_ms, 1700000000500);
    assert.equal(f.displays.flatMap(d => d.kind === 'conversations' ? d.items : []).some(d => d.preview === 'SYNTHETIC PRIVATE A'), false);
  } finally { f.session.stop(); }
});

test('reused gid late former-customer high-time message cannot mask the current authoritative preview/read frontier', async () => {
  const f = fixture(); await f.start();
  const currentB = (id: string, time: number) => sampleRow(GID, { uid: 'customer-B', sessionId: 'service-B', lastMessageTime: time, lastMessageJsonString: JSON.stringify({ msgId: id, fromJid: 'customer-B@x', toJid: GID + '@conf.x', createTime: time, msgtype: 0, messageBody: 'CURRENT B' }) });
  try {
    await f.release([sampleRow(GID)]);
    await f.base.clock.advance(5000); await f.release([currentB('B-first', 1700000001000)]);
    f.sdk.emit('message', event(GID, { id: 'late-former-A', create_time: String(TIME), body: 'OLD A HIGH' })); await flush();
    assert.notEqual(f.last()?.preview, 'OLD A HIGH');
    await f.base.clock.advance(5000); await f.release([currentB('B-current', 1700000001200)]);
    assert.equal(f.last()?.preview, 'CURRENT B');
    assert.equal(f.last()?.read_target_message_id, 'B-current');
    assert.equal(f.session.store.latestMessage(GID)?.msgId, 'B-current');
    assert.equal(f.sdk.readReceipts.length, 0);
  } finally { f.session.stop(); }
});
