/**
 * Page glue: the official web IM SDK → `ImSdkHandle`.
 *
 * What is evidenced (docs/research/evidence/web-im-polling-static-20261030.json,
 * snippet `sdk-connected-disconnected`):
 *   the SDK assigns its XMPP connection to `window.xmppClient`
 *   (`"undefined"!=typeof window?window.xmppClient=c:...`), an xmpp.js
 *   client (`c.status=="online"`, `c.send(..)["catch"]`, `c.start()`,
 *   `c.reconnect.delay`). A reconnect creates a NEW client, so the glue
 *   re-probes the global and re-attaches.
 * Frames (evidence 35/40/05): inbound chat frames are `<message type="groupchat"
 * from="<room jid>" localid id ts msgtype bizType threadid create_time ...><body>`;
 * the send ack is `<message type="send_result" id="<localId>"><body>{error,reason,
 * localid,tid,create_time,ts,threadid,present}</body>`; typing is `type="input_state"`
 * with `msgtype="9901"`; `notify_ack` frames are protocol acks.
 *
 * The facade contract was verified from the currently loaded official SDK and
 * application source on 2026-10-31; see docs/api/sdk-facade.md. The public
 * send model is distinct from the SDK's generated HTTP/XMPP payload. Facade
 * writes are callback-based, and a void return never acknowledges a write.
 * Candidate global names remain feature-detected; no generic XML sender is used.
 */

import type { ImSdkHandle, SdkCallOutcome, SdkEventMap, SdkMessageEvent, SdkReadReceiptRequest, SdkSendRequest, SdkSendResultEvent, SdkSocketStatus, TimerDeps } from './deps.ts';
import { jidLocal } from './facts.ts';
import { recordOrNull } from './soa.ts';

// ------------------------------------------------------------- element reading

export interface ElementView {
  readonly name: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly body: string | null;
}

function childText(el: unknown): string | null {
  if (typeof el !== 'object' || el === null) return null;
  const e = el as { text?: unknown; getText?: unknown; children?: unknown };
  if (typeof e.text === 'function') {
    const t = (e.text as () => unknown).call(el);
    if (typeof t === 'string') return t;
  }
  if (typeof e.getText === 'function') {
    const t = (e.getText as () => unknown).call(el);
    if (typeof t === 'string') return t;
  }
  if (Array.isArray(e.children)) return e.children.filter((c): c is string => typeof c === 'string').join('');
  return null;
}

/** Duck-typed read of an xmpp.js/ltx element; `null` when it does not look like one. */
export function readElement(el: unknown): ElementView | null {
  if (typeof el !== 'object' || el === null) return null;
  const e = el as { name?: unknown; attrs?: unknown; getChildText?: unknown; getChild?: unknown; children?: unknown };
  if (typeof e.name !== 'string') return null;
  const attrs: Record<string, string> = {};
  const rawAttrs = recordOrNull(e.attrs);
  if (rawAttrs) for (const [k, v] of Object.entries(rawAttrs)) if (typeof v === 'string' || typeof v === 'number') attrs[k] = String(v);
  let body: string | null = null;
  if (typeof e.getChildText === 'function') {
    const t = (e.getChildText as (n: string) => unknown).call(el, 'body');
    if (typeof t === 'string') body = t;
  } else if (typeof e.getChild === 'function') {
    body = childText((e.getChild as (n: string) => unknown).call(el, 'body'));
  } else if (Array.isArray(e.children)) {
    const b = e.children.find((c) => typeof c === 'object' && c !== null && (c as { name?: unknown }).name === 'body');
    body = b ? childText(b) : null;
  }
  return { name: e.name, attrs, body };
}

function bareJid(jid: string): string {
  const slash = jid.indexOf('/');
  return slash >= 0 ? jid.slice(0, slash) : jid;
}

export type GlueEvent =
  | { readonly kind: 'message'; readonly event: SdkMessageEvent; readonly roomJid: string | null }
  | { readonly kind: 'send_result'; readonly event: SdkSendResultEvent }
  | { readonly kind: 'ignore' };

const MESSAGE_TYPES: ReadonlySet<string> = new Set(['groupchat', 'chat', 'input_state']);

/** Maps one inbound stanza onto the adapter's SDK event shapes. */
export function stanzaToEvent(el: unknown): GlueEvent {
  const v = readElement(el);
  if (!v || v.name !== 'message') return { kind: 'ignore' };
  const a = v.attrs;
  const wireType = a['type'] ?? '';
  // Official xmppSerialize normalizes cross-session sync frames (2026-10-31 SDK).
  const type = wireType === 'sys_muc' ? 'groupchat' : wireType === 'sys_mam' ? 'chat' : wireType;
  if (type === 'send_result') {
    let body: Record<string, unknown> | null = null;
    if (v.body !== null) {
      try {
        body = recordOrNull(JSON.parse(v.body));
      } catch {
        body = null;
      }
    }
    if (!body) return { kind: 'ignore' };
    // the ack frame's id is the outbound localId (evidence 35: same ref)
    const localid = typeof body['localid'] === 'string' && body['localid'] !== '' ? body['localid'] : a['id'];
    return { kind: 'send_result', event: { ...body, localid } as SdkSendResultEvent };
  }
  if (!MESSAGE_TYPES.has(type)) return { kind: 'ignore' };
  const from = a['from'] ?? '';
  const to = a['to'] ?? '';
  // Group frames carry the room jid in `from` (evidence 35/40: same ref as the send target).
  // facts.ts derives the gid from `from` only when it has a resource; otherwise from `to`,
  // so a bare room `from` is mirrored into `to` to keep the gid right.
  const roomJid = type !== 'chat' && from !== '' ? bareJid(from) : null;
  const evt: SdkMessageEvent = {
    id: a['id'],
    localid: a['localid'],
    type,
    msgtype: a['msgtype'],
    bizType: a['bizType'],
    threadid: a['threadid'],
    create_time: a['create_time'],
    ts: a['ts'],
    from,
    to: roomJid !== null && !from.includes('/') ? roomJid : to,
    body: v.body ?? undefined,
    citemsgid: a['citemsgid'],
  };
  return { kind: 'message', event: evt, roomJid };
}

/** xmpp.js connection statuses → `SdkSocketStatus`. */
export function mapXmppStatus(status: unknown): SdkSocketStatus {
  switch (status) {
    case 'online':
      return 'connected';
    case 'connecting':
    case 'connect':
    case 'opening':
    case 'open':
      return 'connecting';
    case 'reconnecting':
      return 'reconnecting';
    default:
      return 'disconnected';
  }
}

// ------------------------------------------------------------- probing

interface EmitterLike {
  on(event: string, cb: (...a: unknown[]) => void): unknown;
  removeListener?(event: string, cb: (...a: unknown[]) => void): unknown;
  off?(event: string, cb: (...a: unknown[]) => void): unknown;
  /** Captured SDK EventEmitter.prototype.listeners, source offset 151349. */
  listeners?(event: string): unknown;
}

function isEmitter(x: unknown): x is EmitterLike {
  return typeof x === 'object' && x !== null && typeof (x as { on?: unknown }).on === 'function';
}

export interface ImClientLike {
  sendMessageInSocket?: (message: unknown, success: (raw: unknown) => void, failure: (raw: unknown) => void) => unknown;
  putAdviceOfReadByMsgId?: (req: unknown, success: (raw: unknown) => void, failure: (raw: unknown) => void) => unknown;
  getSocketStatus?: () => unknown;
  sdkVersion?: unknown;
}

/** Candidate globals for the SDK facade (unverified names; first match wins). */
export const IM_CLIENT_CANDIDATES: readonly string[] = ['IMClient', 'imClient', 'ImClient', 'IMSDK', 'ImSDK', 'imsdk', 'imSDK'];

function asImClient(x: unknown): ImClientLike | null {
  if ((typeof x !== 'object' && typeof x !== 'function') || x === null) return null;
  const c = x as ImClientLike;
  if (typeof c.sendMessageInSocket === 'function' || typeof c.putAdviceOfReadByMsgId === 'function') return c;
  return null;
}

export function findImClient(win: Record<string, unknown>): ImClientLike | null {
  for (const name of IM_CLIENT_CANDIDATES) {
    let g: unknown;
    try {
      g = win[name];
    } catch {
      continue;
    }
    const direct = asImClient(g);
    if (direct) return direct;
    const rec = g as { default?: unknown; IMClient?: unknown; getInstance?: unknown } | null | undefined;
    if (rec && (typeof rec === 'object' || typeof rec === 'function')) {
      const nested = asImClient(rec.default) ?? asImClient(rec.IMClient);
      if (nested) return nested;
      if (typeof rec.getInstance === 'function') {
        try {
          const inst = asImClient((rec.getInstance as () => unknown).call(rec));
          if (inst) return inst;
        } catch {
          // ignore
        }
      }
    }
  }
  return null;
}

// ------------------------------------------------------------- glue

export interface SdkBindingDiagnostics {
  readonly global_state: 'emitter' | 'missing' | 'invalid' | 'unreadable' | 'disposed';
  /** Health of this glue's callbacks only, never a claim about SDK internals. */
  readonly listener_health: 'verified' | 'missing' | 'unsupported' | 'detached';
  readonly attached: boolean;
  readonly can_rebind: boolean;
  readonly binding_generation: number;
  readonly attach_count: number;
  readonly repair_count: number;
}

export interface PageSdk extends ImSdkHandle {
  /** Bound to the current global emitter. This alone is not delivery proof. */
  readonly attached: boolean;
  /** A facade with `sendMessageInSocket` was found (sending is possible). */
  readonly canSend: boolean;
  /** Only booleans, fixed enums and counters; no upstream data. */
  readonly bindingDiagnostics?: SdkBindingDiagnostics;
  readonly receiveDiagnostics?: import('../../ipc/src/client.ts').UiSdkReceiveDiagnostics;
  sdkVersion(): string | null;
  /** Bare room jid learnt from inbound frames for this gid (SDK target JID). */
  partnerJidOf(gid: string): string | null;
  rememberPartnerJid(gid: string, jid: string): void;
  /** Resolves once an xmpp client is attached, or `false` after `timeoutMs`. */
  waitReady(timeoutMs: number): Promise<boolean>;
  dispose(): void;
}

export interface PageSdkOptions extends TimerDeps {
  readonly now: () => number;
  /** HTTP read receipt used when no SDK facade exposes `putAdviceOfReadByMsgId`. */
  readonly httpReadReceipt?: (req: SdkReadReceiptRequest) => Promise<SdkCallOutcome>;
  readonly probeIntervalMs?: number;
  readonly readReceiptTimeoutMs?: number;
  readonly facadeSendTimeoutMs?: number;
  readonly log?: (msg: string) => void;
}

type Listener<K extends keyof SdkEventMap> = (p: SdkEventMap[K]) => void;

function idStr(x: unknown): string | null {
  if (typeof x === 'string' && x.trim() !== '') return x;
  if (typeof x === 'number' && Number.isSafeInteger(x) && x >= 0) return String(x);
  return null;
}

function integerCode(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value) : null;
  return n !== null && Number.isSafeInteger(n) ? n : null;
}

export function createPageSdk(win: Record<string, unknown>, opts: PageSdkOptions): PageSdk {
  const listeners: { [K in keyof SdkEventMap]: Listener<K>[] } = { message: [], send_result: [], socket_status: [] };
  const partnerJids = new Map<string, string>();
  const readyWaiters: (() => void)[] = [];
  const pendingReadReceipts = new Set<() => void>();
  const pendingFacadeSends = new Map<string, () => void>();
  let client: EmitterLike | null = null;
  let detach: (() => void) | null = null;
  let probeTimer: unknown = null;
  let disposed = false;
  let bindingGeneration = 0;
  let attachCount = 0, repairCount = 0;
  let reportedUnhealthy = false;
  const receive = { callbacks: 0, stale_callbacks: 0, messages: 0, acks: 0, ignored: 0, listener_errors: 0 };
  let lastStanzaMs: number | null = null;
  type Hook = { emitter: EmitterLike; event: string; callback: (...args: unknown[]) => void };
  let bindingHooks: Hook[] = [];
  const log = opts.log ?? (() => undefined);

  const emit = <K extends keyof SdkEventMap>(event: K, payload: SdkEventMap[K]): void => {
    if (disposed) return;
    for (const cb of [...(listeners[event] as Listener<K>[])]) {
      try {
        cb(payload);
      } catch {
        receive.listener_errors = Math.min(Number.MAX_SAFE_INTEGER, receive.listener_errors + 1);
        // a listener error never breaks the SDK dispatch chain
      }
    }
  };

  const onStanza = (el: unknown): void => {
    if (disposed) return;
    const g = stanzaToEvent(el);
    if (g.kind === 'message') {
      receive.messages = Math.min(Number.MAX_SAFE_INTEGER, receive.messages + 1);
      if (g.roomJid) {
        const gid = jidLocal(g.roomJid);
        if (gid) partnerJids.set(gid, g.roomJid);
      }
      emit('message', g.event);
    } else if (g.kind === 'send_result') {
      receive.acks = Math.min(Number.MAX_SAFE_INTEGER, receive.acks + 1);
      // The SDK may still be performing its own HTTP fallback after raw -2.
      // Only this local call's final facade callback/Promise decides its result.
      if (typeof g.event.localid === 'string' && pendingFacadeSends.has(g.event.localid)) return;
      emit('send_result', g.event);
    } else receive.ignored = Math.min(Number.MAX_SAFE_INTEGER, receive.ignored + 1);
  };
  const onStatus = (status: unknown): void => emit('socket_status', mapXmppStatus(status));
  const onReconnecting = (): void => emit('socket_status', 'reconnecting');

  const globalClient = (): { state: SdkBindingDiagnostics['global_state']; emitter: EmitterLike | null } => {
    if (disposed) return { state: 'disposed', emitter: null };
    try {
      const value = win['xmppClient'];
      return value === null || value === undefined ? { state: 'missing', emitter: null }
        : isEmitter(value) ? { state: 'emitter', emitter: value } : { state: 'invalid', emitter: null };
    } catch { return { state: 'unreadable', emitter: null }; }
  };
  const listenerHealth = (): SdkBindingDiagnostics['listener_health'] => {
    if (!client || bindingHooks.length === 0) return 'detached';
    let health: 'verified' | 'unsupported' = 'verified';
    for (const hook of bindingHooks) {
      try {
        if (typeof hook.emitter.listeners !== 'function') { health = 'unsupported'; continue; }
        const registered = hook.emitter.listeners(hook.event);
        if (!Array.isArray(registered)) { health = 'unsupported'; continue; }
        if (!registered.includes(hook.callback)) return 'missing';
      } catch { health = 'unsupported'; }
    }
    return health;
  };
  const currentBinding = (): boolean => !disposed && client !== null && globalClient().emitter === client;
  const attached = (): boolean => currentBinding() && listenerHealth() !== 'missing';
  const canRebind = (): boolean => bindingHooks.length > 0 && bindingHooks.every(hook => {
    try { return typeof hook.emitter.removeListener === 'function' || typeof hook.emitter.off === 'function'; }
    catch { return false; }
  });

  const attach = (c: EmitterLike): void => {
    detach?.();
    client = c;
    const generation = ++bindingGeneration;
    const current = (): boolean => !disposed && generation === bindingGeneration && client === c && globalClient().emitter === c;
    // Removing listeners does not cancel callbacks already queued by a source.
    const boundStanza = (el: unknown): void => {
      receive.callbacks = Math.min(Number.MAX_SAFE_INTEGER, receive.callbacks + 1);
      lastStanzaMs = opts.now();
      if (current()) onStanza(el);
      else receive.stale_callbacks = Math.min(Number.MAX_SAFE_INTEGER, receive.stale_callbacks + 1);
    };
    const boundStatus = (status: unknown): void => { if (current()) listenerHealth() === 'missing' ? emit('socket_status', 'disconnected') : onStatus(status); };
    const boundReconnecting = (): void => { if (current()) listenerHealth() === 'missing' ? emit('socket_status', 'disconnected') : onReconnecting(); };
    let reconnect: unknown;
    try { reconnect = (c as { reconnect?: unknown }).reconnect; } catch { reconnect = null; }
    const hooks: Hook[] = [{ emitter: c, event: 'stanza', callback: boundStanza }, { emitter: c, event: 'status', callback: boundStatus }];
    if (isEmitter(reconnect)) hooks.push({ emitter: reconnect, event: 'reconnecting', callback: boundReconnecting });
    bindingHooks = hooks;
    detach = () => {
      for (const hook of hooks) {
        try {
          if (typeof hook.emitter.removeListener === 'function') hook.emitter.removeListener(hook.event, hook.callback);
          else if (typeof hook.emitter.off === 'function') hook.emitter.off(hook.event, hook.callback);
        } catch { /* The generation fence remains authoritative. */ }
      }
      if (client === c) { client = null; bindingHooks = []; }
    };
    try { for (const hook of hooks) hook.emitter.on(hook.event, hook.callback); }
    catch {
      detach(); detach = null; bindingGeneration++; reportedUnhealthy = true;
      emit('socket_status', 'disconnected'); return;
    }
    attachCount++;
    reportedUnhealthy = !attached();
    log('xmpp listener binding attempted');
    emit('socket_status', reportedUnhealthy ? 'disconnected' : mapXmppStatus((c as { status?: unknown }).status));
    if (!reportedUnhealthy) for (const waiter of readyWaiters.splice(0)) waiter();
  };

  const probe = (): void => {
    if (disposed) return;
    const next = globalClient().emitter;
    if (!next) {
      if (client !== null) {
        detach?.(); detach = null; bindingGeneration++; reportedUnhealthy = false;
        emit('socket_status', 'disconnected');
      }
    } else if (next !== client) attach(next);
    else if (listenerHealth() === 'missing') {
      // Re-register only our own callbacks when the supported listeners() API
      // proves a loss and every old registration can be removed without leaks.
      if (canRebind()) { repairCount++; attach(next); }
      else if (!reportedUnhealthy) { reportedUnhealthy = true; emit('socket_status', 'disconnected'); }
    } else if (reportedUnhealthy) {
      reportedUnhealthy = false; emit('socket_status', mapXmppStatus((next as { status?: unknown }).status));
    }
    probeTimer = opts.setTimeout(probe, opts.probeIntervalMs ?? 1000);
  };
  probe();

  const facade = (): ImClientLike | null => findImClient(win);
  const bindingSnapshot = (): SdkBindingDiagnostics => ({ global_state: globalClient().state, listener_health: currentBinding() ? listenerHealth() : 'detached', attached: attached(), can_rebind: currentBinding() && canRebind(), binding_generation: bindingGeneration, attach_count: attachCount, repair_count: repairCount });

  return {
    get attached() {
      return attached();
    },
    get bindingDiagnostics() {
      return bindingSnapshot();
    },
    get receiveDiagnostics() { return { binding: bindingSnapshot(), counters: { ...receive }, last_stanza_ms: lastStanzaMs }; },
    get canSend() {
      return !disposed && typeof facade()?.sendMessageInSocket === 'function';
    },
    sdkVersion() {
      const v = facade()?.sdkVersion;
      return typeof v === 'string' && v !== '' ? v : null;
    },
    partnerJidOf: (gid) => partnerJids.get(gid) ?? null,
    rememberPartnerJid(gid, jid) {
      if (gid !== '' && jid !== '' && jidLocal(jid) === gid) partnerJids.set(gid, bareJid(jid));
    },
    waitReady(timeoutMs) {
      if (disposed) return Promise.resolve(false);
      if (attached()) return Promise.resolve(true);
      return new Promise((resolve) => {
        let done = false;
        readyWaiters.push(() => {
          if (done) return;
          done = true;
          resolve(true);
        });
        opts.setTimeout(() => {
          if (done) return;
          done = true;
          resolve(false);
        }, timeoutMs);
      });
    },
    on<K extends keyof SdkEventMap>(event: K, cb: Listener<K>): () => void {
      const list = listeners[event] as Listener<K>[];
      list.push(cb);
      return () => {
        const i = list.indexOf(cb);
        if (i >= 0) list.splice(i, 1);
      };
    },
    getSocketStatus() {
      if (!attached()) return false;
      const f = facade();
      if (typeof f?.getSocketStatus === 'function') {
        try {
          return f.getSocketStatus() === true;
        } catch {
          // fall through to the xmpp client
        }
      }
      return (client as { status?: unknown } | null)?.status === 'online';
    },
    sendMessage(req: SdkSendRequest) {
      if (disposed) throw new Error('sdk disposed (nothing sent)');
      const f = facade();
      if (typeof f?.sendMessageInSocket !== 'function') throw new Error('sdk send unavailable');
      const partnerJid = partnerJids.get(req.gid);
      if (!partnerJid) throw new Error('partner jid unknown');
      const b = req.body;
      if (b.msgtype !== '0') throw new Error('sdk media facade unsupported (nothing sent)');
      // The verified facade accepts a public message model, not the HTTP/XMPP
      // payload it later builds. The SDK itself expands this bare gid into a JID.
      const message: Record<string, unknown> = {
        localId: b.localid,
        bizType: /^\d+$/.test(b.biztype) ? Number(b.biztype) : b.biztype,
        toJid: req.gid,
        messageType: Number(b.msgtype),
        content: b.msg,
        conversationType: b.chattype,
        threadId: b.threadid,
      };
      // deserialize mutates and returns the same model; the SDK copies citemsgid
      // into both socket and HTTP fallback payloads (captured source, offset 129983).
      if (req.citemsgid !== undefined) message['citemsgid'] = req.citemsgid;
      if (pendingFacadeSends.has(b.localid) || pendingFacadeSends.size >= 1000) throw new Error('sdk send tracking unavailable (nothing sent)');
      let settled = false;
      let ackTimer: unknown = null;
      const cleanup = (): void => {
        if (ackTimer !== null) opts.clearTimeout(ackTimer);
        if (pendingFacadeSends.get(b.localid) === cancel) pendingFacadeSends.delete(b.localid);
      };
      const cancel = (): void => { if (!settled) { settled = true; cleanup(); } };
      const complete = (raw: unknown, failure: boolean, legacyPromise = false): void => {
        if (settled) return;
        if (disposed) { cancel(); return; }
        settled = true;
        cleanup();
        // A callback from a facade replaced while this operation was pending
        // cannot confirm work in the new binding. It still must never be replayed.
        if (facade() !== f) { emit('send_result', { localid: b.localid }); return; }
        const rec = recordOrNull(raw);
        if (rec && 'localId' in rec && idStr(rec['localId']) !== b.localid) { emit('send_result', { localid: b.localid }); return; }
        const error = integerCode(rec?.['error']);
        const reason = typeof rec?.['errmsg'] === 'string' ? rec['errmsg'] : typeof rec?.['reason'] === 'string' ? rec['reason'] : '';
        if (error !== null && error !== 0) { emit('send_result', { localid: b.localid, error, reason }); return; }
        if (failure || !rec || ('error' in rec && error !== 0)) { emit('send_result', { localid: b.localid }); return; }
        const msgId = idStr(rec['msgId']) ?? (legacyPromise ? idStr(rec['messageId']) : null);
        emit('send_result', msgId !== null
          ? { error: 0, localid: b.localid, tid: msgId, create_time: rec['msgCreateTime'] ?? rec['createTime'] }
          : { localid: b.localid });
      };
      pendingFacadeSends.set(b.localid, cancel);
      ackTimer = opts.setTimeout(() => complete(null, true), opts.facadeSendTimeoutMs ?? 15_000);
      let r: unknown;
      try { r = f.sendMessageInSocket.call(f, message, raw => complete(raw, false), raw => complete(raw, true)); }
      catch { complete(null, true); return; }
      // Keep compatibility with an explicitly promise-returning facade. The
      // callback path above remains authoritative for the captured official SDK.
      if (r && typeof (r as { then?: unknown }).then === 'function') {
        (r as Promise<unknown>).then(raw => complete(raw, false, true), () => complete(null, true));
      }
    },
    async putAdviceOfReadByMsgId(req: SdkReadReceiptRequest): Promise<SdkCallOutcome> {
      if (disposed) throw new Error('sdk disposed (nothing sent)');
      const f = facade();
      const send = f?.putAdviceOfReadByMsgId;
      if (typeof send !== 'function' && !opts.httpReadReceipt) throw new Error('read receipt unavailable');
      return new Promise<SdkCallOutcome>((resolve, reject) => {
        let settled = false;
        let timer: unknown = null;
        const cancel = (): void => settle(null);
        const settle = (outcome: SdkCallOutcome | null): void => {
          if (settled) return;
          settled = true;
          if (timer !== null) opts.clearTimeout(timer);
          pendingReadReceipts.delete(cancel);
          if (disposed || facade() !== f) { reject(new Error('read receipt binding changed; outcome unknown')); return; }
          const valid = recordOrNull(outcome);
          if (valid && (valid['kind'] === 'success' || valid['kind'] === 'failure') && 'raw' in valid) { resolve({ kind: valid['kind'], raw: valid['raw'] }); return; }
          reject(new Error('read receipt outcome unknown (not retried)'));
        };
        const finish = (raw: unknown, failure: boolean): void => {
          if (settled) return;
          const rec = recordOrNull(raw);
          const rs = recordOrNull(rec?.['ResponseStatus']) ?? recordOrNull(rec?.['responseStatus']);
          const code = integerCode(rec?.['error']);
          if (rs?.['Ack'] === 'Failure' || (code !== null && code !== 0)) { settle({ kind: 'failure', raw: 'sdk_rejected' }); return; }
          if (!failure && rs && (rs['Ack'] === 'Success' || rs['Ack'] === 0) && (rs['Errors'] === undefined || (Array.isArray(rs['Errors']) && rs['Errors'].length === 0)) && (!rec || !('error' in rec) || code === 0)) {
            settle({ kind: 'success', raw: null }); return;
          }
          settle(null);
        };
        pendingReadReceipts.add(cancel);
        timer = opts.setTimeout(cancel, opts.readReceiptTimeoutMs ?? 15_000);
        const request = { partnerJid: jidLocal(req.partnerJid), msgId: req.msgId, conversationType: req.conversationType };
        try {
          if (typeof send === 'function') {
            const result = send.call(f, request, raw => finish(raw, false), raw => finish(raw, true));
            if (result && typeof (result as { then?: unknown }).then === 'function') {
              (result as Promise<unknown>).then(raw => finish(raw, false), () => settle(null));
            }
          } else {
            // This pre-existing HTTP path is used only without a facade method.
            // It shares the same timeout/disposal fence, and is never a retry.
            opts.httpReadReceipt!(request).then(outcome => settle(outcome), () => settle(null));
          }
        } catch { settle(null); }
      });
    },
    dispose() {
      disposed = true;
      bindingGeneration++;
      for (const cancel of [...pendingReadReceipts]) cancel();
      for (const cancel of [...pendingFacadeSends.values()]) cancel();
      if (probeTimer !== null) opts.clearTimeout(probeTimer);
      probeTimer = null;
      detach?.();
      detach = null;
    },
  };
}
