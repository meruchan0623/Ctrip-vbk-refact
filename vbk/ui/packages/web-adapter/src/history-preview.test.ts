import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AdapterDisplayPayload } from '../../ipc/src/adapterProtocol.ts';
import { createPageSession } from './session.ts';
import { FakePageSdk, OK_STATUS, jsonResponse, makeDeps, sampleRow } from './testing.ts';

test('history enrichment cannot restore a stale conversation preview after a realtime recall', async () => {
  const base = makeDeps((call) => {
    if (call.url.includes('getConversationList')) return jsonResponse({ ResponseStatus: OK_STATUS, conversationList: [sampleRow('123456')], haveRest: false });
    if (call.url.includes('getMessageList')) return jsonResponse({ ResponseStatus: OK_STATUS, rangeMessage: { isDone: true, messages: [{ msgId: 'old', messageBody: 'synthetic previous content', createTime: 1700000000100, fromJid: 'cust-123456@x', msgtype: 0 }] } });
    return jsonResponse({ ResponseStatus: OK_STATUS, members: [] });
  });
  const sdk = new FakePageSdk();
  const displays: AdapterDisplayPayload[] = [];
  const session = createPageSession({ ...base, sdk }, { account: { account_id: 'synthetic', environment: 'production', session_generation: 1 }, selfUid: 'me', beginMsgTime: 1700000000000, initialEpoch: 1, sdk, pushDisplay: async p => { displays.push(p); return null; } });
  const last = () => displays.flatMap(d => d.kind === 'conversations' ? d.items : []).at(-1);
  session.start();
  try {
    await base.clock.advance(50);
    sdk.emit('message', { id: 'recall', type: 'groupchat', msgtype: '1009', create_time: '1700000001000', from: '123456@conf.x/me', to: 'me@x', body: JSON.stringify({ title: '消息撤回', recallMessageId: 'old' }) });
    const preview = last()?.preview;
    assert.ok(preview);
    assert.equal(last()?.last_message_time_ms, 1700000001000);
    assert.equal((await session.rpc.handle({ req_id: 'history', op: 'im.messages', args: { gid: '123456' } }))?.ok, true);
    assert.equal(last()?.preview, preview, 'reading old history must not overwrite the newer recall preview');
    assert.equal(last()?.last_message_time_ms, 1700000001000, 'conversation order must not regress');
  } finally { session.stop(); }
});
