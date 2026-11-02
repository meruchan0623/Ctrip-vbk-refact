import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMessagePane, DEFAULT_VIEWPORT, PIN_THRESHOLD } from './message-pane.ts';
import type { MessageAnchor } from './message-window.ts';
import { rowId } from './message-window.ts';

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
    const plan = this.pane.plan({ scope: this.scope, list: this.list, view: this.view, pinned, anchor: captured ?? this.view?.anchor ?? null });
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
      const result = this.pane.sync(this.scope, this.geometry(), { header: this.header, rows }, anchor, pinned);
      assert.ok(result);
      if (result.scrollTo !== null) { this.scrollTop = result.scrollTo; this.clamp(); }
      if (!result.rerender) {
        const fresh = pinned ? null : this.pane.capture(this.scope, this.geometry());
        this.view = { scope: this.scope, top: result.top, height: this.viewport, anchor: fresh && 'anchor' in fresh ? fresh.anchor : null, rev: (this.view?.rev ?? 0) + 1 };
        return;
      }
      const plan = this.pane.plan({ scope: this.scope, list: this.list, view: { scope: this.scope, top: result.top, height: this.viewport, anchor, rev: 0 }, pinned, anchor });
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
