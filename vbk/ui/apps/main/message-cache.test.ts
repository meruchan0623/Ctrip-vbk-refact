import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MESSAGE_CACHE_RECENT, hasUnsettledRow, keptConversations, touchRecent, trimMessageCache } from './message-cache.ts';
import type { CachedHistory, CachedRow } from './message-cache.ts';

const row = (id: string | null, kind?: string): CachedRow => ({ message_id: id, disposition: kind ? { kind } : null });
const loaded: CachedHistory = { busy: false, firstPage: 'loaded' };
const state = (gids: readonly string[], extra: Record<string, readonly CachedRow[]> = {}, history: Record<string, CachedHistory> = {}) => ({
  messages: { ...Object.fromEntries(gids.map(gid => [gid, [row(`${gid}-1`)]])), ...extra },
  history: { ...Object.fromEntries(gids.map(gid => [gid, loaded])), ...history },
});

test('recent order moves a reopened conversation to the end and stays bounded', () => {
  let order: string[] = [];
  for (let i = 0; i < 40; i++) order = touchRecent(order, `g${i}`);
  assert.equal(order.length, MESSAGE_CACHE_RECENT + 1);
  assert.equal(order.at(-1), 'g39');
  order = touchRecent(order, 'g30');
  assert.equal(order.at(-1), 'g30');
  assert.equal(order.filter(gid => gid === 'g30').length, 1);
});

test('conversations outside the recent window lose rows and paging state together', () => {
  let order: string[] = [];
  const gids = Array.from({ length: 20 }, (_, i) => `g${i}`);
  for (const gid of gids) order = touchRecent(order, gid);
  const next = trimMessageCache(state(gids), keptConversations('g19', order, false));
  assert.ok(next);
  assert.deepEqual(Object.keys(next.messages).sort(), Object.keys(next.history).sort());
  assert.equal(Object.keys(next.messages).length, MESSAGE_CACHE_RECENT + 1);
  assert.ok('g19' in next.messages && 'g7' in next.messages);
  // Evicted: no history entry, so reopening takes the ordinary first-page read.
  assert.equal(next.history['g0'], undefined);
  assert.equal(next.messages['g6'], undefined);
});

test('nothing to evict returns null so no state update is issued', () => {
  assert.equal(trimMessageCache(state(['a', 'b']), keptConversations('a', ['b', 'a'], false)), null);
});

test('a conversation holding a local or unknown-result send is never evicted', () => {
  assert.equal(hasUnsettledRow([row('1'), row(null)]), true);
  assert.equal(hasUnsettledRow([row('1', 'unknown')]), true);
  assert.equal(hasUnsettledRow([row('1', 'confirmed'), row('2')]), false);
  const next = trimMessageCache(state(['old'], { sending: [row(null)], unknown: [row('u', 'unknown')] }), keptConversations('open', [], false));
  assert.ok(next);
  assert.deepEqual(Object.keys(next.messages).sort(), ['sending', 'unknown']);
});

test('an in-flight page read keeps its conversation', () => {
  const next = trimMessageCache(
    state(['old'], {}, { first: { busy: true, firstPage: 'loading' }, earlier: { busy: true, firstPage: 'loaded' } }),
    keptConversations(null, [], false),
  );
  assert.ok(next);
  assert.deepEqual(Object.keys(next.history).sort(), ['earlier', 'first']);
});

test('long hidden keeps only the open conversation', () => {
  const next = trimMessageCache(state(['a', 'b', 'c']), keptConversations('b', ['a', 'c', 'b'], true));
  assert.ok(next);
  assert.deepEqual(Object.keys(next.messages), ['b']);
  assert.deepEqual([...keptConversations(null, ['a'], true)], []);
});
