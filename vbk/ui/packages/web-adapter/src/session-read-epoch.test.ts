import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPageSession } from './session.ts';
import { FakePageSdk, OK_STATUS, jsonResponse, makeDeps, sampleRow, flush } from './testing.ts';
const gid = '123456';
test('actual session refuses late former-service unread counts and message targets, including A -> B -> A', async () => {
  let release!: (response: ReturnType<typeof jsonResponse>) => void;
  const base = makeDeps(call => call.url.includes('getConversationList') ? jsonResponse({ ResponseStatus: OK_STATUS, conversationList: [sampleRow(gid)], haveRest: false })
    : call.url.includes('getConversationInfoByGidList') ? new Promise(resolve => { release = resolve; })
    : jsonResponse({ ResponseStatus: OK_STATUS, members: [] }));
  const sdk = new FakePageSdk();
  const session = createPageSession({ ...base, sdk }, { sdk, account: { account_id: 'synthetic', environment: 'test', session_generation: 1 }, selfUid: 'me', initialEpoch: 1, beginMsgTime: 1700000000000, pushDisplay: async () => {}, unreadDebounceMs: 1 });
  session.start();
  try {
    await base.clock.advance(50); assert.equal(typeof release, 'function');
    session.unread.set(gid, 42);
    session.store.update([sampleRow(gid, { uid: 'customer-B', sessionId: 'session-B' })]);
    assert.equal(session.unread.unreadOf(gid), null, 'old unread does not carry into the new service');
    session.store.update([sampleRow(gid)]);
    const before = session.store.latestMessage(gid);
    release(jsonResponse({ ResponseStatus: OK_STATUS, bizResponseStatus: { resultCode: 'SUCCESS' }, conversationInfoList: [{ gid, unreadCount: 0, message: { msgId: 'late-A-unread-target', createTime: 1700000009999, toJid: gid + '@old-domain' } }] }));
    await flush();
    assert.equal(session.unread.unreadOf(gid), null);
    assert.deepEqual(session.store.latestMessage(gid), before);
    assert.notEqual(sdk.partnerJidOf(gid), gid + '@old-domain');
    assert.equal(sdk.readReceipts.length, 0);
  } finally { session.stop(); }
});
