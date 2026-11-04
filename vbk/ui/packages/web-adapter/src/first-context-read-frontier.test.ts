import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AdapterDisplayPayload } from '../../ipc/src/adapterProtocol.ts';
import { SoaClient } from './soa.ts';
import { createPageSession } from './session.ts';
import { createVisibleRead } from '../../../apps/main/visible-read.ts';
import { historyScopeKey, messageHistoryKey } from '../../../apps/main/viewmodel.ts';
import { FakePageSdk, OK_STATUS, flush, jsonResponse, makeDeps, sampleRow } from './testing.ts';

const GID = '123456', LOW = 1700000000100, HIGH = 1700000009900;
const oldHistory = { msgId: 'A-old-high', messageBody: 'synthetic stale history', fromJid: 'A@im.x', toJid: `${GID}@conf.x`, createTime: HIGH, msgtype: 0 };
const currentRow = sampleRow(GID, { uid: 'B', sessionId: 'B-session', lastMessageTime: LOW,
  lastMessageJsonString: JSON.stringify({ msgId: 'B-current-low', messageBody: 'synthetic current', fromJid: 'B@im.x', toJid: `${GID}@conf.x`, createTime: LOW, msgtype: 0 }) });

test('first service context: real history/session/visible read cannot promote older service high-time message', async () => {
  const base = makeDeps(call => {
    if (call.url.includes('getConversationList')) return jsonResponse({ ResponseStatus: OK_STATUS, conversationList: [currentRow], haveRest: false });
    if (call.url.includes('getConversationInfoByGidList')) return jsonResponse({ ResponseStatus: OK_STATUS, bizResponseStatus: { resultCode: 'SUCCESS' }, conversationInfoList: [{ gid: GID, unreadCount: 3 }] });
    if (call.url.includes('getMessageList')) return jsonResponse({ ResponseStatus: OK_STATUS, rangeMessage: { isDone: true, messages: [JSON.parse(String(currentRow.lastMessageJsonString)), oldHistory] } });
    return jsonResponse({ ResponseStatus: OK_STATUS, members: [] });
  });
  const sdk = new FakePageSdk(), displays: AdapterDisplayPayload[] = [];
  const account = { account_id: 'synthetic-first-B', environment: 'test', session_generation: 1 };
  const session = createPageSession({ ...base, sdk }, { account, selfUid: 'me', beginMsgTime: 1700000000000, initialEpoch: 1, sdk,
    pushDisplay: async payload => { displays.push(payload); return null; }, unreadDebounceMs: 10 });
  session.start();
  try {
    await base.clock.advance(50);
    const conversation = () => displays.flatMap(d => d.kind === 'conversations' ? d.items : []).filter(c => c.gid === GID).at(-1)!;
    const revision = conversation().assistant_context_revision;
    assert.ok(revision);
    const history = await session.rpc.handle({ req_id: 'first-B-history', op: 'im.messages', args: { gid: GID } });
    assert.equal(history?.ok, true);
    const messages = displays.flatMap(d => d.kind === 'messages' ? d.items : []).filter(m => m.gid === GID);
    assert.ok(messages.some(m => m.message_id === 'A-old-high'), 'old history arrived through real history RPC');
    assert.equal(session.store.latestMessage(GID)?.msgId, 'B-current-low', 'first epoch history cannot replace authoritative row frontier');
    assert.equal(conversation().read_target_message_id, 'B-current-low');
    assert.equal(conversation().assistant_context_revision, revision);
    const state = { account, conversation: { ...conversation(), account, draft: '', is_top: false, waiting_since_ms: null, waiting_confirmed: true }, messages, firstPage: 'loaded', readContextRevision: revision, view: 'messages', blocked: false };
    const rows = messages.map(m => ({ isConnected: true, dataset: { historyKey: messageHistoryKey(account, state.conversation, m) }, getBoundingClientRect: () => ({ top: 10, bottom: 30, left: 0, right: 100, width: 100, height: 20 }) }));
    const pane = { isConnected: true, dataset: { historyScope: historyScopeKey(account, GID), readContextRevision: revision }, querySelectorAll: () => rows,
      getBoundingClientRect: () => ({ top: 0, bottom: 200, left: 0, right: 200, width: 200, height: 200 }) };
    const attempts: Promise<unknown>[] = [];
    const controller = createVisibleRead({ current: () => state, pane: () => pane as unknown as HTMLElement, visible: () => true,
      invoke: args => { assert.equal(args.expected_message_id, 'B-current-low'); const p = session.rpc.handle({ req_id: 'visible-B', op: 'im.mark_read', args }).then(reply => { assert.equal(reply?.ok, true, 'mounted B receipt passes the real RPC fence'); return reply; }); attempts.push(p); return p; } });
    controller.afterRender(); await Promise.all(attempts); await flush();
    assert.equal(attempts.length, 1);
    assert.deepEqual(sdk.readReceipts.map(r => r.msgId), ['B-current-low']);
    assert.equal(conversation().unread_count, 0, 'only the mounted current B message is consumed after its confirmed receipt');
  } finally { session.stop(); }
});

test('first service context: real SDK, compensation and unread refresh preserve authoritative frontier', async () => {
  let initialList = true, compensate = false, unread = 3;
  const base = makeDeps(call => {
    if (call.url.includes('getConversationList')) {
      const rows = initialList ? [currentRow] : []; initialList = false;
      return jsonResponse({ ResponseStatus: OK_STATUS, conversationList: rows, haveRest: false });
    }
    if (call.url.includes('getConversationInfoByGidList')) return jsonResponse({ ResponseStatus: OK_STATUS, bizResponseStatus: { resultCode: 'SUCCESS' }, conversationInfoList: [{ gid: GID, unreadCount: unread }] });
    if (call.url.includes('getRecentMessages')) return jsonResponse({ ResponseStatus: OK_STATUS, lastMessageTimestamp: HIGH + 2000, messages: compensate ? [{ ...oldHistory, msgId: 'A-compensation-high', fromJid: `${GID}@conf.x/A`, toJid: 'me@im.x' }] : [] });
    return jsonResponse({ ResponseStatus: OK_STATUS, members: [] });
  });
  const sdk = new FakePageSdk(), displays: AdapterDisplayPayload[] = [];
  const session = createPageSession({ ...base, sdk }, { account: { account_id: 'first-B-streams', environment: 'test', session_generation: 1 }, selfUid: 'me', beginMsgTime: 1700000000000, initialEpoch: 1, sdk,
    pushDisplay: async payload => { displays.push(payload); return null; }, unreadDebounceMs: 10 });
  session.start();
  try {
    await base.clock.advance(50);
    sdk.emit('message', { id: 'A-sdk-high', type: 'groupchat', msgtype: '0', create_time: String(HIGH + 1000), from: `${GID}@conf.x/A`, to: 'me@im.x', body: 'synthetic delayed A SDK' });
    await flush();
    assert.ok(displays.some(d => d.kind === 'messages' && d.items.some(m => m.message_id === 'A-sdk-high')), 'real SDK event reached session projection');
    assert.equal(session.store.latestMessage(GID)?.msgId, 'B-current-low', 'SDK must not promote an unbound first-epoch target');
    compensate = true;
    await base.clock.advance(10100);
    assert.ok(displays.some(d => d.kind === 'messages' && d.items.some(m => m.message_id === 'A-compensation-high')), 'real compensation poll reached session projection');
    assert.equal(session.store.latestMessage(GID)?.msgId, 'B-current-low', 'compensation must not promote an unbound target');
    unread = 7;
    await session.unread.refresh({ ...base, sdk }, new SoaClient(base), [GID]);
    assert.equal(session.unread.unreadOf(GID), 7);
    assert.equal(session.store.latestMessage(GID)?.msgId, 'B-current-low', 'unread refresh is not read-target evidence');
    assert.equal(sdk.readReceipts.length, 0);
  } finally { session.stop(); }
});
