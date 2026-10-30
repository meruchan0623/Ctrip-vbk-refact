import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPeripheralPanel, type PeripheralPanelState } from './peripheralPanel.ts';
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

test('script empty and unsupported remain distinct; no reply text fabricated', async () => {
  const h = harness(async () => ({ kind: 'unsupported', raw_count: 2, reason: 'synthetic missing contract' }));
  await h.panel.open('scripts'); assert.equal(h.state()?.scripts?.kind, 'unsupported');
  await h.panel.submit(); assert.equal(h.state()?.write, null);
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
      stillActive: () => true, activeConv: () => ({ title: 'Synthetic Customer' }),
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
