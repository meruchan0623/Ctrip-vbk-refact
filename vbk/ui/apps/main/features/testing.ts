/** Test doubles for the feature runtime (imported only by `*.test.ts`). */

import type { AccountContext } from '../../../packages/ipc/src/contracts.ts';
import type { UiMessage } from '../../../packages/ipc/src/client.ts';
import type { ConfirmRequest, DraftView, FeatureScope, TimerHandle } from './context.ts';
import type { RuntimeHost } from './runtime.ts';

export const ACCOUNT: AccountContext = { account_id: 'acct-1', environment: 'production', session_generation: 1 };
export const GID = '1234567890123456789';
export const MSG_ID = '9876543210987654321';

export interface TestHost extends RuntimeHost {
  now: number;
  server: number | null;
  active: FeatureScope | null;
  isVisible: boolean;
  draftView: DraftView;
  messagesByGid: Map<string, readonly UiMessage[]>;
  invokes: { command: string; payload: Record<string, unknown> }[];
  invokeReply: (command: string, payload: Record<string, unknown>) => Promise<unknown>;
  confirmAnswer: boolean;
  confirms: ConfirmRequest[];
  toasts: string[];
  renders: number;
  listeners: Set<() => void>;
  timers: { handle: number; at: number; cb: () => void }[];
  /** Fires the store listeners (a "store changed" tick). */
  changed(): void;
  /** Advance the fake clock and fire due timers. */
  advance(ms: number): Promise<void>;
}

export function makeHost(): TestHost {
  let nextHandle = 1;
  const host: TestHost = {
    now: 1_700_000_000_000,
    server: 1_700_000_000_000,
    active: { account: ACCOUNT, gid: GID },
    isVisible: true,
    draftView: { gid: GID, text: '', version: 0 },
    messagesByGid: new Map(),
    invokes: [],
    invokeReply: () => Promise.resolve(null),
    confirmAnswer: true,
    confirms: [],
    toasts: [],
    renders: 0,
    listeners: new Set(),
    timers: [],
    t: () => null,
    nowMs: () => host.now,
    serverNowMs: () => host.server,
    scope: () => host.active,
    isCurrent: (a) => !!host.active && host.active.account.account_id === a.account_id && host.active.account.environment === a.environment && host.active.account.session_generation === a.session_generation,
    messages: (gid) => host.messagesByGid.get(gid) ?? [],
    draft: () => host.draftView,
    invoke: (command, payload) => {
      host.invokes.push({ command, payload });
      return host.invokeReply(command, payload);
    },
    confirm: (req) => {
      host.confirms.push(req);
      return Promise.resolve(host.confirmAnswer);
    },
    toast: (text) => {
      host.toasts.push(text);
    },
    requestRender: () => {
      host.renders++;
    },
    subscribe: (l) => {
      host.listeners.add(l);
      return () => host.listeners.delete(l);
    },
    visible: () => host.isVisible,
    setTimeout: (cb, ms): TimerHandle => {
      const handle = nextHandle++;
      host.timers.push({ handle, at: host.now + ms, cb });
      return handle;
    },
    clearTimeout: (h) => {
      host.timers = host.timers.filter((t) => t.handle !== h);
    },
    changed() {
      for (const l of [...host.listeners]) l();
    },
    async advance(ms) {
      const target = host.now + ms;
      for (;;) {
        const due = host.timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        host.timers = host.timers.filter((t) => t.handle !== due.handle);
        host.now = Math.max(host.now, due.at);
        if (host.server !== null) host.server = host.now;
        due.cb();
        for (let i = 0; i < 20; i++) await Promise.resolve();
      }
      host.now = target;
      if (host.server !== null) host.server = target;
      for (let i = 0; i < 20; i++) await Promise.resolve();
    },
  };
  return host;
}

export function ownMessage(extra: Partial<UiMessage> = {}): UiMessage {
  return {
    gid: GID,
    message_id: MSG_ID,
    local_id: null,
    create_time_ms: 1_700_000_000_000 - 10_000,
    sender_role: 'merchant_self',
    kind: 'text',
    text: 'hello',
    translation: null,
    original: null,
    quote: null,
    order_id: null,
    disposition: null,
    ...extra,
  };
}

export async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
