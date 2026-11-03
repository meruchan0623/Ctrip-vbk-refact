import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONTRACT_VERSION, FactStreams, classifyCursor, isStaleGeneration, sameAccountContext, DEFAULT_REMINDER_SETTINGS, type AdapterFactEnvelope, type FeatureFact } from './contracts.ts';

const ctx = (g: number) => ({ account_id: 'a', environment: 'production', session_generation: g });
const vbk = join(import.meta.dirname, '..', '..', '..', '..');

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
  const rust = readFileSync(join(vbk, 'crates', 'contracts', 'src', 'version.rs'), 'utf8');
  const m = /pub const CONTRACT_VERSION: u32 = (\d+);/.exec(rust);
  assert.ok(m, 'version.rs declares CONTRACT_VERSION');
  assert.equal(CONTRACT_VERSION, Number(m[1]));
});

// The host crate (src-tauri) cannot be compiled in this environment, so the
// JSON samples of `dto.rs::tests::feature_fact_json_shape_matches_ts` are
// locked here as well: same strings, same expectations.
const FEATURE_ENVELOPE_JSON = '{"account":{"account_id":"a","environment":"production","session_generation":2},'
  + '"stream":"im.feature","epoch":1,"seq":3,'
  + '"fact":{"kind":"feature","fact":{"kind":"typing","gid":"1234567890123456789","from":"cust-9","until_ms":1761800005000}}}';
const FEATURE_EVENT_JSON = '{"kind":"typing","gid":"1234567890123456789","from":"cust-9","until_ms":1761800005000,'
  + '"account":{"account_id":"a","environment":"production","session_generation":2}}';

test('feature fact JSON shapes mirror dto.rs (envelope variant and feature://fact event)', () => {
  const env = JSON.parse(FEATURE_ENVELOPE_JSON) as AdapterFactEnvelope;
  assert.equal(env.stream, FactStreams.FEATURE);
  assert.equal(env.fact.kind, 'feature');
  if (env.fact.kind !== 'feature') return;
  const typed: FeatureFact = env.fact.fact;
  assert.deepEqual(typed, { kind: 'typing', gid: '1234567890123456789', from: 'cust-9', until_ms: 1761800005000 });
  const recalled: FeatureFact = JSON.parse('{"kind":"recalled","gid":"1234567890123456789","message_id":"9876543210987654321"}');
  assert.equal(recalled.kind, 'recalled');
  const queue: FeatureFact = JSON.parse('{"kind":"queue_notice","gid":"1234567890123456789"}');
  assert.deepEqual(queue, { kind: 'queue_notice', gid: '1234567890123456789' });
  // host → main window: the fact flattened with the host-bound account
  const event = JSON.parse(FEATURE_EVENT_JSON) as Record<string, unknown>;
  assert.deepEqual(Object.keys(event).sort(), ['account', 'from', 'gid', 'kind', 'until_ms']);
  assert.deepEqual(event['account'], ctx(2));
  assert.deepEqual({ ...event, account: undefined }, { ...typed, account: undefined });
});

test('dto.rs declares the Feature variant and FeatureFactDto exactly as the TS union', () => {
  const dto = readFileSync(join(vbk, 'src-tauri', 'src', 'dto.rs'), 'utf8');
  const adapterFact = dto.slice(dto.indexOf('pub enum AdapterFactDto'), dto.indexOf('pub enum FeatureFactDto'));
  assert.match(adapterFact, /Feature \{\s*fact: FeatureFactDto,\s*\}/);
  const feature = dto.slice(dto.indexOf('pub enum FeatureFactDto'));
  const body = feature.slice(0, feature.indexOf('\n}\n'));
  const preamble = dto.slice(Math.max(0, dto.indexOf('pub enum FeatureFactDto') - 160), dto.indexOf('pub enum FeatureFactDto'));
  assert.match(preamble, /#\[serde\(tag = "kind", rename_all = "snake_case"\)\]\s*$/, 'internally tagged on kind, snake_case');
  assert.match(body, /Typing \{\s*gid: String,\s*from: String,\s*until_ms: i64,\s*\}/);
  assert.match(body, /Recalled \{\s*gid: String,\s*message_id: String,\s*\}/);
  assert.match(body, /QueueNotice \{\s*gid: String,\s*\}/);
  assert.equal((body.match(/^\s{4}[A-Z]\w* \{/gm) ?? []).length, 3, 'exactly three variants');
  assert.ok(dto.includes(FEATURE_ENVELOPE_JSON.slice(FEATURE_ENVELOPE_JSON.indexOf('"fact":{"kind":"feature"'))), 'the Rust test parses the same fact sample');
  const events = readFileSync(join(vbk, 'src-tauri', 'src', 'events.rs'), 'utf8');
  assert.match(events, /pub const FEATURE_FACT: &str = "feature:\/\/fact";/);
});
