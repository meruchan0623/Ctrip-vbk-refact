import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLayout, captureAnchor, findAnchorIndex, layoutTotal, rowId, RowHeights, rowIndexAt, scrollTopFor, windowRange, ROW_ESTIMATE } from './message-window.ts';
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
