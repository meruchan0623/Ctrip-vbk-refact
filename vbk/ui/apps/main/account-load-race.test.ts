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
  const store = createStore<Record<string, any>>({ conversations: initial, activeGid: null, attachment: null, noticeCats: [], noticeCat: null, agent: null, net: null });
  let responses: Record<string, unknown> = {};
  const env = { store, S: () => store.get(), activeAccount: () => context ? { context } : null,
    stillActive: (account: AccountContext) => !!context && sameAccount(account, context) && account.session_generation === context.session_generation,
    sameAccount, isUiConversation, isUiAgentStatus, isUiNetStatus,
    invokeQuiet: async (command: string) => await responses[command],
    UiCommands: { IM_CONVERSATIONS: 'convs', ACCOUNT_AGENT_STATUS: 'agent', NET_STATUS: 'net', NOTICE_CATEGORIES: 'cats', IM_MARK_READ: 'read' },
    releaseAttachment: async () => undefined, loadNotices: async () => undefined, document: { visibilityState: 'hidden' } };
  const functionStart = source.indexOf('async function loadForActiveAccount():');
  const helperStart = source.lastIndexOf('let accountLoadTicket', functionStart);
  const end = source.indexOf('\nasync function loadNotices(', functionStart);
  const upsertStart = source.indexOf('function upsertConversation('), upsertEnd = source.indexOf('\nasync function sendText(', upsertStart);
  const code = source.slice(helperStart < 0 ? functionStart : helperStart, end) + '\n' + source.slice(upsertStart, upsertEnd);
  const actual = new Function(...Object.keys(env), stripTypeScriptTypes(code) + '\nreturn { load: loadForActiveAccount, upsert: upsertConversation };')(...Object.values(env)) as { load: () => Promise<void>; upsert: (c: UiConversation) => void };
  return { ...actual, store, owner: (next: AccountContext | null) => { context = next; }, responses: (next: Record<string, unknown>) => { responses = next; } };
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
