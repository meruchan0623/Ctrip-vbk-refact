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
import type { AgentStatus, UiMessage } from '../../ipc/src/client.ts';
import type { AdapterDisplayPayload, DisplayConversation } from '../../ipc/src/adapterProtocol.ts';
import type { AdapterDeps, SdkMessageEvent, SdkSocketStatus } from './deps.ts';
import { createAdapter, type Adapter } from './index.ts';
import { SoaClient, type SoaOutcome } from './soa.ts';
import { toConversationFact, type ConversationListItem, type ConversationListResponse, type ConversationListVariant } from './conversationList.ts';
import type { RecentMessagesResponse } from './compensation.ts';
import type { HttpMessageObject } from './facts.ts';
import { agentStatusOf, byCreateTime, httpMessageToUi, previewOfUi, sdkMessageToUi, toDisplayConversation } from './display.ts';
import { ConversationStore, RoleBook, UnreadBook, roomJidFromMessage } from './stores.ts';
import { createRpc, type AgentStatusBox, type Rpc } from './rpc.ts';
import type { IdentityProfile } from './identity.ts';
import type { PageSdk } from './sdkGlue.ts';

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
  const log = opts.log ?? (() => undefined);
  let agent: { status: AgentStatus; confirmed: boolean } | null = null;

  const pushDisplay = (payload: AdapterDisplayPayload): void => {
    // Every conversation projection (including history enrichment) shares the
    // authoritative unread book. Reading history cannot acknowledge messages.
    const current = payload.kind === 'conversations'
      ? { ...payload, items: payload.items.map((item) => ({ ...item, unread_count: unread.unreadOf(item.gid) ?? item.unread_count })) }
      : payload;
    try {
      opts.pushDisplay(current).catch(() => log(`display push failed (${payload.kind})`));
    } catch {
      log(`display push failed (${payload.kind})`);
    }
  };

  const agentBox: AgentStatusBox = {
    current: () => agent,
    set(status, confirmed) {
      const changed = !agent || agent.status !== status || agent.confirmed !== confirmed;
      agent = { status, confirmed };
      if (changed) pushDisplay({ kind: 'agent_status', status, confirmed });
    },
  };

  // ---- unread refresh (debounced, batched)
  const pendingUnread = new Set<string>();
  let unreadTimer: unknown = null;
  let running = false;
  const flushUnread = async (): Promise<void> => {
    unreadTimer = null;
    const gids = [...pendingUnread];
    pendingUnread.clear();
    if (gids.length === 0 || !running) return;
    const changed = await unread.refresh(deps, soa, gids, (gid, msg) => {
      store.noteMessage(gid, msg.msgId, msg.createTime);
      const jid = roomJidFromMessage(gid, msg);
      if (jid) opts.sdk.rememberPartnerJid(gid, jid);
    });
    if (!running) return;
    const items: DisplayConversation[] = [];
    for (const gid of changed) {
      const row = store.row(gid);
      if (!row) continue;
      const fact = toConversationFact(row, false, unread);
      if (fact) adapter.bridge.push({ kind: 'conversation', fact });
      const d = toDisplayConversation(row, false, unread);
      if (d) {
        displays.set(gid, d);
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
  const onListOutcome = (outcome: SoaOutcome<ConversationListResponse>, variant: ConversationListVariant): void => {
    // called by the poller before it advances its cursor: a null cursor means this response is a full snapshot
    const poller = adapter.conversationPollers[(opts.variants ?? ['plain']).indexOf(variant)];
    const full = (poller?.cursor ?? null) === null;
    if (outcome.kind !== 'success') return;
    const status = agentStatusOf(outcome.body.currentStatus);
    if (status !== null) agentBox.set(status, true);
    const rows = Array.isArray(outcome.body.conversationList) ? (outcome.body.conversationList as unknown[]) : [];
    const complete = full && outcome.body.haveRest !== true;
    const gids = store.update(rows);
    const items: DisplayConversation[] = [];
    for (const raw of rows) {
      const d = toDisplayConversation(raw as ConversationListItem, full, unread);
      if (!d) continue;
      const prev = displays.get(d.gid);
      // a realtime preview newer than the row stays until the list catches up
      const merged = prev && prev.last_message_time_ms !== null && (d.last_message_time_ms ?? 0) < prev.last_message_time_ms ? { ...d, preview: prev.preview, last_message_time_ms: prev.last_message_time_ms } : d;
      displays.set(d.gid, merged);
      items.push(merged);
      roles.addCustomer(store.view(d.gid)?.customerUid ?? null);
    }
    const removed: string[] = [];
    if (complete) {
      const keep = new Set(gids);
      for (const g of [...displays.keys()]) {
        if (!keep.has(g)) {
          displays.delete(g);
          removed.push(g);
        }
      }
    }
    if (items.length > 0 || complete) pushDisplay({ kind: 'conversations', full: complete, items, removed_gids: removed });
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
      if (last && d && (d.last_message_time_ms ?? 0) <= last.create_time_ms) {
        const preview = previewOfUi(last);
        const next = { ...d, preview, last_message_time_ms: last.create_time_ms, is_full_snapshot: false };
        displays.set(gid, next);
        convs.push(next);
      }
    }
    if (convs.length > 0) pushDisplay({ kind: 'conversations', full: false, items: convs, removed_gids: [] });
  };

  const onSdkMessage = (evt: SdkMessageEvent): void => {
    const ui = sdkMessageToUi(evt, roles);
    if (!ui) return;
    if (ui.message_id) store.noteMessage(ui.gid, ui.message_id, ui.create_time_ms);
    pushMessages([ui]);
    if (store.has(ui.gid)) void roles.ensure(deps, soa, ui.gid).catch(() => undefined);
  };

  const onCompensation = (outcome: SoaOutcome<RecentMessagesResponse>): void => {
    if (outcome.kind !== 'success' || !Array.isArray(outcome.body.messages)) return;
    const items: UiMessage[] = [];
    for (const m of outcome.body.messages as HttpMessageObject[]) {
      if (typeof m !== 'object' || m === null) continue;
      const ui = httpMessageToUi(m, roles);
      if (!ui) continue;
      store.noteMessage(ui.gid, m.msgId, m.createTime);
      const jid = roomJidFromMessage(ui.gid, m);
      if (jid) opts.sdk.rememberPartnerJid(ui.gid, jid);
      items.push(ui);
    }
    if (items.length > 0) pushMessages(items);
  };

  const onSocket = (status: SdkSocketStatus): void => {
    const state: TransportState = typeof status === 'string' && TRANSPORT_STATES.has(status) ? status : 'disconnected';
    pushDisplay({ kind: 'transport', state });
  };

  const variants = opts.variants ?? ['plain'];
  const adapter: Adapter = createAdapter(deps, {
    account: opts.account,
    initialBeginMsgTime: opts.beginMsgTime,
    initialEpoch: opts.initialEpoch,
    conversationListVariants: variants,
    roles,
    unread,
    onConversationListOutcome: onListOutcome,
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
      running = true;
      unsubs = [opts.sdk.on('message', onSdkMessage), opts.sdk.on('socket_status', onSocket)];
      pushDisplay({ kind: 'transport', state: opts.sdk.getSocketStatus() ? 'connected' : 'disconnected' });
      adapter.start();
      log(`adapter started (epoch ${adapter.bridge.epoch})`);
    },
    stop() {
      if (!running) return;
      running = false;
      for (const u of unsubs) u();
      unsubs = [];
      if (unreadTimer !== null) deps.clearTimeout(unreadTimer);
      unreadTimer = null;
      pendingUnread.clear();
      adapter.stop();
    },
  };
}
