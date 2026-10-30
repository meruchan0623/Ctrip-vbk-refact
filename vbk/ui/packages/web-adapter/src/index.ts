/**
 * web-adapter: bounded fact adapter between the official vbooking web IM
 * page (SDK + HTTP contracts observed 2026-10-30) and the Rust core.
 *
 * `createAdapter(deps, options)` composes: SDK realtime listener,
 * conversation-list poller(s), compensation loop and the bridge. `start()`
 * subscribes to the SDK first, then starts the pollers; `stop()` tears
 * everything down; a restart bumps the epoch so the host re-handshakes.
 *
 * `auth_invalid` is reported by whichever loop sees it first: the adapter
 * stops every loop and pushes the fact once per run (a restart after
 * re-login reports again). The SDK listeners stay attached so transport
 * facts keep flowing; the host decides when to `stop()`/`start()`.
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
export * from './display.ts';
export * from './identity.ts';
export * from './pageContext.ts';
export * from './sdkGlue.ts';
export * from './stores.ts';
export * from './notice.ts';
export * from './rpc.ts';

import type { AccountContext, AdapterFact, TransportState } from '../../ipc/src/contracts.ts';
import type { AdapterDeps, SdkSocketStatus } from './deps.ts';
import { AdapterBridge } from './bridge.ts';
import { SoaClient, type ServerTimeSample } from './soa.ts';
import {
  createConversationListPoller,
  type ConversationListItem,
  type ConversationListPoller,
  type ConversationListResponse,
  type ConversationListVariant,
  type UnreadLookup,
} from './conversationList.ts';
import { createCompensationLoop, type CompensationLoop, type RecentMessagesResponse } from './compensation.ts';
import type { SoaOutcome } from './soa.ts';
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
  /** Raw conversation rows per poll (display cache, sessionId/worksheetId lookups). Never logged. */
  readonly onConversationRows?: (rows: readonly ConversationListItem[], full: boolean, variant: ConversationListVariant) => void;
  /** Every classified conversation-list outcome (e.g. `currentStatus` read-back, `haveRest`). */
  readonly onConversationListOutcome?: (outcome: SoaOutcome<ConversationListResponse>, variant: ConversationListVariant) => void;
  /** Every classified `getRecentMessages` outcome (display bodies of compensated messages). */
  readonly onCompensationOutcome?: (outcome: SoaOutcome<RecentMessagesResponse>) => void;
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

const TRANSPORT_STATES: ReadonlySet<string> = new Set<TransportState>(['connecting', 'connected', 'disconnected', 'reconnecting']);

/** The page glue is unverified: anything outside the contract is treated as "not connected", never forwarded verbatim. */
function toTransport(status: SdkSocketStatus): TransportState {
  return typeof status === 'string' && TRANSPORT_STATES.has(status) ? status : 'disconnected';
}

export function createAdapter(deps: AdapterDeps, opts: AdapterOptions): Adapter {
  const cursors = new CursorAllocator(opts.initialEpoch ?? 1);
  const bridge = new AdapterBridge({ account: opts.account, invoke: deps.invoke, cursors });
  const soa = new SoaClient(deps, opts.onServerTime ? { onServerTime: opts.onServerTime } : {});
  let roles: MemberRoles = opts.roles ?? UNKNOWN_ROLES;
  const rolesProxy: MemberRoles = { roleOf: (uid) => roles.roleOf(uid) };

  let authInvalidSeen = false;
  const stopLoops = (): void => {
    compensation.stop();
    for (const p of conversationPollers) p.stop();
  };
  /** Each loop reports auth failure on its own; the host hears it once per run and every loop stops. */
  const emit = (fact: AdapterFact): void => {
    if (fact.kind === 'auth_invalid') {
      if (authInvalidSeen) return;
      authInvalidSeen = true;
      stopLoops();
    }
    bridge.emit(fact);
  };

  const compensation = createCompensationLoop(deps, soa, {
    emit,
    roles: rolesProxy,
    initialBeginMsgTime: opts.initialBeginMsgTime,
    ...(opts.stopNormalLoopAfterLimit !== undefined ? { stopNormalLoopAfterLimit: opts.stopNormalLoopAfterLimit } : {}),
    ...(opts.msgTypeOverrides ? { msgTypeOverrides: opts.msgTypeOverrides } : {}),
    ...(opts.onCompensationOutcome ? { onOutcome: opts.onCompensationOutcome } : {}),
  });
  const conversationPollers = (opts.conversationListVariants ?? ['plain']).map((variant) =>
    createConversationListPoller(deps, soa, {
      variant,
      emit,
      includeLocale: opts.includeLocaleInConversationList ?? false,
      ...(opts.unread ? { unread: opts.unread } : {}),
      ...(opts.onConversationRows ? { onRows: (rows: readonly ConversationListItem[], full: boolean) => opts.onConversationRows?.(rows, full, variant) } : {}),
      ...(opts.onConversationListOutcome ? { onOutcome: (o: SoaOutcome<ConversationListResponse>) => opts.onConversationListOutcome?.(o, variant) } : {}),
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
      authInvalidSeen = false;
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
