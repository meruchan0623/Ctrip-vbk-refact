import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFeatureRuntime } from './runtime.ts';
import { QUEUE_DROP_OUT_COMMAND, QUEUE_MAX_POLLS, QUEUE_POLL_MAX_MS, QUEUE_POLL_MS, QUEUE_STATUS_COMMAND, QueueTracker, createQueueBanner, queueDelay, type QueueReply } from './queue-banner.ts';
import { ACCOUNT, GID, makeHost, settle } from './testing.ts';

test('delay: 3 s, doubling on failures, capped at 30 s', () => {
  assert.equal(queueDelay(0), QUEUE_POLL_MS);
  assert.equal(queueDelay(1), 6000);
  assert.equal(queueDelay(2), 12_000);
  assert.equal(queueDelay(3), 24_000);
  assert.equal(queueDelay(4), QUEUE_POLL_MAX_MS);
  assert.equal(queueDelay(99), QUEUE_POLL_MAX_MS);
});

test('tracker: ok keeps the cadence and stores the server text; auth/unsupported stop for good; failures back off', () => {
  const t = new QueueTracker();
  const e = t.start(ACCOUNT, GID);
  assert.equal(t.start(ACCOUNT, GID), e, 'one entry per account+conversation');
  assert.equal(t.settle(e, { kind: 'ok', resultCode: 'UNKNOWN', resultMessage: 'waiting' }), 3000);
  assert.equal(e.detail, 'waiting');
  assert.equal(t.settle(e, null), 6000);
  assert.equal(t.settle(e, { kind: 'failed', reason: 'network' }), 12_000);
  assert.equal(t.settle(e, { kind: 'ok', resultCode: null, resultMessage: null }), 3000, 'recovery resets the backoff');
  assert.equal(t.settle(e, { kind: 'failed', reason: 'auth' }), null);
  assert.equal(e.stopped, true);
  const u = t.start({ ...ACCOUNT, session_generation: 2 }, GID);
  assert.equal(t.settle(u, { kind: 'unsupported', reason: 'x' }), null);
});

test('tracker: stops after the poll budget and when dismissed', () => {
  const t = new QueueTracker();
  const e = t.start(ACCOUNT, GID);
  const ok: QueueReply = { kind: 'ok', resultCode: null, resultMessage: null };
  let last: number | null = 0;
  for (let i = 0; i < QUEUE_MAX_POLLS; i++) last = t.settle(e, ok);
  assert.equal(last, null);
  assert.equal(e.stopped, true);
  const d = t.start(ACCOUNT, '555');
  t.dismiss(d);
  assert.equal(t.settle(d, ok), null);
});

function setup(reply: QueueReply | Error) {
  const host = makeHost();
  host.invokeReply = () => (reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply));
  const rt = createFeatureRuntime([createQueueBanner()], host);
  rt.start();
  return { host, rt };
}

const notice = { kind: 'queue_notice' as const, account: ACCOUNT, gid: GID };

test('nothing is polled until a queue notice arrives (no global loop)', async () => {
  const { host } = setup({ kind: 'ok', resultCode: null, resultMessage: null });
  host.changed();
  await host.advance(60_000);
  assert.equal(host.invokes.length, 0);
  assert.equal(host.timers.length, 0);
});

test('a notice starts a 3 s cadence for the open conversation only', async () => {
  const { host, rt } = setup({ kind: 'ok', resultCode: 'UNKNOWN', resultMessage: 'wait' });
  rt.onFact(notice);
  await host.advance(0);
  assert.equal(host.invokes.length, 1);
  assert.equal(host.invokes[0]!.command, QUEUE_STATUS_COMMAND);
  assert.deepEqual(host.invokes[0]!.payload, { gid: GID, account: ACCOUNT });
  await host.advance(QUEUE_POLL_MS);
  assert.equal(host.invokes.length, 2);
  // the user opens another conversation: polling stops, no request for the old one
  host.active = { account: ACCOUNT, gid: '555' };
  host.changed();
  await host.advance(60_000);
  assert.equal(host.invokes.length, 2);
  assert.equal(host.timers.length, 0);
  // coming back resumes
  host.active = { account: ACCOUNT, gid: GID };
  host.changed();
  await host.advance(0);
  assert.equal(host.invokes.length, 3);
});

test('hidden window: wake-ups send no request', async () => {
  const { host, rt } = setup({ kind: 'ok', resultCode: null, resultMessage: null });
  host.isVisible = false;
  rt.onFact(notice);
  await host.advance(30_000);
  assert.equal(host.invokes.length, 0);
  host.isVisible = true;
  await host.advance(QUEUE_POLL_MS);
  assert.ok(host.invokes.length >= 1);
});

test('unsupported / auth failure ends polling; IPC errors back off instead of hammering', async () => {
  const a = setup({ kind: 'unsupported', reason: 'no_customer_uid' });
  a.rt.onFact(notice);
  await a.host.advance(120_000);
  assert.equal(a.host.invokes.length, 1);

  const b = setup(new Error('ipc'));
  b.rt.onFact(notice);
  await b.host.advance(0);
  await b.host.advance(QUEUE_POLL_MS);
  assert.equal(b.host.invokes.length, 1, 'second attempt waits for the 6 s backoff');
  await b.host.advance(QUEUE_POLL_MS);
  assert.equal(b.host.invokes.length, 2);
});

test('only the declared commands are reachable; the drop-out command is declared but never called by the banner', async () => {
  const { host, rt } = setup({ kind: 'ok', resultCode: null, resultMessage: null });
  rt.onFact(notice);
  await host.advance(30_000);
  assert.ok(host.invokes.every((c) => c.command === QUEUE_STATUS_COMMAND));
  assert.ok(!host.invokes.some((c) => c.command === QUEUE_DROP_OUT_COMMAND));
});

test('a notice for a non-current account is ignored', async () => {
  const { host, rt } = setup({ kind: 'ok', resultCode: null, resultMessage: null });
  rt.onFact({ ...notice, account: { ...ACCOUNT, session_generation: 7 } });
  await host.advance(30_000);
  assert.equal(host.invokes.length, 0);
});

test('stop() clears the timer', async () => {
  const { host, rt } = setup({ kind: 'ok', resultCode: null, resultMessage: null });
  rt.onFact(notice);
  await settle();
  rt.stop();
  assert.equal(host.timers.length, 0);
  await host.advance(30_000);
  const n = host.invokes.length;
  await host.advance(30_000);
  assert.equal(host.invokes.length, n);
});
