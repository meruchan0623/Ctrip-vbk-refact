import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AdapterFact } from '../../ipc/src/contracts.ts';
import { SoaClient } from './soa.ts';
import { DEFAULT_NORMAL_LOOP_STOP_AFTER_MS, createCompensationLoop, resolveNormalLoopStopAfterMs } from './compensation.ts';
import { UNKNOWN_ROLES } from './facts.ts';
import { AUTH_FAILURE_STATUS, OK_STATUS, jsonResponse, makeDeps } from './testing.ts';

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
  assert.equal(deps.fakeFetch.calls.length, 3); // restart fires immediately
  loop.setTransport('connected');
  await deps.clock.advance(0);
  assert.equal(loop.mode, 'normal');
  assert.equal(deps.fakeFetch.calls.length, 4);
  await deps.clock.advance(5000);
  assert.equal(deps.fakeFetch.calls.length, 4);
  await deps.clock.advance(5000);
  assert.equal(deps.fakeFetch.calls.length, 5);
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
