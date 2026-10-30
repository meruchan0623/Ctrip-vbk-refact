import type { AccountContext } from '../../packages/ipc/src/contracts.ts';
import type { UiReceiveDiagnostics } from '../../packages/ipc/src/client.ts';

export interface MainReceiveCounters { readonly received: number; readonly guard_rejected: number; readonly account_dropped: number; readonly upserted: number }
export interface ReceiveSnapshot extends UiReceiveDiagnostics { readonly main: MainReceiveCounters }
export interface ReceiveDiagnosticsView { readonly busy: boolean; readonly snapshot: ReceiveSnapshot | null }
const emptyCounters = (): MainReceiveCounters => ({ received: 0, guard_rejected: 0, account_dropped: 0, upserted: 0 });
const key = (scope: AccountContext | null): string => scope ? JSON.stringify([scope.environment, scope.account_id, scope.session_generation]) : 'no-account';
const sameScope = (a: AccountContext | null, b: AccountContext | null): boolean => key(a) === key(b);

/** Keys stay private. Only four aggregate counters can leave this object. */
export function createReceiveCounters() {
  const scopes = new Map<string, MainReceiveCounters>();
  return {
    count(scope: AccountContext | null, field: keyof MainReceiveCounters): void {
      const id = key(scope);
      const prior = scopes.get(id) ?? emptyCounters();
      scopes.set(id, { ...prior, [field]: prior[field] + 1 });
    },
    snapshot(scope: AccountContext | null): MainReceiveCounters { return { ...(scopes.get(key(scope)) ?? emptyCounters()) }; },
  };
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid');
  return value as Record<string, unknown>;
}
function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('invalid');
  return value;
}
function nullableNumber(value: unknown): number | null { return value === null ? null : number(value); }
function boolean(value: unknown): boolean { if (typeof value !== 'boolean') throw new Error('invalid'); return value; }
function literal<T extends string>(value: unknown, allowed: readonly T[]): T { if (!allowed.includes(value as T)) throw new Error('invalid'); return value as T; }
function numbers<K extends string>(value: unknown, fields: readonly K[]): Record<K, number> {
  const row = record(value);
  return Object.fromEntries(fields.map((field) => [field, number(row[field])])) as Record<K, number>;
}
function fixed(availability: UiReceiveDiagnostics['availability'], now: number): UiReceiveDiagnostics {
  return { version: 1, captured_at_ms: now, availability, page: null, host: null };
}

/** Rebuild the known schema. Never serialize original IPC objects, free errors or identifiers. */
export function safeReceiveDiagnostics(value: unknown, now: number): UiReceiveDiagnostics {
  try {
    const raw = record(value);
    if (raw['version'] !== 1) throw new Error('invalid');
    const page = raw['page'] === null ? null : record(raw['page']);
    const sdk = page?.['sdk'] === null || page === null ? null : record(page['sdk']);
    const binding = sdk ? record(sdk['binding']) : null;
    const comp = page ? record(page['compensation']) : null;
    return {
      version: 1, captured_at_ms: number(raw['captured_at_ms']),
      availability: literal(raw['availability'], ['ready', 'no_account', 'timeout', 'unavailable', 'invalid']),
      page: page && comp ? {
        version: page['version'] === 1 ? 1 : (() => { throw new Error('invalid'); })(),
        captured_at_ms: number(page['captured_at_ms']), running: boolean(page['running']), run_generation: number(page['run_generation']),
        sdk: sdk && binding ? {
          binding: {
            global_state: literal(binding['global_state'], ['emitter', 'missing', 'invalid', 'unreadable', 'disposed']),
            listener_health: literal(binding['listener_health'], ['verified', 'missing', 'unsupported', 'detached']),
            attached: boolean(binding['attached']), can_rebind: boolean(binding['can_rebind']),
            ...numbers(binding, ['binding_generation', 'attach_count', 'repair_count']),
          },
          counters: numbers(sdk['counters'], ['callbacks', 'stale_callbacks', 'messages', 'acks', 'ignored', 'listener_errors']),
          last_stanza_ms: nullableNumber(sdk['last_stanza_ms']),
        } : null,
        session: numbers(page['session'], ['received', 'ui_mapped', 'ui_dropped', 'display_batches', 'display_items', 'display_resolved', 'display_rejected']),
        compensation: {
          running: boolean(comp['running']), mode: literal(comp['mode'], ['normal', 'frequent', 'stopped']),
          cursor_ms: number(comp['cursor_ms']), last_outcome_ms: nullableNumber(comp['last_outcome_ms']),
          outcomes: numbers(comp['outcomes'], ['success', 'business_failure', 'auth_invalid', 'http_error', 'malformed', 'network_error', 'timeout', 'unknown']),
          ...numbers(comp, ['rows', 'mapped', 'dropped']),
        },
      } : null,
      host: raw['host'] === null ? null : numbers(raw['host'], ['display_entered', 'display_decode_rejected', 'display_apply_rejected', 'message_items', 'changed_messages', 'main_emit_attempts']),
    };
  } catch { return fixed('invalid', now); }
}
export function receiveDiagnosticsJson(snapshot: ReceiveSnapshot): string {
  // Even callers constructing a snapshot cannot smuggle additional keys into copied JSON.
  return JSON.stringify({ ...safeReceiveDiagnostics(snapshot, snapshot.captured_at_ms), main: numbers(snapshot.main, ['received', 'guard_rejected', 'account_dropped', 'upserted']) }, null, 2);
}

interface Dependencies {
  current(): AccountContext | null;
  invoke(payload: { include_diagnostics: true; account: AccountContext }): Promise<unknown>;
  counters: ReturnType<typeof createReceiveCounters>;
  now(): number;
  publish(view: ReceiveDiagnosticsView | null): void;
}
export function createReceiveDiagnostics(deps: Dependencies) {
  let view: ReceiveDiagnosticsView | null = null;
  let sequence = 0;
  function close() { sequence++; view = null; deps.publish(null); }
  async function refresh() {
    if (!view || view.busy) return;
    const owner = deps.current();
    const captured = owner ? { ...owner } : null;
    const ticket = ++sequence;
    view = { ...view, busy: true }; deps.publish(view);
    let diagnostics: UiReceiveDiagnostics;
    if (!captured) diagnostics = fixed('no_account', deps.now());
    else {
      try {
        const raw = record(await deps.invoke({ include_diagnostics: true, account: captured }));
        diagnostics = safeReceiveDiagnostics(raw['diagnostics'], deps.now());
      } catch { diagnostics = fixed('unavailable', deps.now()); }
    }
    if (ticket !== sequence || !view || !sameScope(captured, deps.current())) return;
    view = { busy: false, snapshot: { ...diagnostics, main: deps.counters.snapshot(captured) } };
    deps.publish(view);
  }
  async function open() { sequence++; view = { busy: false, snapshot: null }; deps.publish(view); await refresh(); }
  return { open, refresh, close };
}
