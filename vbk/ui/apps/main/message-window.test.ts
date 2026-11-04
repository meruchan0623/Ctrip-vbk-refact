import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLayout, captureAnchor, coversViewport, findAnchorIndex, layoutTotal, rowId, RowHeights, rowIndexAt, scrollTopFor, windowRange, ROW_ESTIMATE, ROW_MARGIN, ROW_OVERSCAN } from './message-window.ts';
import { historyKeyMatchesMessage, historyKeyOf, historyKeyString, historyKeysMatch, parseHistoryKey } from './history-key.ts';

type Row = { message_id: string | null; local_id: string | null; sender_role: string; sender_id?: string; create_time_ms: number; kind: string; text: string };
const row = (mid: string | null, lid: string | null, extra: Partial<Row> = {}): Row => ({ message_id: mid, local_id: lid, sender_role: 'customer', create_time_ms: 1, kind: 'text', text: 'x', ...extra });

test('window range covers the viewport with overscan and clamps at both ends', () => {
  const layout = buildLayout(1000, () => 100);
  assert.deepEqual(windowRange(layout, 0, 400, 2), { start: 0, end: 6 });
  assert.deepEqual(windowRange(layout, 50_000, 400, 2), { start: 498, end: 506 });
  assert.deepEqual(windowRange(layout, 999_999, 400, 2), { start: 997, end: 1000 });
  assert.deepEqual(windowRange(buildLayout(0, () => 1), 0, 400), { start: 0, end: 0 });
});

test('a mounted window is kept while it has a row margin on both sides of the viewport', () => {
  const layout = buildLayout(1000, () => 100);
  const row = (n: number) => n * 100;
  // Window computed at row 500 (viewport 400 = rows 500..503): rows 488..515 with the default overscan.
  const range = windowRange(layout, row(500), 400);
  assert.deepEqual(range, { start: 500 - ROW_OVERSCAN, end: 504 + ROW_OVERSCAN });
  assert.ok(ROW_MARGIN < ROW_OVERSCAN, 'a fresh window must always satisfy its own margin');
  assert.equal(coversViewport(layout, range, row(500), 400), true, 'where it was computed');
  const slack = ROW_OVERSCAN - ROW_MARGIN;
  assert.equal(coversViewport(layout, range, row(500 + slack), 400), true, 'down to the last row with a full margin');
  assert.equal(coversViewport(layout, range, row(500 + slack + 1), 400), false, 'one row further eats into the margin');
  assert.equal(coversViewport(layout, range, row(500 - slack), 400), true, 'up to the first row with a full margin');
  assert.equal(coversViewport(layout, range, row(500 - slack - 1), 400), false);
  assert.equal(coversViewport(layout, range, row(500 + slack) - 1, 400), true);
  assert.equal(coversViewport(layout, range, row(500 + slack) + 1, 400), false, 'the viewport bottom entering the next row already needs it as margin');
  // The margin is a parameter: with none, the window lasts until a visible row would be unmounted.
  assert.equal(coversViewport(layout, range, row(500 + ROW_OVERSCAN), 400, 0), true);
  assert.equal(coversViewport(layout, range, row(500 + ROW_OVERSCAN + 1), 400, 0), false);
  // A window built with less overscan than the margin is not kept.
  assert.equal(coversViewport(layout, windowRange(layout, row(500), 400, 2), row(500), 400), false);
  assert.equal(coversViewport(layout, windowRange(layout, row(500), 400, 2), row(500), 400, 2), true);
  // Visible rows outside the range are never acceptable, whatever the margin.
  assert.equal(coversViewport(layout, { start: 0, end: 502 }, row(500), 400, 0), false);
  assert.equal(coversViewport(layout, { start: 501, end: 600 }, row(500), 400, 0), false);
});

test('window margin is clamped at the list ends and a stale range never passes', () => {
  const layout = buildLayout(1000, () => 100);
  const head = windowRange(layout, 0, 400);
  assert.deepEqual(head, { start: 0, end: 4 + ROW_OVERSCAN });
  assert.equal(coversViewport(layout, head, 0, 400), true, 'no rows above the head are required');
  assert.equal(coversViewport(layout, head, 100 * (ROW_OVERSCAN - ROW_MARGIN), 400), true);
  assert.equal(coversViewport(layout, head, 100 * (ROW_OVERSCAN - ROW_MARGIN + 1), 400), false);
  const tail = windowRange(layout, 999_999, 400);
  assert.deepEqual(tail, { start: 999 - ROW_OVERSCAN, end: 1000 });
  assert.equal(coversViewport(layout, tail, 999_999, 400), true, 'no rows below the tail are required');
  assert.equal(coversViewport(layout, tail, 100 * 996, 400), true);
  assert.equal(coversViewport(layout, tail, 100 * (999 - ROW_OVERSCAN + ROW_MARGIN) - 1, 400), false);
  // Pinned at the bottom the last row must be mounted; a window that stops short is replaced.
  assert.equal(coversViewport(layout, { start: 980, end: 999 }, layoutTotal(layout) - 400, 400), false);
  // Ranges that do not fit the layout (shrunk list, bad bounds) are never kept.
  assert.equal(coversViewport(layout, { start: 987, end: 1001 }, 999_999, 400), false);
  assert.equal(coversViewport(layout, { start: -1, end: 20 }, 0, 400), false);
  assert.equal(coversViewport(layout, { start: 5, end: 5 }, 0, 400), false);
  assert.equal(coversViewport(buildLayout(3, () => 100), { start: 0, end: 16 }, 0, 400), false, 'range from a longer list');
  // Empty layout: only the empty window counts as covering.
  const empty = buildLayout(0, () => 1);
  assert.equal(coversViewport(empty, { start: 0, end: 0 }, 0, 400), true);
  assert.equal(coversViewport(empty, { start: 0, end: 0 }, 5000, 400), true);
  assert.equal(coversViewport(empty, { start: 0, end: 5 }, 0, 400), false);
});

test('10k rows mount a bounded window and layout lookups are logarithmic in shape', () => {
  const layout = buildLayout(10_000, i => 40 + (i % 7) * 10);
  const range = windowRange(layout, layoutTotal(layout) / 2, 900);
  assert.ok(range.end - range.start <= 40, `mounted ${range.end - range.start}`);
  for (const i of [0, 1, 4999, 9999]) assert.equal(rowIndexAt(layout, layout.tops[i]!), i);
  assert.equal(rowIndexAt(layout, layout.tops[5]! + 0.5), 5);
});

test('invalid heights fall back to the estimate instead of corrupting offsets', () => {
  const layout = buildLayout(3, i => [NaN, -5, 30][i]!);
  assert.equal(layoutTotal(layout), ROW_ESTIMATE * 2 + 30);
});

test('anchor survives prepending a history page and a confirmation that adds the server id', () => {
  const scope = 's';
  const list = [row('m1', null), row(null, 'l2'), row('m3', null)];
  const layout = buildLayout(3, () => 100);
  const anchor = captureAnchor(layout, 130, scope, i => historyKeyOf(scope, list[i]!))!;
  assert.equal(anchor.offset, -30);
  // History prepends 5 rows and the local row is confirmed (gains a server id).
  const next = [...Array.from({ length: 5 }, (_, i) => row(`old${i}`, null)), list[0]!, row('m2', 'l2'), list[2]!];
  const index = findAnchorIndex(next, anchor);
  assert.equal(index, 6);
  const grown = buildLayout(next.length, () => 100);
  assert.equal(scrollTopFor(grown, index, anchor.offset), 630, 'same row stays 30px under the viewport top');
});

test('anchor is not guessed when the row is gone or the match is ambiguous', () => {
  const key = historyKeyOf('s', row('m1', null));
  const anchor = { scope: 's', key, offset: 0 };
  assert.equal(findAnchorIndex([row('m2', null)], anchor), -1);
  assert.equal(findAnchorIndex([row('m1', null), row('m1', 'l')], anchor), -1, 'duplicate identity is refused');
  assert.equal(findAnchorIndex([row('m1', null, { sender_role: 'merchant_self' })], anchor), -1, 'role conflict');
  assert.equal(findAnchorIndex([row('m1', null, { sender_id: 'a' })], { ...anchor, key: historyKeyOf('s', row('m1', null, { sender_id: 'b' })) }), -1, 'sender conflict');
});

test('unkeyed rows are skipped when capturing an anchor', () => {
  const list = [row(null, null), row('m2', null)];
  const layout = buildLayout(2, () => 50);
  const anchor = captureAnchor(layout, 10, 's', i => (list[i]!.message_id || list[i]!.local_id) ? historyKeyOf('s', list[i]!) : null)!;
  assert.equal(anchor.key.mid, 'm2');
  assert.equal(anchor.offset, 40);
});

test('row heights are scoped and tolerate sub-pixel jitter', () => {
  const heights = new RowHeights();
  heights.use('a');
  assert.equal(heights.get('x'), ROW_ESTIMATE);
  assert.equal(heights.set('x', 120), true);
  assert.equal(heights.set('x', 120.4), false);
  assert.equal(heights.set('x', 0), false);
  assert.equal(heights.get('x'), 120);
  heights.use('b');
  assert.equal(heights.size, 0);
});

test('row id prefers the local id so it is stable across server confirmation', () => {
  const base = { create_time_ms: 5, kind: 'text', text: 'hi' };
  assert.equal(rowId({ message_id: null, local_id: 'l', ...base }), rowId({ message_id: 'm', local_id: 'l', ...base }));
  assert.match(rowId({ message_id: null, local_id: null, ...base }), /^s:5:text:2$/);
});

test('history key struct is byte-compatible with the legacy string and parses once', () => {
  const key = historyKeyOf('scope', row('m', 'l', { sender_id: ' Ab ' }));
  const raw = historyKeyString(key);
  assert.equal(raw, JSON.stringify(['scope', 'm', 'l', 'customer', 'ab']));
  assert.deepEqual(parseHistoryKey(raw), key);
  assert.equal(parseHistoryKey(raw), parseHistoryKey(raw), 'cached object identity');
  assert.equal(parseHistoryKey('not json'), null);
  assert.equal(parseHistoryKey('["s",1,null,"r",null]'), null);
  assert.ok(historyKeysMatch(key, historyKeyOf('scope', row('m', null, { sender_id: 'ab' }))));
  assert.ok(!historyKeysMatch(key, historyKeyOf('other', row('m', 'l'))));
  assert.ok(historyKeyMatchesMessage(historyKeyOf('s', row(null, 'l')), row('m', 'l')));
  assert.ok(!historyKeyMatchesMessage(historyKeyOf('s', row('m1', 'l')), row('m2', 'l')));
});

test('anchor lookup reuses immutable-list identity results across offsets and recreated keys', () => {
  let reads = 0;
  const list = Array.from({ length: 20_000 }, (_, i) => ({ ...row(`m${i}`, null), get sender_role() { reads++; return 'customer'; } }));
  const anchor = { scope: 's', key: historyKeyOf('s', row('m10000', null)), offset: 0 };
  assert.equal(findAnchorIndex(list, anchor), 10_000);
  assert.equal(reads, 20_000, 'first lookup verifies uniqueness across the complete list');
  for (let i = 0; i < 10; i++) assert.equal(findAnchorIndex(list, { ...anchor, key: { ...anchor.key }, offset: -i }), 10_000);
  assert.equal(reads, 20_000, 'repeated identity does not read message fields');
  assert.equal(findAnchorIndex(list, { ...anchor, scope: 'other', key: { ...anchor.key, scope: 'other' } }), 10_000);
  assert.equal(reads, 40_000, 'scope has a separate cache entry');
  assert.equal(findAnchorIndex([...list, row('m10000', 'confirmed')], anchor), -1, 'replacement list rechecks duplicate identities');
  assert.equal(findAnchorIndex(list, { ...anchor, key: { ...anchor.key, role: 'merchant_self' } }), -1, 'role is part of cached identity');
});

test('anchor cache keeps server conflicts distinct from local confirmation aliases', () => {
  const list = [row('server-a', 'local', { sender_id: 'Alice' }), row('server-b', 'local', { sender_id: 'Bob' })];
  const local = { scope: 's', key: historyKeyOf('s', row(null, 'local')), offset: 0 };
  assert.equal(findAnchorIndex(list, local), -1);
  assert.equal(findAnchorIndex(list, local), -1, 'ambiguous result is cached');
  const confirmed = { ...local, key: historyKeyOf('s', row('server-a', 'local')) };
  assert.equal(findAnchorIndex(list, confirmed), 0, 'explicit different server id cannot alias by local id');
  assert.equal(findAnchorIndex(list, { ...local, key: historyKeyOf('s', row(null, 'local', { sender_id: 'alice' })) }), 0);
  assert.equal(findAnchorIndex(list, { ...local, key: historyKeyOf('s', row(null, 'local', { sender_id: 'bob' })) }), 1);
});
