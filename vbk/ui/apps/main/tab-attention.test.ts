import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { UiAccount } from '../../packages/ipc/src/client.ts';
import { addTabAttention, pruneTabAttention, tabBreathes } from './tab-attention.ts';

const acct = (id: string, over: Partial<UiAccount> = {}): UiAccount =>
  ({ context: { account_id: id, environment: 'prod', session_generation: 1 }, state: 'online', unread: 2, ...over }) as UiAccount;

test('the viewed tab never breathes', () => {
  assert.deepEqual(addTabAttention([], 'a', 'a'), []);
  assert.deepEqual(addTabAttention([], 'b', 'a'), ['b']);
});

test('adding twice keeps one entry and the same array', () => {
  const once = addTabAttention([], 'b', 'a');
  assert.equal(addTabAttention(once, 'b', 'a'), once);
});

test('prune drops viewed, read, expired and missing tabs', () => {
  const accounts = [acct('a'), acct('b', { unread: 0 }), acct('c', { state: 'expired' }), acct('d')];
  assert.deepEqual(pruneTabAttention(['a', 'b', 'c', 'd', 'gone'], accounts, 'a'), ['d']);
  const keep = ['d'];
  assert.equal(pruneTabAttention(keep, accounts, 'a'), keep);
});

test('breathing needs unread, a non-active tab and a pending flag', () => {
  assert.equal(tabBreathes(['a'], acct('a'), false), true);
  assert.equal(tabBreathes(['a'], acct('a'), true), false);
  assert.equal(tabBreathes(['a'], acct('a', { unread: 0 }), false), false);
  assert.equal(tabBreathes([], acct('a'), false), false);
});
