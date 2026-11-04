import type { AccountContext } from '../../packages/ipc/src/contracts.ts';
import type { UiMessage } from '../../packages/ipc/src/client.ts';
import type { MessageReadStatusPatch } from '../../packages/ipc/src/adapterProtocol.ts';

export interface MessageReadStatusEvent { account: AccountContext; gid: string; items: readonly MessageReadStatusPatch[] }
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const identity = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value.length <= 512;

/** Receipt-only events must reach loaded history even after host cache eviction. */
export function readMessageReadStatusEvent(payload: unknown, account: AccountContext | null): MessageReadStatusEvent | null {
  const event = object(payload), owner = object(event?.['account']);
  if (!account || !event || !owner || owner['account_id'] !== account.account_id || owner['environment'] !== account.environment || owner['session_generation'] !== account.session_generation
    || !identity(event['gid']) || !Array.isArray(event['items']) || event['items'].length > 2000) return null;
  for (const item of event['items']) {
    const p = object(item);
    if (!p || !identity(p['message_id']) || !identity(p['sender_id']) || (p['read_status'] !== 'read' && p['read_status'] !== 'unread')) return null;
  }
  return event as unknown as MessageReadStatusEvent;
}

export function applyMessageReadStatuses(messages: readonly UiMessage[], event: MessageReadStatusEvent): readonly UiMessage[] {
  const patches = new Map<string, 'read' | 'unread'>();
  const key = (id: string, sender: string) => JSON.stringify([id, sender.trim().toLowerCase()]);
  for (const p of event.items) {
    const k = key(p.message_id, p.sender_id);
    if (patches.get(k) !== 'read') patches.set(k, p.read_status);
  }
  let changed = false;
  const next = messages.map(m => {
    if (m.gid !== event.gid || !m.message_id || !m.sender_id?.trim() || m.read_status === 'read') return m;
    const status = patches.get(key(m.message_id, m.sender_id));
    if (!status || m.read_status === status) return m;
    changed = true;
    return { ...m, read_status: status };
  });
  return changed ? next : messages;
}
