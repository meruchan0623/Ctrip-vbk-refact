/**
 * Thin invoke/listen wrapper over Tauri 2's injected globals.
 *
 * The host exposes `window.__TAURI__` (withGlobalTauri). We feature-detect it
 * and type it loosely through `unknown`, so this file has no dependency on
 * `@tauri-apps/api`. In a browser without the host, apps fall back to
 * `createMockIpc()` from `./mock.ts`.
 */

import { CONTRACT_VERSION, ErrorCodes, isAppError } from './contracts.ts';
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
  /** Resolves only once the host listener is installed; rejects on failure. */
  listenReady?<T>(event: string, cb: (payload: T) => void): Promise<() => void>;
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

/** Global Tauri cleanup can be synchronous or return a rejecting Promise. */
function safeDispose(dispose: () => unknown): void {
  try { void Promise.resolve(dispose()).catch(() => undefined); }
  catch { /* subscription is locally disposed even if native cleanup fails */ }
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
  // Contract handshake (I-03): the first call of this window announces the
  // contract version; every other call waits for it. A version mismatch is
  // sticky (the host rejects the whole window), other failures are retried
  // by the next call.
  let hello: Promise<unknown> | null = null;
  let rejected: unknown = null;
  const handshake = (invoke: (cmd: string, args?: unknown) => Promise<unknown>): Promise<unknown> => {
    if (rejected !== null) return Promise.reject(rejected);
    hello ??= Promise.resolve(invoke(UiCommands.CONTRACT_HELLO, { version: CONTRACT_VERSION })).catch((e: unknown) => {
      hello = null;
      if (isAppError(e) && e.code === ErrorCodes.HOST_CONTRACT_MISMATCH) rejected = e;
      throw e;
    });
    return hello;
  };
  return {
    invoke<T>(cmd: string, payload?: unknown): Promise<T> {
      const invoke = tauriGlobal()?.core?.invoke;
      if (!invoke) return Promise.reject({ code: HOST_UNAVAILABLE, message: 'window.__TAURI__ is not available', retryable: true });
      try {
        if (cmd === UiCommands.CONTRACT_HELLO) return Promise.resolve(invoke(cmd, payload ?? {})) as Promise<T>;
        return handshake(invoke).then(() => invoke(cmd, payload ?? {})) as Promise<T>;
      } catch (e) {
        return Promise.reject(e);
      }
    },
    async listenReady<T>(event: string, cb: (payload: T) => void): Promise<() => void> {
      const listen = tauriGlobal()?.event?.listen;
      if (!listen) throw { code: HOST_UNAVAILABLE, message: 'window.__TAURI__ is not available', retryable: true };
      let disposed = false;
      const off = await listen(event, (ev) => { if (!disposed) cb(ev.payload as T); });
      return () => { if (!disposed) { disposed = true; safeDispose(off); } };
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
          if (disposed) safeDispose(fn);
          else unlisten = fn;
        })
        .catch(() => undefined);
      return () => {
        if (disposed) return;
        disposed = true;
        const off = unlisten; unlisten = null;
        if (off) safeDispose(off);
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
  WEBVIEW_RECOVERY_STATUS: 'webview_recovery_status',
  WEBVIEW_RECOVERY_RETRY: 'webview_recovery_retry',
  // contract version handshake (I-03): first call of every local window
  DEEP_LINK_SETTING_TAKE: 'deep_link_setting_take', // setting-only, pending section or null
  DEEP_LINK_TAKE: 'deep_link_take', // main-only, no args, validated pending navigation[]
  CONTRACT_HELLO: 'contract_hello', // {version} → null; host.contract_mismatch rejects the window
  // account (in addition to AccountCommands)
  ACCOUNT_SET_REMARK: 'account_set_remark', // {account, remark}
  ACCOUNT_AGENT_STATUS: 'account_agent_status', // {account} → UiAgentStatus (read-back only)
  ACCOUNT_SET_AGENT_STATUS: 'account_set_agent_status', // {account, status} → UiAgentStatus (server read-back)
  ACCOUNT_CANCEL_LOGIN: 'account_cancel_login', // {attempt_id} → UiAccountSnapshot
  // im display models (web adapter → host → main)
  IM_CONVERSATIONS: 'im_conversations', // {account} → UiConversation[]
  IM_OUTBOUND_LOOKUP: 'im_outbound_lookup', // {account, gid} -> UiOutboundLookup; no display or read-receipt effects
  IM_UNKNOWN_OUTBOUND: 'im_unknown_outbound', // {account} -> UiUnknownOutboundRecord[]; read-only metadata
  IM_MESSAGES: 'im_messages', // {account, gid} → UiMessage[]
  IM_MESSAGE_PAGE: 'im_message_page', // {account, gid, before_ms?, expected_context_revision?} → UiMessagePage
  IM_TRANSLATE_MESSAGES: 'im_translate_messages', // {account, gid, message_ids (≤20)} → UiMessageTranslations
  IM_COPY_MESSAGE_IMAGE: 'im_copy_message_image',
  IM_SAVE_MESSAGE_IMAGE: 'im_save_message_image',
  IM_FORWARD_MESSAGE: 'im_forward_message',
  IM_SAVED_EMOJIS: 'im_saved_emojis',
  IM_ADD_SAVED_EMOJI: 'im_add_saved_emoji',
  IM_UPDATE_SAVED_EMOJI: 'im_update_saved_emoji',
  IM_SEND_SAVED_EMOJI: 'im_send_saved_emoji',
  IM_SEND_TEXT: 'im_send_text', // {account, gid, local_id, text, original?, quote_id?} → SendDisposition
  IM_SEND_MEDIA: 'im_send_media', // {account,gid,local_id,attachment_id} → UiMediaSendResult
  IM_SET_TOP: 'im_set_top', // {account, gid, top}
  IM_SET_MARK: 'im_set_mark', // {account, gid, action: 0..5}  (official setWorkSheetStar)
  IM_MARK_READ: 'im_mark_read', // {account, gid, expected_message_id, expected_context_revision}
  IM_CUSTOMER_SCRIPTS: 'im_customer_scripts', // {account, content} → UiCustomerScripts
  IM_QUICK_REPLY_CATEGORIES: 'im_quick_reply_categories', // {account,type:'VAGENT'|'VSKILLGROUP'} → UiQuickReplyCategories
  IM_QUICK_REPLY_MANAGE_INFO: 'im_quick_reply_manage_info', // {account,type} → UiQuickReplyManageInfo
  IM_QUICK_REPLY_EDIT: 'im_quick_reply_edit', // {account,type,edit:UiQuickReplyEdit} → UiQuickReplyEditResult (never replayed)
  IM_RECOMMEND_PRODUCTS: 'im_recommend_products',
  IM_RECOMMEND_CITIES: 'im_recommend_cities',
  IM_SEND_PRODUCT_CARD: 'im_send_product_card',
  IM_MEMBERS: 'im_members', // {account, gid} → UiMembers
  IM_INVITE_CANDIDATES: 'im_invite_candidates', // {account, gid, parent_skill_group_ids? | keywords?, extend_token?} → UiInviteCandidates
  IM_INVITE: 'im_invite', // {account, gid, selection_token, target_uids} → UiPeripheralWrite
  IM_TRANSFER: 'im_transfer', // {account, gid, selection_token, target_uid} → UiPeripheralWrite
  IM_FINISH: 'im_finish', // {account, gid, selection_token} → UiPeripheralWrite
  IM_REMOVE: 'im_remove', // {account, gid, selection_token, target_uids} → UiPeripheralWrite (finishConversation + venAgentUids)
  IM_DRAFT_ATTACHMENT_SAVE: 'im_draft_attachment_save',
  IM_DRAFT_ATTACHMENT_RESTORE: 'im_draft_attachment_restore',
  // notification centre (official getIQConversations / getIQMessages / putAdviceofreadIQMessage)
  NOTICE_CATEGORIES: 'notice_categories', // {account} → UiNoticeCategory[]
  NOTICE_LIST: 'notice_list', // {account, category_id, before_ms?} → UiNotice[] (up to 100, older than cursor)
  NOTICE_MARK_READ: 'notice_mark_read', // {account, category_id, id | null}
  // order contact (official searchorderlist / createimchat)
  ORDER_SEARCH: 'order_search', // {account, order_id} → OrderSearchResult
  ORDER_CREATE_IM_CHAT: 'order_create_im_chat', // {account, order_id} → {gid}
  // shell / media placeholders
  SHELL_OPEN_EXTERNAL: 'shell_open_external', // {url}
  SHELL_OPEN_WEBVIEW: 'shell_open_webview', // {account, url} → UiBrowserTab; opens/reuses a tab of the built-in browser
  BROWSER_SHOW: 'browser_show', // {tab_id: string|null, bounds?: {x,y,width,height}} logical px; null hides all
  BROWSER_NAV: 'browser_nav', // {tab_id, action: 'back'|'forward'|'reload'}
  BROWSER_CLOSE: 'browser_close', // {tab_id}
  SHELL_OPEN_WINDOW: 'shell_open_window', // {label, section?}
  SHELL_WINDOW: 'shell_window', // {action: 'state'|'minimize'|'toggle_maximize'|'close'|'system_menu'} → {maximized, focused}
  MEDIA_SAVE_IMAGE: 'media_save_image', // media-viewer window only: {index} of the bound gallery → {saved:boolean}; native dialog, original bytes only
  MEDIA_PICK: 'media_pick', // {account,gid,kind:'image'|'file'} → UiAttachment | null
  MEDIA_ACCEPT_DROP: 'media_accept_drop', // {account,gid,drop_id} → UiAttachment | null; redeems a media://dropped id
  MEDIA_RELEASE: 'media_release', // {account,gid,attachment_id} → null; never clears a durable intent
  NET_STATUS: 'net_status', // {include_diagnostics?: boolean, account?: AccountContext} → UiNetStatus; diagnostics require account
  // prefs (in addition to PrefsCommands.SNAPSHOT)
  // {section, key, value} → PrefsSnapshot. `section: 'reminder'` is accepted only for the fields without a
  // notify_set_* command (continuous_l4, alarm_corner, alert_during_dnd, alert_during_fullscreen,
  // tray_flash, taskbar_badge); enabled / t1_seconds / timeout_sound are rejected (`prefs.use_notify`).
  PREFS_SET: 'prefs_set',
  // assistant (TSim)
  ASSIST_TSIM_STATUS: 'assistant_tsim_status', // {} → {logged_in, user}
  ASSIST_TSIM_LOGIN: 'assistant_tsim_login', // {user, password} → {logged_in, user}  (password never stored in UI)
  ASSIST_TSIM_LOGOUT: 'assistant_tsim_logout',
  ASSIST_TRANSLATE: 'assistant_translate', // {account, gid, draft_version, text, target} → {draft_version, text}
  ASSIST_ORDER_SUMMARY: 'assistant_order_summary',
  ASSIST_PACKAGE_DETAIL_OPEN: 'assistant_package_detail_open',
  ASSIST_PACKAGE_DETAIL: 'assistant_package_detail',
  MEDIA_VIEWER_OPEN_MESSAGE: 'media_viewer_open_message', // {account,gid,message_id}; the host resolves the URL
  MEDIA_VIEWER_OPEN_EMOJI: 'media_viewer_open_emoji', // {account,id}
  MEDIA_VIEWER_CURRENT: 'media_viewer_current', // → UiViewerGallery; viewer window only
  MEDIA_VIEWER_CONTEXT_MENU: 'media_viewer_context_menu', // {index}; viewer window only; host shows the native menu (copy file/video)
  MEDIA_VIEWER_OPEN_EXTERNAL: 'media_viewer_open_external', // {index}; viewer window only; opens an item of its bound gallery
  // {account, gid, order_id, context_revision, session_epoch} → UiTsimOperatorGrant;
  // scope-checked iframe handoff. Keep the credential outside stores, logs and URLs.
  ASSIST_TSIM_ORDER_OPEN: 'assistant_tsim_order_open',
  // {account, gid, iccid, session_epoch} → UiTsimOperatorGrant; same iframe handoff, identifierType=iccid.
  ASSIST_TSIM_ICCID_OPEN: 'assistant_tsim_iccid_open',
  ASSIST_PACKAGE: 'assistant_package_quick_view', // {iccid} → UiPackageInfo
} as const;

/** Events needed in addition to `Events`. */
export const UiEvents = {
  MEDIA_DRAG: 'media://drag', // {active}: OS file drag over the main UI
  MEDIA_DROPPED: 'media://dropped', // {drop_id, name, count}
  BROWSER_TAB_OPENED: 'browser://tab-opened', // UiBrowserTab opened by a page; activate it
  BROWSER_TAB_CHANGED: 'browser://tab-changed', // UiBrowserTab
  BROWSER_TAB_CLOSED: 'browser://tab-closed', // {tab_id}
  WEBVIEW_RECOVERY: 'webview://recovery',
  PACKAGE_DETAIL_INVALIDATED: 'assistant://package-detail-invalidated',
  MEDIA_VIEWER_CHANGED: 'media-viewer://changed',
  MEDIA_VIEWER_COPY: 'media-viewer://copy', // payload 'copying' | 'copied' | 'failed'
  TSIM_STATUS: 'assistant://tsim-status', // UiTsimStatus; local views only
  MEDIA_SEND_PROGRESS: 'media://send-progress',
  NET_STATUS: 'net://status', // UiNetStatus
  AGENT_STATUS: 'account://agent-status', // UiAgentStatusEvent
  TOAST: 'shell://toast', // {text}
} as const;

export interface UiAttachment {
  readonly attachment_id: string; readonly name: string;
  readonly lease_id?: string;
  readonly kind: 'image' | 'file' | 'video'; readonly mime: string; readonly size: number;
  readonly content_sha256: string; readonly owner: { readonly account: AccountContext; readonly gid: string };
  readonly supported: true;
  /** Small `data:image/jpeg` composer thumbnail; images only. */
  readonly preview_data_url?: string;
}
export interface UiBrowserTab {
  readonly tab_id: string; readonly account_id: string;
  readonly url: string; readonly title: string; readonly loading: boolean;
}
export interface UiDraftAttachment {
  readonly lease_id: string;
  readonly name: string;
  readonly kind: 'image' | 'file' | 'video';
  readonly mime: string;
  readonly size: number;
  readonly content_sha256: string;
  readonly state: 'ready' | 'missing' | 'corrupt' | 'pending';
}
export interface UiDraftAttachmentSnapshot {
  readonly attachment_version: number;
  readonly attachments: readonly UiDraftAttachment[];
}
export interface UiMediaSendResult {
  /** Existing ledger metadata without a verifiable selected attachment. Never project/clear the current composer. */
  readonly replay_only?: boolean;
  readonly stage: 'prepare' | 'upload' | 'send';
  readonly kind: 'not_submitted' | 'unknown' | 'confirmed' | 'rejected';
  readonly write_started: boolean; readonly disposition: SendDisposition | null;
  readonly message: UiMessage | null; readonly error: string | null;
}
export interface UiMediaSendProgress {
  readonly account: AccountContext; readonly gid: string; readonly attachment_id: string; readonly local_id: string;
  readonly stage: 'prepare' | 'upload' | 'send';
}

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
  /**
   * Host-wide: a durable write failed and has not been retried successfully
   * (「本地保存失败」). While true the host refuses `im_send_text` /
   * `im_send_media` with `store.persist_failed` and the UI pauses sending;
   * the host re-emits `account://changed` when it flips back. Absent = false
   * (older snapshots, mocks).
   */
  readonly persist_failed?: boolean;
}

export type AgentStatus = 'online' | 'hangup' | 'leaving' | 'getoff';

export interface UiAgentStatus {
  readonly status: AgentStatus;
  /** False until the web page has read the status back from the server. */
  readonly confirmed: boolean;
}

/** Broadcasts must retain their owner; RPC results are scoped by their request. */
export interface UiAgentStatusEvent extends UiAgentStatus {
  readonly account: AccountContext;
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
export interface UiBridgeDiagnostics {
  readonly state: 'active' | 'overflow' | 'disposed';
  readonly capacity: number; readonly pending: number; readonly queued: number; readonly in_flight: number;
  readonly waiting: number; readonly waiting_high_water: number;
  readonly high_water: number; readonly accepted: number; readonly invoked: number; readonly delivered: number;
  readonly failed: number; readonly overflow_events: number; readonly rejected: number; readonly expired: number;
  readonly stale_completions: number; readonly callback_errors: number;
}
export interface UiPageReceiveDiagnostics {
  readonly version: 1; readonly captured_at_ms: number; readonly running: boolean; readonly run_generation: number;
  readonly sdk: UiSdkReceiveDiagnostics | null;
  readonly bridge?: UiBridgeDiagnostics;
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
  readonly product_id?: string;
  readonly customer_language?: string;
  readonly product_price?: string;
  readonly source_channel?: string;
  readonly total_amount?: string;
  readonly remark_name?: string;
  readonly source_title?: string;
  readonly source_description?: string;
}

export interface UiConversation extends ConversationFact {
  /** Raw bounded official business type; old DTOs may omit it, unknown is never inferred. */
  readonly conversation_type?: string | null;
  readonly assistant_context_revision?: string;
  /** Current verified read frontier; never inferred from the highest-time mixed history row. */
  readonly read_target_message_id?: string | null;
  /** Avatar of the verified conversation customer uid; never the account agent. */
  readonly customer_avatar?: string | null;
  readonly vendor_name?: string;
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

export type UiMessageKind = 'text' | 'image' | 'file' | 'video' | 'voice' | 'order_card' | 'system';

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
  /** Original platform message type; drives the official menu's capabilities. */
  readonly platform_type?: number | null;
  readonly text: string;
  readonly media_url?: string | null;
  readonly media_thumbnail?: string | null;
  readonly media_filename?: string | null;
  /** `kind: 'voice'` only: whole seconds from the body; null when missing or invalid. */
  readonly voice_duration_s?: number | null;
  readonly recalled_message_id?: string | null;
  readonly read_status?: 'read' | 'unread' | 'unknown';
  /** Inbound: platform translation under the original. */
  readonly translation: string | null;
  /** Outbound in direct-send mode: the Chinese original kept for self-check. */
  readonly original: string | null;
  readonly quote: string | null;
  readonly order_id: string | null;
  /** null while sending; otherwise confirmed/rejected/unknown. */
  readonly disposition: SendDisposition | null;
}

export interface UiOutboundLookup {
  readonly items: readonly Pick<UiMessage, 'gid' | 'message_id' | 'local_id' | 'sender_role'>[];
}

export interface UiUnknownOutboundRecord {
  readonly environment: string;
  readonly account_id: string;
  readonly local_id: string;
  readonly gid: string;
  readonly creation_generation: number;
  readonly created_at_ms: number;
  readonly write_started: boolean;
  readonly phase: 'write_started' | 'unknown' | 'upload_started' | 'uploaded';
}

/** One explicit answer per requested ID of a platform translation batch. */
export interface UiMessageTranslation {
  readonly message_id: string;
  readonly status: 'translated' | 'not_needed' | 'missing' | 'unsupported';
  readonly translation: string | null;
  readonly source_kind: 'text' | 'system' | null;
  /** Why the platform's answer took this form; `flagged` is its `idWithTranslatedMap[id] === true`. */
  readonly reason?: 'flagged' | 'card' | 'blank' | 'no_row' | 'option_off' | null;
}

export interface UiMessageTranslations {
  readonly items: readonly UiMessageTranslation[];
  /** Translation provider label returned by the platform, when any. */
  readonly supplier: string | null;
  /** Short hash of the session asked about, for telling stale-session answers apart in logs. */
  readonly session_tag?: string | null;
}

export interface UiMessagePage {
  readonly items: readonly UiMessage[];
  readonly has_more: boolean;
  /** Exclusive server history boundary; null when no earlier page is available. */
  readonly before_ms: number | null;
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
  readonly keys: { readonly send_key: 'enter' | 'ctrl_enter'; readonly toggle_main: string };
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
  /** Notice categories that use a banner, per `environment:account_id`. */
  readonly notice_banner: { readonly accounts: Readonly<Record<string, readonly string[]>> };
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
  /** Safe display-only fields; supplied by the order-query projection. */
  readonly detail_fields?: readonly UiPackageField[];
  readonly live_fields?: readonly UiPackageField[];
  readonly cdrs?: readonly (readonly UiPackageField[])[];
  readonly usage_scope?: 'daily' | 'total';
  readonly unlimited?: boolean;
}

/** Ephemeral reply for the main shell's fixed-origin operator iframe only. */
export interface UiTsimOperatorGrant {
  readonly url: string;
  readonly identifier: string;
  readonly request_id: string;
  readonly session_epoch: number;
  readonly access_token: string;
  readonly session_ref: string | null;
}

export interface UiTsimStatus {
  readonly session_epoch: number;
  readonly logged_in: boolean;
  readonly user: string | null;
}

/** `sort_no` comes with category reads; the suggestion path (`im_customer_scripts`) drops it. */
export interface UiQuickReplyScript { readonly id: string; readonly content: string; readonly short_cut: string; readonly type: string; readonly sort_no?: number }
export type UiCustomerScripts = { readonly kind: 'ready'; readonly raw_count: number; readonly items: readonly UiQuickReplyScript[] } | { readonly kind: 'empty' | 'unsupported'; readonly raw_count: number; readonly items?: readonly UiQuickReplyScript[]; readonly reason?: string };
export interface UiQuickReplySkillGroup { readonly id: string; readonly name: string }
export interface UiQuickReplyCategory {
  readonly id: string; readonly name: string;
  /** Category code / numeric owner type as read; writes re-read them in the adapter and never trust this copy. */
  readonly code?: string | null; readonly owner_type?: number | null;
  /** Team categories: the skill groups the category applies to (official "scope" field). */
  readonly skill_groups?: readonly UiQuickReplySkillGroup[];
  readonly scripts: readonly UiQuickReplyScript[]; readonly sub_categories: readonly UiQuickReplyCategory[];
  /** Server rows under this category and its sub-categories (blank and over-budget rows included); `scripts` may list fewer. */
  readonly script_total?: number;
}
export interface UiQuickReplyCategories { readonly categories: readonly UiQuickReplyCategory[] }
export type UiQuickReplyType = 'VAGENT' | 'VSKILLGROUP';
/** Personal: always editable, no skill groups. Team: only `jobPosition == LEADER` may edit. */
export interface UiQuickReplyManageInfo { readonly can_edit: boolean; readonly skill_groups: readonly UiQuickReplySkillGroup[] }
/** The nine official quick-reply writes (personal-settings dialog). IDs are decimal strings. */
export type UiQuickReplyEdit =
  | { readonly op: 'create_category'; readonly name: string; readonly skill_group_ids: readonly string[] }
  | { readonly op: 'update_category'; readonly category_id: string; readonly name: string; readonly skill_group_ids: readonly string[] }
  | { readonly op: 'delete_category'; readonly category_id: string }
  | { readonly op: 'sort_categories'; readonly category_ids: readonly string[] }
  | { readonly op: 'add_script'; readonly category_id: string; readonly content: string }
  | { readonly op: 'update_script'; readonly script_id: string; readonly content: string }
  | { readonly op: 'move_script'; readonly script_id: string; readonly target_category_id: string }
  | { readonly op: 'delete_script'; readonly script_id: string }
  | { readonly op: 'sort_scripts'; readonly category_id: string; readonly script_ids: readonly string[] };
export type UiQuickReplyEditReason = 'invalid' | 'stale' | 'not_leader' | 'busy' | 'not_submitted' | 'auth' | 'business' | 'write_unknown' | 'readback_failed' | 'unverified';
/**
 * `applied` only after a matching read-back; `rejected` means nothing changed
 * (nothing sent, or the server refused); `unknown` must be checked by the user
 * against the fresh list and is never resubmitted. `categories` is the latest
 * read (absent when the host synthesised the outcome; the UI then re-reads).
 */
export interface UiQuickReplyEditResult {
  readonly kind: 'applied' | 'rejected' | 'unknown';
  readonly reason?: UiQuickReplyEditReason;
  readonly detail?: string;
  readonly categories?: readonly UiQuickReplyCategory[];
}
export type UiMemberRole = 'master' | 'agent' | 'customer' | 'robot' | 'company' | 'other';
export interface UiMember {
  readonly avatar?: string | null; readonly uid: string; readonly nickname: string | null; readonly status: string; readonly roles: readonly number[];
  readonly role?: UiMemberRole; readonly present?: boolean; readonly is_self?: boolean;
  readonly can_transfer: boolean; readonly can_remove?: boolean;
}
export interface UiMembers { readonly members: readonly UiMember[]; readonly self_is_master?: boolean; readonly fetched_at_ms: number; readonly selection_token: string; readonly expires_at_ms: number }
/** Official chat status (imWindow DE/Fh): 0 在线 / 1 挂起 / 2 离开 / 3 下班; duty_status 1 上班. */
export interface UiInviteAgent {
  readonly uid: string; readonly nickname: string | null; readonly avatar?: string | null; readonly in_group?: boolean;
  readonly status?: number | null; readonly duty_status?: number | null; readonly job_position?: string | null; readonly job_position_type?: number | null; readonly skill_group_full_name?: string | null;
}
export interface UiInviteCandidates {
  readonly selection_token: string; readonly expires_at_ms: number;
  readonly skill_groups: readonly { readonly skill_group_id: number; readonly name: string }[];
  readonly agents: readonly UiInviteAgent[];
}
/** Only a matching independent read-back makes an action confirmed. A repeated
 * same action in the same session returns the original result without another write. */
export interface UiPeripheralWrite { readonly kind: 'confirmed' | 'accepted' | 'unknown' | 'not_submitted'; readonly confirmed: boolean; readonly reason?: string }

export type UiOrderPackageInfo = Omit<UiPackageInfo, 'remain_pct'> & { readonly remain_pct: number | null };
/** 补发套餐（detail.reissue_list）：宿主逐条读取，按补发时间升序、至多 10 个；读取失败的条目 state='error' 且 info 为 null。 */
export interface UiOrderReissue { readonly create_time_ms: number | null; readonly state: 'ready' | 'error'; readonly info: UiOrderPackageInfo | null }
export interface UiOrderPackagePlan extends UiOrderPackageInfo { readonly detail_handle: string; readonly order_time?: string; readonly reissues?: readonly UiOrderReissue[] }
export interface UiOrderPackageSummary {
  readonly account: AccountContext; readonly gid: string; readonly order_id: string;
  readonly session_epoch: number; readonly context_revision: string; readonly query_handle: string;
  readonly plans: readonly UiOrderPackagePlan[]; readonly total: number; readonly fetched_at_ms: number;
}
export interface UiPackageField { readonly label: string; readonly value: string }
export interface UiViewerAttachment {
  readonly kind: 'image' | 'video' | 'file';
  readonly url: string;
  readonly name: string;
  readonly thumbnail: string | null;
  /** The host can re-resolve and save the original of this item ("另存"). */
  readonly saveable?: boolean;
}

export interface UiViewerGallery {
  readonly items: readonly UiViewerAttachment[];
  readonly index: number;
}

export interface UiPackageDetail {
  readonly order_id: string; readonly session_epoch: number; readonly plan: UiOrderPackageInfo;
  readonly detail_fields: readonly UiPackageField[]; readonly live_fields: readonly UiPackageField[];
  readonly cdrs: readonly (readonly UiPackageField[])[]; readonly fetched_at_ms: number;
}
