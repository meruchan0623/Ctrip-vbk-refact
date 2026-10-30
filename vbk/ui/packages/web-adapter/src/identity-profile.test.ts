import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readIdentity } from './identity.ts';
import { SoaClient } from './soa.ts';
import { RoleBook } from './stores.ts';
import { makeDeps, jsonResponse, OK_STATUS } from './testing.ts';

for (const match of [true, false]) {
  test(`identity avatar is bound to the IM UID before accepting agent profile (match=${match})`, async () => {
    const deps = makeDeps((call) => {
      if (call.url.includes('getCurrentUserInfo')) return jsonResponse({ ResponseStatus: OK_STATUS, user: { buid: 'synthetic-platform', name: 'Platform Display' } });
      if (call.url.includes('GetMyInfo')) return jsonResponse({ ResponseStatus: OK_STATUS, jid: 'self@im.example/device', name: 'IM Display', avatar: 'https://example.invalid/im-avatar.png' });
      return jsonResponse({ ResponseStatus: OK_STATUS, venAgent: { id: 1, ctripUid: match ? 'SELF' : 'different-person', nickname: 'Agent Display', avatar: 'https://example.invalid/agent-avatar.png' } });
    });
    const result = await readIdentity(deps, new SoaClient(deps), { attempts: 1 });
    assert.equal(result.kind, 'ok');
    if (result.kind !== 'ok') throw Error('synthetic identity must load');
    assert.deepEqual(result.selfProfile, { uid: 'self', name: match ? 'Agent Display' : 'IM Display', avatar: `https://example.invalid/${match ? 'agent' : 'im'}-avatar.png` });
    assert.equal(result.identity.uid, 'self');
    assert.equal(result.identity.buid, 'synthetic-platform');
  });
}

test('member and remark API profiles remain UID-bound and isolated between account role books', async () => {
  const members = ['self', 'colleague', 'customer', 'platform-agent', 'robot'].map((uid) => ({ uid, nick: uid, avatar: `https://example.invalid/${uid}.png`, roles: [0, 0, 0] }));
  const deps = makeDeps(call => jsonResponse(call.url.includes('checkMemberStatus') ? { ResponseStatus: OK_STATUS, members } : { ResponseStatus: OK_STATUS, bizResponseStatus: { resultCode: 'SUCCESS' }, remarkList: [{ username: 'CUSTOMER', nickName: 'Remark Customer', avatar: 'https://example.invalid/customer-remark.png' }] }));
  const roles = new RoleBook('self');
  await roles.ensure(deps, new SoaClient(deps), 'synthetic-room');
  for (const member of members) assert.equal(roles.profileOf(member.uid).avatar, member.uid === 'customer' ? 'https://example.invalid/customer-remark.png' : member.avatar);
  assert.deepEqual(roles.profileOf('unreturned-user'), { name: null, avatar: null });
  assert.deepEqual(new RoleBook('other-account-self').profileOf('customer'), { name: null, avatar: null });
  assert.equal(deps.fakeFetch.calls.length, 2);
});

test('verified self profile outranks member snapshots and rejects a mismatched seed', () => {
  const roles = new RoleBook('self');
  roles.setSelfProfile({ uid: 'self', name: 'Authoritative Self', avatar: 'https://example.invalid/self-agent.png' });
  roles.addMembers([{ uid: 'self', nick: 'Member Self', avatar: 'https://example.invalid/self-member.png' }]);
  assert.deepEqual(roles.profileOf('SELF'), { name: 'Authoritative Self', avatar: 'https://example.invalid/self-agent.png' });
  roles.setSelfProfile({ uid: 'other', name: 'Other', avatar: 'https://example.invalid/other.png' });
  assert.equal(roles.profileOf('self').avatar, 'https://example.invalid/self-agent.png');
  assert.deepEqual(roles.profileOf('other'), { name: null, avatar: null });
});
