import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { httpMessageToUi, sdkMessageToUi } from '../../packages/web-adapter/src/display.ts';
import { RoleBook } from '../../packages/web-adapter/src/stores.ts';
import * as vm from './viewmodel.ts';
import { messageAlignment } from './message-alignment.ts';
import { cx } from '../../packages/ui-kit/src/h.ts';
import type { UiMessage } from '../../packages/ipc/src/client.ts';
const secret = 'SYNTHETIC_PIPELINE_RECALLED_SECRET';
const roles = new RoleBook('synthetic-self');
roles.addCustomer('synthetic-customer');
const raw = { msgId: 'synthetic-original', fromJid: 'synthetic-room@muc.example/synthetic-customer', toJid: 'synthetic-self@im.example', createTime: 1800000000000, msgtype: 0, messageBody: secret };
const original = httpMessageToUi(raw, roles)!;
const reply = { ...original, message_id: 'synthetic-reply', text: 'SYNTHETIC REPLY', quote: original.message_id, quote_target_id: original.message_id };
function renderRows(thread: UiMessage[]): string {
  const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  const a = source.indexOf('function messageRow('); const b = source.indexOf('\nfunction translationBar(', a);
  const env = { ...vm, messageAlignment, cx, h: (tag: string, props: unknown, ...children: unknown[]) => ({ tag, props, children }), t: (key: string) => key, richText: (text: string) => [text], formatDate: () => 'date', formatClock: () => 'time', icon: () => null, IC: {}, document: {}, renderMessageAvatar: () => 'avatar' };
  const row = new Function(...Object.keys(env), stripTypeScriptTypes(source.slice(a, b)) + '\nreturn messageRow;')(...Object.values(env));
  const state = { messages: { [original.gid]: thread }, prefs: { general: { show_msg_time: true } } };
  return JSON.stringify(vm.visibleMessages(thread).map((message) => row(state, message, { gid: original.gid, title: 'Synthetic Customer', color: '#aaa' }, null)));
}
const body = JSON.stringify({ title: '消息已撤回', isPresent: true, code: 2, recallMessageId: raw.msgId });
test('real HTTP recall projection reaches the UI tombstone and removes original and reply preview plaintext', () => {
  const recall = httpMessageToUi({ ...raw, msgId: 'synthetic-recall-http', msgtype: 1009, messageBody: body }, roles)!;
  assert.ok(recall);
  const thread = [original, reply, recall];
  assert.equal(vm.visibleMessages(thread).some((message) => message.message_id === original.message_id), false);
  assert.equal(vm.messageQuotePreview(reply, thread), vm.QUOTE_RECALLED);
  assert.equal(vm.selectedQuoteReference(original, thread, original.gid), null);
  assert.equal(renderRows(thread).includes(secret), false);
});
test('real SDK recall projection reaches the same UI tombstone, including recall-before-original ordering', () => {
  const recall = sdkMessageToUi({ id: 'synthetic-recall-sdk', from: raw.fromJid, to: raw.toJid, type: 'groupchat', msgtype: '1009', create_time: String(raw.createTime + 1), body }, roles)!;
  assert.ok(recall);
  const thread = [recall, reply, original];
  assert.equal(vm.visibleMessages(thread).some((message) => message.message_id === original.message_id), false);
  assert.equal(vm.messageQuotePreview(reply, thread), vm.QUOTE_RECALLED);
  assert.equal(renderRows(thread).includes(secret), false);
});
