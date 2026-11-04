import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMemberRoles, normalizeHttpMessage, normalizeSdkMessage } from './facts.ts';
import { httpMessageToUi, sdkMessageToUi, previewOf, messageText } from './display.ts';
import { messageAlignment } from '../../../apps/main/message-alignment.ts';

const roles = buildMemberRoles({ selfUid: 'agent', customerUid: 'customer', members: [] });
const time = 1793689482000;

test('desktop custom text stays customer-aligned in history, compensation, realtime and list previews', () => {
  // Synthetic protocol fixture; wording from the report, not a captured payload.
  const text = 'Не работала сим карта';
  const body = JSON.stringify({ action: 'CBZ06', title: text, ext: { aiMsgType: 0, key: 'MATCH', replaceSender: 'customer' } });
  const row = { msgId: 'custom-text', msgtype: 7, messageBody: body, fromJid: 'room@conf/relay', toJid: 'agent@x', createTime: time };
  const event = { id: row.msgId, type: 'groupchat', msgtype: '7', body, from: row.fromJid, to: row.toJid, create_time: time };
  for (const source of ['history', 'compensation', 'init'] as const) {
    const fact = normalizeHttpMessage(row, { roles, source });
    assert.equal(fact?.sender_role, 'customer');
    assert.equal(fact?.kind, 'business');
  }
  assert.equal(normalizeSdkMessage(event, { roles })?.sender_role, 'customer');
  assert.equal(normalizeSdkMessage(event, { roles })?.kind, 'business');
  for (const ui of [httpMessageToUi(row, roles), sdkMessageToUi(event, roles)]) {
    assert.ok(ui);
    assert.equal(ui.text, text);
    assert.equal(ui.sender_id, 'customer');
    assert.equal(ui.kind, 'text');
    assert.equal(messageAlignment(ui).side, 'left');
  }
  assert.equal(previewOf(row), text);
});

test('system category stays separate even with a customer sender or customer-like wording', () => {
  for (const text of ['The inquiry order changed: 123456', 'Не работала сим карта', 'Риски: Частные транзакции опасны и небезопасны.']) {
    const body = JSON.stringify({ title: text, action: 'NBZ37', ext: { replaceSender: 'customer' } });
    const row = { msgId: 'system', msgtype: 1007, messageBody: body, fromJid: 'room@conf/relay', createTime: time };
    const event = { id: 'system', type: 'groupchat', msgtype: '1007', from: row.fromJid, body, create_time: time };
    assert.equal(normalizeHttpMessage(row, { roles, source: 'compensation' })?.kind, 'control');
    assert.equal(normalizeSdkMessage(event, { roles })?.kind, 'control');
    for (const ui of [httpMessageToUi(row, roles), sdkMessageToUi(event, roles)]) {
      assert.ok(ui);
      assert.equal(messageAlignment(ui).side, 'system');
      assert.equal(ui.text, text);
    }
  }
});

test('card/custom content use sender bubbles; action prefixes do not define system category', () => {
  for (const msgtype of [2, 7]) {
    const row = { msgtype, messageBody: JSON.stringify({ action: 'NBZ73', title: 'fallback', ext: { title: 'body', highlight: '!' } }), msgId: 'm', fromJid: 'room@conf/agent', createTime: time };
    const ui = httpMessageToUi(row, roles)!;
    assert.equal(ui.kind, 'text');
    assert.equal(messageAlignment(ui).side, 'right');
    assert.equal(normalizeHttpMessage(row, { roles, source: 'compensation' })?.kind, 'business');
  }
  assert.equal(messageText(7, JSON.stringify({ action: 'NBZ73', ext: { title: 'body', highlight: '!' } })), 'body!');
  assert.equal(messageText(7, 'plain fallback'), 'plain fallback');
  assert.equal(messageText(0, '{"ext":{"replaceSender":"nobody"}}'), '{"ext":{"replaceSender":"nobody"}}');
});

test('ordinary customer text containing JSON cannot become an agent reply', () => {
  const body = '{"ext":{"replaceSender":"agent"}}';
  const row = { msgId: 'json-text', msgtype: 0, messageBody: body, fromJid: 'room@conf/customer', createTime: time };
  const evt = { id: 'json-text', type: 'groupchat', msgtype: '0', body, from: row.fromJid, create_time: time };
  assert.equal(normalizeHttpMessage(row, { roles, source: 'compensation' })?.sender_role, 'customer');
  assert.equal(normalizeSdkMessage(evt, { roles })?.sender_role, 'customer');
  assert.equal(httpMessageToUi(row, roles)?.sender_role, 'customer');
  assert.equal(sdkMessageToUi(evt, roles)?.sender_role, 'customer');
});
