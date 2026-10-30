import { test } from 'node:test';
import assert from 'node:assert/strict';
import { messageAlignment } from './message-alignment.ts';
import type { UiMessageKind } from '../../packages/ipc/src/client.ts';

for (const kind of ['text', 'image', 'file', 'video', 'order_card'] satisfies UiMessageKind[]) {
  test(`both merchant roles align ${kind} right while self-only controls stay self-only`, () => {
    assert.deepEqual(messageAlignment({ kind, sender_role: 'merchant_self' }), { side: 'right', self: true });
    assert.deepEqual(messageAlignment({ kind, sender_role: 'merchant_other' }), { side: 'right', self: false });
  });
}

test('customer and unknown retain left alignment without self identity or send controls', () => {
  for (const sender_role of ['customer', 'unknown', 'ctrip_agent', 'robot', 'system'] as const) {
    assert.deepEqual(messageAlignment({ kind: 'text', sender_role }), { side: 'left', self: false });
  }
});

test('system rows stay system rows regardless of the sender role', () => {
  for (const sender_role of ['merchant_self', 'merchant_other', 'customer', 'unknown', 'system'] as const) {
    assert.deepEqual(messageAlignment({ kind: 'system', sender_role }), { side: 'system', self: false });
  }
});
