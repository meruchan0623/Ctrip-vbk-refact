const stages = ['capture', 'capture_done', 'capture_skip', 'candidate', 'match', 'restore', 'restore_skip', 'resize', 'scroll', 'clamp'] as const;
const reasons = ['no_conversation', 'wrong_scope', 'pinned', 'no_candidates', 'no_anchor', 'missing', 'ambiguous', 'reverse_ambiguous', 'applied', 'observed', 'unchanged'] as const;
const metrics = ['capture', 'row', 'newRow', 'keyType', 'top', 'bottom', 'offset', 'rows', 'visible', 'candidates', 'matches', 'reverseMatches', 'scrollTop', 'scrollHeight', 'clientHeight', 'before', 'after', 'delta', 'maximum', 'pinned'] as const;
type Stage = typeof stages[number];
type Reason = typeof reasons[number];
type Metrics = Partial<Record<typeof metrics[number], number>>;

/** Explicit, memory-only geometry trace. No caller-provided strings or identifiers are retained. */
export function createHistoryDiagnostics() {
  let active = false, sequence = 0, dropped = 0;
  const events: { sequence: number; stage: Stage; reason?: Reason; metrics: Metrics }[] = [];
  return {
    active: () => active,
    start() { events.length = 0; sequence = 0; dropped = 0; active = true; },
    stop() { active = false; },
    clear() { active = false; events.length = 0; sequence = 0; dropped = 0; },
    record(stage: Stage, values: Metrics = {}, reason?: Reason): number {
      if (!active || !stages.includes(stage)) return 0;
      const safe: Metrics = {};
      for (const key of metrics) {
        const value = values[key];
        if (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 10_000_000) safe[key] = Math.round(value * 10) / 10;
      }
      const event = { sequence: ++sequence, stage, ...(reason && reasons.includes(reason) ? { reason } : {}), metrics: safe };
      // The real single-page reproduction produced 3769 events before the panel reopened.
      // Keep that transition intact while retaining a fixed, memory-only upper bound.
      if (events.length === 8192) { events.shift(); dropped++; }
      events.push(event);
      return sequence;
    },
    snapshot() { return { schema: 'history-geometry-v1', active, dropped, events: events.map(event => ({ ...event, metrics: { ...event.metrics } })) }; },
  };
}
export const historyDiagnostics = createHistoryDiagnostics();
