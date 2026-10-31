import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toDisplayConversation } from './display.ts';
import { mapConversationStatus, toConversationFact } from './conversationList.ts';
import { sampleRow } from './testing.ts';

test('real display producer preserves business type while status 1 is explicitly active', () => {
  const projected = toDisplayConversation(sampleRow('synthetic', { conversationType: 'O2B', serviceType: '2573', status: 1 }), true);
  assert.equal(projected?.conversation_type, 'O2B');
  assert.equal(projected?.service_type, '2573'); assert.equal(projected?.status, 'active');
  assert.equal(mapConversationStatus(1), 'active');
  assert.equal('conversation_type' in toConversationFact(sampleRow('synthetic'), true)!, false, 'persistent fact schema stays unchanged');
});

for (const type of ['B2C', 'C2B', 'B2MC', 'B2O', 'O2B', 'B2B', 'SYNTHETIC_UNKNOWN', ' B2C ', '未知类型', 'X'.repeat(64), '😀'.repeat(32)]) test(`producer preserves exact bounded type ${JSON.stringify(type)}`, () => {
  assert.equal(toDisplayConversation(sampleRow('synthetic', { conversationType: type }), false)?.conversation_type, type);
});
for (const type of [undefined, null, '', '  ', 12, {}, 'X'.repeat(65), 'B2C\u0000', 'B2C\u0085', '\ufeff', '😀'.repeat(33)]) test(`producer emits explicit null for invalid type ${JSON.stringify(type)}`, () => {
  const projected = toDisplayConversation(sampleRow('synthetic', { conversationType: type }), false);
  assert.ok(projected); assert.equal(Object.hasOwn(projected, 'conversation_type'), true); assert.equal(projected.conversation_type, null);
});
test('status mapping leaves unknown and wrong-shaped codes unknown', () => {
  for (const value of [0, 3, 99, '1', '2', null, undefined, NaN]) assert.equal(mapConversationStatus(value), 'unknown');
  assert.equal(mapConversationStatus(2), 'active'); assert.equal(mapConversationStatus(4), 'finished');
});

test('numeric status1 is active rather than unknown fallback', () => { assert.equal(mapConversationStatus(1), 'active'); });
