import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfirmController } from './confirm-dialog.ts';

const req = (title: string) => ({ title, message: 'm', confirmLabel: 'ok', cancelLabel: 'no', danger: true });

test('answers resolve the pending request exactly once', async () => {
  const c = new ConfirmController();
  const p = c.request(req('a'));
  assert.equal(c.current()?.title, 'a');
  c.answer(true);
  c.answer(false);
  assert.equal(await p, true);
  assert.equal(c.current(), null);
});

test('a second request answers the first with "no" (never two stacked dialogs)', async () => {
  const c = new ConfirmController();
  const first = c.request(req('a'));
  const second = c.request(req('b'));
  assert.equal(await first, false);
  assert.equal(c.current()?.title, 'b');
  c.answer(true);
  assert.equal(await second, true);
});

test('listener fires on open and close; answering with nothing pending is a no-op', () => {
  const c = new ConfirmController();
  let n = 0;
  c.onChange(() => { n++; });
  c.answer(true);
  assert.equal(n, 0);
  void c.request(req('a'));
  c.answer(false);
  assert.equal(n, 2);
});
