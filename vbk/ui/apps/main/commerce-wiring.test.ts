import { t as translateUi } from '../../packages/ui-kit/src/i18n.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { replyDialogOpen } from './quick-replies.ts';

const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
test('actual visible-read wiring blocks commerce dialogs and permits nonmodal reply suggestions', () => {
  const account = { account_id: 'a', environment: 'synthetic', session_generation: 1 }, conversation = { gid: 'chat-a' };
  let state: Record<string, unknown> = { view: 'messages', messages: { 'chat-a': [] }, history: { 'chat-a': { firstPage: 'loaded', readContextRevision: 'visit-1' } } };
  let current!: () => { blocked: boolean; account: unknown; conversation: unknown; readContextRevision: unknown };
  const start = source.indexOf('const visibleReads = createVisibleRead('), end = source.indexOf('\n});', start) + '\n});'.length;
  assert.ok(start >= 0 && end > start);
  const env = { S: () => state, activeConv: () => conversation, activeAccount: () => ({ context: account }), createVisibleRead: (deps: { current: typeof current }) => { current = deps.current; }, root: {}, document: {}, ipc: {}, UiCommands: {}, replyDialogOpen };
  new Function(...Object.keys(env), stripTypeScriptTypes(source.slice(start, end)))(...Object.values(env));
  assert.equal(current().blocked, false); assert.equal(current().account, account); assert.equal(current().conversation, conversation); assert.equal(current().readContextRevision, 'visit-1');
  for (const patch of [{ quickReplies: { mode: 'categories' } }, { quickReplies: { mode: 'manage' } }, { recommendations: {} }, { logoutDialog: {} }, { peripheral: {} }, { runtimeLog: true }]) {
    const base = state; state = { ...base, ...patch }; assert.equal(current().blocked, true, JSON.stringify(patch)); state = base;
  }
  state = { ...state, quickReplies: { mode: 'suggestions' } }; assert.equal(current().blocked, false);
  state = { ...state, recommendations: {} }; assert.equal(current().blocked, true);
});

test('ended conversations block member entry and invite shortcuts before any IPC', () => {
  const start = source.indexOf('function openPeripheral('), end = source.indexOf('\nfunction replyContext(', start);
  for (const status of ['finished', 'transferred_out', 'active']) {
    const opened: string[] = [], notices: string[] = [];
    let closed = 0;
    const env = {
      t: translateUi, activeConv: () => ({ status }), activeAccount: () => ({}),
      isDone: (c: { status: string }) => c.status === 'finished' || c.status === 'transferred_out',
      peripheral: { close: () => { closed++; }, open: (kind: string) => opened.push(kind) },
      toast: (text: string) => notices.push(text), quickReplies: { close() {}, open() {} },
      recommendations: { close() {} }, store: { patch() {} },
    };
    const open = new Function(...Object.keys(env), stripTypeScriptTypes(source.slice(start, end)) + '\nreturn openPeripheral;')(...Object.values(env));
    for (const kind of ['members', 'invite', 'transfer']) open(kind);
    if (status === 'active') {
      assert.deepEqual(opened, ['members', 'invite', 'transfer']);
      assert.deepEqual(notices, []);
    } else {
      assert.deepEqual(opened, []);
      assert.equal(closed, 3);
      assert.deepEqual(notices, Array(3).fill('会话已结束，无法管理成员'));
    }
  }
});
