import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, subscribeFrame } from './store.ts';

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

test('frame subscription coalesces bursts, reads latest state and cancels on disposal', () => {
  const store = createStore(0), seen: number[] = [];
  let callback: FrameRequestCallback | undefined, requests = 0;
  const cancelled: number[] = [];
  const off = subscribeFrame(store, value => seen.push(value), fn => { callback = fn; return ++requests; }, id => cancelled.push(id));
  for (let i = 1; i <= 100; i++) store.set(i);
  assert.equal(store.get(), 100); assert.equal(requests, 1); assert.deepEqual(seen, []);
  callback!(0); assert.deepEqual(seen, [100]);
  store.set(101); assert.equal(requests, 2); off();
  assert.deepEqual(cancelled, [2]); store.set(102); assert.equal(requests, 2);
});
