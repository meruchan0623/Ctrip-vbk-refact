/**
 * In-page caches the page session needs (M3-4/M3-5). All in memory, per
 * page load, never logged or persisted.
 *
 * - `ConversationStore`: latest raw `conversationList[]` row per gid plus
 *   the derived `ConversationRowView` (sessionId, worksheetId, serviceType,
 *   threadId, conversationType, customer uid, order id) and the last known
 *   message id per gid (for read receipts).
 * - `RoleBook`: uid → role. Self from the identity uid; customers from the
 *   conversation rows' `uid`; merchants from `13500/checkMemberStatus`
 *   (`roles[1] === 4 || roles[2] === 4`, same rule as `buildMemberRoles`).
 *   Everything else stays `unknown`.
 * - `UnreadBook`: `16037/getConversationInfoByGidList {head, gidList}` →
 *   `conversationInfoList[].unreadCount` (sample 54 sent 12 gids per call).
 */

import type { SenderRole } from '../../ipc/src/contracts.ts';
import type { AdapterDeps } from './deps.ts';
import type { ConversationListItem, UnreadLookup } from './conversationList.ts';
import { Endpoints } from './endpoints.ts';
import { businessHead } from './heads.ts';
import { isBizSuccess, recordOrNull, type SoaClient } from './soa.ts';
import type { HttpMessageObject, MemberRoles } from './facts.ts';
import { jidLocal } from './facts.ts';
import { rowView, type ConversationRowView } from './display.ts';

function norm(uid: string): string {
  return uid.trim().toLowerCase();
}

function idStr(x: unknown): string | null {
  if (typeof x === 'string' && x !== '') return x;
  if (typeof x === 'number' && Number.isFinite(x)) return String(x);
  return null;
}

// ------------------------------------------------------------- conversations

export interface LatestMessage {
  readonly msgId: string;
  readonly createTime: number;
}

export class ConversationStore {
  readonly #rows = new Map<string, ConversationListItem>();
  readonly #views = new Map<string, ConversationRowView>();
  readonly #latest = new Map<string, LatestMessage>();
  readonly #watchers: ((gids: readonly string[]) => void)[] = [];

  /** Stores rows; returns the gids that were stored. */
  update(rows: readonly unknown[]): string[] {
    const gids: string[] = [];
    for (const r of rows) {
      const view = rowView(r as ConversationListItem);
      if (!view) continue;
      this.#rows.set(view.gid, r as ConversationListItem);
      this.#views.set(view.gid, view);
      gids.push(view.gid);
      const lm = view.lastMessage;
      if (lm) this.noteMessage(view.gid, lm.msgId, lm.createTime);
    }
    if (gids.length > 0) for (const w of [...this.#watchers]) w(gids);
    return gids;
  }

  has(gid: string): boolean {
    return this.#rows.has(gid);
  }

  row(gid: string): ConversationListItem | null {
    return this.#rows.get(gid) ?? null;
  }

  view(gid: string): ConversationRowView | null {
    return this.#views.get(gid) ?? null;
  }

  gids(): string[] {
    return [...this.#rows.keys()];
  }

  findByOrderId(orderId: string): ConversationRowView | null {
    for (const v of this.#views.values()) if (v.orderId === orderId) return v;
    return null;
  }

  /** Remembers the newest message id seen for a gid (any source). */
  noteMessage(gid: string, msgId: unknown, createTime: unknown): void {
    const id = idStr(msgId);
    const t = typeof createTime === 'number' ? createTime : typeof createTime === 'string' && /^\d+$/.test(createTime) ? Number(createTime) : 0;
    if (id === null) return;
    const cur = this.#latest.get(gid);
    if (!cur || t >= cur.createTime) this.#latest.set(gid, { msgId: id, createTime: t });
  }

  latestMessage(gid: string): LatestMessage | null {
    return this.#latest.get(gid) ?? null;
  }

  /** Called with the gids of every `update`; returns an unsubscribe. */
  watch(cb: (gids: readonly string[]) => void): () => void {
    this.#watchers.push(cb);
    return () => {
      const i = this.#watchers.indexOf(cb);
      if (i >= 0) this.#watchers.splice(i, 1);
    };
  }
}

/** Room jid of a gid from an HTTP message object (`toJid` / `partner` whose local part is the gid). */
export function roomJidFromMessage(gid: string, msg: HttpMessageObject | null): string | null {
  if (!msg) return null;
  for (const c of [msg.partner, msg.toJid, msg.fromJid]) {
    if (typeof c === 'string' && c.includes('@') && jidLocal(c) === gid) {
      const slash = c.indexOf('/');
      return slash >= 0 ? c.slice(0, slash) : c;
    }
  }
  return null;
}

// ------------------------------------------------------------- roles

export class RoleBook implements MemberRoles {
  readonly #self: string;
  readonly #customers = new Set<string>();
  readonly #merchants = new Set<string>();
  readonly #checked = new Map<string, number>();
  readonly #inflight = new Map<string, Promise<void>>();
  readonly #ttlMs: number;

  constructor(selfUid: string, ttlMs = 5 * 60_000) {
    this.#self = norm(selfUid);
    this.#ttlMs = ttlMs;
  }

  roleOf(uid: string): SenderRole {
    const n = norm(uid);
    if (n === '') return 'unknown';
    if (n === this.#self) return 'merchant_self';
    if (this.#merchants.has(n)) return 'merchant_other';
    if (this.#customers.has(n)) return 'customer';
    return 'unknown';
  }

  addCustomer(uid: string | null): void {
    if (uid && norm(uid) !== this.#self) this.#customers.add(norm(uid));
  }

  addMembers(members: unknown): void {
    if (!Array.isArray(members)) return;
    for (const m of members) {
      const r = recordOrNull(m);
      const uid = r?.['uid'];
      if (typeof uid !== 'string' || uid === '') continue;
      const roles = Array.isArray(r?.['roles']) ? (r['roles'] as unknown[]) : [];
      if ((roles[1] === 4 || roles[2] === 4) && norm(uid) !== this.#self) this.#merchants.add(norm(uid));
    }
  }

  /** `13500/checkMemberStatus {head, groupId}` once per gid per TTL; failures are silent (roles stay unknown). */
  ensure(deps: AdapterDeps, soa: SoaClient, gid: string): Promise<void> {
    const at = this.#checked.get(gid);
    if (at !== undefined && deps.now() - at < this.#ttlMs) return Promise.resolve();
    const running = this.#inflight.get(gid);
    if (running) return running;
    const p = (async () => {
      const outcome = await soa.post<{ members?: unknown }>(Endpoints.CHECK_MEMBER_STATUS, { head: businessHead(deps.context), groupId: gid });
      if (outcome.kind === 'success') {
        this.addMembers(outcome.body.members);
        this.#checked.set(gid, deps.now());
      }
    })().finally(() => {
      this.#inflight.delete(gid);
    });
    this.#inflight.set(gid, p);
    return p;
  }
}

// ------------------------------------------------------------- unread

export const UNREAD_BATCH = 20;

export class UnreadBook implements UnreadLookup {
  readonly #counts = new Map<string, number>();

  unreadOf(gid: string): number | null {
    return this.#counts.get(gid) ?? null;
  }

  set(gid: string, n: number): boolean {
    const prev = this.#counts.get(gid);
    this.#counts.set(gid, n);
    return prev !== n;
  }

  /**
   * Refreshes the given gids; returns the gids whose count changed. The
   * embedded `message` of each info row is reported through `onMessage`
   * (last message id / room jid).
   */
  async refresh(deps: AdapterDeps, soa: SoaClient, gids: readonly string[], onMessage?: (gid: string, msg: HttpMessageObject) => void): Promise<string[]> {
    const changed: string[] = [];
    const unique = [...new Set(gids)];
    for (let i = 0; i < unique.length; i += UNREAD_BATCH) {
      const batch = unique.slice(i, i + UNREAD_BATCH);
      const outcome = await soa.post<{ conversationInfoList?: unknown }>(Endpoints.CONVERSATION_INFO_BY_GID_LIST, { head: businessHead(deps.context), gidList: batch });
      if (outcome.kind !== 'success' || !isBizSuccess(outcome.body)) continue;
      const list = Array.isArray(outcome.body.conversationInfoList) ? outcome.body.conversationInfoList : [];
      for (const item of list) {
        const r = recordOrNull(item);
        const gid = r?.['gid'];
        const n = r?.['unreadCount'];
        if (typeof gid !== 'string' || !batch.includes(gid)) continue;
        if (typeof n === 'number' && Number.isInteger(n) && n >= 0 && this.set(gid, n)) changed.push(gid);
        const msg = recordOrNull(r?.['message']);
        if (msg && onMessage) onMessage(gid, msg as HttpMessageObject);
      }
    }
    return changed;
  }
}
