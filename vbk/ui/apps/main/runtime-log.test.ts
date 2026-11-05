import assert from 'node:assert/strict';
import test from 'node:test';
import { buildReport, createRuntimeLog, LOG_SCHEMA } from './runtime-log.ts';
import { EMPTY_RECOVERY } from '../_shared/recovery.ts';

test('log keeps a bounded ring and counts dropped entries', () => {
  const log = createRuntimeLog({ now: () => 1000, capacity: 3 });
  for (let i = 0; i < 5; i++) log.record('app', 'info', 'tick', { n: i });
  assert.equal(log.entries().length, 3);
  assert.equal(log.dropped(), 2);
  assert.deepEqual(log.entries().map((e) => e.seq), [3, 4, 5]);
  log.clear();
  assert.equal(log.entries().length, 0);
});

test('log rejects bad names and redacts free text', () => {
  const log = createRuntimeLog({ now: () => 1 });
  log.record('app', 'info', 'Bad Event');
  log.record('nope' as 'app', 'info', 'ok');
  log.record('receive', 'warn', 'guard_rejected', { reason: 'hello customer, 你好', n: NaN, ok: true, 'Bad Key': 1, tag: 'shape_invalid' });
  const [entry] = log.entries();
  assert.equal(log.entries().length, 1);
  assert.deepEqual(entry!.fields, { reason: '[redacted]', n: null, ok: true, tag: 'shape_invalid' });
});

test('report is one parseable document without bodies or conversation ids', () => {
  const log = createRuntimeLog({ now: () => 0 });
  log.record('send', 'warn', 'verify.unknown', { found: false });
  const text = buildReport({
    generated_at_ms: 0, version: '1.0.0', environment: 'prod',
    unknown_send: [{ environment: 'prod', account_id: 'acct-secret', local_id: 'L1', gid: 'conversation-secret', creation_generation: 2, created_at_ms: 5, write_started: true, phase: 'unknown' }],
    unknown_send_result: { kind: 'unknown', server_id_present: false },
    receive: null,
    recovery: { ...EMPTY_RECOVERY, connected: true, rows: [{ label: 'acct-profile-secret', incarnation: 1, revision: 2, phase: 'manual', attempt: 3 }] },
    scroll: { schema: 'history-geometry-v1', events: [] },
    log,
  });
  const parsed = JSON.parse(text);
  assert.equal(parsed.schema, LOG_SCHEMA);
  assert.equal(parsed.unknown_send.count, 1);
  assert.equal(parsed.recovery.rows[0].phase, 'manual');
  assert.equal(parsed.recovery.rows[0].window, 'account');
  assert.equal(parsed.events.items[0].event, 'verify.unknown');
  assert.doesNotMatch(text, /acct-secret|conversation-secret|profile-secret/);
});
