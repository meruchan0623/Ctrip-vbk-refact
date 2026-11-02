import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFeatureRuntime } from './runtime.ts';
import { OutboundTyping, TYPING_COMMAND, TYPING_FAILURE_BACKOFF_MS, TYPING_THROTTLE_MS, createTypingIndicator, typingNow } from './typing-indicator.ts';
import { ACCOUNT, GID, makeHost, settle } from './testing.ts';

test('OutboundTyping: first sight, unchanged text, and emptied draft never emit', () => {
  const o = new OutboundTyping();
  assert.equal(o.observe('g', 'restored draft', 0), false, 'first sight after a switch only records');
  assert.equal(o.observe('g', 'restored draft', 10), false, 'no change');
  assert.equal(o.observe('g', 'restored draft!', 20), true);
  assert.equal(o.observe('g', '', 30_000), false, 'clearing the draft is not typing');
  assert.equal(o.observe('g', 'x', 30_001), true);
});

test('OutboundTyping: one frame per 3 s per conversation', () => {
  const o = new OutboundTyping();
  o.observe('g', 'a', 0);
  assert.equal(o.observe('g', 'ab', 1000), true);
  assert.equal(o.observe('g', 'abc', 1000 + TYPING_THROTTLE_MS - 1), false);
  assert.equal(o.observe('g', 'abcd', 1000 + TYPING_THROTTLE_MS), true);
  o.observe('h', 'a', 0);
  assert.equal(o.observe('h', 'ab', 1001), true, 'other conversations are independent');
});

test('OutboundTyping: unsupported is final, any other failure backs off 30 s', () => {
  const o = new OutboundTyping();
  o.observe('g', 'a', 0);
  o.settle(null, 100);
  assert.equal(o.observe('g', 'ab', 100 + TYPING_FAILURE_BACKOFF_MS - 1), false);
  assert.equal(o.observe('g', 'abc', 100 + TYPING_FAILURE_BACKOFF_MS), true);
  o.settle({ sent: false, reason: 'unsupported' }, 200_000);
  assert.equal(o.unsupported, true);
  assert.equal(o.observe('g', 'abcd', 900_000), false);
});

test('OutboundTyping: switching away and back is a first sight again', () => {
  const o = new OutboundTyping();
  o.observe('g', 'a', 0);
  o.forget('g');
  assert.equal(o.observe('g', 'ab', 5000), false);
});

test('module: a draft edit in the open conversation asks the host once; switching and sending do not', async () => {
  const host = makeHost();
  host.invokeReply = () => Promise.resolve({ sent: true });
  const rt = createFeatureRuntime([createTypingIndicator()], host);
  rt.start();
  host.draftView = { gid: GID, text: 'hel', version: 1 };
  host.changed(); // first sight
  assert.equal(host.invokes.length, 0);
  host.draftView = { gid: GID, text: 'hell', version: 2 };
  host.changed();
  await settle();
  assert.equal(host.invokes.length, 1);
  assert.equal(host.invokes[0]!.command, TYPING_COMMAND);
  assert.equal(host.invokes[0]!.payload['gid'], GID);
  host.draftView = { gid: GID, text: 'hello', version: 3 };
  host.changed();
  assert.equal(host.invokes.length, 1, 'throttled inside 3 s');
  // draft belongs to another conversation than the open one: ignored
  host.now += 10_000;
  host.draftView = { gid: '555', text: 'zzz', version: 4 };
  host.changed();
  assert.equal(host.invokes.length, 1);
  rt.stop();
});

test('module: unsupported host answer stops further asking for the session', async () => {
  const host = makeHost();
  host.invokeReply = () => Promise.resolve({ sent: false, reason: 'unsupported' });
  const rt = createFeatureRuntime([createTypingIndicator()], host);
  rt.start();
  host.draftView = { gid: GID, text: 'a', version: 1 };
  host.changed();
  host.draftView = { gid: GID, text: 'ab', version: 2 };
  host.changed();
  await settle();
  host.now += 60_000;
  host.draftView = { gid: GID, text: 'abc', version: 3 };
  host.changed();
  host.now += 60_000;
  host.draftView = { gid: GID, text: 'abcd', version: 4 };
  host.changed();
  assert.equal(host.invokes.length, 1);
});

test('inbound: typing fact shows until until_ms for the matching account only, then removes itself', async () => {
  const host = makeHost();
  const rt = createFeatureRuntime([createTypingIndicator()], host);
  rt.start();
  const until = host.now + 5000;
  rt.onFact({ kind: 'typing', account: ACCOUNT, gid: GID, from: 'cust', until_ms: until });
  const map = new Map([[GID, { account: ACCOUNT, from: 'cust', untilMs: until }]]);
  assert.equal(typingNow(map, ACCOUNT, GID, host.now), 'cust');
  assert.equal(typingNow(map, { ...ACCOUNT, account_id: 'other' }, GID, host.now), null);
  assert.equal(typingNow(map, ACCOUNT, GID, until), null);
  const rendersBefore = host.renders;
  assert.equal(host.timers.length, 1, 'exactly one expiry timer, no polling');
  await host.advance(5000);
  assert.ok(host.renders > rendersBefore, 're-rendered at expiry');
  assert.equal(host.timers.length, 0);
});

test('inbound: a fact for a non-current account is ignored', () => {
  const host = makeHost();
  const rt = createFeatureRuntime([createTypingIndicator()], host);
  rt.start();
  rt.onFact({ kind: 'typing', account: { ...ACCOUNT, session_generation: 99 }, gid: GID, from: 'c', until_ms: host.now + 5000 });
  assert.equal(host.timers.length, 0);
});
