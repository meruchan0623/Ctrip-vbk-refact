import { t as translateUi } from '../../packages/ui-kit/src/i18n.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { createStore } from '../../packages/ui-kit/src/store.ts';
import { isUiConversation, isUiAgentStatus, isUiNetStatus } from '../_shared/guards.ts';
import { sameAccount } from './viewmodel.ts';
import type { UiConversation } from '../../packages/ipc/src/client.ts';
import type { AccountContext } from '../../packages/ipc/src/contracts.ts';
import { toDisplayConversation } from '../../packages/web-adapter/src/display.ts';
import { sampleRow } from '../../packages/web-adapter/src/testing.ts';

const source = readFileSync(process.env['VBK_ACCOUNT_LOAD_SOURCE'] ?? new URL('./main.ts', import.meta.url), 'utf8');
const owner: AccountContext = { account_id: 'synthetic-account', environment: 'synthetic', session_generation: 1 };
function row(gid: string, title = 'OLD', account = owner): UiConversation {
  const result = { ...toDisplayConversation(sampleRow(gid), false), account, title, is_top: false, draft: '', waiting_since_ms: null, waiting_confirmed: false };
  assert.ok(isUiConversation(result)); return result;
}
function deferred() { let resolve!: (value: unknown) => void; return { promise: new Promise(r => { resolve = r; }), resolve }; }
function fixture(initial: UiConversation[] = []) {
  let context: AccountContext | null = owner;
  let accountState: string | undefined;
  const store = createStore<Record<string, any>>({ conversations: initial, activeGid: null, attachment: null, noticeCats: [], noticeCat: null, agent: null, net: null });
  let responses: Record<string, unknown> = {};
  const calls: string[] = [], released: unknown[] = [];
  const env = { t: translateUi, store, S: () => store.get(), activeAccount: () => context ? { context, state: accountState } : null,
    stillActive: (account: AccountContext) => !!context && sameAccount(account, context) && account.session_generation === context.session_generation,
    sameAccount, isUiConversation, isUiAgentStatus, isUiNetStatus,
    invokeQuiet: async (command: string) => { calls.push(command); try { const result = await responses[command]; if (result instanceof Error) throw result; return result; } catch { return null; } },
    UiCommands: { IM_CONVERSATIONS: 'convs', ACCOUNT_AGENT_STATUS: 'agent', NET_STATUS: 'net', NOTICE_CATEGORIES: 'cats', IM_MARK_READ: 'read' },
    releaseAttachment: async (value: unknown) => { released.push(value); }, noticeQuery: { categories: async () => undefined }, document: { visibilityState: 'hidden' } };
  const functionStart = source.indexOf('async function loadForActiveAccount():');
  const helperStart = source.lastIndexOf('let accountLoadTicket', functionStart);
  const end = source.indexOf('\nasync function loadPrefs(', functionStart);
  const upsertStart = source.indexOf('function upsertConversation('), upsertEnd = source.indexOf('\nasync function sendText(', upsertStart);
  const code = source.slice(helperStart < 0 ? functionStart : helperStart, end) + '\n' + source.slice(upsertStart, upsertEnd);
  const actual = new Function(...Object.keys(env), stripTypeScriptTypes(code) + '\nreturn { load: loadForActiveAccount, upsert: upsertConversation };')(...Object.values(env)) as { load: () => Promise<void>; upsert: (c: UiConversation) => void };
  return { ...actual, store, calls, released, owner: (next: AccountContext | null) => { context = next; }, accountState: (next: string) => { accountState = next; }, responses: (next: Record<string, unknown>) => { responses = next; } };
}

test('actual account load retains newer real upserts while unrelated agent read is pending', async () => {
  const f = fixture(), agent = deferred(), old = row('123456'), fresh = { ...old, title: 'FRESH', last_message_time_ms: 9000 }, added = row('223456', 'NEW');
  f.responses({ convs: [old], agent: agent.promise, cats: [] });
  const loading = f.load(); await Promise.resolve(); f.upsert(fresh); f.upsert(added);
  agent.resolve(null); await loading;
  assert.deepEqual(f.store.get().conversations, [fresh, added]);
});

test('actual load never resurrects deleted rows or rolls back an ended conversation', async () => {
  const removed = row('123456'), ending = row('223456'), transient = row('323456');
  const f = fixture([removed, ending]), convs = deferred();
  f.responses({ convs: convs.promise, cats: [] }); const loading = f.load();
  f.upsert({ ...ending, status: 'finished', title: 'ENDED' }); f.upsert(transient);
  f.store.patch({ conversations: f.store.get().conversations.filter((c: UiConversation) => c.gid !== removed.gid && c.gid !== transient.gid) });
  convs.resolve([removed, ending, transient]); await loading;
  assert.deepEqual(f.store.get().conversations, [{ ...ending, status: 'finished', title: 'ENDED' }]);
});

test('actual account load is latest-request-wins including same-scope ABA switches', async () => {
  const f = fixture(), old = deferred(); f.responses({ convs: old.promise, cats: [] }); const first = f.load();
  f.owner({ ...owner, account_id: 'synthetic-other' }); f.responses({ convs: [], cats: [] }); await f.load();
  f.owner(owner); const latest = row('223456', 'LATEST'); f.responses({ convs: [latest], cats: [] }); await f.load();
  old.resolve([row('123456', 'STALE')]); await first; assert.deepEqual(f.store.get().conversations, [latest]);
  const stale = deferred(); f.responses({ convs: stale.promise }); const prior = f.load();
  const newest = row('323456', 'NEWEST'); f.responses({ convs: [newest], cats: [] }); await f.load();
  stale.resolve([latest]); await prior; assert.deepEqual(f.store.get().conversations, [newest]);
});

test('actual load rejects wrong-account/environment/generation snapshot rows and late old generation', async () => {
  const good = row('123456'), foreign = [row('223456', 'FOREIGN', { ...owner, account_id: 'other' }), row('323456', 'FOREIGN', { ...owner, environment: 'other' }), row('423456', 'FOREIGN', { ...owner, session_generation: 2 })];
  const f = fixture(); f.responses({ convs: [good, ...foreign], cats: [] }); await f.load(); assert.deepEqual(f.store.get().conversations, [good]);
  const convs = deferred(); f.responses({ convs: convs.promise }); const pending = f.load(); f.owner({ ...owner, session_generation: 2 });
  f.store.patch({ conversations: [] }); convs.resolve([good]); await pending; assert.deepEqual(f.store.get().conversations, []);
});

test('untouched rows missing from an authoritative snapshot are removed rather than unioned back', async () => {
  const removed = row('123456'), kept = row('223456'); const f = fixture([removed, kept]);
  f.store.patch({ activeGid: removed.gid }); f.responses({ convs: [kept], cats: [] }); await f.load();
  assert.deepEqual(f.store.get().conversations, [kept]); assert.equal(f.store.get().activeGid, null);
});

test('actual superseding loads and completion release observers, including an account becoming unavailable', async () => {
  const f = fixture(), first = deferred(), second = deferred();
  let observers = 0; const subscribe = f.store.subscribe;
  f.store.subscribe = listener => { observers += 1; const stop = subscribe(listener); let active = true; return () => { if (active) { active = false; observers -= 1; stop(); } }; };
  f.responses({ convs: first.promise }); const a = f.load(); assert.equal(observers, 1);
  f.responses({ convs: second.promise }); const b = f.load(); assert.equal(observers, 1);
  first.resolve([]); await a; assert.equal(observers, 1, 'an old completion cannot detach the latest observer');
  second.resolve([]); await b; assert.equal(observers, 0);
  const third = deferred(); f.responses({ convs: third.promise }); const c = f.load(); assert.equal(observers, 1);
  f.owner(null); await f.load(); assert.equal(observers, 0);
  f.owner(owner); third.resolve([row('123456')]); await c; assert.deepEqual(f.store.get().conversations, []);
});


test('actual failed conversation refresh preserves current rows, active room and attachment with explicit retry state', async () => {
  const kept = row('123456'), f = fixture([kept]), attachment = { attachment_id: 'current' };
  f.store.patch({ activeGid: kept.gid, attachment, draft: 'unsent' });
  f.responses({ convs: null }); await f.load();
  assert.deepEqual(f.store.get().conversations, [kept]); assert.equal(f.store.get().activeGid, kept.gid); assert.equal(f.store.get().attachment, attachment); assert.equal(f.store.get().draft, 'unsent');
  assert.ok(f.store.get().conversationsError); assert.equal(f.store.get().conversationsLoading, false); assert.deepEqual(f.released, []);
  assert.deepEqual(f.calls, ['convs', 'agent', 'net']);
});

test('first-load failures are distinguishable from a confirmed empty list, and a successful retry clears the error', async () => {
  for (const failed of [null, undefined, {}, [{}], new Error('synthetic private transport error')]) {
    const f = fixture(); f.responses({ convs: failed }); await f.load();
    assert.deepEqual(f.store.get().conversations, []); assert.ok(f.store.get().conversationsError); assert.equal(f.store.get().conversationsLoading, false);
    f.responses({ convs: [] }); await f.load(); assert.equal(f.store.get().conversationsError, null); assert.deepEqual(f.store.get().conversations, []);
    const fresh = row('223456'); f.responses({ convs: [fresh] }); await f.load(); assert.deepEqual(f.store.get().conversations, [fresh]); assert.equal(f.store.get().conversationsError, null);
    assert.ok(f.calls.every(command => ['convs', 'agent', 'net'].includes(command)), 'retry does not send or mark read');
  }
});

test('an account still restoring or logging in is not read and shows no list failure', async () => {
  for (const state of ['suspended', 'logging_in', 'expired']) {
    const kept = row('123456'), f = fixture([kept]); f.accountState(state); f.store.patch({ conversationsError: 'previous', conversationsLoading: true }); f.responses({ convs: null });
    await f.load();
    assert.deepEqual(f.calls.filter(command => command === 'convs'), [], state);
    assert.equal(f.store.get().conversationsError, null, state); assert.equal(f.store.get().conversationsLoading, false, state);
    assert.deepEqual(f.store.get().conversations, [kept], state);
  }
  const f = fixture(); f.accountState('online'); f.responses({ convs: null }); await f.load();
  assert.ok(f.store.get().conversationsError, 'a read refused while online is still reported');
});

test('late failed reads cannot replace a newer successful refresh or contaminate an A→B→A visit', async () => {
  const f = fixture([row('123456')]), first = deferred(); f.responses({ convs: first.promise }); const old = f.load();
  f.owner({ ...owner, account_id: 'b' }); f.store.patch({ conversations: [], conversationsError: null, conversationsLoading: false }); f.responses({ convs: null }); await f.load();
  f.owner(owner); const latest = row('223456'); f.responses({ convs: [latest] }); await f.load(); const state = f.store.get();
  first.resolve(null); await old; assert.equal(f.store.get(), state); assert.equal(f.store.get().conversationsError, null); assert.deepEqual(f.store.get().conversations, [latest]);
});

test('failed refresh observes latest realtime rows and removals without retaining a foreign account list', async () => {
  const stale = row('123456'), f = fixture([stale]), pending = deferred(); f.responses({ convs: pending.promise }); const loading = f.load();
  const newer = row('223456', 'LIVE'); f.upsert(newer); f.store.patch({ conversations: [newer] }); pending.resolve(null); await loading;
  assert.deepEqual(f.store.get().conversations, [newer]); assert.ok(f.store.get().conversationsError);
  f.owner({ ...owner, session_generation: 2 }); f.responses({ convs: null }); await f.load(); assert.deepEqual(f.store.get().conversations, []);
});


test('a late successful list cannot clear the newest failure or loading state', async () => {
  const f = fixture([row('123456')]), old = deferred(); f.responses({ convs: old.promise }); const before = f.load();
  f.responses({ convs: null }); await f.load(); const failed = f.store.get(); assert.ok(failed.conversationsError);
  old.resolve([]); await before; assert.equal(f.store.get(), failed);
  const pending = deferred(); f.responses({ convs: pending.promise }); const retry = f.load(); assert.equal(f.store.get().conversationsLoading, true); assert.equal(f.store.get().conversationsError, null);
  pending.resolve([]); await retry; assert.deepEqual(f.store.get().conversations, []); assert.equal(f.store.get().conversationsLoading, false); assert.equal(f.store.get().conversationsError, null);
});

test('generation mismatch on failure cannot retain an old-account room or its attachment and observers are cleaned', async () => {
  const f = fixture([row('123456')]), attachment = { attachment_id: 'old-generation' };
  f.store.patch({ activeGid: '123456', attachment }); f.owner({ ...owner, session_generation: 2 }); f.responses({ convs: null }); await f.load();
  assert.deepEqual(f.store.get().conversations, []); assert.equal(f.store.get().activeGid, null); assert.equal(f.store.get().attachment, null); assert.deepEqual(f.released, [attachment]); assert.ok(f.store.get().conversationsError);
  f.owner(null); await f.load(); assert.equal(f.store.get().conversationsLoading, false); assert.equal(f.store.get().conversationsError, null);
});
