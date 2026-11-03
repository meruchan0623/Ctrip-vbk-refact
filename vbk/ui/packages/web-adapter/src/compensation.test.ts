import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AdapterFact } from '../../ipc/src/contracts.ts';
import { SoaClient } from './soa.ts';
import { DEFAULT_NORMAL_LOOP_STOP_AFTER_MS, MAX_BACKOFF_MS, MIN_REQUEST_INTERVAL_MS, createCompensationLoop, resolveNormalLoopStopAfterMs } from './compensation.ts';
import { UNKNOWN_ROLES } from './facts.ts';
import type { FetchResponseLike } from './deps.ts';
import { AUTH_FAILURE_STATUS, OK_STATUS, flush, jsonResponse, makeDeps } from './testing.ts';

const msg = (id: string, t: number) => ({ msgId: id, messageBody: '{{body}}', fromJid: '{{uid}}@x', toJid: '{{gid}}@x', threadId: '', createTime: t, bizType: '1513', status: 0, msgtype: 0, isread: false });

test('compensation: sdk head, beginMsgTime chaining, 10 s cadence when connected, facts + sync', async () => {
  const deps = makeDeps((_, i) =>
    i === 0
      ? jsonResponse({ ResponseStatus: OK_STATUS, messages: [msg('m1', 1700000000100)], localIds: [], lastMessageTimestamp: 1700000000100 })
      : jsonResponse({ ResponseStatus: OK_STATUS, lastMessageTimestamp: 1700000000100 }),
  );
  const facts: AdapterFact[] = [];
  const loop = createCompensationLoop(deps, new SoaClient(deps), { emit: (f) => facts.push(f), roles: UNKNOWN_ROLES, initialBeginMsgTime: 1699999999000 });
  loop.start('connected');
  await deps.clock.advance(0);
  const body = deps.fakeFetch.calls[0]?.bodyJson as { beginMsgTime: number; pageSize: number; head: { cver: string } };
  assert.equal(body.beginMsgTime, 1699999999000);
  assert.equal(body.pageSize, 100);
  assert.equal(body.head.cver, '1.0.7');
  assert.equal(deps.fakeFetch.calls[0]?.url.includes('/11679/getRecentMessages'), true);
  assert.equal(facts.length, 2);
  assert.equal(facts[0]?.kind, 'message');
  assert.equal((facts[0] as { fact: { source: string; message_id: string } }).fact.source, 'compensation');
  assert.deepEqual(facts[1], { kind: 'compensation_sync', last_message_timestamp_ms: 1700000000100 });
  assert.equal(loop.mode, 'normal');

  await deps.clock.advance(9999);
  assert.equal(deps.fakeFetch.calls.length, 1);
  await deps.clock.advance(1);
  assert.equal(deps.fakeFetch.calls.length, 2);
  assert.equal((deps.fakeFetch.calls[1]?.bodyJson as { beginMsgTime: number }).beginMsgTime, 1700000000100);
  assert.equal(facts.length, 3);
  loop.stop();
});

test('compensation: frequent 5 s cadence when transport is not connected; switching back restores normal', async () => {
  const deps = makeDeps(() => jsonResponse({ ResponseStatus: OK_STATUS, lastMessageTimestamp: 1700000000100 }));
  const loop = createCompensationLoop(deps, new SoaClient(deps), { emit: () => undefined, roles: UNKNOWN_ROLES, initialBeginMsgTime: 1 });
  loop.start('disconnected');
  await deps.clock.advance(0);
  assert.equal(loop.mode, 'frequent');
  assert.equal(deps.fakeFetch.calls.length, 1);
  await deps.clock.advance(5000);
  assert.equal(deps.fakeFetch.calls.length, 2);
  loop.setTransport('reconnecting');
  await deps.clock.advance(0);
  assert.equal(deps.fakeFetch.calls.length, 2, 'a mode change does not bypass the 5 s request floor');
  loop.setTransport('connected');
  await deps.clock.advance(0);
  assert.equal(loop.mode, 'normal');
  assert.equal(deps.fakeFetch.calls.length, 2);
  await deps.clock.advance(4999);
  assert.equal(deps.fakeFetch.calls.length, 2);
  await deps.clock.advance(1);
  assert.equal(deps.fakeFetch.calls.length, 3, 'restart round fires once the floor allows it');
  await deps.clock.advance(9999);
  assert.equal(deps.fakeFetch.calls.length, 3);
  await deps.clock.advance(1);
  assert.equal(deps.fakeFetch.calls.length, 4);
  loop.stop();
});

test('compensation: normal loop stops after 300 s (static SDK policy) unless disabled', async () => {
  const deps = makeDeps(() => jsonResponse({ ResponseStatus: OK_STATUS, lastMessageTimestamp: 1 }));
  const loop = createCompensationLoop(deps, new SoaClient(deps), { emit: () => undefined, roles: UNKNOWN_ROLES, initialBeginMsgTime: 1 });
  loop.start('connected');
  await deps.clock.advance(300000);
  const n = deps.fakeFetch.calls.length;
  assert.ok(n >= 30);
  assert.equal(loop.mode, 'stopped');
  await deps.clock.advance(60000);
  assert.equal(deps.fakeFetch.calls.length, n);
  // a transport change restarts
  loop.setTransport('disconnected');
  await deps.clock.advance(0);
  assert.equal(loop.mode, 'frequent');
  assert.equal(deps.fakeFetch.calls.length, n + 1);
  loop.stop();

  const deps2 = makeDeps(() => jsonResponse({ ResponseStatus: OK_STATUS, lastMessageTimestamp: 1 }));
  const loop2 = createCompensationLoop(deps2, new SoaClient(deps2), { emit: () => undefined, roles: UNKNOWN_ROLES, initialBeginMsgTime: 1, stopNormalLoopAfterLimit: false });
  loop2.start('connected');
  await deps2.clock.advance(360000);
  assert.equal(loop2.mode, 'normal');
  assert.ok(deps2.fakeFetch.calls.length >= 36);
  loop2.stop();
});

test('compensation: auth_invalid stops the loop', async () => {
  const deps = makeDeps(() => jsonResponse({ ResponseStatus: AUTH_FAILURE_STATUS }));
  const facts: AdapterFact[] = [];
  const loop = createCompensationLoop(deps, new SoaClient(deps), { emit: (f) => facts.push(f), roles: UNKNOWN_ROLES, initialBeginMsgTime: 1 });
  loop.start('connected');
  await deps.clock.advance(0);
  assert.deepEqual(facts, [{ kind: 'auth_invalid' }]);
  await deps.clock.advance(60000);
  assert.equal(deps.fakeFetch.calls.length, 1);
  assert.equal(loop.running, false);
});

test('compensation: the normal-loop stop delay is configurable (value, null = never, legacy flag, bad values)', async () => {
  assert.equal(resolveNormalLoopStopAfterMs({}), DEFAULT_NORMAL_LOOP_STOP_AFTER_MS);
  assert.equal(resolveNormalLoopStopAfterMs({ normalLoopStopAfterMs: 60_000 }), 60_000);
  assert.equal(resolveNormalLoopStopAfterMs({ normalLoopStopAfterMs: null }), null);
  assert.equal(resolveNormalLoopStopAfterMs({ normalLoopStopAfterMs: 60_000, stopNormalLoopAfterLimit: false }), null, 'legacy "never" wins');
  for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(resolveNormalLoopStopAfterMs({ normalLoopStopAfterMs: bad }), DEFAULT_NORMAL_LOOP_STOP_AFTER_MS, String(bad));

  const custom = makeDeps(() => jsonResponse({ ResponseStatus: OK_STATUS, lastMessageTimestamp: 1 }));
  const short = createCompensationLoop(custom, new SoaClient(custom), { emit: () => undefined, roles: UNKNOWN_ROLES, initialBeginMsgTime: 1, normalLoopStopAfterMs: 60_000 });
  short.start('connected');
  await custom.clock.advance(60_000);
  assert.equal(short.mode, 'stopped');
  const stopped = custom.fakeFetch.calls.length;
  assert.ok(stopped >= 6 && stopped <= 7);
  await custom.clock.advance(120_000);
  assert.equal(custom.fakeFetch.calls.length, stopped, 'stopped after the configured 60 s, not 300 s');
  short.stop();

  const never = makeDeps(() => jsonResponse({ ResponseStatus: OK_STATUS, lastMessageTimestamp: 1 }));
  const forever = createCompensationLoop(never, new SoaClient(never), { emit: () => undefined, roles: UNKNOWN_ROLES, initialBeginMsgTime: 1, normalLoopStopAfterMs: null });
  forever.start('connected');
  await never.clock.advance(3_600_000);
  assert.equal(forever.mode, 'normal');
  assert.ok(never.fakeFetch.calls.length >= 360);
  forever.stop();
  assert.equal(never.clock.pendingCount(), 0);
});

test('compensation: transport flapping never bursts; at most one request per 5 s floor', async () => {
  const deps = makeDeps(() => jsonResponse({ ResponseStatus: OK_STATUS, lastMessageTimestamp: 1 }));
  const loop = createCompensationLoop(deps, new SoaClient(deps), { emit: () => undefined, roles: UNKNOWN_ROLES, initialBeginMsgTime: 1 });
  loop.start('connected');
  await deps.clock.advance(0);
  assert.equal(deps.fakeFetch.calls.length, 1);
  for (let i = 0; i < 40; i++) {
    loop.setTransport(i % 2 === 0 ? 'reconnecting' : 'connected');
    await deps.clock.advance(250);
  }
  // 10 s of flapping: at most one request per 5 s window after the first.
  assert.ok(deps.fakeFetch.calls.length <= 3, String(deps.fakeFetch.calls.length));
  const times: number[] = [];
  const t0 = deps.now();
  const before = deps.fakeFetch.calls.length;
  for (let i = 0; i < 60; i++) {
    loop.setTransport(i % 2 === 0 ? 'disconnected' : 'connected');
    await deps.clock.advance(1000);
    if (deps.fakeFetch.calls.length > before + times.length) times.push(deps.now() - t0);
  }
  for (let i = 1; i < times.length; i++) assert.ok((times[i] ?? 0) - (times[i - 1] ?? 0) >= MIN_REQUEST_INTERVAL_MS, JSON.stringify(times));
  loop.stop();
  assert.equal(deps.clock.pendingCount(), 0);
});

test('compensation: intervals below the floor are clamped to 5 s; bad page sizes fall back to 100', async () => {
  const deps = makeDeps(() => jsonResponse({ ResponseStatus: OK_STATUS, lastMessageTimestamp: 1 }));
  const loop = createCompensationLoop(deps, new SoaClient(deps), { emit: () => undefined, roles: UNKNOWN_ROLES, initialBeginMsgTime: 1, normalIntervalMs: 10, frequentIntervalMs: Number.NaN, pageSize: 1e6 });
  loop.start('connected');
  await deps.clock.advance(4999);
  assert.equal(deps.fakeFetch.calls.length, 1);
  await deps.clock.advance(1);
  assert.equal(deps.fakeFetch.calls.length, 2);
  assert.equal((deps.fakeFetch.calls[0]?.bodyJson as { pageSize: number }).pageSize, 100);
  loop.setTransport('disconnected');
  await deps.clock.advance(4999);
  assert.equal(deps.fakeFetch.calls.length, 2, 'NaN frequent interval falls back to 5 s');
  await deps.clock.advance(1);
  assert.equal(deps.fakeFetch.calls.length, 3);
  loop.stop();
});

test('compensation: single flight — a slow request is never overlapped, even across transport changes', async () => {
  let release!: (r: FetchResponseLike) => void;
  const deps = makeDeps((_, i) => (i === 0 ? new Promise<FetchResponseLike>((r) => { release = r; }) : jsonResponse({ ResponseStatus: OK_STATUS, lastMessageTimestamp: 5 })));
  const loop = createCompensationLoop(deps, new SoaClient(deps), { emit: () => undefined, roles: UNKNOWN_ROLES, initialBeginMsgTime: 1 });
  loop.start('disconnected');
  await deps.clock.advance(4000);
  loop.setTransport('connected');
  await deps.clock.advance(4000);
  loop.setTransport('reconnecting');
  await deps.clock.advance(4000); // still inside the 15 s SOA timeout
  assert.equal(deps.fakeFetch.calls.length, 1, 'no second request while the first is pending');
  release(jsonResponse({ ResponseStatus: OK_STATUS, lastMessageTimestamp: 3 }));
  await flush();
  await deps.clock.advance(0);
  assert.equal(loop.cursor, 1, 'the straddling response is dropped');
  await deps.clock.advance(4999);
  assert.equal(deps.fakeFetch.calls.length, 1, 'next round waits a full frequent interval after the settled request');
  await deps.clock.advance(1);
  assert.equal(deps.fakeFetch.calls.length, 2, 'the current generation still gets its round');
  assert.equal((deps.fakeFetch.calls[1]?.bodyJson as { beginMsgTime: number }).beginMsgTime, 1);
  loop.stop();
  assert.equal(deps.clock.pendingCount(), 0);
});

test('compensation: failures back off exponentially (capped at 60 s), success resets, flaps cannot shortcut it', async () => {
  let failing = true;
  const deps = makeDeps(() => (failing ? jsonResponse({}, 503) : jsonResponse({ ResponseStatus: OK_STATUS, lastMessageTimestamp: 1 })));
  const loop = createCompensationLoop(deps, new SoaClient(deps), { emit: () => undefined, roles: UNKNOWN_ROLES, initialBeginMsgTime: 1 });
  loop.start('disconnected');
  const at: number[] = [];
  let seen = 0;
  const t0 = deps.now();
  for (let i = 0; i < 400; i++) {
    await deps.clock.advance(i === 0 ? 0 : 1000);
    if (i === 50) { loop.setTransport('connected'); loop.setTransport('disconnected'); }
    while (deps.fakeFetch.calls.length > seen) { seen += 1; at.push(deps.now() - t0); }
  }
  const gaps = at.slice(1).map((t, i) => t - (at[i] ?? 0));
  assert.deepEqual(gaps.slice(0, 5), [10000, 20000, 40000, 60000, 60000], JSON.stringify(at));
  for (const g of gaps) assert.ok(g <= MAX_BACKOFF_MS && g >= 10000, JSON.stringify(gaps));
  failing = false;
  await deps.clock.advance(MAX_BACKOFF_MS);
  const ok = deps.fakeFetch.calls.length;
  await deps.clock.advance(5000);
  assert.equal(deps.fakeFetch.calls.length, ok + 1, 'success restores the plain 5 s cadence');
  loop.stop();
});

test('compensation: (gid, message_id) dedup across rounds and a cursor that never moves backwards', async () => {
  const deps = makeDeps((_, i) =>
    i === 0 ? jsonResponse({ ResponseStatus: OK_STATUS, messages: [msg('m1', 1700000000100), msg('m1', 1700000000100)], lastMessageTimestamp: 1700000000500 })
      : i === 1 ? jsonResponse({ ResponseStatus: OK_STATUS, messages: [msg('m1', 1700000000100), msg('m2', 1700000000200)], lastMessageTimestamp: 1700000000300 })
        : jsonResponse({ ResponseStatus: OK_STATUS, lastMessageTimestamp: 1700000000400 }));
  const facts: AdapterFact[] = [];
  const loop = createCompensationLoop(deps, new SoaClient(deps), { emit: (f) => facts.push(f), roles: UNKNOWN_ROLES, initialBeginMsgTime: 1 });
  loop.start('disconnected');
  await deps.clock.advance(0);
  assert.equal(loop.cursor, 1700000000500);
  await deps.clock.advance(5000);
  assert.equal(loop.cursor, 1700000000500, 'older lastMessageTimestamp does not regress the cursor');
  await deps.clock.advance(5000);
  assert.equal((deps.fakeFetch.calls[2]?.bodyJson as { beginMsgTime: number }).beginMsgTime, 1700000000500);
  const ids = facts.filter((f) => f.kind === 'message').map((f) => (f as { fact: { message_id: string } }).fact.message_id);
  assert.deepEqual(ids, ['m1', 'm2']);
  loop.stop();
});
