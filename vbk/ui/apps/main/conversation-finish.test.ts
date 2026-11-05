import test from 'node:test';
import assert from 'node:assert/strict';
import type { AccountContext } from '../../packages/ipc/src/contracts.ts';
import { UiCommands } from '../../packages/ipc/src/client.ts';
import { createConversationFinisher, summarizeFinish } from './conversation-finish.ts';

const account = { account_id: 'synthetic-account', environment: 'prod', session_generation: 3 } as unknown as AccountContext;
const token = (gid: string) => ({ selection_token: `token-${gid}`, expires_at_ms: 10_000, members: [], fetched_at_ms: 1 });

function harness(finish: (payload: { gid: string; selection_token: string }) => unknown, members: (gid: string) => unknown = token) {
  const calls: { command: string; payload: Record<string, unknown> }[] = [];
  const finisher = createConversationFinisher({
    now: () => 1_000,
    invoke: async (command, payload) => {
      const p = payload as Record<string, unknown>;
      calls.push({ command, payload: p });
      if (command === UiCommands.IM_MEMBERS) { const r = members(String(p['gid'])); if (r instanceof Error) throw r; return r; }
      const r = finish(p as { gid: string; selection_token: string });
      if (r instanceof Error) throw r;
      return r;
    },
  });
  const finishes = () => calls.filter(c => c.command === UiCommands.IM_FINISH);
  return { finisher, calls, finishes };
}

test('finish reads a fresh member token and spends exactly that token, with no confirmation step', async () => {
  const h = harness(() => ({ kind: 'confirmed', confirmed: true }));
  assert.deepEqual(await h.finisher.finish(account, 'room-a'), { gid: 'room-a', outcome: 'confirmed' });
  assert.deepEqual(h.calls.map(c => c.command), [UiCommands.IM_MEMBERS, UiCommands.IM_FINISH]);
  assert.equal(h.finishes()[0]!.payload['selection_token'], 'token-room-a');
  assert.equal(h.finishes()[0]!.payload['gid'], 'room-a');
});

test('an expired or missing member token never reaches im_finish', async () => {
  const expired = harness(() => ({ kind: 'confirmed', confirmed: true }), () => ({ selection_token: 'old', expires_at_ms: 999 }));
  assert.equal((await expired.finisher.finish(account, 'room-a')).outcome, 'failed');
  const blank = harness(() => ({ kind: 'confirmed', confirmed: true }), () => ({ selection_token: ' ', expires_at_ms: 10_000 }));
  assert.equal((await blank.finisher.finish(account, 'room-a')).outcome, 'failed');
  const thrown = harness(() => ({ kind: 'confirmed', confirmed: true }), () => new Error('member read failed'));
  assert.deepEqual(await thrown.finisher.finish(account, 'room-a'), { gid: 'room-a', outcome: 'failed', reason: 'member read failed' });
  assert.equal(expired.finishes().length + blank.finishes().length + thrown.finishes().length, 0);
});

test('unknown, lost and accepted-but-unconfirmed writes are fenced and never resubmitted', async () => {
  for (const reply of [{ kind: 'unknown', confirmed: false }, { kind: 'accepted', confirmed: false }, new Error('reply lost')]) {
    const h = harness(() => reply);
    assert.equal((await h.finisher.finish(account, 'room-a')).outcome, 'pending');
    assert.equal(h.finisher.isUnresolved(account, 'room-a'), true);
    assert.equal((await h.finisher.finish(account, 'room-a')).outcome, 'pending');
    assert.equal(h.finishes().length, 1, 'the second attempt must not cross IPC');
  }
});

test('not_submitted lifts the fence so a later explicit attempt may write', async () => {
  let first = true;
  const h = harness(() => { const r = first ? { kind: 'not_submitted', confirmed: false, reason: 'conversation changed' } : { kind: 'confirmed', confirmed: true }; first = false; return r; });
  assert.deepEqual(await h.finisher.finish(account, 'room-a'), { gid: 'room-a', outcome: 'failed', reason: 'conversation changed' });
  assert.equal(h.finisher.isUnresolved(account, 'room-a'), false);
  assert.equal((await h.finisher.finish(account, 'room-a')).outcome, 'confirmed');
  assert.equal(h.finishes().length, 2);
});

test('concurrent clicks on one conversation share a single attempt', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const h = harness(() => gate.then(() => ({ kind: 'confirmed', confirmed: true })));
  const a = h.finisher.finish(account, 'room-a'), b = h.finisher.finish(account, 'room-a');
  release();
  assert.deepEqual(await Promise.all([a, b]), [{ gid: 'room-a', outcome: 'confirmed' }, { gid: 'room-a', outcome: 'confirmed' }]);
  assert.equal(h.finishes().length, 1);
});

test('a new session generation is a different fence', async () => {
  const h = harness(() => ({ kind: 'unknown', confirmed: false }));
  await h.finisher.finish(account, 'room-a');
  const next = { ...account, session_generation: 4 } as AccountContext;
  assert.equal(h.finisher.isUnresolved(next, 'room-a'), false);
});

test('finishMany ends conversations one at a time, dedupes, reports progress and stops before unstarted writes', async () => {
  let inFlight = 0, peak = 0;
  const h = harness(async () => { inFlight++; peak = Math.max(peak, inFlight); await Promise.resolve(); inFlight--; return { kind: 'confirmed', confirmed: true }; });
  const progress: string[] = [];
  let allow = 2;
  const results = await h.finisher.finishMany(account, ['a', 'b', 'a', 'c'], { proceed: () => allow-- > 0, progress: (d, t) => progress.push(`${d}/${t}`) });
  assert.deepEqual(results.map(r => r.gid), ['a', 'b']);
  assert.deepEqual(progress, ['1/3', '2/3']);
  assert.equal(peak, 1, 'writes are sequential');
  assert.deepEqual(h.finishes().map(c => c.payload['gid']), ['a', 'b']);
  assert.deepEqual(summarizeFinish(results, 3), { confirmed: 2, pending: 0, failed: 0, skipped: 1 });
});

test('finishMany keeps going after one failure and summarizes each outcome', async () => {
  const h = harness(({ gid }) => gid === 'b' ? { kind: 'unknown', confirmed: false } : { kind: 'confirmed', confirmed: true }, gid => gid === 'c' ? new Error('denied') : token(gid));
  const results = await h.finisher.finishMany(account, ['a', 'b', 'c', 'd'], { proceed: () => true });
  assert.deepEqual(results.map(r => r.outcome), ['confirmed', 'pending', 'failed', 'confirmed']);
  assert.deepEqual(summarizeFinish(results, 4), { confirmed: 2, pending: 1, failed: 1, skipped: 0 });
});
