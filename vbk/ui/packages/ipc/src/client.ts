/**
 * Thin invoke/listen wrapper over Tauri 2's injected globals.
 *
 * The host exposes `window.__TAURI__` (withGlobalTauri). We feature-detect it
 * and type it loosely through `unknown`, so this file has no dependency on
 * `@tauri-apps/api`. In a browser without the host, apps fall back to
 * `createMockIpc()` from `./mock.ts`.
 */

import type {
  AccountContext,
  ConversationFact,
  ReminderSettings,
  SendDisposition,
  SenderRole,
  TransportState,
} from './contracts.ts';

export interface IpcClient {
  invoke<T>(cmd: string, payload?: unknown): Promise<T>;
  /** Returns an unsubscribe function. The handler receives the event payload. */
  listen<T>(event: string, cb: (payload: T) => void): () => void;
}

interface TauriLike {
  readonly core?: { readonly invoke?: (cmd: string, args?: unknown) => Promise<unknown> };
  readonly event?: {
    readonly listen?: (name: string, handler: (ev: { readonly payload: unknown }) => void) => Promise<() => void>;
  };
}

function tauriGlobal(): TauriLike | null {
  if (typeof window === 'undefined') return null;
  const g = (window as unknown as { __TAURI__?: unknown }).__TAURI__;
  if (!g || typeof g !== 'object') return null;
  const tl = g as TauriLike;
  if (typeof tl.core?.invoke !== 'function' || typeof tl.event?.listen !== 'function') return null;
  return tl;
}

export function hasTauri(): boolean {
  return tauriGlobal() !== null;
}

/** Error code used when the host globals are missing (not part of the frozen contract; UI-only). */
export const HOST_UNAVAILABLE = 'host.unavailable';

/**
 * Never throws: the globals are resolved lazily on every call, so a client
 * created before `window.__TAURI__` exists works once it appears. Without the
 * host, `invoke` rejects with an `AppError` (`host.unavailable`) and `listen`
 * is a no-op that returns an unsubscribe function. Callers that want the mock
 * instead should check `hasTauri()` first (see `apps/_shared/ipc.ts`).
 */
export function createTauriIpc(): IpcClient {
  return {
    invoke<T>(cmd: string, payload?: unknown): Promise<T> {
      const invoke = tauriGlobal()?.core?.invoke;
      if (!invoke) return Promise.reject({ code: HOST_UNAVAILABLE, message: 'window.__TAURI__ is not available', retryable: true });
      try {
        return Promise.resolve(invoke(cmd, payload ?? {})) as Promise<T>;
      } catch (e) {
        return Promise.reject(e);
      }
    },
    listen<T>(event: string, cb: (payload: T) => void): () => void {
      const listen = tauriGlobal()?.event?.listen;
      if (!listen) return () => undefined;
      let disposed = false;
      let unlisten: (() => void) | null = null;
      void listen(event, (ev) => {
        if (!disposed) cb(ev.payload as T);
      })
        .then((fn) => {
          if (disposed) fn();
          else unlisten = fn;
        })
        .catch(() => undefined);
      return () => {
        disposed = true;
        if (unlisten) unlisten();
      };
    },
  };
}

// ---------------------------------------------------------------------------
// UI-facing commands — FROZEN 2026-10-30 (integration owner).
//
// Every payload echoes the `AccountContext` so the host can reject stale
// generations; none of them carry credentials. Return shapes are exactly the
// `Ui*` interfaces below; the Rust host serializes to these shapes.
// Account commands in `AccountCommands` take `{account}` (not a bare id) and
// return `UiAccountSnapshot`; `account_start_login` returns `{attempt_id}`
// and the host itself opens the login window.
// ---------------------------------------------------------------------------

export const UiCommands = {
  // account (in addition to AccountCommands)
  ACCOUNT_SET_REMARK: 'account_set_remark', // {account, remark}
  ACCOUNT_AGENT_STATUS: 'account_agent_status', // {account} → UiAgentStatus (read-back only)
  ACCOUNT_SET_AGENT_STATUS: 'account_set_agent_status', // {account, status} → UiAgentStatus (server read-back)
  ACCOUNT_CANCEL_LOGIN: 'account_cancel_login', // {attempt_id} → UiAccountSnapshot
  // im display models (web adapter → host → main)
  IM_CONVERSATIONS: 'im_conversations', // {account} → UiConversation[]
  IM_MESSAGES: 'im_messages', // {account, gid} → UiMessage[]
  IM_SEND_TEXT: 'im_send_text', // {account, gid, local_id, text, original?, quote_id?} → SendDisposition
  IM_SET_TOP: 'im_set_top', // {account, gid, top}
  IM_SET_MARK: 'im_set_mark', // {account, gid, action: 0..5}  (official setWorkSheetStar)
  IM_MARK_READ: 'im_mark_read', // {account, gid}
  IM_CUSTOMER_SCRIPTS: 'im_customer_scripts', // {account, content} → UiCustomerScripts
  IM_MEMBERS: 'im_members', // {account, gid} → UiMembers
  IM_INVITE_CANDIDATES: 'im_invite_candidates', // {account, gid, parent_skill_group_ids?} → UiInviteCandidates
  IM_INVITE: 'im_invite', // {account, gid, selection_token, target_uids} → UiPeripheralWrite
  IM_TRANSFER: 'im_transfer', // {account, gid, selection_token, target_uid} → UiPeripheralWrite
  IM_FINISH: 'im_finish', // {account, gid, selection_token} → UiPeripheralWrite
  // notification centre (official getIQConversations / getIQMessages / putAdviceofreadIQMessage)
  NOTICE_CATEGORIES: 'notice_categories', // {account} → UiNoticeCategory[]
  NOTICE_LIST: 'notice_list', // {account, category_id} → UiNotice[]
  NOTICE_MARK_READ: 'notice_mark_read', // {account, category_id, id | null}
  // order contact (official searchorderlist / createimchat)
  ORDER_SEARCH: 'order_search', // {account, order_id} → OrderSearchResult
  ORDER_CREATE_IM_CHAT: 'order_create_im_chat', // {account, order_id} → {gid}
  // shell / media placeholders
  SHELL_OPEN_EXTERNAL: 'shell_open_external', // {url}
  SHELL_OPEN_WEBVIEW: 'shell_open_webview', // {account, url}
  SHELL_OPEN_WINDOW: 'shell_open_window', // {label}
  SHELL_WINDOW: 'shell_window', // {action: 'minimize'|'toggle_maximize'|'close'}
  MEDIA_SCREENSHOT: 'media_screenshot', // {} → {attachment_id, name}
  MEDIA_PICK: 'media_pick', // {kind: 'image'|'file'|'video'} → {attachment_id, name} | null
  NET_STATUS: 'net_status', // {include_diagnostics?: boolean, account?: AccountContext} → UiNetStatus; diagnostics require account
  // prefs (in addition to PrefsCommands.SNAPSHOT)
  // {section, key, value} → PrefsSnapshot. `section: 'reminder'` is accepted only for the fields without a
  // notify_set_* command (continuous_l4, position_bottom_right, alert_during_dnd, alert_during_fullscreen,
  // tray_flash, taskbar_badge); enabled / t1_seconds / timeout_sound are rejected (`prefs.use_notify`).
  PREFS_SET: 'prefs_set',
  // assistant (TSim)
  ASSIST_TSIM_STATUS: 'assistant_tsim_status', // {} → {logged_in, user}
  ASSIST_TSIM_LOGIN: 'assistant_tsim_login', // {user, password} → {logged_in, user}  (password never stored in UI)
  ASSIST_TSIM_LOGOUT: 'assistant_tsim_logout',
  ASSIST_TRANSLATE: 'assistant_translate', // {account, gid, draft_version, text, target} → {draft_version, text}
  ASSIST_PACKAGE: 'assistant_package_quick_view', // {iccid} → UiPackageInfo
} as const;

/** Events needed in addition to `Events`. */
export const UiEvents = {
  NET_STATUS: 'net://status', // UiNetStatus
  AGENT_STATUS: 'account://agent-status', // UiAgentStatus
  TOAST: 'shell://toast', // {text}
} as const;

export type AccountState = 'online' | 'logging_in' | 'expired' | 'suspended';

export interface UiPersonProfile { readonly uid: string; readonly name: string | null; readonly avatar: string | null }

export interface UiAccount {
  /** Current verified IM agent; never substitute the platform account nickname. */
  readonly self_profile?: UiPersonProfile | null;
  readonly context: AccountContext;
  readonly nick: string;
  readonly remark: string | null;
  readonly party: string;
  readonly color: string;
  readonly state: AccountState;
  readonly unread: number;
}

export interface UiAccountSnapshot {
  readonly accounts: readonly UiAccount[];
  readonly active_account_id: string | null;
  readonly max_accounts: number;
}

export type AgentStatus = 'online' | 'hangup' | 'leaving' | 'getoff';

export interface UiAgentStatus {
  readonly status: AgentStatus;
  /** False until the web page has read the status back from the server. */
  readonly confirmed: boolean;
}

export interface UiNetStatus {
  readonly online: boolean;
  readonly transport: TransportState;
  readonly diagnostics?: UiReceiveDiagnostics;
}

/** Read-only receive-path counters. No upstream identifiers, payloads or free errors. */
export interface UiSdkReceiveDiagnostics {
  readonly binding: {
    readonly global_state: 'emitter' | 'missing' | 'invalid' | 'unreadable' | 'disposed';
    readonly listener_health: 'verified' | 'missing' | 'unsupported' | 'detached';
    readonly attached: boolean; readonly can_rebind: boolean;
    readonly binding_generation: number; readonly attach_count: number; readonly repair_count: number;
  };
  readonly counters: { readonly callbacks: number; readonly stale_callbacks: number; readonly messages: number; readonly acks: number; readonly ignored: number; readonly listener_errors: number };
  readonly last_stanza_ms: number | null;
}
export interface UiPageReceiveDiagnostics {
  readonly version: 1; readonly captured_at_ms: number; readonly running: boolean; readonly run_generation: number;
  readonly sdk: UiSdkReceiveDiagnostics | null;
  readonly session: { readonly received: number; readonly ui_mapped: number; readonly ui_dropped: number; readonly display_batches: number; readonly display_items: number; readonly display_resolved: number; readonly display_rejected: number };
  readonly compensation: {
    readonly running: boolean; readonly mode: 'normal' | 'frequent' | 'stopped'; readonly cursor_ms: number; readonly last_outcome_ms: number | null;
    readonly outcomes: { readonly success: number; readonly business_failure: number; readonly auth_invalid: number; readonly http_error: number; readonly malformed: number; readonly network_error: number; readonly timeout: number; readonly unknown: number };
    readonly rows: number; readonly mapped: number; readonly dropped: number;
  };
}
export interface UiHostReceiveDiagnostics {
  readonly display_entered: number; readonly display_decode_rejected: number; readonly display_apply_rejected: number;
  readonly message_items: number; readonly changed_messages: number; readonly main_emit_attempts: number;
}
export interface UiReceiveDiagnostics {
  readonly version: 1; readonly captured_at_ms: number;
  readonly availability: 'ready' | 'no_account' | 'timeout' | 'unavailable' | 'invalid';
  readonly page: UiPageReceiveDiagnostics | null; readonly host: UiHostReceiveDiagnostics | null;
}

/** 0 = clear, 1 橙, 2 绿, 3 蓝, 4 紫, 5 粉 (official `setWorkSheetStar.action`). */
export type MarkAction = 0 | 1 | 2 | 3 | 4 | 5;

export interface UiOrderSummary {
  readonly order_id: string;
  readonly product: string;
  readonly use_date: string;
  readonly quantity: string;
  readonly status: string;
  /** Masked contact label, never a phone number. */
  readonly contact: string;
  readonly source_channel?: string;
  readonly total_amount?: string;
  readonly source_title?: string;
  readonly source_description?: string;
}

export interface UiConversation extends ConversationFact {
  /** Avatar of the verified conversation customer uid; never the account agent. */
  readonly customer_avatar?: string | null;
  readonly account: AccountContext;
  readonly title: string;
  readonly color: string;
  readonly lang: string;
  readonly biz: string;
  readonly preview: string;
  readonly draft: string;
  readonly is_top: boolean;
  readonly mark: MarkAction;
  readonly waiting_since_ms: number | null;
  readonly waiting_confirmed: boolean;
  readonly customer_tags: readonly string[];
  readonly order: UiOrderSummary | null;
}

export type UiMessageKind = 'text' | 'image' | 'file' | 'video' | 'order_card' | 'system';

export interface UiMessage {
  readonly gid: string;
  readonly message_id: string | null;
  readonly local_id: string | null;
  readonly create_time_ms: number;
  readonly sender_role: SenderRole;
  readonly sender_id?: string;
  readonly sender_name?: string | null;
  readonly sender_avatar?: string | null;
  readonly kind: UiMessageKind;
  readonly text: string;
  readonly media_url?: string | null;
  readonly media_thumbnail?: string | null;
  readonly media_filename?: string | null;
  /** Server target of an authoritative recall control message. */
  readonly recalled_message_id?: string | null;
  /** Inbound: platform translation under the original. */
  readonly translation: string | null;
  /** Outbound in direct-send mode: the Chinese original kept for self-check. */
  readonly original: string | null;
  readonly quote: string | null;
  readonly order_id: string | null;
  /** null while sending; otherwise confirmed/rejected/unknown. */
  readonly disposition: SendDisposition | null;
}

export interface UiNoticeCategory {
  readonly id: string;
  readonly name: string;
  readonly unread: number;
}

export interface UiNotice {
  readonly id: string;
  readonly category_id: string;
  readonly title: string;
  readonly body: string;
  readonly time_ms: number;
  readonly unread: boolean;
  /** Official page to open externally; never rebuilt in the client. */
  readonly url: string;
}

export type OrderSearchResult =
  | { readonly kind: 'none' }
  | { readonly kind: 'one'; readonly order: UiOrderSummary }
  | { readonly kind: 'multiple'; readonly orders: readonly UiOrderSummary[] }
  | { readonly kind: 'forbidden' };

export type SendMode = 'replace_draft' | 'send_direct';

export interface PrefsSnapshot {
  readonly reminder: ReminderSettings;
  readonly general: {
    readonly autostart: boolean;
    readonly close_action: 'tray' | 'quit';
    readonly start_hidden: boolean;
    readonly show_msg_time: boolean;
    readonly spell_check: boolean;
  };
  readonly display: { readonly zoom: 75 | 100 | 125 | 150; readonly gpu: boolean };
  readonly keys: { readonly send_key: 'enter' | 'ctrl_enter'; readonly screenshot: string; readonly toggle_main: string };
  readonly assistant: {
    readonly enabled: boolean;
    readonly outbound_translation: boolean;
    readonly send_mode: SendMode;
    readonly package_quick_view: boolean;
    readonly tsim_logged_in: boolean;
    readonly tsim_user: string | null;
  };
  readonly dnd: { readonly schedule_enabled: boolean; readonly follow_system: boolean };
  readonly network: { readonly system_proxy: boolean };
  readonly storage: { readonly cache_days: 30 | 90 | 180 | 365; readonly cache_mb: number };
  readonly privacy: { readonly analytics: boolean; readonly crash_upload: boolean };
}

export type PrefsSection = Exclude<keyof PrefsSnapshot, 'reminder'>;

export interface UiPackageInfo {
  readonly iccid: string;
  readonly plan: string;
  readonly status: string;
  readonly remain_pct: number;
  readonly remain: string;
  readonly total: string;
  readonly supplier: string;
  readonly apn: string;
  readonly fetched_at_ms: number;
}

export interface UiTsimStatus {
  readonly logged_in: boolean;
  readonly user: string | null;
}

/** Nonempty script entries have no captured field schema; never expose guessed reply text. */
export interface UiCustomerScripts { readonly kind: 'empty' | 'unsupported'; readonly raw_count: number; readonly reason?: string }
export interface UiMember { readonly avatar?: string | null; readonly uid: string; readonly nickname: string | null; readonly status: string; readonly roles: readonly number[]; readonly can_transfer: boolean }
export interface UiMembers { readonly members: readonly UiMember[]; readonly fetched_at_ms: number; readonly selection_token: string; readonly expires_at_ms: number }
export interface UiInviteCandidates {
  readonly selection_token: string; readonly expires_at_ms: number;
  readonly skill_groups: readonly { readonly skill_group_id: number; readonly name: string }[];
  readonly agents: readonly { readonly uid: string; readonly nickname: string | null; readonly avatar?: string | null }[];
}
/** Only a matching independent read-back makes an action confirmed. A repeated
 * same action in the same session returns the original result without another write. */
export interface UiPeripheralWrite { readonly kind: 'confirmed' | 'accepted' | 'unknown' | 'not_submitted'; readonly confirmed: boolean; readonly reason?: string }
