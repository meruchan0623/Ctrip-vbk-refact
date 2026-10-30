import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { UiAccountSnapshot } from '../../packages/ipc/src/client.ts';
import { resolveAttemptId } from './viewmodel.ts';

const ctx = (id: string) => ({ account_id: id, environment: 'prod', session_generation: 1 }) as unknown as UiAccountSnapshot['accounts'][number]['context'];
const acc = (id: string, state: UiAccountSnapshot['accounts'][number]['state']) => ({ context: ctx(id), nick: id, remark: null, party: '', color: '#000', state, unread: 0 });

test('attempt id prefers the ?attempt= query parameter', () => {
  const snap: UiAccountSnapshot = { accounts: [acc('a1', 'logging_in')], active_account_id: null, max_accounts: 16 };
  assert.equal(resolveAttemptId('?attempt=att-9', snap), 'att-9');
});

test('attempt id falls back to the logging_in account', () => {
  const snap: UiAccountSnapshot = { accounts: [acc('a0', 'online'), acc('a1', 'logging_in')], active_account_id: 'a0', max_accounts: 16 };
  assert.equal(resolveAttemptId('', snap), 'a1');
  assert.equal(resolveAttemptId('?attempt=', snap), 'a1');
});

test('no attempt when nothing is logging in', () => {
  assert.equal(resolveAttemptId('', null), null);
  assert.equal(resolveAttemptId('', { accounts: [acc('a0', 'online')], active_account_id: 'a0', max_accounts: 16 }), null);
});
