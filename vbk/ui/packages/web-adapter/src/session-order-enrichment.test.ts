import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AdapterDisplayPayload } from '../../ipc/src/adapterProtocol.ts';
import { createPageSession } from './session.ts';
import { FakePageSdk, OK_STATUS, flush, jsonResponse, makeDeps, sampleRow } from './testing.ts';

const gid = '123456', orderId = '1234567890';
function card(product: string, order = orderId) { return JSON.stringify({ action: 'CTL01', ext: { title: 'synthetic title', desc: 'synthetic description', dataInfoList: [{ Id: 'orderid', text: order }, { Id: 'productName', text: product }, { Id: 'platformName', text: 'synthetic platform' }, { Id: 'orderamout', text: '18.52' }] } }); }
function frame(product: string, time = 1700000000900, order = orderId, room = gid) { return { type: 'groupchat', id: `synthetic-${time}`, from: `${room}@muc.synthetic/customer`, to: 'me@synthetic', create_time: time, msgtype: 7, body: card(product, order) }; }
function fixture(options: { holdHistory?: boolean; historyRows?: unknown[] } = {}) {
  let row: Record<string, unknown> = {}, recent: unknown[] = [];
  let releaseHistory: ((value: ReturnType<typeof jsonResponse>) => void) | null = null;
  const base = makeDeps(call => call.url.includes('getMessageList') ? options.holdHistory ? new Promise(resolve => { releaseHistory = resolve; }) : jsonResponse({ ResponseStatus: OK_STATUS, rangeMessage: { isDone: true, messages: options.historyRows ?? [] } }) : jsonResponse(call.url.includes('getConversationList') ? { ResponseStatus: OK_STATUS, conversationList: [sampleRow(gid, row)], haveRest: false }
    : call.url.includes('getRecentMessages') ? { ResponseStatus: OK_STATUS, messages: recent, lastMessageTimestamp: 1700000000000 }
    : { ResponseStatus: OK_STATUS, members: [] }));
  const sdk = new FakePageSdk(), displays: AdapterDisplayPayload[] = [];
  const session = createPageSession({ ...base, sdk }, { sdk, account: { account_id: 'synthetic', environment: 'production', session_generation: 1 }, selfUid: 'me', initialEpoch: 1, beginMsgTime: 1700000000000, pushDisplay: async payload => { displays.push(payload); } });
  const last = () => displays.flatMap(payload => payload.kind === 'conversations' ? payload.items.filter(item => item.gid === gid) : []).at(-1);
  return { base, sdk, session, displays, last, changeRow: (value: Record<string, unknown>) => { row = value; session.store.update([sampleRow(gid, row)]); }, recent: (value: unknown[]) => { recent = value; }, releaseHistory: (messages: unknown[]) => { assert.ok(releaseHistory); releaseHistory(jsonResponse({ ResponseStatus: OK_STATUS, rangeMessage: { isDone: true, messages } })); } };
}

test('session order: actual realtime CTL01 card enriches the current conversation without history loading', async () => {
  const f = fixture(); f.session.start();
  try {
    await f.base.clock.advance(50); f.sdk.emit('message', frame('new product')); await flush();
    assert.equal(f.session.store.order(gid)?.product, 'new product');
    assert.equal(f.last()?.order?.product, 'new product'); assert.equal(f.last()?.order?.source_channel, 'synthetic platform'); assert.equal(f.last()?.order?.total_amount, '18.52');
    assert.equal(f.base.fakeFetch.calls.some(call => call.url.includes('getMessageList')), false);
    await f.base.clock.advance(5000); assert.equal(f.last()?.order?.product, 'new product', 'incremental list refresh must preserve card enrichment');
  } finally { f.session.stop(); }
});

test('session order: actual compensation callback enriches matching order cards', async () => {
  const f = fixture(); f.session.start();
  try {
    await f.base.clock.advance(50);
    f.recent([{ msgId: 'synthetic-compensation', msgtype: 7, messageBody: card('compensated product'), fromJid: `${gid}@muc.synthetic/customer`, toJid: 'me@synthetic', createTime: 1700000000900 }]);
    await f.base.clock.advance(10000);
    assert.equal(f.session.store.order(gid)?.product, 'compensated product'); assert.equal(f.last()?.order?.product, 'compensated product');
  } finally { f.session.stop(); }
});

test('session order: wrong room/order and older cards cannot overwrite a newer matching order; preview time never regresses', async () => {
  const f = fixture(); f.session.start();
  try {
    await f.base.clock.advance(50); f.sdk.emit('message', frame('newest order', 1700000001000)); await flush();
    f.sdk.emit('message', { ...frame('irrelevant', 1700000003000), msgtype: 0, body: 'newest visible text' }); await flush();
    const preview = f.last()?.preview;
    f.sdk.emit('message', frame('stale order', 1700000000900)); f.sdk.emit('message', frame('wrong order', 1700000001500, '9999999')); f.sdk.emit('message', frame('wrong room', 1700000002000, orderId, '999999')); await flush();
    assert.equal(f.last()?.order?.product, 'newest order'); assert.equal(f.session.store.order(gid)?.product, 'newest order');
    f.sdk.emit('message', frame('updated order below preview', 1700000002500)); await flush();
    assert.equal(f.last()?.order?.product, 'updated order below preview', 'an older-than-preview card may still carry newer order evidence');
    assert.equal(f.last()?.preview, preview); assert.equal(f.last()?.last_message_time_ms, 1700000003000);
  } finally { f.session.stop(); }
});

test('session order: same gid/order under a new session or customer cannot inherit cached order details', async () => {
  for (const change of [{ sessionId: 'new-session' }, { uid: 'new-customer' }]) {
    const f = fixture(); f.session.start();
    try {
      await f.base.clock.advance(50); f.sdk.emit('message', frame('old service details', 1700000001000)); await flush();
      assert.equal(f.session.store.order(gid)?.product, 'old service details');
      f.changeRow(change); assert.equal(f.session.store.order(gid), null);
      await f.base.clock.advance(5000); assert.equal(f.last()?.order?.product, '');
      f.sdk.emit('message', frame('old delayed card', 1700000000900)); await flush();
      assert.equal(f.session.store.order(gid), null, 'older source evidence cannot rebind an old card to the new service');
      f.sdk.emit('message', frame('new service details', 1700000002000)); await flush();
      assert.equal(f.last()?.order?.product, 'new service details');
    } finally { f.session.stop(); }
  }
});

test('session order: queued SDK callback after stop cannot enrich the stopped session', async () => {
  const f = fixture(); f.sdk.on('message', () => f.session.stop()); f.session.start();
  await f.base.clock.advance(50); const before = f.displays.length;
  f.sdk.emit('message', frame('late stopped card')); await flush();
  assert.equal(f.session.store.order(gid), null); assert.equal(f.displays.length, before);
});

test('session order cache: an existing proven card is invalidated by service or customer identity changes', async () => {
  for (const change of [{ sessionId: 'new-session' }, { uid: 'new-customer' }]) {
    const f = fixture(); f.session.start();
    try {
      await f.base.clock.advance(50);
      f.session.store.noteOrder(gid, { order_id: orderId, product: 'old service details', use_date: '', quantity: '', status: '', contact: '' }, 1700000001000);
      assert.equal(f.session.store.order(gid)?.product, 'old service details');
      f.changeRow(change);
      assert.equal(f.session.store.order(gid), null, 'same order id is not proof of the same service/customer');
    } finally { f.session.stop(); }
  }
});

for (const seeded of [true, false]) test(`session order boundary: old-service delayed card newer than ${seeded ? 'existing cache' : 'an empty cache'} cannot bind to the successor`, async () => {
  const f = fixture(); f.session.start();
  try {
    await f.base.clock.advance(50);
    if (seeded) { f.sdk.emit('message', frame('A first', 1700000001000)); await flush(); }
    const delayed = frame('A delayed second', 1700000001500);
    f.changeRow({ sessionId: 'session-B', uid: 'customer-B', lastMessageTime: 1700000002000, lastUpdateTime: 1700000002000 });
    assert.equal(f.session.store.order(gid), null);
    f.sdk.emit('message', delayed); await flush();
    assert.equal(f.session.store.order(gid), null, 'the successor snapshot is newer than this unscoped source card');
    f.sdk.emit('message', frame('B fresh', 1700000002100)); await flush();
    assert.equal(f.session.store.order(gid)?.product, 'B fresh');
  } finally { f.session.stop(); }
});

test('session order boundary: identity change without a valid snapshot time stays blocked until a later valid snapshot', async () => {
  const f = fixture(); f.session.start();
  try {
    await f.base.clock.advance(50);
    f.changeRow({ sessionId: 'session-B', uid: 'customer-B', lastMessageTime: null, lastUpdateTime: null, lastMessageJsonString: '' });
    f.sdk.emit('message', frame('unscoped card', 1700000003000)); await flush();
    assert.equal(f.session.store.order(gid), null);
    f.changeRow({ sessionId: 'session-B', uid: 'customer-B', lastMessageTime: 1700000002500, lastUpdateTime: 1700000002500 });
    f.sdk.emit('message', frame('equal to snapshot', 1700000002500)); await flush(); assert.equal(f.session.store.order(gid), null);
    f.sdk.emit('message', frame('after boundary', 1700000003000)); await flush(); assert.equal(f.session.store.order(gid)?.product, 'after boundary');
  } finally { f.session.stop(); }
});

test('session order history: a held source from thread A cannot project or enrich thread B under the same session/customer', async () => {
  const f = fixture({ holdHistory: true }); f.session.start();
  try {
    await f.base.clock.advance(50); f.changeRow({ threadId: 'thread-A' });
    const pending = f.session.rpc.handle({ req_id: 'history-owner', op: 'im.messages', args: { gid } });
    for (let i = 0; i < 8; i++) await flush();
    f.changeRow({ threadId: 'thread-B' }); const before = f.displays.length;
    f.releaseHistory([{ msgId: 'old-thread-source', threadId: 'thread-A', fromJid: `${gid}@muc.synthetic/customer`, msgtype: 7, createTime: 1700000001500, messageBody: card('thread-A source') }]);
    const reply = await pending;
    assert.ok(reply && !reply.ok); assert.equal(reply.error.code, 'adapter.not_ready');
    assert.equal(f.session.store.order(gid), null); assert.equal(f.displays.length, before);
  } finally { f.session.stop(); }
});

test('session order history: malformed source time is never converted to a zero-time order proof', async () => {
  const f = fixture({ historyRows: [{ msgId: 'invalid-time', fromJid: `${gid}@muc.synthetic/customer`, msgtype: 7, createTime: 'invalid-time', messageBody: card('invalid source proof') }] }); f.session.start();
  try {
    await f.base.clock.advance(50); const reply = await f.session.rpc.handle({ req_id: 'invalid-source-time', op: 'im.messages', args: { gid } });
    assert.ok(reply?.ok); assert.equal(f.session.store.order(gid), null);
  } finally { f.session.stop(); }
});
