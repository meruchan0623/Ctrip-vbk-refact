import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRpc } from './rpc.ts';
import { SoaClient } from './soa.ts';
import { ConversationStore, RoleBook } from './stores.ts';
import { FakePageSdk, jsonResponse, makeDeps, OK_STATUS } from './testing.ts';

function setup(body: unknown) {
  const deps = makeDeps(() => jsonResponse(body));
  const sdk = new FakePageSdk();
  const rpc = createRpc({ deps, sdk, soa: new SoaClient(deps), store: new ConversationStore(), roles: new RoleBook('me'), pushFact: () => {}, pushDisplay: () => {}, agent: { current: () => null, set: () => {} } });
  return { deps, sdk, rpc };
}

test('quick reply RPC maps personal/team recursive categories and refuses unsupported types before fetch', async () => {
  const { deps, rpc, sdk } = setup({
    ResponseStatus: OK_STATUS,
    categories: [{
      id: 1, code: 'cat-1', name: 'Root', ownerType: 1, vSkillGroups: [{ skillGroupId: 501, skillGroupName: 'SG1' }, { skillGroupId: 'x' }, { skillGroupId: '502' }],
      customerScripts: [{ id: 4, content: 'later', sortNo: 2 }, { id: 2, content: 'reply', shortCut: 'r', type: 'VAGENT', sortNo: 1 }],
      subCategories: [{ id: 3, name: 'Child', code: '', ownerType: '1' }],
    }],
  });
  for (const type of ['VAGENT', 'VSKILLGROUP']) {
    const reply = await rpc.handle({ req_id: type, op: 'im.quick_reply_categories', args: { type } });
    assert.equal(reply?.ok, true);
    if (!reply?.ok) continue;
    // code / owner_type / skill_groups / sort_no feed the management view; scripts are in sortNo order,
    // an empty code and a non-numeric ownerType are reported as null, skill groups without an ID are dropped
    assert.deepEqual(reply.data, {
      categories: [{
        id: '1', name: 'Root', code: 'cat-1', owner_type: 1, skill_groups: [{ id: '501', name: 'SG1' }, { id: '502', name: '502' }],
        scripts: [{ id: '2', content: 'reply', short_cut: 'r', type: 'VAGENT', sort_no: 1 }, { id: '4', content: 'later', short_cut: '', type: '', sort_no: 2 }],
        sub_categories: [{ id: '3', name: 'Child', code: null, owner_type: null, skill_groups: [], scripts: [], sub_categories: [], script_total: 0 }],
        script_total: 2,
      }],
    });
    assert.deepEqual((deps.fakeFetch.calls.at(-1)!.bodyJson as { typeList: string[] }).typeList, [type]);
  }
  assert.equal((await rpc.handle({ req_id: 'bad', op: 'im.quick_reply_categories', args: { type: 'OTHER' } }))?.ok, false);
  assert.equal(deps.fakeFetch.calls.length, 2);
  assert.equal(sdk.sent.length, 0);
});

test('suggestions require content but accept official content/type rows without IDs and trim query', async () => {
  const { deps, rpc, sdk } = setup({ ResponseStatus: OK_STATUS, customerScripts: [{ content: 'Hello', type: 'VAGENT' }, { content: ' ' }, { mystery: 'secret' }, { id: 8, content: 'Team', type: 'VSKILLGROUP', shortCut: 't' }] });
  const reply = await rpc.handle({ req_id: 'suggest', op: 'im.customer_scripts', args: { content: '  he  ' } });
  assert.equal(reply?.ok, true);
  if (!reply?.ok) return;
  // sort_no falls back to the row index when the suggestion row has none (the host DTO drops it on this path)
  assert.deepEqual(reply.data, { kind: 'ready', raw_count: 4, items: [{ id: 'suggestion-0', content: 'Hello', short_cut: '', type: 'VAGENT', sort_no: 0 }, { id: '8', content: 'Team', short_cut: 't', type: 'VSKILLGROUP', sort_no: 3 }] });
  assert.equal((deps.fakeFetch.calls[0]!.bodyJson as { content: string }).content, 'he');
  assert.equal(sdk.sent.length, 0);
});
