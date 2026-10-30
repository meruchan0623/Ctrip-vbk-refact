import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { UiMembers, UiInviteCandidates } from '../../ipc/src/client.ts';
import { createRpc } from './rpc.ts';
import { ConversationStore, RoleBook } from './stores.ts';
import { SoaClient } from './soa.ts';
import { getCurrentMembers } from './peripheral.ts';
import { FakePageSdk, OK_STATUS, jsonResponse, makeDeps, sampleRow } from './testing.ts';

test('member/invite avatar: real endpoint fields and matching uid profiles survive projection; company rolesv2 filtering is display only', async () => {
  const member = (uid: string, extra = {}) => ({ uid, nick: uid, status: '4', roles: [0, 3, 4], ...extra });
  const base = makeDeps(call => jsonResponse(call.url.includes('getInviteMemberListBySkillGroup')
    ? { ResponseStatus: OK_STATUS, bizResponseStatus: { resultCode: 'SUCCESS' }, results: [{ agentInfoList: [{ agentUid: '90071992547409931', avatar: 'https://example.invalid/invite.png' }, { agentUid: 'profile-only' }, { agentUid: 'unknown' }] }] }
    : { ResponseStatus: OK_STATUS, status: { code: 0 }, members: [member('company', { rolesv2: [0, 3, 5], avatar: 'https://example.invalid/company.png' }), member('me', { avatar: 'https://example.invalid/stale-self.png' }), member('customer', { rolesv2: [0, 1, 1], avatar: 'https://example.invalid/customer.png' }), member('cached'), member('missing')] }));
  const sdk = new FakePageSdk(), deps = { ...base, sdk }, soa = new SoaClient(deps);
  const store = new ConversationStore(); store.update([sampleRow('123456')]);
  const roles = new RoleBook('me'); roles.setSelfProfile({ uid: 'me', name: 'Self', avatar: 'https://example.invalid/self.png' });
  roles.addMembers([{ uid: 'cached', avatar: 'https://example.invalid/cached.png' }, { uid: 'profile-only', avatar: 'https://example.invalid/profile.png' }]);
  const rpc = createRpc({ deps, soa, sdk, store, roles, pushFact() {}, pushDisplay() {}, agent: { current: () => null, set() {} } });
  const read = await getCurrentMembers(deps, soa, '123456');
  assert.ok(read.kind === 'success'); assert.equal(read.value.length, 5, 'write preflight retains the raw company member');
  const result = await rpc.handle({ req_id: 'members', op: 'im.members', args: { gid: '123456' } });
  assert.ok(result?.ok); const data = result.data as UiMembers;
  assert.deepEqual(data.members.map(m => m.uid), ['me', 'customer', 'cached', 'missing']);
  assert.deepEqual(data.members.map(m => m.avatar), ['https://example.invalid/self.png', 'https://example.invalid/customer.png', 'https://example.invalid/cached.png', null]);
  assert.equal(data.members[0]?.status, '4', 'self status remains the server value');
  assert.ok(data.members.every(m => m.can_transfer === false), 'avatar display does not broaden current write eligibility');
  const invited = await rpc.handle({ req_id: 'invite', op: 'im.invite_candidates', args: { gid: '123456' } });
  assert.ok(invited?.ok); const candidates = invited.data as UiInviteCandidates;
  assert.deepEqual(candidates.agents.map(a => [a.uid, a.avatar]), [['90071992547409931', 'https://example.invalid/invite.png'], ['profile-only', 'https://example.invalid/profile.png'], ['unknown', null]]);
});


test('member display retains self at status zero and positive members, without filtering write read-back', async () => {
  const members = ['me', 'removed-person', 'present'].map((uid, i) => ({ uid, nick: uid, status: i === 2 ? '4' : '0', roles: [0, 3, 4] }));
  const base = makeDeps(() => jsonResponse({ ResponseStatus: OK_STATUS, status: { code: 0 }, members }));
  const sdk = new FakePageSdk(), deps = { ...base, sdk }, soa = new SoaClient(deps);
  const store = new ConversationStore(); store.update([sampleRow('123456')]);
  const rpc = createRpc({ deps, soa, sdk, store, roles: new RoleBook('me'), pushFact() {}, pushDisplay() {}, agent: { current: () => null, set() {} } });
  const raw = await getCurrentMembers(deps, soa, '123456');
  assert.ok(raw.kind === 'success'); assert.equal(raw.value.length, 3);
  const result = await rpc.handle({ req_id: 'members', op: 'im.members', args: { gid: '123456' } });
  assert.ok(result?.ok);
  assert.deepEqual((result.data as UiMembers).members.map(m => [m.uid, m.status]), [['me', '0'], ['present', '4']]);
});
