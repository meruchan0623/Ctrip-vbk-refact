import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from './store.ts';

test('store get/set/update/patch notify with prev', () => {
  const s = createStore({ a: 1, b: 'x' });
  const seen: Array<[number, number]> = [];
  const off = s.subscribe((next, prev) => seen.push([next.a, prev.a]));
  s.set({ a: 2, b: 'x' });
  s.update((st) => ({ ...st, a: st.a + 1 }));
  s.patch({ b: 'y' });
  assert.deepEqual(s.get(), { a: 3, b: 'y' });
  assert.deepEqual(seen, [
    [2, 1],
    [3, 2],
    [3, 3],
  ]);
  off();
  s.patch({ a: 9 });
  assert.equal(seen.length, 3);
});

test('store ignores identical values and survives nested sets', () => {
  const s = createStore(0);
  let calls = 0;
  s.subscribe((v) => {
    calls += 1;
    if (v === 1) s.set(2);
  });
  s.set(0);
  assert.equal(calls, 0);
  s.set(1);
  assert.equal(s.get(), 2);
  assert.equal(calls, 2);
});
