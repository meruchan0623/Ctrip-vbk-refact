/**
 * Injected dependencies for the web adapter.
 *
 * The adapter runs inside the official vbooking page's WebView, but every
 * module here must be testable under Node. Nothing in this package reads
 * `window`, `document`, `fetch`, `Date.now` or `Math.random` at module load
 * or at call time: the host (or a test) hands an `AdapterDeps` object in.
 *
 * Nothing in `AdapterDeps` may carry cookies, tickets or tokens. The browser
 * attaches cookies itself (`credentials: 'include'`); `cid`/`sid` are
 * request-context values the page already exposes, not credentials.
 */

// ------------------------------------------------------------------ fetch

export interface FetchInit {
  readonly method: 'POST';
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | Uint8Array;
  readonly credentials: 'include' | 'omit';
}

export interface FetchResponseLike {
  readonly status: number;
  text(): Promise<string>;
}

/** Minimal `fetch` shape; the real `fetch` satisfies it. */
export type FetchLike = (url: string, init: FetchInit) => Promise<FetchResponseLike>;

// ------------------------------------------------------------------ timers

/** Opaque timer handle; Node returns an object, browsers a number. */
export type TimerHandle = unknown;

export interface TimerDeps {
  readonly setTimeout: (cb: () => void, ms: number) => TimerHandle;
  readonly clearTimeout: (handle: TimerHandle) => void;
}

// ------------------------------------------------------------------ context

export interface PageContext {
  /** `head.cid` of the web business head; observed equal to the page GUID cookie but read from the page, never hardcoded. */
  readonly cid: string;
  /** `head.sid` of the web business head (observed `8888` in one session; never hardcoded here). */
  readonly sid: string;
  /** Client id the common request layer uses for `_fxpcqlniredt` / `x-traceID`; `null`/empty → no trace query. */
  readonly clientId: string | null;
  /** Page locale, e.g. `zh-CN`; used for `x-ctx-Locale` and head extensions. */
  readonly locale: string;
  /** Observed `cookieOrigin` header value. */
  readonly cookieOrigin: 'https://vbooking.ctrip.com';
  /** Observed `x-ctx-Currency`; defaults to `CNY` when absent. */
  readonly currency?: string;
  /** Observed `x-ctx-Country`; defaults to `CN` when absent. */
  readonly country?: string;
}

// ------------------------------------------------------------------ SDK

/**
 * Message frame as the official SDK hands it to listeners. Every field is
 * optional/unknown on purpose: the adapter narrows at use sites and never
 * trusts the shape. Attribute names follow the observed XMPP frame
 * attributes (`localid, id, ts, msgtype, bizType, threadid, create_time,
 * from, to, ...`).
 */
export interface SdkMessageEvent {
  readonly id?: unknown;
  readonly localid?: unknown;
  readonly type?: unknown;
  readonly msgtype?: unknown;
  readonly bizType?: unknown;
  readonly threadid?: unknown;
  readonly create_time?: unknown;
  readonly ts?: unknown;
  readonly from?: unknown;
  readonly to?: unknown;
  readonly body?: unknown;
  readonly citemsgid?: unknown;
  readonly pollType?: unknown;
}

/** `send_result` body as observed: `{error, reason, chattype, localid, tid, create_time, ts, threadid, present}`. */
export interface SdkSendResultEvent {
  readonly error?: unknown;
  readonly reason?: unknown;
  readonly localid?: unknown;
  readonly tid?: unknown;
  readonly create_time?: unknown;
  readonly ts?: unknown;
  readonly threadid?: unknown;
  readonly chattype?: unknown;
  readonly present?: unknown;
}

export type SdkSocketStatus = 'connecting' | 'connected' | 'disconnected' | 'reconnecting';

export interface SdkEventMap {
  readonly message: SdkMessageEvent;
  readonly send_result: SdkSendResultEvent;
  readonly socket_status: SdkSocketStatus;
}

/** Body JSON the SDK serializes into the XML `<body>`; see transports.md. The SDK does the XML escaping. */
export interface SdkSendBody {
  readonly chattype: 'groupchat';
  readonly biztype: string;
  readonly localid: string;
  readonly msg: string;
  readonly msgtype: '0' | '1' | '3' | '5';
  readonly autoextend: 0;
  readonly threadid: string;
}

export interface SdkSendRequest {
  /** Group id the SDK turns into the target JID. */
  readonly gid: string;
  readonly body: SdkSendBody;
  /** Quote: becomes the `citemsgid` XML attribute, never a body field. */
  readonly citemsgid?: string;
}

export interface SdkReadReceiptRequest {
  readonly partnerJid: string;
  readonly msgId: string;
  readonly conversationType: 'groupchat';
}

export type SdkCallOutcome =
  | { readonly kind: 'success'; readonly raw: unknown }
  | { readonly kind: 'failure'; readonly raw: unknown };

/**
 * Abstract handle over the official web IM SDK. The thin glue that maps
 * this onto the real `IMClient` lives in the page, not in this package,
 * and is unverified; this interface is what the adapter needs, nothing
 * more.
 */
export interface ImSdkHandle {
  on<K extends keyof SdkEventMap>(event: K, cb: (payload: SdkEventMap[K]) => void): () => void;
  /** Fire-and-forget: the result arrives as a `send_result` event matched by `localid`. */
  sendMessage(req: SdkSendRequest): void;
  /** HTTP `11679/PutAdviceOfReadByMsgId.json` through the SDK. */
  putAdviceOfReadByMsgId(req: SdkReadReceiptRequest): Promise<SdkCallOutcome>;
  getSocketStatus(): boolean;
}

// ------------------------------------------------------------------ host

export type InvokeLike = (cmd: string, payload: unknown) => Promise<unknown>;

// ------------------------------------------------------------------ deps

export interface AdapterDeps extends TimerDeps {
  readonly fetch: FetchLike;
  /** Wall clock in Unix ms. */
  readonly now: () => number;
  /** Uniform [0, 1). */
  readonly random: () => number;
  readonly context: PageContext;
  readonly sdk: ImSdkHandle;
  readonly invoke: InvokeLike;
}
