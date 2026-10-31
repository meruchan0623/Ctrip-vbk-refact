import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
test('actual conversation upsert never reads before message rendering, including loading/error/loaded caches', () => {
  for (const firstPage of ['loading', 'error', 'loaded']) {
    let reads = 0;
    const account = { account_id: 'synthetic', environment: 'test', session_generation: 1 };
    const c = { account, gid: 'room', unread_count: 2 };
    const state = { activeGid: 'room', view: 'messages', conversations: [], messages: {}, history: { room: { firstPage } } };
    const env = { S: () => state, store: { patch: (p: object) => Object.assign(state, p) }, document: { visibilityState: 'visible' }, UiCommands: { IM_MARK_READ: 'read' }, invokeQuiet: () => { reads++; } };
    const a = source.indexOf('function upsertConversation('), b = source.indexOf('\nasync function sendText(', a);
    new Function(...Object.keys(env), stripTypeScriptTypes(source.slice(a, b)) + ';return upsertConversation;')(...Object.values(env))(c);
    assert.equal(reads, 0, firstPage);
  }
});

import { createVisibleRead, type VisibleReadState } from './visible-read.ts';
import { historyScopeKey, messageHistoryKey } from './viewmodel.ts';
function fixture() {
  const account = { account_id: 'synthetic', environment: 'test', session_generation: 1 };
  const message: any = { gid: 'room', message_id: 'server-1', local_id: null, create_time_ms: 100, sender_role: 'customer' };
  const conversation: any = { account, gid: 'room', unread_count: 2, last_message_time_ms: 100, assistant_context_revision: 'revision-A', read_target_message_id: 'server-1' };
  const state: VisibleReadState = { account, conversation, messages: [message], firstPage: 'loaded', readContextRevision: 'revision-A', view: 'messages', blocked: false };
  let visible = true, fail = false;
  const calls: any[] = [];
  const row = { isConnected: true, dataset: { historyKey: messageHistoryKey(account, conversation, message) }, rect: { top: 40, bottom: 80, left: 0, right: 200, width: 200, height: 40 }, getBoundingClientRect() { return this.rect; } };
  const pane = { isConnected: true, dataset: { historyScope: historyScopeKey(account, 'room'), readContextRevision: 'revision-A' }, rows: [row], querySelectorAll() { return this.rows; }, getBoundingClientRect() { return { top: 0, bottom: 200, left: 0, right: 200, width: 200, height: 200 }; } };
  const controller = createVisibleRead({ current: () => state, pane: () => pane as any, visible: () => visible, invoke: async args => { calls.push(args); if (fail) throw new Error('synthetic unknown'); } });
  return { controller, state, row, pane, calls, message, account, visible: (v: boolean) => { visible = v; }, fail: () => { fail = true; } };
}
test('only a visible rendered server row in its full account generation scope may be acknowledged', () => {
  const f = fixture(); f.controller.afterRender();
  assert.deepEqual(f.calls, [{ account: f.account, gid: 'room', expected_message_id: 'server-1', expected_context_revision: 'revision-A' }]);
  f.controller.afterRender(); assert.equal(f.calls.length, 1);
});
test('all first-page, visibility, DOM, context and preview gates fail closed', () => {
  const cases: ((f: ReturnType<typeof fixture>) => void)[] = [
    f => { f.state.readContextRevision = undefined; }, f => { f.state.conversation = { ...f.state.conversation!, assistant_context_revision: 'revision-B' }; }, f => { f.pane.dataset.readContextRevision = 'revision-B'; },
    f => { f.state.firstPage = 'loading'; }, f => { f.state.firstPage = 'error'; }, f => { f.state.firstPage = undefined; },
    f => f.visible(false), f => { f.state.view = 'notices'; }, f => { f.state.blocked = true; },
    f => { f.state.messages = []; }, f => { f.pane.rows = []; }, f => { f.pane.isConnected = false; }, f => { f.row.isConnected = false; },
    f => { f.state.account = { ...f.account, account_id: 'other' }; }, f => { f.state.account = { ...f.account, environment: 'other' }; },
    f => { f.state.account = { ...f.account, session_generation: 2 }; }, f => { f.state.conversation = { ...f.state.conversation!, gid: 'other' }; },
    f => { f.pane.dataset.historyScope = 'old-generation'; }, f => { f.row.dataset.historyKey = 'old-row'; },
    f => { f.row.rect.top = 210; f.row.rect.bottom = 250; }, f => { f.row.rect.top = -50; f.row.rect.bottom = -10; },
    f => { f.row.rect.width = 0; }, f => { f.pane.rows = [f.row, f.row]; },
    f => { f.state.messages = [{ ...f.message, message_id: null, local_id: 'pending' }]; },
  ];
  cases.forEach((change, i) => { const f = fixture(); change(f); f.controller.afterRender(); assert.equal(f.calls.length, 0, 'gate ' + i); });
});
test('preview then message then render ordering never acknowledges unseen new content', () => {
  const f = fixture(); f.state.conversation = { ...f.state.conversation!, last_message_time_ms: 200, read_target_message_id: 'server-2' };
  f.controller.afterRender(); assert.equal(f.calls.length, 0);
  const newest = { ...f.message, message_id: 'server-2', create_time_ms: 200 };
  f.state.messages = [f.message, newest]; f.state.conversation = { ...f.state.conversation!, read_target_message_id: 'server-2' }; f.controller.afterRender(); assert.equal(f.calls.length, 0);
  f.row.dataset.historyKey = messageHistoryKey(f.account, f.state.conversation, newest);
  f.controller.afterRender(); assert.equal(f.calls[0].expected_message_id, 'server-2');
});
test('unknown receipt is not retried by automatic render, scroll or focus; explicit reopen can retry', async () => {
  const f = fixture(); f.fail(); f.controller.afterRender();
  for (let i = 0; i < 5; i++) await Promise.resolve();
  f.controller.afterRender(); f.controller.afterRender(); assert.equal(f.calls.length, 1);
  f.controller.retry(f.account, 'room'); f.controller.afterRender(); assert.equal(f.calls.length, 2);
});
test('explicit reopen during an in-flight receipt cannot schedule an automatic later retry', async () => {
  const f = fixture(); f.fail(); f.controller.afterRender(); f.controller.retry(f.account, 'room'); f.controller.afterRender(); assert.equal(f.calls.length, 1);
  for (let i = 0; i < 5; i++) await Promise.resolve();
  f.controller.afterRender(); assert.equal(f.calls.length, 1);
});
test('actual render wiring acknowledges only after DOM replacement and anchor restoration, never during IME deferral', () => {
  const a = source.indexOf('subscribeBatched(store,'), b = source.indexOf('\nrerender(root, () => render(S()));', a);
  const order: string[] = []; let callback!: (s: unknown) => void; let deferred = false;
  const env = { store: {}, subscribeBatched: (_: unknown, fn: typeof callback) => { callback = fn; }, composerInput: { deferRender: () => deferred },
    withMessageAnchor: (_: unknown, draw: () => void) => { draw(); order.push('anchor'); }, root: {}, rerender: (_: unknown, draw: () => unknown) => { draw(); order.push('mounted'); },
    render: () => null, Element: class {}, visibleReads: { afterRender: () => order.push('receipt') } };
  new Function(...Object.keys(env), stripTypeScriptTypes(source.slice(a, b)))(...Object.values(env));
  callback({}); assert.deepEqual(order, ['mounted', 'anchor', 'receipt']);
  deferred = true; order.length = 0; callback({}); assert.deepEqual(order, []);
});

test('visiting more than 256 scopes never forgets an uncertain receipt on automatic return', async () => {
  const f = fixture(); f.fail();
  const visit = async (gid: string) => {
    const c = { ...f.state.conversation!, gid };
    const m = { ...f.message, gid };
    f.state.conversation = c; f.state.messages = [m];
    f.pane.dataset.historyScope = historyScopeKey(f.account, gid);
    f.row.dataset.historyKey = messageHistoryKey(f.account, c, m);
    f.controller.afterRender();
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  await visit('room');
  for (let i = 0; i < 257; i++) await visit('other-' + i);
  assert.equal(f.calls.length, 258);
  await visit('room'); assert.equal(f.calls.length, 258);
  f.controller.retry(f.account, 'room'); f.controller.afterRender(); assert.equal(f.calls.length, 259);
});

test('authoritative current read target remains eligible with higher-time former-service history', () => {
  const f = fixture();
  f.state.messages = [f.message, { ...f.message, message_id: 'former-customer-high-time', create_time_ms: 100000 }];
  f.state.conversation = { ...f.state.conversation!, last_message_time_ms: 100000 };
  f.controller.afterRender(); assert.equal(f.calls[0]?.expected_message_id, 'server-1');
  const g = fixture(); g.state.conversation = { ...g.state.conversation!, read_target_message_id: null };
  g.controller.afterRender(); assert.equal(g.calls.length, 0, 'without a verified frontier the highest-time visible row is not evidence');
});

test('read frontier shape and string bounds fail closed', () => {
  for (const id of [undefined, null, '', ' ', 123, {}, 'x'.repeat(513)]) {
    const f = fixture(); f.state.conversation = { ...f.state.conversation!, read_target_message_id: id } as any;
    f.controller.afterRender(); assert.equal(f.calls.length, 0);
  }
  const f = fixture(), id = 'x'.repeat(512);
  f.state.conversation = { ...f.state.conversation!, read_target_message_id: id };
  f.state.messages = [{ ...f.message, message_id: id }];
  f.row.dataset.historyKey = messageHistoryKey(f.account, f.state.conversation, f.state.messages[0]!);
  f.controller.afterRender(); assert.equal(f.calls.length, 1);
});

import { isUiConversation } from '../_shared/guards.ts';
import { toDisplayConversation } from '../../packages/web-adapter/src/display.ts';
import { sampleRow } from '../../packages/web-adapter/src/testing.ts';
test('actual UI conversation guard preserves legacy rows and rejects malformed read frontier metadata', () => {
  const account = { account_id: 'synthetic', environment: 'test', session_generation: 1 };
  const c = { ...toDisplayConversation(sampleRow('123456'), false), account, draft: '', is_top: false, waiting_since_ms: null, waiting_confirmed: false };
  assert.equal(isUiConversation(c), true);
  for (const value of [null, 'server-id', 'x'.repeat(512)]) assert.equal(isUiConversation({ ...c, read_target_message_id: value }), true);
  for (const value of ['', ' ', 123, {}, 'x'.repeat(513)]) assert.equal(isUiConversation({ ...c, read_target_message_id: value }), false);
});

test('same service frontier A -> B -> A never automatically retries an uncertain A target', async () => {
  const f = fixture(); f.fail();
  const visit = async (id: string) => {
    f.state.conversation = { ...f.state.conversation!, read_target_message_id: id };
    f.state.messages = [{ ...f.message, message_id: id }];
    f.row.dataset.historyKey = messageHistoryKey(f.account, f.state.conversation, f.state.messages[0]!);
    f.controller.afterRender();
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  await visit('A'); await visit('B'); await visit('A');
  assert.deepEqual(f.calls.map(c => c.expected_message_id), ['A', 'B']);
  f.controller.retry(f.account, 'room'); await visit('A');
  assert.deepEqual(f.calls.map(c => c.expected_message_id), ['A', 'B', 'A']);
});
