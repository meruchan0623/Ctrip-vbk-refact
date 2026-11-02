import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { createDraftBook, createIpcDraftPort, draftOwnerKey } from './draft-book.ts';
import type { DraftMap, DraftOwner, DraftPort } from './draft-book.ts';
import { createStore } from '../../packages/ui-kit/src/store.ts';
import { sameAccount } from './viewmodel.ts';

const A: DraftOwner = { environment: 'prod', account_id: 'agent-A' };
const B: DraftOwner = { environment: 'prod', account_id: 'agent-B' };

/** A disk stand-in that survives book instances ("restart"). */
function memoryPort(disk = new Map<string, Map<string, string>>(), hooks: { failSaves?: number; loadDelay?: Promise<void> } = {}): DraftPort & { disk: typeof disk; saves: string[] } {
  const saves: string[] = [];
  return {
    disk, saves,
    async load(owner) { await hooks.loadDelay; return Object.fromEntries(disk.get(draftOwnerKey(owner)) ?? []); },
    async save(owner, gid, text) {
      if (hooks.failSaves) { hooks.failSaves--; throw new Error('disk full'); }
      saves.push(`${owner.account_id}/${gid}=${text}`);
      const k = draftOwnerKey(owner), rows = disk.get(k) ?? new Map<string, string>();
      if (text === '') rows.delete(gid); else rows.set(gid, text);
      disk.set(k, rows);
    },
  };
}
const manualTimers = () => { const queue: (() => void)[] = []; return { setTimer: (fn: () => void) => { queue.push(fn); return queue.length; }, clearTimer: () => { queue.length = 0; }, fire: () => queue.splice(0).forEach(f => f()) }; };

test('after a restart every saved draft comes back, 10/10', async () => {
  for (let run = 0; run < 10; run++) {
    const port = memoryPort();
    const first = createDraftBook(port);
    first.write(A, `room-${run}`, `draft ${run}`);
    first.write(A, 'other', 'keep me');
    await first.flush();
    const second = createDraftBook(port); // new process
    assert.deepEqual(await second.restore(A), { [`room-${run}`]: `draft ${run}`, other: 'keep me' });
  }
});

test('drafts are keyed by account and conversation: accounts never see each other, generations do not matter', async () => {
  const port = memoryPort(), book = createDraftBook(port);
  book.write(A, 'room', 'for A'); book.write(B, 'room', 'for B');
  await book.flush();
  const again = createDraftBook(port);
  assert.deepEqual(await again.restore(A), { room: 'for A' });
  assert.deepEqual(await again.restore(B), { room: 'for B' });
  assert.equal(draftOwnerKey({ ...A, ...({ session_generation: 7 } as object) }), draftOwnerKey(A), 'the session generation is not part of the identity');
  assert.notEqual(draftOwnerKey(A), draftOwnerKey({ ...A, environment: 'uat' }));
});

test('a deliberate clear is persisted and is not resurrected by an older stored draft', async () => {
  const port = memoryPort(new Map([[draftOwnerKey(A), new Map([['room', 'old text']])]]));
  const book = createDraftBook(port);
  book.write(A, 'room', ''); // cleared before the load answered
  assert.deepEqual(await book.restore(A), {});
  await book.flush();
  assert.deepEqual(await createDraftBook(port).restore(A), {});
});

test('text typed while the load is in flight wins over the stored text', async () => {
  let release!: () => void;
  const port = memoryPort(new Map([[draftOwnerKey(A), new Map([['room', 'stored'], ['untouched', 'stored too']])]]), { loadDelay: new Promise<void>(r => { release = r; }) });
  const book = createDraftBook(port);
  const restoring = book.restore(A);
  book.write(A, 'room', 'typed now');
  release();
  assert.deepEqual(await restoring, { room: 'typed now', untouched: 'stored too' });
});

test('saves are debounced and coalesced to the last text per conversation', async () => {
  const timers = manualTimers(), port = memoryPort();
  const book = createDraftBook(port, timers);
  for (const text of ['h', 'he', 'hel', 'hello']) book.write(A, 'room', text);
  assert.equal(book.pending, 1);
  assert.deepEqual(port.saves, []);
  timers.fire(); await book.flush();
  assert.deepEqual(port.saves, ['agent-A/room=hello']);
});

test('a failing port never blocks typing; the draft stays dirty and the next flush retries', async () => {
  const errors: unknown[] = [], port = memoryPort(new Map(), { failSaves: 1 });
  const book = createDraftBook(port, { onError: e => errors.push(e) });
  book.write(A, 'room', 'important');
  await book.flush();
  assert.equal(errors.length, 1);
  assert.equal(book.pending, 1);
  assert.deepEqual(book.read(A), { room: 'important' }, 'still readable in memory');
  await book.flush();
  assert.equal(book.pending, 0);
  assert.deepEqual([...(port.disk.get(draftOwnerKey(A)) ?? [])], [['room', 'important']]);
});

test('without a port the book still keeps drafts for the renderer lifetime', async () => {
  const book = createDraftBook(null);
  book.write(A, 'room', 'in memory');
  assert.deepEqual(await book.restore(A), { room: 'in memory' });
  assert.equal(book.pending, 0);
  await book.flush();
});

test('IPC port speaks the core-store draft contract: versions, deletes, and one CAS-conflict retry', async () => {
  const calls: { command: string; payload: any }[] = [];
  let conflict = true;
  const context = (owner: DraftOwner) => ({ ...owner, session_generation: 3 });
  const port = createIpcDraftPort(async (command, rawPayload) => {
    const payload = rawPayload as any;
    calls.push({ command, payload });
    if (command === 'draft_load') return { drafts: [{ gid: 'room', text: 'stored', version: 4 }, { gid: 7, text: 'bad' }] };
    if (conflict) { conflict = false; throw Object.assign(new Error('cas'), { code: 'store.cas_conflict' }); }
    return { version: payload.expected_version + 1 };
  }, { load: 'draft_load', save: 'draft_save' }, context);
  assert.deepEqual(await port.load(A), { room: 'stored' });
  await port.save(A, 'room', 'next');
  const saves = calls.filter(c => c.command === 'draft_save');
  assert.equal(saves.length, 2, 'retried once after the conflict');
  assert.equal(saves[0]!.payload.expected_version, 4);
  assert.deepEqual(saves[1]!.payload, { account: context(A), gid: 'room', text: 'next', expected_version: 4 });
  await port.save(A, 'room', '');
  assert.equal(calls.at(-1)!.payload.expected_version, 5);
  assert.equal(calls.at(-1)!.payload.text, '');
  const none = createIpcDraftPort(async () => { throw new Error('must not be called'); }, { load: 'l', save: 's' }, () => null);
  assert.deepEqual(await none.load(A), {}); await none.save(A, 'room', 'x');
});

test('real main wiring: store drafts are persisted per account, restored on switch back, and never leak across accounts', async () => {
  const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  const a = source.indexOf('const draftCommands'), b = source.indexOf("window.addEventListener('pagehide'", a);
  assert.ok(a >= 0 && b > a);
  const ctx = (id: string, generation = 1) => ({ account_id: id, environment: 'prod', session_generation: generation });
  const accounts = (id: string, generation = 1) => ({ active_account_id: id, accounts: [{ context: ctx(id, generation), state: 'online' }] });
  const store = createStore<any>({ accounts: accounts('agent-A'), drafts: {}, draft: '', draftVersion: 0, activeGid: 'room' });
  const port = memoryPort();
  const env: Record<string, unknown> = {
    UiCommands: { DRAFT_LOAD: 'draft_load', DRAFT_SAVE: 'draft_save' }, ipc: { invoke: async () => ({}) }, store, S: () => store.get(), sameAccount,
    activeAccount: (s = store.get()) => s.accounts.accounts.find((x: any) => x.context.account_id === s.accounts.active_account_id) ?? null,
    stillActive: (account: any) => { const x = store.get().accounts.accounts.find((y: any) => y.context.account_id === store.get().accounts.active_account_id); return !!x && x.context.account_id === account.account_id && x.context.session_generation === account.session_generation; },
    createDraftBook: (p: DraftPort | null, o?: object) => createDraftBook(port, { ...o, delayMs: 0 }), createIpcDraftPort: () => port, window: { addEventListener() {} }, document: { addEventListener() {}, visibilityState: 'visible' },
  };
  const book = new Function(...Object.keys(env), stripTypeScriptTypes(source.slice(a, b)) + "\nreturn { draftBook };")(...Object.values(env)).draftBook as ReturnType<typeof createDraftBook>;
  const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  await settle();
  // The agent types in account A (what setDraft / send do to the store).
  store.patch({ drafts: { room: 'for A' }, draft: 'for A' }); await settle();
  assert.deepEqual(book.read(ctx('agent-A')), { room: 'for A' });
  // Switch to account B: the state map resets (ACCOUNT_SCOPED_RESET) and must not be written to B or deleted for A.
  store.patch({ accounts: accounts('agent-B'), drafts: {}, draft: '' }); await settle();
  assert.deepEqual(book.read(ctx('agent-A')), { room: 'for A' }, 'the reset is not a deletion');
  assert.deepEqual(book.read(ctx('agent-B')), {});
  store.patch({ drafts: { room: 'for B' } }); await settle();
  // Back to A (new generation after a re-login): its draft returns without clobbering anything typed.
  store.patch({ accounts: accounts('agent-A', 2), drafts: {}, draft: '' }); await settle();
  assert.deepEqual(store.get().drafts, { room: 'for A' });
  assert.equal(store.get().draft, 'for A', 'the open conversation gets its text back');
  // A deliberate clear after send is persisted as a clear.
  store.patch({ drafts: { room: '' }, draft: '' }); await settle();
  await book.flush();
  assert.deepEqual([...(port.disk.get(draftOwnerKey(ctx('agent-A'))) ?? [])], []);
  assert.deepEqual([...(port.disk.get(draftOwnerKey(ctx('agent-B'))) ?? [])], [['room', 'for B']]);
});
