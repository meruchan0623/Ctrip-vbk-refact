/**
 * TypeScript mirror of `vbk/crates/contracts` (identity, event envelope,
 * error, IM facts, alarm DTOs). There is no generator in this environment:
 * keep this file and the Rust crate in step by hand, and add a test when a
 * shape changes.
 *
 * Nothing here may carry cookies, tickets, tokens or customer message text.
 */

// ---------------------------------------------------------------- identity

export type AccountId = string;
export type Environment = string;
export const PRODUCTION_ENVIRONMENT: Environment = 'production';

/** `AccountContext = {account_id, environment, session_generation}` */
export interface AccountContext {
  readonly account_id: AccountId;
  readonly environment: Environment;
  readonly session_generation: number;
}

export interface ConversationRef {
  readonly account: AccountContext;
  readonly gid: string;
}

export interface ViewContext {
  readonly webview_label: string;
  readonly view_generation: number;
}

export interface AggregateScope {
  readonly subscription_id: string;
  readonly authorization_revision: number;
}

export type Scope =
  | { readonly kind: 'account'; readonly account: AccountContext }
  | { readonly kind: 'aggregate'; readonly aggregate: AggregateScope }
  | { readonly kind: 'app' };

export function sameAccountContext(a: AccountContext, b: AccountContext): boolean {
  return (
    a.account_id === b.account_id &&
    a.environment === b.environment &&
    a.session_generation === b.session_generation
  );
}

/** True when `candidate` is an older generation of the same persistent identity. */
export function isStaleGeneration(current: AccountContext, candidate: AccountContext): boolean {
  return (
    current.account_id === candidate.account_id &&
    current.environment === candidate.environment &&
    candidate.session_generation < current.session_generation
  );
}

// ------------------------------------------------------------------ events

export interface StreamCursor {
  readonly epoch: number;
  readonly seq: number;
}

export type CursorStep =
  | { readonly kind: 'next' }
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'gap'; readonly expected: number; readonly got: number }
  | { readonly kind: 'epoch_changed' };

export function classifyCursor(last: StreamCursor, next: StreamCursor): CursorStep {
  if (next.epoch !== last.epoch) return { kind: 'epoch_changed' };
  if (next.seq === last.seq + 1) return { kind: 'next' };
  if (next.seq <= last.seq) return { kind: 'duplicate' };
  return { kind: 'gap', expected: last.seq + 1, got: next.seq };
}

export interface EventEnvelope<P> {
  readonly scope: Scope;
  readonly stream: string;
  readonly epoch: number;
  readonly seq: number;
  readonly payload: P;
}

export interface Snapshot<D> {
  readonly scope: Scope;
  readonly stream: string;
  readonly epoch: number;
  readonly seq: number;
  readonly data: D;
}

// ------------------------------------------------------------------- error

export interface AppError {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly detail?: string;
}

export const ErrorCodes = {
  NET_OFFLINE: 'net.offline',
  NET_TIMEOUT: 'net.timeout',
  NET_PAYLOAD_TOO_LARGE: 'net.payload_too_large',
  ACCOUNT_TICKET_EXPIRED: 'account.ticket_expired',
  ACCOUNT_STALE_GENERATION: 'account.stale_generation',
  ACCOUNT_UNKNOWN: 'account.unknown',
  HOST_VIEW_UNAUTHORIZED: 'host.view_unauthorized',
  IM_SEND_UNKNOWN: 'im.send_unknown',
  IM_PERMISSION_DENIED: 'im.permission_denied',
  NOTIFY_ROUND_VERSION_MISMATCH: 'notify.round_version_mismatch',
  STORE_IO: 'store.io',
  STORE_CORRUPT: 'store.corrupt',
  ADAPTER_NOT_READY: 'adapter.not_ready',
  ADAPTER_TIMEOUT: 'adapter.timeout',
  ADAPTER_FAILED: 'adapter.failed',
  HOST_UNSUPPORTED: 'host.unsupported',
  HOST_URL_REJECTED: 'host.url_rejected',
  HOST_UNAVAILABLE: 'host.unavailable',
} as const;

export function isAppError(x: unknown): x is AppError {
  return (
    typeof x === 'object' &&
    x !== null &&
    typeof (x as AppError).code === 'string' &&
    typeof (x as AppError).message === 'string' &&
    typeof (x as AppError).retryable === 'boolean'
  );
}

// ------------------------------------------------------------------ im facts

export type MessageSource = 'realtime' | 'init' | 'history' | 'compensation';

export function isReplaySource(s: MessageSource): boolean {
  return s === 'init' || s === 'history';
}

export type SenderRole =
  | 'customer'
  | 'merchant_self'
  | 'merchant_other'
  | 'ctrip_agent'
  | 'robot'
  | 'system'
  | 'unknown';

export type MsgKind = 'business' | 'recall' | 'read_receipt' | 'typing' | 'control';

export type SendDisposition =
  | { readonly kind: 'confirmed'; readonly server_message_id: string; readonly server_time_ms: number }
  | { readonly kind: 'rejected'; readonly code: string; readonly reason: string }
  | { readonly kind: 'unknown' };

/**
 * Bounded message fact emitted by the web adapter. `account` is what the
 * adapter believes; the host re-validates source view and generation and
 * never trusts it on its own.
 */
export interface MessageFact {
  readonly gid: string;
  readonly message_id: string | null;
  readonly local_id: string | null;
  /** Server create time, Unix ms (13 digits). */
  readonly create_time_ms: number;
  readonly sender_role: SenderRole;
  /** Opaque sender id; no display name. */
  readonly sender_id: string;
  readonly kind: MsgKind;
  readonly source: MessageSource;
  readonly disposition: SendDisposition | null;
}

export type ConversationStatus = 'active' | 'finished' | 'transferred_out' | 'unknown';

export interface ConversationFact {
  readonly gid: string;
  readonly status: ConversationStatus;
  readonly agent_in_group: boolean;
  readonly is_owner: boolean;
  readonly service_type: string;
  readonly last_message_time_ms: number | null;
  readonly last_update_time_ms: number | null;
  readonly unread_count: number;
  readonly is_full_snapshot: boolean;
}

/** Stream names used for adapter → core facts. */
export const FactStreams = {
  MESSAGE: 'im.message',
  CONVERSATION: 'im.conversation',
  TRANSPORT: 'im.transport',
} as const;

export type TransportState = 'connecting' | 'connected' | 'disconnected' | 'reconnecting';

export type AdapterFact =
  | { readonly kind: 'message'; readonly fact: MessageFact }
  | { readonly kind: 'conversation'; readonly fact: ConversationFact }
  | { readonly kind: 'conversation_list_sync'; readonly full: boolean; readonly last_update_time_ms: number | null }
  | { readonly kind: 'compensation_sync'; readonly last_message_timestamp_ms: number | null }
  | { readonly kind: 'transport'; readonly state: TransportState }
  | { readonly kind: 'auth_invalid' };

/** Envelope the adapter hands to the host: identity + generation + cursor. */
export interface AdapterFactEnvelope {
  readonly account: AccountContext;
  readonly stream: (typeof FactStreams)[keyof typeof FactStreams];
  readonly epoch: number;
  readonly seq: number;
  readonly fact: AdapterFact;
}

// ------------------------------------------------------------------- clock

export type ClockQuality =
  | { readonly kind: 'anchored'; readonly offset_ms: number; readonly error_ms: number }
  | { readonly kind: 'stale' }
  | { readonly kind: 'unanchored' };

export interface ClockReading {
  readonly server_now_ms: number;
  readonly monotonic_ms: number;
  readonly quality: ClockQuality;
}

// ------------------------------------------------------------------- alarm

export type AlarmLevel = 'L0' | 'L1' | 'L2' | 'L3' | 'L4';
export type SnoozeMinutes = 5 | 10 | 30;

export const ALLOWED_T1_SECONDS = [30, 60, 90, 120, 180] as const;
export const DEFAULT_T1_SECONDS = 30;
export const T2_SECONDS = 60;
export const L4_SOUND_PERIOD_SECONDS = 15;
export const L4_SOUND_CAP_SECONDS = 600;
export const RED_AFTER_SECONDS = 90;

export interface ReminderSettings {
  readonly enabled: boolean;
  readonly t1_seconds: number;
  readonly timeout_sound: boolean;
  readonly continuous_l4: boolean;
  readonly position_bottom_right: boolean;
  readonly alert_during_dnd: boolean;
  readonly alert_during_fullscreen: boolean;
  readonly tray_flash: boolean;
  readonly taskbar_badge: boolean;
}

export const DEFAULT_REMINDER_SETTINGS: ReminderSettings = {
  enabled: true,
  t1_seconds: DEFAULT_T1_SECONDS,
  timeout_sound: true,
  continuous_l4: false,
  position_bottom_right: true,
  alert_during_dnd: true,
  alert_during_fullscreen: true,
  tray_flash: true,
  taskbar_badge: true,
};

export interface AlarmEntry {
  readonly account: AccountContext;
  readonly gid: string;
  readonly round_id: string;
  readonly version: number;
  /** Already masked by Rust; never raw message text. */
  readonly label: string;
  readonly waiting_since_ms: number | null;
  readonly waited_seconds: number;
  readonly level: AlarmLevel;
  readonly start_confirmed: boolean;
  readonly snoozed_until_ms: number | null;
}

export interface AlarmSnapshot {
  readonly generated_at_ms: number;
  readonly clock_trusted: boolean;
  readonly reconciling: boolean;
  readonly settings: ReminderSettings;
  readonly entries: readonly AlarmEntry[];
}

export type AlarmCommand =
  | { readonly kind: 'snapshot' }
  | { readonly kind: 'open_conversation'; readonly account: AccountContext; readonly gid: string; readonly round_id: string; readonly version: number }
  | { readonly kind: 'hide_round'; readonly account: AccountContext; readonly gid: string; readonly round_id: string; readonly version: number }
  | { readonly kind: 'hide_all'; readonly seen: readonly { readonly gid: string; readonly round_id: string; readonly version: number }[] }
  | { readonly kind: 'snooze'; readonly account: AccountContext; readonly gid: string; readonly round_id: string; readonly version: number; readonly minutes: SnoozeMinutes }
  | { readonly kind: 'set_enabled'; readonly enabled: boolean }
  | { readonly kind: 'set_threshold'; readonly t1_seconds: number }
  | { readonly kind: 'set_sound_enabled'; readonly enabled: boolean };
