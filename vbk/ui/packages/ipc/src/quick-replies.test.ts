import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockIpc } from './mock.ts';
import { AccountCommands } from './commands.ts';
import { ErrorCodes } from './contracts.ts';
import {
  UiCommands,
  type UiAccountSnapshot,
  type UiConversation,
  type UiQuickReplyCategories,
  type UiCustomerScripts,
  type UiQuickReplyEdit,
  type UiQuickReplyEditResult,
  type UiQuickReplyManageInfo,
  type UiQuickReplyType,
} from './client.ts';
import type { UiRecommendProducts, UiRecommendSend } from './recommend.ts';

test('mock quick replies expose personal/team drafts and keyword suggestions', async () => {
  const ipc = createMockIpc('default', { tick: false, latency: 0 });
  try {
    const account = (await ipc.invoke<UiAccountSnapshot>(AccountCommands.SNAPSHOT)).accounts[0]!.context;
    for (const type of ['VAGENT', 'VSKILLGROUP']) {
      const categories = await ipc.invoke<UiQuickReplyCategories>(UiCommands.IM_QUICK_REPLY_CATEGORIES, { account, type });
      assert.equal(categories.categories[0]!.scripts[0]!.type, type);
    }
    const result = await ipc.invoke<UiCustomerScripts>(UiCommands.IM_CUSTOMER_SCRIPTS, { account, content: ' 您好 ' });
    assert.equal(result.kind, 'ready');
    assert.equal(result.items?.length, 1);
    assert.equal((await ipc.invoke<UiCustomerScripts>(UiCommands.IM_CUSTOMER_SCRIPTS, { account, content: 'no match' })).kind, 'empty');
  } finally { ipc.dispose(); }
});

test('mock product pages consume one explicit selection per send', async () => {
  const ipc = createMockIpc('default', { tick: false, latency: 0 });
  try {
    const account = (await ipc.invoke<UiAccountSnapshot>(AccountCommands.SNAPSHOT)).accounts[0]!.context;
    const gid = (await ipc.invoke<UiConversation[]>(UiCommands.IM_CONVERSATIONS, { account }))[0]!.gid;
    const page = await ipc.invoke<UiRecommendProducts>(UiCommands.IM_RECOMMEND_PRODUCTS, { account, gid, query: '', page_index: 0 });
    assert.equal(page.items.length, 2); assert.equal(page.has_more, true);
    const next = await ipc.invoke<UiRecommendProducts>(UiCommands.IM_RECOMMEND_PRODUCTS, { account, gid, query: '', page_index: 1 });
    assert.equal(next.items.length, 1); assert.equal(next.has_more, false);
    const args = { account, gid, selection_token: page.selection_token, product_id: page.items[0]!.id };
    assert.equal((await ipc.invoke<UiRecommendSend>(UiCommands.IM_SEND_PRODUCT_CARD, { ...args, product_id: next.items[0]!.id })).kind, 'not_submitted');
    assert.equal((await ipc.invoke<UiRecommendSend>(UiCommands.IM_SEND_PRODUCT_CARD, args)).kind, 'confirmed');
    assert.equal((await ipc.invoke<UiRecommendSend>(UiCommands.IM_SEND_PRODUCT_CARD, args)).kind, 'not_submitted');
  } finally { ipc.dispose(); }
});

async function manageFixture(options: Parameters<typeof createMockIpc>[1] = {}) {
  const ipc = createMockIpc('default', { tick: false, latency: 0, ...options });
  const account = (await ipc.invoke<UiAccountSnapshot>(AccountCommands.SNAPSHOT)).accounts[0]!.context;
  const read = async (type: UiQuickReplyType = 'VAGENT') => (await ipc.invoke<UiQuickReplyCategories>(UiCommands.IM_QUICK_REPLY_CATEGORIES, { account, type })).categories;
  const edit = (edit: UiQuickReplyEdit, type: UiQuickReplyType = 'VAGENT') => ipc.invoke<UiQuickReplyEditResult>(UiCommands.IM_QUICK_REPLY_EDIT, { account, type, edit });
  const info = (type: UiQuickReplyType) => ipc.invoke<UiQuickReplyManageInfo>(UiCommands.IM_QUICK_REPLY_MANAGE_INFO, { account, type });
  return { ipc, account, read, edit, info };
}
const ids = (list: readonly { id: string }[]) => list.map((x) => x.id);

test('mock quick-reply seed has an empty personal group and team groups with skill groups', async () => {
  const f = await manageFixture();
  try {
    const personal = await f.read('VAGENT'), team = await f.read('VSKILLGROUP');
    assert.ok(personal.length >= 3 && personal.some((c) => c.scripts.length === 0));
    assert.ok(personal.every((c) => (c.skill_groups ?? []).length === 0));
    assert.ok(team.length >= 2 && team.every((c) => (c.skill_groups ?? []).length >= 1));
    assert.deepEqual(await f.info('VAGENT'), { can_edit: true, skill_groups: [] });
    const teamInfo = await f.info('VSKILLGROUP');
    assert.equal(teamInfo.can_edit, true); assert.ok(teamInfo.skill_groups.length >= 2);
  } finally { f.ipc.dispose(); }
});

test('mock quick-reply edits apply all nine operations and answer the fresh list', async () => {
  const f = await manageFixture();
  try {
    const before = await f.read();
    const created = await f.edit({ op: 'create_category', name: '  Promo  ', skill_group_ids: [] });
    assert.equal(created.kind, 'applied');
    const fresh = created.categories!.find((c) => !ids(before).includes(c.id))!;
    assert.equal(fresh.name, 'Promo'); assert.deepEqual(fresh.scripts, []);
    assert.deepEqual(created.categories, await f.read(), 'applied carries the read-back list');
    assert.equal((await f.edit({ op: 'update_category', category_id: fresh.id, name: 'Deals', skill_group_ids: [] })).kind, 'applied');
    const added = await f.edit({ op: 'add_script', category_id: fresh.id, content: 'line one' });
    const script = added.categories!.find((c) => c.id === fresh.id)!.scripts[0]!;
    assert.equal(script.content, 'line one'); assert.equal(script.type, 'VAGENT');
    await f.edit({ op: 'add_script', category_id: fresh.id, content: 'line two' });
    const updated = await f.edit({ op: 'update_script', script_id: script.id, content: 'line 1' });
    assert.deepEqual(updated.categories!.find((c) => c.id === fresh.id)!.scripts.map((s) => s.content), ['line 1', 'line two']);
    const order = ids((await f.read()).find((c) => c.id === fresh.id)!.scripts);
    const sorted = await f.edit({ op: 'sort_scripts', category_id: fresh.id, script_ids: [...order].reverse() });
    assert.deepEqual(ids(sorted.categories!.find((c) => c.id === fresh.id)!.scripts), [...order].reverse());
    const target = before[0]!;
    const moved = await f.edit({ op: 'move_script', script_id: script.id, target_category_id: target.id });
    assert.ok(ids(moved.categories!.find((c) => c.id === target.id)!.scripts).includes(script.id));
    assert.equal(ids(moved.categories!.find((c) => c.id === fresh.id)!.scripts).includes(script.id), false);
    assert.equal((await f.edit({ op: 'delete_script', script_id: script.id })).kind, 'applied');
    const catOrder = ids(await f.read());
    const catSorted = await f.edit({ op: 'sort_categories', category_ids: [...catOrder].reverse() });
    assert.deepEqual(ids(catSorted.categories!), [...catOrder].reverse());
    const leftover = ids((await f.read()).find((c) => c.id === fresh.id)!.scripts);
    assert.equal(leftover.length, 1);
    const deleted = await f.edit({ op: 'delete_category', category_id: fresh.id });
    assert.equal(deleted.kind, 'applied');
    assert.equal(deleted.categories!.some((c) => c.id === fresh.id), false);
    // The group's scripts went with it: editing one of them is now stale.
    assert.deepEqual(await f.edit({ op: 'delete_script', script_id: leftover[0]! }), { kind: 'rejected', reason: 'stale', categories: await f.read() });
  } finally { f.ipc.dispose(); }
});

test('mock quick-reply edits refuse invalid input, missing targets and non-permutations', async () => {
  const f = await manageFixture();
  try {
    const list = await f.read(), first = list[0]!, other = list[1]!;
    const invalid: unknown[] = [
      { op: 'create_category', name: '   ', skill_group_ids: [] },
      { op: 'create_category', name: 'x'.repeat(16), skill_group_ids: [] },
      { op: 'create_category', name: 'Ok', skill_group_ids: ['7001'] },
      { op: 'add_script', category_id: first.id, content: ' ' },
      { op: 'add_script', category_id: first.id, content: 'y'.repeat(5001) },
      { op: 'delete_script', script_id: 'abc' },
      { op: 'sort_categories', category_ids: [] },
      { op: 'sort_categories', category_ids: [first.id, first.id] },
      { op: 'rename_everything' },
      null,
    ];
    for (const edit of invalid) assert.deepEqual(await f.edit(edit as UiQuickReplyEdit), { kind: 'rejected', reason: 'invalid' }, JSON.stringify(edit));
    const stale = (r: UiQuickReplyEditResult, categories = list) => { assert.equal(r.kind, 'rejected'); assert.equal(r.reason, 'stale'); assert.deepEqual(r.categories, categories); };
    stale(await f.edit({ op: 'update_category', category_id: '999999', name: 'Gone', skill_group_ids: [] }));
    stale(await f.edit({ op: 'delete_category', category_id: '999999' }));
    stale(await f.edit({ op: 'add_script', category_id: '999999', content: 'hello' }));
    stale(await f.edit({ op: 'update_script', script_id: '999999', content: 'hello' }));
    stale(await f.edit({ op: 'move_script', script_id: first.scripts[0]!.id, target_category_id: first.id }));
    stale(await f.edit({ op: 'move_script', script_id: first.scripts[0]!.id, target_category_id: '999999' }));
    stale(await f.edit({ op: 'sort_categories', category_ids: ids(list).slice(1) }));
    stale(await f.edit({ op: 'sort_categories', category_ids: [...ids(list).slice(1), '999999'] }));
    stale(await f.edit({ op: 'sort_scripts', category_id: first.id, script_ids: ids(first.scripts).slice(1) }));
    stale(await f.edit({ op: 'sort_scripts', category_id: other.id, script_ids: ids(first.scripts) }));
    stale(await f.edit({ op: 'create_category', name: 'Team', skill_group_ids: ['999999'] }, 'VSKILLGROUP'), await f.read('VSKILLGROUP'));
    assert.deepEqual(await f.read(), list, 'nothing was written');
    // Text trigger (same convention as the send mock): the server refuses with a business code.
    const refused = await f.edit({ op: 'add_script', category_id: first.id, content: String.fromCharCode(0x62d2, 0x7edd) });
    assert.equal(refused.kind, 'rejected'); assert.equal(refused.reason, 'business'); assert.equal(refused.detail, 'MOCK_REFUSED');
    assert.deepEqual(refused.categories, list);
  } finally { f.ipc.dispose(); }
});

test('mock quick-reply team writes need a leader; personal writes do not', async () => {
  const f = await manageFixture({ quickReplies: { not_leader: true } });
  try {
    assert.equal((await f.info('VSKILLGROUP')).can_edit, false);
    assert.equal((await f.info('VAGENT')).can_edit, true);
    const team = await f.read('VSKILLGROUP');
    assert.deepEqual(await f.edit({ op: 'delete_category', category_id: team[0]!.id }, 'VSKILLGROUP'), { kind: 'rejected', reason: 'not_leader', categories: team });
    assert.equal((await f.edit({ op: 'create_category', name: 'Mine', skill_group_ids: [] })).kind, 'applied');
    f.ipc.quickReplyFaults({ not_leader: false });
    assert.equal((await f.info('VSKILLGROUP')).can_edit, true);
    const created = await f.edit({ op: 'create_category', name: 'Night', skill_group_ids: ['7001', '7003'] }, 'VSKILLGROUP');
    assert.equal(created.kind, 'applied');
    assert.deepEqual(created.categories!.at(-1)!.skill_groups!.map((g) => g.id), ['7001', '7003']);
    assert.deepEqual(await f.read('VSKILLGROUP'), created.categories);
  } finally { f.ipc.dispose(); }
});

test('mock quick-reply unknown injection is consumed once and the read-back tells applied from not applied', async () => {
  const f = await manageFixture();
  try {
    const list = await f.read(), first = list[0]!;
    f.ipc.quickReplyFaults({ unknown_next: 'not_applied' });
    const lost = await f.edit({ op: 'delete_category', category_id: first.id });
    assert.equal(lost.kind, 'unknown'); assert.deepEqual(lost.categories, list);
    assert.deepEqual(await f.read(), list);
    f.ipc.quickReplyFaults({ unknown_next: 'applied' });
    // A refused edit never reached the server and does not consume the injection.
    assert.equal((await f.edit({ op: 'delete_category', category_id: '999999' })).reason, 'stale');
    const landed = await f.edit({ op: 'update_category', category_id: first.id, name: 'Renamed', skill_group_ids: [] });
    assert.equal(landed.kind, 'unknown'); assert.equal(landed.categories!.find((c) => c.id === first.id)!.name, 'Renamed');
    f.ipc.quickReplyFaults({ unknown_next: 'no_readback' });
    const blind = await f.edit({ op: 'update_category', category_id: first.id, name: 'Again', skill_group_ids: [] });
    assert.equal(blind.kind, 'unknown'); assert.equal(blind.categories, undefined);
    assert.equal((await f.read()).find((c) => c.id === first.id)!.name, 'Again');
    assert.equal((await f.edit({ op: 'update_category', category_id: first.id, name: 'Third', skill_group_ids: [] })).kind, 'applied');
  } finally { f.ipc.dispose(); }
});

test('mock quick-reply stores are per account, one write runs at a time, stale generations are refused', async () => {
  const f = await manageFixture();
  try {
    const other = (await f.ipc.invoke<UiAccountSnapshot>(AccountCommands.SNAPSHOT)).accounts[1]!.context;
    const first = (await f.read())[0]!;
    await f.edit({ op: 'delete_category', category_id: first.id });
    const theirs = (await f.ipc.invoke<UiQuickReplyCategories>(UiCommands.IM_QUICK_REPLY_CATEGORIES, { account: other, type: 'VAGENT' })).categories;
    assert.ok(theirs.some((c) => c.id === first.id), 'another account keeps its own groups');
    const [a, b] = await Promise.all([
      f.edit({ op: 'create_category', name: 'One', skill_group_ids: [] }),
      f.edit({ op: 'create_category', name: 'Two', skill_group_ids: [] }),
    ]);
    assert.equal(a.kind, 'applied'); assert.deepEqual(b, { kind: 'rejected', reason: 'busy' });
    const kept = ids(await f.read());
    const old = { ...f.account, session_generation: f.account.session_generation - 1 };
    await assert.rejects(f.ipc.invoke(UiCommands.IM_QUICK_REPLY_EDIT, { account: old, type: 'VAGENT', edit: { op: 'delete_category', category_id: kept[0]! } }), (e: { code?: string }) => e.code === ErrorCodes.ACCOUNT_STALE_GENERATION);
    await assert.rejects(f.ipc.invoke(UiCommands.IM_QUICK_REPLY_CATEGORIES, { account: f.account, type: 'OTHER' }));
    assert.deepEqual(ids(await f.read()), kept);
    // A generation change while the write is out: unknown without a list, never an error (host semantics).
    const [late] = await Promise.all([
      f.edit({ op: 'create_category', name: 'Late', skill_group_ids: [] }),
      f.ipc.invoke(AccountCommands.LOGOUT, { account: f.account }),
    ]);
    assert.deepEqual(late, { kind: 'unknown', reason: 'write_unknown' });
  } finally { f.ipc.dispose(); }
});
