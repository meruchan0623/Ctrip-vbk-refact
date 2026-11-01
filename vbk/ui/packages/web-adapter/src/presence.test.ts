import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AGENT_STATUS_TTL_MS, createPresence } from './presence.ts';
import { FakeClock } from './testing.ts';

function setup() {
  const clock = new FakeClock();
  const updates: { status: string; confirmed: boolean }[] = [];
  const presence = createPresence(clock, (status, confirmed) => updates.push({ status, confirmed }));
  presence.start();
  return { clock, updates, presence };
}

test('presence: cross-device GETOFF supersedes old online reads and never becomes online on socket recovery', () => {
  const { presence } = setup();
  const old = presence.captureRead();
  const latest = presence.captureRead();
  assert.equal(latest.commit('getoff'), true);
  assert.equal(old.commit('online'), false);
  assert.deepEqual(presence.current(), { status: 'getoff', confirmed: true });
  presence.invalidate(); // transport loss
  assert.deepEqual(presence.current(), { status: 'getoff', confirmed: false });
});

test('presence: status expires, lifecycle restarts reject old responses, stop clears timers', async () => {
  const { presence, clock } = setup();
  presence.captureRead().commit('online');
  await clock.advance(AGENT_STATUS_TTL_MS);
  assert.deepEqual(presence.current(), { status: 'online', confirmed: false });
  const old = presence.captureRead();
  presence.stop();
  presence.start();
  assert.equal(old.commit('online'), false);
  presence.captureRead().commit('getoff');
  presence.stop();
  assert.equal(clock.pendingCount(), 0);
});

test('presence: write fences reject pre-write and during-write polls; only independent writeback confirms', () => {
  const { presence } = setup();
  presence.captureRead().commit('online');
  const before = presence.captureRead();
  assert.equal(presence.beginWrite(), true);
  assert.equal(presence.beginWrite(), false);
  const during = presence.captureRead();
  assert.equal(before.commit('online'), false);
  assert.equal(during.commit('online'), false);
  assert.equal(presence.current().confirmed, false);
  assert.equal(presence.captureRead(true).commit('getoff'), true);
  presence.endWrite();
  assert.equal(during.commit('online'), false);
  assert.deepEqual(presence.current(), { status: 'getoff', confirmed: true });
});

test('presence: failed old read cannot invalidate newer server confirmation', () => {
  const { presence } = setup();
  const old = presence.captureRead();
  presence.captureRead().commit('getoff');
  old.fail();
  assert.deepEqual(presence.current(), { status: 'getoff', confirmed: true });
  presence.captureRead().fail();
  assert.deepEqual(presence.current(), { status: 'getoff', confirmed: false });
});

test('presence: slow server responses cannot renew an already expired online observation', async () => {
  const { presence, clock } = setup();
  const slow = presence.captureRead();
  await clock.advance(AGENT_STATUS_TTL_MS);
  assert.equal(slow.commit('online'), false);
  assert.equal(presence.current().confirmed, false);
  const fresh = presence.captureRead();
  await clock.advance(1000);
  assert.equal(fresh.commit('online'), true);
  await clock.advance(AGENT_STATUS_TTL_MS - 1000);
  assert.equal(presence.current().confirmed, false);
});
