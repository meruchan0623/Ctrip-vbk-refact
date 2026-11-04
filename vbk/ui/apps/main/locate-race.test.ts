import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { createAccountNavigation } from './account-navigation.ts';
import { createNoticeQuery, EMPTY_NOTICE_QUERY } from './notice-query.ts';
import { sameAccount } from './viewmodel.ts';
import type { AccountContext } from '../../packages/ipc/src/contracts.ts';
const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
const a: AccountContext = { account_id: 'a', environment: 'synthetic', session_generation: 1 };
const b: AccountContext = { ...a, account_id: 'b' };
function fixture() {
  let current = b, state: Record<string, any> = { accounts: { active_account_id: 'b', accounts: [{ context: a }, { context: b }] }, conversations: [], tab: 'doing' };
  let switchReply: unknown = { active_account_id: 'a' };
  const opened: string[] = [], activated: unknown[] = [], waits: (() => void)[] = [];
  const noticeQuery = createNoticeQuery({ account: () => current, current: () => EMPTY_NOTICE_QUERY, publish() {}, invoke: async <T>() => [] as T, error: String, failed() {} });
  function switchTo(account: AccountContext) { noticeQuery.reset(); current = account; state = { ...state, accounts: { ...state.accounts, active_account_id: account.account_id }, conversations: [] }; }
  const accountNavigation = createAccountNavigation({ switch: async () => await switchReply, snapshot: async () => state.accounts, valid: (value): value is any => !!value });
  const env = { browserTabs: { activate: (id: unknown) => { activated.push(id); } }, accountNavigation, S: () => state, sameAccount, noticeQuery, stillActive: (account: AccountContext) => sameAccount(account, current) && account.session_generation === current.session_generation,
    invokeSafe: async () => await switchReply, isUiAccountSnapshot: () => true, applyAccountSnapshot: (snapshot: { active_account_id: string }) => switchTo(snapshot.active_account_id === 'a' ? a : b), AccountCommands: { SWITCH: 'switch' },
    store: { patch: (patch: object) => { state = { ...state, ...patch }; } }, isDone: (room: { status: string }) => room.status === 'done',
    openConversation: async (gid: string) => { opened.push(`${current.account_id}:${gid}`); }, setTimeout: (callback: () => void) => { waits.push(callback); } };
  const start = source.indexOf('async function locateConversation('), end = source.indexOf('\n/** A removal', start);
  const locate = new Function(...Object.keys(env), stripTypeScriptTypes(source.slice(start, end)) + '\nreturn locateConversation;')(...Object.values(env));
  const switchStart = source.indexOf('async function switchAccount('), switchEnd = source.indexOf('\n/** `account_start_login`', switchStart);
  const choose = new Function(...Object.keys(env), stripTypeScriptTypes(source.slice(switchStart, switchEnd)) + '\nreturn switchAccount;')(...Object.values(env));
  return { activated, choose: (account: AccountContext) => choose({ context: account, state: 'online' }), locate: () => locate(a, '123456'), opened, waits, switchTo, rows: (owner = current) => { state.conversations = [{ account: owner, gid: '123456', status: 'done' }]; }, reply: (value: unknown) => { switchReply = value; }, supersede: () => { state.navigationOperation = {}; }, get state() { return state; } };
}
async function settle() { for (let i = 0; i < 6; i++) await Promise.resolve(); }
test('alarm navigation opens only a room owned by the target account after its list loads', async () => {
  const f = fixture(), pending = f.locate(); await settle(); f.rows(); f.waits.shift()!(); await pending;
  assert.deepEqual(f.opened, ['a:123456']); assert.equal(f.state.tab, 'done');
  assert.deepEqual(f.activated, [null], 'locating a room leaves any web tab first');
});
test('alarm navigation cancels when users change accounts during list loading, including A→B→A', async () => {
  for (const roundTrip of [false, true]) {
    const f = fixture(), pending = f.locate(); await settle(); f.switchTo(b); if (roundTrip) f.switchTo(a); f.rows();
    f.waits.shift()!(); await pending; assert.deepEqual(f.opened, []); assert.equal(f.state.tab, 'doing');
  }
});
test('alarm navigation times out without opening a missing or foreign-account room', async () => {
  const f = fixture(), pending = f.locate(); await settle(); f.rows(b);
  for (let i = 0; i < 50; i++) { f.waits.shift()?.(); await settle(); }
  await pending; assert.deepEqual(f.opened, []);
});


test('an older account switch response cannot steal a newer navigation', async () => {
  const f = fixture(); let resolve!: (value: unknown) => void;
  f.reply(new Promise(r => { resolve = r; }));
  const pending = f.locate(); await settle();
  const latest = f.choose(b); f.reply({ active_account_id: 'b' });
  resolve({ active_account_id: 'a' }); await pending; await latest;
  assert.equal(f.state.accounts.active_account_id, 'b'); assert.deepEqual(f.opened, []);
});

test('selecting another room cancels an older reminder navigation waiting for its list', async () => {
  const f = fixture(), pending = f.locate(); await settle();
  f.supersede(); f.rows(); f.waits.shift()!(); await pending;
  assert.deepEqual(f.opened, []);
});


test('later account-tab selection supersedes an earlier pending tab switch', async () => {
  const f = fixture(); let resolve!: (value: unknown) => void;
  f.reply(new Promise(r => { resolve = r; }));
  const pending = f.choose(a); await settle(); const latest = f.choose(b);
  f.reply({ active_account_id: 'b' }); resolve({ active_account_id: 'a' }); await pending; await latest;
  assert.equal(f.state.accounts.active_account_id, 'b');
});
