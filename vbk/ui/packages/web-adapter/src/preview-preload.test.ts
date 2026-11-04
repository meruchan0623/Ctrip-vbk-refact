import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPageSession } from './session.ts';
import { FakePageSdk, OK_STATUS, flush, jsonResponse, makeDeps, sampleRow } from './testing.ts';
import type { AdapterDisplayPayload } from '../../ipc/src/adapterProtocol.ts';

function fixture(hold = false, selfOnly = false) {
  let release: (value: ReturnType<typeof jsonResponse>) => void = () => {};
  const displays: AdapterDisplayPayload[] = [];
  const gid = '123456';
  const base = makeDeps(call => call.url.includes('getConversationList')
    ? jsonResponse({ ResponseStatus: OK_STATUS, conversationList: [sampleRow(gid, { lastMessageJsonString: null, lastMessage: null })], haveRest: false })
    : call.url.includes('getMessageList') ? hold ? new Promise(resolve => { release = resolve; }) : jsonResponse(history(selfOnly))
    : jsonResponse({ ResponseStatus: OK_STATUS, members: [], messages: [], lastMessageTimestamp: 1700000000000 }));
  const sdk = new FakePageSdk();
  const session = createPageSession({ ...base, sdk }, { sdk, selfUid: 'me', account: { account_id: 'test', environment: 'production', session_generation: 1 }, initialEpoch: 1, beginMsgTime: 1700000000000, pushDisplay: async payload => { displays.push(payload); } });
  return { base, sdk, session, displays, release: (body = history()) => release(jsonResponse(body)) };
}
function history(selfOnly = false) { return { ResponseStatus: OK_STATUS, rangeMessage: { isDone: true, messages: [
  { msgId: 'self', msgtype: 0, fromJid: 'me@x', messageBody: '不客气', createTime: 1700000000100 },
  { msgId: 'system', msgtype: 1007, fromJid: 'system@x', messageBody: JSON.stringify({ title: '会话已结束', isPresent: true }), createTime: 1700000000200 },
  { msgId: 'hidden', msgtype: 1007, fromJid: 'system@x', messageBody: JSON.stringify({ title: 'private protocol', isPresent: false }), createTime: 1700000000300 },
].slice(0, selfOnly ? 1 : 3) } }; }
const settle = async () => { for (let i = 0; i < 20; i++) await flush(); };

test('list bootstrap preloads the newest visible preview without opening a thread or marking read', async () => {
  const f = fixture(); f.session.start();
  try {
    await f.base.clock.advance(100); await settle();
    const rows = f.displays.flatMap(p => p.kind === 'conversations' ? p.items : []);
    assert.equal(rows.at(-1)?.preview, '会话已结束');
    assert.equal(f.displays.some(p => p.kind === 'messages'), false);
    assert.equal(f.sdk.readReceipts.length, 0);
    assert.equal(f.base.fakeFetch.calls.filter(c => c.url.includes('getMessageList')).length, 1);
  } finally { f.session.stop(); }
});

test('a preload finishing after stop cannot publish a preview', async () => {
  const f = fixture(true); f.session.start();
  await f.base.clock.advance(100); await settle();
  f.session.stop(); const count = f.displays.length;
  f.release(); await settle();
  assert.equal(f.displays.length, count);
});

test('the latest self reply is preloaded before any conversation is opened', async () => {
  const f = fixture(false, true); f.session.start();
  try {
    await f.base.clock.advance(100); await settle();
    assert.equal(f.displays.flatMap(p => p.kind === 'conversations' ? p.items : []).at(-1)?.preview, '不客气');
    assert.equal(f.sdk.readReceipts.length, 0);
  } finally { f.session.stop(); }
});

test('preload cannot leak a preview into another service reusing the gid', async () => {
  const f = fixture(true); f.session.start();
  try {
    await f.base.clock.advance(100); await settle();
    f.session.store.update([sampleRow('123456', { sessionId: 'new-service', lastMessageJsonString: null, lastMessage: null })]);
    const count = f.displays.length;
    f.release(); await settle();
    assert.equal(f.displays.length, count);
  } finally { f.session.stop(); }
});

test('a held preload cannot overwrite a same-time newer SDK preview', async () => {
  const f = fixture(true); f.session.start();
  try {
    await f.base.clock.advance(100); await settle();
    f.sdk.emit('message', { type: 'groupchat', id: 'same-time-new', from: '123456@conf.x/cust-123456', to: 'me@x', msgtype: 0, create_time: 1700000000500, body: 'new SDK preview' });
    const body = history(true); body.rangeMessage.messages[0]!.createTime = 1700000000500; body.rangeMessage.messages[0]!.messageBody = 'old same-time preview';
    f.release(body); await settle();
    assert.equal(f.displays.flatMap(p => p.kind === 'conversations' ? p.items : []).at(-1)?.preview, 'new SDK preview');
  } finally { f.session.stop(); }
});
