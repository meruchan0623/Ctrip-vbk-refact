import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AdapterDisplayPayload } from '../../ipc/src/adapterProtocol.ts';
import type { UiMessage } from '../../ipc/src/client.ts';
import { createPageSession } from './session.ts';
import { stanzaToEvent } from './sdkGlue.ts';
import { FakePageSdk, OK_STATUS, jsonResponse, makeDeps, sampleRow, flush } from './testing.ts';
import { mergeHistory } from '../../../apps/main/viewmodel.ts';

const account = { account_id: 'synthetic-read-owner', environment: 'production', session_generation: 1 };
const time = 1700000000400;
const raw = (id = 'outbound', sender = 'me', read = false) => ({ msgId: id, fromJid: `g1@conf.x/${sender}`, toJid: 'me@x', createTime: time, msgtype: 0, messageBody: 'SYNTHETIC', isread: false, isTargetRead: read });
const deferred = <T>() => { let resolve!: (value: T) => void; return { promise: new Promise<T>(r => { resolve = r; }), resolve }; };
function fixture() {
  let rows = [raw(), raw('peer', 'cust-g1')], row = sampleRow('g1');
  let held: ReturnType<typeof deferred<ReturnType<typeof jsonResponse>>> | undefined;
  const displays: AdapterDisplayPayload[] = [];
  let historyRead: ((body: Record<string, unknown>) => ReturnType<typeof jsonResponse>) | undefined;
  const base = makeDeps(call => {
    if (call.url.includes('getConversationList')) return jsonResponse({ ResponseStatus: OK_STATUS, conversationList: [row], haveRest: false, lastUpdateTime: time });
    if (call.url.includes('getConversationInfoByGidList')) return jsonResponse({ ResponseStatus: OK_STATUS, bizResponseStatus: { resultCode: 'SUCCESS' }, conversationInfoList: [{ gid: 'g1', unreadCount: 1 }] });
    if (call.url.includes('getMessageList')) return held?.promise ?? historyRead?.(call.bodyJson as Record<string, unknown>) ?? jsonResponse({ ResponseStatus: OK_STATUS, rangeMessage: { messages: rows, isDone: true } });
    return jsonResponse({ ResponseStatus: OK_STATUS, members: [] });
  });
  const sdk = new FakePageSdk();
  const session = createPageSession({ ...base, sdk }, { account, selfUid: 'me', beginMsgTime: 1700000000000, initialEpoch: 1, sdk, unreadDebounceMs: 10, pushDisplay: async p => { displays.push(p); } });
  const historyCalls = () => base.fakeFetch.calls.filter(call => call.url.includes('getMessageList'));
  function emit(attrs: Record<string, string> = {}) {
    const event = stanzaToEvent({ name: 'message', attrs: { type: 'groupchat', msgtype: '1023', from: 'g1@conf.x/cust-g1', to: 'me@x', ...attrs }, getChildText: () => '{}' });
    assert.equal(event.kind, 'message'); if (event.kind === 'message') sdk.emit('message', event.event);
  }
  return { base, sdk, session, displays, historyCalls, emit,
    patches: () => displays.filter(p => p.kind === 'message_read_statuses'),
    setHistoryRead: (read: typeof historyRead) => { historyRead = read; },
    setRows: (value: typeof rows) => { rows = value; },
    hold: () => (held = deferred()), release: () => { held = undefined; },
    changeContext: (sessionId = 'new-service') => { row = sampleRow('g1', { sessionId }); session.store.update([row]); },
    async start() { session.start(); await base.clock.advance(50); const reply = await session.rpc.handle({ req_id: 'initial-history', op: 'im.message_page', args: { gid: 'g1' } }); assert.equal(reply?.ok, true); await flush(); },
  };
}

test('real stanza -> session -> exact read-status patch, without message replay or receipt writes', async () => {
  const f = fixture(); await f.start();
  try {
    const count = f.historyCalls().length, messages = f.displays.filter(p => p.kind === 'messages').length;
    f.setRows([raw('outbound', 'me', true), raw('not-loaded', 'me', true), raw('peer', 'cust-g1', true)]);
    f.emit(); await flush(); await flush();
    assert.equal(f.historyCalls().length, count + 1);
    assert.equal((f.historyCalls().at(-1)!.bodyJson as { showTargetIsRead: boolean }).showTargetIsRead, true);
    assert.deepEqual(f.patches().at(-1), { kind: 'message_read_statuses', gid: 'g1', items: [{ message_id: 'outbound', sender_id: 'me', read_status: 'read' }] });
    assert.equal(f.displays.filter(p => p.kind === 'messages').length, messages);
    assert.equal(f.sdk.readReceipts.length, 0); assert.equal(f.sdk.sent.length, 0);
  } finally { f.session.stop(); }
});

test('protocol acknowledgments, wrong rooms, and non-read controls cannot mark messages', async () => {
  const f = fixture(); await f.start();
  try {
    const count = f.historyCalls().length;
    f.emit({ msgtype: '1022' }); f.emit({ from: 'g1@other.x/customer' }); f.emit({ from: 'absent@conf.x/customer' });
    const ack = stanzaToEvent({ name: 'message', attrs: { type: 'notify_ack', msgtype: '1023', from: 'g1@conf.x/customer' }, getChildText: () => '{}' });
    assert.equal(ack.kind, 'ignore'); await flush();
    assert.equal(f.historyCalls().length, count); assert.equal(f.patches().length, 0);
  } finally { f.session.stop(); }
});

test('coalesced in-flight notifications read again; stopped and replaced-service reads cannot publish', async () => {
  for (const action of ['burst', 'stop', 'context', 'aba'] as const) {
    const f = fixture(); await f.start();
    try {
      const held = f.hold(), count = f.historyCalls().length;
      f.emit(); await flush();
      if (action === 'burst') { for (let n = 0; n < 10; n++) f.emit(); }
      else if (action === 'stop') f.session.stop();
      else { f.changeContext(); if (action === 'aba') f.changeContext('sess-g1'); }
      f.release(); held.resolve(jsonResponse({ ResponseStatus: OK_STATUS, rangeMessage: { messages: [raw('outbound', 'me', true)], isDone: true } }));
      await flush(); await flush();
      if (action === 'burst') assert.equal(f.historyCalls().length, count + 1, 'already read target needs no duplicate HTTP query');
      else assert.equal(f.patches().length, 0);
    } finally { f.session.stop(); }
  }
});

test('successful visible customer read receipt updates only its exact incoming message', async () => {
  const f = fixture(); await f.start();
  try {
    const conv = f.displays.flatMap(p => p.kind === 'conversations' ? p.items : []).at(-1)!;
    const id = conv.read_target_message_id!;
    // The authoritative row frontier is the sample row last message.
    f.sdk.emit('message', { type: 'groupchat', id, from: 'g1@conf.x/cust-g1', to: 'me@x', msgtype: 0, create_time: time, body: 'SYNTHETIC' });
    f.setRows([{ ...raw('peer', 'cust-g1'), isread: true }]);
    const reply = await f.session.rpc.handle({ req_id: 'mark-visible', op: 'im.mark_read', args: { gid: 'g1', expected_message_id: id, expected_context_revision: conv.assistant_context_revision! } });
    assert.equal(reply?.ok, true);
    assert.ok(f.patches().some(p => p.kind === 'message_read_statuses' && p.items.some(item => item.message_id === id && item.sender_id === 'cust-g1' && item.read_status === 'read')));
    await flush(); await flush();
    assert.ok(f.patches().some(p => p.kind === 'message_read_statuses' && p.items.some(item => item.message_id === 'peer' && item.read_status === 'read')));
    assert.equal(f.session.unread.unreadOf('g1'), 0, 'confirmed visible customer receipt clears its local unread badge');
  } finally { f.session.stop(); }
});

test('UI merges cannot downgrade read state or carry it into a different sender/server message', () => {
  const message: UiMessage = { gid: 'g1', message_id: 'outbound', local_id: 'local', sender_id: 'me', sender_role: 'merchant_self', kind: 'text', text: 'SYNTHETIC', create_time_ms: time, read_status: 'read', translation: null, original: null, quote: null, order_id: null, disposition: null };
  for (const read_status of [undefined, 'unknown', 'unread'] as const) assert.equal(mergeHistory([message], [read_status ? { ...message, read_status } : (({ read_status: omitted, ...row }) => row)(message)])[0]?.read_status, 'read');
  assert.equal(mergeHistory([message], [{ ...message, sender_id: 'other', read_status: 'unknown' }])[0]?.read_status, 'unknown');
  assert.equal(mergeHistory([message], [{ ...message, message_id: 'different', read_status: 'unread' }]).find(m => m.message_id === 'different')?.read_status, 'unread');
});


test('read notification refreshes isolated old history directly instead of scanning thousands of unloaded messages', async () => {
  const f = fixture(), oldTime = 1700000000001;
  const old = { ...raw('isolated-old'), createTime: oldTime };
  f.setRows([old, ...Array.from({ length: 600 }, (_, i) => raw(`newer-${i}`, 'me', true))]); await f.start();
  try {
    const before = f.historyCalls().length;
    f.setHistoryRead(body => {
      assert.equal(body.endTime, oldTime + 1, 'query begins at the loaded target window');
      return jsonResponse({ ResponseStatus: OK_STATUS, rangeMessage: { isDone: false, messages: [{ ...old, isTargetRead: true }] } });
    });
    f.emit(); await flush(); await flush();
    assert.equal(f.historyCalls().length, before + 1);
    assert.ok(f.patches().some(p => p.kind === 'message_read_statuses' && p.items.some(item => item.message_id === 'isolated-old' && item.read_status === 'read')));
  } finally { f.session.stop(); }
});


test('notification arriving during an unread response is retained and refreshes again', async () => {
  const f = fixture(); await f.start();
  try {
    const held = f.hold(), before = f.historyCalls().length;
    f.emit(); await flush(); f.emit();
    f.setRows([raw('outbound', 'me', true)]); f.release();
    held.resolve(jsonResponse({ ResponseStatus: OK_STATUS, rangeMessage: { isDone: true, messages: [raw()] } }));
    await flush(); await flush();
    assert.equal(f.historyCalls().length, before + 2);
    assert.ok(f.patches().some(p => p.kind === 'message_read_statuses' && p.items.some(item => item.read_status === 'read')));
  } finally { f.session.stop(); }
});

test('rejected customer read receipt never emits a read-status update', async () => {
  const f = fixture(); await f.start();
  try {
    const conv = f.displays.flatMap(p => p.kind === 'conversations' ? p.items : []).at(-1)!;
    f.sdk.emit('message', { type: 'groupchat', id: conv.read_target_message_id, from: 'g1@conf.x/cust-g1', to: 'me@x', msgtype: 0, create_time: time, body: 'SYNTHETIC' });
    f.sdk.readReceiptOutcome = { kind: 'failure', raw: null };
    const reply = await f.session.rpc.handle({ req_id: 'mark-rejected', op: 'im.mark_read', args: { gid: 'g1', expected_message_id: conv.read_target_message_id!, expected_context_revision: conv.assistant_context_revision! } });
    assert.equal(reply?.ok, false); assert.equal(f.patches().length, 0);
  } finally { f.session.stop(); }
});


test('repeated successful acknowledgments coalesce customer history refreshes into one per-room flight', async () => {
  const f = fixture(); await f.start();
  try {
    const conv = f.displays.flatMap(p => p.kind === 'conversations' ? p.items : []).at(-1)!;
    f.sdk.emit('message', { type: 'groupchat', id: conv.read_target_message_id, from: 'g1@conf.x/cust-g1', to: 'me@x', msgtype: 0, create_time: time, body: 'SYNTHETIC' });
    const before = f.historyCalls().length, held = f.hold();
    await Promise.all(Array.from({ length: 5 }, (_, i) => f.session.rpc.handle({ req_id: `mark-repeat-${i}`, op: 'im.mark_read', args: { gid: 'g1', expected_message_id: conv.read_target_message_id!, expected_context_revision: conv.assistant_context_revision! } })));
    await flush();
    assert.equal(f.historyCalls().length, before + 1, 'duplicate successful ACKs cannot launch concurrent scans');
    f.release(); held.resolve(jsonResponse({ ResponseStatus: OK_STATUS, rangeMessage: { isDone: true, messages: [{ ...raw('peer', 'cust-g1'), isread: true }] } }));
    await flush(); await flush();
    assert.equal(f.historyCalls().length, before + 1, 'already read targets need no follow-up HTTP query');
  } finally { f.session.stop(); }
});
