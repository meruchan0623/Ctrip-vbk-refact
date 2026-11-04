import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createAccountNavigation } from './account-navigation.ts';
import type { AccountContext } from '../../packages/ipc/src/contracts.ts';
import type { UiAccountSnapshot } from '../../packages/ipc/src/client.ts';
const a: AccountContext = { account_id: 'a', environment: 'synthetic', session_generation: 1 };
const b: AccountContext = { ...a, account_id: 'b' };
const c: AccountContext = { ...a, account_id: 'c' };
function snapshot(active: string, revision = ''): UiAccountSnapshot {
  return { active_account_id: active, max_accounts: 16, accounts: [a, b, c].map(context => ({ context, state: 'online', nick: context.account_id, remark: revision, party: '', color: '', unread: 0 })) };
}
function deferred() { let resolve!: () => void; return { promise: new Promise<void>(r => { resolve = r; }), resolve: () => resolve() }; }
async function settle() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
test('pending A switch event cannot steal a later selection of the still-active B tab; host is compensated to B', async () => {
  const gate = deferred(), calls: string[] = [], events: UiAccountSnapshot[] = [];
  let host = 'b', ui = snapshot('b');
  const navigation = createAccountNavigation({
    async switch(account) {
      calls.push(account.account_id);
      if (account.account_id === 'a') await gate.promise;
      host = account.account_id;
      const event = snapshot(host, `event-${host}`); events.push(event); ui = navigation.project(event);
      return event;
    }, snapshot: async () => snapshot(host), valid: (value): value is UiAccountSnapshot => !!value,
  });
  const old = navigation.select(a); await settle();
  const latest = navigation.select(b);
  gate.resolve();
  assert.equal(await old, null);
  assert.equal(ui.active_account_id, 'b', 'A account changed event keeps the latest valid UI selection');
  const result = await latest; if (result) ui = navigation.project(result);
  assert.deepEqual(calls, ['a', 'b']); assert.deepEqual(events.map(e => e.active_account_id), ['a', 'b']);
  assert.equal(host, 'b'); assert.equal(ui.active_account_id, 'b'); assert.equal(ui.accounts[0]?.remark, 'event-b');
  assert.equal(navigation.pending(), false);
});
test('rapid selections skip obsolete queued switches and preserve lifecycle metadata in intervening events', async () => {
  const gate = deferred(), calls: string[] = []; let host = 'b';
  const navigation = createAccountNavigation({ async switch(account) { calls.push(account.account_id); if (account.account_id === 'a') await gate.promise; host = account.account_id; return snapshot(host); }, snapshot: async () => snapshot(host), valid: (v): v is UiAccountSnapshot => !!v });
  const first = navigation.select(a); await settle(); const obsolete = navigation.select(b), latest = navigation.select(c);
  const event = snapshot('a', 'fresh-profile'); event.accounts[0]!.state; const projected = navigation.project(event);
  assert.equal(projected.active_account_id, 'c'); assert.equal(projected.accounts, event.accounts);
  gate.resolve(); await first; assert.equal(await obsolete, null); assert.equal((await latest)?.active_account_id, 'c'); assert.deepEqual(calls, ['a', 'c']);
});
test('removal and session generation changes invalidate a pending selection instead of masking account lifecycle', async () => {
  for (const replacement of [false, true]) {
    const gate = deferred(), navigation = createAccountNavigation({ switch: async () => { await gate.promise; return snapshot('a'); }, snapshot: async () => snapshot('b'), valid: (v): v is UiAccountSnapshot => !!v });
    const pending = navigation.select(a); await settle();
    const event = snapshot('b');
    const changed = { ...event, accounts: replacement ? event.accounts.map(item => item.context.account_id === 'a' ? { ...item, context: { ...a, session_generation: 2 } } : item) : event.accounts.filter(item => item.context.account_id !== 'a') };
    assert.equal(navigation.project(changed), changed); assert.equal(navigation.pending(), false);
    gate.resolve(); assert.equal(await pending, null);
  }
});
test('a failed latest selection reads back the real host account', async () => {
  let reads = 0;
  const navigation = createAccountNavigation({ switch: async () => { throw new Error('failed'); }, snapshot: async () => { reads++; return snapshot('b'); }, valid: (v): v is UiAccountSnapshot => !!v });
  assert.equal((await navigation.select(a))?.active_account_id, 'b'); assert.equal(reads, 1); assert.equal(navigation.pending(), false);
});
test('main applies the pending selection projection to real account snapshots and compensates current-tab clicks', () => {
  const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  assert.ok(source.includes('snap = accountNavigation.project(snap)'));
  assert.ok(source.includes('&& !accountNavigation.pending()) return'));
  assert.ok(source.includes('const snap = await accountNavigation.select(a.context)'));
});
