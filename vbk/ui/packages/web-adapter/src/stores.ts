import { effectiveMessageSender } from './message-body.ts';
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

import type { IdentityProfile } from './identity.ts';
import type { SenderRole } from '../../ipc/src/contracts.ts';
import type { UiOrderSummary } from '../../ipc/src/client.ts';
import type { AdapterDeps } from './deps.ts';
import type { ConversationListItem, UnreadLookup } from './conversationList.ts';
import { Endpoints } from './endpoints.ts';
import { businessHead } from './heads.ts';
import { isBizSuccess, recordOrNull, type SoaClient } from './soa.ts';
import type { HttpMessageObject, MemberRoles } from './facts.ts';
import { jidLocal, jidSender, normalizeTimeMs } from './facts.ts';
import { selectReadTarget } from './markRead.ts';
import { httpMessageToUi, rowView, type ConversationRowView } from './display.ts';

function norm(uid: string): string {
  return uid.trim().toLowerCase();
}

function idStr(x: unknown): string | null {
  if (typeof x === 'string' && x !== '') return x;
  if (typeof x === 'number' && Number.isFinite(x)) return String(x);
  return null;
}

/**
 * Total order on message ids: decimal ids (the server's, increasing with time)
 * compare numerically and sort before any non-decimal id; the rest compare as
 * strings. Class first, then value, so mixed inputs never form a cycle.
 */
export function compareMessageId(a: string, b: string): number {
  const na = /^\d+$/.test(a), nb = /^\d+$/.test(b);
  if (na !== nb) return na ? -1 : 1;
  if (na) {
    const x = a.replace(/^0+(?=\d)/, ''), y = b.replace(/^0+(?=\d)/, '');
    return x.length !== y.length ? x.length - y.length : x < y ? -1 : x > y ? 1 : 0;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

function orderContext(view: ConversationRowView): string {
  return JSON.stringify([view.gid, view.orderId, view.sessionId, view.customerUid, view.conversationType, view.serviceType, view.threadId, view.conversationKey ?? null, view.worksheetId]);
}
function orderSnapshotFence(row: unknown): number | null {
  const value = recordOrNull(row);
  const times = [normalizeTimeMs(value?.['lastUpdateTime']), normalizeTimeMs(value?.['lastMessageTime'])].filter((time): time is number => time !== null);
  return times.length ? Math.max(...times) : null;
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
  /** Read-receipt cursor: only advanced by row last messages the customer (peer) sent. */
  readonly #readTargets = new Map<string, LatestMessage>();
  readonly #assistantRevisions = new Map<string, { signature: string; token: string }>();
  readonly #orders = new Map<string, { context: string; revision: number; time: number; order: UiOrderSummary }>();
  readonly #sourceOrders = new Map<string, { revision: number; time: number; order: UiOrderSummary }>();
  readonly #sourceReads = new Map<string, number>();
  readonly #sourceDenied = new Map<string, number>();
  // Independent of order evidence: a service may change before any card arrives.
  // undefined is the initial matching-order history scope; null is an observed
  // transition with no usable server snapshot boundary and cannot bind a card.
  readonly #orderScopes = new Map<string, { context: string; revision: number; fence: number | null | undefined }>();
  readonly #watchers: ((gids: readonly string[]) => void)[] = [];

  /** Stores rows; returns the gids that were stored. */
  update(rows: readonly unknown[]): string[] {
    const gids: string[] = [];
    for (const r of rows) {
      const view = rowView(r as ConversationListItem);
      if (!view) continue;
      const context = orderContext(view), previous = this.#orderScopes.get(view.gid);
      if (!previous) this.#orderScopes.set(view.gid, { context, revision: 1, fence: undefined });
      else if (previous.context !== context) this.#orderScopes.set(view.gid, { context, revision: previous.revision + 1, fence: orderSnapshotFence(r) });
      else if (previous.fence === null) {
        const fence = orderSnapshotFence(r);
        if (fence !== null) this.#orderScopes.set(view.gid, { ...previous, fence });
      }
      this.#rows.set(view.gid, r as ConversationListItem);
      this.#views.set(view.gid, view);
      gids.push(view.gid);
      // A reused gid is not a message identity. Drop even a higher-time old target.
      if (!previous || previous.context !== context) { this.#latest.delete(view.gid); this.#readTargets.delete(view.gid); }
      const lm = view.lastMessage;
      if (lm) {
        this.#rememberMessage(view.gid, lm.msgId, lm.createTime);
        this.#rememberPeerMessage(view.gid, view.customerUid, lm);
      }
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

  /** Opaque and stable across display-only changes; never exposes customer/session identifiers. */
  assistantContextRevision(gid: string, selfUid: string, partnerJid: string | null): string | null {
    const view = this.view(gid);
    if (!view?.sessionId || !view.customerUid || !view.conversationType || !view.serviceType || !selfUid || !partnerJid) { this.#assistantRevisions.delete(gid); return null; }
    const signature = JSON.stringify([orderContext(view), this.#orderScopes.get(gid)?.revision, this.#sourceDenied.get(gid) === this.messageContext(gid), this.orderId(gid), selfUid, partnerJid]);
    let current = this.#assistantRevisions.get(gid);
    if (!current || current.signature !== signature) {
      current = { signature, token: globalThis.crypto.randomUUID() };
      this.#assistantRevisions.set(gid, current);
    }
    return current.token;
  }

  gids(): string[] {
    return [...this.#rows.keys()];
  }

  findByOrderId(orderId: string): ConversationRowView | null {
    for (const v of this.#views.values()) if (v.orderId === orderId) return v;
    return null;
  }

  /** Monotonic service epoch; A -> B -> A cannot reuse the first A's evidence. */
  messageContext(gid: string): number | null {
    return this.#orderScopes.get(gid)?.revision ?? null;
  }

  // Only authoritative conversation rows may advance the row snapshot (`latestMessage`).
  // History, unread and SDK/compensation frames are gid-only even in the first observed
  // epoch; the read frontier accepts them only after room/customer/thread/fence checks
  // (`#notePeerRow`), and a live frame may run ahead of the snapshot.
  #rememberMessage(gid: string, msgId: unknown, createTime: unknown): void {
    const id = idStr(msgId);
    const t = typeof createTime === 'number' ? createTime : typeof createTime === 'string' && /^\d+$/.test(createTime) ? Number(createTime) : 0;
    if (id === null) return;
    const cur = this.#latest.get(gid);
    if (!cur || t >= cur.createTime) this.#latest.set(gid, { msgId: id, createTime: t });
  }

  latestMessage(gid: string): LatestMessage | null {
    return this.#latest.get(gid) ?? null;
  }

  // The receipt cursor targets the newest counterpart message (I-06): the
  // agent's own or another merchant's row last message never moves it.
  #rememberPeerMessage(gid: string, customerUid: string | null, lm: HttpMessageObject): void {
    const customer = customerUid ? norm(customerUid) : '';
    const sender = typeof lm.fromJid === 'string' ? norm(effectiveMessageSender(jidSender(lm.fromJid), lm.messageBody, lm.msgtype)) : '';
    if (customer === '' || sender !== customer) return;
    const presented = httpMessageToUi(lm, { roleOf: () => 'customer' }, gid);
    if (!presented || presented.kind === 'system') return;
    const id = idStr(lm.msgId), t = normalizeTimeMs(lm.createTime);
    if (id === null || t === null) return;
    const cur = this.#readTargets.get(gid);
    // Order-independent: newer time wins; at the same timestamp the larger server
    // message id wins, so duplicates / reordered frames cannot flip the frontier
    // and every source (row, history, live) converges on the same target.
    if (cur && (t < cur.createTime || t === cur.createTime && compareMessageId(id, cur.msgId) <= 0)) return;
    if (selectReadTarget([{ msgId: id, createTimeMs: t, fromSelf: false }]) === id) this.#readTargets.set(gid, { msgId: id, createTime: t });
  }

  /** Scope-checked history can recover a peer frontier hidden by a later self/system row.
   * Never advance beyond the authoritative conversation snapshot or accept another room. */
  noteReadHistory(gid: string, rows: readonly HttpMessageObject[]): void {
    const latest = this.latestMessage(gid);
    if (!latest || !Number.isFinite(latest.createTime) || latest.createTime <= 0) return;
    for (const row of rows) this.#notePeerRow(gid, row, latest.createTime);
  }

  /**
   * A realtime / compensation frame whose room the caller already matched
   * against the authoritative row and whose request/arrival the caller bound
   * to the current context. Unlike history it may run ahead of the row
   * snapshot: the customer's newest message is the read frontier even when the
   * agent replies before the next list poll observes it (otherwise the receipt
   * can never target it and the unread badge never clears). It is still fenced
   * by the observed service switch, and a context change drops it.
   */
  noteLiveMessage(gid: string, row: HttpMessageObject): void {
    this.#notePeerRow(gid, row, null);
  }

  #notePeerRow(gid: string, row: HttpMessageObject, maxTime: number | null): void {
    const view = this.view(gid);
    if (!view) return;
    const scope = this.#orderScopes.get(gid);
    if (!scope || scope.fence === null) return;
    const room = roomJidFromMessage(gid, view.lastMessage);
    if (!room) return;
    const time = normalizeTimeMs(row.createTime), type = Number(row.msgtype);
    if (time === null || (maxTime !== null && time > maxTime) || !Number.isFinite(type) || type >= 1000) return;
    if (scope.fence !== undefined && time <= scope.fence) return;
    if (view.threadId && typeof row.threadId === 'string' && row.threadId && row.threadId !== view.threadId) return;
    if (roomJidFromMessage(gid, row) !== room) return;
    this.#rememberPeerMessage(gid, view.customerUid, row);
  }

  /** Newest peer-sent message id known from authoritative rows of the current context, or `null`. */
  readTarget(gid: string): LatestMessage | null {
    return this.#readTargets.get(gid) ?? null;
  }

  noteOrder(gid: string, order: UiOrderSummary, time: number): void {
    const view = this.view(gid);
    if (!view || this.#sourceDenied.get(gid) === this.messageContext(gid) || this.orderId(gid) !== order.order_id || !Number.isFinite(time) || time < 0) return;
    const context = orderContext(view);
    const scope = this.#orderScopes.get(gid);
    if (!scope || scope.context !== context || scope.fence === null || (scope.fence !== undefined && time <= scope.fence)) return;
    const current = this.#orders.get(gid);
    // A different service/customer cannot inherit the old card, nor rebind an
    // older/equal-time delayed card to itself. Keep the room's evidence floor.
    if (current && (current.time > time || (current.revision !== scope.revision && current.time === time))) return;
    this.#orders.set(gid, { context, revision: scope.revision, time, order });
  }

  order(gid: string): UiOrderSummary | null {
    const stored = this.#orders.get(gid), view = this.view(gid), scope = this.#orderScopes.get(gid);
    if (scope && this.#sourceDenied.get(gid) === scope.revision) return null;
    const source = this.#sourceOrders.get(gid);
    const base = source && scope && source.revision === scope.revision ? source.order : null;
    const message = stored && view && scope && stored.order.order_id === this.orderId(gid) && scope.fence !== null && stored.revision === scope.revision && stored.context === orderContext(view) && (scope.fence === undefined || stored.time > scope.fence) ? stored.order : null;
    // Sparse history/realtime cards must not erase fields from the official
    // current-source read. Both records belong to the same service revision.
    const nonempty = (order: UiOrderSummary) => Object.fromEntries(Object.entries(order).filter(([, value]) => typeof value === 'string' && value.trim()));
    return base && message ? stored!.time > source!.time ? { ...base, ...nonempty(message) } : { ...message, ...nonempty(base) } : message ?? base;
  }

  /** A fresh gid-scoped official read may return a source older than the
   * current service snapshot. Bind it to the captured revision, not its age. */
  noteSourceOrder(gid: string, order: UiOrderSummary, revision: number | null, time: number, read?: number): void {
    const scope = this.#orderScopes.get(gid), view = this.view(gid);
    if (!scope || !view || (read !== undefined && read !== this.#sourceReads.get(gid)) || revision !== scope.revision || (view.orderId !== null && view.orderId !== order.order_id)) return;
    if (!Number.isFinite(time) || time < 0 || (this.#sourceOrders.get(gid)?.time ?? -1) > time) return;
    this.#sourceDenied.delete(gid);
    this.#sourceOrders.set(gid, { revision: scope.revision, time, order });
  }

  denySourceOrder(gid: string, revision: number | null, read: number): boolean {
    const scope = this.#orderScopes.get(gid);
    if (!scope || scope.revision !== revision || this.#sourceReads.get(gid) !== read) return false;
    this.#sourceDenied.set(gid, scope.revision);
    this.#sourceOrders.delete(gid);
    this.#orders.delete(gid);
    return true;
  }

  /** An authorized current-gid source can establish the display/query order
   * when the conversation list has no order identity. Known row IDs win. */
  orderId(gid: string): string | null {
    const view = this.view(gid), source = this.#sourceOrders.get(gid), scope = this.#orderScopes.get(gid);
    return view?.orderId ?? (source && scope && source.revision === scope.revision ? (source.order.order_id || null) : null);
  }

  beginSourceRead(gid: string): number {
    const read = (this.#sourceReads.get(gid) ?? 0) + 1;
    this.#sourceReads.set(gid, read);
    return read;
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
  #selfProfile: IdentityProfile | null = null;
  readonly #customers = new Set<string>();
  readonly #merchants = new Set<string>();
  readonly #profiles = new Map<string, { name: string | null; avatar: string | null }>();
  readonly #checked = new Map<string, number>();
  readonly #inflight = new Map<string, Promise<void>>();
  readonly #ttlMs: number;
  readonly #versions = new Map<string, number>();
  #active = 0;
  readonly #waiting: { gid: string; version: number; priority: 'foreground' | 'background'; resolve: () => void }[] = [];

  /** Invalidates queued/in-flight member evidence when a gid changes service. */
  invalidate(gid: string): void {
    this.#versions.set(gid, (this.#versions.get(gid) ?? 0) + 1);
    this.#checked.delete(gid);
    this.#inflight.delete(gid);
  }

  async #acquire(gid: string, version: number, priority: 'foreground' | 'background'): Promise<void> {
    if (this.#active < 4) { this.#active++; return; }
    await new Promise<void>(resolve => this.#waiting.push({ gid, version, priority, resolve }));
  }

  #release(): void {
    const foreground = this.#waiting.findIndex(job => job.priority === 'foreground');
    const next = this.#waiting.splice(foreground < 0 ? 0 : foreground, 1)[0];
    if (next) next.resolve(); else this.#active--;
  }

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

  get selfUid(): string { return this.#self; }

  profileOf(uid: string): { name: string | null; avatar: string | null } {
    const profile = this.#profiles.get(norm(uid)) ?? { name: null, avatar: null };
    return norm(uid) === this.#self && this.#selfProfile
      ? { name: this.#selfProfile.name ?? profile.name, avatar: this.#selfProfile.avatar ?? profile.avatar }
      : profile;
  }

  setSelfProfile(profile: IdentityProfile): void {
    if (norm(profile.uid) !== this.#self || this.#self === '') return;
    this.#selfProfile = { ...profile };
  }

  addCustomer(uid: string | null): void {
    if (uid && norm(uid) !== this.#self) this.#customers.add(norm(uid));
  }

  addMembers(members: unknown): void {
    if (!Array.isArray(members)) return;
    for (const m of members) {
      const r = recordOrNull(m);
      const uid = r?.['uid'] ?? r?.['username'];
      if (typeof uid !== 'string' || uid === '') continue;
      const nick = r?.['nick'] ?? r?.['nickName'];
      const avatar = r?.['avatar'];
      const previous = this.profileOf(uid);
      this.#profiles.set(norm(uid), {
        name: typeof nick === 'string' && nick.trim() !== '' ? nick : previous.name,
        avatar: typeof avatar === 'string' && avatar !== '' ? avatar : previous.avatar,
      });
      const roles = Array.isArray(r?.['roles']) ? (r['roles'] as unknown[]) : [];
      if ((roles[1] === 4 || roles[2] === 4) && norm(uid) !== this.#self) this.#merchants.add(norm(uid));
    }
  }

  /** `13500/checkMemberStatus {head, groupId}` once per gid per TTL; failures are silent (roles stay unknown). */
  ensure(deps: AdapterDeps, soa: SoaClient, gid: string, priority: 'foreground' | 'background' = 'foreground'): Promise<void> {
    const at = this.#checked.get(gid);
    if (at !== undefined && deps.now() - at < this.#ttlMs) return Promise.resolve();
    const running = this.#inflight.get(gid);
    if (running) {
      // A foreground reader joins the same promise while promoting a queued
      // background profile read ahead of unrelated background conversations.
      if (priority === 'foreground') {
        const queued = this.#waiting.find(job => job.gid === gid && job.version === (this.#versions.get(gid) ?? 0));
        if (queued) queued.priority = 'foreground';
      }
      return running;
    }
    const version = this.#versions.get(gid) ?? 0;
    const current = () => (this.#versions.get(gid) ?? 0) === version;
    const p = (async () => {
      await this.#acquire(gid, version, priority);
      try {
        if (!current()) return;
        const outcome = await soa.post<{ members?: unknown }>(Endpoints.CHECK_MEMBER_STATUS, { head: businessHead(deps.context), groupId: gid });
        if (!current() || outcome.kind !== 'success') return;
        this.addMembers(outcome.body.members);
        // gid mode preserves former participants; uidList cannot replace it.
        const remarks = await soa.post<{ remarkList?: unknown }>(Endpoints.REMARK_LIST, { head: businessHead(deps.context), gid });
        if (!current()) return;
        if (remarks.kind === 'success' && isBizSuccess(remarks.body)) this.addMembers(remarks.body.remarkList);
        this.#checked.set(gid, deps.now());
      } finally { this.#release(); }
    })().finally(() => {
      if (this.#inflight.get(gid) === p) this.#inflight.delete(gid);
    });
    this.#inflight.set(gid, p);
    return p;
  }
}

// ------------------------------------------------------------- unread

export const UNREAD_BATCH = 20;

/** How long a confirmed receipt may suppress a lagging server count that shows no newer customer message. */
export const READ_GRACE_MS = 30_000;

export class UnreadBook implements UnreadLookup {
  readonly #counts = new Map<string, number>();
  /**
   * Consumed watermark per gid: the acknowledged customer message, who the
   * customer is, and when the receipt was confirmed. It only bridges the gap
   * until the server reflects the receipt; it never outlives `READ_GRACE_MS`
   * and never survives evidence of a newer customer message.
   */
  readonly #acked = new Map<string, { target: LatestMessage; peer: string | null; at: number }>();

  unreadOf(gid: string): number | null {
    return this.#counts.get(gid) ?? null;
  }

  invalidate(gid: string): void { this.#counts.delete(gid); this.#acked.delete(gid); }

  /** Confirmed visible consumption of `target` (the newest customer message the agent saw) at clock time `at`. */
  acknowledge(gid: string, target: LatestMessage, peer: string | null, at: number): boolean {
    this.#acked.set(gid, { target, peer: peer ? norm(peer) : null, at });
    return this.set(gid, 0);
  }

  /** The read frontier moved: a watermark for another target is evidence-stale and dropped. */
  noteTarget(gid: string, target: string | null): void {
    const entry = this.#acked.get(gid);
    if (entry && entry.target.msgId !== target) this.#acked.delete(gid);
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
  async refresh(deps: AdapterDeps, soa: SoaClient, gids: readonly string[], onMessage?: (gid: string, msg: HttpMessageObject) => void, current: (gid: string) => boolean = () => true): Promise<string[]> {
    const changed: string[] = [];
    const unique = [...new Set(gids)];
    for (let i = 0; i < unique.length; i += UNREAD_BATCH) {
      const batch = unique.slice(i, i + UNREAD_BATCH).filter(current);
      if (batch.length === 0) continue;
      const outcome = await soa.post<{ conversationInfoList?: unknown }>(Endpoints.CONVERSATION_INFO_BY_GID_LIST, { head: businessHead(deps.context), gidList: batch });
      if (outcome.kind !== 'success' || !isBizSuccess(outcome.body)) continue;
      const list = Array.isArray(outcome.body.conversationInfoList) ? outcome.body.conversationInfoList : [];
      for (const item of list) {
        const r = recordOrNull(item);
        const gid = r?.['gid'];
        const n = r?.['unreadCount'];
        if (typeof gid !== 'string' || !batch.includes(gid) || !current(gid)) continue;
        const msg = recordOrNull(r?.['message']);
        const suppressed = typeof n === 'number' && n > 0 && this.#suppressed(gid, msg as HttpMessageObject | null, deps.now());
        if (typeof n === 'number' && Number.isInteger(n) && n >= 0) {
          if (n === 0 || !suppressed) this.#acked.delete(gid);
          if (this.set(gid, suppressed ? 0 : n)) changed.push(gid);
        }
        if (msg && onMessage) onMessage(gid, msg as HttpMessageObject);
      }
    }
    return changed;
  }

  /**
   * A lagging count after a confirmed receipt stays suppressed while the
   * embedded last message is not a customer message newer than the acked
   * target (own / colleague replies, the target itself, an older message) and
   * the grace window has not elapsed. A newer customer message, an unknown
   * sender's newer message, or the end of the window hands the count back to
   * the server: the badge may show a message the client never observed, but
   * it can never hide one.
   */
  #suppressed(gid: string, msg: HttpMessageObject | null, now: number): boolean {
    const entry = this.#acked.get(gid);
    if (!entry) return false;
    if (now - entry.at > READ_GRACE_MS) return false;
    if (!msg) return true;
    const time = normalizeTimeMs(msg.createTime), id = idStr(msg.msgId), type = Number(msg.msgtype);
    if (time === null) return false;
    const newer = time > entry.target.createTime || time === entry.target.createTime && id !== entry.target.msgId;
    if (!newer) return true;
    const sender = typeof msg.fromJid === 'string' ? norm(effectiveMessageSender(jidSender(msg.fromJid), msg.messageBody, msg.msgtype)) : '';
    const system = Number.isFinite(type) && type >= 1000;
    // Unknown sender or unknown peer: treat the newer message as the customer's.
    const fromPeer = !system && (sender === '' || entry.peer === null || sender === entry.peer);
    return !fromPeer;
  }
}
