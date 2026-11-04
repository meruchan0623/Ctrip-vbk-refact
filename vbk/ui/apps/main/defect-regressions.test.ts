import { t as translateUi } from '../../packages/ui-kit/src/i18n.ts';
// Regression cases for the open defects D4 and D5 (docs/reverse/2026-11-01-rea/04-target-vs-vbk-gap.md).
// Each case drives the real main.ts message row / merge code with synthetic data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import * as vm from './viewmodel.ts';
import { messageAlignment } from './message-alignment.ts';
import { cx } from '../../packages/ui-kit/src/h.ts';
import type { UiMessage } from '../../packages/ipc/src/client.ts';

const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
const ROBOT_KEY = 'key.im.servicechat.robotnickname';
const owner = { account_id: 'synthetic-account', environment: 'prod', session_generation: 1 };
const conv = { gid: 'synthetic-room', account: owner, title: 'Synthetic Customer', color: '#aaa', order: null };
const msg = (extra: Partial<UiMessage>): UiMessage => ({ gid: 'synthetic-room', message_id: 'm1', local_id: null, text: 'SYNTHETIC', kind: 'text', create_time_ms: 1, sender_role: 'robot', sender_id: 'synthetic-bot', sender_name: null, sender_avatar: null, translation: null, original: null, quote: null, order_id: null, disposition: null, ...extra });
interface Node { tag: string; props: Record<string, any>; children: unknown[] }
const nodes = (tree: unknown): Node[] => (Array.isArray(tree) ? tree.flatMap(nodes) : !tree || typeof tree !== 'object' ? [] : [tree as Node, ...nodes((tree as Node).children ?? [])]);
const text = (tree: unknown): string => JSON.stringify(tree);

function renderRow(message: UiMessage) {
  const env: Record<string, unknown> = { ...vm, netEverConnected: true, inboundTranslation: { view: () => null, supplier: () => null }, refreshMessageTranslation() {}, messageAlignment, cx, h: (tag: string, props: unknown, ...children: unknown[]) => ({ tag, props: props ?? {}, children }), document: {}, renderMessageAvatar: (_d: unknown, name: string) => `avatar:${name}`, t: (k: string) => k, icon: () => null, IC: {}, richText: (s: string) => [s], formatDate: () => 'd', formatClock: () => 'c', store: { patch() {} }, copyText() {}, toast() {}, openMessageOrder() {} };
  const a = source.indexOf('function messageRow('), b = source.indexOf('\nfunction translationBar(', a);
  const row = new Function(...Object.keys(env), stripTypeScriptTypes(source.slice(a, b)) + '\nreturn messageRow;')(...Object.values(env));
  return row({ messages: {}, prefs: { general: { show_msg_time: false } } }, message, conv, { context: owner, color: '#bbb' });
}

test('D4: a robot sender shown in the message list is never the raw localization key', () => {
  const tree = renderRow(msg({ sender_name: ROBOT_KEY }));
  assert.ok(!text(tree).includes(ROBOT_KEY), 'raw key must not reach the screen');
  assert.ok(text(tree).includes('游游机器人'));
  assert.ok(nodes(tree).some(n => n.props['class'] === 'mmeta' && n.children.includes('游游机器人')));
  assert.ok(text(tree).includes('avatar:游游机器人'), 'the avatar placeholder derives from the translated name');
});

test('D4: only the exact observed key is translated; free names and ids stay intact', () => {
  assert.ok(text(renderRow(msg({ sender_name: 'SYNTHETIC ' + ROBOT_KEY }))).includes('SYNTHETIC ' + ROBOT_KEY));
  assert.ok(text(renderRow(msg({ sender_name: 'Alice' }))).includes('Alice'));
  assert.ok(text(renderRow(msg({ sender_name: null, sender_id: 'uid-77' }))).includes('uid-77'));
});

test('D5: an unknown local echo and its confirmed history row are one message, in either arrival order', () => {
  const local = msg({ message_id: null, local_id: 'L1', sender_role: 'merchant_self', sender_id: 'agent', disposition: { kind: 'unknown' } });
  const server = msg({ message_id: 'S1', local_id: 'L1', sender_role: 'merchant_self', sender_id: 'agent', disposition: { kind: 'confirmed', server_message_id: 'S1', server_time_ms: 2 } });
  for (const merged of [vm.mergeHistory([server], [local]), vm.mergeHistory([local], [server]), vm.mergeHistoryIncremental(vm.mergeHistory([local], []), server)]) {
    assert.equal(merged.length, 1);
    assert.equal(merged[0]!.message_id, 'S1');
    assert.equal(merged[0]!.disposition?.kind, 'confirmed');
  }
});

test('D5: a history order card keeps its own order ID and never renders another order from the sidebar', () => {
  const card = msg({ kind: 'order_card', order_id: 'ORDER-A', sender_role: 'customer', text: 'card text' });
  const withOtherSideOrder = { ...conv, order: { order_id: 'ORDER-B', product: 'PRODUCT B', use_date: 'X', quantity: 1, status: 'S' } };
  const env: Record<string, unknown> = { ...vm, netEverConnected: true, inboundTranslation: { view: () => null, supplier: () => null }, refreshMessageTranslation() {}, messageAlignment, cx, h: (tag: string, props: unknown, ...children: unknown[]) => ({ tag, props: props ?? {}, children }), document: {}, renderMessageAvatar: () => 'avatar', t: (k: string) => k, icon: () => null, IC: {}, richText: (s: string) => [s], formatDate: () => 'd', formatClock: () => 'c', store: { patch() {} }, copyText() {}, toast() {}, openMessageOrder() {} };
  const a = source.indexOf('function messageRow('), b = source.indexOf('\nfunction translationBar(', a);
  const row = new Function(...Object.keys(env), stripTypeScriptTypes(source.slice(a, b)) + '\nreturn messageRow;')(...Object.values(env));
  const tree = row({ messages: {}, prefs: { general: { show_msg_time: false } } }, card, withOtherSideOrder, { context: owner });
  assert.ok(text(tree).includes('ORDER-A'));
  assert.ok(!text(tree).includes('PRODUCT B'), 'order B summary must not be attributed to order A card');
});
