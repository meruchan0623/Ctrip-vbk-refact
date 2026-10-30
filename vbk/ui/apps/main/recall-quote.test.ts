import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import * as viewmodel from './viewmodel.ts';
import { cx } from '../../packages/ui-kit/src/h.ts';
import { messageAlignment } from './message-alignment.ts';
import { mergeMessageProfile } from './message-profile.ts';
import { settleAccountSend } from './sendScope.ts';
import { attachmentSendUnavailable } from './sendComposer.ts';
import type { UiMessage } from '../../packages/ipc/src/client.ts';

const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
const secret = 'SYNTHETIC_RECALLED_SECRET';
const original: UiMessage = { gid: 'synthetic-room', message_id: 'synthetic-original', local_id: null, sender_role: 'customer', kind: 'text', text: secret, create_time_ms: 1800000000000, translation: null, original: null, quote: null, order_id: null, disposition: null };
const reply: UiMessage = { ...original, message_id: 'synthetic-reply', text: 'SYNTHETIC REPLY', quote: secret };
const notice: UiMessage & { readonly recalled_message_id: string | null } = { ...original, message_id: 'synthetic-notice', kind: 'system', text: '消息已撤回', recalled_message_id: original.message_id };
const conv = { gid: original.gid, title: 'Synthetic Customer', color: '#aaa', lang: 'en', order: null };
const account = { context: { account_id: 'synthetic-account', environment: 'synthetic', session_generation: 1 }, color: '#bbb' };
interface Node { tag: string; props: Record<string, unknown>; children: unknown[] }
const h = (tag: string, props: Record<string, unknown> | null, ...children: unknown[]): Node => ({ tag, props: props ?? {}, children });
function fixture(messages: UiMessage[], selected: UiMessage | null = original) {
  const state = { messages: { [original.gid]: messages }, activeGid: original.gid, quote: selected, draft: 'SYNTHETIC NEW DRAFT', drafts: {}, draftVersion: 1, attachment: null, translation: { target: 'en' }, prefs: { general: { show_msg_time: true }, assistant: { enabled: false }, keys: {} }, hideInboundTr: false };
  const commands: { command: string; payload: Record<string, unknown> }[] = [];
  const env = {
    ...viewmodel, h, cx, messageAlignment, mergeMessageProfile, settleAccountSend, attachmentSendUnavailable,
    renderMessageAvatar: () => h('span', null, 'avatar'), document: {},
    activeAccount: () => account, activeConv: () => conv, stillActive: () => true,
    S: () => state, store: { patch: (patch: object) => Object.assign(state, patch) },
    t: (key: string) => key, icon: () => null, IC: {}, richText: (text: string) => [text],
    formatDate: () => 'synthetic-date', formatClock: () => 'synthetic-time',
    translationOn: () => false, translationBar: () => null, notWired: (node: unknown) => node,
    isDone: () => false, isAppError: () => false,
    UiCommands: { IM_SEND_TEXT: 'im_send_text' },
    ipc: { invoke: async (command: string, payload: Record<string, unknown>) => { commands.push({ command, payload }); return { kind: 'confirmed', server_message_id: 'synthetic-new-message', server_time_ms: 1800000000100 }; } },
    upsertMessage: (_message: unknown) => true,
  };
  function run(name: string, next: string, async = false): (...args: unknown[]) => unknown {
    const start = source.indexOf(`${async ? 'async ' : ''}function ${name}(`);
    const end = source.indexOf(`\n${next}`, start);
    assert.ok(start >= 0 && end > start);
    return new Function(...Object.keys(env), stripTypeScriptTypes(source.slice(start, end)) + `\nreturn ${name};`)(...Object.values(env));
  }
  return { state, commands, run };
}

test('actual messageRow never renders recalled text through a legacy copied quote after visible filtering', () => {
  const { state, run } = fixture([original, reply, notice]);
  const render = run('messageRow', 'function translationBar(');
  const visible = viewmodel.visibleMessages(state.messages[original.gid]!);
  assert.equal(visible.some((message) => message.message_id === original.message_id), false);
  const rows = visible.map((message) => render(state, message, conv, account));
  assert.equal(JSON.stringify(rows).includes(secret), false);
});

test('actual composer does not expose a selected message after its recall tombstone arrives', () => {
  const { state, run } = fixture([original, notice]);
  const render = run('composer', 'function emojiPicker(');
  assert.equal(JSON.stringify(render(state, conv)).includes(secret), false);
  assert.equal(state.draft, 'SYNTHETIC NEW DRAFT');
});

test('actual sendText omits a recalled quote target and never copies its body into the local reply', async () => {
  const { state, commands, run } = fixture([original, notice]);
  await run('sendText', 'function translationOn(', true)('SYNTHETIC REPLY', null);
  assert.equal(commands.length, 1);
  assert.equal(commands[0]?.payload['quote_id'], undefined);
  const local = state.messages[original.gid]!.at(-1);
  assert.equal(local?.quote, null);
});

test('actual upsert clears a selected recalled message while preserving the current draft', () => {
  const { state, run } = fixture([original]);
  run('upsertMessage', 'function upsertConversation(')(notice);
  assert.equal(state.quote, null);
  assert.equal(state.draft, 'SYNTHETIC NEW DRAFT');
});

test('new local reply stores only a verified target ID; later recall replaces its preview without a copied body', async () => {
  const { state, commands, run } = fixture([original]);
  await run('sendText', 'function translationOn(', true)('SYNTHETIC REPLY', null);
  const local = state.messages[original.gid]!.at(-1)!;
  assert.equal(commands[0]?.payload['quote_id'], original.message_id);
  assert.equal(local.quote, original.message_id);
  assert.equal(JSON.stringify(local).includes(secret), false);
  assert.equal(viewmodel.messageQuotePreview(local, state.messages[original.gid]!), secret);
  const withRecall = [...state.messages[original.gid]!, notice];
  assert.equal(viewmodel.messageQuotePreview(local, withRecall), viewmodel.QUOTE_RECALLED);
  const render = run('messageRow', 'function translationBar(');
  assert.equal(JSON.stringify(render({ ...state, messages: { [original.gid]: withRecall } }, local, conv, account)).includes(secret), false);
});

test('legacy quote strings never establish provenance even when their text equals a real message ID', () => {
  assert.equal(viewmodel.messageQuotePreview({ ...reply, quote: original.message_id }, [original, reply]), viewmodel.QUOTE_UNAVAILABLE);
  assert.equal(viewmodel.messageQuotePreview(reply, [original, reply]), viewmodel.QUOTE_UNAVAILABLE);
});

test('verified target survives a sparse echo but conflicting quote metadata is not guessed', () => {
  const local = { ...reply, quote: original.message_id, quote_target_id: original.message_id };
  const echoed = viewmodel.mergeQuoteReference(local, { ...reply, quote: null });
  assert.equal(viewmodel.messageQuotePreview(echoed, [original, notice]), viewmodel.QUOTE_RECALLED);
  const conflicting = viewmodel.mergeQuoteReference(local, { ...reply, quote: 'synthetic-conflicting-id' });
  assert.equal(viewmodel.messageQuotePreview(conflicting, [original]), viewmodel.QUOTE_UNAVAILABLE);
});

test('quote resolution is by confirmed target ID and current gid, never copied text or another room tombstone', () => {
  const local = { ...reply, quote: original.message_id, quote_target_id: original.message_id };
  assert.equal(viewmodel.messageQuotePreview(local, [original, { ...notice, gid: 'synthetic-other-room' }]), secret);
  assert.equal(viewmodel.selectedQuoteReference(original, [original, notice], original.gid), null);
  assert.equal(viewmodel.selectedQuoteReference({ ...original, message_id: null, local_id: 'synthetic-pending-local' }, [original], original.gid), null);
  assert.equal(viewmodel.selectedQuoteReference(original, [original], 'synthetic-other-room'), null);
  assert.equal(viewmodel.messageQuotePreview(local, [notice]), viewmodel.QUOTE_RECALLED);
});

test('a sender role change without a new UID never inherits an old verified quote target', () => {
  const local = { ...reply, sender_role: 'merchant_self' as const, sender_id: 'synthetic-self', quote: original.message_id, quote_target_id: original.message_id };
  for (const role of ['customer', 'merchant_other', 'unknown'] as const) {
    const incoming: UiMessage = { ...reply, sender_role: role, quote: null };
    const merged = viewmodel.mergeQuoteReference(local, incoming);
    assert.equal(viewmodel.messageQuotePreview(merged, [original]), null);
    assert.equal((merged as viewmodel.QuotedUiMessage).quote_target_id, undefined);
  }
});
