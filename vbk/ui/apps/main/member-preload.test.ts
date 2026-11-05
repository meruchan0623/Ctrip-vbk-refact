import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemberPreload, MEMBER_PRELOAD_POLICY } from './member-preload.ts';
import { UiCommands, type UiMembers } from '../../packages/ipc/src/client.ts';
import type { AccountContext } from '../../packages/ipc/src/contracts.ts';

const account: AccountContext = { account_id: 'synthetic-a', environment: 'production', session_generation: 1 };
const memberValue = (nickname = 'Fresh'): UiMembers => ({ members: [{ uid: 'agent', nickname, status: '1', roles: [0, 3, 4], can_transfer: true }], fetched_at_ms: 100_000, selection_token: 'never-cache-token', expires_at_ms: 130_000 });
const level = (agents: unknown[] = [], groups: number[] = []) => ({ selection_token: 'never-cache-token', expires_at_ms: 130_000, agents, skill_groups: groups.map(id => ({ skill_group_id: id, name: `Group ${id}` })) });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const settle = () => new Promise(resolve => setImmediate(resolve));
const memberCalls = (calls: readonly { command: string; payload: Record<string, unknown>; at: number }[], gid: string) => calls.filter(call => call.command === UiCommands.IM_MEMBERS && call.payload['gid'] === gid);
function assertBudget(calls: readonly { at: number }[], limit: number) {
  for (const call of calls) assert.ok(calls.filter(other => other.at >= call.at && other.at - call.at < 60_000).length <= limit, `more than ${limit} requests in the minute after ${call.at}`);
}
function assertSpacing(calls: readonly { at: number }[], minimum: number) {
  for (let i = 1; i < calls.length; i++) assert.ok(calls[i]!.at - calls[i - 1]!.at >= minimum, `requests ${calls[i]!.at - calls[i - 1]!.at}ms apart`);
}
function harness(invoke: (command: string, payload: Record<string, unknown>) => Promise<unknown>) {
  let time = 100_000, visible = true, sequence = 0, published = 0;
  const jobs = new Map<number, { at: number; callback: () => void }>();
  const calls: { command: string; payload: Record<string, unknown>; at: number }[] = [];
  const service = createMemberPreload({ now: () => time, isVisible: () => visible, publish: () => { published++; },
    invoke: (command, payload) => { calls.push({ command, payload: payload as Record<string, unknown>, at: time }); return invoke(command, payload as Record<string, unknown>); },
    schedule: (callback, delay) => { const id = ++sequence; jobs.set(id, { at: time + delay, callback }); return () => { jobs.delete(id); }; },
  });
  async function next() { const first = [...jobs.entries()].sort((a, b) => a[1].at - b[1].at)[0]; assert.ok(first, 'expected scheduled work'); jobs.delete(first[0]); time = first[1].at; first[1].callback(); await settle(); }
  return { service, calls, jobs, next, now: () => time, published: () => published, setVisible: (next: boolean) => { visible = next; }, setTime: (next: number) => { time = next; } };
}

test('starts with current group and traverses the shared directory within per-step batch budget', async () => {
  const h = harness(async (command, payload) => {
    if (command === UiCommands.IM_MEMBERS) return memberValue();
    const parents = payload['parent_skill_group_ids'] as number[] | undefined;
    return parents ? level(parents.map(id => ({ uid: `agent-${id}`, nickname: 'Agent', status: 0, in_group: true })), [1]) : level([], Array.from({ length: 30 }, (_, i) => i + 1));
  });
  h.service.sync({ account, gids: ['active', 'other'], activeGid: 'active' });
  assert.equal(h.calls.length, 0);
  await h.next(); assert.equal(h.calls[0]?.command, UiCommands.IM_MEMBERS); assert.equal(h.calls[0]?.payload['gid'], 'active');
  for (let i = 0; i < 5 && !h.service.getDirectory({ account, gid: 'active' }); i++) await h.next();
  const directory = h.service.getDirectory({ account, gid: 'active' });
  assert.equal(directory?.agents.length, 30); assert.equal(directory?.complete, true);
  const directoryCalls = h.calls.filter(call => call.command === UiCommands.IM_INVITE_CANDIDATES);
  assert.deepEqual(directoryCalls.map(call => (call.payload['parent_skill_group_ids'] as number[] | undefined)?.length), [undefined, 25, 5]);
  assert.ok(directoryCalls.every(call => !('extend_token' in call.payload)), 'display scanning must not renew authorization chains');
  assert.equal(directory?.fetched_at_ms, directoryCalls[0]?.at, 'a complete scan reports the earliest observation time');
  assert.ok(directory!.fetched_at_ms < h.now());
  assert.equal(h.service.getDirectory({ account, gid: 'other' })?.agents[0]?.in_group, undefined);
  assert.equal(directory?.agents[0]?.in_group, true);
  assert.equal(JSON.stringify(directory).includes('selection_token'), false);
  assert.equal(JSON.stringify(h.service.getMembers({ account, gid: 'active' })).includes('selection_token'), false);
  assert.ok(directoryCalls.every(call => call.payload['gid'] === 'active'), 'the directory is only read for the entered conversation');
  assert.ok(h.calls.every(call => call.payload['gid'] === 'active' || call.command === UiCommands.IM_MEMBERS), 'other conversations only get membership reads');
});

test('account switches discard late replies and keep one global request in flight', async () => {
  const pending = deferred<unknown>();
  let concurrent = 0, maximum = 0;
  const h = harness(async () => { concurrent++; maximum = Math.max(maximum, concurrent); const result = h.calls.length === 1 ? await pending.promise : memberValue(); concurrent--; return result; });
  h.service.sync({ account, gids: ['a'], activeGid: 'a' }); await h.next();
  const newer = { ...account, session_generation: 2 };
  h.service.sync({ account: newer, gids: ['b'], activeGid: 'b' });
  assert.equal(h.jobs.size, 0); assert.equal(h.calls.length, 1);
  pending.resolve(memberValue('Old')); await settle();
  assert.equal(h.service.getMembers({ account, gid: 'a' }), null);
  await h.next(); assert.equal(maximum, 1); assert.equal(h.calls[1]?.payload['gid'], 'b');
  assert.equal(h.service.getMembers({ account: newer, gid: 'b' })?.members[0]?.nickname, 'Fresh');
  h.service.stop(); assert.equal(h.jobs.size, 0);
});

test('failed requests consume the minute budget and each target backs off', async () => {
  const h = harness(async () => { throw new Error('synthetic read failure'); });
  h.service.sync({ account, gids: Array.from({ length: 20 }, (_, i) => `g${i}`), activeGid: 'g0' });
  for (let i = 0; i < 12; i++) await h.next();
  assert.ok(h.calls.length <= MEMBER_PRELOAD_POLICY.visibleRequestsPerMinute);
  assert.ok(h.calls.every(call => h.calls.filter(other => other.at >= call.at && other.at - call.at < 60_000).length <= MEMBER_PRELOAD_POLICY.visibleRequestsPerMinute));
  const active = h.calls.filter(call => call.command === UiCommands.IM_MEMBERS && call.payload['gid'] === 'g0');
  for (let i = 1; i < active.length; i++) assert.ok(active[i]!.at - active[i - 1]!.at >= MEMBER_PRELOAD_POLICY.initialBackoffMs);
  await h.next(); assert.ok(h.calls.length <= MEMBER_PRELOAD_POLICY.visibleRequestsPerMinute + 1);
});

test('hidden client continues at a lower budget; pausing stops requests and resumes', async () => {
  const h = harness(async command => command === UiCommands.IM_MEMBERS ? memberValue() : level());
  h.setVisible(false);
  const ctx = { account, gids: ['a', 'b', 'c'], activeGid: 'a' };
  h.service.sync(ctx);
  for (let i = 0; i < 4; i++) await h.next();
  assert.equal(h.calls.length, MEMBER_PRELOAD_POLICY.hiddenRequestsPerMinute);
  assert.ok(h.calls[1]!.at - h.calls[0]!.at >= MEMBER_PRELOAD_POLICY.hiddenTickMs);
  h.service.sync({ ...ctx, paused: true }); assert.equal(h.jobs.size, 0);
  h.service.sync(ctx); await h.next();
  assert.equal(h.calls.length, MEMBER_PRELOAD_POLICY.hiddenRequestsPerMinute);
  while (h.now() < 230_000) await h.next();
  assert.ok(h.calls.length > MEMBER_PRELOAD_POLICY.hiddenRequestsPerMinute, 'background preloading continues after its next budget window');
});

test('foreground observations supersede older background reads and never retain authorization', async () => {
  const pendingMembers = deferred<unknown>(), pendingDirectory = deferred<unknown>();
  const h = harness(async command => command === UiCommands.IM_MEMBERS ? pendingMembers.promise : pendingDirectory.promise);
  const scope = { account, gid: 'a' };
  h.service.sync({ account, gids: ['a'], activeGid: 'a' }); await h.next();
  h.service.observeMembers(scope, memberValue('Foreground'));
  pendingMembers.resolve(memberValue('Background')); await settle();
  assert.equal(h.service.getMembers(scope)?.members[0]?.nickname, 'Foreground');
  await h.next();
  h.service.observeDirectory(scope, [{ uid: 'fresh', nickname: 'Foreground', status: 0 }]);
  pendingDirectory.resolve(level([{ uid: 'old', nickname: 'Background' }])); await settle();
  assert.equal(h.service.getDirectory(scope)?.agents[0]?.uid, 'fresh');
  assert.equal('selection_token' in h.service.getMembers(scope)!, false);
  assert.equal('expires_at_ms' in h.service.getMembers(scope)!, false);
});

test('display cache uses LRU bound and validates malformed read snapshots', async () => {
  const h = harness(async () => ({ members: null }));
  h.service.sync({ account, gids: ['a'], activeGid: 'a', paused: true });
  for (let i = 0; i < MEMBER_PRELOAD_POLICY.cacheLimit + 2; i++) h.service.observeMembers({ account, gid: `g${i}` }, memberValue());
  assert.equal(h.service.getMembers({ account, gid: 'g0' }), null);
  assert.ok(h.service.getMembers({ account, gid: `g${MEMBER_PRELOAD_POLICY.cacheLimit + 1}` }));
  h.service.sync({ account, gids: ['a'], activeGid: 'a' }); await h.next();
  assert.equal(h.service.getMembers({ account, gid: 'a' }), null);
  h.service.sync(null); assert.equal(h.jobs.size, 0);
});


test('switching conversations stops old-group scans and points the directory at the entered group', async () => {
  const pending = deferred<unknown>();
  const h = harness(async command => h.calls.length === 1 ? pending.promise : command === UiCommands.IM_MEMBERS ? memberValue() : level());
  h.service.sync({ account, gids: ['a', 'b', 'c'], activeGid: 'a' }); await h.next();
  h.service.sync({ account, gids: ['a', 'b', 'c'], activeGid: 'b' });
  pending.resolve(memberValue()); await settle();
  assert.equal(h.service.getMembers({ account, gid: 'a' }), null);
  for (let i = 0; i < 5; i++) await h.next();
  const after = h.calls.slice(1);
  assert.equal(after[0]?.payload['gid'], 'b');
  const directoryCalls = after.filter(call => call.command === UiCommands.IM_INVITE_CANDIDATES);
  assert.ok(directoryCalls.length > 0);
  assert.ok(directoryCalls.every(call => call.payload['gid'] === 'b'), 'no directory read for a conversation that is no longer entered');
  h.service.sync(null); assert.equal(h.jobs.size, 0);
});

test('the entered conversation goes first and a due active read is never pre-empted by the scan', async () => {
  const h = harness(async command => command === UiCommands.IM_MEMBERS ? memberValue() : level());
  const others = Array.from({ length: 20 }, (_, i) => `g${i}`);
  h.service.sync({ account, gids: [...others, 'active'], activeGid: 'active' });
  await h.next();
  assert.equal(h.calls[0]?.payload['gid'], 'active');
  while (h.now() < 100_000 + 600_000) await h.next();
  let lastActive = h.calls[0]!.at, scanned = 0;
  for (const call of h.calls.slice(1)) {
    if (call.command !== UiCommands.IM_MEMBERS) continue;
    if (call.payload['gid'] === 'active') { lastActive = call.at; continue; }
    scanned++;
    assert.ok(call.at - lastActive < MEMBER_PRELOAD_POLICY.activeMembersMs, 'scan ran while the active read was due');
  }
  assert.ok(scanned > 0);
  assertBudget(h.calls, MEMBER_PRELOAD_POLICY.visibleRequestsPerMinute);
});

test('other candidates all get scanned in rotation, each no sooner than its interval', async () => {
  const gids = ['a', 'b', 'c', 'd', 'e'];
  for (const [visible, interval, budget, span] of [
    [true, MEMBER_PRELOAD_POLICY.otherMembersMs, MEMBER_PRELOAD_POLICY.visibleRequestsPerMinute, 1_000_000],
    [false, MEMBER_PRELOAD_POLICY.hiddenOtherMembersMs, MEMBER_PRELOAD_POLICY.hiddenRequestsPerMinute, 3_000_000],
  ] as const) {
    const h = harness(async () => memberValue());
    h.setVisible(visible);
    h.service.sync({ account, gids, activeGid: null });
    while (h.now() < 100_000 + span) await h.next();
    assert.deepEqual(h.calls.slice(0, 5).map(call => call.payload['gid']), gids, 'uncached candidates go first, in display order');
    for (const gid of gids) {
      const calls = memberCalls(h.calls, gid);
      assert.ok(calls.length >= 3, `${gid} scanned ${calls.length} times`);
      assertSpacing(calls, interval);
      assert.ok(h.service.peekMembers({ account, gid }));
    }
    assertBudget(h.calls, budget);
  }
});

test('a batched directory scan takes turns with other candidates instead of starving them', async () => {
  const groups = Array.from({ length: 300 }, (_, i) => i + 1);
  const h = harness(async (command, payload) => command === UiCommands.IM_MEMBERS ? memberValue() : level([], payload['parent_skill_group_ids'] ? [] : groups));
  const others = ['x', 'y', 'z'];
  h.service.sync({ account, gids: ['active', ...others], activeGid: 'active' });
  for (let i = 0; !h.service.getDirectory({ account, gid: 'active' }); i++) { assert.ok(i < 200, 'scan never finished'); await h.next(); }
  assert.equal(h.calls.filter(call => (call.payload['parent_skill_group_ids'] as number[] | undefined)?.length).length, 12);
  for (const gid of others) assert.ok(h.service.peekMembers({ account, gid }), `${gid} starved by the directory scan`);
  const firstOthers = h.calls.filter(call => others.includes(call.payload['gid'] as string)).slice(0, 3);
  const directoryCalls = h.calls.filter(call => call.command === UiCommands.IM_INVITE_CANDIDATES);
  assert.ok(firstOthers[2]!.at < directoryCalls[4]!.at, 'candidates are interleaved, not left until the scan ends');
  assertBudget(h.calls, MEMBER_PRELOAD_POLICY.visibleRequestsPerMinute);
});

test('every request counts against the minute budget, including failures, in both visibility states', async () => {
  for (const [visible, budget] of [[true, MEMBER_PRELOAD_POLICY.visibleRequestsPerMinute], [false, MEMBER_PRELOAD_POLICY.hiddenRequestsPerMinute]] as const) {
    const h = harness(async (_command, payload) => { if ((h.calls.length + String(payload['gid']).length) % 2) throw new Error('synthetic read failure'); return memberValue(); });
    h.setVisible(visible);
    h.service.sync({ account, gids: Array.from({ length: 40 }, (_, i) => `g${i}`), activeGid: 'g0' });
    while (h.now() < 100_000 + 600_000) await h.next();
    assert.ok(h.calls.length > budget);
    assertBudget(h.calls, budget);
  }
});

test('a failing candidate backs off without blocking the rest of the scan', async () => {
  const h = harness(async (_command, payload) => { if (payload['gid'] === 'bad') throw new Error('synthetic read failure'); return memberValue(); });
  h.service.sync({ account, gids: ['bad', 'good'], activeGid: null });
  while (h.now() < 100_000 + 120_000) await h.next();
  assert.ok(h.service.peekMembers({ account, gid: 'good' }));
  assert.equal(h.service.peekMembers({ account, gid: 'bad' }), null);
  const bad = memberCalls(h.calls, 'bad');
  assert.ok(bad.length >= 2);
  for (let i = 1; i < bad.length; i++) assert.ok(bad[i]!.at - bad[i - 1]!.at >= MEMBER_PRELOAD_POLICY.initialBackoffMs * 2 ** (i - 1));
});

test('candidates beyond the cache bound never thrash the LRU into repeat requests', async () => {
  const gids = Array.from({ length: MEMBER_PRELOAD_POLICY.cacheLimit + 72 }, (_, i) => `g${i}`);
  const active = gids[gids.length - 1]!;
  const h = harness(async command => command === UiCommands.IM_MEMBERS ? memberValue() : level());
  h.service.sync({ account, gids, activeGid: active });
  while (h.now() < 100_000 + 3_600_000) await h.next();
  const kept = new Set([...gids.slice(0, MEMBER_PRELOAD_POLICY.cacheLimit - 1), active]);
  assert.equal(kept.size, MEMBER_PRELOAD_POLICY.cacheLimit);
  assert.ok(h.calls.every(call => kept.has(call.payload['gid'] as string)), 'only the retained head and active are requested');
  for (const gid of kept) {
    assert.ok(h.service.peekMembers({ account, gid }), `${gid} was evicted or never fetched`);
    if (gid !== active) assertSpacing(memberCalls(h.calls, gid), MEMBER_PRELOAD_POLICY.otherMembersMs);
  }
  assertBudget(h.calls, MEMBER_PRELOAD_POLICY.visibleRequestsPerMinute);
});

test('without an active conversation it only scans and never touches the directory', async () => {
  const h = harness(async () => memberValue());
  h.service.sync({ account, gids: ['a', 'b', 'c'], activeGid: null });
  assert.equal(h.jobs.size, 1);
  while (h.now() < 100_000 + 600_000) await h.next();
  assert.ok(h.calls.length >= 3);
  assert.ok(h.calls.every(call => call.command === UiCommands.IM_MEMBERS));
  assert.equal(h.service.getDirectory({ account, gid: 'a' }), null);
  h.service.sync({ account, gids: [], activeGid: null });
  assert.equal(h.jobs.size, 0, 'nothing to do means nothing scheduled');
});

test('peekMembers leaves the LRU order alone, never exposes tokens and rejects stale scopes', async () => {
  const h = harness(async () => memberValue());
  h.service.sync({ account, gids: ['a'], activeGid: 'a', paused: true });
  const limit = MEMBER_PRELOAD_POLICY.cacheLimit;
  for (let i = 0; i < limit; i++) h.service.observeMembers({ account, gid: `g${i}` }, memberValue());
  for (let i = 0; i < 5; i++) assert.ok(h.service.peekMembers({ account, gid: 'g0' }));
  assert.equal('selection_token' in h.service.peekMembers({ account, gid: 'g0' })!, false);
  assert.equal('expires_at_ms' in h.service.peekMembers({ account, gid: 'g0' })!, false);
  h.service.observeMembers({ account, gid: 'new-1' }, memberValue());
  assert.equal(h.service.peekMembers({ account, gid: 'g0' }), null, 'peeking must not have protected g0 from eviction');
  assert.ok(h.service.getMembers({ account, gid: 'g1' }));
  h.service.observeMembers({ account, gid: 'new-2' }, memberValue());
  assert.ok(h.service.peekMembers({ account, gid: 'g1' }), 'getMembers still refreshes recency');
  assert.equal(h.service.peekMembers({ account, gid: 'g2' }), null);
  assert.equal(h.service.peekMembers({ account, gid: 'unknown' }), null);
  assert.equal(h.service.peekMembers({ account: { ...account, account_id: 'synthetic-b' }, gid: 'g1' }), null);
  const newer = { ...account, session_generation: 2 };
  assert.equal(h.service.peekMembers({ account: newer, gid: 'g1' }), null);
  h.service.sync({ account: newer, gids: ['a'], activeGid: 'a', paused: true });
  assert.equal(h.service.peekMembers({ account, gid: 'g1' }), null, 'old generation scope');
  assert.equal(h.service.peekMembers({ account: newer, gid: 'g1' }), null, 'the cache does not carry over to the new generation');
});

test('a gid removed from the candidates is not requested and its late reply is dropped', async () => {
  const pending = deferred<unknown>();
  const h = harness(async (_command, payload) => payload['gid'] === 'gone' ? pending.promise : memberValue());
  h.service.sync({ account, gids: ['gone', 'stay'], activeGid: null });
  await h.next();
  assert.equal(h.calls[0]?.payload['gid'], 'gone');
  h.service.sync({ account, gids: ['stay'], activeGid: null });
  const publishedBefore = h.published();
  pending.resolve(memberValue()); await settle();
  assert.equal(h.service.peekMembers({ account, gid: 'gone' }), null);
  assert.equal(h.published(), publishedBefore);
  const seen = h.calls.length;
  while (h.now() < 100_000 + 1_000_000) await h.next();
  assert.ok(h.calls.length > seen);
  assert.equal(memberCalls(h.calls, 'gone').length, 1);
});

test('a scan discarded by a conversation switch does not back off and frees the in-flight slot', async () => {
  let reject!: (error: Error) => void;
  const failing = new Promise<never>((_done, fail) => { reject = fail; });
  const h = harness(async () => h.calls.length === 1 ? failing : memberValue());
  h.service.sync({ account, gids: ['x'], activeGid: null });
  await h.next();
  h.service.sync({ account, gids: ['x'], activeGid: 'elsewhere' });
  assert.equal(h.jobs.size, 0, 'the single in-flight slot is still taken');
  reject(new Error('synthetic read failure')); await settle();
  assert.equal(h.jobs.size, 1, 'the slot is free again');
  await h.next();
  assert.equal(h.calls.length, 2);
  assert.ok(h.calls[1]!.at - h.calls[0]!.at < MEMBER_PRELOAD_POLICY.initialBackoffMs, 'the discarded failure did not start a backoff');
  assert.ok(h.service.peekMembers({ account, gid: 'x' }));
});

test('scan results publish and pausing stops them', async () => {
  const h = harness(async () => memberValue());
  const ctx = { account, gids: ['a', 'b'], activeGid: null };
  h.service.sync(ctx);
  await h.next();
  assert.equal(h.published(), 1);
  assert.equal(JSON.stringify(h.service.peekMembers({ account, gid: 'a' })).includes('never-cache-token'), false);
  h.service.sync({ ...ctx, paused: true });
  assert.equal(h.jobs.size, 0);
  const seen = h.calls.length;
  h.service.sync(ctx);
  assert.equal(h.calls.length, seen);
  await h.next();
  assert.equal(h.calls[seen]?.payload['gid'], 'b');
  assert.equal(h.published(), 2);
});

test('when an other candidate and the active read fall due on the same tick, the active read wins', async () => {
  const h = harness(async command => command === UiCommands.IM_MEMBERS ? memberValue() : level());
  const start = h.now();
  h.service.sync({ account, gids: ['active', 'x'], activeGid: 'active' });
  while (h.now() < start + 275_000) await h.next();
  // Shift the active read's phase so it falls due exactly when x does, right after a directory read.
  h.service.observeMembers({ account, gid: 'active' }, memberValue());
  while (h.now() < start + 310_250) await h.next();
  assert.equal(memberCalls(h.calls, 'x')[0]?.at, start + 5_250);
  assert.equal(h.calls.find(call => call.at === start + 300_250)?.command, UiCommands.IM_INVITE_CANDIDATES);
  assert.deepEqual(h.calls.filter(call => call.at === start + 305_250).map(call => call.payload['gid']), ['active']);
  assert.deepEqual(h.calls.filter(call => call.at === start + 310_250).map(call => call.payload['gid']), ['x']);
});

test('when the budget cannot refresh every candidate per interval, rotation still reaches the whole list', async () => {
  const gids = Array.from({ length: 100 }, (_, i) => `g${i}`);
  const h = harness(async () => memberValue());
  const start = h.now();
  h.service.sync({ account, gids, activeGid: null });
  while (h.now() < start + 10_800_000) await h.next();
  for (const gid of gids) assert.ok(memberCalls(h.calls, gid).length >= 3, `${gid} was only read ${memberCalls(h.calls, gid).length} times`);
  assertBudget(h.calls, MEMBER_PRELOAD_POLICY.visibleRequestsPerMinute);
});
