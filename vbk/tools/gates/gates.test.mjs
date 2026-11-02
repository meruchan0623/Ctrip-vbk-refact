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

test('dom-sinks B1 state (I-29 merged): allowlist is empty, strict zero hits', () => {
  assert.deepEqual(dom.loadAllowlist(), []);
});
