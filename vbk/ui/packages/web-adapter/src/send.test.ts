import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SoaClient } from './soa.ts';
import { createMediaSendIntent, createSendIntent, mediaMessageJson, sendProductCard, submitIntent } from './send.ts';
import { OK_STATUS, jsonResponse, makeDeps } from './testing.ts';

const conv = { serviceType: '1513', threadId: '' };

test('send intent: body fields exactly as documented, biztype from the conversation, threadid as-is', () => {
  const deps = makeDeps();
  const a = createSendIntent(deps, 'g1', 'hello "<&>"\nline', conv);
  assert.deepEqual(a.body, { chattype: 'groupchat', biztype: '1513', localid: a.localId, msg: 'hello "<&>"\nline', msgtype: '0', autoextend: 0, threadid: '' });
  assert.deepEqual(Object.keys(a.body), ['chattype', 'biztype', 'localid', 'msg', 'msgtype', 'autoextend', 'threadid']);
  assert.equal(a.citemsgid, undefined);
  deps.randomQueue.push(...new Array<number>(16).fill(0.1));
  const b = createSendIntent(deps, 'g1', 'x', { serviceType: '2384', threadId: 't-1' }, { citemsgid: 'cite-1' });
  assert.equal(b.body.biztype, '2384');
  assert.equal(b.body.threadid, 't-1');
  assert.equal(b.citemsgid, 'cite-1');
  assert.equal('citemsgid' in b.body, false);
  assert.notEqual(a.localId, b.localId);
  assert.match(a.localId, /^\d{13}-[0-9a-f]{16}$/);
});

test('submit: confirmed on matching send_result with error 0', async () => {
  const deps = makeDeps();
  const intent = createSendIntent(deps, 'g1', 'hi', conv);
  const p = submitIntent(deps, deps.fakeSdk, intent);
  assert.equal(deps.fakeSdk.sent.length, 1);
  assert.deepEqual(deps.fakeSdk.sent[0], { gid: 'g1', body: intent.body });
  deps.fakeSdk.emit('send_result', { error: 0, reason: '', localid: 'someone-else', tid: 'nope', create_time: '1700000000999' });
  deps.fakeSdk.emit('send_result', { error: 0, reason: '', localid: intent.localId, tid: 'srv-9', create_time: '1700000000999', ts: '1700000000999', threadid: '', present: false });
  const r = await p;
  assert.deepEqual(r.disposition, { kind: 'confirmed', server_message_id: 'srv-9', server_time_ms: 1700000000999 });
  assert.equal(r.fact.message_id, 'srv-9');
  assert.equal(r.fact.local_id, intent.localId);
  assert.equal(r.fact.sender_role, 'merchant_self');
  assert.equal(r.fact.source, 'realtime');
  assert.equal(deps.fakeSdk.listenerCount('send_result'), 0);
  assert.equal(deps.clock.pendingCount(), 0);
});

test('submit: rejected on non-zero error; unknown on timeout with NO resend', async () => {
  const deps = makeDeps();
  const intent = createSendIntent(deps, 'g1', 'hi', conv);
  const p = submitIntent(deps, deps.fakeSdk, intent);
  deps.fakeSdk.emit('send_result', { error: -2, reason: '{{reason}}', localid: intent.localId });
  const r = await p;
  assert.deepEqual(r.disposition, { kind: 'rejected', code: '-2', reason: '{{reason}}' });

  const intent2 = createSendIntent(deps, 'g1', 'hi again', conv);
  const p2 = submitIntent(deps, deps.fakeSdk, intent2, 5000);
  await deps.clock.advance(5000);
  const r2 = await p2;
  assert.deepEqual(r2.disposition, { kind: 'unknown' });
  assert.equal(r2.fact.disposition?.kind, 'unknown');
  assert.equal(r2.fact.message_id, null);
  assert.equal(deps.fakeSdk.sent.length, 2); // one frame per intent, never resent
  assert.equal(deps.fakeFetch.calls.length, 0); // no adapter-level HTTP fallback
  // a late ack after `unknown` does not resend or throw
  deps.fakeSdk.emit('send_result', { error: 0, localid: intent2.localId, tid: 'late' });
  assert.equal(deps.fakeSdk.sent.length, 2);
});

test('submit: quote passes citemsgid as an SDK option', async () => {
  const deps = makeDeps();
  const intent = createSendIntent(deps, 'g1', 'q', conv, { citemsgid: 'cite-7' });
  const p = submitIntent(deps, deps.fakeSdk, intent);
  assert.equal(deps.fakeSdk.sent[0]?.citemsgid, 'cite-7');
  deps.fakeSdk.emit('send_result', { error: 0, localid: intent.localId, tid: 't', create_time: '1700000000001' });
  await p;
});

test('media intents: inner JSON stays a string, serialized once', () => {
  const deps = makeDeps();
  const img = createMediaSendIntent(deps, 'g1', { kind: 'image', url: 'https://x/u.png', thumbUrl: 'https://x/t.png', width: 98, height: 34, scene: '{{scene}}', channel: 'im_business' }, conv);
  assert.equal(img.body.msgtype, '1');
  assert.equal(typeof img.body.msg, 'string');
  assert.deepEqual(JSON.parse(img.body.msg), { thumbUrl: 'https://x/t.png', url: 'https://x/u.png', height: 34, width: 98, btype: 1, originImageSize: -1, originImageUrl: '', ext: { channel: 'im_business', scene: '{{scene}}' } });
  const vid = createMediaSendIntent(deps, 'g1', { kind: 'video', filename: 'f.mp4', cover: 'https://x/c.jpg', url: 'https://x/v.mp4', duration: 0.8, size: 1696, width: 0, height: 0 }, conv);
  assert.equal(vid.body.msgtype, '3');
  assert.deepEqual(JSON.parse(vid.body.msg), { btype: 3, video: { filename: 'f.mp4', cover: 'https://x/c.jpg', url: 'https://x/v.mp4', duration: 0.8, size: 1696, width: 0, height: 0 } });
  const file = mediaMessageJson({ kind: 'file', filename: 'a.pdf', url: 'https://x/a.pdf', size: 1479 });
  assert.deepEqual(JSON.parse(file), { btype: 5, file: { filename: 'a.pdf', url: 'https://x/a.pdf', size: 1479 } });
  assert.equal(createMediaSendIntent(deps, 'g1', { kind: 'file', filename: 'a.pdf', url: 'u', size: 1 }, conv).body.msgtype, '5');
});

test('product card: HTTP write, confirmed only with data.localId/msgId, unknown on timeout', async () => {
  const deps = makeDeps(() => jsonResponse({ ResponseStatus: OK_STATUS, data: { localId: 'l', threadId: null, msgId: 'm' } }));
  const soa = new SoaClient(deps, { defaultTimeoutMs: 1000 });
  const req = { bizType: 1513, templateId: '{{tpl}}', groupIdentity: '{{gi}}', uid: '{{customer}}', card: { productName: '{{name}}', jumpUrl: 'https://x?recommend=1' } };
  const r = await sendProductCard(deps, soa, req);
  assert.deepEqual(r, { kind: 'confirmed', localId: 'l', msgId: 'm' });
  const body = deps.fakeFetch.calls[0]?.bodyJson as Record<string, unknown>;
  assert.equal(deps.fakeFetch.calls[0]?.url.startsWith('https://online.ctrip.com/restapi/soa2/15529/sendCardMessageForOffline'), true);
  assert.equal(body['inSession'], true);
  assert.equal(body['senderRole'], 'Advisor');
  assert.equal(body['platformId'], 0);
  assert.equal(body['contentType'], 'json');
  assert.equal(typeof body['extendJson'], 'string');
  assert.deepEqual(JSON.parse(body['extendJson'] as string), req.card);

  deps.fakeFetch.set(() => 'hang');
  const p = sendProductCard(deps, soa, req);
  await deps.clock.advance(1000);
  assert.deepEqual(await p, { kind: 'unknown' });
  assert.equal(deps.fakeFetch.calls.length, 2);

  deps.fakeFetch.set(() => jsonResponse({ ResponseStatus: OK_STATUS, data: {} }));
  assert.equal((await sendProductCard(deps, soa, req)).kind, 'rejected');
});
