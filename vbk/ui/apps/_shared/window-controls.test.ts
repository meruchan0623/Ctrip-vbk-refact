import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isTitleBarDragTarget, type DragPathElement } from './window-controls.ts';

function el(tagName: string, attrs: Record<string, string> = {}): DragPathElement {
  return { tagName, getAttribute: (name) => attrs[name] ?? null };
}

test('a plain drag region counts only when it is the element clicked', () => {
  const bar = el('DIV', { 'data-tauri-drag-region': 'true' });
  assert.equal(isTitleBarDragTarget([bar, el('BODY')]), true);
  assert.equal(isTitleBarDragTarget([el('SPAN'), bar, el('BODY')]), false);
});

test('a deep drag region covers its plain descendants', () => {
  const bar = el('HEADER', { 'data-tauri-drag-region': 'deep' });
  assert.equal(isTitleBarDragTarget([el('SPAN'), bar]), true);
});

test('controls inside a drag region keep their own right-click', () => {
  const bar = el('HEADER', { 'data-tauri-drag-region': 'deep' });
  assert.equal(isTitleBarDragTarget([el('BUTTON'), bar]), false);
  assert.equal(isTitleBarDragTarget([el('SVG'), el('BUTTON'), bar]), false);
  assert.equal(isTitleBarDragTarget([el('DIV', { role: 'tab' }), bar]), false);
  assert.equal(isTitleBarDragTarget([el('DIV', { tabindex: '0' }), bar]), false);
  assert.equal(isTitleBarDragTarget([el('INPUT'), bar]), false);
});

test('outside any drag region, or where it is disabled, nothing opens', () => {
  assert.equal(isTitleBarDragTarget([el('DIV'), el('BODY')]), false);
  const bar = el('HEADER', { 'data-tauri-drag-region': 'deep' });
  assert.equal(isTitleBarDragTarget([el('DIV', { 'data-tauri-drag-region': 'false' }), bar]), false);
});
