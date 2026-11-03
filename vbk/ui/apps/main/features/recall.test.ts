import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFeatureRuntime } from './runtime.ts';
import { RECALL_COMMAND, RECALL_WINDOW_MS, createRecall, recallEligibility, reeditText } from './recall.ts';
import { ACCOUNT, GID, MSG_ID, makeHost, ownMessage, settle } from './testing.ts';

test('eligibility: own, confirmed, server-id, inside 2 minutes of SERVER time', () => {
  const now = 1_700_000_000_000;
  const m = ownMessage({ create_time_ms: now - 1000 });
  assert.deepEqual(recallEligibility(m, now), { kind: 'ok', remainingMs: RECALL_WINDOW_MS - 1000 });
  assert.deepEqual(recallEligibility(ownMessage({ create_time_ms: now - RECALL_WINDOW_MS }), now).kind, 'ok');
  assert.deepEqual(recallEligibility(ownMessage({ create_time_ms: now - RECALL_WINDOW_MS - 1 }), now), { kind: 'expired' });
  assert.deepEqual(recallEligibility(m, null), { kind: 'clock_unknown' });
  assert.deepEqual(recallEligibility(ownMessage({ create_time_ms: now + 60_000 }), now), { kind: 'clock_unknown' });
});

test('eligibility: other people\'s, system, unconfirmed and id-less messages are never offered', () => {
  const now = 1_700_000_000_000;
  const base = { create_time_ms: now - 1000 };
  assert.equal(recallEligibility(ownMessage({ ...base, sender_role: 'customer' }), now).kind, 'not_own');
  assert.equal(recallEligibility(ownMessage({ ...base, sender_role: 'merchant_other' }), now).kind, 'not_own');
  assert.equal(recallEligibility(ownMessage({ ...base, kind: 'system' }), now).kind, 'not_recallable');
  assert.equal(recallEligibility(ownMessage({ ...base, recalled_message_id: MSG_ID }), now).kind, 'not_recallable');
  assert.equal(recallEligibility(ownMessage({ ...base, disposition: { kind: 'unknown' } }), now).kind, 'not_recallable');
  assert.equal(recallEligibility(ownMessage({ ...base, disposition: { kind: 'rejected', code: 'x', reason: 'y' } }), now).kind, 'not_recallable');
  assert.equal(recallEligibility(ownMessage({ ...base, disposition: { kind: 'confirmed', server_message_id: MSG_ID, server_time_ms: now } }), now).kind, 'ok');
  assert.equal(recallEligibility(ownMessage({ ...base, message_id: null }), now).kind, 'no_server_id');
  assert.equal(recallEligibility(ownMessage({ ...base, message_id: 'local-1' }), now).kind, 'no_server_id');
  assert.equal(recallEligibility(ownMessage({ ...base, message_id: '12345' }), now).kind, 'no_server_id');
});

test('re-edit returns text for the draft and never sends', () => {
  assert.equal(reeditText(ownMessage({ text: 'again' })), 'again');
  assert.equal(reeditText(ownMessage({ kind: 'image' })), null);
  assert.equal(reeditText(ownMessage({ sender_role: 'customer' })), null);
  assert.equal(reeditText(ownMessage({ text: '  ' })), null);
});

function setup(reply: unknown) {
  const host = makeHost();
  host.invokeReply = () => (reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply));
  const mod = createRecall();
  const rt = createFeatureRuntime([mod], host);
  rt.start();
  const action = () => rt.messageActions(ownMessage({ create_time_ms: host.now - 1000 })).find((a) => a.id === 'recall');
  return { host, mod, rt, action };
}

test('action: visible inside the window, hidden when the clock is unanchored', () => {
  const { host, action } = setup({ outcome: 'recalled' });
  assert.ok(action());
  host.server = null;
  assert.equal(action(), undefined);
});

test('run: danger confirmation first; declined means no request', async () => {
  const { host, action } = setup({ outcome: 'recalled' });
  host.confirmAnswer = false;
  await action()!.run(ownMessage({ create_time_ms: host.now - 1000 }), host.active!);
  assert.equal(host.confirms.length, 1);
  assert.equal(host.confirms[0]!.danger, true);
  assert.equal(host.invokes.length, 0);
});

test('run: confirmed recall sends exactly {gid, message_id, created_ms} and marks recalled only after the server said so', async () => {
  const { host, mod, action } = setup({ outcome: 'recalled' });
  const msg = ownMessage({ create_time_ms: host.now - 1000 });
  assert.equal(mod.recalled(GID, MSG_ID), false);
  await action()!.run(msg, host.active!);
  assert.equal(host.invokes.length, 1);
  assert.equal(host.invokes[0]!.command, RECALL_COMMAND);
  assert.deepEqual(host.invokes[0]!.payload, { gid: GID, message_id: MSG_ID, created_ms: msg.create_time_ms, account: ACCOUNT });
  assert.equal(mod.recalled(GID, MSG_ID), true);
  assert.equal(action(), undefined, 'no second recall offered');
});

test('run: the window closing while the dialog is open aborts without a request', async () => {
  const { host, action } = setup({ outcome: 'recalled' });
  const msg = ownMessage({ create_time_ms: host.now - 119_000 });
  host.confirm = async (req) => {
    host.confirms.push(req);
    host.server = host.now + 5000; // dialog stayed open
    return true;
  };
  await action()!.run(msg, host.active!);
  assert.equal(host.invokes.length, 0);
  assert.match(host.toasts.at(-1)!, /2 分钟/);
});

test('run: a refusal raised before any request (unknown op, ACL, host gate) keeps the action and never reads as unknown', async () => {
  const notSent = [
    { code: 'host.unsupported', message: 'unknown op', retryable: false },
    { code: 'host.unauthorized', message: 'window may not call', retryable: false },
    { code: 'host.contract_mismatch', message: 'v', retryable: false },
    { code: 'account.generation_mismatch', message: 'stale', retryable: false },
    { code: 'im.feature_invalid_argument', message: 'gid', retryable: false },
    { code: 'adapter.failed', message: 'arguments must be an object', retryable: false },
  ];
  for (const reply of notSent) {
    const { host, mod, action } = setup(Object.assign(new Error(reply.message), reply));
    const msg = ownMessage({ create_time_ms: host.now - 1000 });
    await action()!.run(msg, host.active!);
    assert.equal(host.invokes.length, 1);
    assert.equal(mod.recalled(GID, MSG_ID), false);
    assert.ok(action(), `${reply.code}: nothing was sent, so the action must stay available`);
    assert.doesNotMatch(host.toasts.at(-1)!, /结果未知/, reply.code);
  }
  const expired = setup(Object.assign(new Error('x'), { code: 'im.recall_expired', message: 'x', retryable: false }));
  await expired.action()!.run(ownMessage({ create_time_ms: expired.host.now - 1000 }), expired.host.active!);
  assert.match(expired.host.toasts.at(-1)!, /2 分钟/);
  const unanchored = setup(Object.assign(new Error('x'), { code: 'im.recall_clock_unknown', message: 'x', retryable: false }));
  await unanchored.action()!.run(ownMessage({ create_time_ms: unanchored.host.now - 1000 }), unanchored.host.active!);
  assert.match(unanchored.host.toasts.at(-1)!, /未校准/);
});

test('run: unknown outcome and a post-dispatch IPC failure are never replayed (action disappears)', async () => {
  for (const reply of [{ outcome: 'unknown' }, new Error('ipc down'), Object.assign(new Error('t'), { code: 'adapter.timeout', message: 't', retryable: true })]) {
    const { host, mod, action } = setup(reply);
    const msg = ownMessage({ create_time_ms: host.now - 1000 });
    await action()!.run(msg, host.active!);
    assert.equal(host.invokes.length, 1);
    assert.equal(mod.recalled(GID, MSG_ID), false, 'not shown as recalled without a server answer');
    assert.equal(action(), undefined, 'no automatic or manual replay');
    assert.match(host.toasts.at(-1)!, /结果未知/);
  }
});

test('run: server rejection keeps the action available and reports the reason', async () => {
  const { host, mod, action } = setup({ outcome: 'rejected', code: 4012, message: 'too late' });
  await action()!.run(ownMessage({ create_time_ms: host.now - 1000 }), host.active!);
  assert.equal(mod.recalled(GID, MSG_ID), false);
  assert.match(host.toasts.at(-1)!, /too late/);
  assert.ok(action());
});

test('run: a second click while the request is in flight is ignored', async () => {
  const { host, action } = setup({ outcome: 'recalled' });
  let release!: (v: unknown) => void;
  host.invokeReply = () => new Promise((r) => { release = r; });
  const msg = ownMessage({ create_time_ms: host.now - 1000 });
  const a = action()!;
  const first = a.run(msg, host.active!);
  await settle();
  const second = a.run(msg, host.active!);
  await settle();
  release({ outcome: 'recalled' });
  await first;
  await second;
  assert.equal(host.invokes.length, 1);
});

test('run: an account switch during the request drops the result', async () => {
  const { host, mod, action } = setup({ outcome: 'recalled' });
  let release!: (v: unknown) => void;
  host.invokeReply = () => new Promise((r) => { release = r; });
  const msg = ownMessage({ create_time_ms: host.now - 1000 });
  const p = action()!.run(msg, host.active!);
  await settle();
  host.active = { account: { ...ACCOUNT, session_generation: 2 }, gid: GID };
  release({ outcome: 'recalled' });
  await p;
  host.active = { account: ACCOUNT, gid: GID };
  assert.equal(mod.recalled(GID, MSG_ID), false);
  assert.equal(host.toasts.length, 0);
});

test('fact: an inbound recalled fact marks the message for the current account only', () => {
  const { host, mod, rt } = setup({ outcome: 'recalled' });
  rt.onFact({ kind: 'recalled', account: { ...ACCOUNT, account_id: 'other' }, gid: GID, message_id: MSG_ID });
  assert.equal(mod.recalled(GID, MSG_ID), false);
  rt.onFact({ kind: 'recalled', account: ACCOUNT, gid: GID, message_id: MSG_ID });
  assert.equal(mod.recalled(GID, MSG_ID), true);
  host.active = { account: { ...ACCOUNT, session_generation: 2 }, gid: GID };
  assert.equal(mod.recalled(GID, MSG_ID), false, 'a new session generation starts clean');
});
