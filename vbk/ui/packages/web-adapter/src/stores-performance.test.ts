import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoleBook } from './stores.ts';
import { SoaClient } from './soa.ts';
import { makeDeps, OK_STATUS, jsonResponse, flush } from './testing.ts';

test('RoleBook limits 30 gids to four requests, coalesces gid reads and retries failed members', async () => {
  let active = 0, peak = 0;
  const pending: (() => void)[] = [];
  const deps = makeDeps(() => {
    active++; peak = Math.max(peak, active);
    return new Promise(resolve => pending.push(() => {
      active--;
      resolve(jsonResponse({ ResponseStatus: OK_STATUS, bizResponseStatus: { resultCode: 'SUCCESS' }, members: [] }));
    }));
  });
  const book = new RoleBook('me'), soa = new SoaClient(deps);
  const first = book.ensure(deps, soa, 'g0');
  assert.equal(book.ensure(deps, soa, 'g0'), first);
  const all = [first, ...Array.from({ length: 29 }, (_, i) => book.ensure(deps, soa, `g${i + 1}`))];
  await flush();
  assert.equal(deps.fakeFetch.calls.length, 4);
  while (pending.length) { pending.shift()!(); await flush(); }
  await Promise.all(all);
  assert.equal(peak, 4); assert.equal(deps.fakeFetch.calls.length, 60);
  await book.ensure(deps, soa, 'g0'); assert.equal(deps.fakeFetch.calls.length, 60, 'TTL hit');
  book.invalidate('g0');
  deps.fakeFetch.set(() => new Error('offline'));
  await book.ensure(deps, soa, 'g0'); await book.ensure(deps, soa, 'g0');
  assert.equal(deps.fakeFetch.calls.length, 64, 'failed member lookup remains retryable');
});

test('RoleBook invalidation drops stale queued and in-flight profile evidence', async () => {
  const pending: (() => void)[] = [];
  const deps = makeDeps(() => new Promise(resolve => pending.push(() => resolve(jsonResponse({ ResponseStatus: OK_STATUS, members: [{ uid: 'customer', nick: 'stale' }] })))));
  const book = new RoleBook('me'), soa = new SoaClient(deps);
  const jobs = Array.from({ length: 5 }, (_, i) => book.ensure(deps, soa, `g${i}`));
  await flush();
  book.invalidate('g0'); book.invalidate('g4');
  while (pending.length) { pending.shift()!(); await flush(); }
  await Promise.all(jobs);
  assert.equal(deps.fakeFetch.calls.filter(c => (c.bodyJson as { groupId?: string }).groupId === 'g4').length, 0);
  // Other valid jobs above may know the same uid, so isolate the in-flight case.
  const isolated = new RoleBook('me');
  const old = isolated.ensure(deps, soa, 'old'); await flush(); isolated.invalidate('old');
  pending.shift()!(); await old;
  assert.equal(isolated.profileOf('customer').name, null);
});
