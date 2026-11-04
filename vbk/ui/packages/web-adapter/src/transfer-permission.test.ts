import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { UiMembers, UiPeripheralWrite } from '../../ipc/src/client.ts';
import { createRpc } from './rpc.ts';
import { ConversationStore, RoleBook } from './stores.ts';
import { SoaClient } from './soa.ts';
import { FakePageSdk, jsonResponse, makeDeps, OK_STATUS, sampleRow } from './testing.ts';

for (const mode of ['non_primary', 'demoted_after_selection', 'left_after_selection', 'b2mc'] as const) {
  test(`transfer rejects before write when authorization is ${mode}`, async () => {
    let reads = 0;
    const base = makeDeps(() => {
      reads++;
      const primary = mode !== 'non_primary' && !(mode === 'demoted_after_selection' && reads > 1);
      const present = !(mode === 'left_after_selection' && reads > 1);
      return jsonResponse({ ResponseStatus: OK_STATUS, status: { code: 0 }, members: [
        { uid: 'me', roles: primary ? [3, 4, 4] : [0, 3, 4], status: present ? '4' : '2' },
        { uid: 'chosen', roles: [0, 3, 4], status: '4' },
      ] });
    });
    const sdk = new FakePageSdk(), deps = { ...base, sdk }, store = new ConversationStore();
    store.update([sampleRow('123456', { conversationType: mode === 'b2mc' ? 'B2MC' : 'B2C' })]);
    const rpc = createRpc({ deps, soa: new SoaClient(deps), sdk, store, roles: new RoleBook('me'), pushFact() {}, pushDisplay() {}, agent: { current: () => null, set() {} } });
    const selected = await rpc.handle({ req_id: 'members', op: 'im.members', args: { gid: '123456' } });
    assert.ok(selected?.ok);
    const data = selected.data as UiMembers;
    assert.equal(data.members.find(m => m.uid === 'chosen')?.can_transfer, mode === 'demoted_after_selection' || mode === 'left_after_selection');
    const reply = await rpc.handle({ req_id: 'transfer', op: 'im.transfer', args: { gid: '123456', target_uid: 'chosen', selection_token: data.selection_token } });
    assert.ok(reply?.ok);
    const result = reply.data as UiPeripheralWrite;
    assert.equal(result.kind, 'not_submitted');
    assert.equal(base.fakeFetch.calls.some(call => call.url.includes('/transferVenMaster')), false);
    assert.equal(base.fakeFetch.calls.some(call => call.url.includes('/updateGroupOwner')), false);
  });
}

for (const action of ['transfer', 'remove'] as const) {
  test(`rolesV2 vendor code 5 remains eligible for ${action}; exact company tuple does not`, async () => {
    let written = false;
    const base = makeDeps(call => {
      if (call.url.includes('/transferVenMaster') || call.url.includes('/finishConversation')) {
        written = true;
        return jsonResponse({ ResponseStatus: OK_STATUS, bizResponseStatus: { resultCode: 'SUCCESS' } });
      }
      return jsonResponse({ ResponseStatus: OK_STATUS, status: { code: 0 }, members: [
        { uid: 'me', roles: [3, 4, 4], status: '4' },
        { uid: 'vendor5', roles: written && action === 'transfer' ? [3, 4, 4] : [0, 3, 4], rolesv2: [0, 4, 5], status: written && action === 'remove' ? '2' : '4' },
        { uid: 'company', roles: [0, 3, 4], rolesv2: [0, 3, 5], status: '4' },
      ] });
    });
    const sdk = new FakePageSdk(), deps = { ...base, sdk }, store = new ConversationStore();
    store.update([sampleRow('123456')]);
    const rpc = createRpc({ deps, soa: new SoaClient(deps), sdk, store, roles: new RoleBook('me'), pushFact() {}, pushDisplay() {}, agent: { current: () => null, set() {} } });
    const selected = await rpc.handle({ req_id: 'members', op: 'im.members', args: { gid: '123456' } });
    assert.ok(selected?.ok);
    const data = selected.data as UiMembers;
    const vendor = data.members.find(m => m.uid === 'vendor5');
    assert.equal(vendor?.role, 'agent');
    assert.equal(vendor?.can_transfer, true);
    assert.equal(vendor?.can_remove, true);
    assert.equal(data.members.some(m => m.uid === 'company'), false);
    const args = { gid: '123456', selection_token: data.selection_token, ...(action === 'transfer' ? { target_uid: 'company' } : { target_uids: ['company'] }) };
    const denied = await rpc.handle({ req_id: 'company', op: `im.${action}`, args });
    assert.ok(denied?.ok);
    assert.equal((denied.data as UiPeripheralWrite).kind, 'not_submitted');
    assert.equal(written, false);
    const reply = await rpc.handle({ req_id: 'vendor', op: `im.${action}`, args: { ...args, ...(action === 'transfer' ? { target_uid: 'vendor5' } : { target_uids: ['vendor5'] }) } });
    assert.ok(reply?.ok);
    assert.equal((reply.data as UiPeripheralWrite).kind, 'confirmed');
    assert.equal(written, true);
    assert.equal(base.fakeFetch.calls.filter(c => c.url.includes(action === 'transfer' ? '/transferVenMaster' : '/finishConversation')).length, 1);
  });
}
