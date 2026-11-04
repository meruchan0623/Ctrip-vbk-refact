import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdapterBridge, BridgeQueueError, DEFAULT_BRIDGE_CAPACITY } from './bridge.ts';
import type { AdapterFact, AdapterFactEnvelope } from '../../ipc/src/contracts.ts';
import { hostArgs } from './boot.ts';
import { AdapterCommands } from '../../ipc/src/adapterProtocol.ts';
import { ImCommands } from '../../ipc/src/commands.ts';
import { createPageSession } from './session.ts';
import { FakePageSdk, flush, jsonResponse, makeDeps, OK_STATUS, sampleRow } from './testing.ts';

const account = { account_id: 'synthetic-account', environment: 'production' as const, session_generation: 1 };
const fact = (id: number): AdapterFact => ({ kind: 'message', fact: { gid: 'room', message_id: `m${id}`, local_id: null, create_time_ms: 1700000000000 + id, sender_role: 'customer', sender_id: 'customer', kind: 'business', source: 'realtime', disposition: null } });
const code = (expected: string) => (error: unknown) => error instanceof BridgeQueueError && error.code === expected;

function slow(capacity: number) {
  const calls: AdapterFactEnvelope[] = [], releases: (() => void)[] = [], faults: unknown[] = [];
  const bridge = new AdapterBridge({ account, capacity, onQueueFault: (error, diagnostics) => faults.push({ error, diagnostics }), invoke: (_cmd, payload) => {
    calls.push(payload as AdapterFactEnvelope);
    return new Promise(resolve => releases.push(() => resolve(null)));
  } });
  return { bridge, calls, releases, faults };
}

test('slow host pressure is bounded including in-flight, faults once and never admits or silently acknowledges overflow', async () => {
  const h = slow(8);
  for (let i = 1; i <= 8; i++) h.bridge.push(fact(i));
  const drain = h.bridge.flush();
  assert.equal(h.bridge.flush(), drain, 'all flush callers share a single bounded waiter');
  await flush();
  assert.equal(h.calls.length, 1);
  for (let i = 0; i < 10_000; i++) assert.throws(() => h.bridge.push(fact(100 + i)), code('bridge.queue_overflow'));
  await assert.rejects(drain, code('bridge.queue_overflow'));
  await assert.rejects(h.bridge.flush(), code('bridge.queue_overflow'));
  assert.equal(h.bridge.flush(), h.bridge.flush());
  assert.equal(h.faults.length, 1);
  assert.equal(h.bridge.diagnostics.pending, 8);
  assert.equal(h.bridge.diagnostics.queued, 7);
  assert.equal(h.bridge.diagnostics.in_flight, 1);
  assert.equal(h.bridge.diagnostics.high_water, 8);
  assert.equal(h.bridge.diagnostics.accepted, 8);
  assert.equal(h.bridge.diagnostics.rejected, 10_000);
  assert.equal(h.bridge.diagnostics.overflow_events, 1);
  for (let i = 0; i < 8; i++) { h.releases[i]!(); await flush(); }
  assert.deepEqual(h.calls.map(e => e.seq), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(h.bridge.diagnostics.pending, 0);
  assert.equal(h.bridge.diagnostics.delivered, 8);
  assert.equal(h.bridge.diagnostics.state, 'overflow', 'draining does not pretend omitted facts were recovered');
  assert.equal(h.bridge.bumpEpoch(), 2);
  assert.equal(h.bridge.push(fact(9)).seq, 1);
  await flush(); h.releases[8]!(); await h.bridge.flush();
  assert.equal(h.bridge.diagnostics.state, 'active');
});

test('epoch replacement expires pending facts and old completions cannot flush new work or dispatch old backlog', async () => {
  const h = slow(4);
  h.bridge.push(fact(1)); h.bridge.push(fact(2)); h.bridge.push(fact(3));
  const oldDrain = h.bridge.flush(); await flush();
  h.bridge.bumpEpoch();
  await assert.rejects(oldDrain, code('bridge.epoch_expired'));
  const next = h.bridge.push(fact(4)), newDrain = h.bridge.flush();
  assert.equal(next.epoch, 2); assert.equal(next.seq, 1);
  await flush(); assert.equal(h.calls.length, 1, 'old invocation remains single-flight until settled');
  let settled = false; void newDrain.then(() => { settled = true; });
  h.releases[0]!(); await flush();
  assert.equal(settled, false);
  assert.deepEqual(h.calls.map(e => [e.epoch, e.seq]), [[1, 1], [2, 1]]);
  assert.equal(h.bridge.diagnostics.expired, 2);
  assert.equal(h.bridge.diagnostics.stale_completions, 1);
  h.releases[1]!(); await newDrain;
});

test('logout disposal and pre-dispatch cancellation release old facts without retaining a promise tail', async () => {
  const h = slow(4);
  h.bridge.push(fact(1)); h.bridge.push(fact(2));
  const drain = h.bridge.flush(); h.bridge.dispose();
  await assert.rejects(drain, code('bridge.epoch_expired'));
  await flush(); assert.equal(h.calls.length, 0);
  assert.equal(h.bridge.diagnostics.pending, 0);
  assert.equal(h.bridge.diagnostics.expired, 2);
  assert.throws(() => h.bridge.push(fact(3)), code('bridge.disposed'));
  assert.throws(() => h.bridge.bumpEpoch(), code('bridge.disposed'));
  await assert.rejects(h.bridge.flush(), code('bridge.disposed'));
  h.bridge.dispose(); assert.equal(h.bridge.diagnostics.expired, 2);
});

test('a rejected or throwing host/callback stops FIFO once without retrying or retaining failed envelopes', async () => {
  let calls = 0;
  const bridge = new AdapterBridge({ account, capacity: 4, invoke: () => {
    calls++; if (calls === 1) throw new Error('sync');
    return calls === 2 ? Promise.reject(new Error('async')) : Promise.resolve(null);
  }, onPushError() { throw new Error('observer failed'); } });
  bridge.push(fact(1)); bridge.push(fact(2)); bridge.push(fact(3)); await assert.rejects(bridge.flush(), code('bridge.delivery_failed'));
  assert.equal(calls, 1); assert.equal(bridge.diagnostics.failed, 1);
  assert.equal(bridge.diagnostics.delivered, 0); assert.equal(bridge.diagnostics.callback_errors, 1);
  assert.equal(bridge.diagnostics.pending, 0); assert.equal(bridge.diagnostics.state, 'overflow');
  assert.equal(JSON.stringify(bridge.diagnostics).includes('room'), false);
});

test('capacity validation is finite and an overflowing observer exception cannot bypass the latch', async () => {
  for (const capacity of [0, -1, NaN, Infinity, 1.5, 1_000_000]) {
    const bridge = new AdapterBridge({ account, capacity, invoke: async () => null });
    assert.equal(bridge.diagnostics.capacity, DEFAULT_BRIDGE_CAPACITY);
  }
  const bridge = new AdapterBridge({ account, capacity: 1, invoke: async () => null, onQueueFault() { throw new Error('bad observer'); } });
  bridge.push(fact(1)); assert.throws(() => bridge.push(fact(2)), code('bridge.queue_overflow'));
  assert.equal(bridge.diagnostics.callback_errors, 1);
  await assert.rejects(bridge.flush());
});

test('real session overflow stops intake, expires old facts and reports one fixed boot lease without automatic restart or outbound replay', async () => {
  const base = makeDeps(call => jsonResponse(call.url.includes('getConversationList')
    ? { ResponseStatus: OK_STATUS, conversationList: [], lastUpdateTime: base.now(), currentStatus: 0 }
    : { ResponseStatus: OK_STATUS, messages: [], lastMessageTimestamp: base.now() }));
  const sdk = new FakePageSdk(); let hold = false, release!: () => void, disposes = 0;
  sdk.dispose = () => { disposes++; };
  const deps = { ...base, sdk, invoke: (command: string, payload: unknown) => {
    if (hold && command === ImCommands.PUSH_FACT) { base.invoked.push({ cmd: command, payload }); return new Promise(resolve => { release = () => resolve(null); }); }
    return base.invoke(command, payload);
  } };
  const session = createPageSession(deps, { account, selfUid: 'self', initialEpoch: 17, beginMsgTime: base.now(), sdk, bridgeCapacity: 4, pushDisplay: async () => null });
  session.start(); await base.clock.advance(0); await session.adapter.bridge.flush();
  session.stop(); session.start(); await base.clock.advance(0); await session.adapter.bridge.flush();
  assert.equal(session.adapter.bridge.epoch, 18);
  hold = true;
  const message = (id: number) => ({ id: `m${id}`, type: 'groupchat', msgtype: '0', from: 'room@conf/customer', create_time: base.now() });
  sdk.emit('message', message(1)); await flush();
  sdk.emit('message', message(2)); sdk.emit('message', message(3)); sdk.emit('message', message(4));
  assert.doesNotThrow(() => sdk.emit('message', message(5)), 'the producer contains the already-handled terminal queue fault');
  assert.equal(session.adapter.running, false);
  assert.equal(session.adapter.compensation.running, false);
  assert.equal(session.adapter.conversationPollers.every(p => !p.running), true);
  assert.equal(disposes, 1);
  assert.equal(sdk.sent.length, 0);
  const notifications = base.invoked.filter(call => (call.payload as AdapterFactEnvelope)?.fact?.kind === 'bridge_fault');
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]!.cmd, AdapterCommands.PUSH_FACT);
  const control = { account, stream: 'im.transport', epoch: 17, seq: 0, fact: { kind: 'bridge_fault', fault: { boot_epoch: 17, reason: 'queue_overflow' } } };
  assert.deepEqual(notifications[0]!.payload, control);
  assert.deepEqual(hostArgs(notifications[0]!.cmd, notifications[0]!.payload), { envelope: control }, 'the actual boot wrapper adds exactly one named envelope');
  assert.equal(session.adapter.bridge.diagnostics.expired, 3);
  assert.equal(session.adapter.bridge.diagnostics.in_flight, 1);
  const count = base.fakeFetch.calls.length;
  session.start(); sdk.emit('socket_status', 'connected'); sdk.emit('terminal', 6);
  await base.clock.advance(60_000); assert.equal(base.fakeFetch.calls.length, count);
  assert.equal(base.invoked.filter(call => (call.payload as AdapterFactEnvelope)?.fact?.kind === 'bridge_fault').length, 1);
  release(); await flush();
  assert.equal(session.adapter.bridge.diagnostics.pending, 0);
  await assert.rejects(session.adapter.bridge.flush(), code('bridge.queue_overflow'));
  const diagnostics = await session.rpc.handle({ req_id: 'diagnostics', op: 'adapter.diagnostics', args: {} });
  assert.ok(diagnostics?.ok);
  assert.equal((diagnostics.data as { bridge: { overflow_events: number } }).bridge.overflow_events, 1);
});

test('snapshot flush settles at its captured FIFO tail even while newer facts keep arriving', async () => {
  const h = slow(8);
  h.bridge.push(fact(1)); const first = h.bridge.flush();
  assert.equal(first, h.bridge.flush());
  h.bridge.push(fact(2)); const second = h.bridge.flush();
  assert.notEqual(first, second);
  await flush();
  h.releases[0]!(); await first; await flush();
  assert.equal(h.calls.length, 2);
  assert.equal(h.bridge.diagnostics.pending, 1);
  let secondSettled = false; void second.then(() => { secondSettled = true; });
  h.bridge.push(fact(3)); await flush(); assert.equal(secondSettled, false);
  h.releases[1]!(); await second; await flush();
  assert.equal(h.calls.length, 3); assert.equal(h.bridge.diagnostics.pending, 1);
  h.releases[2]!(); await h.bridge.flush();
});

for (const producer of ['compensation', 'conversation_list'] as const) {
  test(`real ${producer} batch uses bounded backpressure without an unhandled rejection or false overload`, async () => {
    const unhandled: unknown[] = [], observe = (error: unknown) => unhandled.push(error);
    process.on('unhandledRejection', observe);
    const base = makeDeps(call => jsonResponse(call.url.includes('getConversationList')
      ? { ResponseStatus: OK_STATUS, conversationList: producer === 'conversation_list' ? Array.from({ length: 20 }, (_, index) => ({ gid: `room-${index}`, status: 1, inGroup: 1, serviceType: '1513', conversationType: 'B2C', lastUpdateTime: base.now() })) : [], lastUpdateTime: base.now() }
      : { ResponseStatus: OK_STATUS, messages: producer === 'compensation' ? Array.from({ length: 20 }, (_, index) => ({ msgId: `m-${index}`, msgtype: 0, messageBody: 'synthetic', fromJid: `room-${index}@conf/customer`, createTime: base.now() })) : [], lastMessageTimestamp: base.now() }));
    const sdk = new FakePageSdk();
    const session = createPageSession({ ...base, sdk }, { account, selfUid: 'self', initialEpoch: 11, beginMsgTime: base.now(), sdk, bridgeCapacity: 4, pushDisplay: async () => null });
    try {
      session.start(); await base.clock.advance(0); await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(session.adapter.running, true);
      assert.deepEqual(unhandled, []);
      assert.equal(base.invoked.filter(call => (call.payload as AdapterFactEnvelope)?.fact?.kind === 'bridge_fault').length, 0);
      await session.adapter.bridge.flush();
      assert.ok(session.adapter.bridge.diagnostics.high_water <= 4);
    } finally { session.stop(); sdk.dispose(); process.off('unhandledRejection', observe); }
  });
}

for (const phase of ['members', 'translation'] as const) {
  test(`overflow revokes held ${phase}, list, compensation and unread callbacks before any late output or new HTTP`, async () => {
    type Release = { url: string; resolve: (value: ReturnType<typeof jsonResponse>) => void };
    const held: Release[] = [], displays: unknown[] = [];
    let holdResponses = false, holdFacts = false, releaseFact!: () => void;
    const base = makeDeps(call => {
      if ((phase === 'members' && call.url.includes('checkMemberStatus')) || call.url.includes('batchTranslateByMsgIds') ||
        (holdResponses && (call.url.includes('getConversationList') || call.url.includes('getRecentMessages') || call.url.includes('getConversationInfoByGidList')))) {
        return new Promise(resolve => held.push({ url: call.url, resolve }));
      }
      if (call.url.includes('getConversationList')) return jsonResponse({ ResponseStatus: OK_STATUS, conversationList: [sampleRow('room')], currentStatus: 0, lastUpdateTime: base.now() });
      if (call.url.includes('checkMemberStatus')) return jsonResponse({ ResponseStatus: OK_STATUS, status: { code: 0 }, members: [{ uid: 'cust-room', roles: [0, 1, 1], nick: 'known customer' }] });
      if (call.url.includes('getRemarkList')) return jsonResponse({ ResponseStatus: OK_STATUS, bizResponseStatus: { resultCode: 'SUCCESS' }, remarkList: [] });
      return jsonResponse({ ResponseStatus: OK_STATUS, messages: [], lastMessageTimestamp: base.now() });
    });
    const sdk = new FakePageSdk();
    const deps = { ...base, sdk, invoke: (command: string, payload: unknown) => {
      if (holdFacts && command === ImCommands.PUSH_FACT) { base.invoked.push({ cmd: command, payload }); return new Promise(resolve => { releaseFact = () => resolve(null); }); }
      return base.invoke(command, payload);
    } };
    const session = createPageSession(deps, { account, selfUid: 'self', initialEpoch: 3, beginMsgTime: base.now(), sdk, bridgeCapacity: 4, pushDisplay: async value => { displays.push(value); return null; } });
    session.start(); await base.clock.advance(0); await session.adapter.bridge.flush();
    const message = (id: string) => ({ id, type: 'groupchat', msgtype: '0', body: 'source text', from: 'room@conf.x/cust-room', create_time: base.now() });
    if (phase === 'translation') { sdk.emit('message', message('before-fault')); await flush(); await session.adapter.bridge.flush(); }
    assert.ok(held.some(item => item.url.includes(phase === 'members' ? 'checkMemberStatus' : 'batchTranslateByMsgIds')));
    holdResponses = true; await base.clock.advance(10_000);
    assert.ok(held.some(item => item.url.includes('getConversationList')));
    assert.ok(held.some(item => item.url.includes('getRecentMessages')));
    holdFacts = true;
    sdk.emit('message', message('pressure-1')); await flush();
    for (let i = 2; i <= 5; i++) sdk.emit('message', message(`pressure-${i}`));
    assert.equal(session.adapter.running, false);
    const oldDisplays = displays.length, oldInvokes = base.invoked.length, oldRequests = base.fakeFetch.calls.length;
    for (const item of held) item.resolve(jsonResponse(item.url.includes('checkMemberStatus')
      ? { ResponseStatus: OK_STATUS, status: { code: 0 }, members: [{ uid: 'cust-room', roles: [0, 1, 1], nick: 'late profile' }] }
      : item.url.includes('batchTranslateByMsgIds') ? { ResponseStatus: OK_STATUS, translateMessageList: [{ msgId: 'before-fault', msgtype: 0, messageBody: 'late translation' }] }
      : item.url.includes('getConversationList') ? { ResponseStatus: OK_STATUS, conversationList: [sampleRow('room', { groupTitle: 'late row' })], currentStatus: 0, lastUpdateTime: base.now() }
      : item.url.includes('getConversationInfoByGidList') ? { ResponseStatus: OK_STATUS, bizResponseStatus: { resultCode: 'SUCCESS' }, conversationInfoList: [{ gid: 'room', unreadCount: 99 }] }
      : { ResponseStatus: OK_STATUS, messages: [{ msgId: 'late-compensation', msgtype: 0, messageBody: 'late body', fromJid: 'room@conf.x/cust-room', createTime: base.now() }], lastMessageTimestamp: base.now() }));
    releaseFact(); await flush(); await base.clock.advance(60_000);
    assert.equal(displays.length, oldDisplays, 'late callbacks cannot publish a message, profile, translation or list');
    assert.equal(base.invoked.length, oldInvokes, 'no late fact or second fault report');
    assert.equal(base.fakeFetch.calls.length, oldRequests, 'held member evidence cannot initiate remark/translation HTTP after stop');
    assert.equal(base.invoked.filter(call => (call.payload as AdapterFactEnvelope)?.fact?.kind === 'bridge_fault').length, 1);
    assert.equal(sdk.sent.length, 0); assert.equal(sdk.readReceipts.length, 0);
  });
}

test('batch admission never overwrites an existing producer or grows beyond five retained waiters', async () => {
  for (const duplicate of [true, false]) {
    const h = slow(1);
    h.bridge.push(fact(1));
    const waiting = Array.from({ length: duplicate ? 1 : 5 }, (_, i) => h.bridge.pushAsync(fact(i + 2), () => true, `producer-${i}`));
    assert.equal(h.bridge.diagnostics.waiting, duplicate ? 1 : 5);
    const rejected = h.bridge.pushAsync(fact(20), () => true, duplicate ? 'producer-0' : 'producer-5');
    assert.equal(await rejected, false);
    assert.deepEqual(await Promise.all(waiting), waiting.map(() => false));
    assert.equal(h.bridge.diagnostics.waiting, 0);
    assert.equal(h.bridge.diagnostics.waiting_high_water, duplicate ? 1 : 5);
    assert.equal(h.bridge.diagnostics.overflow_events, 1);
    assert.equal(h.faults.length, 1);
    h.bridge.dispose();
  }
});

test('normal applied resync hints and idempotent duplicate reports remain acknowledgements; old rejected invokes stay stale', async () => {
  for (const report of [{ applied: true, needs_resync: 'im.message', dropped: null }, { applied: false, needs_resync: null, dropped: 'DuplicateSeq' }, { applied: false, needs_resync: null, dropped: 'ForwardedToMain' }]) {
    const bridge = new AdapterBridge({ account, invoke: async () => report });
    bridge.push(fact(1)); await bridge.flush();
    assert.equal(bridge.diagnostics.delivered, 1); assert.equal(bridge.diagnostics.state, 'active');
  }
  let reject!: (error: Error) => void, calls = 0, faults = 0;
  const bridge = new AdapterBridge({ account, invoke: async () => { if (++calls === 1) await new Promise((_resolve, fail) => { reject = fail; }); return null; }, onQueueFault: () => { faults++; } });
  bridge.push(fact(1)); await flush(); bridge.bumpEpoch(); bridge.push(fact(2));
  reject(new Error('old page')); await bridge.flush();
  assert.equal(faults, 0); assert.equal(bridge.diagnostics.stale_completions, 1); assert.equal(bridge.diagnostics.state, 'active');
});

test('real session delivery failure reports one delivery_failed control and stops without auth_invalid or reconnect', async () => {
  const base = makeDeps(call => jsonResponse(call.url.includes('getConversationList') ? { ResponseStatus: OK_STATUS, conversationList: [], lastUpdateTime: 1700000000000 } : { ResponseStatus: OK_STATUS, messages: [], lastMessageTimestamp: 1700000000000 }));
  const sdk = new FakePageSdk(); let rejectMessages = false, disposes = 0;
  const dispose = sdk.dispose.bind(sdk); sdk.dispose = () => { disposes++; dispose(); };
  const controls: AdapterFactEnvelope[] = [];
  const session = createPageSession({ ...base, sdk, invoke: async (command, payload) => {
    const envelope = payload as AdapterFactEnvelope;
    if (command === AdapterCommands.PUSH_FACT && envelope.fact.kind === 'bridge_fault') { controls.push(envelope); return null; }
    if (rejectMessages && command === ImCommands.PUSH_FACT && envelope.fact.kind === 'message') throw new Error('synthetic rejected delivery');
    return base.invoke(command, payload);
  } }, { account, selfUid: 'self', initialEpoch: 7, beginMsgTime: base.now(), sdk, pushDisplay: async () => null });
  session.start(); await base.clock.advance(0); await session.adapter.bridge.flush();
  rejectMessages = true;
  sdk.emit('message', { id: 'failed-delivery', type: 'groupchat', msgtype: '0', body: '', from: 'room@conf.x/customer', create_time: base.now() });
  await flush();
  assert.equal(session.adapter.running, false);
  assert.deepEqual(controls.map(e => e.fact), [{ kind: 'bridge_fault', fault: { boot_epoch: 7, reason: 'delivery_failed' } }]);
  assert.equal(controls[0]?.seq, 0); assert.equal(controls[0]?.epoch, 7);
  const requests = base.fakeFetch.calls.length;
  session.start(); await base.clock.advance(60_000);
  assert.equal(session.adapter.running, false); assert.equal(base.fakeFetch.calls.length, requests);
  assert.equal(base.invoked.some(c => (c.payload as AdapterFactEnvelope)?.fact?.kind === 'auth_invalid'), false);
  assert.equal(disposes, 1); assert.equal(base.fakeSdk.sent.length, 0);
});
