import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OK_STATUS, jsonResponse } from './testing.ts';
import { GID, MSG_ID, makeCtx } from './featureTesting.ts';
import { createFeatureDispatcher } from './features.ts';
import { RECALL_WINDOW_MS, isWireId, recallBody, recallFeature, recallMessage, recallVerdict, recallWithWindow } from './recall.ts';

const okBody = { ResponseStatus: OK_STATUS, status: { code: 0, msg: 'ok' } };

test('recall body is exactly {head, messageId, partnerId} with both ids as 19-digit STRINGS', async () => {
  const ctx = makeCtx(() => jsonResponse(okBody));
  const result = await recallMessage(ctx.deps, ctx.soa, { messageId: MSG_ID, partnerId: GID });
  assert.deepEqual(result, { outcome: 'recalled' });
  const call = ctx.fakeDeps.fakeFetch.calls[0]!;
  assert.match(call.url, /^https:\/\/m\.ctrip\.com\/restapi\/soa2\/11679\/recallMessage\?/);
  const body = call.bodyJson as Record<string, unknown>;
  assert.deepEqual(Object.keys(body), ['head', 'messageId', 'partnerId']);
  assert.equal(typeof body['messageId'], 'string');
  assert.equal(typeof body['partnerId'], 'string');
  // the raw text keeps the digits intact (a JSON number would round them)
  assert.ok((call.init.body as string).includes(`"messageId":"${MSG_ID}"`));
  assert.deepEqual(Object.keys(recallBody(ctx.deps, { messageId: MSG_ID, partnerId: GID })), ['head', 'messageId', 'partnerId']);
});

test('wire ids: only 19-digit strings', () => {
  assert.equal(isWireId(MSG_ID), true);
  for (const bad of ['', '123', '12345678901234567890', '98765432109876543a', 9876543210987654321, null, undefined]) assert.equal(isWireId(bad), false);
});

test('invalid ids are refused without any request', async () => {
  const ctx = makeCtx(() => jsonResponse(okBody));
  assert.deepEqual(await recallMessage(ctx.deps, ctx.soa, { messageId: 'abc', partnerId: GID }), { outcome: 'refused', reason: 'invalid_id' });
  assert.deepEqual(await recallMessage(ctx.deps, ctx.soa, { messageId: MSG_ID, partnerId: '1' }), { outcome: 'refused', reason: 'invalid_id' });
  assert.equal(ctx.fakeDeps.fakeFetch.calls.length, 0);
});

test('2-minute window is judged on server time; an unanchored clock refuses', () => {
  assert.equal(RECALL_WINDOW_MS, 120_000);
  assert.deepEqual(recallVerdict(1000, 1000 + 119_999), { kind: 'allowed', remainingMs: 1 });
  assert.deepEqual(recallVerdict(1000, 1000 + 120_000), { kind: 'allowed', remainingMs: 0 });
  assert.deepEqual(recallVerdict(1000, 1000 + 120_001), { kind: 'expired' });
  assert.deepEqual(recallVerdict(1000, null), { kind: 'clock_unknown' });
  assert.deepEqual(recallVerdict(100_000, 94_999), { kind: 'future_timestamp' });
  assert.equal(recallVerdict(100_000, 95_000).kind, 'allowed');
});

test('recallWithWindow: refuses expired / unanchored / unknown conversation before any request, emits fact on success', async () => {
  const ctx = makeCtx(() => jsonResponse(okBody));
  const now = ctx.fakeDeps.now();
  ctx.serverNow = now;
  assert.deepEqual(await recallWithWindow(ctx, GID, MSG_ID, now - 120_001), { outcome: 'refused', reason: 'expired' });
  ctx.serverNow = null;
  assert.deepEqual(await recallWithWindow(ctx, GID, MSG_ID, now - 1000), { outcome: 'refused', reason: 'clock_unknown' });
  ctx.serverNow = now;
  assert.deepEqual(await recallWithWindow(ctx, '999', MSG_ID, now - 1000), { outcome: 'refused', reason: 'invalid_id' });
  ctx.views.delete(GID);
  assert.deepEqual(await recallWithWindow(ctx, GID, MSG_ID, now - 1000), { outcome: 'refused', reason: 'unknown_conversation' });
  assert.equal(ctx.fakeDeps.fakeFetch.calls.length, 0);
  assert.equal(ctx.facts.length, 0);
  ctx.views.set(GID, { gid: GID, conversationKey: null, sessionId: null, worksheetId: null, serviceType: '1', threadId: '', conversationType: null, customerUid: null, orderId: null, lastMessage: null });
  assert.deepEqual(await recallWithWindow(ctx, GID, MSG_ID, now - 1000), { outcome: 'recalled' });
  assert.deepEqual(ctx.facts, [{ kind: 'recalled', gid: GID, message_id: MSG_ID }]);
});

test('server rejection, ack-less status and unknown write outcome are reported, never replayed', async () => {
  let n = 0;
  const ctx = makeCtx((_, i) => {
    n = i;
    if (i === 0) return jsonResponse({ ResponseStatus: OK_STATUS, status: { code: 4012, msg: 'too late' } });
    if (i === 1) return jsonResponse({ ResponseStatus: OK_STATUS });
    if (i === 2) return 'hang';
    return jsonResponse({}, 500);
  });
  assert.deepEqual(await recallMessage(ctx.deps, ctx.soa, { messageId: MSG_ID, partnerId: GID }), { outcome: 'rejected', code: 4012, message: 'too late' });
  assert.deepEqual(await recallMessage(ctx.deps, ctx.soa, { messageId: MSG_ID, partnerId: GID }), { outcome: 'unknown' });
  const pending = recallMessage(ctx.deps, ctx.soa, { messageId: MSG_ID, partnerId: GID });
  await ctx.fakeDeps.clock.advance(1000);
  assert.deepEqual(await pending, { outcome: 'unknown' });
  assert.deepEqual(await recallMessage(ctx.deps, ctx.soa, { messageId: MSG_ID, partnerId: GID }), { outcome: 'unknown' });
  assert.equal(n, 3);
  assert.equal(ctx.fakeDeps.fakeFetch.calls.length, 4, 'exactly one request per call');
});

test('recall.message op validates arguments and goes through the dispatcher', async () => {
  const ctx = makeCtx(() => jsonResponse(okBody));
  const d = createFeatureDispatcher([recallFeature]);
  assert.equal(d.has('recall.message'), true);
  const now = ctx.fakeDeps.now();
  assert.deepEqual(await d.call('recall.message', { gid: GID, message_id: MSG_ID, created_ms: now - 5000 }, ctx), { outcome: 'recalled' });
  await assert.rejects(d.call('recall.message', { gid: GID, message_id: MSG_ID }, ctx), /created_ms/);
  await assert.rejects(d.call('recall.message', { gid: GID, message_id: MSG_ID, created_ms: -1 }, ctx), /created_ms/);
  await assert.rejects(d.call('recall.message', 'x', ctx), /object/);
});
