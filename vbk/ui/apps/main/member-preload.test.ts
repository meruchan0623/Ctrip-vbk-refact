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
function harness(invoke: (command: string, payload: Record<string, unknown>) => Promise<unknown>) {
  let time = 100_000, visible = true, sequence = 0;
  const jobs = new Map<number, { at: number; callback: () => void }>();
  const calls: { command: string; payload: Record<string, unknown>; at: number }[] = [];
  const service = createMemberPreload({ now: () => time, isVisible: () => visible,
    invoke: (command, payload) => { calls.push({ command, payload: payload as Record<string, unknown>, at: time }); return invoke(command, payload as Record<string, unknown>); },
    schedule: (callback, delay) => { const id = ++sequence; jobs.set(id, { at: time + delay, callback }); return () => { jobs.delete(id); }; },
  });
  async function next() { const first = [...jobs.entries()].sort((a, b) => a[1].at - b[1].at)[0]; assert.ok(first, 'expected scheduled work'); jobs.delete(first[0]); time = first[1].at; first[1].callback(); await settle(); }
  return { service, calls, jobs, next, now: () => time, setVisible: (next: boolean) => { visible = next; }, setTime: (next: number) => { time = next; } };
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
  assert.ok(h.calls.every(call => call.payload['gid'] === 'active'), 'never preload other conversations');
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


test('switching conversations stops old-group scans and only preloads the entered group', async () => {
  const pending = deferred<unknown>();
  const h = harness(async command => h.calls.length === 1 ? pending.promise : command === UiCommands.IM_MEMBERS ? memberValue() : level());
  h.service.sync({ account, gids: ['a', 'b', 'c'], activeGid: 'a' }); await h.next();
  h.service.sync({ account, gids: ['a', 'b', 'c'], activeGid: 'b' });
  pending.resolve(memberValue()); await settle();
  assert.equal(h.service.getMembers({ account, gid: 'a' }), null);
  for (let i = 0; i < 5; i++) await h.next();
  assert.ok(h.calls.slice(1).every(call => call.payload['gid'] === 'b'));
  h.service.sync(null); assert.equal(h.jobs.size, 0);
});
