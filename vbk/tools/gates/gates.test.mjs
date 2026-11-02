// node:test wrapper (run by `npm test` and CI): fixtures self-test + real tree must be clean.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatViolation } from './lib/common.mjs';
import { selfTest } from './lib/selftest.mjs';
import { gates } from './run.mjs';
import * as dom from './dom-sinks.mjs';

test('gate fixtures: must-fail are flagged, must-pass stay clean, at least 3 of each per gate', () => {
  const { problems } = selfTest();
  assert.deepEqual(problems, []);
});

for (const g of gates) {
  test(`gate ${g.GATE}: zero violations on the real tree`, () => {
    assert.deepEqual(g.run().map(formatViolation), []);
  });
}

test('dom-sinks B0 state: the allowlist holds exactly companion-card.ts:70', () => {
  const list = dom.loadAllowlist();
  assert.equal(list.length, 1);
  assert.deepEqual({ file: list[0].file, line: list[0].line, sink: list[0].sink }, { file: 'ui/apps/main/companion-card.ts', line: 70, sink: 'innerHTML' });
});
