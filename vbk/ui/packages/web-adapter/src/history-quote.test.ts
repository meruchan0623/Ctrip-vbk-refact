import { test } from 'node:test';
import assert from 'node:assert/strict';
import { httpMessageToUi, sdkMessageToUi } from './display.ts';
import { buildMemberRoles } from './facts.ts';

const roles = buildMemberRoles({ selfUid: 'agent', customerUid: 'customer', members: [] });
const timestamp = 1793689482000;
const quoteId = '9223372036854775806';

test('history/compensation retains both captured HTTP quote spellings with exact IDs', () => {
  for (const field of ['citeMsgId', 'citemsgid']) {
    const row = { msgId: 'reply', msgtype: 0, messageBody: 'reply text', fromJid: 'room@conf/customer', createTime: timestamp, [field]: quoteId };
    assert.equal(httpMessageToUi(row, roles)?.quote, quoteId);
  }
  const event = { id: 'reply', type: 'groupchat', msgtype: '0', body: 'reply text', from: 'room@conf/customer', create_time: timestamp, citemsgid: quoteId };
  assert.equal(sdkMessageToUi(event, roles)?.quote, quoteId);
});

test('canonical HTTP quote spelling wins while unsafe numeric quote IDs remain unknown', () => {
  const row = { msgId: 'reply', msgtype: 0, messageBody: 'reply text', fromJid: 'room@conf/customer', createTime: timestamp };
  assert.equal(httpMessageToUi({ ...row, citeMsgId: 'canonical', citemsgid: 'legacy' }, roles)?.quote, 'canonical');
  for (const field of ['citeMsgId', 'citemsgid']) {
    assert.equal(httpMessageToUi({ ...row, [field]: 9223372036854775806 }, roles)?.quote, null);
  }
});
