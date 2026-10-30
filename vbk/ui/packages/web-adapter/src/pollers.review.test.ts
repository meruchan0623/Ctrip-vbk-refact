/**
 * Review: poller timing, cursor chaining, stop/epoch races, auth_invalid
 * once, hostile rows (hunt items 3, 4, 5, 12).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AdapterFact, AdapterFactEnvelope } from '../../ipc/src/contracts.ts';
import type { FetchResponseLike, SdkSocketStatus } from './deps.ts';
import { SoaClient } from './soa.ts';
import { createConversationListPoller, type ConversationListItem } from './conversationList.ts';
import { createCompensationLoop } from './compensation.ts';
import { createAdapter } from './index.ts';
import { UNKNOWN_ROLES } from './facts.ts';
import { AUTH_FAILURE_STATUS, OK_STATUS, flush, jsonResponse, makeDeps, type FakeDeps } from './testing.ts';

const account = { account_id: '{{account}}', environment: 'production', session_generation: 1 };
const row = (gid: string, extra: Record<string, unknown> = {}) => ({ uid: '{{uid}}', serviceType: '1513', isOwner: false, gid, status: 2, inGroup: 1, lastMessageTime: 1700000000001, lastUpdateTime: 1700000000002, isRead: 0, star: 0, ...extra });
const msg = (id: string, t: number) => ({ msgId: id, messageBody: '{{body}}', fromJid: '{{uid}}@x', toJid: '{{gid}}@x', threadId: '', createTime: t, bizType: '1513', status: 0, msgtype: 0, isread: false });

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve: (v: T) => void = () => undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test('review/pollers: next conversation-list POST is 5000 ms after the response, not after the request', async () => {
  const deps: FakeDeps = makeDeps(
    () =>
      new Promise<FetchResponseLike>((res) => {
        deps.clock.setTimeout(() => res(jsonResponse({ ResponseStatus: OK_STATUS, conversationList: [], lastUpdateTime: 1700000001000 })), 700);
      }),
  );
  const t0 = deps.clock.now();
  const poller = createConversationListPoller(deps, new SoaClient(deps), { variant: 'plain', emit: () => undefined });
  poller.start();
  await deps.clock.advance(0);
  assert.equal(deps.fakeFetch.calls.length, 1);
  await deps.clock.advance(700); // response lands at t0+700
  assert.equal(deps.fakeFetch.calls.length, 1);
  await deps.clock.advance(4300); // t0+5000: a request-anchored timer would fire here
  assert.equal(deps.fakeFetch.calls.length, 1, 'must not fire 5 s after the request');
  await deps.clock.advance(699);
  assert.equal(deps.fakeFetch.calls.length, 1);
  await deps.clock.advance(1); // t0+5700
  assert.equal(deps.fakeFetch.calls.length, 2);
  assert.equal(deps.clock.now(), t0 + 5700);
  poller.stop();
});

test('review/pollers: a response arriving after stop() pushes nothing, reschedules nothing, leaves no timers', async () => {
  const d = deferred<FetchResponseLike>();
  const deps = makeDeps(() => d.promise);
  const facts: AdapterFact[] = [];
  const poller = createConversationListPoller(deps, new SoaClient(deps), { variant: 'plain', emit: (f) => facts.push(f) });
  poller.start();
  await deps.clock.advance(0);
  assert.equal(deps.fakeFetch.calls.length, 1);
  poller.stop();
  d.resolve(jsonResponse({ ResponseStatus: OK_STATUS, conversationList: [row('LATE')], lastUpdateTime: 1700000009000 }));
  await flush();
  await deps.clock.advance(60000);
  assert.deepEqual(facts, []);
  assert.equal(deps.fakeFetch.calls.length, 1);
  assert.equal(poller.cursor, null, 'a dropped response must not move the cursor');
  assert.equal(deps.clock.pendingCount(), 0);
});

test('review/pollers: stop()+start() while a response is in flight → old response dropped, new facts carry the new epoch', async () => {
  const old = { list: deferred<FetchResponseLike>(), comp: deferred<FetchResponseLike>() };
  let phase = 0;
  const deps = makeDeps((call) => {
    const isList = call.url.includes('getConversationList');
    if (phase === 0) return isList ? old.list.promise : old.comp.promise;
    return isList
      ? jsonResponse({ ResponseStatus: OK_STATUS, conversationList: [row('NEW')], lastUpdateTime: 1700000002000 })
      : jsonResponse({ ResponseStatus: OK_STATUS, messages: [msg('NEW-M', 1700000001000)], lastMessageTimestamp: 1700000001000 });
  });
  const adapter = createAdapter(deps, { account, initialBeginMsgTime: 1700000000000 });
  adapter.start();
  await deps.clock.advance(0);
  assert.equal(deps.fakeFetch.calls.length, 2);
  adapter.stop();
  phase = 1;
  adapter.start();
  await deps.clock.advance(0);
  assert.equal(deps.fakeFetch.calls.length, 4);
  old.list.resolve(jsonResponse({ ResponseStatus: OK_STATUS, conversationList: [row('OLD')], lastUpdateTime: 1700000009000 }));
  old.comp.resolve(jsonResponse({ ResponseStatus: OK_STATUS, messages: [msg('OLD-M', 1700000009000)], lastMessageTimestamp: 1700000009000 }));
  await flush();
  await deps.clock.advance(0);
  await adapter.bridge.flush();
  const envs = deps.invoked.map((i) => i.payload as AdapterFactEnvelope);
  assert.equal(envs.some((e) => JSON.stringify(e).includes('OLD')), false, 'late response must be dropped');
  const dataFacts = envs.filter((e) => e.fact.kind === 'conversation' || e.fact.kind === 'message');
  assert.ok(dataFacts.length >= 2);
  for (const e of dataFacts) assert.equal(e.epoch, 2);
  assert.equal(adapter.compensation.cursor, 1700000001000, 'dropped compensation response must not move beginMsgTime');
  assert.equal(adapter.conversationPollers[0]?.cursor, 1700000002000, 'dropped list response must not move startTime');
  adapter.stop();
  assert.equal(deps.clock.pendingCount(), 0);
});

test('review/pollers: auth_invalid stops every loop and is pushed exactly once per run', async () => {
  const deps = makeDeps(() => jsonResponse({ ResponseStatus: AUTH_FAILURE_STATUS }));
  const adapter = createAdapter(deps, { account, initialBeginMsgTime: 1, conversationListVariants: ['plain', 'json'] });
  adapter.start();
  await deps.clock.advance(0);
  await adapter.bridge.flush();
  const n = deps.fakeFetch.calls.length;
  assert.ok(n >= 1 && n <= 3);
  const auths = deps.invoked.filter((i) => (i.payload as AdapterFactEnvelope).fact.kind === 'auth_invalid');
  assert.equal(auths.length, 1, 'auth_invalid must be pushed once, not once per loop');
  assert.equal(adapter.compensation.running, false);
  for (const p of adapter.conversationPollers) assert.equal(p.running, false);
  await deps.clock.advance(120000);
  assert.equal(deps.fakeFetch.calls.length, n, 'no loop may keep polling after auth_invalid');
  assert.equal(deps.clock.pendingCount(), 0);
  // a restart after re-login reports again (new epoch)
  adapter.stop();
  deps.fakeFetch.set(() => jsonResponse({ ResponseStatus: AUTH_FAILURE_STATUS }));
  adapter.start();
  await deps.clock.advance(0);
  await adapter.bridge.flush();
  const auths2 = deps.invoked.filter((i) => (i.payload as AdapterFactEnvelope).fact.kind === 'auth_invalid');
  assert.equal(auths2.length, 2);
  assert.equal((auths2[1]?.payload as AdapterFactEnvelope).epoch, 2);
  adapter.stop();
});

test('review/pollers: empty increment never emits conversation facts marked full; a missing lastUpdateTime keeps the snapshot cursor', async () => {
  const deps = makeDeps((_, i) => {
    if (i === 0) return jsonResponse({ ResponseStatus: OK_STATUS, conversationList: [row('g1')] }); // no lastUpdateTime
    if (i === 1) return jsonResponse({ ResponseStatus: OK_STATUS, conversationList: [row('g1')], lastUpdateTime: 1700000001000 });
    return jsonResponse({ ResponseStatus: OK_STATUS, conversationList: [], lastUpdateTime: 1700000002000 });
  });
  const facts: AdapterFact[] = [];
  const poller = createConversationListPoller(deps, new SoaClient(deps), { variant: 'plain', emit: (f) => facts.push(f) });
  poller.start();
  await deps.clock.advance(0);
  assert.equal(poller.cursor, null);
  await deps.clock.advance(5000);
  assert.equal('startTime' in (deps.fakeFetch.calls[1]?.bodyJson as object), false, 'without a server cursor the next request is still a full snapshot');
  await deps.clock.advance(5000);
  assert.equal((deps.fakeFetch.calls[2]?.bodyJson as { startTime: number }).startTime, 1700000001000);
  const convFacts = facts.filter((f): f is Extract<AdapterFact, { kind: 'conversation' }> => f.kind === 'conversation');
  assert.deepEqual(convFacts.map((f) => f.fact.is_full_snapshot), [true, true]);
  const syncs = facts.filter((f): f is Extract<AdapterFact, { kind: 'conversation_list_sync' }> => f.kind === 'conversation_list_sync');
  assert.deepEqual(syncs.map((s) => [s.full, s.last_update_time_ms]), [[true, null], [true, 1700000001000], [false, 1700000002000]]);
  poller.stop();
});

test('review/pollers: hostile conversationList rows never throw and never kill the loop', async () => {
  const hostile = [null, undefined, 1, 'x', [], {}, { gid: 5 }, { gid: '' }, { gid: 'ok', status: '2', inGroup: '1', isOwner: 1, serviceType: null, lastMessageTime: 'abc' }] as unknown as ConversationListItem[];
  const deps = makeDeps((_, i) => (i === 0 ? jsonResponse({ ResponseStatus: OK_STATUS, conversationList: hostile, lastUpdateTime: 1700000001000 }) : jsonResponse({ ResponseStatus: OK_STATUS, conversationList: 'nope', lastUpdateTime: 1700000002000 })));
  const facts: AdapterFact[] = [];
  const poller = createConversationListPoller(deps, new SoaClient(deps), { variant: 'plain', emit: (f) => facts.push(f) });
  poller.start();
  await deps.clock.advance(0);
  assert.deepEqual(
    facts.map((f) => f.kind),
    ['conversation', 'conversation_list_sync'],
  );
  const ok = facts[0] as Extract<AdapterFact, { kind: 'conversation' }>;
  assert.deepEqual(ok.fact, { gid: 'ok', status: 'unknown', agent_in_group: false, is_owner: false, service_type: '', last_message_time_ms: null, last_update_time_ms: null, unread_count: 0, is_full_snapshot: true });
  await deps.clock.advance(5000);
  assert.equal(deps.fakeFetch.calls.length, 2, 'loop must survive hostile rows');
  assert.equal(facts.length, 3);
  poller.stop();
});

test('review/pollers: compensation chains beginMsgTime from lastMessageTimestamp (string tolerated) and survives hostile messages', async () => {
  const deps = makeDeps((_, i) => {
    if (i === 0) return jsonResponse({ ResponseStatus: OK_STATUS, messages: [null, 7, 'x', [], { msgId: 'bad', createTime: 'abc' }, msg('ok', 1700000000100)], localIds: null, lastMessageTimestamp: '1700000000100' });
    if (i === 1) return jsonResponse({ ResponseStatus: OK_STATUS, messages: {}, lastMessageTimestamp: null });
    return jsonResponse({ ResponseStatus: OK_STATUS });
  });
  const facts: AdapterFact[] = [];
  const loop = createCompensationLoop(deps, new SoaClient(deps), { emit: (f) => facts.push(f), roles: UNKNOWN_ROLES, initialBeginMsgTime: 1699999999000 });
  loop.start('connected');
  await deps.clock.advance(0);
  assert.deepEqual(
    facts.map((f) => f.kind),
    ['message', 'compensation_sync'],
  );
  assert.equal(loop.cursor, 1700000000100);
  await deps.clock.advance(10000);
  assert.equal((deps.fakeFetch.calls[1]?.bodyJson as { beginMsgTime: number }).beginMsgTime, 1700000000100);
  assert.equal(loop.cursor, 1700000000100, 'null lastMessageTimestamp keeps the watermark');
  assert.deepEqual(facts[2], { kind: 'compensation_sync', last_message_timestamp_ms: null });
  await deps.clock.advance(10000);
  assert.equal(deps.fakeFetch.calls.length, 3);
  assert.equal((deps.fakeFetch.calls[2]?.bodyJson as { beginMsgTime: number }).beginMsgTime, 1700000000100);
  loop.stop();
});

test('review/pollers: a compensation response arriving after a transport-driven restart is dropped and does not move the cursor', async () => {
  const d = deferred<FetchResponseLike>();
  const deps = makeDeps((_, i) => (i === 0 ? d.promise : jsonResponse({ ResponseStatus: OK_STATUS, lastMessageTimestamp: 1700000002000 })));
  const facts: AdapterFact[] = [];
  const loop = createCompensationLoop(deps, new SoaClient(deps), { emit: (f) => facts.push(f), roles: UNKNOWN_ROLES, initialBeginMsgTime: 1 });
  loop.start('connected');
  await deps.clock.advance(0);
  loop.setTransport('disconnected'); // restart → generation bump → second request
  await deps.clock.advance(0);
  assert.equal(deps.fakeFetch.calls.length, 2);
  assert.equal(loop.cursor, 1700000002000);
  d.resolve(jsonResponse({ ResponseStatus: OK_STATUS, messages: [msg('OLD', 1700000009000)], lastMessageTimestamp: 1700000009000 }));
  await flush();
  await deps.clock.advance(0);
  assert.equal(facts.some((f) => f.kind === 'message'), false);
  assert.equal(loop.cursor, 1700000002000);
  assert.equal(loop.mode, 'frequent');
  await deps.clock.advance(5000);
  assert.equal(deps.fakeFetch.calls.length, 3);
  loop.stop();
  assert.equal(deps.clock.pendingCount(), 0);
});

test('review/pollers: an unknown SDK socket status never reaches the host as an invalid TransportState', async () => {
  const deps = makeDeps(() => jsonResponse({ ResponseStatus: OK_STATUS, conversationList: [], lastUpdateTime: 1, lastMessageTimestamp: 1 }));
  const adapter = createAdapter(deps, { account, initialBeginMsgTime: 1 });
  adapter.start();
  deps.fakeSdk.emit('socket_status', 'weird' as unknown as SdkSocketStatus);
  deps.fakeSdk.emit('socket_status', null as unknown as SdkSocketStatus);
  await adapter.bridge.flush();
  const states = deps.invoked.map((i) => i.payload as AdapterFactEnvelope).filter((e) => e.fact.kind === 'transport').map((e) => (e.fact as { state: string }).state);
  for (const s of states) assert.ok(['connecting', 'connected', 'disconnected', 'reconnecting'].includes(s), s);
  adapter.stop();
});
