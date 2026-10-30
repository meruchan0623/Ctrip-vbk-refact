import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stanzaToEvent } from './sdkGlue.ts';
import { sdkMessageToUi } from './display.ts';
import { RoleBook } from './stores.ts';
import { normalizeSdkMessage, buildMemberRoles } from './facts.ts';

for (const [wireType, normalized, from, to, gid] of [
  ['sys_muc', 'groupchat', 'room@muc.example/customer', 'self@im.example', 'room'],
  ['sys_mam', 'chat', 'customer@im.example', 'self@im.example', 'customer'],
] as const) {
  test(`official sync stanza ${wireType} reaches the ordinary display projection`, () => {
    const roles = new RoleBook('self'); roles.addCustomer('customer');
    const make = (type: string) => ({ name: 'message', attrs: { type, from, to, id: '9223372036854775806', msgtype: '0', create_time: '1700000000123' }, getChildText: () => 'SYNTHETIC SYNC' });
    const direct = stanzaToEvent(make(normalized));
    const sync = stanzaToEvent(make(wireType));
    assert.equal(sync.kind, 'message');
    assert.deepEqual(sync, direct, 'official sync types carry the same message semantics');
    if (sync.kind !== 'message') throw new Error('message required');
    const ui = sdkMessageToUi(sync.event, roles);
    assert.equal(ui?.gid, gid); assert.equal(ui?.text, 'SYNTHETIC SYNC');
    assert.equal(ui?.message_id, '9223372036854775806'); assert.equal(ui?.sender_role, 'customer');
    const fact = normalizeSdkMessage(sync.event, { roles });
    assert.equal(fact?.gid, gid); assert.equal(fact?.sender_id, 'customer');
  });
}

test('bare group JID cannot masquerade as a customer sender', () => {
  const roles = new RoleBook('self'); roles.addCustomer('room');
  const event = stanzaToEvent({ name: 'message', attrs: { type: 'sys_muc', from: 'room@muc.example', to: 'self@im.example', id: 'message', msgtype: '0', create_time: '1700000000123' }, getChildText: () => 'SYNTHETIC SYNC' });
  assert.equal(event.kind, 'message');
  if (event.kind !== 'message') throw new Error('message required');
  assert.equal(sdkMessageToUi(event.event, roles)?.sender_role, 'unknown');
});

for (const type of ['chat', 'sys_mam']) {
  test(`single chat ${type} uses explicit self identity for both directions`, () => {
    const roles = buildMemberRoles({ selfUid: 'self', customerUid: 'customer', members: [], overrides: { customer: 'merchant_self' } });
    for (const [from, to, sender] of [['customer@im.example/device', 'self@im.example', 'customer'], ['self@im.example', 'customer@im.example', 'self']]) {
      const event = stanzaToEvent({ name: 'message', attrs: { type, from, to, id: 'message', msgtype: '0', create_time: '1700000000123' }, getChildText: () => 'SYNTHETIC SYNC' });
      assert.equal(event.kind, 'message');
      if (event.kind !== 'message') throw new Error('message required');
      assert.equal(sdkMessageToUi(event.event, roles)?.gid, 'customer');
      const fact = normalizeSdkMessage(event.event, { roles });
      assert.equal(fact?.gid, 'customer'); assert.equal(fact?.sender_id, sender);
    }
  });
}
