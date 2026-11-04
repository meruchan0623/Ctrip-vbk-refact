// I-29 B1: focus restoration across the full re-render reaches every control that carries data-fid
// (conversation rows, tabs, chat actions, composer tools), and announcements go through a persistent live region.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import * as vm from './viewmodel.ts';
import { cx } from '../../packages/ui-kit/src/h.ts';
import { createStore } from '../../packages/ui-kit/src/store.ts';
import type { UiConversation } from '../../packages/ipc/src/client.ts';

const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
const hSource = readFileSync(new URL('../../packages/ui-kit/src/h.ts', import.meta.url), 'utf8');
const account = { account_id: 'synthetic-account', environment: 'prod', session_generation: 1 };
interface Node { tag: string; props: Record<string, any>; children: unknown[] }
const nodes = (tree: unknown): Node[] => (Array.isArray(tree) ? tree.flatMap(nodes) : !tree || typeof tree !== 'object' ? [] : [tree as Node, ...nodes((tree as Node).children ?? [])]);
const fidsOf = (tree: unknown): string[] => nodes(tree).flatMap(n => (n.props?.dataset?.fid ? [n.props.dataset.fid as string] : []));
const row = (gid: string): UiConversation => ({ account, gid, status: 'active', agent_in_group: true, is_owner: true, service_type: '1513', conversation_type: 'B2C', last_message_time_ms: 1000, last_update_time_ms: 1000, unread_count: 0, is_full_snapshot: true, title: gid, color: '#000', lang: 'zh', biz: 'synthetic', preview: 'p', draft: '', is_top: false, mark: 0, waiting_since_ms: null, waiting_confirmed: false, customer_tags: [], order: null } as unknown as UiConversation);

function conversationTree() {
  const conversations = ['room-1', 'room-2', 'room-3'].map(row);
  const store = createStore<Record<string, any>>({ accounts: { active_account_id: account.account_id, accounts: [{ context: account, state: 'online' }], max_accounts: 16 }, conversations, business: 'customer', tab: 'doing', query: '', activeGid: 'room-1', drafts: {}, messages: {}, now: 1000, agent: { status: 'online', confirmed: true }, net: null, ctxMenu: null, meMenu: false });
  const env: Record<string, unknown> = { ...vm, netEverConnected: true, document: {}, store, part: (_name: string, build: () => unknown) => build(), S: () => store.get(), cx, activeAccount: () => ({ context: account, state: 'online' }), h: (tag: string, props: object | null, ...children: unknown[]) => ({ tag, props: props ?? {}, children }), t: (k: string) => k, icon: () => null, IC: {}, accBadge: () => null, formatRelativeTime: () => '', formatDuration: () => '', RED_AFTER_SECONDS: 90, waitedSeconds: () => 0, openConversation() {}, renderMessageAvatar: () => null, loadForActiveAccount: async () => undefined, startLogin() {}, toggleTop() {}, ipc: { invoke() {} }, langName: (c: string) => c, MARK_COLORS: vm.MARK_COLORS };
  const a = source.indexOf('function conversationList('), b = source.indexOf('\nfunction contextMenu(', a);
  const render = new Function(...Object.keys(env), stripTypeScriptTypes(source.slice(a, b)) + '\nreturn conversationList;')(...Object.values(env));
  return render(store.get());
}

test('conversation rows and list tabs carry unique fids so focus survives the full rebuild', () => {
  const fids = fidsOf(conversationTree());
  for (const gid of ['room-1', 'room-2', 'room-3']) assert.ok(fids.includes(`conv:${gid}`), gid);
  assert.ok(fids.includes('list-tab:doing') && fids.includes('list-tab:done'));
  assert.equal(new Set(fids).size, fids.length, 'fids are unique');
});

test('every interactive control that has a stable identity in the main window source declares a fid', () => {
  for (const needle of ["fid: `conv:${c.gid}`", "fid: 'chat-act:members'", "fid: 'chat-act:end'", "fid: `tool:${id}`", "fid: 'tool:more'", "fid: 'tr:send'", "fid: `nav:${view}`", "fid: 'nav:settings'", "fid: `acct-tab:${a.context.account_id}`"]) assert.ok(source.includes(needle), needle);
});

/** The real ui-kit rerender against a tiny fake DOM: focus returns to a fid'd button, not just inputs. */
function realRerender() {
  const start = hSource.indexOf('export function rerender('), end = hSource.indexOf('\nexport', start + 10);
  const body = stripTypeScriptTypes(hSource.slice(start, end < 0 ? undefined : end).replace('export function', 'function'));
  const focused: string[] = [];
  const makeEl = (fid: string, kind: 'button' | 'input') => ({ kind, dataset: { fid }, focus: () => focused.push(fid), setSelectionRange: (a: number, b: number) => focused.push(`sel:${a}-${b}`), selectionStart: 2, selectionEnd: 4 });
  return { focused, makeEl, run(active: ReturnType<typeof makeEl> | null, next: ReturnType<typeof makeEl>[]) {
    const doc = { activeElement: active };
    const root = { querySelectorAll: () => [], querySelector: (sel: string) => next.find(n => sel.includes(`"${n.dataset.fid}"`)) ?? null };
    const fn = new Function('document', 'mount', 'CSS', 'HTMLInputElement', 'HTMLTextAreaElement', body + '\nreturn rerender;')(doc, () => {}, { escape: (s: string) => s }, class {}, class {});
    fn(root, () => ({}));
  } };
}
test('ui-kit rerender returns focus to any element with a fid (button, not only text inputs)', () => {
  const r = realRerender();
  r.run(r.makeEl('conv:room-2', 'button'), [r.makeEl('conv:room-1', 'button'), r.makeEl('conv:room-2', 'button')]);
  assert.deepEqual(r.focused, ['conv:room-2']);
  const none = realRerender();
  none.run(none.makeEl('conv:gone', 'button'), [none.makeEl('conv:room-1', 'button')]);
  assert.deepEqual(none.focused, [], 'a row that no longer exists is not replaced by another');
});

test('announcements use one persistent polite status region outside the re-rendered tree', () => {
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  assert.match(html, /<div id="app" aria-live="off"><\/div>/, 'the rebuilt root never announces itself');
  assert.match(html, /<div id="live"[^>]*role="status"[^>]*aria-live="polite"[^>]*>/);
  const a = source.indexOf('function announce('), b = source.indexOf('\nlet toastTimer', a);
  assert.ok(a >= 0 && b > a);
  const region = { textContent: 'old' };
  const calls: string[] = [];
  const announce = new Function('document', stripTypeScriptTypes(source.slice(a, b)) + '\nreturn announce;')({ getElementById: (id: string) => (id === 'live' ? region : null) });
  announce('已复制');
  assert.equal(region.textContent, '已复制');
  announce('');
  assert.equal(region.textContent, '');
  void calls;
  assert.ok(/function toast\([^)]*\): void \{[^}]*announce\(text\)/.test(source), 'toast() announces through the live region');
  assert.match(source, /s\.toast \? h\('div', \{ class: 'toast', role: 'status' \}/);
});
