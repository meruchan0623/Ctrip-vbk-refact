import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GID, makeCtx } from './featureTesting.ts';
import { createFeatureDispatcher } from './features.ts';
import { TYPING_THROTTLE_MS, TYPING_VISIBLE_MS, TypingThrottle, TypingTracker, createTypingFeature, parseInboundTyping, sendTypingState } from './typingState.ts';

test('throttle: one frame per 3 s per conversation, independent across conversations', () => {
  const t = new TypingThrottle();
  assert.equal(TYPING_THROTTLE_MS, 3000);
  assert.equal(typeof t.admit('1', 10_000), 'symbol');
  assert.equal(t.admit('1', 12_999), null);
  assert.equal(typeof t.admit('2', 12_999), 'symbol');
  const attempt = t.admit('1', 13_000);
  assert.ok(attempt);
  t.release('1', attempt);
  assert.equal(typeof t.admit('1', 13_001), 'symbol', 'a released slot does not block');
});

test('throttle table stays bounded', () => {
  const t = new TypingThrottle();
  for (let i = 0; i < 400; i++) t.admit(`g${i}`, i);
  assert.ok(t.size <= 256);
});

test('send: nothing leaves without the page capability, and the throttle slot is not consumed', async () => {
  const ctx = makeCtx();
  const throttle = new TypingThrottle();
  assert.deepEqual(await sendTypingState(throttle, ctx, GID), { sent: false, reason: 'unsupported' });
  assert.equal(throttle.size, 0);
  assert.equal(ctx.fakeDeps.fakeFetch.calls.length, 0, 'typing never goes over HTTP');
});

test('send: throttled second call, unsent frame releases the slot, unknown conversation refused', async () => {
  const sent: unknown[] = [];
  let result = true;
  const ctx = makeCtx(undefined, { sendInputState: (req) => { sent.push(req); return result; } });
  const throttle = new TypingThrottle();
  assert.deepEqual(await sendTypingState(throttle, ctx, GID), { sent: true });
  assert.deepEqual(await sendTypingState(throttle, ctx, GID), { sent: false, reason: 'throttled' });
  assert.equal(sent.length, 1);
  await ctx.fakeDeps.clock.advance(3000);
  result = false;
  assert.deepEqual(await sendTypingState(throttle, ctx, GID), { sent: false, reason: 'not_sent' });
  result = true;
  assert.deepEqual(await sendTypingState(throttle, ctx, GID), { sent: true }, 'failed attempt did not hold the slot');
  assert.deepEqual(await sendTypingState(throttle, ctx, '777'), { sent: false, reason: 'unknown_conversation' });
  await assert.rejects(sendTypingState(throttle, ctx, 'x y'), /invalid gid/);
});

test('send: a throwing facade is a not_sent, not an exception', async () => {
  const ctx = makeCtx(undefined, { sendInputState: () => { throw new Error('boom'); } });
  assert.deepEqual(await sendTypingState(new TypingThrottle(), ctx, GID), { sent: false, reason: 'not_sent' });
});

test('inbound: group frame from someone else yields gid + sender; own echo and other types are ignored', () => {
  const evt = { type: 'input_state', msgtype: '9901', from: `${GID}@conf.x/cust-9`, to: 'agent-1@im.x' };
  assert.deepEqual(parseInboundTyping(evt, 'agent-1'), { gid: GID, from: 'cust-9' });
  assert.equal(parseInboundTyping({ ...evt, from: `${GID}@conf.x/agent-1` }, 'agent-1'), null);
  assert.equal(parseInboundTyping({ ...evt, type: 'groupchat' }, 'agent-1'), null);
  assert.equal(parseInboundTyping({ type: 'input_state' }, 'agent-1'), null);
});

test('tracker: indicator expires on its own and a real message clears it', () => {
  const tr = new TypingTracker();
  const f = tr.observe('g1', 'c1', 1000);
  assert.equal(f.until_ms, 1000 + TYPING_VISIBLE_MS);
  assert.equal(tr.active('g1', 1000 + TYPING_VISIBLE_MS - 1), 'c1');
  assert.equal(tr.active('g1', 1000 + TYPING_VISIBLE_MS), null);
  assert.equal(tr.size, 0);
  tr.observe('g2', 'c2', 0);
  tr.clear('g2');
  assert.equal(tr.active('g2', 1), null);
});

test('feature: typing.send op + inbound frames emit typing facts with an expiry', async () => {
  const ctx = makeCtx(undefined, { sendInputState: () => true });
  const feature = createTypingFeature();
  const d = createFeatureDispatcher([feature]);
  assert.deepEqual(await d.call('typing.send', { gid: GID }, ctx), { sent: true });
  d.onSdkMessage({ type: 'input_state', from: `${GID}@conf.x/cust-9`, to: 'agent-1@im.x' }, ctx);
  d.onSdkMessage({ type: 'input_state', from: `${GID}@conf.x/agent-1`, to: 'agent-1@im.x' }, ctx);
  assert.deepEqual(ctx.facts, [{ kind: 'typing', gid: GID, from: 'cust-9', until_ms: ctx.fakeDeps.now() + TYPING_VISIBLE_MS }]);
  d.dispose();
  assert.equal(feature.throttle.size, 0);
});

test('a failed attempt can release only its own admission, including after eviction or clear', () => {
  const t = new TypingThrottle(), old = t.admit('1', 0)!;
  const newer = t.admit('1', 3000)!;
  assert.notEqual(newer, old);
  t.release('1', old); assert.equal(t.admit('1', 3001), null);
  t.release('1', newer); assert.ok(t.admit('1', 3001));
  t.clear(); const afterClear = t.admit('1', 3000)!;
  t.release('1', newer); assert.equal(t.admit('1', 3001), null);
  t.release('1', afterClear);
  const evicted = t.admit('1', 0)!;
  for (let i = 0; i < 256; i++) t.admit(`other-${i}`, 10000 + i);
  const restored = t.admit('1', 20000)!;
  t.release('1', evicted); assert.equal(t.admit('1', 20001), null);
  t.release('1', restored); assert.ok(t.admit('1', 20001));
});
