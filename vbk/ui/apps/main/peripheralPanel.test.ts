import { t as translateUi } from '../../packages/ui-kit/src/i18n.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPeripheralPanel, filteredInviteAgents, MEMBER_REFRESH_MS, type PeripheralPanelState } from './peripheralPanel.ts';
import { UiCommands } from '../../packages/ipc/src/client.ts';
import type { AccountContext } from '../../packages/ipc/src/contracts.ts';

const account: AccountContext = { account_id: 'synthetic-account-a', environment: 'production', session_generation: 1 };
const members = { members: [{ uid: 'synthetic-agent-b', nickname: 'Synthetic Agent', status: '1', roles: [0, 3, 4], can_transfer: true }], fetched_at_ms: 1, expires_at_ms: 1000, selection_token: 'synthetic-token' };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }
function harness(invoke: (command: string, payload: unknown) => Promise<unknown>, now = () => 100) {
  let scope = { account, gid: 'synthetic-room-a' };
  let state: PeripheralPanelState | null = null;
  let refreshed = 0;
  const panel = createPeripheralPanel({ current: () => scope, invoke, now, publish: (next) => { state = next; }, refreshConversation: async () => { refreshed++; } });
  return { panel, setScope: (next: typeof scope) => { scope = next; }, state: () => state, refreshed: () => refreshed };
}

test('late read does not publish into another room, account generation or reopened panel', async () => {
  const first = deferred<unknown>(); let count = 0;
  const h = harness(async () => ++count === 1 ? first.promise : { ...members, members: [] });
  const pending = h.panel.open('members');
  h.setScope({ account: { ...account, session_generation: 2 }, gid: 'synthetic-room-b' });
  await h.panel.open('members');
  first.resolve(members); await pending;
  assert.equal(h.state()?.scope.gid, 'synthetic-room-b');
  assert.equal(h.state()?.members?.members.length, 0);
});

test('double click sends once; closing and reopening unknown allows only reads', async () => {
  const write = deferred<unknown>(); let writes = 0;
  const h = harness(async (cmd) => { if (cmd === UiCommands.IM_TRANSFER) { writes++; return write.promise; } return members; });
  await h.panel.open('transfer'); h.panel.select('synthetic-agent-b');
  const pending = h.panel.submit(); await h.panel.submit();
  assert.equal(writes, 1);
  write.resolve({ kind: 'unknown', confirmed: false }); await pending;
  assert.equal(h.state()?.write?.kind, 'unknown');
  h.panel.close(); await h.panel.open('transfer'); h.panel.select('synthetic-agent-b'); await h.panel.submit();
  assert.equal(writes, 1);
  await h.panel.refresh(); assert.ok(h.refreshed() > 0); assert.equal(writes, 1);
});

test('expired selection token refreshes read-only, never submits or silently selects', async () => {
  let time = 100; let writes = 0;
  const h = harness(async (cmd) => { if (cmd === UiCommands.IM_TRANSFER) writes++; return members; }, () => time);
  await h.panel.open('transfer'); h.panel.select('synthetic-agent-b'); time = 1001;
  await h.panel.submit(); assert.equal(writes, 0); assert.deepEqual(h.state()?.selected, []);
  assert.match(h.state()?.notice ?? '', /过期/);
});

test('transfer uses explicit server capability; stale panel cannot write after context switch', async () => {
  let writes = 0;
  const h = harness(async (cmd) => { if (cmd === UiCommands.IM_TRANSFER) writes++; return { ...members, members: [{ ...members.members[0], can_transfer: false }] }; });
  await h.panel.open('transfer'); h.panel.select('synthetic-agent-b'); await h.panel.submit(); assert.equal(writes, 0);
  h.setScope({ account: { ...account, session_generation: 2 }, gid: 'synthetic-room-a' });
  await h.panel.submit(); assert.equal(writes, 0);
});

test('ambiguous IPC failure is latched unknown; accepted is not confirmed', async () => {
  let writes = 0;
  const h = harness(async (cmd) => { if (cmd === UiCommands.IM_FINISH) { writes++; throw new Error('synthetic lost reply'); } return members; });
  await h.panel.open('finish'); await h.panel.submit(); assert.equal(h.state()?.write?.kind, 'unknown');
  await h.panel.submit(); assert.equal(writes, 1);
  const other = harness(async (cmd) => cmd === UiCommands.IM_FINISH ? { kind: 'accepted', confirmed: false } : members);
  await other.panel.open('finish'); await other.panel.submit(); assert.equal(other.state()?.write?.kind, 'accepted');
});

test('malformed members cannot reach the dialog or authorize a write', async () => {
  const h = harness(async () => ({ ...members, members: null }));
  await h.panel.open('transfer');
  assert.equal(h.state()?.members, null);
  assert.match(h.state()?.error ?? '', /格式/);
  await h.panel.submit(); assert.equal(h.state()?.submitted, false);
});

test('request generation rejects old response after closing and reopening the same room', async () => {
  const old = deferred<unknown>(); let reads = 0;
  const h = harness(async () => ++reads === 1 ? old.promise : { ...members, members: [] });
  const pending = h.panel.open('members');
  h.panel.close(); await h.panel.open('members');
  old.resolve(members); await pending;
  assert.equal(h.state()?.members?.members.length, 0);
});

test('same room and account with a newer auth generation discards old read and selection', async () => {
  const old = deferred<unknown>(); let writes = 0;
  const h = harness(async (cmd) => { if (cmd === UiCommands.IM_TRANSFER) writes++; return old.promise; });
  const pending = h.panel.open('transfer');
  h.setScope({ account: { ...account, session_generation: 2 }, gid: 'synthetic-room-a' });
  old.resolve(members); await pending;
  assert.equal(h.state()?.members, null);
  h.panel.select('synthetic-agent-b'); await h.panel.submit(); assert.equal(writes, 0);
});

test('confirmed action does not permanently fence a different explicit invitation intent', async () => {
  let writes = 0;
  const h = harness(async (cmd) => cmd === UiCommands.IM_INVITE ? (writes++, { kind: 'confirmed', confirmed: true }) : { selection_token: 'synthetic-token', expires_at_ms: 1000, skill_groups: [], agents: [{ uid: 'synthetic-agent-b', nickname: null }, { uid: 'synthetic-agent-c', nickname: null }] });
  await h.panel.open('invite'); h.panel.select('synthetic-agent-b'); await h.panel.submit();
  h.panel.close(); await h.panel.open('invite'); h.panel.select('synthetic-agent-c'); await h.panel.submit();
  assert.equal(writes, 2);
});

test('finish sends exactly the token captured by the open dialog', async () => {
  const payloads: unknown[] = [];
  const h = harness(async (cmd, payload) => {
    if (cmd === UiCommands.IM_FINISH) { payloads.push(payload); return { kind: 'confirmed', confirmed: true }; }
    return members;
  });
  await h.panel.open('finish'); await h.panel.submit();
  assert.deepEqual(payloads, [{ account, gid: 'synthetic-room-a', selection_token: 'synthetic-token' }]);
});

test('expired finish token only refreshes and requires another explicit confirmation', async () => {
  let time = 100; let reads = 0; const tokens: unknown[] = [];
  const h = harness(async (cmd, payload) => {
    if (cmd === UiCommands.IM_FINISH) { tokens.push((payload as Record<string, unknown>)['selection_token']); return { kind: 'confirmed', confirmed: true }; }
    reads++;
    return { ...members, selection_token: reads === 1 ? 'synthetic-token-a' : 'synthetic-token-b', expires_at_ms: reads === 1 ? 1000 : 3000 };
  }, () => time);
  await h.panel.open('finish'); time = 1001;
  await h.panel.submit();
  assert.equal(tokens.length, 0);
  assert.equal(reads, 2);
  assert.equal(h.state()?.submitted, false);
  assert.match(h.state()?.notice ?? '', /再次确认/);
  await h.panel.submit();
  assert.deepEqual(tokens, ['synthetic-token-b']);
});

test('finish cannot write when the member read failed to provide a valid token', async () => {
  let writes = 0;
  const h = harness(async (cmd) => {
    if (cmd === UiCommands.IM_FINISH) { writes++; return { kind: 'confirmed', confirmed: true }; }
    return { ...members, selection_token: '' };
  });
  await h.panel.open('finish'); await h.panel.submit();
  assert.equal(writes, 0);
  assert.equal(h.state()?.submitted, false);
});

test('explicit not_submitted releases the local fence after read-only refresh; exceptions still do not', async () => {
  let complete = false; let writes = 0;
  const h = harness(async (cmd) => cmd === UiCommands.IM_FINISH
    ? (complete ? (writes++, { kind: 'confirmed', confirmed: true }) : { kind: 'not_submitted', confirmed: false, reason: 'host.unsupported' })
    : members);
  await h.panel.open('finish'); await h.panel.submit();
  assert.equal(writes, 0);
  assert.equal(h.state()?.submitted, false);
  assert.equal(h.state()?.write?.kind, 'not_submitted');
  complete = true;
  h.panel.close(); await h.panel.open('finish');
  assert.equal(writes, 0, 'opening after metadata repair is still read-only');
  await h.panel.submit(); assert.equal(writes, 1);
});

test('real RPC rejects a finish dialog opened for session-a after same gid moves to session-b', async () => {
  const { createRpc } = await import('../../packages/web-adapter/src/rpc.ts');
  const { ConversationStore, RoleBook } = await import('../../packages/web-adapter/src/stores.ts');
  const { SoaClient } = await import('../../packages/web-adapter/src/soa.ts');
  const { makeDeps, sampleRow, jsonResponse, OK_STATUS, FakePageSdk } = await import('../../packages/web-adapter/src/testing.ts');
  const gid = '123456';
  const ok = { ResponseStatus: OK_STATUS, bizResponseStatus: { resultCode: 'SUCCESS' } };
  const deps = makeDeps((call) => call.url.includes('/checkMemberStatus')
    ? jsonResponse({ ResponseStatus: OK_STATUS, status: { code: 0 }, members: [] })
    : call.url.includes('/finishConversation') ? jsonResponse(ok)
    : jsonResponse({ ...ok, conversation: { gid, sessionId: 'synthetic-session-b', status: 4, inGroup: -1 } }));
  const store = new ConversationStore();
  store.update([sampleRow(gid, { sessionId: 'synthetic-session-a', conversationKey: 'synthetic-key-a' })]);
  const rpc = createRpc({ deps, soa: new SoaClient(deps), sdk: new FakePageSdk(), store, roles: new RoleBook('synthetic-self'), pushFact() {}, pushDisplay() {}, agent: { current: () => null, set() {} } });
  let sequence = 0;
  const h = harness(async (command, payload) => {
    const reply = await rpc.handle({ req_id: `synthetic-request-${++sequence}`, op: command === UiCommands.IM_MEMBERS ? 'im.members' : 'im.finish', args: payload });
    assert.ok(reply);
    if (!reply.ok) throw reply.error;
    return reply.data;
  }, deps.now);
  h.setScope({ account, gid });
  await h.panel.open('finish');
  assert.ok(h.state()?.members?.selection_token);
  store.update([sampleRow(gid, { sessionId: 'synthetic-session-b', conversationKey: 'synthetic-key-b' })]);
  await h.panel.submit();
  assert.equal(deps.fakeFetch.calls.filter((call) => call.url.includes('/finishConversation')).length, 0, 'an old confirmation must not finish the new service session');
});

test('actual finish dialog requires a current token before enabling confirmation', async () => {
  const { readFileSync } = await import('node:fs');
  const { stripTypeScriptTypes } = await import('node:module');
  const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  const start = source.indexOf('function peripheralDialog(');
  const end = source.indexOf('\nfunction render(', start);
  assert.ok(start >= 0 && end > start);
  const body = stripTypeScriptTypes(source.slice(start, end));
  interface Node { tag: string; props: Record<string, unknown>; children: unknown[] }
  const walk = (tree: unknown): Node[] => Array.isArray(tree) ? tree.flatMap(walk) : tree && typeof tree === 'object' ? [tree as Node, ...walk((tree as Node).children ?? [])] : [];
  for (const selection of [null, { ...members, selection_token: '' }, { ...members, expires_at_ms: 100 }, members]) {
    const state = { now: 101, activeGid: 'synthetic-room-a', peripheral: { kind: 'finish', scope: { account, gid: 'synthetic-room-a' }, members: selection, candidates: null, busy: false, submitted: false, write: null, selected: [], error: null, notice: null } };
    const env = {
      t: translateUi, stillActive: () => true, activeConv: () => ({ title: 'Synthetic Customer' }),
      h: (tag: string, props: Record<string, unknown> | null, ...children: unknown[]) => ({ tag, props: props ?? {}, children }),
      icon: () => null, IC: {}, cx: (...classes: unknown[]) => classes.filter((item) => typeof item === 'string').join(' '),
    };
    const renderDialog = new Function(...Object.keys(env), body + '\nreturn peripheralDialog;')(...Object.values(env)) as (value: unknown) => Node;
    const confirm = walk(renderDialog(state)).find((node) => (node.props['dataset'] as Record<string, string> | undefined)?.['action'] === 'peripheral-finish-confirm');
    assert.ok(confirm);
    assert.equal(confirm.props['disabled'], selection !== members);
  }
});

test('contradictory not_submitted result cannot unlock an uncertain write', async () => {
  let calls = 0;
  const h = harness(async (cmd) => cmd === UiCommands.IM_FINISH ? (calls++, { kind: 'not_submitted', confirmed: true }) : members);
  await h.panel.open('finish'); await h.panel.submit();
  assert.equal(h.state()?.write?.kind, 'unknown');
  assert.equal(h.state()?.submitted, true);
  h.panel.close(); await h.panel.open('finish'); await h.panel.submit();
  assert.equal(calls, 1);
});

test('real prewrite missing-key result does not permanently lock a repaired finish dialog', async () => {
  const { createRpc } = await import('../../packages/web-adapter/src/rpc.ts');
  const { ConversationStore, RoleBook } = await import('../../packages/web-adapter/src/stores.ts');
  const { SoaClient } = await import('../../packages/web-adapter/src/soa.ts');
  const { makeDeps, sampleRow, jsonResponse, OK_STATUS, FakePageSdk } = await import('../../packages/web-adapter/src/testing.ts');
  const gid = '123456';
  const ok = { ResponseStatus: OK_STATUS, bizResponseStatus: { resultCode: 'SUCCESS' } };
  const deps = makeDeps((call) => call.url.includes('/checkMemberStatus')
    ? jsonResponse({ ResponseStatus: OK_STATUS, status: { code: 0 }, members: [] })
    : call.url.includes('/finishConversation') ? jsonResponse(ok)
    : jsonResponse({ ...ok, conversation: { gid, sessionId: 'synthetic-session-a', status: 4, inGroup: -1 } }));
  const store = new ConversationStore();
  store.update([sampleRow(gid, { sessionId: 'synthetic-session-a', conversationKey: null })]);
  const rpc = createRpc({ deps, soa: new SoaClient(deps), sdk: new FakePageSdk(), store, roles: new RoleBook('synthetic-self'), pushFact() {}, pushDisplay() {}, agent: { current: () => null, set() {} } });
  let sequence = 0;
  const h = harness(async (command, payload) => {
    const reply = await rpc.handle({ req_id: `synthetic-repair-${++sequence}`, op: command === UiCommands.IM_MEMBERS ? 'im.members' : 'im.finish', args: payload });
    assert.ok(reply);
    if (!reply.ok) throw reply.error;
    return reply.data;
  }, deps.now);
  h.setScope({ account, gid });
  await h.panel.open('finish'); await h.panel.submit();
  assert.equal(h.state()?.write?.kind, 'not_submitted');
  assert.equal(h.state()?.submitted, false);
  assert.equal(deps.fakeFetch.calls.filter((call) => call.url.includes('/finishConversation')).length, 0);
  store.update([sampleRow(gid, { sessionId: 'synthetic-session-a', conversationKey: 'synthetic-repaired-key' })]);
  h.panel.close(); await h.panel.open('finish');
  assert.equal(deps.fakeFetch.calls.filter((call) => call.url.includes('/finishConversation')).length, 0);
  await h.panel.submit();
  assert.equal(deps.fakeFetch.calls.filter((call) => call.url.includes('/finishConversation')).length, 1);
  assert.equal(h.state()?.write?.kind, 'confirmed');
});

const managed = { ...members, self_is_master: true, members: [
  { uid: 'synthetic-self', nickname: null, status: '4', roles: [3, 4, 4], role: 'master', is_self: true, can_transfer: false, can_remove: false },
  { uid: 'synthetic-agent-b', nickname: 'B', status: '1', roles: [0, 3, 4], role: 'agent', can_transfer: true, can_remove: true },
  { uid: 'synthetic-agent-c', nickname: 'C', status: '4', roles: [0, 3, 4], role: 'agent', can_transfer: true, can_remove: true },
] };

test('members panel removes only after an explicit second confirmation, then re-reads members', async () => {
  const payloads: unknown[] = []; let reads = 0;
  const h = harness(async (cmd, payload) => {
    if (cmd === UiCommands.IM_REMOVE) { payloads.push(payload); return { kind: 'confirmed', confirmed: true }; }
    reads++; return managed;
  });
  await h.panel.open('members');
  h.panel.select('synthetic-self'); h.panel.select('synthetic-agent-b'); h.panel.select('synthetic-agent-c');
  assert.deepEqual(h.state()?.selected, ['synthetic-agent-b', 'synthetic-agent-c'], 'self is never selectable');
  await h.panel.submit('remove'); assert.equal(payloads.length, 0, 'no write without the confirm step');
  await h.panel.submit(); assert.equal(payloads.length, 0, 'members panel needs an explicit action');
  h.panel.confirmRemove(); await h.panel.submit('remove');
  assert.deepEqual(payloads, [{ account, gid: 'synthetic-room-a', selection_token: 'synthetic-token', target_uids: ['synthetic-agent-b', 'synthetic-agent-c'] }]);
  assert.equal(h.state()?.write?.kind, 'confirmed'); assert.equal(h.state()?.action, 'remove');
  assert.equal(reads, 2, 'confirmed removal re-reads members'); assert.deepEqual(h.state()?.selected, []);
});

test('members panel transfer requires exactly one selection; unknown remove fences the reopened panel', async () => {
  let transfers = 0; let removes = 0;
  const h = harness(async (cmd) => {
    if (cmd === UiCommands.IM_TRANSFER) { transfers++; return { kind: 'confirmed', confirmed: true }; }
    if (cmd === UiCommands.IM_REMOVE) { removes++; throw new Error('synthetic lost reply'); }
    return managed;
  });
  await h.panel.open('members');
  h.panel.select('synthetic-agent-b'); h.panel.select('synthetic-agent-c');
  await h.panel.submit('transfer'); assert.equal(transfers, 0);
  h.panel.confirmRemove(); await h.panel.submit('remove'); assert.equal(removes, 1);
  h.panel.close(); await h.panel.open('members');
  assert.equal(h.state()?.submitted, true); assert.equal(h.state()?.write?.kind, 'unknown');
  h.panel.confirmRemove(); await h.panel.submit('remove'); assert.equal(removes, 1);
});

test('invite directory traverses every department in batches, extends tokens and terminates cycles', async () => {
  const calls: Record<string, unknown>[] = [];
  const h = harness(async (cmd, payload) => {
    assert.equal(cmd, UiCommands.IM_INVITE_CANDIDATES);
    const p = payload as Record<string, unknown>; calls.push(p);
    const parents = p['parent_skill_group_ids'] as number[] | undefined;
    return !parents
      ? { selection_token: 'root-token', expires_at_ms: 1000, skill_groups: [{ skill_group_id: 7, name: 'A' }, { skill_group_id: 8, name: 'B' }], agents: [] }
      : parents.includes(7)
        ? { selection_token: 'branch-token', expires_at_ms: 1000, skill_groups: [{ skill_group_id: 9, name: 'Nested' }], agents: [{ uid: 'agent-7', nickname: 'Seven', status: 0, job_position_type: 4 }, { uid: 'agent-8', nickname: 'Eight', status: 0, job_position_type: 3 }] }
        : { selection_token: 'leaf-token', expires_at_ms: 1000, skill_groups: [{ skill_group_id: 7, name: 'Cycle' }], agents: [{ uid: 'agent-9', nickname: 'Nine', status: 0, job_position_type: 4 }, { uid: 'member-9', nickname: null, in_group: true }] };
  });
  await h.panel.open('invite');
  h.panel.select('agent-7'); h.panel.select('agent-9'); h.panel.select('member-9');
  assert.deepEqual(calls.slice(1).map(c => [c['parent_skill_group_ids'], c['extend_token']]), [[[7, 8], 'root-token'], [[9], 'branch-token']]);
  assert.deepEqual(h.state()?.selected, ['agent-7', 'agent-9'], 'in-group agents are not selectable');
  assert.equal(h.state()?.candidates?.selection_token, 'leaf-token');
  assert.deepEqual(filteredInviteAgents(h.state()!).map(a => a.uid), ['agent-9', 'agent-7']);
  h.panel.setRoleFilter('all'); assert.equal(filteredInviteAgents(h.state()!).length, 3);
  await h.panel.refresh(undefined, 'Seven');
  assert.equal(calls.length, 3, 'search filters the complete directory locally');
  assert.deepEqual(filteredInviteAgents(h.state()!).map(a => a.uid), ['agent-7']);
  assert.deepEqual(h.state()?.selected, ['agent-7', 'agent-9'], 'filters do not erase explicit selections');
});

function automaticHarness(invoke: (command: string, payload: unknown) => Promise<unknown>) {
  let state: PeripheralPanelState | null = null;
  let scope = { account, gid: 'synthetic-room-a' };
  let visible = true;
  const jobs = new Map<number, () => void>(); let id = 0;
  const panel = createPeripheralPanel({ current: () => scope, invoke, now: () => 100, publish: next => { state = next; }, refreshConversation: async () => {}, isVisible: () => visible,
    schedule: (callback, delay) => { assert.equal(delay, MEMBER_REFRESH_MS); const key = ++id; jobs.set(key, callback); return () => { jobs.delete(key); }; },
  });
  return { panel, state: () => state, jobs, setVisible: (next: boolean) => { visible = next; }, setScope: (next: typeof scope) => { scope = next; },
    tick: async () => { const next = jobs.entries().next().value; assert.ok(next); jobs.delete(next[0]); next[1](); await new Promise(resolve => setImmediate(resolve)); } };
}
const inviteSnapshot = (agents: unknown[], token = 'synthetic-token') => ({ selection_token: token, expires_at_ms: 1000, skill_groups: [], agents });

test('automatic member reads preserve selection, prune lost eligibility, pause hidden and stop on close/context loss', async () => {
  let calls = 0;
  const h = automaticHarness(async () => ++calls < 3 ? managed : { ...managed, members: [managed.members[0]] });
  await h.panel.open('members'); h.panel.select('synthetic-agent-b'); h.panel.confirmRemove();
  await h.tick(); assert.equal(h.state()?.confirming, 'remove'); assert.equal(calls, 2); assert.deepEqual(h.state()?.selected, ['synthetic-agent-b']);
  h.setVisible(false); await h.tick(); assert.equal(calls, 2);
  h.setVisible(true); await h.tick(); assert.equal(calls, 3); assert.deepEqual(h.state()?.selected, []); assert.equal(h.state()?.confirming, null);
  assert.equal(h.jobs.size, 1);
  h.panel.close(); assert.equal(h.jobs.size, 0);
  await h.panel.open('members'); h.setScope({ account, gid: 'other-room' });
  await h.tick(); assert.equal(h.state(), null); assert.equal(h.jobs.size, 0);
});

test('background invitation refresh preserves filters and picks while preventing overlapping reads and writes', async () => {
  let reads = 0; let writes = 0; const pending = deferred<unknown>();
  const agents = [{ uid: 'a', nickname: 'Alpha', status: 0, job_position_type: 4 }, { uid: 'b', nickname: 'Beta', status: 0, job_position_type: 3 }];
  const h = automaticHarness(async command => {
    if (command === UiCommands.IM_INVITE) { writes++; return { kind: 'confirmed', confirmed: true }; }
    return ++reads === 2 ? pending.promise : inviteSnapshot(agents);
  });
  await h.panel.open('invite'); h.panel.select('a'); h.panel.setOnlineOnly(false); h.panel.setRoleFilter('all');
  await h.panel.refresh(undefined, 'Beta');
  await h.tick(); assert.equal(h.state()?.refreshing, true); assert.equal(h.state()?.busy, false);
  h.panel.select('b'); await h.panel.refresh(); await h.panel.submit();
  assert.equal(reads, 2); assert.equal(writes, 0);
  pending.resolve(inviteSnapshot(agents, 'new-token')); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.state()?.selected, ['a', 'b']); assert.equal(h.state()?.query, 'Beta');
  assert.equal(h.state()?.onlineOnly, false); assert.equal(h.state()?.roleFilter, 'all');
  assert.equal(h.state()?.candidates?.selection_token, 'new-token'); assert.equal(h.jobs.size, 1);
});

test('late automatic read cannot replace a reopened panel or cancel its timer', async () => {
  let calls = 0; const pending = deferred<unknown>();
  const h = automaticHarness(async () => ++calls === 2 ? pending.promise : managed);
  await h.panel.open('members'); await h.tick();
  h.panel.close(); await h.panel.open('members'); assert.equal(h.jobs.size, 1);
  pending.resolve({ ...managed, members: [] }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.state()?.members?.members.length, managed.members.length); assert.equal(h.jobs.size, 1);
  await h.tick(); assert.equal(calls, 4);
});

test('unknown invitation is never retried by automatic refresh', async () => {
  let writes = 0;
  const h = automaticHarness(async command => command === UiCommands.IM_INVITE
    ? (writes++, { kind: 'unknown', confirmed: false })
    : inviteSnapshot([{ uid: 'a', nickname: null, status: 0, job_position_type: 4 }]));
  await h.panel.open('invite'); h.panel.select('a'); await h.panel.submit(); await h.tick(); await h.tick();
  await h.panel.submit(); assert.equal(writes, 1); assert.equal(h.state()?.submitted, true); assert.equal(h.state()?.write?.kind, 'unknown');
});

test('slow traversal cannot publish earlier candidates under a token that lost its extension', async () => {
  let time = 100; let calls = 0;
  const h = harness(async () => ++calls === 1
    ? { ...inviteSnapshot([{ uid: 'a', nickname: null }]), skill_groups: [{ skill_group_id: 7, name: 'A' }] }
    : (time = 1001, inviteSnapshot([{ uid: 'b', nickname: null }], 'non-extending-token')), () => time);
  await h.panel.open('invite');
  assert.equal(h.state()?.candidates, null); assert.deepEqual(h.state()?.known, {}); assert.match(h.state()?.error ?? '', /超时/);
});

test('online and role filters never infer presence from duty and keep unknown roles explicit', async () => {
  const h = harness(async () => inviteSnapshot([
    { uid: 'a', nickname: 'A', status: 0, duty_status: 0, job_position_type: 4 },
    { uid: 'b', nickname: 'B', status: 3, duty_status: 1, job_position_type: 4 },
    { uid: 'c', nickname: 'C', status: null, duty_status: 1, job_position_type: 4 },
    { uid: 'd', nickname: 'D', status: 0, job_position: '客服' },
    { uid: 'e', nickname: 'E', status: 0 },
    { uid: 'f', nickname: 'F', status: 0, job_position_type: 99 },
    { uid: 'g', nickname: 'G', status: 0, job_position_type: 0 },
  ]));
  await h.panel.open('invite'); assert.deepEqual(filteredInviteAgents(h.state()!).map(a => a.uid), ['a', 'd']);
  h.panel.setOnlineOnly(false); assert.deepEqual(filteredInviteAgents(h.state()!).map(a => a.uid), ['a', 'd', 'b', 'c']);
  h.panel.setRoleFilter('unknown'); assert.deepEqual(filteredInviteAgents(h.state()!).map(a => a.uid), ['e', 'f', 'g']);
});

test('available presence includes online, suspended and away in that order', async () => {
  const h = harness(async () => inviteSnapshot([
    { uid: 'away', nickname: 'A', status: 2, job_position_type: 4 },
    { uid: 'off', nickname: 'B', status: 3, job_position_type: 4 },
    { uid: 'busy', nickname: 'Z', status: 1, job_position_type: 4 },
    { uid: 'on', nickname: 'Z', status: 0, job_position_type: 4 },
    { uid: 'unknown', nickname: 'C', status: null, job_position_type: 4 },
  ]));
  await h.panel.open('invite');
  assert.deepEqual(filteredInviteAgents(h.state()!).map(a => a.uid), ['on', 'busy', 'away']);
  h.panel.setOnlineOnly(false);
  assert.deepEqual(filteredInviteAgents(h.state()!).map(a => a.uid), ['on', 'busy', 'away', 'off', 'unknown']);
});

test('preloaded display is immediate but never authorizes a write before a fresh read', async () => {
  const pending = deferred<unknown>();
  let state: PeripheralPanelState | null = null;
  let writes = 0;
  const panel = createPeripheralPanel({
    current: () => ({ account, gid: 'synthetic-room-a' }), now: () => 100,
    invoke: async command => { if (command === UiCommands.IM_MEMBERS) return pending.promise; writes++; return {}; },
    publish: next => { state = next; }, refreshConversation: async () => {},
    preload: () => ({ members, updatedAt: 1 }),
  });
  const opening = panel.open('transfer');
  const cached = state as PeripheralPanelState | null;
  assert.equal(cached?.members?.members.length, 1);
  assert.equal(cached?.members?.selection_token, '');
  await panel.submit(); assert.equal(writes, 0);
  pending.resolve(members); await opening;
  assert.equal((state as PeripheralPanelState | null)?.members?.selection_token, members.selection_token);
  panel.close();
});
test('preloaded invite list stays selectable while the authorizing read is in flight', async () => {
  const pending = deferred<unknown>();
  let state: PeripheralPanelState | null = null;
  let writes = 0;
  const agents = [{ uid: 'a', nickname: 'Alpha', status: 0, job_position_type: 4 }, { uid: 'b', nickname: 'Beta', status: 0, job_position_type: 4, in_group: true }];
  const panel = createPeripheralPanel({
    current: () => ({ account, gid: 'synthetic-room-a' }), now: () => 100,
    invoke: async command => { if (command === UiCommands.IM_INVITE_CANDIDATES) return pending.promise; writes++; return {}; },
    publish: next => { state = next; }, refreshConversation: async () => {},
    preload: () => ({ candidates: { agents, skill_groups: [], selection_token: '', expires_at_ms: 0 }, updatedAt: 1 }),
  });
  const opening = panel.open('invite');
  const cached = state as PeripheralPanelState | null;
  assert.equal(cached?.busy, false); assert.equal(cached?.refreshing, true);
  panel.select('a'); panel.select('b');
  assert.deepEqual((state as PeripheralPanelState | null)?.selected, ['a']);
  await panel.submit(); assert.equal(writes, 0, 'no write before the fresh token arrives');
  pending.resolve({ selection_token: 'fresh', expires_at_ms: 1000, skill_groups: [], agents }); await opening;
  assert.deepEqual((state as PeripheralPanelState | null)?.selected, ['a']);
  assert.equal((state as PeripheralPanelState | null)?.candidates?.selection_token, 'fresh');
  panel.close();
});
