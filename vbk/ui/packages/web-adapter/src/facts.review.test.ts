/**
 * Review: fact normalization and cursors (hunt items 7, 12).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MsgKind } from '../../ipc/src/contracts.ts';
import type { SdkMessageEvent } from './deps.ts';
import { AdapterBridge } from './bridge.ts';
import { CursorAllocator, UNKNOWN_ROLES, buildMemberRoles, mapMsgType, normalizeHttpMessage, normalizeSdkMessage, normalizeTimeMs, type CheckMemberStatusMember, type HttpMessageObject } from './facts.ts';

const account = { account_id: '{{account}}', environment: 'production', session_generation: 1 };

test('review/facts: msgtype mapping matrix (observed codes only; everything else is control)', () => {
  const expect: [unknown, MsgKind][] = [
    [0, 'business'],
    ['0', 'business'],
    [1, 'business'],
    [2, 'business'],
    [3, 'business'],
    [5, 'business'],
    [7, 'business'],
    ['007', 'business'],
    [1007, 'control'],
    [1009, 'recall'],
    [9901, 'typing'],
    ['9901', 'typing'],
    [4, 'control'],
    [6, 'control'],
    [8, 'control'],
    [-1, 'control'],
    [1.5, 'control'],
    ['1e3', 'control'],
    [' 1', 'control'],
    [null, 'control'],
    [undefined, 'control'],
    [{}, 'control'],
    [[], 'control'],
    [true, 'control'],
    [Number.NaN, 'control'],
  ];
  for (const [raw, kind] of expect) assert.equal(mapMsgType(raw), kind, String(raw));
  assert.equal(mapMsgType(0, { 0: 'control' }), 'control', 'overrides win');
});

test('review/facts: create_time_ms normalization from seconds / ms / strings; everything else rejected', () => {
  assert.equal(normalizeTimeMs(1700000000), 1700000000000);
  assert.equal(normalizeTimeMs('1700000000'), 1700000000000);
  assert.equal(normalizeTimeMs(1700000000123), 1700000000123);
  assert.equal(normalizeTimeMs(' 1700000000123 '), 1700000000123);
  assert.equal(normalizeTimeMs(1700000000123.9), 1700000000123);
  assert.equal(normalizeTimeMs(9999999999), 9999999999000);
  for (const bad of ['1700000000123.5', -1, 0, true, false, 17000000001234, 99999999999, 999999999, '0x1', '', ' ', '1,700', null, undefined, {}, [], Number.NaN, Number.POSITIVE_INFINITY, '1700000000e0']) {
    assert.equal(normalizeTimeMs(bad), null, String(bad));
  }
});

test('review/facts: unknown roles → unknown; hostile member rows never throw', () => {
  assert.equal(UNKNOWN_ROLES.roleOf('anyone'), 'unknown');
  const members = [null, undefined, 'x', 7, [], { uid: 7, roles: [4, 4, 4] }, { uid: 'r1', roles: 'x' }, { uid: 'r2', roles: [4] }, { uid: 'r3', roles: [0, 4] }, { uid: 'r4', roles: [0, 0, 4] }] as unknown as CheckMemberStatusMember[];
  const roles = buildMemberRoles({ selfUid: 'ME', members });
  assert.equal(roles.roleOf('r1'), 'unknown');
  assert.equal(roles.roleOf('r2'), 'unknown');
  assert.equal(roles.roleOf('r3'), 'merchant_other');
  assert.equal(roles.roleOf('r4'), 'merchant_other');
  assert.equal(roles.roleOf('7'), 'unknown');
  assert.equal(roles.roleOf('me'), 'merchant_self');
  assert.equal(roles.roleOf(''), 'unknown');
  const noArray = buildMemberRoles({ selfUid: 'ME', members: 'nope' as unknown as CheckMemberStatusMember[] });
  assert.equal(noArray.roleOf('ME'), 'merchant_self');
});

test('review/facts: notify_ack / send_result never become facts, even with a read_receipt override', () => {
  const overrides = { 1234: 'read_receipt' as const };
  const base = { id: 'x', msgtype: 1234, create_time: '1700000000555', from: 'g7@conf.x/cust-1', to: 'me@x', body: '{{text}}' };
  assert.equal(normalizeSdkMessage({ ...base, type: 'notify_ack' }, { roles: UNKNOWN_ROLES, msgTypeOverrides: overrides }), null);
  assert.equal(normalizeSdkMessage({ ...base, type: 'send_result' }, { roles: UNKNOWN_ROLES, msgTypeOverrides: overrides }), null);
  assert.equal(normalizeSdkMessage({ ...base, type: 'groupchat' }, { roles: UNKNOWN_ROLES })?.kind, 'control', 'no override → control');
  assert.equal(normalizeSdkMessage({ ...base, type: 'groupchat' }, { roles: UNKNOWN_ROLES, msgTypeOverrides: overrides })?.kind, 'read_receipt');
  assert.equal(normalizeHttpMessage({ msgId: 'm', toJid: 'g@x', createTime: 1700000000123, msgtype: 1234 }, { roles: UNKNOWN_ROLES, source: 'history' })?.kind, 'control');
});

test('review/facts: SDK/HTTP normalizers tolerate non-object input and never throw', () => {
  for (const evil of [null, undefined, 'str', 7, [], true]) {
    assert.equal(normalizeSdkMessage(evil as unknown as SdkMessageEvent, { roles: UNKNOWN_ROLES }), null, String(evil));
    assert.equal(normalizeHttpMessage(evil as unknown as HttpMessageObject, { roles: UNKNOWN_ROLES, source: 'history' }), null, String(evil));
  }
  // every field of the wrong type
  const junk = { id: 1, localid: {}, type: 5, msgtype: [], create_time: {}, ts: null, from: 3, to: [], body: 1 };
  assert.equal(normalizeSdkMessage(junk, { roles: UNKNOWN_ROLES }), null);
  const typing = normalizeSdkMessage({ type: 'input_state', from: 'g1@conf/c', create_time: 'nope' }, { roles: UNKNOWN_ROLES });
  assert.equal(typing?.kind, 'typing');
  assert.equal(typing?.create_time_ms, 0);
  // A groupchat bare JID is not verified sender identity. Keep the room,
  // but require a sender resource before attributing the message.
  const f = normalizeSdkMessage({ type: 'groupchat', from: 'cust@x', to: 'g1@conf', create_time: 1700000000555, msgtype: '0' }, { roles: UNKNOWN_ROLES });
  assert.equal(f?.gid, 'g1');
  assert.equal(f?.sender_id, '');
  assert.equal(f?.sender_role, 'unknown');
  const identified = normalizeSdkMessage({ type: 'groupchat', from: 'g1@conf/cust', to: 'self@x', create_time: 1700000000555, msgtype: '0' }, { roles: UNKNOWN_ROLES });
  assert.equal(identified?.gid, 'g1');
  assert.equal(identified?.sender_id, 'cust');
  assert.equal(identified?.sender_role, 'unknown');
});

test('review/facts: duplicate SDK events get distinct, strictly monotonic seq; no (epoch, seq) pair is ever reused', async () => {
  const bridge = new AdapterBridge({ account, invoke: () => Promise.resolve(null) });
  const evt = { id: 'dup', type: 'groupchat', msgtype: '0', create_time: '1700000000700', from: 'g1@conf/cust', to: 'me@x' };
  const seen = new Set<string>();
  let last = 0;
  for (let i = 0; i < 500; i++) {
    const fact = normalizeSdkMessage(evt, { roles: UNKNOWN_ROLES });
    assert.ok(fact);
    const env = bridge.push({ kind: 'message', fact });
    assert.equal(env.seq, last + 1);
    last = env.seq;
    const key = `${env.epoch}:${env.stream}:${env.seq}`;
    assert.equal(seen.has(key), false, key);
    seen.add(key);
  }
  bridge.bumpEpoch();
  for (let i = 0; i < 50; i++) {
    const env = bridge.push({ kind: 'compensation_sync', last_message_timestamp_ms: null });
    const key = `${env.epoch}:${env.stream}:${env.seq}`;
    assert.equal(seen.has(key), false, key);
    seen.add(key);
    assert.equal(env.seq, i + 1);
  }
  await bridge.flush();
  const c = new CursorAllocator(7);
  const a = c.next('s');
  c.bumpEpoch();
  const b = c.next('s');
  assert.notDeepEqual(a, b);
  assert.equal(b.epoch, 8);
});
