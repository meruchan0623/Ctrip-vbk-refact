import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeHistory, mergeHistoryIncremental } from './viewmodel.ts';
import type { UiMessage } from '../../packages/ipc/src/client.ts';

// Deterministic xorshift so a failure is reproducible from its seed.
function rng(seed: number): (n: number) => number {
  let x = seed >>> 0 || 1;
  return n => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x % n; };
}
function random(next: (n: number) => number): UiMessage {
  const id = next(14), withServer = next(3) > 0, withLocal = next(3) > 0;
  const role = (['customer', 'merchant_self', 'unknown'] as const)[next(3)]!;
  const sender = next(4) === 0 ? undefined : `s${next(3)}`;
  const confirmed = withServer && next(3) === 0;
  return {
    gid: next(8) === 0 ? 'g2' : 'g1', message_id: withServer ? `m${id}` : null, local_id: withLocal ? `l${next(10) < 8 ? id : next(14)}` : null,
    text: `t${next(100)}`, kind: next(12) === 0 ? 'system' : 'text', create_time_ms: next(9) * 10, sender_role: role, ...(sender ? { sender_id: sender } : {}),
    sender_name: null, sender_avatar: null, translation: null, original: null, quote: null, order_id: null,
    disposition: confirmed ? { kind: 'confirmed', server_message_id: `m${id}`, server_time_ms: next(9) * 10 } : next(5) === 0 ? { kind: 'unknown' } : null,
  } as UiMessage;
}
const base = (): UiMessage => ({ gid: 'g1', message_id: 'm1', local_id: null, text: 'a', kind: 'text', create_time_ms: 10, sender_role: 'customer', sender_id: 's', sender_name: null, sender_avatar: null, translation: null, original: null, quote: null, order_id: null, disposition: null });

test('incremental single insert equals the full merge, step by step, on random histories', () => {
  let fast = 0, full = 0;
  for (let seed = 1; seed <= 400; seed++) {
    const next = rng(seed * 7919);
    // A real mergeHistory output, as the store holds it.
    let incremental = mergeHistory(Array.from({ length: next(25) }, () => random(next)), []);
    let reference = incremental;
    for (let step = 0; step < 40; step++) {
      const message = random(next);
      const known = new Set(incremental.flatMap(r => [r.message_id && `${r.gid}/m/${r.message_id}`, r.local_id && `${r.gid}/l/${r.local_id}`]));
      const touches = (message.message_id && known.has(`${message.gid}/m/${message.message_id}`)) || (message.local_id && known.has(`${message.gid}/l/${message.local_id}`));
      incremental = mergeHistoryIncremental(incremental, message);
      reference = mergeHistory(reference, [message]);
      if (touches) full++; else fast++;
      assert.deepEqual(incremental, reference, `seed ${seed} step ${step}`);
    }
  }
  assert.ok(fast > 2000 && full > 500, `both paths exercised (fast=${fast}, full=${full})`);
});

test('incremental result is itself a merge output: chained inserts keep taking the fast path and stay equal', () => {
  const next = rng(42);
  let incremental = mergeHistory([], []), reference: UiMessage[] = [];
  for (let i = 0; i < 300; i++) {
    const message = { ...base(), message_id: `m${i}`, create_time_ms: next(50) };
    incremental = mergeHistoryIncremental(incremental, message);
    reference = mergeHistory(reference, [message]);
  }
  assert.deepEqual(incremental, reference);
});

test('a list of unknown provenance, or a non-finite timestamp, falls back to the full path', () => {
  const handBuilt = [base(), { ...base(), message_id: 'm1' }];
  assert.deepEqual(mergeHistoryIncremental(handBuilt, { ...base(), message_id: 'm2' }), mergeHistory(handBuilt, [{ ...base(), message_id: 'm2' }]));
  const out = mergeHistory([base()], []);
  const odd = { ...base(), message_id: 'm9', create_time_ms: Number.NaN };
  assert.deepEqual(mergeHistoryIncremental(out, odd), mergeHistory(out, [odd]));
});

test('the previous list stays usable after an incremental insert (index is rebuilt, not corrupted)', () => {
  const first = mergeHistory([base()], []);
  const second = mergeHistoryIncremental(first, { ...base(), message_id: 'm2', create_time_ms: 20 });
  const sibling = mergeHistoryIncremental(first, { ...base(), message_id: 'm3', create_time_ms: 5 });
  assert.deepEqual(second.map(m => m.message_id), ['m1', 'm2']);
  assert.deepEqual(sibling.map(m => m.message_id), ['m3', 'm1']);
  assert.deepEqual(mergeHistoryIncremental(second, { ...base(), message_id: 'm2', text: 'dup' }).length, 2, 'exact server match replaces, never duplicates');
});

test('10k-row single insert beats the full merge (micro-benchmark; steady state after the first insert)', () => {
  const rows = Array.from({ length: 10_000 }, (_, i) => ({ ...base(), message_id: `m${i}`, create_time_ms: i }));
  const list = mergeHistory(rows, []);
  const t0 = performance.now(); mergeHistory(list, [{ ...base(), message_id: 'full', create_time_ms: 30_000 }]); const fullMs = performance.now() - t0;
  const t1 = performance.now(); const warm = mergeHistoryIncremental(list, { ...base(), message_id: 'first', create_time_ms: 20_000 }); const firstMs = performance.now() - t1;
  const t2 = performance.now(); mergeHistoryIncremental(warm, { ...base(), message_id: 'live', create_time_ms: 30_000 }); const steadyMs = performance.now() - t2;
  assert.ok(steadyMs < fullMs, `steady ${steadyMs.toFixed(2)}ms vs full ${fullMs.toFixed(2)}ms`);
  console.log(`# mergeHistory(10k,1): full=${fullMs.toFixed(2)}ms, first incremental (verify+index)=${firstMs.toFixed(2)}ms, steady incremental=${steadyMs.toFixed(2)}ms`);
});
