import { test } from 'node:test';
import assert from 'node:assert/strict';
import { badgeText, formatDuration, formatRelativeTime, formatStopwatch, initialOf, maskMiddle } from './format.ts';

test('formatDuration matches prototype fmtWait', () => {
  assert.equal(formatDuration(0), '0秒');
  assert.equal(formatDuration(16), '16秒');
  assert.equal(formatDuration(59.9), '59秒');
  assert.equal(formatDuration(102), '1分42秒');
  assert.equal(formatDuration(125), '2分05秒');
  assert.equal(formatDuration(3725), '1小时02分');
  assert.equal(formatDuration(-5), '0秒');
});

test('badgeText 1–99 then 99+', () => {
  assert.equal(badgeText(0), '');
  assert.equal(badgeText(-1), '');
  assert.equal(badgeText(1), '1');
  assert.equal(badgeText(99), '99');
  assert.equal(badgeText(100), '99+');
  assert.equal(badgeText(1234), '99+');
});

test('formatRelativeTime', () => {
  const now = new Date(2026, 9, 30, 14, 5).getTime();
  assert.equal(formatRelativeTime(new Date(2026, 9, 30, 9, 7).getTime(), now), '09:07');
  assert.equal(formatRelativeTime(new Date(2026, 9, 29, 23, 0).getTime(), now), '昨天');
  assert.equal(formatRelativeTime(new Date(2026, 9, 1, 23, 0).getTime(), now), '10-01');
});

test('maskMiddle and initialOf', () => {
  assert.equal(maskMiddle('0000000001'), '0000****0001');
  assert.equal(maskMiddle('12345678'), '12345678');
  assert.equal(initialOf('客户A'), '客');
  assert.equal(initialOf('emma'), 'E');
  assert.equal(initialOf('  '), '?');
});

test('formatStopwatch counts every second at a fixed width', () => {
  assert.equal(formatStopwatch(0), '00:00');
  assert.equal(formatStopwatch(45.9), '00:45');
  assert.equal(formatStopwatch(65), '01:05');
  assert.equal(formatStopwatch(3599), '59:59');
  assert.equal(formatStopwatch(3930), '1:05:30');
  assert.equal(formatStopwatch(-3), '00:00');
});

test('localized duration templates preserve flooring, padding and unit boundaries', () => {
  const cases: [number, string][] = [[-0.5, '0秒'], [59.999, '59秒'], [60, '1分00秒'], [61, '1分01秒'], [3599, '59分59秒'], [3600, '1小时00分'], [3659, '1小时00分'], [3660, '1小时01分'], [360000, '100小时00分']];
  for (const [seconds, expected] of cases) assert.equal(formatDuration(seconds), expected);
});

test('localized yesterday remains based on the existing local-day comparison across year boundary', () => {
  const now = new Date(2027, 0, 1, 12, 0).getTime();
  assert.equal(formatRelativeTime(new Date(2026, 11, 31, 23, 59).getTime(), now), '昨天');
  assert.equal(formatRelativeTime(new Date(2027, 0, 1, 0, 1).getTime(), now), '00:01');
  assert.equal(formatRelativeTime(new Date(2026, 11, 30, 23, 59).getTime(), now), '12-30');
});
