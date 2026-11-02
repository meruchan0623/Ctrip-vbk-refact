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

import type { AccountContext, AdapterFact, TransportState } from '../../ipc/src/contracts.ts';
import type { UiMessage } from '../../ipc/src/client.ts';
import type { AdapterDisplayPayload, DisplayConversation } from '../../ipc/src/adapterProtocol.ts';
import type { AdapterDeps, SdkMessageEvent, SdkSocketStatus } from './deps.ts';
import { createAdapter, type Adapter } from './index.ts';
import { SoaClient, recordOrNull, type SoaOutcome } from './soa.ts';
import { toConversationFact, type ConversationListItem, type ConversationListResponse, type ConversationListVariant } from './conversationList.ts';
import type { RecentMessagesResponse } from './compensation.ts';
import { normalizeTimeMs, type HttpMessageObject } from './facts.ts';
import { agentStatusOf, byCreateTime, httpMessageToUi, orderSummaryFromMessage, previewOfUi, sdkMessageToUi, toDisplayConversation } from './display.ts';
import { ConversationStore, RoleBook, UnreadBook, roomJidFromMessage } from './stores.ts';
import { createRpc, type AgentStatusBox, type Rpc } from './rpc.ts';
import type { IdentityProfile } from './identity.ts';
import type { PageSdk } from './sdkGlue.ts';
import { createReceiveCounters, receiveCount } from './diagnostics.ts';
import { createPresence, type StatusRead } from './presence.ts';
import { latestPeerReadTarget } from './markRead.ts';

export interface PageSessionOptions {
  readonly account: AccountContext;
  readonly selfUid: string;
  readonly selfProfile?: IdentityProfile;
  readonly beginMsgTime: number;
  readonly initialEpoch: number;
  readonly sdk: PageSdk;
  /** Display push (`adapter_push_display`); errors are swallowed by the session. */
  readonly pushDisplay: (payload: AdapterDisplayPayload) => Promise<unknown>;
  readonly variants?: readonly ConversationListVariant[];
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

const TRANSPORT_STATES: ReadonlySet<string> = new Set<TransportState>(['connecting', 'connected', 'disconnected', 'reconnecting']);

export function createPageSession(deps: AdapterDeps, opts: PageSessionOptions): PageSession {
  const soa = new SoaClient(deps);
  const store = new ConversationStore();
  const roles = new RoleBook(opts.selfUid);
  if (opts.selfProfile) roles.setSelfProfile(opts.selfProfile);
  const unread = new UnreadBook();
  const displays = new Map<string, DisplayConversation>();
  const displayContexts = new Map<string, string>();
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

  const pushDisplay = (payload: AdapterDisplayPayload): void => {
    if (payload.kind === 'conversations' && !running) return;
    const messages = payload.kind === 'messages';
    if (messages) {
      diagnostics.session.display_batches = receiveCount(diagnostics.session.display_batches);
      diagnostics.session.display_items = receiveCount(diagnostics.session.display_items, payload.items.length);
    }
    // Every conversation projection (including history enrichment) shares the
    // authoritative unread book. Reading history cannot acknowledge messages.
    const current = payload.kind === 'conversations'
      ? { ...payload, items: payload.items.map((item) => {
          const signature = contextOf(item.gid);
          const previous = signature && displayContexts.get(item.gid) === signature ? displays.get(item.gid) : undefined;
          const uid = store.view(item.gid)?.customerUid;
          const next = {
            ...item,
            // The row's customer uid is the only association for this surface.
            // RoleBook preserves known profile fields on incomplete refreshes.
            customer_avatar: uid ? roles.profileOf(uid).avatar : null,
            read_target_message_id: latestPeerReadTarget(store, item.gid)?.msgId ?? null,
            assistant_context_revision: store.assistantContextRevision(item.gid, roles.selfUid, opts.sdk.partnerJidOf(item.gid) ?? roomJidFromMessage(item.gid, store.view(item.gid)?.lastMessage ?? null)) ?? '',
            ...(previous && (previous.last_message_time_ms ?? 0) > (item.last_message_time_ms ?? 0)
              ? { preview: previous.preview, last_message_time_ms: previous.last_message_time_ms }
              : {}),
            unread_count: unread.unreadOf(item.gid) ?? item.unread_count,
          };
          displays.set(item.gid, next);
          if (signature) displayContexts.set(item.gid, signature); else displayContexts.delete(item.gid);
          return next;
        }) }
      : payload;
    try {
      opts.pushDisplay(current).then(() => {
        if (messages) diagnostics.session.display_resolved = receiveCount(diagnostics.session.display_resolved);
      }, () => {
        if (messages) diagnostics.session.display_rejected = receiveCount(diagnostics.session.display_rejected);
        log(`display push failed (${payload.kind})`);
      });
    } catch {
      if (messages) diagnostics.session.display_rejected = receiveCount(diagnostics.session.display_rejected);
      log(`display push failed (${payload.kind})`);
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
  let running = false;
  let runGeneration = 0;
  const unreadContexts = new Map<string, number | null>();
  store.watch(gids => {
    for (const gid of gids) {
      latestPeerReadTarget(store, gid);
      const current = store.messageContext(gid);
      const room = roomJidFromMessage(gid, store.view(gid)?.lastMessage ?? null);
      if (room) opts.sdk.rememberPartnerJid(gid, room);
      if (unreadContexts.has(gid) && unreadContexts.get(gid) !== current) unread.invalidate(gid);
      unreadContexts.set(gid, current);
    }
  });
  const flushUnread = async (): Promise<void> => {
    const generation = runGeneration;
    unreadTimer = null;
    const gids = [...pendingUnread];
    pendingUnread.clear();
    if (gids.length === 0 || !running) return;
    const contexts = new Map(gids.map(gid => [gid, store.messageContext(gid)]));
    const current = (gid: string): boolean => running && generation === runGeneration && contexts.get(gid) === store.messageContext(gid);
    const changed = await unread.refresh(deps, soa, gids, (gid, msg) => {
      if (!running || generation !== runGeneration) return;
      const jid = roomJidFromMessage(gid, msg);
      if (jid && roomJidFromMessage(gid, store.view(gid)?.lastMessage ?? null) === jid) opts.sdk.rememberPartnerJid(gid, jid);
    }, current);
    if (!running || generation !== runGeneration) return;
    const items: DisplayConversation[] = [];
    for (const gid of changed) {
      const row = store.row(gid);
      if (!row) continue;
      const fact = toConversationFact(row, false, unread);
      if (fact) adapter.bridge.push({ kind: 'conversation', fact });
      const base = toDisplayConversation(row, false, unread);
      const uid = store.view(gid)?.customerUid;
      const d = base ? { ...base, title: uid ? roles.profileOf(uid).name ?? base.title : base.title, order: store.order(gid) ?? base.order } : null;
      if (d) {
        items.push(d);
      }
    }
    if (items.length > 0) pushDisplay({ kind: 'conversations', full: false, items, removed_gids: [] });
  };
  const scheduleUnread = (gids: readonly string[]): void => {
    for (const g of gids) pendingUnread.add(g);
    if (unreadTimer === null) unreadTimer = deps.setTimeout(() => void flushUnread(), opts.unreadDebounceMs ?? 300);
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
      const base = toDisplayConversation(raw as ConversationListItem, full, unread);
      // Store identity is the final row of this batch. Never give an earlier
      // raw customer's display fields the final row's identity signature.
      if (!base || store.row(base.gid) !== raw || projected.has(base.gid)) continue;
      projected.add(base.gid);
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
          removed.push(g);
        }
      }
    }
    if (items.length > 0 || complete) pushDisplay({ kind: 'conversations', full: complete, items, removed_gids: removed });
    // List groupTitle is the product title. The customer's display nick comes from the member API.
    for (const gid of gids) {
      const expectedUid = store.view(gid)?.customerUid;
      void roles.ensure(deps, soa, gid).then(() => {
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

  // ---- realtime / compensation messages → display
  const pushMessages = (items: readonly UiMessage[]): void => {
    const byGid = new Map<string, UiMessage[]>();
    for (const m of items) {
      const list = byGid.get(m.gid) ?? [];
      list.push(m);
      byGid.set(m.gid, list);
    }
    const convs: DisplayConversation[] = [];
    for (const [gid, list] of byGid) {
      list.sort(byCreateTime);
      pushDisplay({ kind: 'messages', gid, replace: false, items: list });
      const last = list[list.length - 1];
      const d = displays.get(gid);
      const row = store.row(gid);
      const order = store.order(gid) ?? (row ? toDisplayConversation(row, false, unread)?.order : null) ?? null;
      const verifiedTarget = store.messageContext(gid) === 1 || last?.message_id === store.latestMessage(gid)?.msgId;
      const newerPreview = last && verifiedTarget && (d?.last_message_time_ms ?? 0) <= last.create_time_ms;
      if (last && d && (newerPreview || JSON.stringify(d.order) !== JSON.stringify(order))) {
        const next = { ...d, order, ...(newerPreview ? { preview: previewOfUi(last), last_message_time_ms: last.create_time_ms } : {}), is_full_snapshot: false };
        convs.push(next);
      }
    }
    if (convs.length > 0) pushDisplay({ kind: 'conversations', full: false, items: convs, removed_gids: [] });
  };

  const onSdkMessage = (evt: SdkMessageEvent): void => {
    diagnostics.session.received = receiveCount(diagnostics.session.received);
    const generation = runGeneration;
    const ui = sdkMessageToUi(evt, roles);
    if (!ui) { diagnostics.session.ui_dropped = receiveCount(diagnostics.session.ui_dropped); return; }
    diagnostics.session.ui_mapped = receiveCount(diagnostics.session.ui_mapped);
    rememberPending(ui, roomJidFromMessage(ui.gid, { fromJid: evt.from, toJid: evt.to }), evt.threadid);
    const order = orderSummaryFromMessage({ msgtype: evt.msgtype, messageBody: evt.body });
    if (order) store.noteOrder(ui.gid, order, ui.create_time_ms);
    pushMessages([ui]);
    const messageContext = store.messageContext(ui.gid);
    if (store.has(ui.gid)) void roles.ensure(deps, soa, ui.gid).then(() => {
      if (!running || generation !== runGeneration || store.messageContext(ui.gid) !== messageContext) return;
      const enriched = sdkMessageToUi(evt, roles);
      if (enriched?.sender_id) pushDisplay({ kind: 'message_profiles', gid: enriched.gid, items: [{
        message_id: enriched.message_id, local_id: enriched.local_id,
        sender_id: enriched.sender_id, sender_name: enriched.sender_name ?? null,
        sender_avatar: enriched.sender_avatar ?? null,
      }] });
    }).catch(() => undefined);
  };

  const onCompensation = (outcome: SoaOutcome<RecentMessagesResponse>): void => {
    if (outcome.kind === 'auth_invalid') presence.invalidate();
    diagnostics.compensation.last_outcome_ms = deps.now();
    diagnostics.compensation.outcomes[outcome.kind] = receiveCount(diagnostics.compensation.outcomes[outcome.kind]);
    if (outcome.kind !== 'success' || !Array.isArray(outcome.body.messages)) return;
    diagnostics.compensation.rows = receiveCount(diagnostics.compensation.rows, outcome.body.messages.length);
    const items: UiMessage[] = [];
    for (const m of outcome.body.messages as HttpMessageObject[]) {
      if (typeof m !== 'object' || m === null) { diagnostics.compensation.dropped = receiveCount(diagnostics.compensation.dropped); continue; }
      const ui = httpMessageToUi(m, roles);
      if (!ui) { diagnostics.compensation.dropped = receiveCount(diagnostics.compensation.dropped); continue; }
      diagnostics.compensation.mapped = receiveCount(diagnostics.compensation.mapped);
      rememberPending(ui, roomJidFromMessage(ui.gid, m), recordOrNull(m)?.['threadId'] ?? recordOrNull(m)?.['threadid']);
      const order = orderSummaryFromMessage(m);
      if (order) store.noteOrder(ui.gid, order, ui.create_time_ms);
      const jid = roomJidFromMessage(ui.gid, m);
      if (jid && roomJidFromMessage(ui.gid, store.view(ui.gid)?.lastMessage ?? null) === jid) opts.sdk.rememberPartnerJid(ui.gid, jid);
      items.push(ui);
    }
    if (items.length > 0) pushMessages(items);
  };

  const onSocket = (status: SdkSocketStatus): void => {
    const state: TransportState = typeof status === 'string' && TRANSPORT_STATES.has(status) ? status : 'disconnected';
    pushDisplay({ kind: 'transport', state });
    if (state !== 'connected') presence.invalidate();
  };

  const variants = opts.variants ?? ['plain'];
  const adapter: Adapter = createAdapter(deps, {
    account: opts.account,
    initialBeginMsgTime: opts.beginMsgTime,
    initialEpoch: opts.initialEpoch,
    conversationListVariants: variants,
    // A hidden account is long-lived; keep the read-only recovery path active.
    stopNormalLoopAfterLimit: false,
    roles,
    unread,
    onConversationListOutcome: onListOutcome,
    onConversationListRequest: () => presence.captureRead(),
    onCompensationOutcome: onCompensation,
  });

  const pushFact = (fact: AdapterFact): void => {
    adapter.bridge.push(fact);
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
    receiveDiagnostics: () => ({ version: 1, captured_at_ms: deps.now(), running, run_generation: runGeneration, sdk: opts.sdk.receiveDiagnostics ?? null,
      session: { ...diagnostics.session }, compensation: { ...diagnostics.compensation, outcomes: { ...diagnostics.compensation.outcomes }, running: adapter.compensation.running, mode: adapter.compensation.mode, cursor_ms: adapter.compensation.cursor } }),
    captureWriteGuard: () => {
      const generation = runGeneration;
      return () => running && generation === runGeneration;
    },
    ...(opts.sendAckTimeoutMs !== undefined ? { sendAckTimeoutMs: opts.sendAckTimeoutMs } : {}),
    ...(opts.orderGidWaitMs !== undefined ? { orderGidWaitMs: opts.orderGidWaitMs } : {}),
  });

  let unsubs: (() => void)[] = [];

  return {
    adapter,
    rpc,
    store,
    roles,
    unread,
    start() {
      if (running) return;
      runGeneration++;
      running = true;
      presence.start();
      const generation = runGeneration;
      unsubs = [opts.sdk.on('message', evt => { if (running && generation === runGeneration) onSdkMessage(evt); }), opts.sdk.on('socket_status', status => { if (running && generation === runGeneration) onSocket(status); })];
      pushDisplay({ kind: 'transport', state: opts.sdk.getSocketStatus() ? 'connected' : 'disconnected' });
      adapter.start();
      log(`adapter started (epoch ${adapter.bridge.epoch})`);
    },
    stop() {
      if (!running) return;
      runGeneration++;
      running = false;
      presence.stop();
      for (const u of unsubs) u();
      unsubs = [];
      if (unreadTimer !== null) deps.clearTimeout(unreadTimer);
      unreadTimer = null;
      pendingUnread.clear();
      pendingPreviews.clear();
      adapter.stop();
    },
  };
}
