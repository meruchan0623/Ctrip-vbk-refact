/**
 * Normalizers from (a) SDK realtime message events and (b) HTTP message
 * objects into the frozen `MessageFact`, plus the per-stream cursor
 * allocator and the member-role snapshot.
 *
 * Evidence: message object shape from getMessageList / getRecentMessages /
 * batchTranslateByMsgIds (`msgId, messageBody, fromJid, toJid, threadId,
 * createTime, bizType, status, msgtype, isread`), XMPP frame attributes
 * (`localid, id, ts, msgtype, bizType, threadid, create_time, from, to`).
 *
 * Observed `msgtype` values and the kind they map to:
 *   0 text, 1 image, 2 card(推荐), 3 video, 5 file, 7 CTL card → business
 *   1009 recall notice (body `code:2, recallMessageId`) → recall
 *   9901 input_state → typing
 *   1007 system NBZ event (join/invite/leave titles) → control
 *   anything else → control (never counted as a merchant reply)
 * `notify_ack` and `send_result` frames are protocol acks, not messages;
 * they never become facts. A read receipt msgtype was not observed; the
 * `read_receipt` kind is reserved for an SDK-level read event, mapped via
 * `MsgTypeOverrides` if the host identifies one.
 */

import type { MessageFact, MessageSource, MsgKind, SenderRole, StreamCursor } from '../../ipc/src/contracts.ts';
import type { SdkMessageEvent } from './deps.ts';

// ------------------------------------------------------------- member roles

export interface MemberRoles {
  roleOf(uid: string): SenderRole;
}

export interface CheckMemberStatusMember {
  readonly uid?: unknown;
  readonly roles?: unknown;
  readonly status?: unknown;
}

export interface MemberRolesInput {
  /** The logged-in agent's uid (from getVenAgentByUid / page context). */
  readonly selfUid: string;
  /** `conversationList[].uid` — the customer of the conversation; optional. */
  readonly customerUid?: string | null;
  /** `checkMemberStatus.members[]`. */
  readonly members: readonly CheckMemberStatusMember[];
  /** Explicit overrides (e.g. known robot/ctrip agent uids from another source). */
  readonly overrides?: Readonly<Record<string, SenderRole>>;
}

function norm(uid: string): string {
  return uid.trim().toLowerCase();
}

/**
 * Builds a uid→role snapshot. Only the documented role rules are applied:
 * `roles[1] === 4` (primary merchant agent) and `roles[2] === 4` (merchant
 * agent) identify merchant members (docs/research/2026-10-30-im-peripheral-apis.md §2.2);
 * `self` vs `other` is decided by uid. The customer is identified only when
 * the caller passes `customerUid` from the conversation. Everything else is
 * `unknown` — robots, ctrip agents and system senders have no verified
 * role code yet.
 */
export function buildMemberRoles(input: MemberRolesInput): MemberRoles {
  const map = new Map<string, SenderRole>();
  const self = norm(input.selfUid);
  for (const m of input.members) {
    if (typeof m.uid !== 'string' || m.uid === '') continue;
    const roles = Array.isArray(m.roles) ? m.roles : [];
    const isMerchant = roles[1] === 4 || roles[2] === 4;
    if (isMerchant) map.set(norm(m.uid), norm(m.uid) === self ? 'merchant_self' : 'merchant_other');
  }
  if (input.customerUid) map.set(norm(input.customerUid), 'customer');
  map.set(self, 'merchant_self');
  for (const [uid, role] of Object.entries(input.overrides ?? {})) map.set(norm(uid), role);
  return {
    roleOf(uid: string): SenderRole {
      return map.get(norm(uid)) ?? 'unknown';
    },
  };
}

export const UNKNOWN_ROLES: MemberRoles = { roleOf: () => 'unknown' };

// ------------------------------------------------------------- msg types

export const MSG_TYPE_KIND: Readonly<Record<number, MsgKind>> = {
  0: 'business',
  1: 'business',
  2: 'business',
  3: 'business',
  5: 'business',
  7: 'business',
  1007: 'control',
  1009: 'recall',
  9901: 'typing',
};

export type MsgTypeOverrides = Readonly<Record<number, MsgKind>>;

export function mapMsgType(raw: unknown, overrides?: MsgTypeOverrides): MsgKind {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : null;
  if (n === null) return 'control';
  return overrides?.[n] ?? MSG_TYPE_KIND[n] ?? 'control';
}

// ------------------------------------------------------------- time

/**
 * Normalizes a create time to Unix ms. 13-digit values pass through,
 * 10-digit values (seconds) are scaled, anything else is `null`.
 * Strings of digits are accepted (`send_result.create_time` is a string).
 */
export function normalizeTimeMs(raw: unknown): number | null {
  let n: number;
  if (typeof raw === 'number') n = raw;
  else if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) n = Number(raw.trim());
  else return null;
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n >= 1e12 && n < 1e13) return Math.floor(n);
  if (n >= 1e9 && n < 1e10) return n * 1000;
  return null;
}

export function is13DigitMs(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 1e12 && n < 1e13;
}

// ------------------------------------------------------------- jids

/** `local@domain/resource` → local part; plain ids pass through. */
export function jidLocal(jid: string): string {
  const at = jid.indexOf('@');
  return at >= 0 ? jid.slice(0, at) : jid.split('/')[0] ?? jid;
}

/** `room@conf/sender` → sender; `uid@domain` → uid. */
export function jidSender(jid: string): string {
  const slash = jid.indexOf('/');
  if (slash >= 0 && slash < jid.length - 1) return jid.slice(slash + 1);
  return jidLocal(jid);
}

// ------------------------------------------------------------- http message

export interface HttpMessageObject {
  readonly msgId?: unknown;
  readonly messageBody?: unknown;
  readonly fromJid?: unknown;
  readonly toJid?: unknown;
  readonly threadId?: unknown;
  readonly createTime?: unknown;
  readonly bizType?: unknown;
  readonly status?: unknown;
  readonly msgtype?: unknown;
  readonly isread?: unknown;
  readonly partner?: unknown;
  readonly localId?: unknown;
}

export interface NormalizeHttpOptions {
  /** Known group id (history pager); when absent it is derived from `partner`/`toJid` local part. */
  readonly gid?: string;
  readonly roles: MemberRoles;
  readonly source: MessageSource;
  readonly msgTypeOverrides?: MsgTypeOverrides;
}

function s(x: unknown): string | null {
  return typeof x === 'string' && x !== '' ? x : null;
}

/** Returns `null` when the object lacks a usable create time or gid; callers skip such rows. */
export function normalizeHttpMessage(msg: HttpMessageObject, opts: NormalizeHttpOptions): MessageFact | null {
  const createTime = normalizeTimeMs(msg.createTime);
  if (createTime === null) return null;
  const partner = s(msg.partner);
  const to = s(msg.toJid);
  const gid = opts.gid ?? (partner ? jidLocal(partner) : to ? jidLocal(to) : null);
  if (!gid) return null;
  const from = s(msg.fromJid);
  const senderId = from ? jidSender(from) : '';
  return {
    gid,
    message_id: s(msg.msgId),
    local_id: s(msg.localId),
    create_time_ms: createTime,
    sender_role: senderId ? opts.roles.roleOf(senderId) : 'unknown',
    sender_id: senderId,
    kind: mapMsgType(msg.msgtype, opts.msgTypeOverrides),
    source: opts.source,
    disposition: null,
  };
}

// ------------------------------------------------------------- sdk message

export interface NormalizeSdkOptions {
  readonly roles: MemberRoles;
  readonly msgTypeOverrides?: MsgTypeOverrides;
}

/**
 * Frames with `type` `notify_ack`, `send_result` or `input_state` are not
 * business messages: `notify_ack`/`send_result` return `null`,
 * `input_state` becomes a `typing` fact (no message id).
 */
export function normalizeSdkMessage(evt: SdkMessageEvent, opts: NormalizeSdkOptions): MessageFact | null {
  const type = s(evt.type);
  if (type === 'notify_ack' || type === 'send_result') return null;
  const from = s(evt.from);
  const to = s(evt.to);
  // groupchat: `from` is `gid@conf/sender`; the room is the gid.
  const gid = from && from.includes('/') ? jidLocal(from) : to ? jidLocal(to) : from ? jidLocal(from) : null;
  if (!gid) return null;
  const senderId = from ? jidSender(from) : '';
  const createTime = normalizeTimeMs(evt.create_time) ?? normalizeTimeMs(evt.ts);
  if (type === 'input_state') {
    return {
      gid,
      message_id: null,
      local_id: null,
      create_time_ms: createTime ?? 0,
      sender_role: senderId ? opts.roles.roleOf(senderId) : 'unknown',
      sender_id: senderId,
      kind: 'typing',
      source: 'realtime',
      disposition: null,
    };
  }
  if (createTime === null) return null;
  return {
    gid,
    message_id: s(evt.id),
    local_id: s(evt.localid),
    create_time_ms: createTime,
    sender_role: senderId ? opts.roles.roleOf(senderId) : 'unknown',
    sender_id: senderId,
    kind: mapMsgType(evt.msgtype, opts.msgTypeOverrides),
    source: 'realtime',
    disposition: null,
  };
}

// ------------------------------------------------------------- cursors

/**
 * Per-stream `{epoch, seq}` allocator. `seq` is monotonic within an epoch;
 * `bumpEpoch()` (reconnect/reload) restarts every stream at seq 1 so the
 * host sees `epoch_changed` and re-handshakes.
 */
export class CursorAllocator {
  #epoch: number;
  #seqs = new Map<string, number>();

  constructor(initialEpoch = 1) {
    this.#epoch = initialEpoch;
  }

  get epoch(): number {
    return this.#epoch;
  }

  next(stream: string): StreamCursor {
    const seq = (this.#seqs.get(stream) ?? 0) + 1;
    this.#seqs.set(stream, seq);
    return { epoch: this.#epoch, seq };
  }

  bumpEpoch(): number {
    this.#epoch += 1;
    this.#seqs.clear();
    return this.#epoch;
  }
}
