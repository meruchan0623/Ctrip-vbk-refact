import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roomJidFromMessage } from './stores.ts';
import { normalizeHttpMessage, UNKNOWN_ROLES } from './facts.ts';
import { httpMessageToUi } from './display.ts';

const message = { msgId: 'synthetic-message', msgtype: 0, messageBody: 'synthetic text', createTime: 1700000000000, fromJid: '123456@muc.example.invalid/synthetic-agent', toJid: 'self@example.invalid' };

test('history room resource routes facts and display to the room rather than the recipient account', () => {
  assert.equal(normalizeHttpMessage(message, { roles: UNKNOWN_ROLES, source: 'history' })?.gid, '123456');
  assert.equal(httpMessageToUi(message, UNKNOWN_ROLES)?.gid, '123456');
  assert.equal(roomJidFromMessage('123456', message), '123456@muc.example.invalid');
});

test('room lookup cannot borrow a different room or a customer alias as the target', () => {
  assert.equal(roomJidFromMessage('999999', message), null);
  assert.equal(roomJidFromMessage('synthetic-customer', message), null);
  assert.equal(normalizeHttpMessage(message, { roles: UNKNOWN_ROLES, source: 'history', gid: 'explicit-room' })?.gid, 'explicit-room');
  assert.equal(httpMessageToUi(message, UNKNOWN_ROLES, 'explicit-room')?.gid, 'explicit-room');
});
