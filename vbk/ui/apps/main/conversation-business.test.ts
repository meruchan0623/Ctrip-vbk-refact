import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import * as vm from './viewmodel.ts';
import { createStore } from '../../packages/ui-kit/src/store.ts';
import { cx } from '../../packages/ui-kit/src/h.ts';
import type { UiConversation } from '../../packages/ipc/src/client.ts';
import { isUiConversation } from '../_shared/guards.ts';
import { toDisplayConversation } from '../../packages/web-adapter/src/display.ts';
import { sampleRow } from '../../packages/web-adapter/src/testing.ts';

const source = readFileSync(process.env['VBK_BUSINESS_MAIN_SOURCE'] ?? new URL('./main.ts', import.meta.url), 'utf8');
const account = { account_id: 'synthetic-business', environment: 'synthetic', session_generation: 1 };
type BusinessRow = UiConversation & { readonly conversation_type?: string | null };
function row(gid: string, conversation_type?: string | null, status: UiConversation['status'] = 'active', service_type = '1513'): BusinessRow {
  return { account, gid, ...(conversation_type === undefined ? {} : { conversation_type }), status, agent_in_group: true, is_owner: true, service_type, last_message_time_ms: 1000, last_update_time_ms: 1000, unread_count: 0, is_full_snapshot: true, title: gid, color: '#000', lang: 'zh', biz: 'synthetic', preview: 'synthetic preview', draft: '', is_top: false, mark: 0, waiting_since_ms: null, waiting_confirmed: false, customer_tags: [], order: null };
}
interface Node { tag: string; props: Record<string, any>; children: unknown[] }
function nodes(tree: unknown): Node[] { if (Array.isArray(tree)) return tree.flatMap(nodes); if (!tree || typeof tree !== 'object') return []; const n = tree as Node; return [n, ...nodes(n.children ?? [])]; }
function fixture() {
  const rows = [row('customer', 'B2C'), row('customer-finished', 'C2B', 'finished'), row('customer-status-unknown', 'B2MC', 'unknown'), row('enterprise', 'B2B'), row('special-customer', 'O2B', 'active', '2573'), row('ordinary-enterprise', 'O2B'), row('missing'), row('null-type', null, 'finished'), row('future-type', 'FUTURE', 'active')];
  const store = createStore<Record<string, any>>({ accounts: { active_account_id: account.account_id, accounts: [{ context: account, state: 'online' }], max_accounts: 16 }, conversations: rows, business: 'customer', tab: 'doing', query: '', activeGid: 'customer', draft: 'SYNTHETIC DRAFT', drafts: { customer: 'SYNTHETIC DRAFT' }, messages: {}, now: 1000, agent: { status: 'online', confirmed: true }, net: null, ctxMenu: null, meMenu: false });
  const sideEffects: unknown[] = [];
  const env: Record<string, any> = { ...vm, document: {}, store, S: () => store.get(), cx, activeAccount: () => ({ context: account, state: 'online' }), h: (tag: string, props: object | null, ...children: unknown[]) => ({ tag, props: props ?? {}, children }), t: (key: string) => key, icon: () => null, IC: {}, accBadge: () => null, formatRelativeTime: () => '', renderMessageAvatar: () => null, formatDuration: () => '', RED_AFTER_SECONDS: 90, waitedSeconds: () => 0, openConversation: (...args: unknown[]) => sideEffects.push(args), ipc: { invoke: (...args: unknown[]) => sideEffects.push(args) } };
  const a = source.indexOf('function conversationList('), b = source.indexOf('\nfunction contextMenu(', a);
  const render = new Function(...Object.keys(env), stripTypeScriptTypes(source.slice(a, b)) + '\nreturn conversationList;')(...Object.values(env));
  const resetA = source.indexOf('const ACCOUNT_SCOPED_RESET ='), resetB = source.indexOf('} as const satisfies Partial<MainState>;', resetA) + '} as const satisfies Partial<MainState>;'.length;
  const reset = new Function('TRANSLATION_IDLE', 'PKG_IDLE', stripTypeScriptTypes(source.slice(resetA, resetB)) + '\nreturn ACCOUNT_SCOPED_RESET;')(vm.TRANSLATION_IDLE, {});
  Object.assign(env, { ACCOUNT_SCOPED_RESET: reset, activeAccount: () => store.get().accounts.accounts.find((a: any) => a.context.account_id === store.get().accounts.active_account_id), peripheral: { close() {} }, receiveDiagnostics: { close() {} }, unknownOutbound: { close() {} }, loadForActiveAccount: async () => undefined });
  const accountA = source.indexOf('function applyAccountSnapshot('), accountB = source.indexOf('\nasync function switchAccount(', accountA);
  const applyAccount = new Function(...Object.keys(env), stripTypeScriptTypes(source.slice(accountA, accountB)) + '\nreturn applyAccountSnapshot;')(...Object.values(env));
  return { store, sideEffects, applyAccount, tree: () => render(store.get()) as Node, click: (key: string, value: string) => { const button = nodes(render(store.get())).find(n => n.props.dataset?.[key] === value); assert.ok(button, `${key}=${value}`); button.props.onclick(); } };
}
const visible = (tree: unknown) => nodes(tree).filter(n => n.props.dataset?.gid).map(n => n.props.dataset.gid);

test('actual business tabs classify BC/BOP and preserve current room and draft without IPC or opening a room', () => {
  const f = fixture();
  assert.ok(nodes(f.tree()).some(n => n.props.dataset?.business === 'customer'));
  assert.deepEqual(visible(f.tree()), ['customer', 'special-customer']);
  f.click('business', 'enterprise'); assert.deepEqual(visible(f.tree()), ['enterprise', 'ordinary-enterprise']);
  assert.equal(f.store.get().activeGid, 'customer'); assert.equal(f.store.get().draft, 'SYNTHETIC DRAFT'); assert.equal(f.store.get().drafts.customer, 'SYNTHETIC DRAFT'); assert.deepEqual(f.sideEffects, []);
  f.click('business', 'customer'); f.click('tab', 'done'); assert.deepEqual(visible(f.tree()), ['customer-finished']);
  assert.deepEqual(f.sideEffects, []);
});

test('actual pending-check entries expose unknown status/types without mixing them into processing counts', () => {
  const f = fixture(); const processing = nodes(f.tree()).find(n => n.props.dataset?.serving);
  assert.equal(processing?.props.dataset.serving, '2');
  f.click('tab', 'unknown'); assert.deepEqual(visible(f.tree()), ['customer-status-unknown']);
  f.click('business', 'unknown'); assert.deepEqual(visible(f.tree()), ['missing', 'null-type', 'future-type']);
  assert.equal(nodes(f.tree()).find(n => n.props.dataset?.serving)?.props.dataset.serving, '0');
  assert.deepEqual(f.sideEffects, []);
});

test('business counts ignore search while visible rows respect search; reset explicitly selects customer processing', () => {
  const f = fixture(); f.store.patch({ query: 'special' }); assert.deepEqual(visible(f.tree()), ['special-customer']);
  assert.equal(nodes(f.tree()).find(n => n.props.dataset?.serving)?.props.dataset.serving, '2');
  f.click('business', 'enterprise');
  f.applyAccount({ ...f.store.get().accounts, accounts: [{ context: account, state: 'online', unread_total: 3 }] });
  assert.equal(f.store.get().business, 'enterprise', 'same-owner metadata broadcasts keep the selected business');
  const other = { ...account, account_id: 'synthetic-other' };
  f.applyAccount({ active_account_id: other.account_id, max_accounts: 16, accounts: [{ context: other, state: 'online' }] });
  assert.equal(f.store.get().business, 'customer'); assert.equal(f.store.get().tab, 'doing');
});

test('conversation guard accepts legacy/null/unknown short types but rejects malformed type metadata', () => {
  for (const type of [undefined, null, 'B2C', 'FUTURE_TYPE', ' B2C ', 'x'.repeat(64), '😀'.repeat(32)]) assert.equal(isUiConversation(row('synthetic', type)), true);
  for (const type of [1, {}, '', '  ', '\nB2C', '\u0085B2C', 'x'.repeat(65), '😀'.repeat(33)]) assert.equal(isUiConversation({ ...row('synthetic'), conversation_type: type }), false);
});

test('official type matrix and every known UI status remain separate; ownership flags never hide rows', () => {
  for (const type of ['B2C', 'C2B', 'B2MC']) assert.equal(vm.conversationBusiness(row(type, type)), 'customer');
  for (const type of ['B2O', 'O2B', 'B2B']) assert.equal(vm.conversationBusiness(row(type, type)), 'enterprise');
  assert.equal(vm.conversationBusiness(row('special', 'O2B', 'active', '2573')), 'customer');
  assert.equal(vm.conversationBusiness(row('wrong-case', 'b2c')), 'unknown');
  assert.equal(vm.conversationBusiness(row('padded-type', ' B2C ')), 'unknown');
  const customer = [row('active', 'B2C'), row('finished', 'B2C', 'finished'), row('transferred', 'B2C', 'transferred_out'), row('unknown', 'B2C', 'unknown')].map(c => ({ ...c, is_owner: false, agent_in_group: false }));
  assert.deepEqual(vm.tabCounts(customer, 'customer'), { doing: 1, done: 2, unknown: 1 });
  assert.deepEqual(vm.filterConversations(customer, 'doing', '', 'customer').map(c => c.gid), ['active']);
  assert.deepEqual(vm.filterConversations(customer, 'unknown', '', 'customer').map(c => c.gid), ['unknown']);
});

test('real producer status 1/2/4 and raw conversation type flow through guard into scoped UI counts', () => {
  const rows = [1, 2, 4, 99].map((status, i) => {
    const projected = toDisplayConversation(sampleRow(`synthetic-${i}`, { status, conversationType: 'B2C' }), false);
    assert.ok(projected);
    const c = { ...projected, account, draft: '', is_top: false, waiting_since_ms: null, waiting_confirmed: false };
    assert.equal(isUiConversation(c), true); return c;
  });
  assert.deepEqual(vm.tabCounts(rows, 'customer'), { doing: 2, done: 1, unknown: 1 });
  assert.deepEqual(vm.filterConversations(rows, 'doing', '', 'customer').map(c => c.gid), ['synthetic-0', 'synthetic-1']);
});
