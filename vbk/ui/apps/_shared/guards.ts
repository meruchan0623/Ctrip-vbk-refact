/**
 * Shallow runtime guards for event payloads. Events come from the host (or
 * the mock) over IPC; a window must never crash on a null/garbage payload
 * (00-architecture §4: the UI treats anything from the wire as data). Each
 * guard checks exactly the fields the views dereference, nothing more.
 */

import type { AccountContext, AlarmSnapshot, ClockReading } from '../../packages/ipc/src/contracts.ts';
import type { PrefsSnapshot, UiAccountSnapshot, UiAgentStatus, UiConversation, UiMessage, UiNetStatus } from '../../packages/ipc/src/client.ts';

type Rec = Record<string, unknown>;

function rec(x: unknown): x is Rec {
  return typeof x === 'object' && x !== null;
}

function str(x: unknown): x is string {
  return typeof x === 'string';
}

function num(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

function bool(x: unknown): x is boolean {
  return typeof x === 'boolean';
}

function nullableNum(x: unknown): boolean {
  return x === null || num(x);
}

function nullableStr(x: unknown): boolean {
  return x === null || str(x);
}

function accountContext(x: unknown): boolean {
  return rec(x) && str(x['account_id']) && str(x['environment']) && num(x['session_generation']);
}

export function isAlarmSnapshot(x: unknown): x is AlarmSnapshot {
  if (!rec(x)) return false;
  if (!num(x['generated_at_ms']) || !bool(x['clock_trusted']) || !bool(x['reconciling'])) return false;
  const s = x['settings'];
  if (!rec(s) || !bool(s['enabled']) || !num(s['t1_seconds']) || !bool(s['continuous_l4'])) return false;
  const entries = x['entries'];
  if (!Array.isArray(entries)) return false;
  return entries.every(
    (e: unknown) =>
      rec(e) &&
      accountContext(e['account']) &&
      str(e['gid']) &&
      str(e['round_id']) &&
      num(e['version']) &&
      str(e['label']) &&
      nullableNum(e['waiting_since_ms']) &&
      num(e['waited_seconds']) &&
      str(e['level']) &&
      bool(e['start_confirmed']) &&
      nullableNum(e['snoozed_until_ms']),
  );
}

export function isUiConversation(x: unknown): x is UiConversation {
  return (
    rec(x) &&
    accountContext(x['account']) &&
    str(x['gid']) &&
    str(x['status']) &&
    str(x['title']) &&
    str(x['color']) &&
    str(x['lang']) &&
    str(x['biz']) &&
    str(x['preview']) &&
    str(x['draft']) &&
    bool(x['is_top']) &&
    num(x['mark']) &&
    num(x['unread_count']) &&
    nullableNum(x['last_message_time_ms']) &&
    nullableNum(x['waiting_since_ms']) &&
    bool(x['waiting_confirmed']) &&
    Array.isArray(x['customer_tags']) &&
    (x['customer_tags'] as unknown[]).every(str) &&
    (x['order'] === null || (rec(x['order']) && str(x['order']['order_id'])))
  );
}

export function isUiMessage(x: unknown): x is UiMessage {
  return (
    rec(x) &&
    str(x['gid']) &&
    nullableStr(x['message_id']) &&
    nullableStr(x['local_id']) &&
    num(x['create_time_ms']) &&
    str(x['sender_role']) &&
    str(x['kind']) &&
    str(x['text']) &&
    nullableStr(x['translation']) &&
    nullableStr(x['original']) &&
    nullableStr(x['quote']) &&
    nullableStr(x['order_id']) &&
    (x['disposition'] === null || (rec(x['disposition']) && str(x['disposition']['kind'])))
  );
}

export function isPrefsSnapshot(x: unknown): x is PrefsSnapshot {
  if (!rec(x)) return false;
  for (const k of ['reminder', 'general', 'display', 'keys', 'assistant', 'dnd', 'network', 'storage', 'privacy']) if (!rec(x[k])) return false;
  const r = x['reminder'] as Rec;
  const a = x['assistant'] as Rec;
  return bool(r['enabled']) && num(r['t1_seconds']) && bool(a['enabled']) && str(a['send_mode']);
}

export function isUiAccountSnapshot(x: unknown): x is UiAccountSnapshot {
  if (!rec(x) || !Array.isArray(x['accounts']) || !nullableStr(x['active_account_id']) || !num(x['max_accounts'])) return false;
  return (x['accounts'] as unknown[]).every((a) => rec(a) && accountContext(a['context']) && str(a['nick']) && nullableStr(a['remark']) && str(a['party']) && str(a['color']) && str(a['state']) && num(a['unread']));
}

export function isClockReading(x: unknown): x is ClockReading {
  return rec(x) && num(x['server_now_ms']) && rec(x['quality']) && str(x['quality']['kind']);
}

export function isUiNetStatus(x: unknown): x is UiNetStatus {
  return rec(x) && bool(x['online']) && str(x['transport']);
}

export function isUiAgentStatus(x: unknown): x is UiAgentStatus {
  return rec(x) && str(x['status']) && bool(x['confirmed']);
}

export function isToastPayload(x: unknown): x is { readonly text: string } {
  return rec(x) && str(x['text']);
}

/** `im://locate-conversation` → `{account, gid}`. */
export interface LocatePayload {
  readonly account: AccountContext;
  readonly gid: string;
}

export function isLocatePayload(x: unknown): x is LocatePayload {
  return rec(x) && accountContext(x['account']) && str(x['gid']) && x['gid'] !== '';
}

/** `notify://banner` → `{account, gid, count, stay_ms, system?}` (scheduler.rs). No message text. */
export interface BannerPayload {
  readonly account: AccountContext;
  readonly gid: string;
  readonly count: number;
  readonly stay_ms: number;
  readonly system?: boolean;
}

export function isBannerPayload(x: unknown): x is BannerPayload {
  return rec(x) && accountContext(x['account']) && str(x['gid']) && num(x['count']) && x['count'] >= 0 && num(x['stay_ms']) && x['stay_ms'] >= 0 && (x['system'] === undefined || bool(x['system']));
}

export type SoundName = 'new_message' | 'timeout' | 'loop';

/** `notify://play-sound` carries the bare clip name. */
export function isSoundName(x: unknown): x is SoundName {
  return x === 'new_message' || x === 'timeout' || x === 'loop';
}

/** `im://message-new` may carry the owning account next to the message; when present it must be well-formed. */
export function messageAccount(x: unknown): AccountContext | null {
  if (!rec(x) || !accountContext(x['account'])) return null;
  return x['account'] as AccountContext;
}

/** `account_start_login` result. */
export function isAttemptResult(x: unknown): x is { readonly attempt_id: string } {
  return rec(x) && str(x['attempt_id']) && x['attempt_id'] !== '';
}

/** Wrap an event handler so that a malformed payload is dropped (and logged) instead of throwing. */
export function guarded<T>(event: string, guard: (x: unknown) => x is T, handler: (payload: T) => void): (payload: unknown) => void {
  return (payload: unknown) => {
    if (!guard(payload)) {
      console.warn(`[ipc] dropped malformed payload for ${event}`);
      return;
    }
    handler(payload);
  };
}
