import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMessagePane, DEFAULT_VIEWPORT, HISTORY_RUNWAY, PIN_THRESHOLD } from './message-pane.ts';
import type { MessageAnchor } from './message-window.ts';
import { ROW_MARGIN, ROW_OVERSCAN, rowId } from './message-window.ts';

type Msg = { message_id: string | null; local_id: string | null; sender_role: string; sender_id?: string; create_time_ms: number; kind: string; text: string };
const msg = (mid: string | null, lid: string | null, t: number, extra: Partial<Msg> = {}): Msg => ({ message_id: mid, local_id: lid, sender_role: 'customer', create_time_ms: t, kind: 'text', text: 'x', ...extra });
const SCOPE = 'scope-A';

/** A tiny layout engine standing in for the browser: truth heights, spacers, header, scroll clamping. */
class SimPane {
  readonly pane = createMessagePane();
  list: Msg[];
  truth = new Map<string, number>();
  header = 40;
  viewport = 500;
  scrollTop = 0;
  anchor: MessageAnchor | null = null;
  view: { scope: string; top: number; height: number; anchor: MessageAnchor | null; rev: number } | undefined;
  mounted: string[] = [];
  renders = 0;
  scope = SCOPE;
  /** Scroll height held above row 0, as main.ts asks for while older history exists. */
  runway = 0;
  /** Every scrollTop the model asked for: each one can disturb a gesture in flight. */
  writes = 0;
  idle = false;
  private topSpacer = 0;
  private bottomSpacer = 0;
  readonly truthOf: (m: Msg) => number;
  constructor(list: Msg[], truthOf: (m: Msg) => number = () => 100) { this.list = list; this.truthOf = truthOf; }
  height(m: Msg): number { return this.truth.get(rowId(m)) ?? this.truthOf(m); }
  private get scrollHeight(): number {
    const mounted = this.pane.mountedIds();
    const real = this.list.filter(m => mounted.includes(rowId(m))).reduce((n, m) => n + this.height(m), 0);
    return this.header + this.topSpacer + real + this.bottomSpacer;
  }
  private geometry() { return { scrollTop: this.scrollTop, clientHeight: this.viewport, scrollHeight: this.scrollHeight }; }
  private clamp(): void { this.scrollTop = Math.max(0, Math.min(this.scrollTop, this.scrollHeight - this.viewport)); }
  nearBottom(): boolean { return this.scrollHeight - this.viewport - this.scrollTop < PIN_THRESHOLD; }

  /** What chatPane + messagePane + the frame subscriber do for one store change. */
  render(opts: { pinned?: boolean } = {}): void {
    const first = this.renders === 0;
    const capture = first ? { skip: 'no_pane' as const } : this.pane.capture(this.scope, this.geometry());
    const captured = 'anchor' in capture ? capture.anchor : null;
    const pinned = opts.pinned ?? (first || this.nearBottom());
    const plan = this.pane.plan({ scope: this.scope, list: this.list, view: this.view, pinned, anchor: captured ?? this.view?.anchor ?? null, retained: !first, runway: this.runway });
    this.renders++;
    this.topSpacer = plan.topSpacer; this.bottomSpacer = plan.bottomSpacer;
    this.mounted = this.pane.mountedIds();
    // Browser behaviour: a fresh node starts at the kept pixel scrollTop, or bottom when pinned.
    if (pinned) this.scrollTop = Math.max(0, this.scrollHeight - this.viewport); else this.clamp();
    this.settle(pinned ? null : captured ?? this.view?.anchor ?? null, pinned);
  }

  /** The post-mount measure/restore loop, bounded like main.ts. */
  settle(anchor: MessageAnchor | null, pinned: boolean): void {
    for (let guard = 0; guard < 6; guard++) {
      const rows = this.list.filter(m => this.mounted.includes(rowId(m))).map(m => ({ id: rowId(m), height: this.height(m) }));
      const result = this.pane.sync(this.scope, this.geometry(), { header: this.header, rows }, anchor, pinned, this.idle);
      assert.ok(result);
      this.topSpacer = result.topSpacer;
      if (result.scrollTo !== null) { this.scrollTop = result.scrollTo; this.writes++; this.clamp(); }
      if (!result.rerender) {
        const fresh = pinned ? null : this.pane.capture(this.scope, this.geometry());
        this.view = { scope: this.scope, top: result.top, height: this.viewport, anchor: fresh && 'anchor' in fresh ? fresh.anchor : null, rev: (this.view?.rev ?? 0) + 1 };
        return;
      }
      const plan = this.pane.plan({ scope: this.scope, list: this.list, view: { scope: this.scope, top: result.top, height: this.viewport, anchor, rev: 0 }, pinned, anchor, retained: true, runway: this.runway });
      this.renders++;
      this.topSpacer = plan.topSpacer; this.bottomSpacer = plan.bottomSpacer; this.mounted = this.pane.mountedIds();
      if (pinned) this.scrollTop = Math.max(0, this.scrollHeight - this.viewport); else this.clamp();
    }
    assert.fail('window did not converge');
  }

  userScroll(top: number): void { this.scrollTop = top; this.clamp(); this.render({ pinned: false }); }
  /** Y of a row's top edge relative to the viewport top, in the sim's real layout. */
  rowViewportTop(m: Msg): number {
    let y = this.header + this.topSpacer;
    for (const row of this.list) {
      if (!this.mounted.includes(rowId(row))) continue;
      if (rowId(row) === rowId(m)) return y - this.scrollTop;
      y += this.height(row);
    }
    throw new Error('row is not mounted: ' + rowId(m));
  }
  /** The first row whose bottom edge is below the viewport top, in real layout. */
  readingRow(): Msg {
    let y = this.header + this.topSpacer;
    for (const row of this.list) {
      if (!this.mounted.includes(rowId(row))) continue;
      y += this.height(row);
      if (y > this.scrollTop) return row;
    }
    throw new Error('no mounted row below the viewport top');
  }
  /** Media inside a mounted row resolved to its real size. */
  grow(m: Msg, delta: number): void {
    const before = this.pane.capture(this.scope, this.geometry());
    this.truth.set(rowId(m), this.height(m) + delta);
    this.settle('anchor' in before ? before.anchor : null, this.nearBottom());
  }
}

const many = (n: number): Msg[] => Array.from({ length: n }, (_, i) => msg(`m${i}`, null, i + 1));

test('10k messages mount a bounded window and open pinned at the bottom', () => {
  const sim = new SimPane(many(10_000));
  sim.render();
  assert.ok(sim.mounted.length <= 40, `mounted ${sim.mounted.length}`);
  assert.ok(sim.mounted.includes('m:m9999'));
  assert.ok(sim.nearBottom());
  assert.ok(sim.view && sim.view.scope === SCOPE);
});

test('scrolling up remounts a different window and keeps the DOM bounded', () => {
  const sim = new SimPane(many(10_000));
  sim.render();
  sim.userScroll(sim.scrollTop / 2);
  assert.ok(!sim.mounted.includes('m:m9999'));
  assert.ok(sim.mounted.length <= 40);
  assert.ok(!sim.nearBottom());
});

test('small scrolls inside the mounted window keep it; only scrolling past the buffer swaps it', () => {
  const sim = new SimPane(many(2000));
  sim.render();
  sim.userScroll(sim.header + 100 * 1000);
  const window = [...sim.mounted], reading = sim.readingRow(), index = sim.list.indexOf(reading);
  const base = sim.scrollTop, renders = sim.renders;
  const geometry = (rows: number) => ({ scrollTop: base + 100 * rows, clientHeight: sim.viewport, scrollHeight: 1_000_000 });
  const slack = ROW_OVERSCAN - ROW_MARGIN;
  assert.ok(slack >= 3, 'the buffer is wide enough for the small scrolls below');
  // Up to `slack` rows in either direction the window still has its margin (mounted rows are measured, so 100px = 1 row).
  for (let rows = -slack; rows <= slack; rows++) assert.equal(sim.pane.rangeFor(geometry(rows))!.changed, false, `rangeFor ${rows} rows away`);
  assert.equal(sim.pane.rangeFor(geometry(-slack - 1))!.changed, true, 'one row past the buffer upward');
  // Downward the window was sized while the rows below were still estimates, so its tail may be longer:
  // the swap point is wherever the margin runs out, never before `slack` rows.
  const swapAt = Array.from({ length: 60 }, (_, k) => k + 1).find(k => sim.pane.rangeFor(geometry(k))!.changed)!;
  assert.ok(swapAt > slack, `window swaps after ${swapAt} rows`);
  assert.equal(sim.pane.rangeFor(geometry(swapAt - 1))!.changed, false);
  // Renders triggered by small scrolls (3 rows down, 1 up, 3 up, back) keep exactly the same rows mounted.
  for (const rows of [3, 1, -3, 0]) {
    sim.userScroll(base + 100 * rows);
    assert.deepEqual(sim.mounted, window, `scrolled ${rows} rows`);
    assert.equal(sim.readingRow(), sim.list[index + rows], 'the reading row moved by that many rows');
    assert.equal(sim.pane.sync(SCOPE, geometry(rows), { header: sim.header, rows: [] }, null, false)!.rerender, false);
  }
  assert.ok(sim.renders > renders, 'renders ran but reused the same window');
  // Past the buffer the window moves with the reader and stays bounded, in both directions.
  sim.userScroll(base + 100 * swapAt);
  assert.notDeepEqual(sim.mounted, window, 'scrolled down past the buffer');
  assert.equal(sim.readingRow(), sim.list[index + swapAt]);
  assert.ok(sim.mounted.length <= 40);
  sim.userScroll(base - 100 * (slack + 1));
  assert.notDeepEqual(sim.mounted, window, 'scrolled up past the buffer');
  assert.equal(sim.readingRow(), sim.list[index - slack - 1]);
  assert.ok(sim.mounted.includes(rowId(sim.list[index - slack - 1]!)) && sim.mounted.length <= 40);
  // A new list identity (history prepended) never reuses the shifted indexes: the same rows stay mounted.
  const before = [...sim.mounted], top = sim.rowViewportTop(sim.readingRow());
  sim.list = [...Array.from({ length: 3 }, (_, i) => msg(`old${i}`, null, -10 + i)), ...sim.list];
  sim.render({ pinned: false });
  assert.deepEqual(sim.mounted, before, 'the same rows stay mounted although every index moved by the prepended page');
  assert.equal(sim.rowViewportTop(sim.list[index - slack - 1 + 3]!), top);
});

test('a prepended history page keeps the reading row where it was (offset 0 and partial)', () => {
  for (const partial of [0, 37]) {
    const list = many(300);
    const sim = new SimPane(list);
    sim.render(); sim.userScroll(sim.header + 100 * 50 + partial);
    const reading = sim.readingRow();
    const before = sim.rowViewportTop(reading);
    sim.list = [...Array.from({ length: 50 }, (_, i) => msg(`old${i}`, null, -100 + i)), ...list];
    sim.render();
    assert.equal(sim.rowViewportTop(reading), before, `partial=${partial}`);
  }
});

test('image growth above the viewport shifts the page but not the reading row', () => {
  const list = many(300);
  const sim = new SimPane(list);
  sim.render(); sim.userScroll(sim.header + 100 * 100);
  const reading = sim.readingRow();
  const before = sim.rowViewportTop(reading);
  const above = list[list.indexOf(reading) - 2]!;
  assert.ok(sim.mounted.includes(rowId(above)));
  sim.grow(above, 240);
  assert.equal(sim.rowViewportTop(reading), before);
});

test('a local row confirmed by the server stays the anchor', () => {
  const list = Array.from({ length: 200 }, (_, i) => msg(null, `local-${i}`, i + 1, { sender_role: 'merchant_self', sender_id: 'agent' }));
  const sim = new SimPane(list);
  sim.render(); sim.userScroll(sim.header + 100 * 120);
  const reading = sim.readingRow(), index = list.indexOf(reading);
  const before = sim.rowViewportTop(reading);
  const confirmed = msg(`server-${index}`, reading.local_id, reading.create_time_ms, { sender_role: 'merchant_self', sender_id: 'agent' });
  sim.list = [...list.slice(0, index), confirmed, ...list.slice(index + 1)];
  sim.render();
  assert.equal(sim.rowViewportTop(confirmed), before);
});

test('an ambiguous or vanished anchor row is not guessed: the pixel position is kept', () => {
  const list = many(200);
  const sim = new SimPane(list);
  sim.render(); sim.userScroll(sim.header + 100 * 80);
  const top = sim.scrollTop;
  const gone = sim.list.filter((_, i) => i !== 80);
  sim.list = gone;
  sim.render();
  assert.ok(Math.abs(sim.scrollTop - top) <= 100, 'scroll stays near the old pixel offset');
  const dup = [...gone, msg(gone[80]!.message_id, null, 9999)];
  sim.list = dup; sim.render(); // duplicate identity: refuse, no throw, no loop
});

test('a live message while pinned follows the bottom; while reading it does not move the row', () => {
  const list = many(200);
  const pinned = new SimPane(list);
  pinned.render();
  pinned.list = [...list, msg('new', null, 1000)];
  pinned.render();
  assert.ok(pinned.mounted.includes('m:new')); assert.ok(pinned.nearBottom());
  const reading = new SimPane(list);
  reading.render(); reading.userScroll(reading.header + 100 * 60);
  const row = reading.readingRow(), before = reading.rowViewportTop(row);
  reading.list = [...list, msg('new', null, 1000)];
  reading.render();
  assert.equal(reading.rowViewportTop(row), before);
  assert.ok(!reading.mounted.includes('m:new'));
});

test('another scope never inherits geometry or the anchor', () => {
  const sim = new SimPane(many(200));
  sim.render(); sim.userScroll(sim.header + 100 * 60);
  const capture = sim.pane.capture('scope-B', { scrollTop: sim.scrollTop, clientHeight: 500, scrollHeight: 20_000 });
  assert.deepEqual(capture, { skip: 'wrong_scope' });
  assert.deepEqual(sim.pane.capture(null, null), { skip: 'no_pane' });
  sim.scope = 'scope-B'; sim.view = undefined; sim.renders = 0; sim.truth.clear();
  sim.render();
  assert.ok(sim.mounted.includes('m:m199'), 'a new scope opens at the bottom');
});

test('the stored view anchor restores the position after the pane was unmounted', () => {
  const list = many(400);
  const sim = new SimPane(list);
  sim.render(); sim.userScroll(sim.header + 100 * 150);
  const stored = sim.view!;
  const row = sim.readingRow();
  const fresh = new SimPane(list);
  fresh.view = stored; fresh.renders = 1; // already rendered once elsewhere; no live pane to capture from
  fresh.render({ pinned: false });
  assert.ok(fresh.mounted.includes(rowId(row)));
  assert.equal(fresh.rowViewportTop(row), sim.rowViewportTop(row));
});

test('capture refuses the bottom (pinned) and an empty list', () => {
  const sim = new SimPane(many(10));
  sim.render();
  assert.deepEqual(sim.pane.capture(SCOPE, { scrollTop: 100, clientHeight: 500, scrollHeight: 640 }), { skip: 'pinned' });
  const empty = new SimPane([]);
  empty.render();
  assert.deepEqual(empty.pane.capture(SCOPE, { scrollTop: 0, clientHeight: 500, scrollHeight: 2000 }), { skip: 'no_anchor' });
});

test('default viewport is used until the pane reports its height', () => {
  const pane = createMessagePane();
  const plan = pane.plan({ scope: SCOPE, list: many(1000), view: undefined, pinned: true, anchor: null });
  assert.ok(plan.range.end === 1000);
  assert.ok(plan.range.end - plan.range.start < DEFAULT_VIEWPORT / 10);
});

test('20k unchanged messages do not rescan anchor identity during repeated plan/sync frames', () => {
  let reads = 0;
  const list = Array.from({ length: 20_000 }, (_, i) => ({ ...msg(`m${i}`, null, i), get sender_role() { reads++; return 'customer'; } }));
  const pane = createMessagePane();
  const anchor: MessageAnchor = { scope: SCOPE, key: { scope: SCOPE, mid: 'm10000', lid: null, role: 'customer', sender: null }, offset: -20 };
  const input = { scope: SCOPE, list, view: undefined, pinned: false, anchor };
  const first = pane.plan(input);
  assert.equal(reads, 20_000);
  const geometry = { scrollTop: 760_020, clientHeight: 800, scrollHeight: 1_520_000 };
  for (let i = 0; i < 10; i++) {
    assert.deepEqual(pane.plan({ ...input, anchor: { ...anchor, key: { ...anchor.key } } }), first);
    assert.equal(pane.sync(SCOPE, geometry, { header: 0, rows: [] }, anchor, false)?.scrollTo, null);
  }
  assert.equal(reads, 20_000, 'recreated anchor objects and sync share the cached identity lookup');
});

const mixed = (m: Msg): number => [44, 44, 66, 44, 180, 44, 96, 44, 320][Number(m.message_id?.slice(1) ?? 0) % 9]!;
const page = (from: number, count: number): Msg[] => Array.from({ length: count }, (_, i) => msg(`m${from + i}`, null, from + i + 1));

test('a retained pane absorbs prepended pages and real heights in the spacer, never in scrollTop', () => {
  const sim = new SimPane(page(900, 100), mixed);
  sim.runway = HISTORY_RUNWAY;
  sim.render();
  sim.writes = 0;
  for (let from = 800; from >= 500; from -= 100) {
    // The gesture keeps moving up; a page lands in the middle of it.
    for (let step = 0; step < 40; step++) {
      const reading = sim.readingRow(), before = sim.rowViewportTop(reading);
      const delta = Math.min(90, sim.scrollTop);
      sim.scrollTop -= delta;
      sim.render({ pinned: false });
      // The row moved by exactly what the user scrolled: no snap back, no jump.
      assert.ok(Math.abs(sim.rowViewportTop(reading) - before - delta) < 0.01, `step ${step}`);
    }
    const reading = sim.readingRow(), before = sim.rowViewportTop(reading);
    sim.list = [...page(from, 100), ...sim.list];
    sim.render({ pinned: false });
    assert.ok(Math.abs(sim.rowViewportTop(reading) - before) < 0.01, `page ${from}`);
  }
  assert.equal(sim.writes, 0, 'scrollTop was never written during the gesture');
});

test('media resolving above the reading row moves the spacer only', () => {
  const sim = new SimPane(many(300), mixed);
  sim.runway = HISTORY_RUNWAY;
  sim.render();
  sim.userScroll(sim.scrollTop - 6000);
  const reading = sim.readingRow(), before = sim.rowViewportTop(reading);
  const above = sim.list[sim.list.indexOf(reading) - 2]!;
  sim.writes = 0;
  sim.grow(above, 240);
  assert.equal(sim.rowViewportTop(reading), before);
  assert.equal(sim.writes, 0);
});

test('the runway is topped up only once the gesture is over, without moving the rows', () => {
  const sim = new SimPane(page(900, 100), mixed);
  sim.runway = HISTORY_RUNWAY;
  sim.render();
  sim.userScroll(sim.scrollTop - 1000);
  sim.list = [...page(0, 900), ...sim.list];
  sim.render({ pinned: false });
  sim.writes = 0;
  sim.render({ pinned: false });
  assert.equal(sim.writes, 0, 'still in flight: the reset waits');
  const reading = sim.readingRow(), before = sim.rowViewportTop(reading);
  sim.idle = true;
  sim.render({ pinned: false });
  assert.equal(sim.writes, 1);
  assert.ok(Math.abs(sim.rowViewportTop(reading) - before) < 0.01);
});

test('rows cannot become unreachable: near the scroll origin the slack is reset even in flight', () => {
  const sim = new SimPane(page(900, 100), mixed);
  sim.runway = HISTORY_RUNWAY;
  sim.render();
  sim.userScroll(sim.scrollTop - 1000);
  sim.list = [...page(0, 900), ...sim.list];
  sim.render({ pinned: false });
  sim.writes = 0;
  sim.scrollTop = 100;
  const geometry = (scrollTop: number) => ({ scrollTop, clientHeight: sim.viewport, scrollHeight: Number.MAX_SAFE_INTEGER });
  const before = sim.pane.capture(SCOPE, geometry(100));
  sim.render({ pinned: false });
  const after = sim.pane.capture(SCOPE, geometry(sim.scrollTop));
  assert.equal(sim.writes, 1);
  assert.ok(sim.scrollTop > sim.viewport, 'there is room above again');
  assert.ok('anchor' in before && 'anchor' in after);
  assert.deepEqual(after.anchor.key, before.anchor.key, 'the same row is still at the viewport top');
  assert.ok(Math.abs(after.anchor.offset - before.anchor.offset) < 0.01);
});

test('the last page removes the runway: the first row ends at the real top with no gap', () => {
  const sim = new SimPane(page(50, 50), mixed);
  sim.runway = HISTORY_RUNWAY;
  sim.render();
  sim.userScroll(sim.scrollTop - 1000);
  const reading = sim.readingRow(), before = sim.rowViewportTop(reading);
  sim.list = [...page(0, 50), ...sim.list];
  sim.runway = 0;
  sim.render({ pinned: false });
  assert.ok(Math.abs(sim.rowViewportTop(reading) - before) < 0.01, 'the page landing does not move the reading row');
  sim.idle = true;
  sim.render({ pinned: false });
  assert.ok(Math.abs(sim.rowViewportTop(reading) - before) < 0.01, 'neither does closing the gap');
  sim.userScroll(0);
  assert.equal(sim.rowViewportTop(sim.list[0]!), sim.header);
});

test('deep in the runway the first row follows the viewport, so a landing page is visible at once', () => {
  const sim = new SimPane(page(900, 100), mixed);
  sim.runway = HISTORY_RUNWAY;
  sim.render();
  // A fling far past the loaded rows: only placeholders are on screen.
  sim.userScroll(sim.scrollTop - 12_000);
  sim.writes = 0;
  const first = sim.list[0]!;
  assert.ok(sim.rowViewportTop(first) >= 0 && sim.rowViewportTop(first) <= sim.viewport + 0.01, 'held at the lower edge');
  sim.list = [...page(800, 100), ...sim.list];
  sim.render({ pinned: false });
  assert.ok(sim.rowViewportTop(first) >= 0 && sim.rowViewportTop(first) <= sim.viewport + 0.01, 'the old head did not move away');
  assert.ok(sim.rowViewportTop(sim.list[99]!) < sim.rowViewportTop(first), 'the new rows sit directly above it, in view');
  assert.equal(sim.writes, 0);
});

test('outOfBand tells the scroll path when a sync cannot wait for the next render', () => {
  const sim = new SimPane(page(50, 50), mixed);
  sim.runway = HISTORY_RUNWAY;
  sim.render();
  const geometry = (scrollTop: number) => ({ scrollTop, clientHeight: sim.viewport, scrollHeight: 1e9 });
  assert.equal(sim.pane.outOfBand(geometry(sim.scrollTop)), false, 'reading the loaded rows');
  assert.equal(sim.pane.outOfBand(geometry(sim.scrollTop - 12_000)), true, 'the first row left the viewport below');
  sim.userScroll(sim.scrollTop - 500);
  sim.list = [...page(0, 50), ...sim.list];
  sim.runway = 0;
  sim.render({ pinned: false });
  assert.equal(sim.pane.outOfBand(geometry(sim.scrollTop)), false, 'the gap above the real head is still out of view');
  const head = sim.scrollTop - sim.pane.distanceToHead(sim.scrollTop);
  assert.equal(sim.pane.outOfBand(geometry(head - 10)), true, 'it is about to show');
});
