import { test } from 'node:test';
import assert from 'node:assert/strict';
import { badgeText, formatDuration, formatRelativeTime, initialOf, maskMiddle } from './format.ts';

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
