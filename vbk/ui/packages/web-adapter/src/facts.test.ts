import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyCursor } from '../../ipc/src/contracts.ts';
import { CursorAllocator, buildMemberRoles, jidLocal, jidSender, mapMsgType, normalizeHttpMessage, normalizeSdkMessage, normalizeTimeMs } from './facts.ts';

const members = [
  { uid: 'CUST-1', nick: '{{nick}}', status: '1', roles: [0, 1, 0] },
  { uid: 'ME-1', nick: '{{nick}}', status: '4', roles: [3, 4, 4] },
  { uid: 'OTHER-1', nick: '{{nick}}', status: '4', roles: [0, 3, 4] },
  { uid: 'MYSTERY', nick: '{{nick}}', status: '4', roles: [0, 3, 5] },
];

test('member roles: documented merchant rules, customer from conversation, unknown otherwise', () => {
  const roles = buildMemberRoles({ selfUid: 'me-1', customerUid: 'cust-1', members });
  assert.equal(roles.roleOf('ME-1'), 'merchant_self');
  assert.equal(roles.roleOf('me-1'), 'merchant_self');
  assert.equal(roles.roleOf('OTHER-1'), 'merchant_other');
  assert.equal(roles.roleOf('CUST-1'), 'customer');
  assert.equal(roles.roleOf('MYSTERY'), 'unknown');
  assert.equal(roles.roleOf('nobody'), 'unknown');
  const noCustomer = buildMemberRoles({ selfUid: 'me-1', members });
  assert.equal(noCustomer.roleOf('CUST-1'), 'unknown');
  const overridden = buildMemberRoles({ selfUid: 'me-1', members, overrides: { MYSTERY: 'robot' } });
  assert.equal(overridden.roleOf('mystery'), 'robot');
});

test('msgtype mapping and time normalization', () => {
  assert.equal(mapMsgType(0), 'business');
  assert.equal(mapMsgType('1'), 'business');
  assert.equal(mapMsgType(3), 'business');
  assert.equal(mapMsgType(5), 'business');
  assert.equal(mapMsgType(1009), 'recall');
  assert.equal(mapMsgType(9901), 'typing');
  assert.equal(mapMsgType(1007), 'control');
  assert.equal(mapMsgType(424242), 'control');
  assert.equal(mapMsgType('x'), 'control');
  assert.equal(mapMsgType(1234, { 1234: 'read_receipt' }), 'read_receipt');
  assert.equal(normalizeTimeMs(1700000000123), 1700000000123);
  assert.equal(normalizeTimeMs('1700000000123'), 1700000000123);
  assert.equal(normalizeTimeMs(1700000000), 1700000000000);
  assert.equal(normalizeTimeMs(12345), null);
  assert.equal(normalizeTimeMs('abc'), null);
  assert.equal(normalizeTimeMs(null), null);
});

test('jid helpers', () => {
  assert.equal(jidLocal('gid123@conference.x/uid9'), 'gid123');
  assert.equal(jidLocal('uid9@x'), 'uid9');
  assert.equal(jidLocal('bare'), 'bare');
  assert.equal(jidSender('gid123@conference.x/uid9'), 'uid9');
  assert.equal(jidSender('uid9@x'), 'uid9');
});

test('http message normalizer: role lookup, unknown, kind, source, skip unusable rows', () => {
  const roles = buildMemberRoles({ selfUid: 'me-1', customerUid: 'cust-1', members });
  const f = normalizeHttpMessage(
    { msgId: 'm1', messageBody: '{{text}}', fromJid: 'cust-1@x', toJid: 'g9@x', threadId: '', createTime: 1700000000123, bizType: '1513', status: 2, msgtype: 0, isread: false },
    { roles, source: 'compensation' },
  );
  assert.deepEqual(f, {
    gid: 'g9',
    message_id: 'm1',
    local_id: null,
    create_time_ms: 1700000000123,
    sender_role: 'customer',
    sender_id: 'cust-1',
    kind: 'business',
    source: 'compensation',
    disposition: null,
  });
  const g = normalizeHttpMessage({ msgId: 'm2', fromJid: 'who@x', partner: 'g1@x', createTime: 1700000000124, msgtype: 1007 }, { roles, source: 'history', gid: 'given' });
  assert.equal(g?.gid, 'given');
  assert.equal(g?.sender_role, 'unknown');
  assert.equal(g?.kind, 'control');
  assert.equal(normalizeHttpMessage({ msgId: 'm3', fromJid: 'a@x', toJid: 'g@x' }, { roles, source: 'history' }), null);
  assert.equal(normalizeHttpMessage({ msgId: 'm4', fromJid: 'a@x', createTime: 1700000000124 }, { roles, source: 'history' }), null);
});

test('sdk message normalizer: groupchat frame, acks dropped, typing mapped', () => {
  const roles = buildMemberRoles({ selfUid: 'me-1', customerUid: 'cust-1', members });
  const f = normalizeSdkMessage(
    { id: 'srv-1', localid: 'loc-1', type: 'groupchat', msgtype: '0', bizType: '1513', threadid: '', create_time: '1700000000555', from: 'g7@conf.x/cust-1', to: 'me-1@x', body: '{{text}}' },
    { roles },
  );
  assert.deepEqual(f, {
    gid: 'g7',
    message_id: 'srv-1',
    local_id: 'loc-1',
    create_time_ms: 1700000000555,
    sender_role: 'customer',
    sender_id: 'cust-1',
    kind: 'business',
    source: 'realtime',
    disposition: null,
  });
  assert.equal(normalizeSdkMessage({ id: 'x', type: 'notify_ack', from: 'g7@conf.x/cust-1' }, { roles }), null);
  assert.equal(normalizeSdkMessage({ id: 'x', type: 'send_result', from: 'g7@conf.x/cust-1' }, { roles }), null);
  const typing = normalizeSdkMessage({ id: 'x', type: 'input_state', msgtype: '9901', from: 'g7@conf.x/cust-1', body: '{"status":2}' }, { roles });
  assert.equal(typing?.kind, 'typing');
  assert.equal(typing?.message_id, null);
  assert.equal(normalizeSdkMessage({ id: 'x', type: 'groupchat', from: 'g7@conf.x/cust-1' }, { roles }), null); // no create time
});

test('cursor allocator: per-stream monotonic seq, epoch bump restarts', () => {
  const c = new CursorAllocator(3);
  assert.deepEqual(c.next('im.message'), { epoch: 3, seq: 1 });
  assert.deepEqual(c.next('im.message'), { epoch: 3, seq: 2 });
  assert.deepEqual(c.next('im.conversation'), { epoch: 3, seq: 1 });
  assert.equal(classifyCursor({ epoch: 3, seq: 1 }, c.next('im.message')).kind, 'gap');
  assert.equal(c.bumpEpoch(), 4);
  const after = c.next('im.message');
  assert.deepEqual(after, { epoch: 4, seq: 1 });
  assert.deepEqual(classifyCursor({ epoch: 3, seq: 3 }, after), { kind: 'epoch_changed' });
});
