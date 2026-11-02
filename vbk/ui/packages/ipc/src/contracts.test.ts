import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONTRACT_VERSION, classifyCursor, isStaleGeneration, sameAccountContext, DEFAULT_REMINDER_SETTINGS } from './contracts.ts';

const ctx = (g: number) => ({ account_id: 'a', environment: 'production', session_generation: g });

test('stale generation detection mirrors Rust', () => {
  assert.equal(isStaleGeneration(ctx(3), ctx(2)), true);
  assert.equal(isStaleGeneration(ctx(3), ctx(3)), false);
  assert.equal(isStaleGeneration(ctx(3), { ...ctx(1), account_id: 'b' }), false);
  assert.equal(sameAccountContext(ctx(1), ctx(1)), true);
});

test('cursor classification mirrors Rust', () => {
  assert.deepEqual(classifyCursor({ epoch: 2, seq: 10 }, { epoch: 2, seq: 11 }), { kind: 'next' });
  assert.deepEqual(classifyCursor({ epoch: 2, seq: 10 }, { epoch: 2, seq: 10 }), { kind: 'duplicate' });
  assert.deepEqual(classifyCursor({ epoch: 2, seq: 10 }, { epoch: 2, seq: 13 }), { kind: 'gap', expected: 11, got: 13 });
  assert.deepEqual(classifyCursor({ epoch: 2, seq: 10 }, { epoch: 3, seq: 0 }), { kind: 'epoch_changed' });
});

test('reminder defaults follow design', () => {
  assert.equal(DEFAULT_REMINDER_SETTINGS.t1_seconds, 30);
  assert.equal(DEFAULT_REMINDER_SETTINGS.continuous_l4, false);
});

test('CONTRACT_VERSION mirrors the Rust constant', () => {
  const rust = readFileSync(join(import.meta.dirname, '..', '..', '..', '..', 'crates', 'contracts', 'src', 'version.rs'), 'utf8');
  const m = /pub const CONTRACT_VERSION: u32 = (\d+);/.exec(rust);
  assert.ok(m, 'version.rs declares CONTRACT_VERSION');
  assert.equal(CONTRACT_VERSION, Number(m[1]));
});
