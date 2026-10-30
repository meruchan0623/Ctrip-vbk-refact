/**
 * Review: outbound send discipline (hunt item 8).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SdkSendResultEvent } from './deps.ts';
import { SoaClient } from './soa.ts';
import { createMediaSendIntent, createSendIntent, sendProductCard, submitIntent } from './send.ts';
import { FAILURE_STATUS, OK_STATUS, jsonResponse, makeDeps } from './testing.ts';

test('review/send: localid is stable and identical in body, SDK envelope and the resulting fact; prefix is the injected clock', async () => {
  const deps = makeDeps();
  const intent = createSendIntent(deps, 'g1', 'hi', { serviceType: '2384', threadId: '' });
  assert.equal(intent.body.localid, intent.localId);
  assert.equal(intent.localId.split('-')[0], String(deps.clock.now()));
  const p = submitIntent(deps, deps.fakeSdk, intent);
  assert.equal(deps.fakeSdk.sent[0]?.body.localid, intent.localId);
  assert.equal(deps.fakeSdk.sent[0]?.body, intent.body, 'the same body object is handed to the SDK (no re-serialization)');
  deps.fakeSdk.emit('send_result', { error: '0', localid: intent.localId, tid: 123, create_time: '1700000000' });
  const r = await p;
  assert.equal(r.fact.local_id, intent.localId);
  assert.deepEqual(r.disposition, { kind: 'confirmed', server_message_id: '123', server_time_ms: 1700000000000 });
});

test('review/send: biztype comes from the conversation, threadid passes through unchanged', () => {
  const deps = makeDeps();
  const a = createSendIntent(deps, 'g1', 'x', { serviceType: '2384', threadId: '' });
  const b = createSendIntent(deps, 'g1', 'x', { serviceType: '77', threadId: 'thr-9' });
  assert.equal(a.body.biztype, '2384');
  assert.equal(b.body.biztype, '77');
  assert.equal(a.body.threadid, '');
  assert.equal('threadid' in a.body, true);
  assert.notEqual(a.body.threadid, null);
  assert.equal(b.body.threadid, 'thr-9');
  assert.equal(a.body.msgtype, '0');
  assert.equal(a.body.autoextend, 0);
  assert.equal(a.body.chattype, 'groupchat');
});

test('review/send: media `msg` is a JSON string serialized exactly once; quote is never a body field', async () => {
  const deps = makeDeps();
  const conv = { serviceType: '1513', threadId: 't' };
  const img = createMediaSendIntent(deps, 'g1', { kind: 'image', url: 'https://x/u.png', thumbUrl: 'https://x/t.png', width: 1, height: 2, scene: 's', channel: 'im_business' }, conv);
  assert.equal(typeof img.body.msg, 'string');
  const once = JSON.parse(img.body.msg) as Record<string, unknown>;
  assert.equal(typeof once, 'object');
  assert.throws(() => JSON.parse(once as unknown as string), 'double-encoded JSON would parse twice');
  assert.equal(img.body.msg.startsWith('{"thumbUrl"'), true, 'inner JSON is not wrapped in another string');
  assert.equal(img.body.msg.includes('\\"'), false, 'no escaped quotes → not double-encoded');
  assert.deepEqual(Object.keys(img.body), ['chattype', 'biztype', 'localid', 'msg', 'msgtype', 'autoextend', 'threadid']);
  assert.equal(img.body.threadid, 't');
  const quoted = createSendIntent(deps, 'g1', 'q', conv, { citemsgid: 'cite-1' });
  assert.equal('citemsgid' in quoted.body, false);
  assert.equal(JSON.stringify(quoted.body).includes('cite-1'), false);
  const plain = createSendIntent(deps, 'g1', 'q', conv);
  const p = submitIntent(deps, deps.fakeSdk, plain, 1000);
  assert.equal('citemsgid' in (deps.fakeSdk.sent[0] as object), false, 'no citemsgid key at all without a quote');
  deps.fakeSdk.emit('send_result', { error: 0, localid: plain.localId, tid: 't' });
  await p;
});

test('review/send: a send_result with a mismatched or hostile localid never confirms; timeout → unknown; no resend, no HTTP fallback', async () => {
  const deps = makeDeps();
  deps.randomQueue.push(...new Array<number>(16).fill(0.7)); // hex 'b…' so a case-folded id is a different id
  const intent = createSendIntent(deps, 'g1', 'hi', { serviceType: '1513', threadId: '' });
  assert.match(intent.localId, /^\d{13}-b{16}$/);
  const p = submitIntent(deps, deps.fakeSdk, intent, 5000);
  const evil: unknown[] = [null, undefined, 'str', 7, [], {}, { localid: null }, { localid: intent.localId.toUpperCase(), error: 0 }, { localid: `${intent.localId} `, error: 0 }, { error: 0 }];
  for (const e of evil) deps.fakeSdk.emit('send_result', e as SdkSendResultEvent);
  assert.equal(deps.clock.pendingCount(), 1, 'still waiting for the real ack');
  await deps.clock.advance(4999);
  assert.equal(deps.clock.pendingCount(), 1);
  await deps.clock.advance(1);
  const r = await p;
  assert.deepEqual(r.disposition, { kind: 'unknown' });
  assert.equal(deps.fakeSdk.sent.length, 1);
  assert.equal(deps.fakeFetch.calls.length, 0, 'the adapter never issues SendMessage.json itself');
  assert.equal(deps.fakeSdk.listenerCount('send_result'), 0);
  deps.fakeSdk.emit('send_result', { error: 0, localid: intent.localId, tid: 'late' });
  await deps.clock.advance(60000);
  assert.equal(deps.fakeSdk.sent.length, 1);
  assert.equal(deps.fakeFetch.calls.length, 0);
});

test('review/send: a synchronous SDK throw is `unknown` (the frame may have left) and is never retried', async () => {
  const deps = makeDeps();
  let calls = 0;
  deps.fakeSdk.sendMessage = () => {
    calls++;
    throw new Error('sdk boom');
  };
  const intent = createSendIntent(deps, 'g1', 'hi', { serviceType: '1513', threadId: '' });
  const r = await submitIntent(deps, deps.fakeSdk, intent, 1000);
  assert.deepEqual(r.disposition, { kind: 'unknown' });
  assert.equal(calls, 1);
  assert.equal(deps.clock.pendingCount(), 0);
  assert.equal(deps.fakeSdk.listenerCount('send_result'), 0);
});

test('review/send: rejected acks keep code+reason; non-zero/garbage error codes are never confirmed', async () => {
  const deps = makeDeps();
  const cases: [unknown, string][] = [
    [-2, '-2'],
    ['-2', '-2'],
    [1, '1'],
    ['x', 'unknown_error'],
    [null, 'unknown_error'],
    [undefined, 'unknown_error'],
    [{}, 'unknown_error'],
    [true, 'unknown_error'],
  ];
  for (const [error, code] of cases) {
    const intent = createSendIntent(deps, 'g1', 'hi', { serviceType: '1513', threadId: '' });
    const p = submitIntent(deps, deps.fakeSdk, intent);
    deps.fakeSdk.emit('send_result', { error, reason: 'r', localid: intent.localId } as SdkSendResultEvent);
    const r = await p;
    assert.deepEqual(r.disposition, { kind: 'rejected', code, reason: 'r' }, String(error));
    assert.equal(r.fact.message_id, null);
  }
});

test('review/send: product card over HTTP — Ack Failure or missing ids is never confirmed; network error → unknown with one request', async () => {
  const req = { bizType: 1513, templateId: 't', groupIdentity: 'g', uid: 'u', card: { productName: 'n' } };
  const d1 = makeDeps(() => jsonResponse({ ResponseStatus: FAILURE_STATUS, data: { localId: 'l', msgId: 'm' } }));
  assert.equal((await sendProductCard(d1, new SoaClient(d1), req)).kind, 'rejected');
  const d2 = makeDeps(() => jsonResponse({ ResponseStatus: OK_STATUS, data: { localId: 'l' } }));
  assert.equal((await sendProductCard(d2, new SoaClient(d2), req)).kind, 'rejected');
  const d3 = makeDeps(() => jsonResponse({ ResponseStatus: OK_STATUS, data: null }));
  assert.equal((await sendProductCard(d3, new SoaClient(d3), req)).kind, 'rejected');
  const d4 = makeDeps(() => new Error('net'));
  assert.deepEqual(await sendProductCard(d4, new SoaClient(d4), req), { kind: 'unknown' });
  assert.equal(d4.fakeFetch.calls.length, 1);
});
