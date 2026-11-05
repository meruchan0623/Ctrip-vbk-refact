import type { UiUnknownOutboundRecord } from '../../packages/ipc/src/client.ts';
import type { RecoveryState } from '../_shared/recovery.ts';
import { receiveDiagnosticsJson, type ReceiveSnapshot } from './receive-diagnostics.ts';

/**
 * Unified, memory-only runtime log. It folds the unknown-send ledger view, the receive
 * chain snapshot, WebView recovery state and the scroll trace into one copyable report.
 * Nothing here keeps message bodies, credentials or conversation identifiers.
 */
export const LOG_SCHEMA = 'vbk-runtime-log-v1';
export type LogSource = 'send' | 'receive' | 'recovery' | 'scroll' | 'app';
export type LogLevel = 'info' | 'warn' | 'error';
export type LogValue = string | number | boolean | null;
export interface LogEntry { readonly seq: number; readonly at_ms: number; readonly source: LogSource; readonly level: LogLevel; readonly event: string; readonly fields: Readonly<Record<string, LogValue>> }

const SOURCES: readonly LogSource[] = ['send', 'receive', 'recovery', 'scroll', 'app'];
const LEVELS: readonly LogLevel[] = ['info', 'warn', 'error'];
const EVENT = /^[a-z0-9_.]{1,64}$/;
const FIELD = /^[a-z0-9_]{1,32}$/;
const TOKEN = /^[A-Za-z0-9_.:-]{0,64}$/;

/** Only short tokens, finite numbers and booleans survive; anything else is replaced. */
function sanitize(fields: Record<string, unknown>): Record<string, LogValue> {
  const out: Record<string, LogValue> = {};
  for (const [key, value] of Object.entries(fields).slice(0, 16)) {
    if (!FIELD.test(key)) continue;
    if (value === null || typeof value === 'boolean') out[key] = value;
    else if (typeof value === 'number') out[key] = Number.isFinite(value) ? value : null;
    else out[key] = typeof value === 'string' && TOKEN.test(value) ? value : '[redacted]';
  }
  return out;
}

/** WebView labels can embed a profile id; the report only says which kind of window it was. */
export function recoveryKind(label: string): string {
  if (label.startsWith('acct-')) return 'account';
  if (label.startsWith('login')) return 'login';
  return ['main', 'setting', 'alarm', 'update', 'package-detail', 'notice', 'media-viewer'].includes(label) ? label : 'other';
}

export function createRuntimeLog(deps: { now(): number; capacity?: number }) {
  const capacity = deps.capacity ?? 500;
  const entries: LogEntry[] = [];
  let seq = 0, dropped = 0;
  return {
    record(source: LogSource, level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
      if (!SOURCES.includes(source) || !LEVELS.includes(level) || !EVENT.test(event)) return;
      if (entries.length >= capacity) { entries.shift(); dropped++; }
      entries.push({ seq: ++seq, at_ms: deps.now(), source, level, event, fields: sanitize(fields) });
    },
    entries: (): readonly LogEntry[] => entries.map((entry) => ({ ...entry, fields: { ...entry.fields } })),
    dropped: () => dropped,
    clear(): void { entries.length = 0; dropped = 0; },
  };
}
export type RuntimeLog = ReturnType<typeof createRuntimeLog>;

export interface ReportInput {
  readonly generated_at_ms: number;
  readonly version: string | null;
  readonly environment: string | null;
  readonly unknown_send: readonly UiUnknownOutboundRecord[] | null;
  readonly unknown_send_result: { readonly kind: string; readonly server_id_present: boolean } | null;
  readonly receive: ReceiveSnapshot | null;
  readonly recovery: RecoveryState | undefined;
  readonly scroll: unknown;
  readonly log: RuntimeLog;
}

/** One JSON document: easy to paste into a bug report and easy to parse back. */
export function buildReport(input: ReportInput): string {
  const report = {
    schema: LOG_SCHEMA,
    generated_at: new Date(input.generated_at_ms).toISOString(),
    app_version: input.version,
    environment: input.environment,
    unknown_send: input.unknown_send === null ? null : {
      count: input.unknown_send.length,
      last_verify: input.unknown_send_result,
      records: input.unknown_send.map((row) => ({ local_id: row.local_id, phase: row.phase, write_started: row.write_started, creation_generation: row.creation_generation, created_at: new Date(row.created_at_ms).toISOString() })),
    },
    receive: input.receive === null ? null : JSON.parse(receiveDiagnosticsJson(input.receive)) as unknown,
    recovery: input.recovery ? {
      connected: input.recovery.connected,
      error: input.recovery.error !== null || input.recovery.connectionError !== null,
      rows: input.recovery.rows.map((row) => ({ window: recoveryKind(row.label), phase: row.phase, attempt: row.attempt, incarnation: row.incarnation, revision: row.revision, listener_error: row.listener_error ?? null })),
    } : null,
    scroll: input.scroll,
    events: { dropped: input.log.dropped(), items: input.log.entries().map((entry) => ({ ...entry, at: new Date(entry.at_ms).toISOString(), at_ms: undefined })) },
  };
  return JSON.stringify(report, null, 2);
}
