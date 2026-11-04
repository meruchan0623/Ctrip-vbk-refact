import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { createDraftFailureNotice, type DraftRetryAction } from './draft-notice.ts';
import { createDraftBook } from './draft-book.ts';
import type { DraftOwner, DraftPort } from './draft-book.ts';
import { mainRuntimeStrings } from '../../packages/ui-kit/src/main-runtime/strings.ts';

const A: DraftOwner = { environment: 'prod', account_id: 'agent-A' };
const failureCopy = mainRuntimeStrings['mainRuntime.draftSyncFailed'];
const retryCopy = mainRuntimeStrings['mainRuntime.retryDraftSync'];
type Notice = { readonly message: string; readonly actionLabel: string; readonly retry: DraftRetryAction };
type MainToastAction = { readonly label: string; readonly run: () => void };
type MainToastState = { toast: string | null; toastAction: MainToastAction | null };
const mainSource = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');

function actualToastFunctions() {
  const start = mainSource.indexOf('let toastTimer:');
  const end = mainSource.indexOf('\n/** User-initiated command:', start);
  assert.ok(start >= 0 && end > start, 'main toast implementation exists');
  const state: MainToastState = { toast: null, toastAction: null };
  const announcements: string[] = [];
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  const api = new Function('announce', 'store', 'S', 'setTimeout', 'clearTimeout', 't',
    stripTypeScriptTypes(mainSource.slice(start, end)) + '\nreturn { toast, showDraftSyncNotice, runToastAction };')(
    (text: string) => announcements.push(text),
    { patch: (patch: Partial<MainToastState>) => Object.assign(state, patch) },
    () => state,
    (callback: () => void) => { const id = ++nextTimer; timers.set(id, callback); return id; },
    (id: number) => { timers.delete(id); },
    (key: string) => Object.entries(mainRuntimeStrings).find(([name]) => name === key)?.[1] ?? key,
  ) as {
    toast: (text: string) => void;
    showDraftSyncNotice: (retry: DraftRetryAction) => void;
    runToastAction: (action: MainToastAction) => void;
  };
  return { ...api, state, announcements, timers };
}

function actualRetryDraftSync(env: Record<string, unknown>): () => Promise<void> {
  const start = mainSource.indexOf('async function retryDraftSync(): Promise<void> {');
  const end = mainSource.indexOf('\nstore.subscribe((s, prev) => {', start);
  assert.ok(start >= 0 && end > start, 'main draft retry implementation exists');
  return new Function(...Object.keys(env), stripTypeScriptTypes(mainSource.slice(start, end)) + '\nreturn retryDraftSync;')(...Object.values(env)) as () => Promise<void>;
}

function nextTurn(): Promise<void> { return new Promise(resolve => setImmediate(resolve)); }

function connect(port: DraftPort, options: { now?: () => number; intervalMs?: number } = {}) {
  const notices: Notice[] = [];
  let book!: ReturnType<typeof createDraftBook>;
  const notifier = createDraftFailureNotice({
    ...(options.now ? { now: options.now } : {}),
    ...(options.intervalMs !== undefined ? { intervalMs: options.intervalMs } : {}),
    notify: retry => { notices.push({ message: failureCopy, actionLabel: retryCopy, retry }); },
    retry: async () => { await book.restore(A); await book.flush(); },
  });
  book = createDraftBook(port, {
    setTimer: () => 'manual', clearTimer: () => undefined,
    onError: notifier.onError,
  });
  return { book, notices };
}

test('the real DraftBook failure callback keeps dirty text, hides errors, rate-limits notices, and edits retry saving', async () => {
  let failures = 1;
  const saves: string[] = [];
  const port: DraftPort = {
    async load() { return {}; },
    async save(_owner, _gid, text) {
      if (failures-- > 0) throw new Error('SECRET /private/customer/draft.txt');
      saves.push(text);
    },
  };
  const { book, notices } = connect(port, { now: () => 100, intervalMs: 5000 });
  await book.restore(A);
  book.write(A, 'room', 'private unsaved body');
  await book.flush();

  assert.equal(book.pending, 1);
  assert.deepEqual(book.read(A), { room: 'private unsaved body' });
  assert.deepEqual(notices.map(({ message, actionLabel }) => ({ message, actionLabel })), [{ message: failureCopy, actionLabel: retryCopy }]);
  assert.equal(JSON.stringify(notices).includes('SECRET'), false);
  assert.equal(JSON.stringify(notices).includes('/private/customer'), false);
  assert.equal(JSON.stringify(notices).includes('private unsaved body'), false);

  book.write(A, 'room', 'private unsaved body revised');
  await book.flush();
  assert.equal(book.pending, 0);
  assert.deepEqual(saves, ['private unsaved body revised']);
  assert.equal(notices.length, 1, 'rapid failure callbacks do not toast once per edit');

  failures = 2;
  book.write(A, 'room-2', 'another unsaved body');
  await book.flush();
  assert.equal(book.pending, 1);
  assert.equal(notices.length, 1, 'another automatic failure inside the interval stays rate-limited');
  await notices[0]!.retry();
  assert.equal(book.pending, 1);
  assert.equal(notices.length, 2, 'a failed explicit save retry is reported immediately');
  await notices[1]!.retry();
  assert.equal(book.pending, 0);
  assert.deepEqual(saves, ['private unsaved body revised', 'another unsaved body']);
  assert.equal(notices.length, 2, 'a successful save does not show an unverified success message');
});

test('a load failure is generic and the notice action explicitly retries loading', async () => {
  let loads = 0;
  const port: DraftPort = {
    async load() {
      loads++;
      if (loads === 1) throw new Error('SECRET load /private/profile.json');
      return { room: 'previously stored draft' };
    },
    async save() {},
  };
  const { book, notices } = connect(port);
  assert.deepEqual(await book.restore(A), {});
  assert.equal(notices.length, 1);
  assert.deepEqual({ message: notices[0]!.message, actionLabel: notices[0]!.actionLabel }, { message: failureCopy, actionLabel: retryCopy });
  assert.equal(JSON.stringify(notices).includes('SECRET'), false);
  assert.equal(JSON.stringify(notices).includes('/private/profile.json'), false);

  await notices[0]!.retry();
  assert.equal(loads, 2);
  assert.deepEqual(book.read(A), { room: 'previously stored draft' });
  assert.equal(notices.length, 1, 'successful retry does not claim that the draft was saved');
});

test('repeated failures during explicit retry show again immediately and concurrent retry clicks are guarded', async () => {
  let now = 100;
  let retryCalls = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const notices: Notice[] = [];
  const notice = createDraftFailureNotice({
    now: () => now,
    intervalMs: 5000,
    notify: retry => notices.push({ message: failureCopy, actionLabel: retryCopy, retry }),
    retry: async () => { retryCalls++; await gate; },
  });

  notice.onError(new Error('SECRET first failure'));
  notice.onError(new Error('SECRET repeated failure'));
  assert.equal(notices.length, 1);
  assert.equal(notices[0]!.message, failureCopy);
  assert.equal(JSON.stringify(notices).includes('SECRET'), false);

  const pending = notices[0]!.retry();
  const duplicate = notices[0]!.retry();
  await Promise.resolve();
  assert.equal(retryCalls, 1);
  notice.onError(new Error('SECRET retry failure'));
  assert.equal(notices.length, 2, 'a failed explicit retry is immediately visible despite the throttle window');
  assert.equal(notices[1]!.message, failureCopy);
  release();
  await Promise.all([pending, duplicate]);
  now += 100;
  assert.equal(notices.length, 2);
});

test('actual main toast action clears before retry and ignores duplicate clicks', () => {
  const main = actualToastFunctions();
  let calls = 0;
  let retrySawClear = false;
  main.showDraftSyncNotice(async () => {
    calls++;
    retrySawClear = main.state.toast === null && main.state.toastAction === null;
  });
  const oldAction = main.state.toastAction!;
  assert.equal(main.state.toast, failureCopy);
  assert.equal(oldAction.label, retryCopy);
  assert.equal(main.timers.size, 0, 'the actionable notice persists until an action or another toast replaces it');

  main.runToastAction(oldAction);
  main.runToastAction(oldAction);
  assert.equal(retrySawClear, true, 'the UI clears the notice before invoking retry');
  assert.equal(calls, 1, 'a stale second click does not invoke retry again');
  assert.equal(main.state.toast, null);
  assert.equal(main.state.toastAction, null);
});

test('ordinary main toast replaces a retry action and makes its stale callback inert', () => {
  const main = actualToastFunctions();
  let retryCalls = 0;
  main.showDraftSyncNotice(async () => { retryCalls++; });
  const oldAction = main.state.toastAction!;
  main.toast('ordinary notice');
  assert.equal(main.state.toast, 'ordinary notice');
  assert.equal(main.state.toastAction, null);
  assert.equal(main.timers.size, 1, 'ordinary toast retains its 2.6 second timer');
  main.runToastAction(oldAction);
  assert.equal(retryCalls, 0);
  assert.equal(main.state.toast, 'ordinary notice');
});

test('actual main retry without an account throws into the fixed notice and leaves dirty text pending', async () => {
  const main = actualToastFunctions();
  const operations: string[] = [];
  let accountContext: object | null = null;
  let accountLookups = 0;
  let restoreCalls = 0;
  let retryFlushCalls = 0;
  let book!: ReturnType<typeof createDraftBook>;
  const draftBook = { flush: async () => { retryFlushCalls++; operations.push('flush'); await book.flush(); } };
  const retry = actualRetryDraftSync({
    S: () => main.state,
    activeAccount: () => { accountLookups++; return accountContext ? { context: accountContext } : null; },
    restoreDrafts: async () => { restoreCalls++; operations.push('restore'); },
    draftBook,
  });
  const notifier = createDraftFailureNotice({ notify: main.showDraftSyncNotice, retry, now: () => 100 });
  book = createDraftBook({
    async load() { return {}; },
    async save() { operations.push('save-failed'); throw new Error('SECRET /private/draft'); },
  }, { setTimer: () => 'manual', clearTimer: () => undefined, onError: notifier.onError });

  book.write(A, 'room', 'SYNTHETIC PRIVATE DRAFT');
  await book.flush();
  assert.equal(book.pending, 1);
  const firstAction = main.state.toastAction!;
  main.runToastAction(firstAction);
  assert.equal(main.state.toast, null, 'click clears before the asynchronous retry starts');
  await nextTurn();

  assert.equal(accountLookups, 1);
  assert.equal(restoreCalls, 0);
  assert.equal(retryFlushCalls, 0);
  assert.equal(book.pending, 1);
  assert.deepEqual(book.read(A), { room: 'SYNTHETIC PRIVATE DRAFT' });
  assert.equal(main.state.toast, failureCopy, 'the no-account retry failure re-shows the fixed notice');
  assert.notEqual(main.state.toastAction, firstAction);
  assert.equal(JSON.stringify(main.state).includes('SECRET'), false);
  assert.equal(JSON.stringify(main.state).includes('/private/draft'), false);
  assert.equal(JSON.stringify(main.state).includes('SYNTHETIC PRIVATE DRAFT'), false);

  main.runToastAction(firstAction);
  await nextTurn();
  assert.equal(accountLookups, 1, 'the stale first action remains inert after the failure notice returns');
  assert.equal(book.pending, 1);
  assert.equal(operations.filter(value => value === 'save-failed').length, 1);
});

test('actual main retry with an account restores then flushes and never sends', async () => {
  const main = actualToastFunctions();
  const operations: string[] = [];
  const accountContext = { ...A, session_generation: 1 };
  let failures = 1;
  let book!: ReturnType<typeof createDraftBook>;
  let sendCalls = 0;
  const draftBook = { flush: async () => { operations.push('flush'); await book.flush(); } };
  const retry = actualRetryDraftSync({
    S: () => main.state,
    activeAccount: () => ({ context: accountContext }),
    restoreDrafts: async (context: unknown) => { assert.deepEqual(context, accountContext); operations.push('restore'); },
    draftBook,
    sendText: () => { sendCalls++; },
  });
  const notifier = createDraftFailureNotice({ notify: main.showDraftSyncNotice, retry, now: () => 100 });
  book = createDraftBook({
    async load() { return {}; },
    async save() {
      operations.push(failures > 0 ? 'save-failed' : 'save-ok');
      if (failures-- > 0) throw new Error('SECRET save failure');
    },
  }, { setTimer: () => 'manual', clearTimer: () => undefined, onError: notifier.onError });

  book.write(A, 'room', 'SYNTHETIC RETRY DRAFT');
  await book.flush();
  assert.equal(book.pending, 1);
  const action = main.state.toastAction!;
  main.runToastAction(action);
  await nextTurn();

  assert.deepEqual(operations, ['save-failed', 'restore', 'flush', 'save-ok']);
  assert.equal(book.pending, 0);
  assert.equal(sendCalls, 0);
  assert.equal(main.state.toast, null, 'a resolved flush is not presented as proof of persistence');
});
