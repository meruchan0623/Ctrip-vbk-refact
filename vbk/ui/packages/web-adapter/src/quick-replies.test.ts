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
  const { deps, rpc, sdk } = setup({ ResponseStatus: OK_STATUS, categories: [{ id: 1, name: 'Root', customerScripts: [{ id: 2, content: 'reply', shortCut: 'r', type: 'VAGENT' }], subCategories: [{ id: 3, name: 'Child' }] }] });
  for (const type of ['VAGENT', 'VSKILLGROUP']) {
    const reply = await rpc.handle({ req_id: type, op: 'im.quick_reply_categories', args: { type } });
    assert.equal(reply?.ok, true);
    if (!reply?.ok) continue;
    assert.deepEqual(reply.data, { categories: [{ id: '1', name: 'Root', scripts: [{ id: '2', content: 'reply', short_cut: 'r', type: 'VAGENT' }], sub_categories: [{ id: '3', name: 'Child', scripts: [], sub_categories: [] }] }] });
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
  assert.deepEqual(reply.data, { kind: 'ready', raw_count: 4, items: [{ id: 'suggestion-0', content: 'Hello', short_cut: '', type: 'VAGENT' }, { id: '8', content: 'Team', short_cut: 't', type: 'VSKILLGROUP' }] });
  assert.equal((deps.fakeFetch.calls[0]!.bodyJson as { content: string }).content, 'he');
  assert.equal(sdk.sent.length, 0);
});
