/**
 * Review: bridge envelope shape and leak checks (hunt item 11).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FactStreams, type AdapterFact, type AdapterFactEnvelope, type AppError } from '../../ipc/src/contracts.ts';
import { ImCommands } from '../../ipc/src/commands.ts';
import { AdapterBridge, streamFor } from './bridge.ts';
import { createAdapter } from './index.ts';
import { buildMemberRoles } from './facts.ts';
import { OK_STATUS, jsonResponse, makeDeps } from './testing.ts';

const account = { account_id: '{{account}}', environment: 'production', session_generation: 3 };

const ALL_FACTS: AdapterFact[] = [
  { kind: 'message', fact: { gid: 'g', message_id: 'm', local_id: 'l', create_time_ms: 1700000000000, sender_role: 'customer', sender_id: 'u', kind: 'business', source: 'realtime', disposition: null } },
  { kind: 'message', fact: { gid: 'g', message_id: 'm', local_id: 'l', create_time_ms: 1700000000000, sender_role: 'merchant_self', sender_id: '', kind: 'business', source: 'realtime', disposition: { kind: 'confirmed', server_message_id: 's', server_time_ms: 1 } } },
  { kind: 'conversation', fact: { gid: 'g', status: 'active', agent_in_group: true, is_owner: false, service_type: '1513', last_message_time_ms: null, last_update_time_ms: 1, unread_count: 0, is_full_snapshot: true } },
  { kind: 'conversation_list_sync', full: true, last_update_time_ms: null },
  { kind: 'compensation_sync', last_message_timestamp_ms: 1 },
  { kind: 'transport', state: 'connected' },
  { kind: 'auth_invalid' },
];

/** Every key the frozen contract allows anywhere inside an envelope. */
const ALLOWED_KEYS = new Set([
  'account', 'stream', 'epoch', 'seq', 'fact', 'account_id', 'environment', 'session_generation', 'kind',
  'gid', 'message_id', 'local_id', 'create_time_ms', 'sender_role', 'sender_id', 'source', 'disposition',
  'server_message_id', 'server_time_ms', 'code', 'reason', 'status', 'agent_in_group', 'is_owner', 'service_type',
  'last_message_time_ms', 'last_update_time_ms', 'unread_count', 'is_full_snapshot', 'full', 'last_message_timestamp_ms', 'state',
]);

function walkKeys(x: unknown, seen: (k: string) => void): void {
  if (Array.isArray(x)) for (const v of x) walkKeys(v, seen);
  else if (typeof x === 'object' && x !== null) {
    for (const [k, v] of Object.entries(x)) {
      seen(k);
      walkKeys(v, seen);
    }
  }
}

test('review/bridge: envelope keys/value types equal AdapterFactEnvelope; stream names come from FactStreams', async () => {
  const bridge = new AdapterBridge({ account, invoke: () => Promise.resolve(null) });
  const expectedStream: Record<AdapterFact['kind'], string> = {
    message: FactStreams.MESSAGE,
    compensation_sync: FactStreams.MESSAGE,
    conversation: FactStreams.CONVERSATION,
    conversation_list_sync: FactStreams.CONVERSATION,
    transport: FactStreams.TRANSPORT,
    auth_invalid: FactStreams.TRANSPORT,
  };
  for (const fact of ALL_FACTS) {
    const env = bridge.push(fact);
    assert.deepEqual(Object.keys(env), ['account', 'stream', 'epoch', 'seq', 'fact']);
    assert.deepEqual(env.account, account);
    assert.equal(typeof env.epoch, 'number');
    assert.equal(typeof env.seq, 'number');
    assert.equal(Number.isInteger(env.seq) && env.seq >= 1, true);
    assert.equal(env.stream, expectedStream[fact.kind]);
    assert.equal(streamFor(fact), expectedStream[fact.kind]);
    assert.ok((Object.values(FactStreams) as string[]).includes(env.stream));
    assert.equal(env.fact, fact, 'the fact object is passed through untouched');
    assert.deepEqual(JSON.parse(JSON.stringify(env)), env, 'serializable without loss');
    walkKeys(env, (k) => assert.ok(ALLOWED_KEYS.has(k), `unexpected key ${k}`));
  }
  await bridge.flush();
});

test('review/bridge: a host AppError rejection is reported once, never retried, and does not break ordering or seq', async () => {
  const invoked: { cmd: string; seq: number }[] = [];
  const errors: [AdapterFactEnvelope, unknown][] = [];
  let n = 0;
  const appError: AppError = { code: 'host.view_unauthorized', message: 'nope', retryable: false };
  const bridge = new AdapterBridge({
    account,
    invoke: (cmd, payload) => {
      n++;
      invoked.push({ cmd, seq: (payload as AdapterFactEnvelope).seq });
      return n === 1 ? Promise.reject(appError) : Promise.resolve(null);
    },
    onPushError: (env, err) => errors.push([env, err]),
  });
  bridge.push({ kind: 'auth_invalid' });
  bridge.push({ kind: 'transport', state: 'connected' });
  bridge.push({ kind: 'transport', state: 'disconnected' });
  await bridge.flush();
  assert.deepEqual(invoked, [
    { cmd: ImCommands.PUSH_FACT, seq: 1 },
    { cmd: ImCommands.PUSH_FACT, seq: 2 },
    { cmd: ImCommands.PUSH_FACT, seq: 3 },
  ]);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.[0].seq, 1);
  assert.equal(errors[0]?.[1], appError);
  // a synchronous throw inside invoke is contained too
  const bridge2 = new AdapterBridge({
    account,
    invoke: () => {
      throw new Error('sync');
    },
    onPushError: (env) => errors.push([env, null]),
  });
  bridge2.push({ kind: 'auth_invalid' });
  await bridge2.flush();
  assert.equal(errors.length, 2);
});

test('review/bridge: nothing in any envelope carries message text, titles, nicknames, cookies or tokens', async () => {
  const deps = makeDeps((call) => {
    if (call.url.includes('getConversationList')) {
      return jsonResponse({
        ResponseStatus: OK_STATUS,
        conversationList: [{ gid: 'g1', status: 2, inGroup: 1, isOwner: false, serviceType: '1513', uid: 'cust-1', groupTitle: 'SECRET-TITLE', ext: { token: 'SECRET-TOKEN', cookie: 'SECRET-COOKIE' }, lastMessageJsonString: '{"messageBody":"SECRET-BODY"}', lastUpdateTime: 1700000000002, lastMessageTime: 1700000000001 }],
        lastUpdateTime: 1700000000002,
      });
    }
    return jsonResponse({
      ResponseStatus: OK_STATUS,
      messages: [{ msgId: 'm1', messageBody: 'SECRET-BODY', fromJid: 'cust-1@x', toJid: 'g1@x', threadId: '', createTime: 1700000000100, bizType: '1513', status: 0, msgtype: 0, isread: false, nick: 'SECRET-NICK' }],
      lastMessageTimestamp: 1700000000100,
    });
  });
  const roles = buildMemberRoles({ selfUid: 'me', customerUid: 'cust-1', members: [{ uid: 'cust-1', nick: 'SECRET-NICK', roles: [0, 1, 0] } as never] });
  const adapter = createAdapter(deps, { account, initialBeginMsgTime: 1, roles });
  adapter.start();
  deps.fakeSdk.emit('message', { id: 'srv-1', type: 'groupchat', msgtype: '0', create_time: '1700000000700', from: 'g1@conf/cust-1', to: 'me@x', body: 'SECRET-TEXT', cookie: 'SECRET-COOKIE', token: 'SECRET-TOKEN' } as never);
  await deps.clock.advance(0);
  await adapter.bridge.flush();
  adapter.stop();
  const all = JSON.stringify(deps.invoked);
  assert.ok(deps.invoked.length >= 4);
  for (const s of ['SECRET', 'messageBody', 'groupTitle', 'nick', 'cookie', 'token', 'body', 'ext']) assert.equal(all.includes(s), false, s);
  for (const i of deps.invoked) {
    assert.equal(i.cmd, ImCommands.PUSH_FACT);
    walkKeys(i.payload, (k) => assert.ok(ALLOWED_KEYS.has(k), `unexpected key ${k}`));
  }
  const kinds = deps.invoked.map((i) => (i.payload as AdapterFactEnvelope).fact.kind);
  assert.deepEqual(kinds[0], 'transport');
  assert.ok(kinds.includes('message') && kinds.includes('conversation'));
});
