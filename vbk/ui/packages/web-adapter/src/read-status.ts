import type { AdapterDisplayPayload, MessageReadStatusPatch } from '../../ipc/src/adapterProtocol.ts';
import type { UiMessage } from '../../ipc/src/client.ts';
import type { AdapterDeps, SdkMessageEvent } from './deps.ts';
import { httpMessageToUi } from './display.ts';
import { jidLocal, normalizeTimeMs } from './facts.ts';
import { messageListBody } from './history.ts';
import { Endpoints } from './endpoints.ts';
import { SoaClient } from './soa.ts';
import { roomJidFromMessage, type ConversationStore, type RoleBook } from './stores.ts';

/** 1023 is OtherHasRead in the official desktop enum. It is a notification,
 * not a documented message cursor: ask the server which exact rows are read.
 * Never infer a frontier from notification time, notify_ack, or send_result. */
export function createReadStatusSync(options: {
  deps: AdapterDeps; soa: SoaClient; store: ConversationStore; roles: RoleBook;
  context(gid: string): string | null;
  captureCurrent(): () => boolean;
  publish(payload: AdapterDisplayPayload): Promise<boolean>;
}) {
  type TrackedMessage = Pick<UiMessage, 'gid' | 'message_id' | 'sender_id' | 'sender_role' | 'create_time_ms' | 'read_status'>;
  type Thread = { context: string; rows: Map<string, TrackedMessage> };
  const threads = new Map<string, Thread>();
  type Direction = 'incoming' | 'outgoing';
  const flights = new Map<string, { pending: Set<Direction> }>();
  const queued = new Map<string, Set<Direction>>();
  function observe(payload: AdapterDisplayPayload): void {
    if (payload.kind !== 'messages') return;
    const context = options.context(payload.gid);
    if (!context) return;
    let thread = threads.get(payload.gid);
    if (!thread || thread.context !== context) {
      thread = { context, rows: new Map() };
      threads.delete(payload.gid); threads.set(payload.gid, thread);
    }
    for (const m of payload.items) {
      if (!m.message_id || m.gid !== payload.gid || !m.sender_id?.trim()) continue;
      const old = thread.rows.get(m.message_id);
      // Keep only identity/status metadata for the UI's loaded history, never
      // message bodies. Host cache eviction must not forget visible old rows.
      thread.rows.set(m.message_id, { gid: m.gid, message_id: m.message_id, sender_id: m.sender_id, sender_role: m.sender_role, create_time_ms: m.create_time_ms,
        ...(old?.sender_id === m.sender_id && old.read_status === 'read' ? { read_status: 'read' } : m.read_status ? { read_status: m.read_status } : {}),
      });
    }
  }
  async function publish(gid: string, items: MessageReadStatusPatch[]): Promise<void> {
    if (!items.length) return;
    if (await options.publish({ kind: 'message_read_statuses', gid, items })) {
      const thread = threads.get(gid);
      for (const item of items) {
        const m = thread?.rows.get(item.message_id);
        if (m && m.sender_id?.trim().toLowerCase() === item.sender_id.trim().toLowerCase()) thread!.rows.set(item.message_id, { ...m, read_status: m.read_status === 'read' ? 'read' : item.read_status });
      }
    }
  }
  async function refresh(gid: string, incoming = false): Promise<void> {
    const context = options.context(gid), current = options.captureCurrent();
    const view = options.store.view(gid), thread = threads.get(gid);
    if (!context || !view?.conversationType || !thread || thread.context !== context) return;
    const pending = [...thread.rows.values()].filter(m => (incoming ? m.sender_role === 'customer' : m.sender_role === 'merchant_self' || m.sender_role === 'merchant_other') && m.read_status !== 'read');
    if (!pending.length) return;
    const remaining = new Map(pending.map(m => [m.message_id!, m.create_time_ms]));
    const valid = () => current() && context === options.context(gid) && threads.get(gid) === thread;
    // Refresh the loaded windows, including isolated old history. Cache size
    // does not imply these rows are among the server's newest messages. Each
    // iteration consumes at least its anchor, bounding reads by cached targets.
    for (let page = 0; page < pending.length && remaining.size && valid(); page++) {
      const anchor = Math.max(...remaining.values());
      const before = anchor + 1;
      const body = messageListBody(options.deps, { gid, conversationType: view.conversationType, pageSize: 30,
        cursor: { direction: 'prev' as const, endTime: before } });
      if (!body) return;
      const result = await options.soa.post<{ rangeMessage?: { messages?: unknown; isDone?: unknown; lastMessageTime?: unknown } }>(Endpoints.MESSAGE_LIST, body);
      if (!valid() || result.kind !== 'success') return;
      const range = result.body.rangeMessage;
      if (!Array.isArray(range?.messages)) return;
      const patches: MessageReadStatusPatch[] = [];
      for (const raw of range.messages) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
        const message = httpMessageToUi(raw, options.roles);
        const target = message?.message_id ? thread.rows.get(message.message_id) : null;
        if (!message || message.gid !== gid || !target || message.sender_id?.trim().toLowerCase() !== target.sender_id?.trim().toLowerCase()
          || (incoming ? message.sender_role !== 'customer' : message.sender_role !== 'merchant_self' && message.sender_role !== 'merchant_other')) continue;
        const flag = incoming ? raw.isread : raw.isTargetRead;
        if (typeof flag !== 'boolean') continue;
        remaining.delete(message.message_id!);
        patches.push({ message_id: message.message_id!, sender_id: message.sender_id!, read_status: flag ? 'read' : 'unread' });
      }
      await publish(gid, patches);
      if (!valid()) return;
      // Missing/deleted rows and tied timestamps cannot cause an infinite
      // retry. They keep their previous status; only exact server flags patch.
      const times = range.messages.map(raw => normalizeTimeMs(raw?.createTime)).filter((time): time is number => time !== null && time < before);
      const floor = times.length ? Math.min(...times) : anchor;
      for (const [id, time] of remaining) if (time >= floor) remaining.delete(id);
    }
  }
  function receive(event: SdkMessageEvent): boolean {
    if (event.msgtype !== 1023 && event.msgtype !== '1023') return false;
    // Match the official decoder's room portion of fromJid. Only an already
    // known room may cause an HTTP read; no payload-supplied cursor is trusted.
    if ((event.type !== 'groupchat' && event.type !== 'chat') || typeof event.from !== 'string') return true;
    const room = event.from.split('/')[0]!, gid = jidLocal(room);
    const expectedRoom = roomJidFromMessage(gid, options.store.view(gid)?.lastMessage ?? null);
    if (!expectedRoom || room !== expectedRoom) return true;
    enqueue(gid, 'outgoing');
    return true;
  }
  function enqueue(gid: string, direction: Direction): void {
    const active = flights.get(gid);
    if (active) { active.pending.add(direction); return; }
    const pending = queued.get(gid) ?? new Set<Direction>();
    pending.add(direction); queued.set(gid, pending);
    drain();
  }
  function drain(): void {
    while (flights.size < 2 && queued.size) {
      const [gid, pending] = queued.entries().next().value!; queued.delete(gid);
      const flight = { pending };
      flights.set(gid, flight);
      void (async () => {
        // Both directions share one per-room flight and the global read limit.
        // Notifications arriving during an await retain one further refresh.
        while (flight.pending.size && flights.get(gid) === flight) {
          const direction = flight.pending.values().next().value!;
          flight.pending.delete(direction);
          await refresh(gid, direction === 'incoming');
        }
      })().catch(() => undefined).finally(() => { if (flights.get(gid) === flight) { flights.delete(gid); drain(); } });
    }
  }
  async function acknowledged(gid: string, id: string): Promise<void> {
    const context = options.context(gid), current = options.captureCurrent();
    const m = threads.get(gid)?.rows.get(id);
    if (m?.sender_role !== 'customer' || !m.sender_id) return;
    await publish(gid, [{ message_id: id, sender_id: m.sender_id, read_status: 'read' }]);
    // The receipt is cursor-like, but old mixed-service history cannot be
    // marked by timestamp alone. Refresh other loaded customer rows using
    // server isread flags, without blocking the acknowledgment response.
    if (current() && context === options.context(gid)) enqueue(gid, 'incoming');
  }
  return { observe, receive, acknowledged, reset() { threads.clear(); flights.clear(); queued.clear(); } };
}
