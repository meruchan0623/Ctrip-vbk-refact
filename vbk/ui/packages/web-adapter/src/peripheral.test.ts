import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SoaClient } from './soa.ts';
import { FAILURE_STATUS, OK_STATUS, jsonResponse, makeDeps } from './testing.ts';
import { finishConversation, getCustomerScripts, getInviteMemberListBySkillGroup, inviteVenAgent, transferVenMaster, type PeripheralConversation } from './peripheral.ts';

const view: PeripheralConversation = {
  gid: '123', conversationKey: 'actual-key', sessionId: 'session-1', worksheetId: 456,
  serviceType: 'actual-service', threadId: '', conversationType: 'B2C', customerUid: null, orderId: null, lastMessage: null,
};
const accepted = { ResponseStatus: OK_STATUS, bizResponseStatus: { resultCode: 'SUCCESS' } };

test('peripheral reads preserve content and exact candidate request types', async () => {
  const deps = makeDeps((_, i) => jsonResponse(i === 0 ? { ResponseStatus: OK_STATUS, customerScripts: [] } : {
    ...accepted, results: [{ skillGroupList: [{ skillGroupId: 9, skillGroupName: 'Group' }], agentInfoList: [{ agentUid: 'chosen-agent', nickname: 'Agent' }] }],
  }));
  const soa = new SoaClient(deps);
  assert.deepEqual(await getCustomerScripts(deps, soa, { content: 'draft fragment' }), { kind: 'success', value: { items: [] } });
  assert.equal((deps.fakeFetch.calls[0]!.bodyJson as Record<string, unknown>)['content'], 'draft fragment');
  const result = await getInviteMemberListBySkillGroup(deps, soa, view);
  assert.deepEqual(result, { kind: 'success', value: { skillGroups: [{ skillGroupId: 9, skillGroupName: 'Group' }], agents: [{ agentUid: 'chosen-agent', nickname: 'Agent' }] } });
  const body = deps.fakeFetch.calls[1]!.bodyJson as Record<string, unknown>;
  assert.equal(body['groupId'], '123'); assert.equal(body['worksheetId'], 456);
  assert.equal('parentSkillGroupIds' in body, false);
  await getInviteMemberListBySkillGroup(deps, soa, view, { parentSkillGroupIds: [9] });
  assert.deepEqual((deps.fakeFetch.calls[2]!.bodyJson as Record<string, unknown>)['parentSkillGroupIds'], [9]);
});

test('peripheral operations reject absent actual conversation fields without fetching', async () => {
  const deps = makeDeps(); const soa = new SoaClient(deps);
  assert.deepEqual(await finishConversation(deps, soa, { ...view, conversationKey: null }), { kind: 'unsupported', missing: ['conversationKey'] });
  assert.equal((await inviteVenAgent(deps, soa, { ...view, serviceType: '' }, { venAgentUidList: ['a'] })).kind, 'unsupported');
  assert.equal((await transferVenMaster(deps, soa, { ...view, sessionId: null }, { targetVenAgentUid: 'a' })).kind, 'unsupported');
  assert.equal((await getInviteMemberListBySkillGroup(deps, soa, { ...view, worksheetId: null })).kind, 'unsupported');
  assert.equal((await inviteVenAgent(deps, soa, view, { venAgentUidList: [] })).kind, 'invalid');
  assert.equal(deps.fakeFetch.calls.length, 0);
});

test('peripheral writes serialize finish, invite and transfer distinctly, requiring read-back', async () => {
  const deps = makeDeps((_, i) => jsonResponse(i === 1 ? { ResponseStatus: OK_STATUS, sessionId: view.sessionId, workSheetId: String(view.worksheetId) } : accepted));
  const soa = new SoaClient(deps);
  assert.deepEqual(await finishConversation(deps, soa, view), { kind: 'accepted', requiresReadBack: true });
  assert.deepEqual(await inviteVenAgent(deps, soa, view, { venAgentUidList: ['chosen-agent'] }), { kind: 'accepted', requiresReadBack: true });
  assert.deepEqual(await transferVenMaster(deps, soa, view, { targetVenAgentUid: 'chosen-agent' }), { kind: 'accepted', requiresReadBack: true });
  const bodies = deps.fakeFetch.calls.map(c => { const { head: _head, ...body } = c.bodyJson as Record<string, unknown>; return body; });
  assert.deepEqual(bodies, [
    { conversationKey: 'actual-key', conversationType: 'B2C', sessionId: 'session-1', workSheetId: 456 },
    { venAgentUidList: ['chosen-agent'], serviceType: 'actual-service', workSheetId: '456' },
    { sessionId: 'session-1', groupId: '123', targetVenAgentUid: 'chosen-agent' },
  ]);
});

test('Ack alone, business rejection, and unknown writes are never promoted or replayed', async () => {
  const deps = makeDeps((_, i) => i === 3 ? 'hang' : jsonResponse(i === 0 ? { ResponseStatus: OK_STATUS } : i === 1 ? { ...accepted, bizResponseStatus: { resultCode: 'DENIED' } } : { ResponseStatus: FAILURE_STATUS }));
  const soa = new SoaClient(deps, { defaultTimeoutMs: 100 });
  assert.equal((await inviteVenAgent(deps, soa, view, { venAgentUidList: ['a'] })).kind, 'unknown');
  assert.equal((await transferVenMaster(deps, soa, view, { targetVenAgentUid: 'a' })).kind, 'biz_failure');
  assert.equal((await finishConversation(deps, soa, view)).kind, 'failed');
  const pending = finishConversation(deps, soa, view);
  await deps.clock.advance(100);
  assert.equal((await pending).kind, 'unknown');
  await deps.clock.advance(1000);
  assert.equal(deps.fakeFetch.calls.length, 4);
});

test('malformed reads and candidate business denial are explicit failures', async () => {
  const deps = makeDeps((_, i) => jsonResponse(i === 0 ? { ResponseStatus: OK_STATUS } : { ResponseStatus: OK_STATUS, bizResponseStatus: { resultCode: 'DENIED' }, results: [] }));
  const soa = new SoaClient(deps);
  assert.equal((await getCustomerScripts(deps, soa, { content: '' })).kind, 'failed');
  assert.equal((await getInviteMemberListBySkillGroup(deps, soa, view)).kind, 'biz_failure');
});

test('current members validate business status, roles, and exact string IDs before exposing a snapshot', async () => {
  const { getCurrentMembers } = await import('./peripheral.ts');
  const deps = makeDeps((_, i) => jsonResponse({ ResponseStatus: OK_STATUS, status: { code: i === 0 ? 2 : 0 }, members: i === 2 ? [{ uid: 'x', status: '1', roles: ['4'] }] : [{ uid: '900719925474099312345', nick: 'Exact', status: '1', roles: [0, 3, 4] }] }));
  const soa = new SoaClient(deps);
  assert.equal((await getCurrentMembers(deps, soa, 'gid-exact')).kind, 'biz_failure');
  assert.deepEqual(await getCurrentMembers(deps, soa, 'gid-exact'), { kind: 'success', value: [{ uid: '900719925474099312345', nickname: 'Exact', status: '1', roles: [0, 3, 4] }] });
  assert.equal((await getCurrentMembers(deps, soa, 'gid-exact')).kind, 'failed');
});

test('latest-conversation readback rejects unrelated gid and missing session instead of proving finish', async () => {
  const { getLatestConversationState } = await import('./peripheral.ts');
  const deps = makeDeps((_, i) => jsonResponse({ ...accepted, conversation: { gid: i === 0 ? 'other' : 'expected', sessionId: i === 1 ? 9007199254740992 : 'actual', status: 4, inGroup: -1 } }));
  const soa = new SoaClient(deps);
  assert.equal((await getLatestConversationState(deps, soa, 'expected')).kind, 'failed');
  assert.equal((await getLatestConversationState(deps, soa, 'expected')).kind, 'failed');
  assert.deepEqual(await getLatestConversationState(deps, soa, 'expected'), { kind: 'success', value: { gid: 'expected', sessionId: 'actual', status: 4, inGroup: -1 } });
});

test('conversation identity rejects unsafe numeric session IDs and preserves full string precision', async () => {
  const { rowView } = await import('./display.ts');
  const { sampleRow } = await import('./testing.ts');
  const exact = rowView(sampleRow('900719925474099312345', { sessionId: '900719925474099312346', conversationKey: 'actual-upstream-key' }));
  assert.equal(exact?.gid, '900719925474099312345');
  assert.equal(exact?.sessionId, '900719925474099312346');
  assert.equal(exact?.conversationKey, 'actual-upstream-key');
  const unsafe = rowView(sampleRow('gid', { sessionId: 9007199254740992 }));
  assert.equal(unsafe?.sessionId, null);
  const deps = makeDeps();
  assert.equal((await transferVenMaster(deps, new SoaClient(deps), unsafe, { targetVenAgentUid: 'chosen' })).kind, 'unsupported');
  assert.equal(deps.fakeFetch.calls.length, 0);
});

test('write HTTP failure, undecodable reply, and absent business ack remain unknown without another submission', async () => {
  const deps = makeDeps((_, i) => i === 0 ? { status: 503, text: async () => 'gateway failure' } : i === 1 ? { status: 200, text: async () => 'invalid JSON' } : jsonResponse({ ResponseStatus: OK_STATUS }));
  const soa = new SoaClient(deps);
  for (let i = 0; i < 3; i++) assert.equal((await finishConversation(deps, soa, view)).kind, 'unknown');
  assert.equal(deps.fakeFetch.calls.length, 3);
});
