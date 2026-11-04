import { readHistoryPage } from './history-read.ts';
import { createMessagePane, PIN_THRESHOLD, sameWindow } from './message-pane.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import * as vm from './viewmodel.ts';
import { isUiMessage } from '../_shared/guards.ts';
import { cx } from '../../packages/ui-kit/src/h.ts';

const source = readFileSync(process.env['VBK_HISTORY_MAIN_SOURCE'] ?? new URL('./main.ts', import.meta.url), 'utf8');
function fixture() {
  const account = { account_id: 'synthetic-account', environment: 'test', session_generation: 1 };
  const uiAccount = { context: account };
  const state: any = { activeGid: 'synthetic-room', view: 'messages', messages: { 'synthetic-room': [] }, history: {}, drafts: {}, draft: 'KEEP DRAFT', draftVersion: 1, banners: [], conversations: [{ gid: 'synthetic-room', account, unread_count: 3, waiting_since_ms: null, status: 'active', lang: 'en' }] };
  let response: unknown = null, active = true;
  const requests: string[] = [];
  const invoke = async (cmd: string) => { requests.push(cmd); return await (typeof response === 'function' ? response() : response); };
  const visibility = { visibilityState: 'visible' };
  const env = { closeCommerce() {}, visibleReads: { retry() {}, afterRender() {} }, ...vm, readHistoryPage, document: visibility, S: () => state, store: { patch: (patch: object) => Object.assign(state, patch) }, activeAccount: () => uiAccount, stillActive: () => active, peripheral: { close() {} }, isUiMessage, TRANSLATION_IDLE: vm.TRANSLATION_IDLE, PKG_IDLE: {}, releaseAttachment: async () => {}, autoQueryPackage() {}, UiCommands: { IM_MESSAGE_PAGE: 'page', IM_MESSAGES: 'messages', IM_MARK_READ: 'read' }, invokeQuiet: invoke, invokeSafe: invoke };
  const a = source.indexOf('async function openConversation('), b = source.indexOf('\nasync function loadEarlier(', a);
  const open = new Function(...Object.keys(env), stripTypeScriptTypes(source.slice(a, b)) + '\nreturn openConversation;')(...Object.values(env));
  const loadEnd = source.indexOf('\n/** `im://locate-conversation`', b);
  const load = new Function(...Object.keys(env), stripTypeScriptTypes(source.slice(b, loadEnd)) + '\nreturn loadEarlier;')(...Object.values(env));
  const renderEnv = { ...env, HISTORY_RUNWAY: 16000, messagePaneModel: createMessagePane(), liveAnchor: null, PIN_THRESHOLD, sameWindow, cx, part: (_name: string, build: () => unknown) => build(), featureRuntime: { renderSlot: () => [] }, activeConv: () => state.conversations[0], document: { querySelector: () => null }, h: (tag: string, props: any, ...children: any[]) => ({ tag, props: props ?? {}, dataset: props?.dataset ?? {}, children }), icon: () => null, IC: {}, t: (key: string) => key, renderMessageAvatar: () => null, netEverConnected: true, netView: () => ({ offline: false }), composer: () => null, emojiPicker: () => null, messageRow: () => null, openConversation: open, loadEarlier: load };
  const ca = source.indexOf('let messagePaneCache:'), cb = source.indexOf('\nfunction messagesView(', ca);
  const render = new Function(...Object.keys(renderEnv), stripTypeScriptTypes(source.slice(ca, cb)) + '\nreturn chatPane;')(...Object.values(renderEnv));
  return { state, requests, visibility, render: () => render(state), open: () => open('synthetic-room'), earlier: () => load(state.conversations[0]), respond: (value: unknown) => { response = value; }, invalidate: () => { active = false; }, page: { items: [], has_more: false, before_ms: null } };
}

test('empty or realtime-only cache cannot suppress the first historical read', async () => {
  const f = fixture(); f.respond(f.page); await f.open();
  assert.equal(f.requests.filter(x => x === 'page').length, 1);
  assert.equal(f.state.history['synthetic-room'].firstPage, 'loaded');
  assert.equal(f.state.draft, 'KEEP DRAFT');
  await f.open(); assert.equal(f.requests.filter(x => x === 'page').length, 1, 'a verified first page is reusable');
});
test('persistent failure is visible after one automatic retry without clearing the draft', async () => {
  const f = fixture(); await f.open();
  assert.equal(f.state.history['synthetic-room']?.firstPage, 'error');
  assert.deepEqual(f.requests, ['page', 'page']); assert.equal(f.state.draft, 'KEEP DRAFT');
  f.respond(f.page); await f.open(); assert.equal(f.state.history['synthetic-room'].firstPage, 'loaded');
});
test('opening a conversation automatically recovers a transient first-page failure', async () => {
  const f = fixture(); let attempts = 0;
  let finish!: (value: unknown) => void;
  f.respond(() => ++attempts === 1 ? null : new Promise(resolve => { finish = resolve; }));
  const pending = f.open();
  for (let i = 0; i < 12; i++) await Promise.resolve();
  assert.deepEqual(f.requests, ['page', 'page']);
  assert.equal(f.state.history['synthetic-room'].firstPage, 'loading');
  assert.doesNotMatch(JSON.stringify(f.render()), /聊天记录读取失败或超时/);
  await f.open(); assert.equal(attempts, 2, 'clicks cannot duplicate the automatic retry');
  finish(f.page); await pending;
  assert.equal(f.state.history['synthetic-room'].firstPage, 'loaded');
  assert.equal(f.state.draft, 'KEEP DRAFT');
});
test('a timed out initial read automatically fetches a fresh page', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); let attempts = 0;
  f.respond(() => ++attempts === 1 ? new Promise(() => {}) : f.page);
  const pending = f.open(); t.mock.timers.tick(20_000); await pending;
  assert.deepEqual(f.requests, ['page', 'page']);
  assert.equal(f.state.history['synthetic-room'].firstPage, 'loaded');
});
test('leaving a room before a failed initial read prevents an automatic background retry', async () => {
  const f = fixture(); let finish!: (value: unknown) => void;
  f.respond(new Promise(resolve => { finish = resolve; }));
  const pending = f.open(); f.state.activeGid = 'other'; finish(null); await pending;
  assert.deepEqual(f.requests, ['page']);
});
test('concurrent clicks share initial read and completion while another room is visible does not mark read', async () => {
  const f = fixture(); let complete!: (value: unknown) => void;
  f.respond(new Promise(resolve => { complete = resolve; }));
  const first = f.open(); await f.open(); assert.equal(f.requests.length, 1);
  assert.equal(f.state.history['synthetic-room'].firstPage, 'loading');
  f.state.activeGid = 'other'; complete(f.page); await first;
  assert.equal(f.state.history['synthetic-room'].firstPage, 'loaded'); assert.deepEqual(f.requests, ['page']);
  f.state.activeGid = 'synthetic-room'; await f.open(); assert.deepEqual(f.requests, ['page'], 'explicit return waits for a visible rendered server row before acknowledging');
});
test('late account result and malformed first pages cannot become a loaded empty history', async () => {
  const f = fixture(); let complete!: (value: unknown) => void;
  f.respond(new Promise(resolve => { complete = resolve; })); const first = f.open();
  f.invalidate(); f.state.history = {}; complete(f.page); await first; assert.deepEqual(f.state.history, {});
  for (const invalid of [{}, { items: null }, { items: [], has_more: true, before_ms: null }]) {
    const g = fixture(); g.respond(invalid); await g.open(); assert.equal(g.state.history['synthetic-room']?.firstPage, 'error'); assert.ok(!g.requests.includes('read'));
  }
});
test('actual chat pane exposes pending status and an actionable failed-read retry', async () => {
  const f = fixture(); let complete!: (value: unknown) => void;
  f.respond(new Promise(resolve => { complete = resolve; })); const first = f.open();
  const nodes = (tree: any): any[] => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' ? [tree, ...nodes(tree.children ?? [])] : [];
  assert.ok(nodes(f.render()).some(n => n.props?.role === 'status' && n.children.includes('正在读取聊天记录…')));
  complete(null); await first;
  const retry = nodes(f.render()).find(n => n.tag === 'button' && n.children.includes('聊天记录读取失败或超时，点击重试'));
  assert.ok(retry); f.respond(f.page); retry.props.onclick();
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(f.state.history['synthetic-room'].firstPage, 'loaded'); assert.equal(f.requests.filter(x => x === 'page').length, 3);
});
test('renderer deadline releases a stuck host invocation and a later result cannot change it', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let complete!: (value: unknown) => void;
  const pending = readHistoryPage(new Promise(resolve => { complete = resolve; }));
  t.mock.timers.tick(20_000); assert.equal(await pending, null);
  complete({ items: [], has_more: false, before_ms: null }); await Promise.resolve(); assert.equal(await pending, null);
  assert.deepEqual(await readHistoryPage(Promise.resolve({ items: [], has_more: false, before_ms: null })), { items: [], has_more: false, before_ms: null });
});
test('an older pagination completion cannot overwrite a newer first-page request', async () => {
  const f = fixture(); f.state.history['synthetic-room'] = { firstPage: 'loaded', hasMore: true, beforeMs: 100, busy: false };
  let complete!: (value: unknown) => void;
  f.respond(new Promise(resolve => { complete = resolve; })); const earlier = f.earlier();
  const newer = { firstPage: 'loading', hasMore: false, beforeMs: null, busy: true };
  f.state.history['synthetic-room'] = newer; complete(f.page); await earlier;
  assert.equal(f.state.history['synthetic-room'], newer);
});
test('late first page on another view or hidden window does not mark the conversation read', async () => {
  for (const hidden of [false, true]) {
    const f = fixture(); let complete!: (value: unknown) => void;
    f.respond(new Promise(resolve => { complete = resolve; })); const pending = f.open();
    if (hidden) f.visibility.visibilityState = 'hidden'; else f.state.view = 'notifications';
    complete(f.page); await pending; assert.deepEqual(f.requests, ['page']);
    f.visibility.visibilityState = 'visible'; await f.open(); assert.deepEqual(f.requests, ['page']);
  }
});
test('earlier-page renderer timeout remains visibly retryable with its old cursor', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(); f.state.history['synthetic-room'] = { firstPage: 'loaded', hasMore: true, beforeMs: 100, busy: false };
  f.respond(new Promise(() => {})); const pending = f.earlier(); t.mock.timers.tick(20_000); await pending;
  assert.equal(f.state.history['synthetic-room'].pageError, true); assert.equal(f.state.history['synthetic-room'].beforeMs, 100);
  assert.match(JSON.stringify(f.render()), /历史记录读取失败或超时，点击重试/);
});

test('first-open context enrichment discards the old page and automatically reads the new scope', async () => {
  const f = fixture(); f.state.conversations[0].assistant_context_revision = 'service-A';
  let done!: (value: unknown) => void; f.respond(new Promise(resolve => { done = resolve; }));
  const loading = f.open();
  f.state.conversations[0] = { ...f.state.conversations[0], assistant_context_revision: 'service-B' };
  f.state.messages['synthetic-room'] = [{ message_id: 'old-customer' }];
  f.respond(f.page); done(f.page); await loading;
  assert.equal(f.state.history['synthetic-room'].firstPage, 'loaded');
  assert.equal(f.state.history['synthetic-room'].readContextRevision, 'service-B');
  assert.deepEqual(f.state.messages['synthetic-room'], []);
  assert.equal(f.requests.filter(cmd => cmd === 'page').length, 2);
  assert.equal(f.requests.includes('read'), false);
});
test('continuous context changes stop automatic recovery after one fresh scope', async () => {
  const f = fixture(); let attempts = 0;
  f.respond(() => {
    f.state.conversations[0].assistant_context_revision = String(++attempts);
    return f.page;
  });
  await f.open();
  assert.equal(attempts, 2);
  assert.equal(f.state.history['synthetic-room'].firstPage, 'error');
});
test('actual earlier-page reply cannot cross a service revision or stamp old rows with the new revision', async () => {
  const f = fixture(); f.state.conversations[0].assistant_context_revision = 'A';
  f.state.history['synthetic-room'] = { firstPage: 'loaded', hasMore: true, beforeMs: 100, busy: false, readContextRevision: 'A' };
  let done!: (value: unknown) => void; f.respond(new Promise(resolve => { done = resolve; }));
  const loading = f.earlier(); f.state.conversations[0] = { ...f.state.conversations[0], assistant_context_revision: 'B' };
  done(f.page); await loading;
  assert.equal(f.state.history['synthetic-room'].readContextRevision, 'A');
  assert.deepEqual(f.state.messages['synthetic-room'], []);
  await f.earlier(); assert.equal(f.requests.length, 1, 'old-service pagination is refused before another request');
});

test('returning from another room reuses a loaded first page without another request', async () => {
  const f = fixture(); f.respond(f.page); await f.open();
  f.state.activeGid = 'other'; await f.open();
  assert.equal(f.state.activeGid, 'synthetic-room'); assert.deepEqual(f.requests, ['page']);
});

test('nonadvancing cursor is retryable and cannot loop automatic history loading', async () => {
  const f = fixture();
  f.state.history['synthetic-room'] = { firstPage: 'loaded', hasMore: true, beforeMs: 100, busy: false };
  f.respond({ items: [], has_more: true, before_ms: 100 }); await f.earlier();
  assert.equal(f.state.history['synthetic-room'].pageError, true);
  assert.equal(f.state.history['synthetic-room'].busy, false);
  assert.equal(f.state.history['synthetic-room'].beforeMs, 100);
  f.respond({ items: [], has_more: true, before_ms: 50 }); await f.earlier();
  assert.equal(f.state.history['synthetic-room'].pageError, false);
  assert.equal(f.state.history['synthetic-room'].beforeMs, 50);
});


test('draft changes reuse the message pane; history and profile updates invalidate it', async () => {
  const f = fixture(); f.respond(f.page); await f.open();
  const find = (tree: any): any => Array.isArray(tree) ? tree.map(find).find(Boolean) : tree && typeof tree === 'object' ? tree.props?.class === 'msgs' ? tree : find(tree.children) : undefined;
  const first = find(f.render()); assert.ok(first);
  f.state.draft = 'typing'; assert.equal(find(f.render()), first);
  f.state.history['synthetic-room'] = { ...f.state.history['synthetic-room'], busy: true };
  const loading = find(f.render()); assert.notEqual(loading, first);
  f.state.conversations[0] = { ...f.state.conversations[0], title: 'updated' };
  assert.notEqual(find(f.render()), loading);
});

test('scrolling near the top loads history only for the current mounted scope and stops on errors', () => {
  const account = { account_id: 'a', environment: 'test', session_generation: 1 }, conv = { gid: 'g', account };
  const state: any = { history: { g: {} } }; let calls = 0;
  let onScroll!: (event: any) => void;
  const env = { messagePaneModel: { distanceToHead: (scrollTop: number) => scrollTop }, historyPrefetchDistance: (viewport: number) => viewport * 2, root: { addEventListener: (_: string, fn: typeof onScroll) => { onScroll = fn; } }, visibleReads: { afterRender() {} }, onMessageScroll() {}, S: () => state, activeConv: () => conv, activeAccount: () => ({ context: account }), historyScopeKey: vm.historyScopeKey, loadEarlier: () => { calls++; } };
  const a = source.indexOf("root.addEventListener('scroll',"), b = source.indexOf("window.addEventListener('resize',", a);
  new Function(...Object.keys(env), stripTypeScriptTypes(source.slice(a, b)))(...Object.values(env));
  const pane = { isConnected: true, scrollTop: 100, clientHeight: 200, dataset: { keepScroll: 'msgs', historyScope: vm.historyScopeKey(account, 'g') } };
  onScroll({ target: pane }); assert.equal(calls, 1);
  pane.scrollTop = 500; onScroll({ target: pane }); assert.equal(calls, 1);
  pane.scrollTop = 0; state.history.g.pageError = true; onScroll({ target: pane }); assert.equal(calls, 1);
  state.history.g.pageError = false; pane.dataset.historyScope = 'old'; onScroll({ target: pane }); assert.equal(calls, 1);
  pane.dataset.historyScope = vm.historyScopeKey(account, 'g'); pane.isConnected = false; onScroll({ target: pane }); assert.equal(calls, 1);
});
