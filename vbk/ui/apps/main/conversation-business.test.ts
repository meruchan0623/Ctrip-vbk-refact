import { isUiAccountSnapshot } from '../_shared/guards.ts';
import { createAccountNavigation } from './account-navigation.ts';
import { EMPTY_NOTICE_QUERY } from './notice-query.ts';
import { EMPTY_EVENT_QUERY } from './event-query.ts';
import { EVENT_PICKER_CLOSED } from './events-view.ts';
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
  const env: Record<string, any> = { pruneTabAttention: (list: readonly string[]) => list, viewingAccountId: () => null, restoreRoomAttachment: async () => undefined, memberPillsFor: () => ({ count: null, isMaster: false }), accountNavigation: createAccountNavigation({ switch: async () => null, snapshot: async () => null, valid: isUiAccountSnapshot }), closeCommerce() {}, noticeQuery: { reset() {} }, ...vm, document: {}, store, part: (_name: string, build: () => unknown) => build(), S: () => store.get(), cx, activeAccount: () => ({ context: account, state: 'online' }), h: (tag: string, props: object | null, ...children: unknown[]) => ({ tag, props: props ?? {}, children }), t: (key: string) => key, icon: () => null, IC: {}, accBadge: () => null, formatRelativeTime: () => '', renderMessageAvatar: () => null, formatDuration: () => '', RED_AFTER_SECONDS: 90, waitedSeconds: () => 0, openConversation: (...args: unknown[]) => sideEffects.push(args), ipc: { invoke: (...args: unknown[]) => sideEffects.push(args) } };
  const a = source.indexOf('function conversationList('), b = source.indexOf('\nfunction contextMenu(', a);
  const render = new Function(...Object.keys(env), stripTypeScriptTypes(source.slice(a, b)) + '\nreturn conversationList;')(...Object.values(env));
  const resetA = source.indexOf('const ACCOUNT_SCOPED_RESET ='), resetB = source.indexOf('} as const satisfies Partial<MainState>;', resetA) + '} as const satisfies Partial<MainState>;'.length;
  const reset = new Function('TRANSLATION_IDLE', 'PKG_IDLE', 'EMPTY_NOTICE_QUERY', 'EMPTY_EVENT_QUERY', 'EVENT_PICKER_CLOSED', stripTypeScriptTypes(source.slice(resetA, resetB)) + '\nreturn ACCOUNT_SCOPED_RESET;')(vm.TRANSLATION_IDLE, {}, EMPTY_NOTICE_QUERY, EMPTY_EVENT_QUERY, EVENT_PICKER_CLOSED);
  Object.assign(env, { closeRuntimeLog() {}, eventQuery: { reset() {} }, ACCOUNT_SCOPED_RESET: reset, activeAccount: () => store.get().accounts.accounts.find((a: any) => a.context.account_id === store.get().accounts.active_account_id), peripheral: { close() {} }, receiveDiagnostics: { close() {} }, unknownOutbound: { close() {} }, loadForActiveAccount: async () => undefined });
  const accountA = source.indexOf('function applyAccountSnapshot('), accountB = source.indexOf('\nasync function switchAccount(', accountA);
  const applyAccount = new Function(...Object.keys(env), stripTypeScriptTypes(source.slice(accountA, accountB)) + '\nreturn applyAccountSnapshot;')(...Object.values(env));
  return { store, sideEffects, applyAccount, tree: () => render(store.get()) as Node, click: (key: string, value: string) => { const button = nodes(render(store.get())).find(n => n.props.dataset?.[key] === value); assert.ok(button, `${key}=${value}`); button.props.onclick(); } };
}
const visible = (tree: unknown) => nodes(tree).filter(n => n.props.dataset?.gid).map(n => n.props.dataset.gid);

test('customer-only list has exactly pending/done tabs and preserves room/draft on filtering', () => {
  const f = fixture();
  assert.ok(!nodes(f.tree()).some(n => n.props.dataset?.business));
  assert.deepEqual(nodes(f.tree()).filter(n => n.props.dataset?.tab).map(n => n.props.dataset.tab), ['doing', 'done']);
  assert.deepEqual(visible(f.tree()), ['customer', 'customer-status-unknown', 'special-customer']);
  f.click('tab', 'done'); assert.deepEqual(visible(f.tree()), ['customer-finished']);
  assert.equal(f.store.get().activeGid, 'customer'); assert.equal(f.store.get().draft, 'SYNTHETIC DRAFT');
  assert.deepEqual(f.sideEffects, []);
});

test('customer counts ignore search and legacy business selection cannot expose enterprise rows', () => {
  const f = fixture(); f.store.patch({ query: 'special', business: 'enterprise' });
  assert.deepEqual(visible(f.tree()), ['special-customer']);
  assert.equal(nodes(f.tree()).find(n => n.props.dataset?.tab === 'doing')?.children[0], 'list.doing 3');
  assert.ok(!nodes(f.tree()).some(n => n.props.dataset?.serving), 'counts appear only in the tabs below the status control');
  const other = { ...account, account_id: 'synthetic-other' };
  f.applyAccount({ active_account_id: other.account_id, max_accounts: 16, accounts: [{ context: other, state: 'online' }] });
  assert.equal(f.store.get().business, 'customer'); assert.equal(f.store.get().tab, 'doing');
});

test('work status menu opens beside its own button, toggles closed, and resets on account switch', () => {
  const f = fixture();
  const toggle = () => {
    const button = nodes(f.tree()).find(n => n.props.dataset?.fid === 'agent-status-toggle');
    assert.ok(button);
    button.props.onclick({ stopPropagation() {} });
  };
  toggle();
  assert.equal(f.store.get().meMenu, 'status');
  const control = nodes(f.tree()).find(n => n.props.class === 'agent-status-control');
  assert.ok(control);
  const menu = nodes(control).find(n => n.props.id === 'agent-status-menu');
  assert.ok(menu, 'menu is a child of the status button positioning container');
  assert.deepEqual(nodes(menu).filter(n => n.props.dataset?.agentStatus).map(n => n.props.dataset.agentStatus), vm.AGENT_STATUS_ORDER);
  assert.equal(nodes(control).find(n => n.props.dataset?.fid === 'agent-status-toggle')?.props['aria-expanded'], 'true');
  toggle();
  assert.equal(f.store.get().meMenu, false);
  toggle();
  assert.equal(f.store.get().meMenu, 'status');
  const other = { ...account, account_id: 'synthetic-other' };
  f.applyAccount({ active_account_id: other.account_id, max_accounts: 16, accounts: [{ context: other, state: 'online' }] });
  assert.equal(f.store.get().meMenu, false);
});

test('large lists mount only a viewport and scrolling reaches the end', () => {
  const f = fixture(); const rows = Array.from({ length: 10000 }, (_, i) => row(`customer-${i}`, 'B2C'));
  f.store.patch({ conversations: rows });
  assert.ok(visible(f.tree()).length <= 22);
  const scroll = nodes(f.tree()).find(n => n.props.class === 'cscroll'); assert.ok(scroll);
  scroll.props.onscroll({ currentTarget: { scrollTop: 9999 * 96, clientHeight: 900 } });
  assert.ok(visible(f.tree()).includes('customer-9999'));
  assert.ok(visible(f.tree()).length <= 22);
  f.store.patch({ query: 'customer-123' });
  assert.equal(visible(f.tree())[0], 'customer-123');
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
  assert.deepEqual(vm.tabCounts(customer, 'customer'), { doing: 2, done: 2, unknown: 0 });
  assert.deepEqual(vm.filterConversations(customer, 'doing', '', 'customer').map(c => c.gid), ['active', 'unknown']);
  assert.deepEqual(vm.filterConversations(customer, 'unknown', '', 'customer').map(c => c.gid), []);
});

test('real producer status 1/2/4 and raw conversation type flow through guard into scoped UI counts', () => {
  const rows = [1, 2, 4, 99].map((status, i) => {
    const projected = toDisplayConversation(sampleRow(`synthetic-${i}`, { status, conversationType: 'B2C' }), false);
    assert.ok(projected);
    const c = { ...projected, account, draft: '', is_top: false, waiting_since_ms: null, waiting_confirmed: false };
    assert.equal(isUiConversation(c), true); return c;
  });
  assert.deepEqual(vm.tabCounts(rows, 'customer'), { doing: 3, done: 1, unknown: 0 });
  assert.deepEqual(vm.filterConversations(rows, 'doing', '', 'customer').map(c => c.gid), ['synthetic-0', 'synthetic-1', 'synthetic-3']);
});

test('viewport resize expands the mounted window without needing a scroll event', () => {
  const state: any = { listWindow: { scope: 'scope', top: 960, height: 600 } };
  let patches = 0;
  const pane = { dataset: { listScope: 'scope' }, clientHeight: 1800, scrollTop: 960 };
  const env = { root: { querySelector: () => pane }, S: () => state, store: { patch: (value: any) => { Object.assign(state, value); patches++; } } };
  const a = source.indexOf('function syncConversationViewport('), b = source.indexOf('function fillHistoryViewport(', a);
  const sync = new Function(...Object.keys(env), stripTypeScriptTypes(source.slice(a, b)) + '\nreturn syncConversationViewport;')(...Object.values(env));
  const old = vm.virtualConversationRange(10000, 960, 600); sync();
  const next = vm.virtualConversationRange(10000, state.listWindow.top, state.listWindow.height);
  assert.ok(next.end > old.end); assert.equal(state.listWindow.height, 1800);
  sync(); assert.equal(patches, 1, 'unchanged geometry must not cause a render loop');
});

test('scroll/draft rerenders reuse sorting but replaced snapshots and filters invalidate it', () => {
  const rows = [row('a', 'B2C'), row('b', 'B2C', 'finished')];
  const first = vm.filterConversations(rows, 'doing', '');
  assert.equal(vm.filterConversations(rows, 'doing', ''), first);
  assert.deepEqual(vm.filterConversations(rows, 'done', '').map(c => c.gid), ['b']);
  assert.deepEqual(vm.filterConversations(rows, 'doing', 'missing'), []);
  const updated = rows.map(c => ({ ...c, status: 'finished' as const }));
  assert.deepEqual(vm.filterConversations(updated, 'doing', ''), []);
});

test('an unrelated re-render hands back the same row nodes; only rows whose inputs changed are rebuilt', () => {
  const f = fixture();
  const rows = (tree: unknown) => new Map(nodes(tree).filter(n => n.props.dataset?.gid).map(n => [n.props.dataset.gid as string, n]));
  const first = rows(f.tree());
  f.store.patch({ now: 2000, toast: 'synthetic' });
  const second = rows(f.tree());
  assert.ok(first.size > 1);
  for (const [gid, node] of first) assert.equal(second.get(gid), node, `${gid} reused`);
  f.store.patch({ activeGid: 'customer-status-unknown' });
  const third = rows(f.tree());
  assert.notEqual(third.get('customer'), first.get('customer'), 'selection change rebuilds the old selected row');
  const changed = [...third.keys()].find(gid => gid !== 'customer' && gid !== 'customer-status-unknown')!;
  const other = [...third.keys()].find(gid => gid !== 'customer' && gid !== 'customer-status-unknown' && gid !== changed);
  const conversations = f.store.get().conversations.map((c: BusinessRow) => (c.gid === changed ? { ...c, preview: 'changed' } : c));
  f.store.patch({ conversations });
  const fourth = rows(f.tree());
  assert.notEqual(fourth.get(changed), third.get(changed), 'a changed conversation rebuilds its row');
  if (other) assert.equal(fourth.get(other), third.get(other), 'an untouched conversation keeps its row');
});

test('empty server previews fall back to latest visible self or system text and invalidate cached rows', () => {
  const f = fixture();
  f.store.patch({ conversations: [{ ...row('customer', 'B2C'), preview: '' }] });
  const preview = () => nodes(f.tree()).find(n => n.props.class === 'cprev')?.children[0];
  assert.equal(preview(), '');
  const message = { gid: 'customer', kind: 'text', sender_role: 'merchant_self', text: '不客气', create_time_ms: 20 };
  f.store.patch({ messages: { customer: [message, {...message, sender_role: 'customer', text: '谢谢', create_time_ms: 10}] } });
  assert.equal(preview(), '不客气');
  f.store.patch({ messages: { customer: [message, {...message, kind: 'system', text: '会话已结束', create_time_ms: 30}] } });
  assert.equal(preview(), '会话已结束');
});
