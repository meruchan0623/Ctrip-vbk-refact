/**
 * web-adapter: bounded fact adapter between the official vbooking web IM
 * page (SDK + HTTP contracts observed 2026-10-30) and the Rust core.
 *
 * `createAdapter(deps, options)` composes: SDK realtime listener,
 * conversation-list poller(s), compensation loop and the bridge. `start()`
 * subscribes to the SDK first, then starts the pollers; `stop()` tears
 * everything down; a restart bumps the epoch so the host re-handshakes.
 */

export * from './deps.ts';
export * from './heads.ts';
export * from './soa.ts';
export * from './endpoints.ts';
export * from './md5.ts';
export * from './facts.ts';
export * from './conversationList.ts';
export * from './compensation.ts';
export * from './history.ts';
export * from './send.ts';
export * from './markRead.ts';
export * from './worksheetStar.ts';
export * from './pinned.ts';
export * from './order.ts';
export * from './upload.ts';
export * from './translation.ts';
export * from './settings.ts';
export * from './bridge.ts';

import type { AccountContext, TransportState } from '../../ipc/src/contracts.ts';
import type { AdapterDeps, SdkSocketStatus } from './deps.ts';
import { AdapterBridge } from './bridge.ts';
import { SoaClient, type ServerTimeSample } from './soa.ts';
import { createConversationListPoller, type ConversationListPoller, type ConversationListVariant, type UnreadLookup } from './conversationList.ts';
import { createCompensationLoop, type CompensationLoop } from './compensation.ts';
import { CursorAllocator, UNKNOWN_ROLES, normalizeSdkMessage, type MemberRoles, type MsgTypeOverrides } from './facts.ts';

export interface AdapterOptions {
  readonly account: AccountContext;
  /** Persisted compensation watermark (`beginMsgTime`). */
  readonly initialBeginMsgTime: number;
  /** Conversation list variants to poll; the vbooking entry uses `plain`, imvendor `json`. */
  readonly conversationListVariants?: readonly ConversationListVariant[];
  readonly includeLocaleInConversationList?: boolean;
  readonly roles?: MemberRoles;
  readonly unread?: UnreadLookup;
  readonly msgTypeOverrides?: MsgTypeOverrides;
  readonly stopNormalLoopAfterLimit?: boolean;
  readonly onServerTime?: (sample: ServerTimeSample) => void;
  readonly initialEpoch?: number;
}

export interface Adapter {
  readonly bridge: AdapterBridge;
  readonly soa: SoaClient;
  readonly compensation: CompensationLoop;
  readonly conversationPollers: readonly ConversationListPoller[];
  start(): void;
  stop(): void;
  /** Replace the role snapshot (after checkMemberStatus / getConversationInfoByGidList). */
  setRoles(roles: MemberRoles): void;
  readonly running: boolean;
}

function toTransport(status: SdkSocketStatus): TransportState {
  return status;
}

export function createAdapter(deps: AdapterDeps, opts: AdapterOptions): Adapter {
  const cursors = new CursorAllocator(opts.initialEpoch ?? 1);
  const bridge = new AdapterBridge({ account: opts.account, invoke: deps.invoke, cursors });
  const soa = new SoaClient(deps, opts.onServerTime ? { onServerTime: opts.onServerTime } : {});
  let roles: MemberRoles = opts.roles ?? UNKNOWN_ROLES;
  const rolesProxy: MemberRoles = { roleOf: (uid) => roles.roleOf(uid) };

  const compensation = createCompensationLoop(deps, soa, {
    emit: bridge.emit,
    roles: rolesProxy,
    initialBeginMsgTime: opts.initialBeginMsgTime,
    ...(opts.stopNormalLoopAfterLimit !== undefined ? { stopNormalLoopAfterLimit: opts.stopNormalLoopAfterLimit } : {}),
    ...(opts.msgTypeOverrides ? { msgTypeOverrides: opts.msgTypeOverrides } : {}),
  });
  const conversationPollers = (opts.conversationListVariants ?? ['plain']).map((variant) =>
    createConversationListPoller(deps, soa, {
      variant,
      emit: bridge.emit,
      includeLocale: opts.includeLocaleInConversationList ?? false,
      ...(opts.unread ? { unread: opts.unread } : {}),
    }),
  );

  let running = false;
  let started = false;
  let unsubscribes: (() => void)[] = [];

  return {
    bridge,
    soa,
    compensation,
    conversationPollers,
    get running() {
      return running;
    },
    setRoles(next) {
      roles = next;
    },
    start() {
      if (running) return;
      running = true;
      if (started) bridge.bumpEpoch();
      started = true;
      // subscribe before any snapshot so nothing is missed between the two
      unsubscribes = [
        deps.sdk.on('message', (evt) => {
          const fact = normalizeSdkMessage(evt, { roles: rolesProxy, ...(opts.msgTypeOverrides ? { msgTypeOverrides: opts.msgTypeOverrides } : {}) });
          if (fact) bridge.push({ kind: 'message', fact });
        }),
        deps.sdk.on('socket_status', (status) => {
          const state = toTransport(status);
          bridge.push({ kind: 'transport', state });
          compensation.setTransport(state);
        }),
      ];
      const initial: TransportState = deps.sdk.getSocketStatus() ? 'connected' : 'disconnected';
      bridge.push({ kind: 'transport', state: initial });
      compensation.start(initial);
      for (const p of conversationPollers) p.start();
    },
    stop() {
      if (!running) return;
      running = false;
      for (const u of unsubscribes) u();
      unsubscribes = [];
      compensation.stop();
      for (const p of conversationPollers) p.stop();
    },
  };
}
