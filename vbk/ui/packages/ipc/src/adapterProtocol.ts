/**
 * Wire protocol between the per-account official-page webview (`acct-*`,
 * running `web-adapter` boot script) and the host. FROZEN 2026-10-30 by the
 * integration owner; changes go through a contract request.
 *
 * Direction page → host: Tauri commands in `AdapterCommands` (granted to the
 * remote origin only via `capabilities/adapter.json`).
 * Direction host → page: event `adapter://request` emitted to that webview
 * only; the page answers with `adapter_reply`.
 *
 * The host never trusts `account` claimed by the page: it maps the calling
 * webview label → profile → AccountContext and rejects mismatches.
 * Payload data shapes reuse the UI DTOs in `client.ts`, so the host can
 * forward replies to `main` without re-shaping.
 */

import type { AccountContext, AdapterFactEnvelope, AppError, SendDisposition, TransportState } from './contracts.ts';
import type { AgentStatus, MarkAction, OrderSearchResult, UiConversation, UiMessage, UiNotice, UiNoticeCategory, UiCustomerScripts, UiMembers, UiInviteCandidates, UiPeripheralWrite } from './client.ts';

export const AdapterCommands = {
  /** Page booted on an official IM page; host answers with the bound account (null while identity unknown). */
  READY: 'adapter_ready',
  /** Identity read from the official page after login (no cookies/tokens). */
  IDENTITY: 'adapter_identity',
  /** Bounded fact envelope (same shape as `im_push_fact`). */
  PUSH_FACT: 'adapter_push_fact',
  /** Display data (titles, previews, bodies) for the in-memory display cache. Never persisted, never logged. */
  PUSH_DISPLAY: 'adapter_push_display',
  /** Answer to an `adapter://request`. */
  REPLY: 'adapter_reply',
} as const;

export const AdapterEvents = {
  REQUEST: 'adapter://request',
} as const;

export interface AdapterReadyPayload {
  readonly url: string;
  readonly sdk_version: string | null;
}

export interface AdapterReadyAck {
  /** Null until identity has been published for this webview. */
  readonly account: AccountContext | null;
  /** Persisted compensation watermark for this account (0 when unknown). */
  readonly begin_msg_time: number;
  readonly initial_epoch: number;
}

/** Upstream identity as read on the official page (getCurrentUserInfo / GetMyInfo per docs/api). */
export interface AdapterIdentityPayload {
  readonly self_profile?: import('./client.ts').UiPersonProfile | null;
  readonly buid: string;
  readonly uid: string;
  readonly agent_id: string | null;
  /** Display nickname of the logged-in merchant user. */
  readonly nick: string;
  /** Merchant / supplier name shown under the nickname. */
  readonly party: string;
  readonly environment: 'production';
}

export type AdapterPushFactPayload = AdapterFactEnvelope;

/** Conversation display row: `UiConversation` minus fields the host owns. */
export type DisplayConversation = Omit<UiConversation, 'account' | 'waiting_since_ms' | 'waiting_confirmed' | 'is_top' | 'draft'>;

export type AdapterDisplayPayload =
  | { readonly kind: 'conversations'; readonly full: boolean; readonly items: readonly DisplayConversation[]; readonly removed_gids: readonly string[] }
  | { readonly kind: 'messages'; readonly gid: string; readonly replace: boolean; readonly items: readonly UiMessage[] }
  | { readonly kind: 'message_profiles'; readonly gid: string; readonly items: readonly MessageProfilePatch[] }
  | { readonly kind: 'agent_status'; readonly status: AgentStatus; readonly confirmed: boolean }
  | { readonly kind: 'transport'; readonly state: TransportState }
  | { readonly kind: 'notice_categories'; readonly items: readonly UiNoticeCategory[] };

/** Enrichment may never replay an old message body, status, or timestamp. */
export interface MessageProfilePatch {
  readonly message_id: string | null;
  readonly local_id: string | null;
  readonly sender_id: string;
  readonly sender_name: string | null;
  readonly sender_avatar: string | null;
}

/** Operations the host may ask the page to perform. `args` per op below. */
export type AdapterRequest =
  | { readonly req_id: string; readonly op: 'im.messages'; readonly args: { readonly gid: string } }
  | { readonly req_id: string; readonly op: 'im.send_text'; readonly args: { readonly gid: string; readonly local_id: string; readonly text: string; readonly original: string | null; readonly quote_id: string | null } }
  | { readonly req_id: string; readonly op: 'im.customer_scripts'; readonly args: { readonly content: string } }
  | { readonly req_id: string; readonly op: 'im.members'; readonly args: { readonly gid: string } }
  | { readonly req_id: string; readonly op: 'im.invite_candidates'; readonly args: { readonly gid: string; readonly parent_skill_group_ids?: readonly number[] } }
  | { readonly req_id: string; readonly op: 'im.invite'; readonly args: { readonly gid: string; readonly selection_token: string; readonly target_uids: readonly string[] } }
  | { readonly req_id: string; readonly op: 'im.transfer'; readonly args: { readonly gid: string; readonly selection_token: string; readonly target_uid: string } }
  | { readonly req_id: string; readonly op: 'im.finish'; readonly args: { readonly gid: string; readonly selection_token: string } }
  | { readonly req_id: string; readonly op: 'im.mark_read'; readonly args: { readonly gid: string } }
  | { readonly req_id: string; readonly op: 'im.set_mark'; readonly args: { readonly gid: string; readonly action: MarkAction } }
  | { readonly req_id: string; readonly op: 'notice.categories'; readonly args: Record<string, never> }
  | { readonly req_id: string; readonly op: 'notice.list'; readonly args: { readonly category_id: string } }
  | { readonly req_id: string; readonly op: 'notice.mark_read'; readonly args: { readonly category_id: string; readonly id: string | null } }
  | { readonly req_id: string; readonly op: 'order.search'; readonly args: { readonly order_id: string } }
  | { readonly req_id: string; readonly op: 'order.create_im_chat'; readonly args: { readonly order_id: string } }
  | { readonly req_id: string; readonly op: 'agent.set_status'; readonly args: { readonly status: AgentStatus } }
  | { readonly req_id: string; readonly op: 'agent.status'; readonly args: Record<string, never> };

export type AdapterOp = AdapterRequest['op'];

/** Result data per op (reply `data`). */
export interface AdapterResultMap {
  'im.messages': readonly UiMessage[];
  'im.send_text': SendDisposition;
  'im.mark_read': null;
  'im.customer_scripts': UiCustomerScripts;
  'im.members': UiMembers;
  'im.invite_candidates': UiInviteCandidates;
  'im.invite': UiPeripheralWrite;
  'im.transfer': UiPeripheralWrite;
  'im.finish': UiPeripheralWrite;
  'im.set_mark': null;
  'notice.categories': readonly UiNoticeCategory[];
  'notice.list': readonly UiNotice[];
  'notice.mark_read': null;
  'order.search': OrderSearchResult;
  'order.create_im_chat': { readonly gid: string; readonly reused: boolean };
  'agent.set_status': { readonly status: AgentStatus; readonly confirmed: boolean };
  'agent.status': { readonly status: AgentStatus; readonly confirmed: boolean };
}

export type AdapterReplyPayload =
  | { readonly req_id: string; readonly ok: true; readonly data: unknown }
  | { readonly req_id: string; readonly ok: false; readonly error: AppError };

/** Host-side timeouts (ms). A timed-out write is reported as `unknown`, never retried. */
export const ADAPTER_READ_TIMEOUT_MS = 15_000;
export const ADAPTER_WRITE_TIMEOUT_MS = 20_000;

/** Webview label prefix of per-account official-page webviews. */
export const ACCOUNT_WEBVIEW_PREFIX = 'acct-';
/** Webview label prefix of the remote login page (no capability at all). */
export const LOGIN_WEBVIEW_PREFIX = 'login-remote-';
