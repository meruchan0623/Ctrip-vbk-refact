import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { createDraftBook, createIpcDraftPort, draftOwnerKey } from './draft-book.ts';
import type { DraftMap, DraftOwner, DraftPort } from './draft-book.ts';
import { createStore } from '../../packages/ui-kit/src/store.ts';
import { sameAccount } from './viewmodel.ts';
import { ImCommands } from '../../packages/ipc/src/commands.ts';
import { createDraftFailureNotice } from './draft-notice.ts';

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
    if (command === 'draft_load') return { drafts: [{ gid: 'room', text: 'stored', version: 4, attachment_version: 8, attachments: [] }] };
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
  await assert.rejects(none.load(A), { message: 'draft.account_unavailable' });
  await assert.rejects(none.save(A, 'room', 'x'), { message: 'draft.account_unavailable' });
});

test('real main wiring: store drafts are persisted per account, restored on switch back, and never leak across accounts', async () => {
  const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  const a = source.indexOf('const draftBook = createDraftBook('), b = source.indexOf("window.addEventListener('pagehide'", a);
  assert.ok(a >= 0 && b > a);
  assert.match(source.slice(a, b), /ImCommands\.DRAFT_LOAD/);
  assert.match(source.slice(a, b), /ImCommands\.DRAFT_SAVE/);
  const ctx = (id: string, generation = 1) => ({ account_id: id, environment: 'prod', session_generation: generation });
  const accounts = (id: string, generation = 1) => ({ active_account_id: id, accounts: [{ context: ctx(id, generation), state: 'online' }] });
  const store = createStore<any>({ accounts: accounts('agent-A'), drafts: {}, draft: '', draftVersion: 0, activeGid: 'room' });
  const port = memoryPort();
  const env: Record<string, unknown> = {
    draftFailureNotice: createDraftFailureNotice({ notify: () => {}, retry: () => {} }),
    ImCommands, ipc: { invoke: async () => ({}) }, store, S: () => store.get(), sameAccount,
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

/**
 * A stand-in for the host's `im_draft_load` / `im_draft_save` (src-tauri/src/features/draft.rs over
 * core-store `DraftBook`): per (environment, account_id, gid) versions, first save = 1, a stale
 * `expected_version` rejects with `store.cas_conflict`, empty text deletes and resets to 0.
 */
function hostDraftStore() {
  const rows = new Map<string, Map<string, { text: string; version: number }>>();
  const calls: { command: string; payload: any }[] = [];
  const nsKey = (account: any) => `${account.environment}/${account.account_id}`;
  const invoke = async (command: string, rawPayload: unknown): Promise<unknown> => {
    const payload = rawPayload as any;
    calls.push({ command, payload });
    const ns = rows.get(nsKey(payload.account)) ?? new Map<string, { text: string; version: number }>();
    rows.set(nsKey(payload.account), ns);
    if (command === ImCommands.DRAFT_LOAD) return { drafts: [...ns].map(([gid, r]) => ({ gid, text: r.text, version: r.version })) };
    if (command !== ImCommands.DRAFT_SAVE) throw new Error(`unexpected command ${command}`);
    const current = ns.get(payload.gid)?.version ?? 0;
    if (current !== payload.expected_version) throw Object.assign(new Error(`draft version is ${current}, expected ${payload.expected_version}`), { code: 'store.cas_conflict', retryable: false });
    if (payload.text === '') { ns.delete(payload.gid); return { version: 0 }; }
    ns.set(payload.gid, { text: payload.text, version: current + 1 });
    return { version: current + 1 };
  };
  return { rows, calls, invoke, texts: (account: DraftOwner) => Object.fromEntries([...(rows.get(nsKey(account)) ?? [])].map(([g, r]) => [g, r.text])) };
}
const realCommands = { load: ImCommands.DRAFT_LOAD, save: ImCommands.DRAFT_SAVE };
const withGeneration = (owner: DraftOwner) => ({ ...owner, session_generation: 1 });

test('host contract end to end: the book over the IPC port persists, versions, deletes and restores across a restart', async () => {
  const host = hostDraftStore();
  const first = createDraftBook(createIpcDraftPort(host.invoke, realCommands, withGeneration));
  first.write(A, '1001', 'hello');
  first.write(A, '1002', 'short lived');
  await first.flush();
  first.write(A, '1001', 'hello again');
  first.write(A, '1002', '');
  await first.flush();
  assert.deepEqual(host.texts(A), { '1001': 'hello again' });
  assert.equal(host.rows.get('prod/agent-A')!.get('1001')!.version, 2, 'two saves, versions 1 then 2');
  const saves = host.calls.filter(c => c.command === ImCommands.DRAFT_SAVE);
  assert.deepEqual(saves.map(c => c.payload.expected_version), [0, 0, 1, 1], 'each save presents the version it last learned');
  assert.equal(saves[0]!.command, 'im_draft_save');
  // Restart: a fresh port has no versions; it learns them from the load.
  const second = createDraftBook(createIpcDraftPort(host.invoke, realCommands, withGeneration));
  assert.deepEqual(await second.restore(A), { '1001': 'hello again' });
  second.write(A, '1001', 'after restart');
  await second.flush();
  assert.deepEqual(host.calls.at(-1)!.payload, { account: withGeneration(A), gid: '1001', text: 'after restart', expected_version: 2 });
  assert.equal(host.rows.get('prod/agent-A')!.get('1001')!.version, 3);
});

test('host contract end to end: a second window saving first yields store.cas_conflict, the port reloads and the last writer wins', async () => {
  const host = hostDraftStore();
  const errors: unknown[] = [];
  const windowOne = createDraftBook(createIpcDraftPort(host.invoke, realCommands, withGeneration), { onError: e => errors.push(e) });
  const windowTwo = createDraftBook(createIpcDraftPort(host.invoke, realCommands, withGeneration), { onError: e => errors.push(e) });
  await windowOne.restore(A); await windowTwo.restore(A);
  windowTwo.write(A, '1001', 'from window two'); await windowTwo.flush();
  windowOne.write(A, '1001', 'from window one'); await windowOne.flush();
  assert.equal(errors.length, 0, 'the conflict is absorbed by the port, not surfaced');
  assert.deepEqual(host.texts(A), { '1001': 'from window one' });
  const saves = host.calls.filter(c => c.command === ImCommands.DRAFT_SAVE).map(c => c.payload.expected_version);
  assert.deepEqual(saves, [0, 0, 1], 'window one: stale 0 → conflict → reload → 1');
  assert.equal(host.calls.filter(c => c.command === ImCommands.DRAFT_LOAD).length, 3, 'two restores plus the reload after the conflict');
  // A conflict that persists after the reload is a real error and stays dirty.
  let poison = true;
  const flaky = createDraftBook(createIpcDraftPort(async (c, p) => { if (c === ImCommands.DRAFT_SAVE && poison) throw Object.assign(new Error('cas'), { code: 'store.cas_conflict' }); return host.invoke(c, p); }, realCommands, withGeneration), { onError: e => errors.push(e) });
  flaky.write(A, '1001', 'never lands'); await flaky.flush();
  assert.equal(errors.length, 1); assert.equal((errors[0] as any).code, 'store.cas_conflict'); assert.equal(flaky.pending, 1);
  poison = false; await flaky.flush();
  assert.equal(flaky.pending, 0); assert.deepEqual(host.texts(A), { '1001': 'never lands' });
});

test('host contract end to end: accounts and environments never see each other\'s drafts', async () => {
  const host = hostDraftStore();
  const book = createDraftBook(createIpcDraftPort(host.invoke, realCommands, withGeneration));
  const uatA: DraftOwner = { environment: 'uat', account_id: 'agent-A' };
  book.write(A, '1001', 'prod A'); book.write(B, '1001', 'prod B'); book.write(uatA, '1001', 'uat A');
  await book.flush();
  const again = createDraftBook(createIpcDraftPort(host.invoke, realCommands, withGeneration));
  assert.deepEqual(await again.restore(A), { '1001': 'prod A' });
  assert.deepEqual(await again.restore(B), { '1001': 'prod B' });
  assert.deepEqual(await again.restore(uatA), { '1001': 'uat A' });
  for (const c of host.calls) assert.deepEqual(Object.keys(c.payload.account).sort(), ['account_id', 'environment', 'session_generation']);
});

test('actual port and book retain dirty text without an account context and persist on a later explicit flush', async () => {
  const host = hostDraftStore(), errors: unknown[] = [];
  let generation: number | null = 1;
  const book = createDraftBook(createIpcDraftPort(host.invoke, realCommands, owner => generation === null ? null : { ...owner, session_generation: generation }), { ...manualTimers(), onError: error => errors.push(error) });
  await book.restore(A); book.write(A, 'room', 'private unsaved text');
  assert.equal(book.pending, 1);
  generation = null; await book.flush();
  assert.equal(book.pending, 1); assert.deepEqual(book.read(A), { room: 'private unsaved text' });
  assert.deepEqual(host.calls.map(call => call.command), [ImCommands.DRAFT_LOAD]);
  assert.equal(errors.length, 1); assert.equal((errors[0] as Error).message, 'draft.account_unavailable');
  assert.equal(String(errors[0]).includes('private unsaved text'), false);
  generation = 2; await book.flush();
  assert.equal(book.pending, 0); assert.deepEqual(host.texts(A), { room: 'private unsaved text' });
  assert.deepEqual(host.calls.at(-1)?.payload, { account: { ...A, session_generation: 2 }, gid: 'room', text: 'private unsaved text', expected_version: 0 });
});

test('missing-context load is retryable and never makes an unread account a confirmed empty draft set', async () => {
  const host = hostDraftStore(), errors: unknown[] = [];
  await host.invoke(ImCommands.DRAFT_SAVE, { account: withGeneration(A), gid: 'stored', text: 'persisted', expected_version: 0 });
  await host.invoke(ImCommands.DRAFT_SAVE, { account: withGeneration(A), gid: 'edited', text: 'older stored text', expected_version: 0 });
  let present = false;
  const port = createIpcDraftPort(host.invoke, realCommands, owner => present ? withGeneration(owner) : null);
  const book = createDraftBook(port, { ...manualTimers(), onError: error => errors.push(error) });
  await assert.rejects(port.load(A), { message: 'draft.account_unavailable' });
  assert.deepEqual(await book.restore(A), {}); assert.equal(errors.length, 1);
  assert.equal(host.calls.filter(call => call.command === ImCommands.DRAFT_LOAD).length, 0);
  book.write(A, 'edited', 'typed while unavailable');
  present = true;
  assert.deepEqual(await book.restore(A), { stored: 'persisted', edited: 'typed while unavailable' });
  await book.flush(); assert.equal(book.pending, 0);
  assert.deepEqual(host.texts(A), { stored: 'persisted', edited: 'typed while unavailable' });
  assert.equal(host.calls.at(-1)?.payload.expected_version, 1);
});

test('absent owner cannot borrow another account context and an explicit clear stays dirty across disappearance', async () => {
  const host = hostDraftStore(), timers = manualTimers();
  let current: DraftOwner | null = A;
  const context = (owner: DraftOwner) => current && draftOwnerKey(current) === draftOwnerKey(owner) ? withGeneration(owner) : null;
  const book = createDraftBook(createIpcDraftPort(host.invoke, realCommands, context), timers);
  book.write(A, 'room', 'stored for A'); await book.flush();
  book.write(A, 'room', ''); current = B; book.write(B, 'room', 'stored for B'); await book.flush();
  assert.equal(book.pending, 1); assert.deepEqual(host.texts(A), { room: 'stored for A' }); assert.deepEqual(host.texts(B), { room: 'stored for B' });
  current = null; await book.flush(); assert.equal(book.pending, 1);
  current = A; await book.flush(); assert.equal(book.pending, 0); assert.deepEqual(host.texts(A), {}); assert.deepEqual(host.texts(B), { room: 'stored for B' });
  assert.deepEqual(book.read(A), {});
});

test('actual port and book reject malformed draft load replies without partial cache or version updates', async () => {
  const invalidReplies: unknown[] = [
    null,
    undefined,
    [],
    {},
    { drafts: null },
    { drafts: {} },
    { drafts: [null] },
    { drafts: [{ gid: '1001', text: 'missing version' }] },
    ...[NaN, Infinity, -Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1].map(version => ({ drafts: [{ gid: '1001', text: 'MUST_NOT_LEAK', version }] })),
    { drafts: [{ gid: '1001', text: 'MUST_NOT_LEAK', version: 9 }, { gid: 7, text: 'bad row', version: 1 }] },
  ];
  for (const invalidReply of invalidReplies) {
    const errors: unknown[] = [], calls: { command: string; payload: any }[] = [];
    const port = createIpcDraftPort(async (command, payload) => {
      calls.push({ command, payload });
      if (command === ImCommands.DRAFT_LOAD) return invalidReply;
      return { version: 1 };
    }, realCommands, withGeneration);
    const book = createDraftBook(port, { ...manualTimers(), onError: error => errors.push(error) });
    book.write(A, 'local', 'private text');
    assert.deepEqual(await book.restore(A), { local: 'private text' });
    assert.deepEqual(book.read(A), { local: 'private text' });
    assert.equal(errors.length, 1);
    assert.equal((errors[0] as Error).message, 'draft.invalid_load_response');
    assert.equal(String(errors[0]).includes('MUST_NOT_LEAK'), false);
    await book.flush();
    assert.equal(book.pending, 0);
    assert.equal(calls.filter(call => call.command === ImCommands.DRAFT_SAVE).length, 1);
    assert.equal(calls.at(-1)?.payload.expected_version, 0);
  }

  let reply: unknown = { drafts: [{ gid: '1001', text: 'known text', version: 4 }] };
  const saves: any[] = [];
  const port = createIpcDraftPort(async (command, payload) => {
    if (command === ImCommands.DRAFT_LOAD) return reply;
    const savePayload = payload as { expected_version: number };
    saves.push(savePayload);
    return { version: savePayload.expected_version + 1 };
  }, realCommands, withGeneration);
  assert.deepEqual(await port.load(A), { '1001': 'known text' });
  reply = { drafts: [{ gid: '1001', text: 'partial text', version: 99 }, { gid: '1002', text: 'bad row', version: NaN }] };
  const invalidError = await port.load(A).then(() => null, error => error);
  assert.equal((invalidError as Error).message, 'draft.invalid_load_response');
  assert.equal(String(invalidError).includes('partial text'), false);
  await port.save(A, '1001', 'new text');
  assert.equal(saves[0]!.expected_version, 4, 'the valid first row did not partially replace the cached version');
});

test('invalid save acknowledgements keep dirty text for a later valid flush, including clear version zero', async () => {
  const invalidReplies: unknown[] = [null, undefined, [], {}, { version: '1' }, ...[NaN, Infinity, -Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1].map(version => ({ version }))];
  for (const invalidReply of invalidReplies) {
    let saveReply: unknown = invalidReply;
    const errors: unknown[] = [], calls: { command: string; payload: any }[] = [];
    const port = createIpcDraftPort(async (command, payload) => {
      calls.push({ command, payload });
      if (command === ImCommands.DRAFT_LOAD) return { drafts: [] };
      return saveReply;
    }, realCommands, withGeneration);
    const book = createDraftBook(port, { ...manualTimers(), onError: error => errors.push(error) });
    book.write(A, '1001', 'private unsaved text');
    await book.flush();
    assert.equal(book.pending, 1);
    assert.deepEqual(book.read(A), { '1001': 'private unsaved text' });
    assert.equal(errors.length, 1);
    assert.equal((errors[0] as Error).message, 'draft.invalid_save_response');
    assert.equal(String(errors[0]).includes('private unsaved text'), false);
    assert.equal(calls.filter(call => call.command === ImCommands.DRAFT_SAVE).length, 1, 'a malformed acknowledgement is not replayed automatically');

    saveReply = { version: 1, attachment_version: 6 };
    await book.flush();
    assert.equal(book.pending, 0);
    assert.equal(calls.at(-1)?.payload.expected_version, 0);

    book.write(A, '1001', '');
    saveReply = { version: 0 };
    await book.flush();
    assert.equal(book.pending, 0, 'version zero is a valid delete acknowledgement');
  }
});

test('a CAS conflict with a malformed reload is surfaced without a second save attempt', async () => {
  let saveCalls = 0, loadCalls = 0, reload: unknown = null;
  const errors: unknown[] = [];
  const port = createIpcDraftPort(async command => {
    if (command === ImCommands.DRAFT_LOAD) { loadCalls++; return reload; }
    saveCalls++;
    if (saveCalls === 1) throw Object.assign(new Error('stale'), { code: 'store.cas_conflict' });
    return { version: 1 };
  }, realCommands, withGeneration);
  const book = createDraftBook(port, { ...manualTimers(), onError: error => errors.push(error) });
  book.write(A, '1001', 'keep me dirty');
  await book.flush();
  assert.equal(saveCalls, 1);
  assert.equal(loadCalls, 1);
  assert.equal(book.pending, 1);
  assert.equal((errors[0] as Error).message, 'draft.invalid_load_response');

  reload = { drafts: [] };
  await book.flush();
  assert.equal(saveCalls, 2, 'a later explicit flush can retry the still-dirty value');
  assert.equal(loadCalls, 1);
  assert.equal(book.pending, 0);
});

test('a CAS reload that finds an externally cleared draft resets only that owner version before retry', async () => {
  const rows = new Map<string, Map<string, { text: string; version: number }>>([
    ['prod/agent-A', new Map([['1001', { text: 'A old', version: 1 }]])],
    ['prod/agent-B', new Map([['1001', { text: 'B old', version: 7 }]])],
  ]);
  const calls: { command: string; payload: any }[] = [];
  const invoke = async (command: string, rawPayload: unknown): Promise<unknown> => {
    const payload = rawPayload as any;
    calls.push({ command, payload });
    const key = `${payload.account.environment}/${payload.account.account_id}`;
    const ns = rows.get(key)!;
    if (command === ImCommands.DRAFT_LOAD) {
      return { drafts: [...ns].map(([gid, draft]) => ({ gid, ...draft })) };
    }
    if (command !== ImCommands.DRAFT_SAVE) throw new Error(`unexpected command ${command}`);
    const current = ns.get(payload.gid)?.version ?? 0;
    if (current !== payload.expected_version) throw Object.assign(new Error('store.cas_conflict'), { code: 'store.cas_conflict' });
    if (payload.text === '') { ns.delete(payload.gid); return { version: 0 }; }
    const version = current + 1;
    ns.set(payload.gid, { text: payload.text, version });
    return { version };
  };
  const port = createIpcDraftPort(invoke, realCommands, withGeneration);
  assert.deepEqual(await port.load(A), { '1001': 'A old' });
  assert.deepEqual(await port.load(B), { '1001': 'B old' });

  // A second window clears A after this port learned version 1.
  assert.deepEqual(await invoke(ImCommands.DRAFT_SAVE, { account: withGeneration(A), gid: '1001', text: '', expected_version: 1 }), { version: 0 });
  await port.save(A, '1001', 'A after clear');
  await port.save(B, '1001', 'B after load');

  const saves = calls.filter(call => call.command === ImCommands.DRAFT_SAVE).map(call => [call.payload.account.account_id, call.payload.text, call.payload.expected_version]);
  assert.deepEqual(saves, [
    ['agent-A', '', 1],
    ['agent-A', 'A after clear', 1],
    ['agent-A', 'A after clear', 0],
    ['agent-B', 'B after load', 7],
  ]);
  assert.deepEqual(rows.get('prod/agent-A')!.get('1001'), { text: 'A after clear', version: 1 });
  assert.deepEqual(rows.get('prod/agent-B')!.get('1001'), { text: 'B after load', version: 8 });
});
