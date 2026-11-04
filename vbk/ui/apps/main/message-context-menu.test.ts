import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { selectedQuoteReference } from './viewmodel.ts';
import type { UiMessage } from '../../packages/ipc/src/client.ts';

const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
const account = { account_id: 'account', environment: 'test', session_generation: 1 };
const conv = { gid: 'room', assistant_context_revision: 'revision' };
const message = { gid: 'room', message_id: 'server-id', kind: 'text', sender_role: 'merchant_self', text: 'Hello', translation: null } as UiMessage;
function setup(selected = message) {
  let current = true;
  const state = { view: 'messages', activeGid: 'room', conversations: [conv], messages: { room: [selected] } };
  let opened: any[] = [];
  const patches: any[] = [], copied: string[] = [], recalls: UiMessage[] = [], translations: UiMessage[] = [], forwards: UiMessage[] = [];
  const env = {
    forwardDialog: {open:(m:UiMessage)=>forwards.push(m)}, safeMediaUrl:()=>null,
    S: () => state, stillActive: () => current, selectedQuoteReference,
    featureRuntime: { messageActions: () => [{ id: 'recall', label: () => '撤回', run: (m: UiMessage) => { recalls.push(m); } }] },
    store: { patch: (p: any) => patches.push(p) }, copyText: (text: string) => { copied.push(text); }, toast() {},
    refreshMessageTranslation: async (m: UiMessage) => { translations.push(m); },
    messageContextMenu: { open: (...args: any[]) => { opened = args; } },
  };
  const a = source.indexOf('function openMessageMenu('), b = source.indexOf('\nfunction messageRow(', a);
  const open = new Function(...Object.keys(env), stripTypeScriptTypes(source.slice(a, b)) + '\nreturn openMessageMenu;')(...Object.values(env));
  const event = { clientX: 20, clientY: 30, preventDefault() {}, stopPropagation() {} };
  return { state, patches, copied, recalls, translations, stale: () => { current = false; }, open: () => open(event, selected, conv, { context: account }), menu: () => opened };
}

test('message menu uses official action order and invokes the selected message', async () => {
  const f = setup(); f.open();
  const [x, y, actions, valid] = f.menu();
  assert.deepEqual([x, y], [20, 30]);
  assert.deepEqual(actions.map((a: any) => a.label), ['复制', '引用', '转发', '撤回', '翻译']);
  assert.equal(valid(), true);
  for (const action of actions) await action.run();
  assert.deepEqual(f.copied, ['Hello']);
  assert.ok(f.patches.some(p => p.quote === message));
  assert.deepEqual(f.recalls, [message]); assert.deepEqual(f.translations, [message]);
});

test('stale account, conversation, revision and removed message invalidate the open menu', () => {
  for (const change of ['account', 'conversation', 'revision', 'message']) {
    const f = setup(); f.open(); const valid = f.menu()[3];
    if (change === 'account') f.stale();
    if (change === 'conversation') f.state.activeGid = 'other';
    if (change === 'revision') f.state.conversations = [{ ...conv, assistant_context_revision: 'new' }];
    if (change === 'message') f.state.messages.room = [];
    assert.equal(valid(), false, change);
  }
  const f = setup(); f.stale(); f.open(); assert.equal(f.menu().length, 0);
});

test('official raw custom messages do not expose forward while supported cards do', () => {
  const custom = setup({ ...message, platform_type: 7 }); custom.open();
  assert.ok(!custom.menu()[2].some((action: {id:string}) => action.id === 'forward'));
  for (const platform_type of [0,1,2,3,5,8,9]) {
    const supported = setup({ ...message, platform_type }); supported.open();
    assert.ok(supported.menu()[2].some((action: {id:string}) => action.id === 'forward'));
  }
});
