import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AdapterDisplayPayload } from '../../ipc/src/adapterProtocol.ts';
import { createPageSession } from './session.ts';
import { SoaClient } from './soa.ts';
import { FakePageSdk, OK_STATUS, jsonResponse, makeDeps, sampleRow } from './testing.ts';

test('history preserves authoritative unread across unchanged polling until server confirms zero', async () => {
  let serverUnread = 3;
  const base = makeDeps((call) => {
    if (call.url.includes('getConversationList')) return jsonResponse({ ResponseStatus: OK_STATUS, conversationList: [sampleRow('123456')], haveRest: false });
    if (call.url.includes('getConversationInfoByGidList')) return jsonResponse({ ResponseStatus: OK_STATUS, bizResponseStatus: { resultCode: 'SUCCESS' }, conversationInfoList: [{ gid: '123456', unreadCount: serverUnread }] });
    if (call.url.includes('getMessageList')) return jsonResponse({ ResponseStatus: OK_STATUS, rangeMessage: { isDone: true, messages: [{ msgId: 'history-only', messageBody: 'synthetic history', fromJid: 'cust-123456@x', createTime: 1700000000100, msgtype: 0 }] } });
    return jsonResponse({ ResponseStatus: OK_STATUS, members: [] });
  });
  const sdk = new FakePageSdk();
  const displays: AdapterDisplayPayload[] = [];
  const session = createPageSession({ ...base, sdk }, {
    account: { account_id: 'synthetic-account', environment: 'production', session_generation: 1 },
    selfUid: 'me', beginMsgTime: 1700000000000, initialEpoch: 1, sdk,
    pushDisplay: async (payload) => { displays.push(payload); return null; }, unreadDebounceMs: 10,
  });
  const latestUnread = () => displays.flatMap((d) => d.kind === 'conversations' ? d.items : []).filter((c) => c.gid === '123456').at(-1)?.unread_count;
  session.start();
  try {
    await base.clock.advance(50);
    assert.equal(latestUnread(), 3);
    const result = await session.rpc.handle({ req_id: 'history', op: 'im.messages', args: { gid: '123456' } });
    assert.equal(result?.ok, true);
    assert.ok(displays.some((d) => d.kind === 'messages' && d.items.some((m) => m.message_id === 'history-only')));
    assert.equal(latestUnread(), 3, 'history is not a read receipt and must not overwrite unread with zero');
    assert.equal(sdk.readReceipts.length, 0, 'history itself must not send a read receipt');
    const unchanged = await session.unread.refresh({ ...base, sdk }, new SoaClient(base), ['123456']);
    assert.deepEqual(unchanged, [], 'same server count does not trigger a corrective display');
    assert.equal(latestUnread(), 3);
    // This is the UI gate: history must leave the pending receipt eligible.
    if ((latestUnread() ?? 0) > 0) {
      assert.equal((await session.rpc.handle({ req_id: 'read', op: 'im.mark_read', args: { gid: '123456' } }))?.ok, true);
    }
    assert.equal(sdk.readReceipts.length, 1);
    assert.equal(latestUnread(), 3, 'SDK acknowledgment alone does not prove server unread zero');
    serverUnread = 0;
    await base.clock.advance(5100);
    assert.equal(latestUnread(), 0, 'confirmed server zero must still propagate');
  } finally { session.stop(); }
});
