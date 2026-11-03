import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AdapterFactEnvelope } from '../../ipc/src/contracts.ts';
import { ImCommands } from '../../ipc/src/commands.ts';
import { AdapterBridge, streamFor } from './bridge.ts';
import { createAdapter } from './index.ts';
import { buildMemberRoles } from './facts.ts';
import { OK_STATUS, jsonResponse, makeDeps } from './testing.ts';

const account = { account_id: '{{account}}', environment: 'production', session_generation: 2 };

test('bridge: envelope shape, stream tagging, seq per stream, epoch bump', async () => {
  const pushed: { cmd: string; payload: unknown }[] = [];
  const bridge = new AdapterBridge({ account, invoke: (cmd, payload) => (pushed.push({ cmd, payload }), Promise.resolve(null)) });
  const e1 = bridge.push({ kind: 'transport', state: 'connected' });
  const e2 = bridge.push({ kind: 'conversation_list_sync', full: true, last_update_time_ms: null });
  const e3 = bridge.push({ kind: 'compensation_sync', last_message_timestamp_ms: 1 });
  const e4 = bridge.push({ kind: 'conversation_list_sync', full: false, last_update_time_ms: 2 });
  await bridge.flush();
  assert.deepEqual(
    [e1, e2, e3, e4].map((e) => [e.stream, e.epoch, e.seq]),
    [
      ['im.transport', 1, 1],
      ['im.conversation', 1, 1],
      ['im.message', 1, 1],
      ['im.conversation', 1, 2],
    ],
  );
  assert.equal(pushed.length, 4);
  assert.equal(pushed[0]?.cmd, ImCommands.PUSH_FACT);
  assert.deepEqual(pushed[0]?.payload, { account, stream: 'im.transport', epoch: 1, seq: 1, fact: { kind: 'transport', state: 'connected' } });
  assert.deepEqual(Object.keys(pushed[1]?.payload as object), ['account', 'stream', 'epoch', 'seq', 'fact']);
  assert.equal(bridge.bumpEpoch(), 2);
  const e5 = bridge.push({ kind: 'auth_invalid' });
  assert.deepEqual([e5.stream, e5.epoch, e5.seq], ['im.transport', 2, 1]);
  assert.equal(streamFor({ kind: 'message', fact: { gid: 'g', message_id: null, local_id: null, create_time_ms: 1, sender_role: 'unknown', sender_id: '', kind: 'business', source: 'history', disposition: null } }), 'im.message');
});

test('bridge: a rejected invoke is reported, never retried', async () => {
  const errors: AdapterFactEnvelope[] = [];
  let calls = 0;
  const bridge = new AdapterBridge({ account, invoke: () => (calls++, Promise.reject(new Error('host'))), onPushError: (env) => errors.push(env) });
  bridge.push({ kind: 'auth_invalid' });
  await bridge.flush();
  assert.equal(calls, 1);
  assert.equal(errors.length, 1);
});

test('createAdapter: subscribes first, pushes transport, runs pollers, stop/restart bumps epoch', async () => {
  const deps = makeDeps((call) => {
    if (call.url.includes('getConversationList')) return jsonResponse({ ResponseStatus: OK_STATUS, conversationList: [], lastUpdateTime: 1700000000500 });
    return jsonResponse({ ResponseStatus: OK_STATUS, lastMessageTimestamp: 1700000000600 });
  });
  const adapter = createAdapter(deps, { account, initialBeginMsgTime: 1700000000000 });
  adapter.start();
  assert.equal(deps.fakeSdk.listenerCount('message'), 1);
  await deps.clock.advance(0);
  await adapter.bridge.flush();
  const kinds = deps.invoked.map((i) => (i.payload as AdapterFactEnvelope).fact.kind);
  assert.deepEqual(kinds.slice(0, 1), ['transport']);
  assert.ok(kinds.includes('conversation_list_sync'));
  assert.ok(kinds.includes('compensation_sync'));
  for (const i of deps.invoked) assert.equal((i.payload as AdapterFactEnvelope).epoch, 1);

  deps.fakeSdk.emit('message', { id: 'srv-1', type: 'groupchat', msgtype: '0', create_time: '1700000000700', from: 'g1@conf/cust', to: 'me@x' });
  await adapter.bridge.flush();
  const last = deps.invoked[deps.invoked.length - 1]?.payload as AdapterFactEnvelope;
  assert.equal(last.fact.kind, 'message');
  assert.equal(last.stream, 'im.message');

  deps.fakeSdk.emit('socket_status', 'disconnected');
  assert.equal(adapter.compensation.mode, 'frequent');

  adapter.stop();
  assert.equal(deps.fakeSdk.listenerCount('message'), 0);
  const before = deps.fakeFetch.calls.length;
  await deps.clock.advance(60000);
  assert.equal(deps.fakeFetch.calls.length, before);

  adapter.start();
  await deps.clock.advance(0);
  await adapter.bridge.flush();
  const restarted = deps.invoked[deps.invoked.length - 1]?.payload as AdapterFactEnvelope;
  assert.equal(restarted.epoch, 2);
  adapter.stop();
});


test('createAdapter forwards explicit self identity through role replacement for direct-message facts', async () => {
  const deps = makeDeps();
  const adapter = createAdapter(deps, { account, initialBeginMsgTime: deps.now(), roles: buildMemberRoles({ selfUid: 'self-a', customerUid: 'customer', members: [] }) });
  adapter.start();
  for (const [self, id] of [['self-a', 'm1'], ['self-b', 'm2']] as const) {
    if (self === 'self-b') adapter.setRoles(buildMemberRoles({ selfUid: self, customerUid: 'customer', members: [] }));
    deps.fakeSdk.emit('message', { id, type: 'chat', msgtype: '0', create_time: '1700000000700', from: 'customer@im.example/device', to: `${self}@im.example` });
    await adapter.bridge.flush();
    const facts = deps.invoked.map((row) => (row.payload as AdapterFactEnvelope).fact).filter((fact) => fact.kind === 'message');
    const fact = facts.find((item) => item.fact.message_id === id)?.fact;
    assert.equal(fact?.gid, 'customer');
    assert.equal(fact?.sender_id, 'customer');
    assert.equal(fact?.sender_role, 'customer');
  }
  deps.fakeSdk.emit('message', { id: 'out-after-replacement', type: 'chat', msgtype: '0', create_time: '1700000000800', from: 'self-b@im.example', to: 'customer@im.example' });
  await adapter.bridge.flush();
  const outgoing = deps.invoked.map((row) => (row.payload as AdapterFactEnvelope).fact).find((fact) => fact.kind === 'message' && fact.fact.message_id === 'out-after-replacement');
  assert.equal(outgoing?.kind, 'message');
  if (outgoing?.kind !== 'message') throw new Error('replacement identity must reach the fact bridge');
  assert.equal(outgoing.fact.gid, 'customer');
  assert.equal(outgoing.fact.sender_id, 'self-b');
  assert.equal(outgoing.fact.sender_role, 'merchant_self');
  adapter.stop();
});
