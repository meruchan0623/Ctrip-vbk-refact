import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AdapterDisplayPayload } from '../../ipc/src/adapterProtocol.ts';
import { ConversationStore, compareMessageId } from './stores.ts';
import { createPageSession } from './session.ts';
import { FakePageSdk, OK_STATUS, flush, jsonResponse, makeDeps, sampleRow } from './testing.ts';

/**
 * 红点消失的权威链路：服务端 unreadCount → 本地 UnreadBook → 界面；清零只能由
 * 对“当前已读边界（read target）”的 SDK 回执触发。已读边界必须跟上客户的最新
 * 消息，否则客服回复后（列表行的最后一条是本方消息）边界永远停在旧消息上，
 * 回执发不出去，红点点了也不会消失。
 */

const gid = '123456';
const msg = (msgId: string, createTime: number, fromJid = `cust-${gid}@im.x`, room = gid, extra: Record<string, unknown> = {}) =>
  ({ msgId, createTime, fromJid, toJid: `${room}@conf.x`, msgtype: 0, messageBody: 'synthetic', ...extra });
const sdkPeer = (id: string, create_time: number, sender = `cust-${gid}`, room = gid) =>
  ({ type: 'groupchat' as const, id, from: `${room}@conf.x/${sender}`, to: 'me@im.x', msgtype: 0, create_time, body: 'synthetic live' });

interface World { row: Record<string, unknown>; unread: number; detail: Record<string, unknown>; recent: Record<string, unknown>[]; holdRecent: ((rows: Record<string, unknown>[]) => void) | null; hangRecent: boolean }
function world(initial: Record<string, unknown>): World {
  return { row: initial, unread: 1, detail: initial, recent: [], holdRecent: null, hangRecent: false };
}
function script(w: World) {
  return (call: { url: string }) => {
    if (call.url.includes('getRecentMessages') && w.hangRecent) {
      // Hold this compensation response until the test releases it (a request straddling a service switch).
      w.hangRecent = false;
      return new Promise<ReturnType<typeof jsonResponse>>(resolve => { w.holdRecent = rows => resolve(jsonResponse({ ResponseStatus: OK_STATUS, lastMessageTimestamp: 1700000009000, messages: rows })); });
    }
    return jsonResponse(call.url.includes('getConversationList')
    ? { ResponseStatus: OK_STATUS, conversationList: [sampleRow(gid, { ...(w.row['sessionId'] ? { sessionId: w.row['sessionId'] } : {}), ...(w.row['threadId'] ? { threadId: w.row['threadId'] } : {}), lastMessageTime: w.row['createTime'], lastUpdateTime: w.row['createTime'], lastMessageJsonString: JSON.stringify(w.row) })], haveRest: false }
    : call.url.includes('getConversationInfoByGidList')
      ? { ResponseStatus: OK_STATUS, bizResponseStatus: { resultCode: 'SUCCESS' }, conversationInfoList: [{ gid, unreadCount: w.unread, message: w.detail }] }
      : call.url.includes('getMessageList')
        ? { ResponseStatus: OK_STATUS, rangeMessage: { isDone: true, messages: [w.row] } }
        : call.url.includes('getRecentMessages')
          ? { ResponseStatus: OK_STATUS, lastMessageTimestamp: 1700000009000, messages: w.recent }
          : { ResponseStatus: OK_STATUS, members: [], messages: [], lastMessageTimestamp: 1700000000000 });
  };
}
const settle = async (): Promise<void> => { for (let i = 0; i < 25; i++) await flush(); };

function boot(w: World, id: string) {
  const base = makeDeps(script(w)), sdk = new FakePageSdk(), displays: AdapterDisplayPayload[] = [];
  const session = createPageSession({ ...base, sdk }, { sdk, selfUid: 'me', account: { account_id: id, environment: 'production', session_generation: 1 }, initialEpoch: 1, beginMsgTime: 1700000000000, pushDisplay: async p => { displays.push(p); }, unreadDebounceMs: 10 });
  const last = () => displays.flatMap(p => p.kind === 'conversations' ? p.items : []).filter(c => c.gid === gid).at(-1);
  const revision = () => session.store.assistantContextRevision(gid, 'me', sdk.partnerJidOf(gid))!;
  return { base, sdk, displays, session, last, revision };
}

test('a live customer message newer than the row snapshot advances the read frontier; the badge clears after the agent replies', async () => {
  const peer300 = msg('peer300', 1700000000300), w = world(peer300);
  const { base, sdk, session, last, revision } = boot(w, 'live-frontier');
  session.start();
  try {
    await base.clock.advance(1000); await settle();
    assert.equal(last()?.read_target_message_id, 'peer300');
    // Realtime customer message before the 5 s list poll observes it.
    sdk.emit('message', sdkPeer('peer900', 1700000000900));
    await settle();
    assert.equal(session.store.readTarget(gid)?.msgId, 'peer900', 'verified live frame moves the frontier past the row snapshot');
    assert.equal(last()?.read_target_message_id, 'peer900', 'projection republishes the new frontier');
    // The agent replies first; the next list poll shows our own message as the row's last message.
    sdk.emit('message', { ...sdkPeer('self950', 1700000000950, 'me'), from: `${gid}@conf.x/me` });
    w.row = msg('self950', 1700000000950, 'me@im.x'); w.detail = w.row;
    await base.clock.advance(6000); await settle();
    assert.equal(session.store.latestMessage(gid)?.msgId, 'self950');
    assert.equal(session.store.readTarget(gid)?.msgId, 'peer900', 'own reply never moves the frontier back');
    assert.equal(last()?.read_target_message_id, 'peer900');
    assert.equal(last()?.unread_count, 1);
    const stale = await session.rpc.handle({ req_id: 'stale', op: 'im.mark_read', args: { gid, expected_message_id: 'peer300', expected_context_revision: revision() } });
    assert.equal(stale?.ok, false, 'the superseded frontier is refused');
    const receipt = await session.rpc.handle({ req_id: 'read', op: 'im.mark_read', args: { gid, expected_message_id: 'peer900', expected_context_revision: revision() } });
    assert.equal(receipt?.ok, true, JSON.stringify(receipt));
    await settle();
    assert.deepEqual(sdk.readReceipts.map(r => r.msgId), ['peer900']);
    assert.equal(last()?.unread_count, 0, 'confirmed receipt for the live frontier clears the badge');
    // Server detail lagging behind the receipt (still 1, last message = our reply) must not resurrect the badge.
    await base.clock.advance(6000); await settle();
    assert.equal(last()?.unread_count, 0, 'lagging server count behind the consumed snapshot stays suppressed');
    w.unread = 0;
    await base.clock.advance(6000); await settle();
    assert.equal(last()?.unread_count, 0);
    // A genuinely new customer message restores the badge and moves the frontier again.
    sdk.emit('message', sdkPeer('peer2000', 1700000002000));
    w.row = msg('peer2000', 1700000002000); w.detail = w.row; w.unread = 1;
    await base.clock.advance(6000); await settle();
    assert.equal(last()?.unread_count, 1);
    assert.equal(last()?.read_target_message_id, 'peer2000');
  } finally { session.stop(); }
});

test('a compensation customer message (socket down) advances the read frontier the same way', async () => {
  const peer300 = msg('peer300', 1700000000300), w = world(peer300);
  const { base, sdk, session, last, revision } = boot(w, 'compensation-frontier');
  sdk.socketConnected = false;
  session.start();
  try {
    await base.clock.advance(1000); await settle();
    w.recent = [{ ...msg('peer900', 1700000000900), fromJid: `${gid}@conf.x/cust-${gid}`, toJid: 'me@im.x' }];
    await base.clock.advance(10100); await settle();
    assert.equal(session.store.readTarget(gid)?.msgId, 'peer900', 'verified compensation row moves the frontier');
    w.recent = [];
    w.row = msg('self950', 1700000000950, 'me@im.x'); w.detail = w.row;
    await base.clock.advance(6000); await settle();
    assert.equal(last()?.read_target_message_id, 'peer900');
    const receipt = await session.rpc.handle({ req_id: 'read', op: 'im.mark_read', args: { gid, expected_message_id: 'peer900', expected_context_revision: revision() } });
    assert.equal(receipt?.ok, true, JSON.stringify(receipt));
    await settle();
    assert.equal(last()?.unread_count, 0);
  } finally { session.stop(); }
});

test('live frames from another customer, another room or a stale thread never advance the frontier', async () => {
  const peer300 = msg('peer300', 1700000000300), w = world(peer300);
  const { base, sdk, session } = boot(w, 'live-guards');
  session.start();
  try {
    await base.clock.advance(1000); await settle();
    sdk.emit('message', sdkPeer('other-customer', 1700000000900, 'someone-else'));
    sdk.emit('message', sdkPeer('other-room', 1700000000950, `cust-${gid}`, '654321'));
    sdk.emit('message', { ...sdkPeer('system', 1700000000960), msgtype: 1007, body: JSON.stringify({ title: 'notice', isPresent: true }) });
    await settle();
    assert.equal(session.store.readTarget(gid)?.msgId, 'peer300');
  } finally { session.stop(); }
});

test('a service switch on the same gid drops a frontier that a live frame established', async () => {
  const peer300 = msg('peer300', 1700000000300), w = world(peer300);
  const { base, sdk, session } = boot(w, 'live-switch');
  session.start();
  try {
    await base.clock.advance(1000); await settle();
    sdk.emit('message', sdkPeer('peer900', 1700000000900));
    await settle();
    assert.equal(session.store.readTarget(gid)?.msgId, 'peer900');
    const store = session.store;
    store.update([sampleRow(gid, { sessionId: 'new-service', lastUpdateTime: 1700000001000, lastMessageTime: 1700000001000, lastMessageJsonString: JSON.stringify(msg('new-self', 1700000001000, 'me@im.x')) })]);
    assert.equal(store.readTarget(gid), null, 'context change discards the live frontier');
    // Below the observed fence a late frame of the old service cannot re-establish it.
    store.noteLiveMessage(gid, msg('late-old', 1700000000990));
    assert.equal(store.readTarget(gid), null);
    store.noteLiveMessage(gid, msg('fresh', 1700000001100));
    assert.equal(store.readTarget(gid)?.msgId, 'fresh');
  } finally { session.stop(); }
});

test('store: a live peer row past the snapshot moves the frontier; history stays bounded by the snapshot', () => {
  const store = new ConversationStore();
  store.update([sampleRow(gid, { lastMessageJsonString: JSON.stringify(msg('own', 1700000000500, 'me@im.x')) })]);
  store.noteReadHistory(gid, [msg('history-newer', 1700000000600)]);
  assert.equal(store.readTarget(gid), null, 'history cannot cross the row snapshot');
  store.noteLiveMessage(gid, msg('live-newer', 1700000000600));
  assert.equal(store.readTarget(gid)?.msgId, 'live-newer');
  store.noteLiveMessage(gid, msg('live-older', 1700000000400));
  assert.equal(store.readTarget(gid)?.msgId, 'live-newer', 'an older live frame does not move the frontier back');
  store.noteLiveMessage(gid, msg('own-live', 1700000000700, 'me@im.x'));
  assert.equal(store.readTarget(gid)?.msgId, 'live-newer', 'own rows are never a read target');
});

// ---- adversarial review counterexamples (2026-11-04, rounds 1 and 2)

const peerRow = (id: string, time: number, extra: Record<string, unknown> = {}) => ({ ...msg(id, time), fromJid: `${gid}@conf.x/cust-${gid}`, toJid: 'me@im.x', ...extra });
const rowOf = (row: Record<string, unknown>) => sampleRow(gid, { sessionId: row['sessionId'] ?? `sess-${gid}`, threadId: row['threadId'] ?? '', lastMessageTime: row['createTime'], lastUpdateTime: row['createTime'], lastMessageJsonString: JSON.stringify(row) });

test('review r1-1/r2-3: a compensation response issued before A->B->A cannot establish a frontier after it, whatever its time', async () => {
  const peerA = msg('peerA300', 1700000000300), w = world(peerA);
  const { base, sdk, session, revision } = boot(w, 'aba-straddle');
  sdk.socketConnected = false;
  session.start();
  try {
    await base.clock.advance(1000); await settle();
    w.hangRecent = true;
    await base.clock.advance(10100); await settle();
    assert.ok(w.holdRecent, 'a compensation request is in flight');
    session.store.update([rowOf({ ...msg('selfB1000', 1700000001000, 'me@im.x'), sessionId: 'B' })]);
    session.store.update([rowOf(peerA)]);
    assert.equal(session.store.messageContext(gid), 3);
    assert.equal(session.store.readTarget(gid)?.msgId, 'peerA300');
    // The first-A response is released only now, carrying a never-observed message above every snapshot.
    w.holdRecent!([peerRow('oldA1500', 1700000001500)]); w.holdRecent = null;
    await settle();
    assert.equal(session.store.readTarget(gid)?.msgId, 'peerA300', 'a frame from an earlier request context is display only');
    const stale = await session.rpc.handle({ req_id: 'stale', op: 'im.mark_read', args: { gid, expected_message_id: 'oldA1500', expected_context_revision: revision() } });
    assert.equal(stale?.ok, false);
    assert.deepEqual(sdk.readReceipts, []);
    // A request issued in the current context still advances the frontier.
    w.recent = [peerRow('fresh1600', 1700000001600)];
    await base.clock.advance(10100); await settle();
    assert.equal(session.store.readTarget(gid)?.msgId, 'fresh1600');
  } finally { session.stop(); }
});

test('review r2-4: a service whose snapshot is older than a previous service still accepts its own live frames', async () => {
  const peerA = msg('peerA1500', 1700000001500), w = world(peerA);
  const { base, sdk, session, last, revision } = boot(w, 'older-service');
  session.start();
  try {
    await base.clock.advance(1000); await settle();
    w.row = { ...msg('selfB300', 1700000000300, 'me@im.x'), sessionId: 'B', threadId: 'thread-B' }; w.detail = w.row;
    await base.clock.advance(6000); await settle();
    assert.equal(session.store.messageContext(gid), 2);
    assert.equal(session.store.readTarget(gid), null);
    sdk.emit('message', { ...sdkPeer('peerB900', 1700000000900), threadid: 'thread-B' });
    await settle();
    assert.equal(session.store.readTarget(gid)?.msgId, 'peerB900', 'B frames above B\'s own fence are admitted regardless of A\'s times');
    w.row = { ...msg('selfB950', 1700000000950, 'me@im.x'), sessionId: 'B', threadId: 'thread-B' }; w.detail = w.row;
    await base.clock.advance(6000); await settle();
    assert.equal(last()?.read_target_message_id, 'peerB900');
    const receipt = await session.rpc.handle({ req_id: 'read', op: 'im.mark_read', args: { gid, expected_message_id: 'peerB900', expected_context_revision: revision() } });
    assert.equal(receipt?.ok, true, JSON.stringify(receipt)); await settle();
    assert.equal(last()?.unread_count, 0);
  } finally { session.stop(); }
});

test('review r1-2/r2-5: a receipt confirmed before the own reply is observed (or while it arrives in flight) does not rebound', async () => {
  for (const inFlight of [false, true]) {
    const peer300 = msg('peer300', 1700000000300), w = world(peer300);
    const { base, sdk, session, last, revision } = boot(w, `early-receipt-${inFlight}`);
    session.start();
    try {
      await base.clock.advance(1000); await settle();
      sdk.emit('message', sdkPeer('peer900', 1700000000900));
      const ownReply = () => sdk.emit('message', { ...sdkPeer('own950', 1700000000950, 'me'), from: `${gid}@conf.x/me` });
      if (inFlight) sdk.putAdviceOfReadByMsgId = async req => { sdk.readReceipts.push(req); ownReply(); await flush(); return { kind: 'success', raw: {} }; };
      else ownReply();
      await settle();
      assert.equal(last()?.read_target_message_id, 'peer900');
      const receipt = await session.rpc.handle({ req_id: 'read', op: 'im.mark_read', args: { gid, expected_message_id: 'peer900', expected_context_revision: revision() } });
      assert.equal(receipt?.ok, true, JSON.stringify(receipt));
      w.detail = msg('own950', 1700000000950, 'me@im.x');
      await base.clock.advance(400); await settle();
      assert.equal(last()?.unread_count, 0, `lagging count behind our own reply stays suppressed (inFlight=${inFlight})`);
      w.row = w.detail;
      await base.clock.advance(6000); await settle();
      assert.equal(last()?.unread_count, 0, 'the list catching up does not resurrect the badge');
      sdk.emit('message', { ...sdkPeer('colleague980', 1700000000980, 'colleague'), from: `${gid}@conf.x/colleague` });
      w.detail = msg('colleague980', 1700000000980, 'colleague@im.x');
      await base.clock.advance(6000); await settle();
      assert.equal(last()?.unread_count, 0, 'a colleague reply is not customer evidence');
      sdk.emit('message', sdkPeer('peer2000', 1700000002000));
      w.detail = msg('peer2000', 1700000002000); w.row = w.detail; w.unread = 1;
      await base.clock.advance(6000); await settle();
      assert.equal(last()?.unread_count, 1, 'a newer customer message restores the badge');
      assert.equal(last()?.read_target_message_id, 'peer2000');
    } finally { session.stop(); }
  }
});

test('review r2-2: a colleague reply cannot hide an unseen customer message beyond the grace window', async () => {
  const peer300 = msg('peer300', 1700000000300), w = world(peer300);
  const { base, sdk, session, last, revision } = boot(w, 'hidden-peer');
  session.start();
  try {
    await base.clock.advance(1000); await settle();
    const receipt = await session.rpc.handle({ req_id: 'read', op: 'im.mark_read', args: { gid, expected_message_id: 'peer300', expected_context_revision: revision() } });
    assert.equal(receipt?.ok, true); await settle();
    assert.equal(last()?.unread_count, 0);
    // Customer 900 is never delivered to this client; only the colleague reply shows up everywhere.
    sdk.emit('message', { ...sdkPeer('colleague950', 1700000000950, 'colleague'), from: `${gid}@conf.x/colleague` });
    w.row = msg('colleague950', 1700000000950, 'colleague@im.x'); w.detail = w.row; w.unread = 1;
    await base.clock.advance(6000); await settle();
    assert.equal(last()?.unread_count, 0, 'inside the grace window the lagging count is still suppressed');
    await base.clock.advance(31_000); await settle();
    assert.equal(last()?.unread_count, 1, 'after the window the server count is the truth again');
  } finally { session.stop(); }
});

test('review r2-2b: a customer message delivered late by compensation is shown as soon as it moves the frontier', async () => {
  const peer300 = msg('peer300', 1700000000300), w = world(peer300);
  const { base, sdk, session, last, revision } = boot(w, 'late-customer');
  session.start();
  try {
    await base.clock.advance(1000); await settle();
    const receipt = await session.rpc.handle({ req_id: 'read', op: 'im.mark_read', args: { gid, expected_message_id: 'peer300', expected_context_revision: revision() } });
    assert.equal(receipt?.ok, true); await settle();
    sdk.emit('message', { ...sdkPeer('own950', 1700000000950, 'me'), from: `${gid}@conf.x/me` });
    w.recent = [peerRow('peer920', 1700000000920)];
    w.detail = msg('own950', 1700000000950, 'me@im.x'); w.row = w.detail; w.unread = 1;
    await base.clock.advance(10100); await settle();
    assert.equal(session.store.readTarget(gid)?.msgId, 'peer920');
    assert.equal(last()?.unread_count, 1, 'a real unread behind the own reply is shown');
  } finally { session.stop(); }
});

test('review r1-3/r2-1: same-timestamp ids converge on the larger id from every source; the acked smaller id never hides the other', async () => {
  const peer300 = msg('peer300', 1700000000300), w = world(peer300);
  const { base, sdk, session, last, revision } = boot(w, 'same-ts');
  session.start();
  try {
    await base.clock.advance(1000); await settle();
    const a = peerRow('100900', 1700000000900), b = peerRow('100901', 1700000000900);
    // Receipt for the smaller id first (it was the only one seen), then the larger one arrives.
    sdk.emit('message', { ...sdkPeer('100900', 1700000000900) });
    await settle();
    const receipt = await session.rpc.handle({ req_id: 'read', op: 'im.mark_read', args: { gid, expected_message_id: '100900', expected_context_revision: revision() } });
    assert.equal(receipt?.ok, true); await settle();
    assert.equal(last()?.unread_count, 0);
    sdk.emit('message', { ...sdkPeer('100901', 1700000000900) });
    w.row = msg('100901', 1700000000900); w.detail = w.row; w.unread = 1;
    await base.clock.advance(6000); await settle();
    assert.equal(session.store.readTarget(gid)?.msgId, '100901', 'the larger id at the same timestamp becomes the frontier');
    assert.equal(last()?.unread_count, 1, 'the other message at the same timestamp is not consumed by the first receipt');
    const next = await session.rpc.handle({ req_id: 'read-b', op: 'im.mark_read', args: { gid, expected_message_id: '100901', expected_context_revision: revision() } });
    assert.equal(next?.ok, true, JSON.stringify(next));
    // Duplicate / reordered compensation frames at that timestamp do not flip it back.
    w.recent = [b, a];
    await base.clock.advance(10100); await settle();
    assert.equal(session.store.readTarget(gid)?.msgId, '100901');
    w.recent = [a];
    await base.clock.advance(10100); await settle();
    assert.equal(session.store.readTarget(gid)?.msgId, '100901');
    assert.deepEqual(sdk.readReceipts.map(r => r.msgId), ['100900', '100901']);
  } finally { session.stop(); }
});

test('review r1-3b: a receipt that was not admitted locally still re-reads the server count', async () => {
  const peer300 = msg('peer300', 1700000000300), w = world(peer300);
  const { base, sdk, session, last, revision } = boot(w, 'not-admitted');
  session.start();
  try {
    await base.clock.advance(1000); await settle();
    // Newer customer evidence arrives while the receipt is in flight: no local clear.
    sdk.putAdviceOfReadByMsgId = async req => { sdk.readReceipts.push(req); sdk.emit('message', sdkPeer('peer900', 1700000000900)); await flush(); return { kind: 'success', raw: {} }; };
    const receipt = await session.rpc.handle({ req_id: 'read', op: 'im.mark_read', args: { gid, expected_message_id: 'peer300', expected_context_revision: revision() } });
    assert.equal(receipt?.ok, true); await settle();
    assert.equal(last()?.unread_count, 1, 'not consumed locally');
    w.unread = 0;
    await base.clock.advance(400); await settle();
    assert.equal(last()?.unread_count, 0, 'the confirmed receipt scheduled a server re-read');
  } finally { session.stop(); }
});

// ---- round 3

test('round 3: compareMessageId is a total order on mixed decimal / non-decimal ids', () => {
  const ids = ['9', '10', '1a', '0010', 'b', '845831480998363136', '845831480780259328', ''];
  for (const a of ids) for (const b of ids) {
    assert.equal((Math.sign(compareMessageId(a, b)) || 0) + (Math.sign(compareMessageId(b, a)) || 0), 0, `${a} vs ${b} antisymmetric`);
    for (const c of ids) if (compareMessageId(a, b) <= 0 && compareMessageId(b, c) <= 0) assert.ok(compareMessageId(a, c) <= 0, `${a} <= ${b} <= ${c} transitive`);
  }
  assert.ok(compareMessageId('10', '9') > 0 && compareMessageId('845831480998363136', '845831480780259328') > 0 && compareMessageId('0010', '10') === 0);
  assert.ok(compareMessageId('9', '1a') < 0, 'decimal ids sort before non-decimal ids');
});

test('round 3: a compensation response issued before a gid was ever observed cannot seed that gid\'s frontier', async () => {
  const peerA = msg('peerA300', 1700000000300), w = world(peerA);
  const { base, sdk, session } = boot(w, 'unknown-gid');
  sdk.socketConnected = false;
  // The list is empty at first: the compensation request goes out before the gid exists.
  const emptyList = { on: true };
  const inner = script(w);
  base.fakeFetch.set(call => call.url.includes('getConversationList') && emptyList.on ? jsonResponse({ ResponseStatus: OK_STATUS, conversationList: [], haveRest: false }) : inner(call));
  session.start();
  try {
    await base.clock.advance(1000); await settle();
    assert.equal(session.store.has(gid), false);
    w.hangRecent = true;
    await base.clock.advance(10100); await settle();
    assert.ok(w.holdRecent);
    emptyList.on = false;
    w.row = { ...msg('selfB1000', 1700000001000, 'me@im.x'), sessionId: 'B' }; w.detail = w.row;
    await base.clock.advance(6000); await settle();
    assert.equal(session.store.messageContext(gid), 1);
    w.holdRecent!([peerRow('oldA900', 1700000000900)]); w.holdRecent = null;
    await settle();
    assert.equal(session.store.readTarget(gid), null, 'an unbound response cannot seed the first context');
    w.recent = [peerRow('fresh1200', 1700000001200)];
    await base.clock.advance(10100); await settle();
    assert.equal(session.store.readTarget(gid)?.msgId, 'fresh1200', 'a request issued after the gid was observed does');
  } finally { session.stop(); }
});

test('round 3: a lagging detail message from another room cannot move the row (and the receipt address)', async () => {
  const peer300 = msg('peer300', 1700000000300), w = world(peer300);
  const { base, sdk, session, revision } = boot(w, 'detail-room');
  session.start();
  try {
    await base.clock.advance(1000); await settle();
    w.detail = msg('otherRoom1000', 1700000001000, 'me@im.x', '654321');
    await base.clock.advance(6000); await settle();
    assert.equal(session.store.latestMessage(gid)?.msgId, 'peer300', 'the row keeps its own room\'s last message');
    assert.equal(sdk.partnerJidOf(gid), `${gid}@conf.x`);
    const receipt = await session.rpc.handle({ req_id: 'read', op: 'im.mark_read', args: { gid, expected_message_id: 'peer300', expected_context_revision: revision() } });
    assert.equal(receipt?.ok, true, JSON.stringify(receipt));
    assert.deepEqual(sdk.readReceipts.map(r => r.partnerJid), [`${gid}@conf.x`]);
  } finally { session.stop(); }
});
