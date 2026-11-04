import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitColumns } from './workspace-columns.ts';

test('column bounds reserve room for chat and separators across window sizes', () => {
  for (const width of [600, 852, 900, 1100, 1600]) {
    for (const side of [true, false]) {
      const fitted = fitColumns(width, { left: 480, right: 520 }, side);
      assert.ok(fitted.left >= 220 && fitted.left <= 480);
      assert.ok(side ? fitted.right >= 260 && fitted.right <= 520 : fitted.right === 0);
      assert.ok(fitted.left + fitted.right + 400 + (side ? 12 : 6) <= Math.max(width, side ? 892 : 626));
    }
  }
});
test('hiding the sidebar frees chat space without changing preferred widths', () => {
  const preferred = { left: 340, right: 420 };
  assert.deepEqual(fitColumns(1400, preferred, false), { left: 340, right: 0 });
  assert.deepEqual(fitColumns(1400, preferred, true), preferred);
});

test('chat pane never produces horizontal scrolling at any width', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
  const rule = (selector: RegExp) => css.match(selector)?.[1] ?? '';
  assert.match(rule(/\.msgs\s*\{([^}]+)\}/), /overflow-x\s*:\s*hidden/);
  assert.match(rule(/\.message-columns\s*\{([^}]+)\}/), /overflow-x\s*:\s*hidden/);
  assert.doesNotMatch(css, /overflow-x\s*:\s*(auto|scroll)[^}]*\}\s*\n\.message-columns/);
  assert.doesNotMatch(rule(/\.message-columns > \.chat,[^{]*\{([^}]+)\}/), /min-width\s*:\s*[1-9]/);
});
