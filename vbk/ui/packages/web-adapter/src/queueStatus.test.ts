import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OK_STATUS, jsonResponse } from './testing.ts';
import { GID, makeCtx } from './featureTesting.ts';
import { createFeatureDispatcher } from './features.ts';
import { QUEUE_NOTICE_ACTION, isQueueNotice, queueFeature } from './queueStatus.ts';

test('only the exact NBZ11 action is the queue notice (NBZ112 and friends are other notices)', () => {
  assert.equal(QUEUE_NOTICE_ACTION, 'NBZ11');
  assert.equal(isQueueNotice(JSON.stringify({ action: 'NBZ11', title: 'x' })), true);
  assert.equal(isQueueNotice({ action: 'NBZ11' }), true);
  assert.equal(isQueueNotice(JSON.stringify({ action: 'NBZ112' })), false);
  assert.equal(isQueueNotice('not json'), false);
  assert.equal(isQueueNotice(null), false);
});

test('queue.status posts checkSessionStatus {gid, customerUid} once and reports the biz result', async () => {
  const ctx = makeCtx(() => jsonResponse({ ResponseStatus: OK_STATUS, bizResponseStatus: { resultCode: 'UNKNOWN', resultMessage: 'waiting' } }));
  const d = createFeatureDispatcher([queueFeature]);
  const r = await d.call('queue.status', { gid: GID }, ctx);
  assert.deepEqual(r, { kind: 'ok', resultCode: 'UNKNOWN', resultMessage: 'waiting' });
  const call = ctx.fakeDeps.fakeFetch.calls[0]!;
  assert.match(call.url, /\/16037\/checkSessionStatus\?/);
  const body = call.bodyJson as Record<string, unknown>;
  assert.deepEqual(Object.keys(body), ['head', 'gid', 'customerUid']);
  assert.equal(body['gid'], GID);
  assert.equal(body['customerUid'], 'cust-1', 'falls back to the cached row customer uid');
  await d.call('queue.status', { gid: GID, customer_uid: 'explicit' }, ctx);
  assert.equal((ctx.fakeDeps.fakeFetch.calls[1]!.bodyJson as Record<string, unknown>)['customerUid'], 'explicit');
  assert.equal(ctx.facts.length, 0, 'no fact is invented from an unmapped resultCode');
});

test('queue.status: unknown conversation / no uid send nothing; failures are classified', async () => {
  const ctx = makeCtx(() => jsonResponse({}, 503));
  const d = createFeatureDispatcher([queueFeature]);
  assert.deepEqual(await d.call('queue.status', { gid: '555' }, ctx), { kind: 'unsupported', reason: 'unknown_conversation' });
  ctx.views.set(GID, { ...ctx.views.get(GID)!, customerUid: null });
  assert.deepEqual(await d.call('queue.status', { gid: GID }, ctx), { kind: 'unsupported', reason: 'no_customer_uid' });
  assert.equal(ctx.fakeDeps.fakeFetch.calls.length, 0);
  const r = (await d.call('queue.status', { gid: GID, customer_uid: 'u' }, ctx)) as { kind: string };
  assert.equal(r.kind, 'failed');
  await assert.rejects(d.call('queue.status', { gid: 'x' }, ctx), /invalid gid/);
});

test('queue.drop_out is unsupported and sends nothing (dropOutManual endpoint was never captured)', async () => {
  const ctx = makeCtx(() => jsonResponse({ ResponseStatus: OK_STATUS }));
  const d = createFeatureDispatcher([queueFeature]);
  assert.deepEqual(await d.call('queue.drop_out', { gid: GID }, ctx), { kind: 'unsupported', reason: 'endpoint_not_captured' });
  assert.equal(ctx.fakeDeps.fakeFetch.calls.length, 0);
});
