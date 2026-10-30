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
 * What is NOT evidenced: the global name of the SDK's `IMClient` facade.
 * The glue probes a short list of candidates for `sendMessageInSocket` /
 * `putAdviceOfReadByMsgId` / `getSocketStatus`; without one, sending is
 * reported as unsupported (nothing is sent) and read receipts use the
 * HTTP call the SDK itself makes (`11679/PutAdviceOfReadByMsgId.json`,
 * evidence 71). The glue never builds or sends XML itself.
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
  const type = a['type'] ?? '';
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
}

function isEmitter(x: unknown): x is EmitterLike {
  return typeof x === 'object' && x !== null && typeof (x as { on?: unknown }).on === 'function';
}

export interface ImClientLike {
  sendMessageInSocket?: (message: unknown) => unknown;
  putAdviceOfReadByMsgId?: (req: unknown) => unknown;
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

export interface PageSdk extends ImSdkHandle {
  /** An xmpp client is attached (realtime receive works). */
  readonly attached: boolean;
  /** A facade with `sendMessageInSocket` was found (sending is possible). */
  readonly canSend: boolean;
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
  readonly log?: (msg: string) => void;
}

type Listener<K extends keyof SdkEventMap> = (p: SdkEventMap[K]) => void;

function idStr(x: unknown): string | null {
  if (typeof x === 'string' && x.trim() !== '') return x;
  if (typeof x === 'number' && Number.isSafeInteger(x) && x >= 0) return String(x);
  return null;
}

export function createPageSdk(win: Record<string, unknown>, opts: PageSdkOptions): PageSdk {
  const listeners: { [K in keyof SdkEventMap]: Listener<K>[] } = { message: [], send_result: [], socket_status: [] };
  const partnerJids = new Map<string, string>();
  const readyWaiters: (() => void)[] = [];
  let client: EmitterLike | null = null;
  let detach: (() => void) | null = null;
  let probeTimer: unknown = null;
  let disposed = false;
  const log = opts.log ?? (() => undefined);

  const emit = <K extends keyof SdkEventMap>(event: K, payload: SdkEventMap[K]): void => {
    for (const cb of [...(listeners[event] as Listener<K>[])]) {
      try {
        cb(payload);
      } catch {
        // a listener error never breaks the SDK dispatch chain
      }
    }
  };

  const onStanza = (el: unknown): void => {
    const g = stanzaToEvent(el);
    if (g.kind === 'message') {
      if (g.roomJid) {
        const gid = jidLocal(g.roomJid);
        if (gid) partnerJids.set(gid, g.roomJid);
      }
      emit('message', g.event);
    } else if (g.kind === 'send_result') {
      emit('send_result', g.event);
    }
  };
  const onStatus = (status: unknown): void => emit('socket_status', mapXmppStatus(status));
  const onReconnecting = (): void => emit('socket_status', 'reconnecting');

  const attach = (c: EmitterLike): void => {
    detach?.();
    client = c;
    c.on('stanza', onStanza);
    c.on('status', onStatus);
    const reconnect = (c as { reconnect?: unknown }).reconnect;
    if (isEmitter(reconnect)) reconnect.on('reconnecting', onReconnecting);
    detach = () => {
      const off = (e: EmitterLike, name: string, cb: (...a: unknown[]) => void): void => {
        try {
          if (typeof e.removeListener === 'function') e.removeListener(name, cb);
          else if (typeof e.off === 'function') e.off(name, cb);
        } catch {
          // ignore
        }
      };
      off(c, 'stanza', onStanza);
      off(c, 'status', onStatus);
      if (isEmitter(reconnect)) off(reconnect, 'reconnecting', onReconnecting);
      if (client === c) client = null;
    };
    log('xmpp client attached');
    emit('socket_status', mapXmppStatus((c as { status?: unknown }).status));
    for (const w of readyWaiters.splice(0)) w();
  };

  const probe = (): void => {
    if (disposed) return;
    let g: unknown;
    try {
      g = win['xmppClient'];
    } catch {
      g = undefined;
    }
    if (isEmitter(g) && g !== client) attach(g);
    probeTimer = opts.setTimeout(probe, opts.probeIntervalMs ?? 1000);
  };
  probe();

  const facade = (): ImClientLike | null => findImClient(win);

  return {
    get attached() {
      return client !== null;
    },
    get canSend() {
      return typeof facade()?.sendMessageInSocket === 'function';
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
      if (client !== null) return Promise.resolve(true);
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
      const f = facade();
      if (typeof f?.sendMessageInSocket !== 'function') throw new Error('sdk send unavailable');
      const partnerJid = partnerJids.get(req.gid);
      if (!partnerJid) throw new Error('partner jid unknown');
      const b = req.body;
      // Field names/types as the SDK's own HTTP fallback sends them (evidence 51) — the facade signature itself is unverified.
      const message: Record<string, unknown> = {
        localId: b.localid,
        bizType: /^\d+$/.test(b.biztype) ? Number(b.biztype) : b.biztype,
        localTimeStamp: opts.now(),
        partnerJid,
        toJid: partnerJid,
        msgType: Number(b.msgtype),
        messageBody: b.msg,
        type: b.chattype,
        conversationType: b.chattype,
        threadId: b.threadid,
      };
      if (req.citemsgid !== undefined) message['citemsgid'] = req.citemsgid;
      const r = f.sendMessageInSocket.call(f, message);
      if (r && typeof (r as { then?: unknown }).then === 'function') {
        (r as Promise<unknown>).then(
          (res) => {
            // Only a result that names the server message id confirms; anything else leaves the
            // decision to the `send_result` frame or the timeout (→ unknown, never resent).
            const rec = recordOrNull(res);
            const msgId = idStr(rec?.['msgId']) ?? idStr(rec?.['messageId']);
            const lid = idStr(rec?.['localId']);
            if (msgId !== null && (lid === null || lid === b.localid)) {
              emit('send_result', { error: 0, localid: b.localid, tid: msgId, create_time: rec?.['msgCreateTime'] ?? rec?.['createTime'] });
            }
          },
          () => undefined,
        );
      }
    },
    async putAdviceOfReadByMsgId(req: SdkReadReceiptRequest): Promise<SdkCallOutcome> {
      const f = facade();
      if (typeof f?.putAdviceOfReadByMsgId === 'function') {
        const raw = await f.putAdviceOfReadByMsgId.call(f, { partnerJid: req.partnerJid, msgId: req.msgId, conversationType: req.conversationType });
        return { kind: 'success', raw: null === raw ? null : 'ok' };
      }
      if (opts.httpReadReceipt) return opts.httpReadReceipt(req);
      throw new Error('read receipt unavailable');
    },
    dispose() {
      disposed = true;
      if (probeTimer !== null) opts.clearTimeout(probeTimer);
      probeTimer = null;
      detach?.();
      detach = null;
    },
  };
}
