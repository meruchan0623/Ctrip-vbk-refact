import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { createNoticeQuery, EMPTY_NOTICE_QUERY, type NoticeQueryState } from './notice-query.ts';
import { UiCommands } from '../../packages/ipc/src/client.ts';
import type { AccountContext } from '../../packages/ipc/src/contracts.ts';

const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
function deferred() { let resolve!: (value: unknown) => void, reject!: (error: unknown) => void; return { promise: new Promise((res, rej) => { resolve = res; reject = rej; }), resolve, reject }; }
function fixture() {
  let account: AccountContext = { account_id: 'a', environment: 'synthetic', session_generation: 1 };
  let noticeState: NoticeQueryState = { ...EMPTY_NOTICE_QUERY };
  let state: Record<string, any> = { orderBusyId: null, order: { kind: 'ready' }, conversations: [], tab: 'done' };
  const calls: { command: string; payload: unknown }[] = [], opened: string[] = [], toasts: unknown[] = [], patches: object[] = [];
  let createResult: unknown = { gid: '123456', reused: false }, listResult: unknown = [{ gid: '123456' }];
  const noticeQuery = createNoticeQuery({ account: () => account, current: () => noticeState, publish: patch => { noticeState = { ...noticeState, ...patch }; }, invoke: async <T>() => [] as T, error: String, failed() {} });
  let patchEffect: ((patch: object) => void) | null = null;
  const store = { patch(patch: object) { patches.push(patch); state = { ...state, ...patch }; patchEffect?.(patch); } };
  const env = { activeAccount: () => ({ context: account }), S: () => state, canContactOrder: () => true, noticeQuery, store, UiCommands,
    ipc: { async invoke(command: string, payload: unknown) { calls.push({ command, payload }); return await (command === UiCommands.ORDER_CREATE_IM_CHAT ? createResult : listResult); } },
    isUiConversation: (value: unknown) => value !== null && typeof value === 'object' && 'gid' in value,
    openConversation: async (gid: string) => { opened.push(gid); }, toast: (text: unknown) => { toasts.push(text); }, t: (_key: string, values: unknown) => values, errorMessage: String,
  };
  const a = source.indexOf('async function contactViaIm('), b = source.indexOf('\nasync function openWebAdvanced(', a);
  const contact = new Function(...Object.keys(env), stripTypeScriptTypes(source.slice(a, b)) + '\nreturn contactViaIm;')(...Object.values(env)) as (order: unknown) => Promise<void>;
  return { calls, opened, toasts, patches, noticeQuery, get state() { return state; }, contact: () => contact({ order_id: '1234567890' }),
    create(value: unknown) { createResult = value; }, list(value: unknown) { listResult = value; },
    switchAccount(patch: Partial<AccountContext>) { noticeQuery.reset(); account = { ...account, ...patch }; state = { orderBusyId: null, order: { kind: 'ready' }, conversations: [], tab: 'done' }; },
    onPatch(effect: (patch: object) => void) { patchEffect = effect; },
    busy(id: string) { state = { ...state, orderBusyId: id }; },
  };
}
async function settle() { for (let i = 0; i < 8; ++i) await Promise.resolve(); }

test('actual order contact opens a current result normally after loading conversations for the clicked account', async () => {
  const f = fixture(); await f.contact();
  assert.deepEqual(f.opened, ['123456']); assert.equal(f.state.orderBusyId, null); assert.equal(f.state.tab, 'doing');
  assert.deepEqual(f.calls.map(call => call.command), [UiCommands.ORDER_CREATE_IM_CHAT, UiCommands.IM_CONVERSATIONS]);
  assert.deepEqual(f.calls[0]?.payload, { account: { account_id: 'a', environment: 'synthetic', session_generation: 1 }, order_id: '1234567890' });
  assert.deepEqual(f.toasts, []);
});

test('actual order contact rejects late create/list replies after account A→B→A without replacing rows or opening a room', async () => {
  for (const phase of ['create', 'list']) {
    const f = fixture(), pending = deferred();
    if (phase === 'create') f.create(pending.promise); else f.list(pending.promise);
    const operation = f.contact(); await settle();
    f.switchAccount({ account_id: 'b' }); f.switchAccount({ account_id: 'a' }); f.busy('new-operation');
    const expected = f.state;
    pending.resolve(phase === 'create' ? { gid: '123456', reused: false } : [{ gid: '123456' }]); await operation;
    assert.equal(f.state, expected); assert.deepEqual(f.opened, []); assert.deepEqual(f.toasts, []);
    assert.equal(f.calls.length, phase === 'create' ? 1 : 2);
  }
});

test('actual order contact ignores late failures after any old-account visit and preserves newer busy state', async () => {
  for (const patch of [{ account_id: 'b' }, { environment: 'other' }, { session_generation: 2 }]) for (const phase of ['create', 'list']) {
    const f = fixture(), pending = deferred();
    if (phase === 'create') f.create(pending.promise); else f.list(pending.promise);
    const operation = f.contact(); await settle(); f.switchAccount(patch); if ('account_id' in patch) f.switchAccount({ account_id: 'a' }); f.busy('new-operation'); const expected = f.state;
    pending.reject(new Error('old account failure')); await operation;
    assert.equal(f.state, expected); assert.deepEqual(f.toasts, []); assert.deepEqual(f.opened, []);
  }
});

test('actual order contact reports a current failure and releases its own busy state', async () => {
  const f = fixture(), pending = deferred(); f.create(pending.promise); const operation = f.contact();
  pending.reject(new Error('current failure')); await operation;
  assert.equal(f.state.orderBusyId, null); assert.equal(f.toasts.length, 1); assert.deepEqual(f.opened, []);
});

test('actual order contact rechecks account visit after synchronous store subscribers before opening or toasting', async () => {
  const success = fixture();
  success.onPatch(patch => { if ('conversations' in patch) { success.switchAccount({ account_id: 'b' }); success.switchAccount({ account_id: 'a' }); } });
  await success.contact(); assert.deepEqual(success.opened, []);
  const failure = fixture(), pending = deferred(); failure.create(pending.promise);
  failure.onPatch(patch => { if ('orderBusyId' in patch && patch.orderBusyId === null) failure.switchAccount({ account_id: 'b' }); });
  const operation = failure.contact(); pending.reject(new Error('old visit failed')); await operation;
  assert.deepEqual(failure.toasts, []); assert.deepEqual(failure.opened, []);
});
