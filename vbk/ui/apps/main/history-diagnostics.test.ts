import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHistoryDiagnostics } from './history-diagnostics.ts';

test('geometry diagnostics require opt-in, have a fixed numeric schema, and never export caller strings', () => {
  const trace = createHistoryDiagnostics(); trace.record('capture', { rows: 3 }); assert.equal(trace.snapshot().events.length, 0);
  trace.start();
  trace.record('capture', { rows: 3, top: 1.234, gid: 'SECRET', text: 'SECRET', scope: 'SECRET', scrollTop: NaN, offset: 1e16 } as any, 'SECRET' as any);
  trace.record('SECRET' as any, { rows: 9 });
  assert.deepEqual(trace.snapshot().events, [{ sequence: 1, stage: 'capture', metrics: { top: 1.2, rows: 3 } }]);
  assert.ok(!JSON.stringify(trace.snapshot()).includes('SECRET'));
  trace.stop(); trace.record('scroll', { rows: 5 }); assert.equal(trace.snapshot().events.length, 1);
});
test('geometry trace is bounded, snapshots detached, clear stops recording', () => {
  const trace = createHistoryDiagnostics(); trace.start();
  for (let i = 0; i < 600; i++) trace.record('capture', { row: i });
  const snapshot = trace.snapshot(); assert.equal(snapshot.events.length, 512); assert.equal(snapshot.dropped, 88);
  snapshot.events[0]!.metrics.row = -1; assert.equal(trace.snapshot().events[0]!.metrics.row, 88);
  trace.clear(); assert.equal(trace.active(), false); assert.equal(trace.snapshot().events.length, 0);
});
