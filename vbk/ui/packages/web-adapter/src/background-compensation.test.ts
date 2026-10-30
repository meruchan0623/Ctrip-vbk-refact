import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPageSession } from './session.ts';
import { FakePageSdk, OK_STATUS, jsonResponse, makeDeps, sampleRow } from './testing.ts';
import type { AdapterDisplayPayload } from '../../ipc/src/adapterProtocol.ts';

test('active account continues real compensation after five minutes without RPC, reconnect or SDK message', async () => {
  let available = false;
  const base = makeDeps(call => {
    if (call.url.includes('getConversationList')) return jsonResponse({ ResponseStatus: OK_STATUS, conversationList: [sampleRow('123456')], haveRest: false });
    if (call.url.includes('getRecentMessages')) return jsonResponse({ ResponseStatus: OK_STATUS, lastMessageTimestamp: base.clock.now(), messages: available ? [{ msgId: 'late-server', fromJid: '123456@muc.synthetic/customer', toJid: 'me@synthetic', messageBody: 'synthetic late inbound', msgtype: 0, createTime: base.clock.now() }] : [] });
    return jsonResponse({ ResponseStatus: OK_STATUS });
  });
  const sdk = new FakePageSdk();
  const displays: AdapterDisplayPayload[] = [];
  const session = createPageSession({ ...base, sdk }, { account: { account_id: 'synthetic', environment: 'production', session_generation: 1 }, selfUid: 'me', beginMsgTime: base.clock.now(), initialEpoch: 1, sdk, pushDisplay: async payload => { displays.push(payload); } });
  session.start();
  await base.clock.advance(301000);
  available = true;
  await base.clock.advance(11000);
  assert.ok(displays.some(payload => payload.kind === 'messages' && payload.items.some(item => item.message_id === 'late-server')), 'the production session must still receive after the SDK mirror stop limit');
  assert.equal(sdk.sent.length, 0);
  session.stop();
  const calls = base.fakeFetch.calls.length;
  await base.clock.advance(30000);
  assert.equal(base.fakeFetch.calls.length, calls, 'stopping the account stops compensation');
  assert.equal(base.clock.pendingCount(), 0);
});
