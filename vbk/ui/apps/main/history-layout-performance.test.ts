import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHistoryLayoutFrames, observeHistoryLayout, startHistoryLayout, stopHistoryLayout } from './history-layout.ts';

function fixture() {
  const listeners = new Set<() => void>();
  const pane = {
    clientWidth: 600, clientHeight: 400, scrollHeight: 1000, scrollTop: 120,
    children: [{}, {}],
    addEventListener(_type: string, callback: () => void) { listeners.add(callback); },
    removeEventListener(_type: string, callback: () => void) { listeners.delete(callback); },
  };
  return { pane, element: pane as unknown as HTMLElement, listeners };
}

test('100 unchanged frames perform one restore, including user scrolling within the window', () => {
  const f = fixture(), frames = createHistoryLayoutFrames(), revision = {};
  let restores = 0;
  const render = () => frames.sync(f.element, 'account/room', revision, () => { restores++; });
  assert.equal(render(), true);
  for (let i = 0; i < 100; i++) { f.pane.scrollTop++; assert.equal(render(), false); }
  assert.equal(restores, 1);
});

test('width, viewport height, media height, rendered content, scope and pane replacement invalidate measurements', () => {
  const f = fixture(), frames = createHistoryLayoutFrames();
  let restores = 0, scope = 'account/room', revision = {};
  const render = () => frames.sync(f.element, scope, revision, () => { restores++; });
  render();
  f.pane.clientWidth--; render();
  f.pane.clientHeight--; render();
  f.pane.scrollHeight++; render();
  revision = {}; render();
  scope = 'other-account/same-room'; render();
  frames.sync(fixture().element, scope, revision, () => { restores++; });
  assert.equal(restores, 7);
  frames.sync(null, '', revision, () => assert.fail('no pane'));
  render();
  assert.equal(restores, 8, 'returning from another view must measure again');
});

test('persistent observer only observes new children and releases removed rows', () => {
  const f = fixture();
  let deliveries!: () => void, restored = 0, disconnected = 0;
  const observed: unknown[] = [], removed: unknown[] = [];
  class Observer {
    constructor(deliver: () => void) { deliveries = deliver; }
    observe(node: unknown) { observed.push(node); }
    unobserve(node: unknown) { removed.push(node); }
    disconnect() { disconnected++; }
  }
  let rowTop = 200;
  const stop = observeHistoryLayout(f.element, () => ({ offset: rowTop - f.pane.scrollTop }), anchor => {
    restored++;
    if (anchor) f.pane.scrollTop = rowTop - anchor.offset;
  }, () => true, Observer as unknown as typeof ResizeObserver);
  for (let i = 0; i < 100; i++) stop.refresh();
  assert.equal(observed.length, 3);
  assert.equal(disconnected, 0);
  const removedRow = f.pane.children.shift();
  f.pane.children.push({}); stop.refresh();
  assert.equal(observed.length, 4);
  assert.deepEqual(removed, [removedRow]);
  rowTop += 240; f.pane.scrollHeight += 240; deliveries();
  assert.equal(f.pane.scrollTop, 360);
  assert.equal(restored, 1);
  stop(); deliveries();
  assert.equal(restored, 1);
  assert.equal(f.listeners.size, 0);
});

test('manager keeps one observer across no-op frames and releases it for scope/view changes', () => {
  const prior = globalThis.ResizeObserver;
  let created = 0, disconnected = 0;
  const queued: (() => void)[] = [];
  class Observer {
    constructor(deliver: () => void) { created++; queued.push(deliver); }
    observe() {}
    unobserve() {}
    disconnect() { disconnected++; }
  }
  globalThis.ResizeObserver = Observer as unknown as typeof ResizeObserver;
  try {
    const f = fixture(); let restores = 0;
    const start = (scope: string, refresh = false) => startHistoryLayout(f.element, () => null, () => { restores++; }, () => true, scope, refresh);
    start('a');
    for (let i = 0; i < 100; i++) start('a');
    assert.equal(created, 1); assert.equal(disconnected, 0);
    start('a', true); assert.equal(created, 1);
    start('b'); assert.equal(created, 2); assert.equal(disconnected, 1);
    queued[0]!(); assert.equal(restores, 0);
    startHistoryLayout(null, () => null, () => {}, () => false);
    assert.equal(disconnected, 2); assert.equal(f.listeners.size, 0);
  } finally {
    stopHistoryLayout();
    if (prior === undefined) Reflect.deleteProperty(globalThis, 'ResizeObserver');
    else globalThis.ResizeObserver = prior;
  }
});
