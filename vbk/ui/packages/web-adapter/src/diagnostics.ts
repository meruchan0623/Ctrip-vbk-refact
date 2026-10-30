/** Saturating counters only. Never retain an event, identifier, URL or error. */
export const receiveCount = (value: number, amount = 1): number => Math.min(Number.MAX_SAFE_INTEGER, value + amount);
export function createReceiveCounters() {
  return {
    session: { received: 0, ui_mapped: 0, ui_dropped: 0, display_batches: 0, display_items: 0, display_resolved: 0, display_rejected: 0 },
    compensation: { last_outcome_ms: null as number | null, outcomes: { success: 0, business_failure: 0, auth_invalid: 0, http_error: 0, malformed: 0, network_error: 0, timeout: 0, unknown: 0 }, rows: 0, mapped: 0, dropped: 0 },
  };
}
