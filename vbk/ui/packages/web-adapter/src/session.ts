import { createProductNameCache, type ProductNameCache } from './product-name-cache.ts';
import { fetchOrderSource } from './order-source.ts';
import { createReadStatusSync } from './read-status.ts';
import { messageListBody } from './history.ts';
import { Endpoints } from './endpoints.ts';
/**
 * Page session: composes `createAdapter` (facts) with the display channel,
 * caches, role/unread enrichment (M3-4) and the RPC dispatcher (M3-5).
 *
 * - facts go through `adapter.bridge` (body-free envelopes);
 * - titles / previews / bodies go through `pushDisplay` only;
 * - every new adapter run starts with a full conversation snapshot (U02,
 *   `conversationList.ts` resets its cursor on `start()`), so the host can
 *   rebuild after `epoch_changed`;
 * - unread counts come from `getConversationInfoByGidList`; when a count
 *   changes the conversation fact is re-emitted (`is_full_snapshot:false`).
 */

import { FactStreams } from '../../ipc/src/contracts.ts';
import type { AccountContext, AdapterFact, TransportState } from '../../ipc/src/contracts.ts';
import type { UiMessage } from '../../ipc/src/client.ts';
import { AdapterCommands } from '../../ipc/src/adapterProtocol.ts';
import type { AdapterDisplayPayload, DisplayConversation } from '../../ipc/src/adapterProtocol.ts';
import type { AdapterDeps, SdkMessageEvent, SdkSocketStatus } from './deps.ts';
import { BridgeQueueError } from './bridge.ts';
import { createAdapter, type Adapter } from './index.ts';
import { SoaClient, isBizSuccess, recordOrNull, type SoaOutcome } from './soa.ts';
import { conversationListBody, toConversationFact, type ConversationListItem, type ConversationListResponse, type ConversationListVariant, type VisibilityGate } from './conversationList.ts';
import type { OfficialConversationFeed } from './pageContext.ts';
import type { RecentMessagesResponse } from './compensation.ts';
import { effectiveMessageSender } from './message-body.ts';
import { resolveSdkAddress, jidLocal, jidSender, normalizeTimeMs, type HttpMessageObject } from './facts.ts';
import { agentStatusOf, rowView, byCreateTime, httpMessageToUi, orderSummaryFromMessage, previewOf, previewOfUi, sdkMessageToUi, toDisplayConversation } from './display.ts';
import { ConversationStore, RoleBook, UnreadBook, roomJidFromMessage } from './stores.ts';
import { createRpc, type AgentStatusBox, type Rpc } from './rpc.ts';
import type { IdentityProfile } from './identity.ts';
import type { PageSdk } from './sdkGlue.ts';
import { createReceiveCounters, receiveCount } from './diagnostics.ts';
import { createPresence, type StatusRead } from './presence.ts';
import { LATEST_CONVERSATION } from './peripheral.ts';
import { businessHead } from './heads.ts';

export interface PageSessionOptions {
  readonly bridgeCapacity?: number;
  readonly account: AccountContext;
  readonly selfUid: string;
  readonly productNameCache?: ProductNameCache;
  readonly selfProfile?: IdentityProfile;
  readonly beginMsgTime: number;
  readonly initialEpoch: number;
  readonly sdk: PageSdk;
  /** Display push (`adapter_push_display`); errors are swallowed by the session. */
  readonly pushDisplay: (payload: AdapterDisplayPayload) => Promise<unknown>;
  readonly variants?: readonly ConversationListVariant[];
  /** Compensation normal-loop stop delay (ms); `null`/omitted = never stop. */
  readonly normalLoopStopAfterMs?: number | null;
  /** This session stopped on a bridge fault; the owner boots a fresh one. */
  readonly onFaultUnhandled?: () => void;
  /** Official page's own conversation-list loop (fetch hook); pollers consume it instead of requesting (I-06). */
  readonly officialConversationFeed?: OfficialConversationFeed;
  readonly conversationVisibility?: VisibilityGate;
  readonly onConversationBootstrap?: () => void;
  readonly sendAckTimeoutMs?: number;
  readonly orderGidWaitMs?: number;
  readonly unreadDebounceMs?: number;
  readonly log?: (msg: string) => void;
}

export interface PageSession {
  readonly adapter: Adapter;
  readonly rpc: Rpc;
  readonly store: ConversationStore;
  readonly roles: RoleBook;
  readonly unread: UnreadBook;
  start(): void;
  stop(): void;
}

interface CompensationTicket { readonly generation: number; readonly contexts: ReadonlyMap<string, number | null> }

const TRANSPORT_STATES: ReadonlySet<string> = new Set<TransportState>(['connecting', 'connected', 'disconnected', 'reconnecting']);

/** Display values are bounded DTOs. Ignore snapshot metadata when comparing rows. */
function sameDisplayValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  const keys = Object.keys(left).filter(key => key !== 'is_full_snapshot');
  return keys.length === Object.keys(right).filter(key => key !== 'is_full_snapshot').length
    && keys.every(key => Object.hasOwn(right, key) && sameDisplayValue(left[key], right[key]));
}

export function createPageSession(deps: AdapterDeps, opts: PageSessionOptions): PageSession {
  const soa = new SoaClient(deps);
  const store = new ConversationStore();
  const roles = new RoleBook(opts.selfUid);
  if (opts.selfProfile) roles.setSelfProfile(opts.selfProfile);
  const unread = new UnreadBook();
  const displays = new Map<string, DisplayConversation>();
  const displayContexts = new Map<string, string>();
  const sentDisplays = new Map<string, DisplayConversation>();
  let recoverDisplaySnapshot = false;
  let queueFaulted = false;
  // Only display-sized evidence is retained while the first row is in flight.
  // Never replay a gid-only preview into a newly claimed customer/service.
  const pendingPreviews = new Map<string, { preview: string; time: number; sender: string; room: string; thread: string | null; order: string | null; expires: number }>();
  const contextOf = (gid: string): string | null => {
    const v = store.view(gid);
    return v?.sessionId && v.customerUid && v.conversationType && v.serviceType
      ? JSON.stringify([v.gid, v.sessionId, v.customerUid, v.conversationType, v.serviceType, v.threadId, v.conversationKey, v.worksheetId, v.orderId, roles.selfUid]) : null;
  };
  const trimPending = (): void => {
    const now = deps.now();
    for (const [gid, entry] of pendingPreviews) if (entry.expires <= now) pendingPreviews.delete(gid);
  };
  const rememberPending = (message: UiMessage, room: string | null, thread: unknown): void => {
    if (store.has(message.gid)) return;
    trimPending();
    // A self/system frame before the first row cannot prove the customer.
    if (!room || room.length > 512 || !message.sender_id || message.sender_id.length > 512 || message.sender_id.toLowerCase() === roles.selfUid.toLowerCase()) return;
    if (thread !== undefined && thread !== null && (typeof thread !== 'string' || thread.length > 512)) return;
    const old = pendingPreviews.get(message.gid);
    if (old && old.time > message.create_time_ms) return;
    if (!old && pendingPreviews.size >= 256) pendingPreviews.delete(pendingPreviews.keys().next().value!);
    pendingPreviews.set(message.gid, { preview: previewOfUi(message).slice(0, 200), time: message.create_time_ms, sender: message.sender_id.toLowerCase(), room: room.toLowerCase(), thread: typeof thread === 'string' ? thread : null, order: message.order_id, expires: deps.now() + 60_000 });
  };
  const initialPreview = (item: DisplayConversation, raw: ConversationListItem): DisplayConversation => {
    trimPending();
    const entry = pendingPreviews.get(item.gid);
    pendingPreviews.delete(item.gid); // consume only on the first observable row
    // A duplicate gid batch must never mix one row's fence with another row's identity.
    if (store.row(item.gid) !== raw) return item;
    const view = store.view(item.gid);
    const fence = normalizeTimeMs(raw.lastUpdateTime);
    const room = roomJidFromMessage(item.gid, view?.lastMessage ?? null);
    if (!entry || !view || !contextOf(item.gid) || fence === null || entry.time <= Math.max(fence, item.last_message_time_ms ?? 0) || entry.sender !== view.customerUid?.toLowerCase() || entry.room !== room?.toLowerCase() || (entry.thread ?? '') !== view.threadId || (entry.order !== null && entry.order !== view.orderId)) return item;
    return { ...item, preview: entry.preview, last_message_time_ms: entry.time };
  };
  const log = opts.log ?? (() => undefined);
  const diagnostics = createReceiveCounters();

  // One conversation delivery in flight and one coalesced successor. Other
  // kinds bypass this channel, including messages and status lease renewals.
  type Conversations = Extract<AdapterDisplayPayload, { kind: 'conversations' }>;
  type Delivery = { payload: Conversations; generation: number; force: boolean; done: (ok: boolean) => void; promise: Promise<boolean> };
  let conversationFlight = false;
  let conversationPending: Delivery | null = null;
  const deliverConversations = async (delivery: Delivery): Promise<void> => {
    conversationFlight = true;
    let ok = false;
    try {
      if (!running || delivery.generation !== runGeneration) return;
      const source = delivery.payload;
      const full = source.full || recoverDisplaySnapshot;
      const items = full ? [...displays.values()] : source.items;
      const sameSnapshot = full && items.length === sentDisplays.size && items.every(item => sameDisplayValue(sentDisplays.get(item.gid), item));
      const changed = full ? items : items.filter(item => !sameDisplayValue(sentDisplays.get(item.gid), item));
      if (!delivery.force && !recoverDisplaySnapshot && (sameSnapshot || (!full && changed.length === 0 && source.removed_gids.length === 0))) { ok = true; return; }
      const payload: Conversations = { ...source, full, items: changed };
      await opts.pushDisplay(payload);
      if (running && delivery.generation === runGeneration) {
        if (full) sentDisplays.clear();
        for (const gid of source.removed_gids) sentDisplays.delete(gid);
        for (const item of changed) sentDisplays.set(item.gid, item);
        recoverDisplaySnapshot = false;
        ok = true;
      }
    } catch {
      if (running && delivery.generation === runGeneration) {
        sentDisplays.clear(); recoverDisplaySnapshot = true;
      }
      log('display push failed (conversations)');
    } finally {
      delivery.done(ok);
      conversationFlight = false;
      const next = conversationPending;
      conversationPending = null;
      if (next) void deliverConversations(next);
    }
  };
  const enqueueConversations = (payload: Conversations): Promise<boolean> => {
    if (conversationFlight && conversationPending) {
      conversationPending.payload = { kind: 'conversations', full: true, items: [...displays.values()], removed_gids: [] };
      conversationPending.force ||= payload.full;
      return conversationPending.promise;
    }
    let done!: (ok: boolean) => void;
    const promise = new Promise<boolean>(resolve => { done = resolve; });
    const delivery: Delivery = { payload: conversationFlight ? { kind: 'conversations', full: true, items: [...displays.values()], removed_gids: [] } : payload, generation: runGeneration, force: payload.full, done, promise };
    if (conversationFlight) conversationPending = delivery;
    else void deliverConversations(delivery);
    return promise;
  };

  let readStatuses: ReturnType<typeof createReadStatusSync> | undefined;
  const pushDisplay = (payload: AdapterDisplayPayload): Promise<boolean> => {
    if (payload.kind === 'conversations' && !running) return Promise.resolve(false);
    if (payload.kind === 'conversations') {
      if (payload.full) {
        const keep = new Set(payload.items.map(item => item.gid));
        for (const gid of displays.keys()) if (!keep.has(gid)) { displays.delete(gid); displayContexts.delete(gid); }
      }
      for (const gid of payload.removed_gids) { displays.delete(gid); displayContexts.delete(gid); }
    }
    readStatuses?.observe(payload);
    const messages = payload.kind === 'messages';
    if (messages) {
      diagnostics.session.display_batches = receiveCount(diagnostics.session.display_batches);
      diagnostics.session.display_items = receiveCount(diagnostics.session.display_items, payload.items.length);
    }
    // Every conversation projection (including history enrichment) shares the
    // authoritative unread book. Reading history cannot acknowledge messages.
    let current: AdapterDisplayPayload = payload.kind === 'conversations'
      ? { ...payload, items: payload.items.flatMap((item) => {
          // Match host admission: preserve existing rows and ignore new gids at capacity.
          if (!displays.has(item.gid) && displays.size >= 2000) return [];
          const signature = contextOf(item.gid);
          const previous = signature && displayContexts.get(item.gid) === signature ? displays.get(item.gid) : undefined;
          const uid = store.view(item.gid)?.customerUid;
          const next = {
            ...item,
            // The row's customer uid is the only association for this surface.
            // RoleBook preserves known profile fields on incomplete refreshes.
            customer_avatar: uid ? roles.profileOf(uid).avatar : null,
            read_target_message_id: store.readTarget(item.gid)?.msgId ?? null,
            assistant_context_revision: store.assistantContextRevision(item.gid, roles.selfUid, opts.sdk.partnerJidOf(item.gid) ?? roomJidFromMessage(item.gid, store.view(item.gid)?.lastMessage ?? null)) ?? '',
            ...(previous && ((previous.last_message_time_ms ?? 0) > (item.last_message_time_ms ?? 0) || (!item.preview && !!previous.preview && previous.last_message_time_ms === item.last_message_time_ms))
              ? { preview: previous.preview, last_message_time_ms: previous.last_message_time_ms }
              : {}),
            unread_count: unread.unreadOf(item.gid) ?? item.unread_count,
          };
          displays.set(item.gid, next);
          if (signature) displayContexts.set(item.gid, signature); else displayContexts.delete(item.gid);
          return [next];
        }) }
      : payload;
    if (current.kind === 'conversations') return enqueueConversations(current);
    try {
      return opts.pushDisplay(current).then(() => {
        if (messages) diagnostics.session.display_resolved = receiveCount(diagnostics.session.display_resolved);
        return true;
      }, () => {
        if (messages) diagnostics.session.display_rejected = receiveCount(diagnostics.session.display_rejected);
        log(`display push failed (${payload.kind})`);
        return false;
      });
    } catch {
      if (messages) diagnostics.session.display_rejected = receiveCount(diagnostics.session.display_rejected);
      log(`display push failed (${payload.kind})`);
      return Promise.resolve(false);
    }
  };

  // Host-issued boot epoch + lifetime sequence also fence unordered IPC delivery.
  // Do not reset the sequence on stop/start of this session instance.
  let statusSequence = 0;
  const presence = createPresence(deps, (status, confirmed) => pushDisplay({ kind: 'agent_status', status, confirmed, status_epoch: opts.initialEpoch, status_seq: ++statusSequence }));
  const agentBox: AgentStatusBox = {
    ...presence,
    // All production observations use request-scoped tickets.
    set: (status, confirmed) => { if (confirmed) presence.captureRead().commit(status); else presence.invalidate(); },
  };

  // ---- unread refresh (debounced, batched)
  const pendingUnread = new Set<string>();
  let unreadTimer: unknown = null;
  let unreadInFlight: object | null = null;
  let running = false;
  let runGeneration = 0;
  const unreadContexts = new Map<string, number | null>();
  // A moved read frontier is evidence of a newer customer message: the consumed watermark is dropped.
  const syncFrontier = (gid: string): void => unread.noteTarget(gid, store.readTarget(gid)?.msgId ?? null);
  store.watch(gids => {
    for (const gid of gids) {
      const current = store.messageContext(gid);
      const room = roomJidFromMessage(gid, store.view(gid)?.lastMessage ?? null);
      if (room) opts.sdk.rememberPartnerJid(gid, room);
      if (unreadContexts.has(gid) && unreadContexts.get(gid) !== current) {
        unread.invalidate(gid);
        roles.invalidate(gid);
      }
      unreadContexts.set(gid, current);
      syncFrontier(gid);
    }
  });
  const runUnreadBatch = async (): Promise<void> => {
    const generation = runGeneration;
    unreadTimer = null;
    const gids = [...pendingUnread];
    pendingUnread.clear();
    if (gids.length === 0 || !running) return;
    const contexts = new Map(gids.map(gid => [gid, store.messageContext(gid)]));
    const current = (gid: string): boolean => running && generation === runGeneration && contexts.get(gid) === store.messageContext(gid);
    const messageChanged = new Set<string>();
    const changed = await unread.refresh(deps, soa, gids, (gid, msg) => {
      if (!running || generation !== runGeneration) return;
      if (!current(gid)) return;
      const row = store.row(gid), old = store.view(gid)?.lastMessage;
      const time = normalizeTimeMs(msg.createTime);
      // A lagging detail must not move the row to another room: the row's room is the
      // address every read receipt for this gid is sent to.
      const canonical = roomJidFromMessage(gid, old ?? null), incoming = roomJidFromMessage(gid, msg);
      if (row && time !== null && time >= (normalizeTimeMs(old?.createTime) ?? 0) && (!canonical || !!incoming && incoming.toLowerCase() === canonical.toLowerCase())) {
        store.update([{ ...row, lastMessageJsonString: JSON.stringify(msg), lastMessageTime: time }]);
        messageChanged.add(gid);
      }
      const jid = roomJidFromMessage(gid, msg);
      if (jid && roomJidFromMessage(gid, store.view(gid)?.lastMessage ?? null) === jid) opts.sdk.rememberPartnerJid(gid, jid);
    }, current);
    if (!running || generation !== runGeneration) return;
    const items: DisplayConversation[] = [];
    for (const gid of new Set([...changed, ...messageChanged])) {
      const row = store.row(gid);
      if (!row) continue;
      const fact = toConversationFact(row, false, unread);
      if (fact) {
        try { adapter.bridge.push({ kind: 'conversation', fact }); }
        catch (error) { if (queueFaulted && error instanceof BridgeQueueError) return; throw error; }
      }
      const base = toDisplayConversation(row, false, unread, roles.selfUid);
      const uid = store.view(gid)?.customerUid;
      const d = base ? { ...base, title: uid ? roles.profileOf(uid).name ?? base.title : base.title, order: store.order(gid) ?? base.order } : null;
      if (d) {
        items.push(d);
      }
    }
    if (items.length > 0) pushDisplay({ kind: 'conversations', full: false, items, removed_gids: [] });
  };
  const flushUnread = async (): Promise<void> => {
    unreadTimer = null;
    if (unreadInFlight) return;
    const drain = {};
    unreadInFlight = drain;
    try {
      while (running && unreadInFlight === drain && pendingUnread.size > 0) await runUnreadBatch();
    } finally { if (unreadInFlight === drain) unreadInFlight = null; }
  };
  const scheduleUnread = (gids: readonly string[]): void => {
    for (const g of gids) pendingUnread.add(g);
    if (unreadTimer === null && !unreadInFlight) unreadTimer = deps.setTimeout(() => void flushUnread(), opts.unreadDebounceMs ?? 300);
  };

  // ---- conversation list → display
  const onListOutcome = (outcome: SoaOutcome<ConversationListResponse>, variant: ConversationListVariant, ticket?: unknown): void => {
    if (!running) return;
    const generation = runGeneration;
    // called by the poller before it advances its cursor: a null cursor means this response is a full snapshot
    const poller = adapter.conversationPollers[(opts.variants ?? ['plain']).indexOf(variant)];
    const full = (poller?.cursor ?? null) === null;
    const statusRead = ticket as StatusRead | undefined;
    if (outcome.kind !== 'success') { statusRead?.fail(); return; }
    const status = agentStatusOf(outcome.body.currentStatus);
    if (status !== null) statusRead?.commit(status); else statusRead?.fail();
    const rows = Array.isArray(outcome.body.conversationList) ? (outcome.body.conversationList as unknown[]) : [];
    const complete = full && outcome.body.haveRest !== true;
    const gids = store.update(rows);
    const observed = new Set<string>();
    for (const gid of gids) {
      if (observed.has(gid)) pendingPreviews.delete(gid);
      observed.add(gid);
    }
    const projected = new Set<string>();
    const items: DisplayConversation[] = [];
    for (const raw of rows) {
      const base = toDisplayConversation(raw as ConversationListItem, full, unread, roles.selfUid);
      // Store identity is the final row of this batch. Never give an earlier
      // raw customer's display fields the final row's identity signature.
      if (!base || store.row(base.gid) !== raw || projected.has(base.gid)) continue;
      projected.add(base.gid);
      restoreProductName(base.gid);
      const uid = store.view(base.gid)?.customerUid;
      const d = { ...initialPreview(base, raw as ConversationListItem), title: uid ? roles.profileOf(uid).name ?? base.title : base.title, order: store.order(base.gid) ?? base.order };
      const signature = contextOf(d.gid);
      const prev = signature && displayContexts.get(d.gid) === signature ? displays.get(d.gid) : undefined;
      // a realtime preview newer than the row stays until the list catches up
      const merged = prev && prev.last_message_time_ms !== null && (d.last_message_time_ms ?? 0) < prev.last_message_time_ms ? { ...d, preview: prev.preview, last_message_time_ms: prev.last_message_time_ms } : d;
      items.push(merged);
      roles.addCustomer(store.view(d.gid)?.customerUid ?? null);
    }
    const removed: string[] = [];
    if (complete) {
      const keep = new Set(gids);
      for (const gid of pendingPreviews.keys()) if (!keep.has(gid)) pendingPreviews.delete(gid);
      for (const g of [...displays.keys()]) {
        if (!keep.has(g)) {
          displays.delete(g);
          displayContexts.delete(g);
          productQueue.delete(g);
          productAttempts.delete(g);
          removed.push(g);
        }
      }
    }
    if (items.length > 0 || complete || recoverDisplaySnapshot) pushDisplay({ kind: 'conversations', full: complete, items, removed_gids: removed });
    preloadPreviews(gids);
    preloadProductNames(gids);
    // List groupTitle is the product title. The customer's display nick comes from the member API.
    for (const gid of gids) {
      const expectedUid = store.view(gid)?.customerUid;
      void roles.ensure(deps, soa, gid, 'background').then(() => {
        if (!running || generation !== runGeneration || store.view(gid)?.customerUid !== expectedUid) return;
        const display = displays.get(gid);
        const uid = store.view(gid)?.customerUid;
        const profile = uid ? roles.profileOf(uid) : null;
        if (!display || (!profile?.name && !profile?.avatar)) return;
        const next = { ...display, title: profile?.name ?? display.title, is_full_snapshot: false };
        pushDisplay({ kind: 'conversations', full: false, items: [next], removed_gids: [] });
      }).catch(() => undefined);
    }
    if (gids.length > 0) scheduleUnread(gids);
  };

  const productCache = opts.productNameCache ?? createProductNameCache();
  const productQueue = new Map<string, string>();
  const productAttempts = new Map<string, { key: string; at: number; delay: number }>();
  let productLoading = false;
  const productKey = (gid: string): string | null => {
    const v = store.view(gid);
    if (!v?.customerUid || !v.conversationType || !v.serviceType) return null;
    return JSON.stringify([opts.account.environment, opts.account.account_id, gid, v.sessionId, v.customerUid, v.conversationType, v.serviceType, v.threadId, v.conversationKey, recordOrNull(store.row(gid))?.['id'], v.orderId]);
  };
  const restoreProductName = (gid: string): void => {
    const key = productKey(gid), view = store.view(gid);
    if (!key || !view || store.order(gid)?.product) return;
    const cached = productCache.get(key);
    if (!cached || view.orderId && view.orderId !== cached.orderId) return;
    store.noteSourceOrder(gid, { order_id: cached.orderId, product: cached.product, use_date: '', quantity: '', status: '', contact: '' }, store.messageContext(gid), cached.savedAt, store.beginSourceRead(gid));
  };
  const drainProductNames = (): void => {
    if (!running || productLoading || !productQueue.size) return;
    const [gid, key] = productQueue.entries().next().value!;
    productQueue.delete(gid);
    const view = store.view(gid);
    if (!view || !displays.has(gid) || productKey(gid) !== key) { drainProductNames(); return; }
    productLoading = true;
    const generation = runGeneration, revision = store.messageContext(gid), started = deps.now(), read = store.beginSourceRead(gid);
    productAttempts.set(gid, { key, at: started, delay: 60_000 });
    void fetchOrderSource(deps, soa, gid, view.orderId).then(result => {
      if (!running || generation !== runGeneration || revision !== store.messageContext(gid) || !displays.has(gid) || key !== productKey(gid) || result.kind === 'unavailable') return;
      if (result.kind === 'order') {
        store.noteSourceOrder(gid, result.order, revision, started, read);
        // A foreground read can supersede this request while it is in flight.
        if (store.order(gid)?.order_id !== result.order.order_id || store.order(gid)?.product !== result.order.product) return;
        if (result.order.product.trim()) productCache.set(key, { orderId: result.order.order_id, product: result.order.product, savedAt: deps.now() });
      } else {
        if (!store.denySourceOrder(gid, revision, read)) return;
        productCache.delete(key);
      }
      productAttempts.set(gid, { key, at: deps.now(), delay: 15 * 60_000 });
      const display = displays.get(gid);
      if (display) void pushDisplay({ kind: 'conversations', full: false, items: [{ ...display, order: store.order(gid) ?? null }], removed_gids: [] });
    }).catch(() => undefined).finally(() => { productLoading = false; drainProductNames(); });
  };
  const preloadProductNames = (gids: readonly string[]): void => {
    const ordered = [...gids].sort((a, b) => {
      const left = displays.get(a), right = displays.get(b);
      return (right?.last_message_time_ms ?? right?.last_update_time_ms ?? 0) - (left?.last_message_time_ms ?? left?.last_update_time_ms ?? 0);
    });
    for (const gid of ordered) {
      const key = productKey(gid);
      if (!key) continue;
      const previous = productAttempts.get(gid), cached = productCache.get(key);
      if (previous?.key === key && deps.now() - previous.at < previous.delay || !previous && cached && deps.now() - cached.savedAt < 15 * 60_000) continue;
      if (productQueue.size < 2000) productQueue.set(gid, key);
    }
    drainProductNames();
  };

  // Preview reads never dispatch message facts, hydrate a thread, or mark it read.
  const previewQueue = new Map<string, string>();
  const previewAttempts = new Map<string, { key: string; at: number }>();
  let previewReads = 0;
  const previewVersions = new Map<string, number>();
  const previewKey = (gid: string): string => JSON.stringify([contextOf(gid), store.messageContext(gid), store.view(gid), recordOrNull(store.row(gid))?.['lastMessageTime']]);
  const drainPreviewQueue = (): void => {
    while (running && previewReads < 2 && previewQueue.size) {
      const [gid, key] = previewQueue.entries().next().value!;
      previewQueue.delete(gid);
      const view = store.view(gid), generation = runGeneration;
      if (!view?.conversationType || key !== previewKey(gid)) continue;
      const body = messageListBody(deps, { gid, conversationType: view.conversationType, pageSize: 20 });
      if (!body) continue;
      const arrivalVersion = previewVersions.get(gid) ?? 0;
      previewReads++;
      previewAttempts.set(gid, { key, at: deps.now() });
      void soa.post<{ rangeMessage?: { messages?: unknown } }>(Endpoints.MESSAGE_LIST, body, { timeoutMs: 5000 }).then(result => {
        if (!running || generation !== runGeneration || key !== previewKey(gid) || arrivalVersion !== (previewVersions.get(gid) ?? 0) || result.kind !== 'success') return;
        const rows = result.body.rangeMessage?.messages;
        if (!Array.isArray(rows)) return;
        const candidates = rows.flatMap(value => {
          const message = recordOrNull(value) as HttpMessageObject | null;
          const time = normalizeTimeMs(message?.createTime);
          const thread = recordOrNull(message)?.['threadId'];
          if (view.threadId && typeof thread === 'string' && thread && thread !== view.threadId) return [];
          if (store.messageContext(gid) !== 1 && time !== null && time > (store.latestMessage(gid)?.createTime ?? 0)) return [];
          const preview = previewOf(message, roles.selfUid);
          return message && time !== null && preview ? [{ time, preview }] : [];
        }).sort((a, b) => b.time - a.time);
        const latest = candidates[0], display = displays.get(gid);
        if (!latest || !display || (display.preview && latest.time < (display.last_message_time_ms ?? 0))) return;
        void pushDisplay({ kind: 'conversations', full: false, removed_gids: [], items: [{ ...display, preview: latest.preview, last_message_time_ms: Math.max(display.last_message_time_ms ?? 0, latest.time) }] });
      }).catch(() => undefined).finally(() => { previewReads--; drainPreviewQueue(); });
    }
  };
  const preloadPreviews = (gids: readonly string[]): void => {
    for (const gid of gids) {
      const status = store.row(gid)?.status;
      if (!store.view(gid)?.conversationType || (displays.get(gid)?.preview && status !== 1 && status !== 2)) continue;
      const key = previewKey(gid), previous = previewAttempts.get(gid);
      // Active rows refresh with the list loop; finished empty rows are a bounded recovery extension.
      if (previous?.key === key && deps.now() - previous.at < (status === 1 || status === 2 ? 5000 : 60_000)) continue;
      if (previewQueue.size < 2000) previewQueue.set(gid, key);
    }
    for (const gid of previewAttempts.keys()) if (!store.has(gid)) previewAttempts.delete(gid);
    drainPreviewQueue();
  };

  // ---- realtime / compensation messages → display
  const pushMessages = (items: readonly UiMessage[], summary?: string): void => {
    const byGid = new Map<string, UiMessage[]>();
    for (const m of items) {
      previewVersions.set(m.gid, (previewVersions.get(m.gid) ?? 0) + 1);
      const list = byGid.get(m.gid) ?? [];
      list.push(m);
      byGid.set(m.gid, list);
    }
    const convs: DisplayConversation[] = [];
    for (const [gid, list] of byGid) {
      list.sort(byCreateTime);
      pushDisplay({ kind: 'messages', gid, replace: false, items: list });
      if (store.view(gid) && contextOf(gid)) void roles.ensure(deps, soa, gid, 'background').catch(() => undefined);
      const last = list[list.length - 1];
      const d = displays.get(gid);
      const row = store.row(gid);
      const order = store.order(gid) ?? (row ? toDisplayConversation(row, false, unread, roles.selfUid)?.order : null) ?? null;
      const verifiedTarget = store.messageContext(gid) === 1 || last?.message_id === store.latestMessage(gid)?.msgId;
      const newerPreview = last && verifiedTarget && (d?.last_message_time_ms ?? 0) <= last.create_time_ms;
      if (last && d && (newerPreview || JSON.stringify(d.order) !== JSON.stringify(order))) {
        const next = { ...d, order, ...(newerPreview ? { preview: summary || previewOfUi(last), last_message_time_ms: last.create_time_ms } : {}), is_full_snapshot: false };
        convs.push(next);
      }
    }
    if (convs.length > 0) pushDisplay({ kind: 'conversations', full: false, items: convs, removed_gids: [] });
  };

  const pushRawPreview = (gid: string, message: HttpMessageObject): void => {
    const display = displays.get(gid), canonical = roomJidFromMessage(gid, store.view(gid)?.lastMessage ?? null);
    const room = roomJidFromMessage(gid, message), time = normalizeTimeMs(message.createTime);
    const preview = previewOf(message, roles.selfUid);
    const latest = store.latestMessage(gid);
    const verified = store.messageContext(gid) === 1 || !!latest && typeof message.msgId === 'string' && message.msgId.trim().length > 0 && message.msgId === latest.msgId;
    if (!verified || !display || !canonical || room?.toLowerCase() !== canonical.toLowerCase() || time === null || time < (display.last_message_time_ms ?? 0) || !preview) return;
    previewVersions.set(gid, (previewVersions.get(gid) ?? 0) + 1);
    void pushDisplay({ kind: 'conversations', full: false, items: [{ ...display, preview, last_message_time_ms: time }], removed_gids: [] });
  };

  readStatuses = createReadStatusSync({ deps, soa, store, roles, publish: pushDisplay,
    context: gid => { const context = contextOf(gid); return context ? JSON.stringify([context, store.messageContext(gid)]) : null; },
    captureCurrent: () => { const generation = runGeneration; return () => running && generation === runGeneration; },
  });

  const incomingVersions = new Map<string, number>();
  const incomingEvidence = new Map<string, { context: number | null; time: number; ids: Set<string> }>();
  const readAdmission = (gid: string) => {
    const version = incomingVersions.get(gid) ?? 0;
    const context = store.messageContext(gid), generation = runGeneration;
    return () => {
      const evidence = incomingEvidence.get(gid), target = store.readTarget(gid);
      const covered = !evidence || evidence.context !== context || !!target && (evidence.time < target.createTime || evidence.time === target.createTime && [...evidence.ids].every(id => id === target.msgId));
      return covered && running && generation === runGeneration && context === store.messageContext(gid) && version === (incomingVersions.get(gid) ?? 0);
    };
  };
  const noteIncoming = (gid: string, sender: string, type: unknown, id: unknown, timeValue: unknown): void => {
    const n = Number(type), customer = store.view(gid)?.customerUid;
    if (customer && sender.toLowerCase() === customer.toLowerCase() && Number.isInteger(n) && n >= 0 && n < 1000) {
      incomingVersions.set(gid, (incomingVersions.get(gid) ?? 0) + 1);
      const context = store.messageContext(gid), time = normalizeTimeMs(timeValue) ?? Infinity, previous = incomingEvidence.get(gid);
      const token = typeof id === 'string' ? id : '';
      if (!previous || previous.context !== context || time > previous.time) incomingEvidence.set(gid, { context, time, ids: new Set([token]) });
      else if (time === previous.time) previous.ids.add(token);
      scheduleUnread([gid]);
    }
  };
  const onSdkMessage = (evt: SdkMessageEvent): void => {
    if (readStatuses!.receive(evt)) return;
    diagnostics.session.received = receiveCount(diagnostics.session.received);
    const generation = runGeneration;
    const address = resolveSdkAddress(evt, roles);
    if (address) noteIncoming(address.gid, effectiveMessageSender(address.senderId, evt.body, evt.msgtype), evt.msgtype, evt.id, evt.create_time ?? evt.ts);
    const ui = sdkMessageToUi(evt, roles);
    if (!ui) {
      if (address) pushRawPreview(address.gid, { msgId: evt.id, fromJid: evt.from, toJid: evt.to, createTime: evt.create_time ?? evt.ts, msgtype: evt.msgtype, messageBody: evt.body });
      diagnostics.session.ui_dropped = receiveCount(diagnostics.session.ui_dropped); return;
    }
    diagnostics.session.ui_mapped = receiveCount(diagnostics.session.ui_mapped);
    rememberPending(ui, roomJidFromMessage(ui.gid, { fromJid: evt.from, toJid: evt.to }), evt.threadid);
    const order = orderSummaryFromMessage({ msgtype: evt.msgtype, messageBody: evt.body });
    if (order) store.noteOrder(ui.gid, order, ui.create_time_ms);
    const previousTarget = store.readTarget(ui.gid)?.msgId;
    const raw = { msgId: evt.id, localId: evt.localid, createTime: ui.create_time_ms, fromJid: evt.from, toJid: evt.to, msgtype: evt.msgtype, messageBody: evt.body, threadId: evt.threadid };
    const canonicalRoom = roomJidFromMessage(ui.gid, store.view(ui.gid)?.lastMessage ?? null);
    const incomingRoom = roomJidFromMessage(ui.gid, raw);
    // A room-verified frame is live evidence: the customer's newest message is the
    // read frontier even before the list poll observes it; own/colleague replies
    // only extend the consumed watermark.
    if (canonicalRoom && incomingRoom?.toLowerCase() === canonicalRoom.toLowerCase()) store.noteLiveMessage(ui.gid, raw);
    syncFrontier(ui.gid);
    pushMessages([ui], previewOf(raw, roles.selfUid));
    if (store.readTarget(ui.gid)?.msgId !== previousTarget) {
      const display = displays.get(ui.gid);
      if (display) void pushDisplay({ kind: 'conversations', full: false, items: [display], removed_gids: [] });
    }
    const messageContext = store.messageContext(ui.gid);
    if (store.has(ui.gid)) void roles.ensure(deps, soa, ui.gid, 'background').then(() => {
      if (!running || generation !== runGeneration || store.messageContext(ui.gid) !== messageContext) return;
      const enriched = sdkMessageToUi(evt, roles);
      if (enriched?.sender_id) pushDisplay({ kind: 'message_profiles', gid: enriched.gid, items: [{
        message_id: enriched.message_id, local_id: enriched.local_id,
        sender_id: enriched.sender_id, sender_name: enriched.sender_name ?? null,
        sender_avatar: enriched.sender_avatar ?? null,
      }] });
    }).catch(() => undefined);
  };

  /** Per-gid service revision when a compensation request was issued; a late response cannot bind frames to a newer context. */
  const compensationTicket = (): CompensationTicket => ({ generation: runGeneration, contexts: new Map(store.gids().map(gid => [gid, store.messageContext(gid)])) });
  // A gid unknown when the request went out has no binding at all: its frontier waits for
  // the row itself, history, or the next request (no "first context" exception).
  const boundToCurrentContext = (ticket: CompensationTicket | undefined, gid: string): boolean =>
    !ticket || (ticket.generation === runGeneration && ticket.contexts.has(gid) && ticket.contexts.get(gid) === store.messageContext(gid));
  const onCompensation = (outcome: SoaOutcome<RecentMessagesResponse>, ticket?: unknown): void => {
    if (!running) return;
    const bound = ticket as CompensationTicket | undefined;
    if (outcome.kind === 'auth_invalid') presence.invalidate();
    diagnostics.compensation.last_outcome_ms = deps.now();
    diagnostics.compensation.outcomes[outcome.kind] = receiveCount(diagnostics.compensation.outcomes[outcome.kind]);
    if (outcome.kind !== 'success' || !Array.isArray(outcome.body.messages)) return;
    diagnostics.compensation.rows = receiveCount(diagnostics.compensation.rows, outcome.body.messages.length);
    const items: UiMessage[] = [];
    const frontierMoved = new Set<string>();
    for (const m of outcome.body.messages as HttpMessageObject[]) {
      if (typeof m !== 'object' || m === null) { diagnostics.compensation.dropped = receiveCount(diagnostics.compensation.dropped); continue; }
      const from = typeof m.fromJid === 'string' ? m.fromJid : '';
      const target = typeof m.partner === 'string' ? m.partner : typeof m.toJid === 'string' ? m.toJid : '';
      noteIncoming(jidLocal(from.includes('/') ? from : target), effectiveMessageSender(jidSender(from), m.messageBody, m.msgtype), m.msgtype, m.msgId, m.createTime);
      const ui = httpMessageToUi(m, roles);
      if (!ui) { diagnostics.compensation.dropped = receiveCount(diagnostics.compensation.dropped); continue; }
      diagnostics.compensation.mapped = receiveCount(diagnostics.compensation.mapped);
      rememberPending(ui, roomJidFromMessage(ui.gid, m), recordOrNull(m)?.['threadId'] ?? recordOrNull(m)?.['threadid']);
      const order = orderSummaryFromMessage(m);
      if (order) store.noteOrder(ui.gid, order, ui.create_time_ms);
      const jid = roomJidFromMessage(ui.gid, m);
      const canonical = roomJidFromMessage(ui.gid, store.view(ui.gid)?.lastMessage ?? null);
      if (jid && canonical === jid) opts.sdk.rememberPartnerJid(ui.gid, jid);
      // Same admission as the realtime path (room-verified) plus request binding:
      // a response issued in an earlier service context of this gid is display only.
      if (jid && canonical && jid.toLowerCase() === canonical.toLowerCase() && boundToCurrentContext(bound, ui.gid)) {
        const previousTarget = store.readTarget(ui.gid)?.msgId;
        store.noteLiveMessage(ui.gid, m);
        syncFrontier(ui.gid);
        if (store.readTarget(ui.gid)?.msgId !== previousTarget) frontierMoved.add(ui.gid);
      }
      items.push(ui);
    }
    if (items.length > 0) pushMessages(items);
    for (const gid of frontierMoved) {
      const display = displays.get(gid);
      if (display) void pushDisplay({ kind: 'conversations', full: false, items: [display], removed_gids: [] });
    }
    for (const value of outcome.body.messages) {
      const m = recordOrNull(value) as HttpMessageObject | null;
      if (!m) continue;
      const from = typeof m.fromJid === 'string' ? m.fromJid : '';
      const target = typeof m.partner === 'string' ? m.partner : typeof m.toJid === 'string' ? m.toJid : '';
      pushRawPreview(jidLocal(from.includes('/') ? from : target), m);
    }
  };

  const onSocket = (status: SdkSocketStatus): void => {
    const state: TransportState = typeof status === 'string' && TRANSPORT_STATES.has(status) ? status : 'disconnected';
    pushDisplay({ kind: 'transport', state });
    if (state !== 'connected') presence.invalidate();
  };

  // First login: the work status must be learned before anything else. Keep reading
  // until this run has one confirmed observation, at a short fixed cadence — the list
  // poller's hidden-page stretch and failure backoff would leave the status unknown for
  // minutes. Stops on the first observation (from any source), stop, or auth failure.
  let acquireTimer: unknown = null;
  const stopAcquire = (): void => { if (acquireTimer !== null) deps.clearTimeout(acquireTimer); acquireTimer = null; };
  // The first read waits briefly: the list poller (or the official loop) normally answers
  // at once, and a healthy start should not issue a second request.
  const scheduleAcquire = (generation: number, attempt: number): void => {
    stopAcquire();
    acquireTimer = deps.setTimeout(() => { acquireTimer = null; acquireStatus(generation, attempt); }, attempt === 0 ? 1500 : Math.min(2000 * attempt, 5000));
  };
  const acquireStatus = (generation: number, attempt: number): void => {
    if (!running || generation !== runGeneration || presence.observed || attempt > 60) return;
    const ticket = presence.captureRead();
    void soa.post<ConversationListResponse>(Endpoints.CONVERSATION_LIST, conversationListBody(deps, null, false)).then(outcome => {
      if (!running || generation !== runGeneration) return;
      if (outcome.kind === 'auth_invalid') { ticket.fail(); return; }
      const status = outcome.kind === 'success' ? agentStatusOf(outcome.body.currentStatus) : null;
      if (status !== null && ticket.commit(status)) return;
      if (status === null) ticket.fail();
      if (presence.observed) return;
      scheduleAcquire(generation, attempt + 1);
    });
  };

  const variants = opts.variants ?? ['plain'];
  const adapter: Adapter = createAdapter(deps, {
    onTerminal: stopSession,
    ...(opts.bridgeCapacity !== undefined ? { bridgeCapacity: opts.bridgeCapacity } : {}),
    onQueueFault: (_diagnostics, error) => {
      if (queueFaulted) return;
      queueFaulted = true;
      stopSession();
      adapter.bridge.dispose();
      opts.sdk.dispose();
      void pushDisplay({ kind: 'transport', state: 'disconnected' });
      // The host keeps the account signed in, so a stopped page must not
      // stay this way: the owner reboots it, whatever the host answered.
      const unhandled = (): void => { log('bridge queue fault: session stopped, handing over to a fresh boot'); opts.onFaultUnhandled?.(); };
      // One out-of-band lifecycle report; it cannot wait behind the full fact
      // queue. Unknown outcome is never replayed and no SDK reconnect is made.
      try {
        void deps.invoke(AdapterCommands.PUSH_FACT, { account: opts.account, stream: FactStreams.TRANSPORT, epoch: opts.initialEpoch, seq: 0, fact: { kind: 'bridge_fault', fault: { boot_epoch: opts.initialEpoch, reason: error.code === 'bridge.delivery_failed' ? 'delivery_failed' : 'queue_overflow' } } })
          .then(unhandled, unhandled);
      } catch { unhandled(); }
    },
    account: opts.account,
    initialBeginMsgTime: opts.beginMsgTime,
    initialEpoch: opts.initialEpoch,
    conversationListVariants: variants,
    // A hidden account is long-lived; keep the read-only recovery path active
    // unless the caller configures a stop delay (I-06; default decided after fault injection).
    normalLoopStopAfterMs: opts.normalLoopStopAfterMs ?? null,
    ...(opts.officialConversationFeed ? { officialConversationFeed: opts.officialConversationFeed } : {}),
    ...(opts.conversationVisibility ? { conversationVisibility: opts.conversationVisibility } : {}),
    // The adapter WebView can be hidden while the desktop is in use. Its
    // currentStatus also renews the 15 s notification/status lease: the generic
    // 30 s hidden cadence would repeatedly expire an otherwise healthy status.
    // Keep one 5 s loop; the poller still reuses the official feed and backs off
    // on failures rather than starting a second status-only request loop.
    conversationHiddenIntervalMultiplier: 1,
    ...(opts.onConversationBootstrap ? { onConversationBootstrap: opts.onConversationBootstrap } : {}),
    roles,
    unread,
    onConversationListOutcome: onListOutcome,
    onConversationListRequest: () => presence.captureRead(),
    onCompensationRequest: compensationTicket,
    onCompensationOutcome: onCompensation,
  });

  const pushFact = (fact: AdapterFact): void => {
    adapter.bridge.push(fact);
  };

  /** Read back the gid returned by the order flow; never invent a conversation from URL/start-chat args. */
  const ensureOrderConversation = async (gid: string, orderId: string, current: () => boolean): Promise<boolean> => {
    if (typeof gid !== 'string' || !/^\d{1,32}$/.test(gid) || /^0+$/.test(gid) || !/^(?:\d{10}|\d{16})$/.test(orderId)) return false;
    const generation = runGeneration, previousRow = store.row(gid);
    const applies = () => running && generation === runGeneration && current();
    if (!applies()) return false;
    const outcome = await soa.post<unknown>(LATEST_CONVERSATION, { head: businessHead(deps.context), gid });
    if (!applies() || store.row(gid) !== previousRow || outcome.kind !== 'success' || !isBizSuccess(outcome.body)) return false;
    const row = recordOrNull(recordOrNull(outcome.body)?.['conversation']);
    if (!row || row['gid'] !== gid) return false;
    const ext = recordOrNull(row['ext']);
    const candidates = [row['relationOrderId'], ext?.['relationOrderId'], ext?.['orderId'], ext?.['relationorderid'], ext?.['orderid']].filter(value => value !== undefined && value !== null && value !== '');
    // Never round a numeric order id or accept conflicting order evidence.
    if (!candidates.length || candidates.some(value => typeof value === 'string' ? value !== orderId : typeof value !== 'number' || !Number.isSafeInteger(value) || String(value) !== orderId)) return false;
    const view = rowView(row);
    if (!view || view.orderId !== orderId || !view.sessionId || !view.customerUid || !view.serviceType || !view.conversationType || ![1, 2, 4].includes(row['status'] as number)) return false;
    if (typeof row['id'] === 'number' && !Number.isSafeInteger(row['id'])) return false;
    const display = toDisplayConversation(row, false, unread, roles.selfUid), fact = toConversationFact(row, false, unread);
    if (!display || !fact || !applies()) return false;
    store.update([row]);
    roles.addCustomer(view.customerUid);
    pushFact({ kind: 'conversation', fact });
    await adapter.bridge.flush();
    if (!applies() || store.row(gid) !== row) return false;
    const published = await pushDisplay({ kind: 'conversations', full: false, items: [display], removed_gids: [] });
    if (!published || !applies() || store.row(gid) !== row) return false;
    scheduleUnread([gid]);
    return true;
  };

  const rpc = createRpc({
    deps,
    soa,
    sdk: opts.sdk,
    store,
    roles,
    pushFact,
    pushDisplay,
    agent: agentBox,
    ensureOrderConversation,
    captureReadAcknowledgment: readAdmission,
    onReadReceiptConfirmed: gid => { if (running) scheduleUnread([gid]); },
    onReadAcknowledged: async (gid, id, through) => {
      const noNewMessages = readAdmission(gid);
      const generation = runGeneration, context = store.messageContext(gid);
      await readStatuses!.acknowledged(gid, id);
      if (!running || generation !== runGeneration) return;
      // The server count is the authority after any confirmed receipt, admitted locally or not.
      const target = store.readTarget(gid);
      if (!noNewMessages() || context !== store.messageContext(gid) || target?.msgId !== id || !through) { scheduleUnread([gid]); return; }
      unread.acknowledge(gid, target, store.view(gid)?.customerUid ?? null, deps.now());
      const row = store.row(gid), display = displays.get(gid);
      if (row) {
        const fact = toConversationFact(row, false, unread);
        if (fact) adapter.bridge.push({ kind: 'conversation', fact });
      }
      if (display) await pushDisplay({ kind: 'conversations', full: false, items: [{ ...display, unread_count: 0 }], removed_gids: [] });
      scheduleUnread([gid]);
    },
    receiveDiagnostics: () => ({ version: 1, captured_at_ms: deps.now(), running, run_generation: runGeneration, sdk: opts.sdk.receiveDiagnostics ?? null, bridge: adapter.bridge.diagnostics,
      session: { ...diagnostics.session }, compensation: { ...diagnostics.compensation, outcomes: { ...diagnostics.compensation.outcomes }, running: adapter.compensation.running, mode: adapter.compensation.mode, cursor_ms: adapter.compensation.cursor } }),
    captureWriteGuard: () => {
      const generation = runGeneration;
      return () => running && generation === runGeneration;
    },
    ...(opts.sendAckTimeoutMs !== undefined ? { sendAckTimeoutMs: opts.sendAckTimeoutMs } : {}),
    ...(opts.orderGidWaitMs !== undefined ? { orderGidWaitMs: opts.orderGidWaitMs } : {}),
  });

  let unsubs: (() => void)[] = [];
  function stopSession(): void {
    if (!running) return;
    runGeneration++;
    running = false;
    stopAcquire();
    presence.stop();
    // Revoke queued/in-flight member enrichment before it can start remark
    // requests or publish profiles after this run has stopped.
    for (const gid of store.gids()) roles.invalidate(gid);
    for (const u of unsubs) u();
    unsubs = [];
    if (unreadTimer !== null) deps.clearTimeout(unreadTimer);
    unreadTimer = null;
    unreadInFlight = null;
    conversationPending?.done(false);
    conversationPending = null;
    pendingUnread.clear();
    readStatuses?.reset();
    pendingPreviews.clear();
    previewVersions.clear();
    incomingEvidence.clear();
    incomingVersions.clear();
    productQueue.clear();
    productAttempts.clear();
    previewQueue.clear();
    previewAttempts.clear();
    adapter.stop();
  }

  return {
    adapter,
    rpc,
    store,
    roles,
    unread,
    start() {
      if (running || queueFaulted) return;
      runGeneration++;
      running = true;
      sentDisplays.clear();
      recoverDisplaySnapshot = false;
      presence.start();
      const generation = runGeneration;
      unsubs = [opts.sdk.on('message', evt => { if (running && generation === runGeneration) onSdkMessage(evt); }), opts.sdk.on('socket_status', status => { if (running && generation === runGeneration) onSocket(status); })];
      pushDisplay({ kind: 'transport', state: opts.sdk.getSocketStatus() ? 'connected' : 'disconnected' });
      adapter.start();
      scheduleAcquire(generation, 0);
      log(`adapter started (epoch ${adapter.bridge.epoch})`);
    },
    stop: stopSession,
  };
}
