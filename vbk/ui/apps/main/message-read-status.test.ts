import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import type { UiMessage } from '../../packages/ipc/src/client.ts';
import { readMessageReadStatusEvent, applyMessageReadStatuses } from './message-read-status.ts';

const account = { account_id: 'synthetic-account', environment: 'production', session_generation: 1 };
const row: UiMessage = { gid: 'g', message_id: 'old-history', local_id: 'local', sender_id: 'me', sender_role: 'merchant_self', create_time_ms: 1, kind: 'text', text: 'SYNTHETIC', translation: null, original: null, quote: null, order_id: null, disposition: null };
const payload = { account, gid: 'g', items: [{ message_id: row.message_id!, sender_id: 'me', read_status: 'read' as const }] };

test('receipt-only UI patch updates loaded history beyond host cache, without replacing content or creating messages', () => {
  const messages = [row, ...Array.from({ length: 600 }, (_, i) => ({ ...row, message_id: `new-${i}`, create_time_ms: i + 2 }))];
  const event = readMessageReadStatusEvent(payload, account)!;
  const next = applyMessageReadStatuses(messages, event);
  assert.equal(next[0]?.read_status, 'read'); assert.equal(next[0]?.text, row.text); assert.equal(next.length, messages.length);
  assert.equal(next[600], messages[600]);
  assert.equal(applyMessageReadStatuses(next, { ...event, items: [{ ...payload.items[0]!, read_status: 'unread' }] }), next);
  assert.equal(applyMessageReadStatuses(messages, { ...event, items: [{ ...payload.items[0]!, sender_id: 'other' }] }), messages);
  assert.equal(applyMessageReadStatuses(messages, { ...event, gid: 'other-room' }), messages);
  assert.equal(applyMessageReadStatuses(messages, { ...event, items: [{ ...payload.items[0]!, message_id: 'local' }] }), messages);
});

test('receipt event rejects wrong account, generation, environment, malformed and partial patches atomically', () => {
  for (const invalid of [null, {}, { ...payload, account: { ...account, account_id: 'other' } }, { ...payload, account: { ...account, session_generation: 2 } }, { ...payload, account: { ...account, environment: 'test' } }, { ...payload, items: [...payload.items, { message_id: 'bad', sender_id: 'me', read_status: true }] }, { ...payload, items: [{ ...payload.items[0], sender_id: '' }] }]) assert.equal(readMessageReadStatusEvent(invalid, account), null);
  assert.equal(readMessageReadStatusEvent(payload, null), null);
});

test('actual main receipt listener applies the scoped event to loaded state', () => {
  const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  assert.ok(source.includes('ipc.listen<unknown>(Events.IM_MESSAGE_READ_STATUSES, receiveMessageReadStatuses)'));
  const state = { messages: { g: [row] as readonly UiMessage[] } };
  const env = { readMessageReadStatusEvent, applyMessageReadStatuses, activeAccount: () => ({ context: account }), S: () => state, store: { patch: (p: typeof state) => Object.assign(state, p) } };
  const start = source.indexOf('function receiveMessageReadStatuses('), end = source.indexOf('\nfunction receiveMainMessage(', start);
  const receive = new Function(...Object.keys(env), stripTypeScriptTypes(source.slice(start, end)) + '\nreturn receiveMessageReadStatuses;')(...Object.values(env));
  receive(payload); assert.equal(state.messages.g[0]?.read_status, 'read');
  const previous = state.messages.g;
  receive({ ...payload, account: { ...account, session_generation: 2 } }); assert.equal(state.messages.g, previous);
});
