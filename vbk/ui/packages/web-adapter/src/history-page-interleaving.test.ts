import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AdapterDisplayPayload } from '../../ipc/src/adapterProtocol.ts';
import { createPageSession } from './session.ts';
import { FakePageSdk, OK_STATUS, flush, jsonResponse, makeDeps, sampleRow } from './testing.ts';

function fixture() {
  let release!: (value: ReturnType<typeof jsonResponse>) => void;
  const base = makeDeps(call => call.url.includes('getMessageList') ? new Promise(resolve => { release = resolve; }) : jsonResponse(call.url.includes('getConversationList')
    ? { ResponseStatus: OK_STATUS, conversationList: [sampleRow('123456')], haveRest: false }
    : call.url.includes('getRecentMessages') ? { ResponseStatus: OK_STATUS, messages: [], lastMessageTimestamp: 1700000000000 }
    : { ResponseStatus: OK_STATUS, members: [] }));
  const sdk = new FakePageSdk(), displays: AdapterDisplayPayload[] = [];
  const session = createPageSession({ ...base, sdk }, { sdk, account: { account_id: 'synthetic', environment: 'production', session_generation: 1 }, selfUid: 'me', beginMsgTime: 1700000000000, initialEpoch: 1, pushDisplay: async payload => { displays.push(payload); } });
  return { base, sdk, displays, session, release: () => { assert.equal(typeof release, 'function'); release(jsonResponse({ ResponseStatus: OK_STATUS, rangeMessage: { isDone: true, messages: [{ msgId: 'old-history', messageBody: 'older history', fromJid: '123456@muc.synthetic/customer', createTime: 1700000001000, msgtype: 0 }] } })); } };
}

test('history page: realtime arriving during the actual history request survives partial merge and keeps the latest preview/time', async () => {
  const f = fixture(); f.session.start();
  try {
    await f.base.clock.advance(50);
    const pending = f.session.rpc.handle({ req_id: 'page', op: 'im.message_page', args: { gid: '123456' } });
    for (let i = 0; i < 8; i++) await flush();
    f.sdk.emit('message', { type: 'groupchat', id: 'new-realtime', from: '123456@muc.synthetic/customer', to: 'me@synthetic', create_time: 1700000002000, msgtype: 0, body: 'newest realtime' });
    f.release(); const reply = await pending; assert.ok(reply?.ok);
    const batches = f.displays.filter(p => p.kind === 'messages');
    assert.equal(batches.length, 2);
    assert.ok(batches.every(p => p.kind === 'messages' && p.replace === false));
    assert.ok(batches[0]?.kind === 'messages' && batches[0].items[0]?.message_id === 'new-realtime');
    assert.ok(batches[1]?.kind === 'messages' && batches[1].items[0]?.message_id === 'old-history');
    const conversation = f.displays.flatMap(p => p.kind === 'conversations' ? p.items : []).at(-1);
    assert.equal(conversation?.last_message_time_ms, 1700000002000); assert.equal(conversation?.preview, 'newest realtime');
  } finally { f.session.stop(); }
});

test('history page: a response held across stop/restart cannot publish into the successor run', async () => {
  const f = fixture(); f.session.start();
  try {
    await f.base.clock.advance(50);
    const pending = f.session.rpc.handle({ req_id: 'stale-page', op: 'im.message_page', args: { gid: '123456' } });
    for (let i = 0; i < 8; i++) await flush();
    f.session.stop(); f.session.start(); await f.base.clock.advance(50); const before = f.displays.length;
    f.release(); const reply = await pending;
    assert.ok(reply && !reply.ok); assert.equal(reply.error.code, 'adapter.not_ready'); assert.equal(f.displays.length, before);
    assert.equal(f.sdk.sent.length, 0);
  } finally { f.session.stop(); }
});
