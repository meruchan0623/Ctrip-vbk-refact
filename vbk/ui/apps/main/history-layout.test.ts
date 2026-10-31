import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observeHistoryLayout } from './history-layout.ts';

function fixture(pinned = false) {
  let resize!: () => void;
  let listener: (() => void) | undefined;
  let current = true, rowTop = 200, disconnected = false;
  let top = pinned ? 600 : 120;
  const watched: unknown[] = [];
  const scroll = {
    get scrollTop() { return top; },
    set scrollTop(value: number) { top = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)); },
    scrollHeight: 1000, clientHeight: 400,
    children: [{}, {}],
    addEventListener: (_: string, fn: () => void) => { listener = fn; },
    removeEventListener: () => { listener = undefined; },
  };
  class Observer {
    constructor(fn: () => void) { resize = fn; }
    observe(node: unknown) { watched.push(node); }
    disconnect() { disconnected = true; }
  }
  const stop = observeHistoryLayout(scroll as unknown as HTMLElement,
    () => ({ offset: rowTop - scroll.scrollTop }),
    anchor => { if (anchor) scroll.scrollTop = rowTop - anchor.offset; },
    () => current, Observer as unknown as typeof ResizeObserver);
  return { scroll, watched, stop, resize: () => resize(), grow: (delta = 240) => { rowTop += delta; scroll.scrollHeight += delta; scroll.scrollTop = scroll.scrollTop; }, queuedScroll: () => listener?.(), userScroll: (top: number) => { scroll.scrollTop = top; listener?.(); }, invalidate: () => { current = false; }, disconnected: () => disconnected };
}

test('late media growth preserves the reading row, not the old pixel scrollTop', () => {
  const f = fixture(); f.grow(); f.resize(); assert.equal(f.scroll.scrollTop, 360);
  f.resize(); assert.equal(f.scroll.scrollTop, 360, 'repeat delivery must not double adjust');
  assert.equal(f.watched.length, 3, 'observe rows as well as fixed-height container');
});
test('user scrolling replaces the pending media anchor', () => {
  const f = fixture(); f.userScroll(200); f.grow(); f.resize(); assert.equal(f.scroll.scrollTop, 440);
});
test('queued synchronous-restore scroll cannot erase a later media layout delta', () => {
  const f = fixture(); f.grow(); f.queuedScroll(); f.resize();
  assert.equal(f.scroll.scrollTop, 360);
});
test('bottom pin follows late media but stops following after user scrolls up', () => {
  const f = fixture(true); f.grow(); f.resize(); assert.equal(f.scroll.scrollTop, f.scroll.scrollHeight - f.scroll.clientHeight);
  f.userScroll(120); f.grow(); f.resize(); assert.equal(f.scroll.scrollTop, 360);
});
test('native scroll anchoring before resize delivery is not compensated twice', () => {
  const f = fixture(); f.grow(); f.scroll.scrollTop += 240; f.queuedScroll(); f.resize();
  assert.equal(f.scroll.scrollTop, 360);
});
test('media shrink clamping the scroll range is not mistaken for user scrolling', () => {
  const f = fixture(); f.grow(800); f.resize(); f.userScroll(900);
  f.grow(-600); assert.equal(f.scroll.scrollTop, 800);
  f.queuedScroll(); f.resize(); assert.equal(f.scroll.scrollTop, 300);
});
test('detached or changed account scope cannot apply a queued resize', () => {
  const f = fixture(); f.invalidate(); f.grow(); f.resize(); assert.equal(f.scroll.scrollTop, 120);
  const g = fixture(); g.stop(); g.grow(); g.resize(); assert.equal(g.scroll.scrollTop, 120); assert.equal(g.disconnected(), true);
});
