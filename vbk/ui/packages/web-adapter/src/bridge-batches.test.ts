import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAdapter } from './index.ts';
import { createPageSession } from './session.ts';
import { createOfficialConversationFeed } from './pageContext.ts';
import { ImCommands } from '../../ipc/src/commands.ts';
import type { AdapterFactEnvelope } from '../../ipc/src/contracts.ts';
import { FakePageSdk, flush, jsonResponse, makeDeps, OK_STATUS, sampleRow } from './testing.ts';

const account = { account_id: 'batch-account', environment: 'production' as const, session_generation: 1 };
const rows = (size: number) => Array.from({ length: size }, (_, i) => ({ gid: `room-${i}`, status: 1, inGroup: 1, serviceType: '1513', conversationType: 'B2C', lastUpdateTime: 1700000001000 }));
async function until(condition: () => boolean, limit = 100_000) { for (let i = 0; i < limit; i++) { if (condition()) return; await Promise.resolve(); } assert.fail('bounded asynchronous progress did not reach its condition'); }

for (const size of [2000, 10_000]) {
  test(`real ${size}-row snapshot under a slow host stays bounded and sends its full sync last`, async () => {
    const base = makeDeps(call => jsonResponse(call.url.includes('getConversationList')
      ? { ResponseStatus: OK_STATUS, conversationList: rows(size), lastUpdateTime: 1700000001000 }
      : { ResponseStatus: OK_STATUS, messages: [], lastMessageTimestamp: 1700000000500 }));
    const sent: AdapterFactEnvelope[] = []; let release: (() => void) | undefined;
    const adapter = createAdapter({ ...base, invoke: (_command, payload) => { sent.push(payload as AdapterFactEnvelope); return new Promise(resolve => { release = () => resolve(null); }); } }, { account, initialBeginMsgTime: 1700000000000 });
    adapter.start();
    await until(() => adapter.bridge.diagnostics.waiting > 0);
    assert.equal(adapter.running, true); assert.ok(adapter.bridge.diagnostics.pending <= 1024);
    for (let i = 0; i < size + 20; i++) {
      const sync = sent.find(e => e.fact.kind === 'conversation_list_sync');
      if (sync) break;
      assert.ok(release); release!(); release = undefined;
      await until(() => release !== undefined);
      assert.ok(adapter.bridge.diagnostics.pending <= 1024);
      assert.ok(adapter.bridge.diagnostics.waiting <= 5);
    }
    const conversations = sent.filter(e => e.fact.kind === 'conversation');
    assert.equal(conversations.length, size);
    const syncIndex = sent.findIndex(e => e.fact.kind === 'conversation_list_sync');
    assert.ok(syncIndex > 0);
    assert.equal(sent.slice(0, syncIndex).filter(e => e.fact.kind === 'conversation').length, size);
    assert.equal(adapter.bridge.diagnostics.overflow_events, 0);
    assert.equal(adapter.conversationPollers[0]!.cursor, null, 'sync invocation alone cannot advance the cursor before its ACK');
    release?.(); release = undefined;
    await until(() => adapter.conversationPollers[0]!.cursor === 1700000001000);
    assert.equal(base.fakeSdk.sent.length, 0);
    (release as (() => void) | undefined)?.(); await flush(); adapter.stop();
  });
}

test('stop immediately wakes capacity waiters, drops the unsent suffix and never advances list or compensation watermarks', async () => {
  const base = makeDeps(call => jsonResponse(call.url.includes('getConversationList') ? { ResponseStatus: OK_STATUS, conversationList: rows(50), lastUpdateTime: 1700000001000 }
    : { ResponseStatus: OK_STATUS, messages: rows(50).map((row, i) => ({ msgId: `m${i}`, fromJid: `${row.gid}@conf/customer`, msgtype: 0, createTime: 1700000001000 })), lastMessageTimestamp: 1700000001000 }));
  const sent: AdapterFactEnvelope[] = []; let release!: () => void;
  const adapter = createAdapter({ ...base, invoke: (_command, payload) => { sent.push(payload as AdapterFactEnvelope); return new Promise(resolve => { release = () => resolve(null); }); } }, { account, initialBeginMsgTime: 1700000000000, bridgeCapacity: 8 });
  adapter.start(); await until(() => adapter.bridge.diagnostics.waiting >= 2);
  adapter.stop(); await flush();
  assert.equal(adapter.bridge.diagnostics.waiting, 0);
  assert.equal(adapter.bridge.diagnostics.queued, 0);
  assert.equal(adapter.compensation.cursor, 1700000000000);
  assert.equal(adapter.conversationPollers[0]!.cursor, null);
  const calls = base.fakeFetch.calls.length;
  release(); await base.clock.advance(60_000);
  assert.equal(sent.length, 1);
  assert.equal(sent.some(e => e.fact.kind === 'conversation_list_sync' || e.fact.kind === 'compensation_sync'), false);
  assert.equal(base.fakeFetch.calls.length, calls);
});

test('two list variants and compensation share atomic bounded admissions without overflowing on concurrent valid batches', async () => {
  const base = makeDeps(call => jsonResponse(call.url.includes('getConversationList') ? { ResponseStatus: OK_STATUS, conversationList: rows(100), lastUpdateTime: 1700000001000 }
    : { ResponseStatus: OK_STATUS, messages: rows(100).map((row, i) => ({ msgId: `m${i}`, fromJid: `${row.gid}@conf/customer`, msgtype: 0, createTime: 1700000001000 })), lastMessageTimestamp: 1700000001000 }));
  const sent: AdapterFactEnvelope[] = []; let release: (() => void) | undefined;
  const adapter = createAdapter({ ...base, invoke: (_command, payload) => { sent.push(payload as AdapterFactEnvelope); return new Promise(resolve => { release = () => resolve(null); }); } }, { account, initialBeginMsgTime: 1700000000000, bridgeCapacity: 8, conversationListVariants: ['plain', 'json'] });
  adapter.start(); await until(() => adapter.bridge.diagnostics.waiting === 2);
  for (let i = 0; i < 310; i++) {
    if (sent.filter(e => e.fact.kind === 'conversation_list_sync' || e.fact.kind === 'compensation_sync').length === 3) break;
    release!(); release = undefined; await until(() => release !== undefined);
    assert.ok(adapter.bridge.diagnostics.pending <= 8);
  }
  assert.equal(sent.filter(e => e.fact.kind === 'conversation').length, 200);
  assert.equal(sent.filter(e => e.fact.kind === 'message').length, 100);
  assert.equal(sent.filter(e => e.fact.kind === 'conversation_list_sync').length, 2);
  assert.equal(sent.filter(e => e.fact.kind === 'compensation_sync').length, 1);
  const conversationStream = sent.filter(e => e.stream === 'im.conversation');
  assert.deepEqual(conversationStream.flatMap((e, i) => e.fact.kind === 'conversation_list_sync' ? [i] : []), [100, 201], 'each variant owns one contiguous full batch and sync; the core snapshot set cannot interleave');
  assert.equal(adapter.bridge.diagnostics.overflow_events, 0);
  release?.(); await flush(); adapter.stop();
});

test('official feed increments received during a large full snapshot stay serialized and are not coalesced away', async () => {
  const base = makeDeps(call => jsonResponse(call.url.includes('getConversationList') ? { ResponseStatus: OK_STATUS, conversationList: [], lastUpdateTime: 1700000000100 } : { ResponseStatus: OK_STATUS, messages: [], lastMessageTimestamp: 1700000000000 }));
  const official = createOfficialConversationFeed(), sent: AdapterFactEnvelope[] = [];
  let slow = false, release: (() => void) | undefined;
  const adapter = createAdapter({ ...base, invoke: async (_command, payload) => { sent.push(payload as AdapterFactEnvelope); if (slow) await new Promise<void>(resolve => { release = resolve; }); return null; } }, { account, initialBeginMsgTime: 1700000000000, bridgeCapacity: 8, officialConversationFeed: official });
  adapter.start(); await until(() => adapter.conversationPollers[0]!.cursor === 1700000000100); await adapter.bridge.flush();
  slow = true;
  const url = 'https://m.ctrip.com/restapi/soa2/16037/getConversationList';
  for (const [index, full] of [true, false, false].entries()) {
    const token = official.noteRequest(url, full ? {} : { startTime: 1700000001000 + index - 1 }, base.now())!;
    official.noteResponse(token, 200, JSON.stringify({ ResponseStatus: OK_STATUS, conversationList: full ? rows(100) : [{ ...rows(1)[0], gid: `delta-${index}` }], lastUpdateTime: 1700000001000 + index }), base.now());
  }
  await until(() => adapter.bridge.diagnostics.waiting > 0);
  for (let i = 0; i < 120; i++) {
    if (adapter.conversationPollers[0]!.cursor === 1700000001002 && adapter.bridge.diagnostics.pending === 0) break;
    if (release) { const next = release; release = undefined; next(); }
    await flush();
  }
  assert.equal(adapter.running, true);
  assert.equal(adapter.conversationPollers[0]!.cursor, 1700000001002);
  const gids = sent.flatMap(e => e.fact.kind === 'conversation' ? [e.fact.fact.gid] : []);
  assert.ok(gids.includes('delta-1')); assert.ok(gids.includes('delta-2'));
  assert.equal(adapter.bridge.diagnostics.overflow_events, 0);
  adapter.stop();
});

test('a 125-message server batch with its first translation chunk held cannot issue a second chunk after queue fault', async () => {
  let recent = 0, releaseTranslation!: () => void, holdFacts = false, releaseFact!: () => void;
  const displays: unknown[] = [];
  const base = makeDeps(call => {
    if (call.url.includes('getConversationList')) return jsonResponse({ ResponseStatus: OK_STATUS, conversationList: [sampleRow('room')], currentStatus: 0, lastUpdateTime: base.now() });
    if (call.url.includes('checkMemberStatus')) return jsonResponse({ ResponseStatus: OK_STATUS, status: { code: 0 }, members: [{ uid: 'cust-room', roles: [0, 1, 1] }] });
    if (call.url.includes('getRemarkList')) return jsonResponse({ ResponseStatus: OK_STATUS, bizResponseStatus: { resultCode: 'SUCCESS' }, remarkList: [] });
    if (call.url.includes('batchTranslateByMsgIds')) return new Promise(resolve => { releaseTranslation = () => resolve(jsonResponse({ ResponseStatus: OK_STATUS, translateMessageList: [{ msgId: 'large-0', msgtype: 0, messageBody: 'late translation' }] })); });
    if (call.url.includes('getRecentMessages')) return jsonResponse({ ResponseStatus: OK_STATUS, messages: recent++ === 0 ? [] : Array.from({ length: 125 }, (_, i) => ({ msgId: `large-${i}`, msgtype: 0, messageBody: 'source', fromJid: 'room@conf.x/cust-room', createTime: base.now() })), lastMessageTimestamp: base.now() });
    return jsonResponse({ ResponseStatus: OK_STATUS });
  });
  const sdk = new FakePageSdk();
  const deps = { ...base, sdk, invoke: (command: string, payload: unknown) => {
    if (holdFacts && command === ImCommands.PUSH_FACT) { base.invoked.push({ cmd: command, payload }); return new Promise(resolve => { releaseFact = () => resolve(null); }); }
    return base.invoke(command, payload);
  } };
  const session = createPageSession(deps, { account, selfUid: 'self', initialEpoch: 1, beginMsgTime: base.now(), sdk, bridgeCapacity: 160, pushDisplay: async value => { displays.push(value); return null; } });
  session.start(); await base.clock.advance(0); await session.adapter.bridge.flush();
  await base.clock.advance(10_000);
  await until(() => session.adapter.compensation.cursor === 1700000010000 && !!releaseTranslation);
  await session.adapter.bridge.flush();
  assert.equal(base.fakeFetch.calls.filter(call => call.url.includes('batchTranslateByMsgIds')).length, 1);
  holdFacts = true;
  const message = (id: number) => ({ id: `pressure-${id}`, type: 'groupchat', msgtype: '0', body: '', from: 'room@conf.x/cust-room', create_time: base.now() });
  sdk.emit('message', message(1)); await flush();
  for (let i = 2; i <= 161; i++) sdk.emit('message', message(i));
  assert.equal(session.adapter.running, false);
  const output = displays.length, requests = base.fakeFetch.calls.length, facts = base.invoked.length;
  releaseTranslation(); releaseFact(); await flush(); await base.clock.advance(60_000);
  assert.equal(base.fakeFetch.calls.filter(call => call.url.includes('batchTranslateByMsgIds')).length, 1);
  assert.equal(base.fakeFetch.calls.length, requests);
  assert.equal(displays.length, output); assert.equal(base.invoked.length, facts);
});

test('official feed backlog has a finite bound and explicitly faults instead of discarding an intermediate delta', async () => {
  const base = makeDeps(call => jsonResponse(call.url.includes('getConversationList') ? { ResponseStatus: OK_STATUS, conversationList: [], lastUpdateTime: 1700000000100 } : { ResponseStatus: OK_STATUS, messages: [], lastMessageTimestamp: 1700000000000 }));
  const official = createOfficialConversationFeed(); let slow = false, faults = 0;
  const adapter = createAdapter({ ...base, invoke: async () => { if (slow) await new Promise(() => {}); return null; } }, { account, initialBeginMsgTime: 1700000000000, bridgeCapacity: 8, officialConversationFeed: official, onQueueFault: () => { faults++; } });
  adapter.start(); await until(() => adapter.conversationPollers[0]!.cursor === 1700000000100); await adapter.bridge.flush(); slow = true;
  const url = 'https://m.ctrip.com/restapi/soa2/16037/getConversationList';
  for (let i = 0; i < 34; i++) {
    const token = official.noteRequest(url, i === 0 ? {} : { startTime: 1700000001000 + i - 1 }, base.now())!;
    official.noteResponse(token, 200, JSON.stringify({ ResponseStatus: OK_STATUS, conversationList: i === 0 ? rows(100) : [{ ...rows(1)[0], gid: `delta-${i}` }], lastUpdateTime: 1700000001000 + i }), base.now());
  }
  await flush();
  assert.equal(adapter.running, false);
  assert.equal(faults, 1);
  assert.equal(adapter.bridge.diagnostics.overflow_events, 1);
  assert.equal(adapter.bridge.diagnostics.waiting, 0);
  assert.ok(adapter.conversationPollers[0]!.cursor === null || adapter.conversationPollers[0]!.cursor === 1700000000100, 'unfinished work cannot advance beyond the previously completed watermark');
});

test('a current-generation failed first message cannot send Sync or advance the next login compensation begin time', async () => {
  const initial = 1700000000000, next = initial + 1000;
  for (const reply of ['reject', 'resync'] as const) {
    const requests: number[] = [], delivered: AdapterFactEnvelope[] = [], faults: string[] = [];
    const base = makeDeps(call => {
      if (call.url.includes('getConversationList')) return jsonResponse({ ResponseStatus: OK_STATUS, conversationList: [], lastUpdateTime: next });
      requests.push((JSON.parse(call.init?.body as string) as { beginMsgTime: number }).beginMsgTime);
      return jsonResponse({ ResponseStatus: OK_STATUS, messages: [{ msgId: 'm', fromJid: 'room@conf/customer', msgtype: 0, createTime: next }], lastMessageTimestamp: next });
    });
    const adapter = createAdapter({ ...base, invoke: async (_command, payload) => {
      const envelope = payload as AdapterFactEnvelope; delivered.push(envelope);
      if (envelope.fact.kind === 'message') {
        if (reply === 'reject') throw new Error('synthetic host rejection');
        return { applied: false, dropped: 'Gap', needs_resync: 'im.message', auth_invalid: false };
      }
      return null;
    } }, { account, initialBeginMsgTime: initial, onQueueFault: (_diagnostics, error) => faults.push(error.code) });
    adapter.start(); await until(() => !adapter.running);
    assert.deepEqual(faults, ['bridge.delivery_failed']);
    assert.equal(delivered.some(e => e.fact.kind === 'compensation_sync'), false);
    assert.equal(adapter.compensation.cursor, initial);
    await base.clock.advance(60_000); assert.equal(requests.length, 1);
    const resumed = createAdapter(base, { account: { ...account, session_generation: 2 }, initialBeginMsgTime: adapter.compensation.cursor });
    resumed.start(); await base.clock.advance(0); await resumed.bridge.flush();
    assert.deepEqual(requests, [initial, initial]); resumed.stop();
  }
});
