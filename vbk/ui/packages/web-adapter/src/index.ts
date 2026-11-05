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
export * from './features.ts';
export { createTypingFeature, TypingThrottle, TypingTracker, parseInboundTyping, sendTypingState, TYPING_THROTTLE_MS, TYPING_VISIBLE_MS } from './typingState.ts';
export { recallFeature, recallMessage, recallWithWindow, recallVerdict, recallBody, RECALL_WINDOW_MS, RECALL_MESSAGE } from './recall.ts';
export { voiceFeature, parseVoiceBody, playableVoiceUrl, VOICE_MSGTYPE } from './voice.ts';
export { queueFeature, isQueueNotice, checkManualAgentStatus, QUEUE_NOTICE_ACTION } from './queueStatus.ts';
export { translateDraft, createDraftTranslator, outboundTranslateBody, GET_MESSAGE_TRANSLATE, OUTBOUND_TRANSLATE_DEBOUNCE_MS, OUTBOUND_TRANSLATE_DEFAULT_MODE } from './outboundTranslate.ts';

/** Adapter feature registration (plan I-30 access rule 2) lives in `adapterFeatures.ts`; see there. */
export { createAdapterFeatures } from './adapterFeatures.ts';

import type { AccountContext, AdapterFact, MessageFact, TransportState } from '../../ipc/src/contracts.ts';
import type { AdapterDeps, SdkSocketStatus } from './deps.ts';
import { AdapterBridge, BridgeQueueError, type BridgeDiagnostics } from './bridge.ts';
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
import type { VisibilityGate } from './conversationList.ts';
import type { OfficialConversationFeed } from './pageContext.ts';
import type { SoaOutcome } from './soa.ts';
import { CursorAllocator, UNKNOWN_ROLES, normalizeSdkMessage, type MemberRoles, type MsgTypeOverrides } from './facts.ts';

export interface AdapterOptions {
  readonly bridgeCapacity?: number;
  /** Overflow stops this adapter; the owner must require fresh login/resync. */
  readonly onQueueFault?: (diagnostics: BridgeDiagnostics, error: BridgeQueueError) => void;
  /** Account terminal: caller cancels session work after auth_invalid is queued. */
  readonly onTerminal?: () => void;
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
  /** Normal-loop stop delay for the compensation loop; `null` = never stop (see `compensation.ts`). */
  readonly normalLoopStopAfterMs?: number | null;
  /** Observed official `getConversationList` loop: while active the pollers only consume its responses (I-06). */
  readonly officialConversationFeed?: OfficialConversationFeed;
  /** `visibilityState` gate for self-run conversation-list requests. */
  readonly conversationVisibility?: VisibilityGate;
  /** Presence-bearing sessions must refresh before their status lease expires, even while hidden. */
  readonly conversationHiddenIntervalMultiplier?: number;
  /** Fired when a poller had to pull one full snapshot itself while the official loop was active. */
  readonly onConversationBootstrap?: () => void;
  readonly onServerTime?: (sample: ServerTimeSample) => void;
  readonly initialEpoch?: number;
  /** Raw conversation rows per poll (display cache, sessionId/worksheetId lookups). Never logged. */
  readonly onConversationRows?: (rows: readonly ConversationListItem[], full: boolean, variant: ConversationListVariant) => void;
  /** Every classified conversation-list outcome (e.g. `currentStatus` read-back, `haveRest`). */
  readonly onConversationListRequest?: () => unknown;
  readonly onConversationListOutcome?: (outcome: SoaOutcome<ConversationListResponse>, variant: ConversationListVariant, ticket?: unknown) => void;
  /** Every classified `getRecentMessages` outcome (display bodies of compensated messages). */
  readonly onCompensationRequest?: () => unknown;
  readonly onCompensationOutcome?: (outcome: SoaOutcome<RecentMessagesResponse>, ticket?: unknown) => void;
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

const UNRESOLVED_RESEND_MS = 30_000;
const MAX_UNRESOLVED = 64;

export function createAdapter(deps: AdapterDeps, opts: AdapterOptions): Adapter {
  const cursors = new CursorAllocator(opts.initialEpoch ?? 1);
  let queueFaulted = false;
  const bridge = new AdapterBridge({ account: opts.account, invoke: deps.invoke, cursors,
    ...(opts.bridgeCapacity !== undefined ? { capacity: opts.bridgeCapacity } : {}),
    onQueueFault: (error, diagnostics) => {
      queueFaulted = true;
      stopAdapter();
      opts.onQueueFault?.(diagnostics, error);
    },
  });
  const soa = new SoaClient(deps, opts.onServerTime ? { onServerTime: opts.onServerTime } : {});
  let roles: MemberRoles = opts.roles ?? UNKNOWN_ROLES;
  const rolesProxy: MemberRoles = { get selfUid() { return roles.selfUid ?? ''; }, roleOf: (uid) => roles.roleOf(uid) };

  // A first message can outrun the conversation list that names its customer.
  // Resend it once roles settle so the host can resolve and notify it.
  let unresolved: { readonly fact: MessageFact; readonly at: number }[] = [];
  const resendResolved = (): void => {
    const now = deps.now();
    const pending = unresolved;
    unresolved = [];
    for (const entry of pending) {
      const sender_role = rolesProxy.roleOf(entry.fact.sender_id);
      if (sender_role !== 'unknown') emit({ kind: 'message', fact: { ...entry.fact, sender_role } });
      else if (now - entry.at < UNRESOLVED_RESEND_MS) unresolved.push(entry);
    }
  };

  let authInvalidSeen = false;
  const stopLoops = (): void => {
    compensation.stop();
    for (const p of conversationPollers) p.stop();
  };
  /** Each loop reports auth failure on its own; the host hears it once per run and every loop stops. */
  const emit = (fact: AdapterFact): void => {
    if (!queueFaulted && fact.kind === 'auth_invalid') {
      if (authInvalidSeen) return;
      authInvalidSeen = true;
      stopLoops();
    }
    try { bridge.emit(fact); }
    catch (error) {
      // Poller emitters are void callbacks inside fire-and-forget async ticks.
      // Overflow has already stopped intake and reported the lifecycle fault;
      // contain that terminal signal instead of creating an unhandled rejection.
      if (queueFaulted && error instanceof BridgeQueueError) return;
      throw error;
    }
  };

  // The core owns one im.conversation snapshot set: whole list batches across
  // variants must stay contiguous, while compensation uses a separate stream.
  let batchOwner: symbol | null = null;
  const batchWaiters = new Map<string, { current: () => boolean; resolve: (release: (() => void) | null) => void }>();
  const grantBatch = (): (() => void) => {
    const owner = Symbol(); batchOwner = owner;
    return () => {
      if (batchOwner !== owner) return;
      batchOwner = null;
      while (batchWaiters.size) {
        const [key, waiter] = batchWaiters.entries().next().value!;
        batchWaiters.delete(key);
        if (!waiter.current()) { waiter.resolve(null); continue; }
        waiter.resolve(grantBatch()); break;
      }
    };
  };
  const acquireBatch = (key: string, current: () => boolean): Promise<(() => void) | null> => {
    if (!current()) return Promise.resolve(null);
    if (batchOwner === null) return Promise.resolve(grantBatch());
    if (batchWaiters.has(key) || batchWaiters.size >= 2) { bridge.overflow(); return Promise.resolve(null); }
    return new Promise(resolve => { batchWaiters.set(key, { current, resolve }); });
  };
  const cancelBatches = (): void => {
    batchOwner = null;
    for (const waiter of batchWaiters.values()) waiter.resolve(null);
    batchWaiters.clear();
  };

  const compensation = createCompensationLoop(deps, soa, {
    emit,
    emitAsync: (fact, current) => bridge.pushAsync(fact, current, 'compensation'),
    awaitDelivery: () => bridge.flush(),
    roles: rolesProxy,
    initialBeginMsgTime: opts.initialBeginMsgTime,
    ...(opts.stopNormalLoopAfterLimit !== undefined ? { stopNormalLoopAfterLimit: opts.stopNormalLoopAfterLimit } : {}),
    ...(opts.normalLoopStopAfterMs !== undefined ? { normalLoopStopAfterMs: opts.normalLoopStopAfterMs } : {}),
    ...(opts.msgTypeOverrides ? { msgTypeOverrides: opts.msgTypeOverrides } : {}),
    ...(opts.onCompensationRequest ? { onRequest: opts.onCompensationRequest } : {}),
    ...(opts.onCompensationOutcome ? { onOutcome: opts.onCompensationOutcome } : {}),
  });
  const conversationPollers = (opts.conversationListVariants ?? ['plain']).map((variant) =>
    createConversationListPoller(deps, soa, {
      variant,
      emit,
      emitAsync: (fact, current) => bridge.pushAsync(fact, current, `list:${variant}`),
      awaitDelivery: () => bridge.flush(),
      onBatchOverflow: () => bridge.overflow(),
      acquireBatch: current => acquireBatch(variant, current),
      includeLocale: opts.includeLocaleInConversationList ?? false,
      ...(opts.officialConversationFeed ? { official: opts.officialConversationFeed } : {}),
      ...(opts.conversationVisibility ? { visibility: opts.conversationVisibility } : {}),
      ...(opts.conversationHiddenIntervalMultiplier !== undefined ? { hiddenIntervalMultiplier: opts.conversationHiddenIntervalMultiplier } : {}),
      ...(opts.onConversationBootstrap ? { onBootstrap: opts.onConversationBootstrap } : {}),
      ...(opts.unread ? { unread: opts.unread } : {}),
      onRows: (rows: readonly ConversationListItem[], full: boolean) => {
        opts.onConversationRows?.(rows, full, variant);
        resendResolved();
      },
      ...(opts.onConversationListRequest ? { onRequest: opts.onConversationListRequest } : {}),
      ...(opts.onConversationListOutcome ? { onOutcome: (o: SoaOutcome<ConversationListResponse>, ticket?: unknown) => opts.onConversationListOutcome?.(o, variant, ticket) } : {}),
    }),
  );

  let running = false;
  let started = false;
  let unsubscribes: (() => void)[] = [];
  function stopAdapter(): void {
    if (!running) return;
    running = false;
    unresolved = [];
    for (const unsubscribe of unsubscribes) unsubscribe();
    unsubscribes = [];
    stopLoops();
    cancelBatches();
    // The final account-invalid fact must survive its own terminal shutdown.
    // Ordinary stop/restart expires old pending facts before a fresh epoch.
    if (!authInvalidSeen || queueFaulted) bridge.cancelPending();
  }

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
      if (running || queueFaulted) return;
      running = true;
      authInvalidSeen = false;
      if (started) bridge.bumpEpoch();
      started = true;
      // subscribe before any snapshot so nothing is missed between the two
      unsubscribes = [
        deps.sdk.on('terminal', () => {
          if (!running || authInvalidSeen) return;
          emit({ kind: 'auth_invalid' });
          opts.onTerminal?.();
        }),
        deps.sdk.on('message', (evt) => {
          if (!running || authInvalidSeen) return;
          const fact = normalizeSdkMessage(evt, { roles: rolesProxy, ...(opts.msgTypeOverrides ? { msgTypeOverrides: opts.msgTypeOverrides } : {}) });
          // Typing frames carry no message identity and have no place in the message stream.
          if (!fact || (fact.message_id === null && fact.local_id === null)) return;
          emit({ kind: 'message', fact });
          if (fact.sender_role === 'unknown' && fact.kind === 'business' && fact.message_id) {
            if (unresolved.length >= MAX_UNRESOLVED) unresolved.shift();
            unresolved.push({ fact, at: deps.now() });
          }
        }),
        deps.sdk.on('socket_status', (status) => {
          if (!running || authInvalidSeen) return;
          const state = toTransport(status);
          emit({ kind: 'transport', state });
          if (running) compensation.setTransport(state);
        }),
      ];
      if (deps.sdk.terminalStatus !== undefined && deps.sdk.terminalStatus !== null) {
        emit({ kind: 'auth_invalid' });
        opts.onTerminal?.();
        return;
      }
      const initial: TransportState = deps.sdk.getSocketStatus() ? 'connected' : 'disconnected';
      emit({ kind: 'transport', state: initial });
      if (!running) return;
      compensation.start(initial);
      for (const p of conversationPollers) p.start();
    },
    stop: stopAdapter,
  };
}
