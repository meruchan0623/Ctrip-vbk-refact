import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markRead, selectReadTarget, type ReadCandidate } from './markRead.ts';
import { FakeSdk } from './testing.ts';

const msg = (msgId: string | null, createTimeMs: number, extra: Partial<ReadCandidate> = {}): ReadCandidate => ({ msgId, createTimeMs, fromSelf: false, ...extra });

test('target: the last counterpart message, not one per message and not own/system rows', () => {
  const rows = [msg('c1', 100), msg('c2', 200), msg('own', 300, { fromSelf: true }), msg('sys', 400, { system: true }), msg('c3', 250)];
  assert.equal(selectReadTarget(rows), 'c3');
  assert.equal(selectReadTarget([...rows].reverse()), 'c3', 'independent of input order');
  assert.equal(selectReadTarget([msg('own', 1, { fromSelf: true })]), null);
  assert.equal(selectReadTarget([]), null);
});

test('target: nothing to send when the newest counterpart message is already read; id-less rows are skipped', () => {
  assert.equal(selectReadTarget([msg('c1', 100), msg('c2', 200, { read: true })]), null);
  assert.equal(selectReadTarget([msg('c1', 100, { read: true }), msg('c2', 200)]), 'c2');
  assert.equal(selectReadTarget([msg('c1', 100), msg(null, 200), msg('', 300), msg('c4', Number.NaN)]), 'c1');
});

test('dedup: the same (partner, msgId) is sent once, even when asked repeatedly or concurrently', async () => {
  const sdk = new FakeSdk();
  const a = markRead(sdk, { partnerJid: 'room-1', msgId: 'm1' });
  const b = markRead(sdk, { partnerJid: 'room-1', msgId: 'm1' });
  assert.deepEqual(await a, { kind: 'acked' });
  assert.deepEqual(await b, { kind: 'acked', deduped: true });
  assert.deepEqual(await markRead(sdk, { partnerJid: 'room-1', msgId: 'm1' }), { kind: 'acked', deduped: true });
  assert.equal(sdk.readReceipts.length, 1, 'the official client repeats the receipt twice per opening; the adapter must not');
  assert.deepEqual(sdk.readReceipts[0], { partnerJid: 'room-1', msgId: 'm1', conversationType: 'groupchat' });
});

test('dedup is per conversation and per message: other room, same id, or a newer id still go out', async () => {
  const sdk = new FakeSdk();
  await markRead(sdk, { partnerJid: 'room-1', msgId: 'm1' });
  await markRead(sdk, { partnerJid: 'room-2', msgId: 'm1' });
  await markRead(sdk, { partnerJid: 'room-1', msgId: 'm2' });
  assert.equal(sdk.readReceipts.length, 3);
  const other = new FakeSdk();
  await markRead(other, { partnerJid: 'room-1', msgId: 'm1' });
  assert.equal(other.readReceipts.length, 1, 'a different SDK handle (another account/page) has its own ledger');
});

test('a definite rejection may be retried; an uncertain outcome is never repeated blindly', async () => {
  const sdk = new FakeSdk();
  sdk.readReceiptOutcome = { kind: 'failure', raw: 'rejected' };
  assert.equal((await markRead(sdk, { partnerJid: 'r', msgId: 'm' })).kind, 'failed');
  sdk.readReceiptOutcome = { kind: 'success', raw: null };
  assert.equal((await markRead(sdk, { partnerJid: 'r', msgId: 'm' })).kind, 'acked');
  assert.equal(sdk.readReceipts.length, 2);

  const flaky = new FakeSdk();
  flaky.putAdviceOfReadByMsgId = () => Promise.reject(new Error('lost'));
  assert.deepEqual(await markRead(flaky, { partnerJid: 'r', msgId: 'm' }), { kind: 'unknown' });
  let calls = 0;
  flaky.putAdviceOfReadByMsgId = () => {
    calls += 1;
    return Promise.resolve({ kind: 'success', raw: null });
  };
  assert.deepEqual(await markRead(flaky, { partnerJid: 'r', msgId: 'm' }), { kind: 'unknown' });
  assert.equal(calls, 0, 'unknown stays unknown: no automatic second write');
});

test('dedup memory is bounded', async () => {
  const sdk = new FakeSdk();
  for (let i = 0; i < 300; i++) await markRead(sdk, { partnerJid: 'r', msgId: `m${i}` });
  assert.equal(sdk.readReceipts.length, 300);
  await markRead(sdk, { partnerJid: 'r', msgId: 'm299' });
  assert.equal(sdk.readReceipts.length, 300, 'recent ids are still deduplicated');
  await markRead(sdk, { partnerJid: 'r', msgId: 'm0' });
  assert.equal(sdk.readReceipts.length, 301, 'the oldest entry was evicted');
});
