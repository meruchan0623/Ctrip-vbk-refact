import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AdapterFact } from '../../ipc/src/contracts.ts';
import { SoaClient } from './soa.ts';
import { createPageRequestObserver } from './pageContext.ts';
import { createConversationListPoller, mapConversationStatus, toConversationFact } from './conversationList.ts';
import { AUTH_FAILURE_STATUS, OK_STATUS, jsonResponse, makeDeps } from './testing.ts';

const row = (gid: string, extra: Record<string, unknown> = {}) => ({
  uid: '{{uid}}',
  serviceType: '1513',
  isOwner: false,
  gid,
  status: 2,
  inGroup: 1,
  lastMessageTime: 1700000000001,
  lastUpdateTime: 1700000000002,
  isRead: 0,
  star: 0,
  ...extra,
});

test('status mapping table with unknown default', () => {
  assert.equal(mapConversationStatus(2), 'active');
  assert.equal(mapConversationStatus(4), 'finished');
  assert.equal(mapConversationStatus(3), 'unknown');
  assert.equal(mapConversationStatus('2'), 'unknown');
  assert.equal(mapConversationStatus(undefined), 'unknown');
});

test('row → ConversationFact only from fields present in the contract doc', () => {
  const fact = toConversationFact(row('g1', { isOwner: true, inGroup: -1, status: 4 }), true);
  assert.deepEqual(fact, {
    gid: 'g1',
    status: 'finished',
    agent_in_group: false,
    is_owner: true,
    service_type: '1513',
    last_message_time_ms: 1700000000001,
    last_update_time_ms: 1700000000002,
    unread_count: 0,
    is_full_snapshot: true,
  });
  assert.equal(toConversationFact({ status: 2 }, true), null);
  const noLast = toConversationFact(row('g2', { lastMessageTime: undefined }), false);
  assert.equal(noLast?.last_message_time_ms, null);
  assert.equal(noLast?.is_full_snapshot, false);
  const unread = toConversationFact(row('g3'), false, { unreadOf: (g) => (g === 'g3' ? 7 : null) });
  assert.equal(unread?.unread_count, 7);
});

test('poller: first body, 5 s after response, startTime chaining, empty increment → sync only', async () => {
  const deps = makeDeps((_, i) => {
    if (i === 0) return jsonResponse({ ResponseStatus: OK_STATUS, conversationList: [row('g1'), row('g2')], currentStatus: 3, lastUpdateTime: 1700000001000, haveRest: false });
    if (i === 1) return jsonResponse({ ResponseStatus: OK_STATUS, conversationList: [], currentStatus: 3, lastUpdateTime: 1700000006000, haveRest: false });
    return jsonResponse({ ResponseStatus: OK_STATUS, conversationList: [row('g1', { status: 4 })], currentStatus: 3, lastUpdateTime: 1700000011000, haveRest: false });
  });
  const facts: AdapterFact[] = [];
  const poller = createConversationListPoller(deps, new SoaClient(deps), { variant: 'plain', emit: (f) => facts.push(f) });
  poller.start();
  await deps.clock.advance(0);
  assert.equal(deps.fakeFetch.calls.length, 1);
  assert.deepEqual(Object.keys(deps.fakeFetch.calls[0]?.bodyJson as object), ['head', 'needTodoList']);
  assert.equal((deps.fakeFetch.calls[0]?.bodyJson as { needTodoList: unknown }).needTodoList, 1);
  assert.equal(deps.fakeFetch.calls[0]?.url.startsWith('https://m.ctrip.com/restapi/soa2/16037/getConversationList?'), true);
  assert.deepEqual(
    facts.map((f) => f.kind),
    ['conversation', 'conversation', 'conversation_list_sync'],
  );
  assert.deepEqual(facts[2], { kind: 'conversation_list_sync', full: true, last_update_time_ms: 1700000001000 });
  assert.equal((facts[0] as { fact: { is_full_snapshot: boolean } }).fact.is_full_snapshot, true);

  await deps.clock.advance(4999);
  assert.equal(deps.fakeFetch.calls.length, 1);
  await deps.clock.advance(1);
  assert.equal(deps.fakeFetch.calls.length, 2);
  assert.equal((deps.fakeFetch.calls[1]?.bodyJson as { startTime: number }).startTime, 1700000001000);
  // empty increment → only a sync fact, cursor advances
  assert.equal(facts.length, 4);
  assert.deepEqual(facts[3], { kind: 'conversation_list_sync', full: false, last_update_time_ms: 1700000006000 });

  await deps.clock.advance(5000);
  assert.equal(deps.fakeFetch.calls.length, 3);
  assert.equal((deps.fakeFetch.calls[2]?.bodyJson as { startTime: number }).startTime, 1700000006000);
  assert.equal(facts.length, 6);
  assert.equal((facts[4] as { fact: { is_full_snapshot: boolean; status: string } }).fact.is_full_snapshot, false);
  assert.equal((facts[4] as { fact: { status: string } }).fact.status, 'finished');

  poller.stop();
  await deps.clock.advance(20000);
  assert.equal(deps.fakeFetch.calls.length, 3);
  assert.equal(poller.cursor, 1700000011000);
});

test('poller: .json variant with locale is a separate endpoint', async () => {
  const deps = makeDeps(() => jsonResponse({ ResponseStatus: OK_STATUS, conversationList: [], lastUpdateTime: 1700000001000 }));
  const poller = createConversationListPoller(deps, new SoaClient(deps), { variant: 'json', includeLocale: true, emit: () => undefined });
  poller.start();
  await deps.clock.advance(0);
  assert.equal(deps.fakeFetch.calls[0]?.url.includes('/16037/getConversationList.json?'), true);
  assert.deepEqual(Object.keys(deps.fakeFetch.calls[0]?.bodyJson as object), ['head', 'needTodoList', 'locale']);
  poller.stop();
});

test('poller: auth_invalid stops and emits auth_invalid', async () => {
  const deps = makeDeps(() => jsonResponse({ ResponseStatus: AUTH_FAILURE_STATUS }));
  const facts: AdapterFact[] = [];
  const poller = createConversationListPoller(deps, new SoaClient(deps), { variant: 'plain', emit: (f) => facts.push(f) });
  poller.start();
  await deps.clock.advance(0);
  assert.deepEqual(facts, [{ kind: 'auth_invalid' }]);
  assert.equal(poller.running, false);
  await deps.clock.advance(60000);
  assert.equal(deps.fakeFetch.calls.length, 1);
});

test('poller: transient failure keeps polling without emitting facts', async () => {
  const deps = makeDeps((_, i) => (i === 0 ? jsonResponse('', 502) : jsonResponse({ ResponseStatus: OK_STATUS, conversationList: [], lastUpdateTime: 1 })));
  const facts: AdapterFact[] = [];
  const poller = createConversationListPoller(deps, new SoaClient(deps), { variant: 'plain', emit: (f) => facts.push(f) });
  poller.start();
  await deps.clock.advance(0);
  assert.equal(facts.length, 0);
  await deps.clock.advance(5000);
  assert.equal(deps.fakeFetch.calls.length, 2);
  // the retry after a failure is still a full snapshot (no cursor yet)
  assert.equal('startTime' in (deps.fakeFetch.calls[1]?.bodyJson as object), false);
  poller.stop();
});

test('official loop: thirty minute buckets have zero adapter list requests; official full/incremental bodies feed facts', async () => {
  const deps = makeDeps();
  const requests = createPageRequestObserver(deps.now);
  const facts: AdapterFact[] = [];
  const poller = createConversationListPoller(deps, new SoaClient(deps), { variant: 'plain', officialRequests: requests, emit: fact => facts.push(fact) });
  poller.start();
  const buckets = new Array<number>(30).fill(0);
  for (let i = 0; i < 360; i++) {
    const request = requests.begin('https://m.ctrip.com/restapi/soa2/16037/getConversationList', JSON.stringify(i === 0 ? {} : { startTime: 1700000000000 + i * 5000 }), 'official')!;
    requests.complete(request, 200, { ResponseStatus: OK_STATUS, conversationList: i === 0 ? [row('g1')] : [], lastUpdateTime: 1700000000000 + (i + 1) * 5000 });
    await deps.clock.advance(5000);
    buckets[Math.floor(i / 12)] = deps.fakeFetch.calls.length;
  }
  assert.deepEqual(buckets, new Array<number>(30).fill(0));
  assert.equal(facts.filter(f => f.kind === 'conversation_list_sync').length, 360);
  assert.deepEqual(facts[1], { kind: 'conversation_list_sync', full: true, last_update_time_ms: 1700000005000 });
  assert.equal(poller.cursor, 1700001800000);
  poller.stop();
});

test('fallback obeys visible gate, five-second minimum including transport errors, and exponential backoff', async () => {
  const deps = makeDeps(() => new Error('offline'));
  let visible = true;
  let changed = () => {};
  const poller = createConversationListPoller(deps, new SoaClient(deps), { variant: 'plain', intervalMs: 1, emit: () => {}, visibility: { visible: () => visible, subscribe: cb => { changed = cb; return () => {}; } } });
  poller.start();
  await deps.clock.advance(4999);
  assert.equal(deps.fakeFetch.calls.length, 1, 'SoaClient must not instantly retry a cadence read');
  await deps.clock.advance(1);
  assert.equal(deps.fakeFetch.calls.length, 2);
  await deps.clock.advance(9999);
  assert.equal(deps.fakeFetch.calls.length, 2);
  await deps.clock.advance(1);
  assert.equal(deps.fakeFetch.calls.length, 3);
  visible = false; changed();
  await deps.clock.advance(600000);
  assert.equal(deps.fakeFetch.calls.length, 3);
  visible = true; changed();
  await deps.clock.advance(4999);
  assert.equal(deps.fakeFetch.calls.length, 3);
  await deps.clock.advance(1);
  assert.equal(deps.fakeFetch.calls.length, 4);
  poller.stop();
});

test('official request supersedes in-flight adapter result; out-of-order official and stopped-epoch responses are ignored', async () => {
  let release!: (response: ReturnType<typeof jsonResponse>) => void;
  const deps = makeDeps(() => new Promise(resolve => { release = resolve; }));
  const requests = createPageRequestObserver(deps.now);
  const facts: AdapterFact[] = [];
  const poller = createConversationListPoller(deps, new SoaClient(deps), { variant: 'plain', officialRequests: requests, emit: fact => facts.push(fact) });
  poller.start(); await deps.clock.advance(5000);
  const older = requests.begin('https://m.ctrip.com/restapi/soa2/16037/getConversationList', '{}', 'official')!;
  const newer = requests.begin('https://m.ctrip.com/restapi/soa2/16037/getConversationList', '{"startTime":1700000000100}', 'official')!;
  requests.complete(newer, 200, { ResponseStatus: OK_STATUS, conversationList: [row('new')], lastUpdateTime: 1700000000300 });
  requests.complete(older, 200, { ResponseStatus: OK_STATUS, conversationList: [row('old')], lastUpdateTime: 1700000000200 });
  release(jsonResponse({ ResponseStatus: OK_STATUS, conversationList: [row('adapter-old')] }));
  await deps.clock.advance(0);
  assert.deepEqual(facts.filter(f => f.kind === 'conversation').map(f => f.fact.gid), ['new']);
  assert.equal((facts.find(f => f.kind === 'conversation') as { fact: { is_full_snapshot: boolean } }).fact.is_full_snapshot, false);
  const pending = requests.begin('https://m.ctrip.com/restapi/soa2/16037/getConversationList', '{}', 'official')!;
  poller.stop(); poller.start();
  requests.complete(pending, 200, { ResponseStatus: OK_STATUS, conversationList: [row('previous-epoch')] });
  assert.equal(facts.filter(f => f.kind === 'conversation').length, 1);
  poller.stop();
});

test('boot handoff consumes a completed official full snapshot once; stopping the official loop enables fallback after the lease', async () => {
  const deps = makeDeps(() => jsonResponse({ ResponseStatus: OK_STATUS, conversationList: [] }));
  const requests = createPageRequestObserver(deps.now);
  const request = requests.begin('https://m.ctrip.com/restapi/soa2/16037/getConversationList', '{}', 'official')!;
  requests.complete(request, 200, { ResponseStatus: OK_STATUS, conversationList: [row('boot')] });
  const facts: AdapterFact[] = [];
  const poller = createConversationListPoller(deps, new SoaClient(deps), { variant: 'plain', officialRequests: requests, emit: fact => facts.push(fact) });
  poller.start();
  assert.equal(facts.filter(f => f.kind === 'conversation').length, 1);
  await deps.clock.advance(14999); assert.equal(deps.fakeFetch.calls.length, 0);
  await deps.clock.advance(1); assert.equal(deps.fakeFetch.calls.length, 1);
  poller.stop(); poller.start();
  assert.equal(facts.filter(f => f.kind === 'conversation').length, 1);
  poller.stop();
});
