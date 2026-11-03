/**
 * Request-context values (`cid`, `sid`, `clientId`, `locale`) for
 * `PageContext`, read the way docs/api/authentication.md documents them:
 *
 * - `head.cid` / `head.sid` are merged into every web business head by the
 *   official common request layer; the only safe source is therefore the
 *   page's own outgoing SOA bodies. The sniffer below observes (never
 *   modifies) the official page's `fetch` / `XMLHttpRequest` calls to
 *   `/restapi/soa2/` and keeps exactly these two strings. `cid` was observed
 *   equal to the `GUID` / `vbk_login_cid` cookies, used only as a fallback.
 *   `sid` has no documented fallback and is never hardcoded.
 * - `clientId` (`t`) is the `_fxpcqlniredt` query value the common layer
 *   appends when `t` is non-empty; read from the same observed URLs.
 * - `locale`: the page's own conversation model uses
 *   `query.lang || "zh-CN"` (static excerpt `conversation-incremental-cursor`).
 *
 * Nothing else from the observed requests is kept; nothing is logged.
 *
 * I-06 additions (request pacing, docs/api/transports.md "请求节奏"):
 *
 * - `TrafficLedger`: per account x request path x one-minute bucket x
 *   initiator (`official` = the page's own calls seen by the hooks,
 *   `adapter` = calls the adapter makes through its un-hooked `fetch`).
 * - `OfficialConversationFeed`: the official page's own
 *   `getConversationList` loop, observed request + response, so the adapter
 *   consumes those responses instead of issuing a second request.
 */

import type { FetchLike, PageContext } from './deps.ts';
import { M, ONLINE, SEC_M } from './endpoints.ts';

// ------------------------------------------------------------- traffic classification

/** Counted categories (the five path groups of the I-06 acceptance) plus two reported separately. */
export type TrafficCategory = 'conversation_list' | 'remark_info' | 'recent_messages' | 'empathy_phrase' | 'open_session' | 'read_receipt' | 'telemetry';
export const COUNTED_CATEGORIES: readonly TrafficCategory[] = ['conversation_list', 'remark_info', 'recent_messages', 'empathy_phrase', 'open_session'];
export type TrafficInitiator = 'official' | 'adapter';
export type OfficialListVariant = 'plain' | 'json';

const SOA_NAME_TO_CATEGORY: Readonly<Record<string, TrafficCategory>> = {
  getConversationList: 'conversation_list',
  getRemarkList: 'remark_info',
  getConversationInfoByGidList: 'remark_info',
  getRecentMessages: 'recent_messages',
  getSessionEmpathyPhraseInfo: 'empathy_phrase',
  batchTranslateByMsgIds: 'open_session',
  queryToken: 'open_session',
  getOrderDetailsForVbk: 'open_session',
  PutAdviceOfReadByMsgId: 'read_receipt',
};

function pathOf(url: string): string {
  const cut = url.search(/[?#]/);
  return cut >= 0 ? url.slice(0, cut) : url;
}

/** Hosts whose `/restapi/soa2/` traffic belongs to the pacing contract (endpoints.ts hosts + the IM page origins). */
const SOA_HOSTS: ReadonlySet<string> = new Set([M, SEC_M, ONLINE, 'vbooking.ctrip.com', 'imvendor.ctrip.com']);
const TELEMETRY_HOST = 's.c-ctrip.com';
/** Relative URLs are the official page's own; the adapter only boots on this origin (boot.ts). */
const PAGE_BASE = 'https://vbooking.ctrip.com/';

/**
 * Exact `https:` + allow-listed host + default port, or `null`. Lookalike
 * hosts (`m.ctrip.com.evil`), plain `http:` and non-default ports are not
 * official traffic and must never be counted or fed to the adapter.
 */
function officialUrl(url: string): URL | null {
  let u: URL;
  try {
    u = new URL(url, PAGE_BASE);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || (u.port !== '' && u.port !== '443') || u.username !== '' || u.password !== '') return null;
  return u;
}

/** Category of one request URL, or `null` when it is not part of the pacing contract. */
export function classifyTrafficPath(rawUrl: unknown): TrafficCategory | null {
  const url = urlString(rawUrl);
  if (url === null) return null;
  const u = officialUrl(url);
  if (u === null) return null;
  const path = u.pathname;
  if (SOA_HOSTS.has(u.hostname) && path.startsWith('/restapi/soa2/')) {
    const rest = path.slice('/restapi/soa2/'.length).split('/');
    const name = (rest[rest.length - 1] ?? '').replace(/\.json$/, '');
    return Object.prototype.hasOwnProperty.call(SOA_NAME_TO_CATEGORY, name) ? (SOA_NAME_TO_CATEGORY[name] ?? null) : null;
  }
  return u.hostname === TELEMETRY_HOST && path === '/bee/collect' ? 'telemetry' : null;
}

/** `.json` entry vs the plain vbooking entry of `getConversationList`; `null` for other URLs. */
export function conversationListVariantOf(rawUrl: unknown): OfficialListVariant | null {
  const url = urlString(rawUrl);
  if (url === null || classifyTrafficPath(url) !== 'conversation_list') return null;
  return pathOf(url).endsWith('.json') ? 'json' : 'plain';
}

export const TRAFFIC_BUCKET_MS = 60_000;

export interface TrafficRow {
  readonly account: string | null;
  readonly path: TrafficCategory;
  /** `floor(ms / 60000)`; one-minute bucket index. */
  readonly bucket: number;
  readonly initiator: TrafficInitiator;
  readonly count: number;
  /** Subset of `count` that was a deliberate one-off bootstrap full snapshot (reported, never hidden). */
  readonly bootstrap: number;
}

export interface TrafficEvent {
  readonly seq: number;
  readonly phase: 'request' | 'response';
  readonly category: TrafficCategory;
  readonly initiator: TrafficInitiator;
  readonly at: number;
  readonly status?: number;
}

export interface TrafficTicket {
  readonly seq: number;
  readonly category: TrafficCategory;
  readonly initiator: TrafficInitiator;
}

export interface TrafficLedger {
  setAccount(account: string | null): void;
  /** Counts one request and logs its position in the request/response order. */
  request(url: unknown, initiator: TrafficInitiator, nowMs: number): TrafficTicket | null;
  response(ticket: TrafficTicket, status: number, nowMs: number): void;
  /** The *next* adapter request of `category` is a deliberate one-off bootstrap snapshot (counted in `bootstrap` too). */
  markBootstrap(category: TrafficCategory): void;
  count(category: TrafficCategory, initiator: TrafficInitiator, bucket: number): number;
  rows(): readonly TrafficRow[];
  /** Newest-last request/response log (bounded). */
  events(): readonly TrafficEvent[];
}

export interface TrafficLedgerOptions {
  readonly retainBuckets?: number;
  readonly retainEvents?: number;
}

export function createTrafficLedger(opts: TrafficLedgerOptions = {}): TrafficLedger {
  const retainBuckets = opts.retainBuckets ?? 360;
  const retainEvents = opts.retainEvents ?? 512;
  let account: string | null = null;
  let seq = 0;
  const cells = new Map<string, { account: string | null; category: TrafficCategory; bucket: number; initiator: TrafficInitiator; count: number; bootstrap: number }>();
  const log: TrafficEvent[] = [];
  const pendingBootstrap = new Set<TrafficCategory>();
  const keyOf = (c: TrafficCategory, b: number, i: TrafficInitiator): string => `${c}|${b}|${i}`;
  const prune = (bucket: number): void => {
    for (const [k, cell] of cells) if (cell.bucket <= bucket - retainBuckets) cells.delete(k);
  };
  const push = (e: TrafficEvent): void => {
    log.push(e);
    if (log.length > retainEvents) log.splice(0, log.length - retainEvents);
  };
  return {
    setAccount(next) {
      account = next;
    },
    request(url, initiator, nowMs) {
      const category = classifyTrafficPath(url);
      if (category === null) return null;
      const bucket = Math.floor(nowMs / TRAFFIC_BUCKET_MS);
      const key = keyOf(category, bucket, initiator);
      const cell = cells.get(key) ?? { account, category, bucket, initiator, count: 0, bootstrap: 0 };
      cell.count += 1;
      if (initiator === 'adapter' && pendingBootstrap.delete(category)) cell.bootstrap += 1;
      cells.set(key, cell);
      prune(bucket);
      seq += 1;
      push({ seq, phase: 'request', category, initiator, at: nowMs });
      return { seq, category, initiator };
    },
    response(ticket, status, nowMs) {
      push({ seq: ticket.seq, phase: 'response', category: ticket.category, initiator: ticket.initiator, at: nowMs, status });
    },
    markBootstrap(category) {
      pendingBootstrap.add(category);
    },
    count: (category, initiator, bucket) => cells.get(keyOf(category, bucket, initiator))?.count ?? 0,
    rows: () =>
      [...cells.values()]
        .map((c) => ({ account: c.account, path: c.category, bucket: c.bucket, initiator: c.initiator, count: c.count, bootstrap: c.bootstrap }))
        .sort((a, b) => a.bucket - b.bucket || a.path.localeCompare(b.path) || a.initiator.localeCompare(b.initiator)),
    events: () => log.slice(),
  };
}

// ------------------------------------------------------------- official conversation-list feed

export interface OfficialConversationEntry {
  readonly variant: OfficialListVariant;
  /** Request body `startTime`; `null` = absent/0 = a full snapshot; `undefined` = body not observable. */
  readonly startTime: number | null | undefined;
  readonly full: boolean;
  readonly status: number;
  readonly text: string;
  readonly at: number;
}

export interface OfficialFeedHandler {
  /** Called when the official page sends a request; the returned ticket comes back with the response. */
  onRequest(): unknown;
  onResponse(entry: OfficialConversationEntry, ticket: unknown): void;
}

export interface OfficialFeedAttachment {
  /** `true` when the buffered chain starts at an observed full snapshot and was replayed to the handler. */
  readonly complete: boolean;
  detach(): void;
}

export interface OfficialConversationFeed {
  /**
   * The official loop is considered a usable feed for `variant`: >= `minCalls`
   * requests of that variant in `windowMs`, the latest not older than
   * `staleMs`, **and** its responses are actually reaching the tap (a body was
   * observed within `responseStaleMs`, or the first request is younger than
   * that). Requests alone never count: a loop whose bodies cannot be read
   * (opaque response type, clone failure, the other URL variant) would
   * otherwise silence the poller with zero requests *and* zero data.
   * Without `variant`, any variant counts (request liveness only).
   */
  active(nowMs: number, variant?: OfficialListVariant): boolean;
  attach(variant: OfficialListVariant, handler: OfficialFeedHandler): OfficialFeedAttachment;
}

export interface OfficialFeedToken {
  readonly variant: OfficialListVariant;
  readonly startTime: number | null | undefined;
  readonly tickets: ReadonlyMap<OfficialFeedHandler, unknown>;
}

export interface OfficialFeedSink extends OfficialConversationFeed {
  noteRequest(url: unknown, body: unknown, nowMs: number): OfficialFeedToken | null;
  noteResponse(token: OfficialFeedToken, status: number, text: string | null, nowMs: number): void;
}

export interface OfficialFeedOptions {
  /** Official interval is 5 s; 3x tolerates one throttled/skipped round. */
  readonly staleMs?: number;
  readonly windowMs?: number;
  readonly minCalls?: number;
  /** Longest time a variant may go without an observed response body before its loop stops counting as a feed (default `windowMs`). */
  readonly responseStaleMs?: number;
  /** Replay buffer bounds (entries/characters since the last full snapshot, per variant). */
  readonly maxEntries?: number;
  readonly maxChars?: number;
}

function startTimeOf(body: unknown): number | null | undefined {
  if (typeof body !== 'string' || body.length > MAX_BODY_CHARS || body.charCodeAt(0) !== 123) return undefined;
  try {
    const parsed = JSON.parse(body) as { startTime?: unknown };
    const v = typeof parsed === 'object' && parsed !== null ? parsed.startTime : undefined;
    if (v === undefined || v === null || v === 0 || v === '') return null;
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

export function createOfficialConversationFeed(opts: OfficialFeedOptions = {}): OfficialFeedSink {
  const staleMs = opts.staleMs ?? 15_000;
  const windowMs = opts.windowMs ?? 30_000;
  const minCalls = opts.minCalls ?? 2;
  const maxEntries = opts.maxEntries ?? 32;
  const maxChars = opts.maxChars ?? 4_000_000;
  const responseStaleMs = opts.responseStaleMs ?? windowMs;
  const times: Record<OfficialListVariant, number[]> = { plain: [], json: [] };
  /** First observed request / last observed response body per variant (response liveness). */
  const firstRequestAt: Record<OfficialListVariant, number | undefined> = { plain: undefined, json: undefined };
  const lastBodyAt: Record<OfficialListVariant, number | undefined> = { plain: undefined, json: undefined };
  const handlers = new Map<OfficialFeedHandler, OfficialListVariant>();
  const chains: Record<OfficialListVariant, { entries: OfficialConversationEntry[]; chars: number; anchored: boolean }> = {
    plain: { entries: [], chars: 0, anchored: false },
    json: { entries: [], chars: 0, anchored: false },
  };

  const store = (entry: OfficialConversationEntry): void => {
    const chain = chains[entry.variant];
    if (entry.status !== 200) return;
    if (entry.full) {
      chain.entries = [entry];
      chain.chars = entry.text.length;
      chain.anchored = true;
      return;
    }
    if (!chain.anchored) return; // an increment without its full snapshot cannot be replayed
    chain.entries.push(entry);
    chain.chars += entry.text.length;
    if (chain.entries.length > maxEntries || chain.chars > maxChars) {
      chain.entries = [];
      chain.chars = 0;
      chain.anchored = false; // lost the chain: the next official full snapshot re-anchors
    }
  };

  const requestsAlive = (nowMs: number, variant: OfficialListVariant): boolean => {
    const list = times[variant];
    const last = list[list.length - 1];
    if (last === undefined || nowMs - last > staleMs) return false;
    return list.filter((t) => nowMs - t <= windowMs).length >= minCalls;
  };
  const responsesAlive = (nowMs: number, variant: OfficialListVariant): boolean => {
    const seen = lastBodyAt[variant] ?? firstRequestAt[variant];
    return seen !== undefined && nowMs - seen <= responseStaleMs;
  };

  return {
    active(nowMs, variant) {
      if (variant === undefined) return requestsAlive(nowMs, 'plain') || requestsAlive(nowMs, 'json');
      return requestsAlive(nowMs, variant) && responsesAlive(nowMs, variant);
    },
    attach(variant, handler) {
      handlers.set(handler, variant);
      const chain = chains[variant];
      const complete = chain.anchored && chain.entries.length > 0;
      if (complete) for (const entry of chain.entries.slice()) handler.onResponse(entry, undefined);
      return {
        complete,
        detach() {
          handlers.delete(handler);
        },
      };
    },
    noteRequest(url, body, nowMs) {
      const variant = conversationListVariantOf(url);
      if (variant === null) return null;
      const list = times[variant];
      list.push(nowMs);
      if (list.length > 16) list.splice(0, list.length - 16);
      firstRequestAt[variant] ??= nowMs;
      const tickets = new Map<OfficialFeedHandler, unknown>();
      for (const [h, v] of handlers) if (v === variant) tickets.set(h, h.onRequest());
      return { variant, startTime: startTimeOf(body), tickets };
    },
    noteResponse(token, status, text, nowMs) {
      if (text === null) return;
      lastBodyAt[token.variant] = nowMs;
      const entry: OfficialConversationEntry = { variant: token.variant, startTime: token.startTime, full: token.startTime === null, status, text, at: nowMs };
      store(entry);
      for (const [h, v] of [...handlers]) if (v === token.variant) h.onResponse(entry, token.tickets.get(h));
    },
  };
}

/**
 * Counts every request the adapter itself sends as `adapter` traffic. The
 * adapter's `fetch` is the page's original one (captured before the hooks),
 * so this wrapper is the only place those requests are seen.
 */
export function recordAdapterFetch(ledger: TrafficLedger, inner: FetchLike, now: () => number): FetchLike {
  return (url, init) => {
    const ticket = ledger.request(url, 'adapter', now());
    const result = inner(url, init);
    if (ticket) {
      result.then(
        (r) => ledger.response(ticket, r.status, now()),
        () => ledger.response(ticket, 0, now()),
      );
    }
    return result;
  };
}

// ------------------------------------------------------------- hook tap

export interface PageTicket {
  readonly traffic: TrafficTicket | null;
  readonly feed: OfficialFeedToken | null;
  /** Only conversation-list bodies are read; other responses are logged by status alone. */
  readonly wantsBody: boolean;
}

export interface TrafficTap {
  /** Sees one request the *page* issued; never alters it. */
  onRequest(url: unknown, body: unknown): PageTicket | null;
  onResponse(ticket: PageTicket, status: number, text: string | null): void;
}

export function createTrafficTap(ledger: TrafficLedger, feed: OfficialFeedSink | null, now: () => number): TrafficTap {
  return {
    onRequest(url, body) {
      const traffic = ledger.request(url, 'official', now());
      if (traffic === null) return null;
      const token = feed && traffic.category === 'conversation_list' ? feed.noteRequest(url, body, now()) : null;
      return { traffic, feed: token, wantsBody: token !== null };
    },
    onResponse(ticket, status, text) {
      if (ticket.traffic) ledger.response(ticket.traffic, status, now());
      if (ticket.feed && feed) feed.noteResponse(ticket.feed, status, text, now());
    },
  };
}

export interface SniffedContext {
  readonly cid: string | null;
  readonly sid: string | null;
  readonly clientId: string | null;
}

export interface ContextSniffer {
  snapshot(): SniffedContext;
  /** Feed one observed request (exported for tests; the hooks call it). */
  observe(url: unknown, body: unknown): void;
  /** Resolves `true` once `cid` and `sid` are both known, `false` after the timeout. */
  waitForHead(timeoutMs: number, timers: { setTimeout(cb: () => void, ms: number): unknown }): Promise<boolean>;
}

const PLACEHOLDER = /^\{\{.*\}\}$/;
const MAX_BODY_CHARS = 512 * 1024;

function usable(x: unknown): x is string {
  return typeof x === 'string' && x !== '' && x.length <= 256 && !PLACEHOLDER.test(x);
}

function urlString(input: unknown): string | null {
  if (typeof input === 'string') return input;
  if (typeof input === 'object' && input !== null) {
    const u = (input as { url?: unknown; href?: unknown }).url ?? (input as { href?: unknown }).href;
    if (typeof u === 'string') return u;
  }
  return null;
}

export function createContextSniffer(): ContextSniffer {
  let cid: string | null = null;
  let sid: string | null = null;
  let clientId: string | null = null;
  const waiters: (() => void)[] = [];

  const settle = (): void => {
    if (cid === null || sid === null) return;
    for (const w of waiters.splice(0)) w();
  };

  return {
    snapshot: () => ({ cid, sid, clientId }),
    observe(rawUrl, body) {
      const url = urlString(rawUrl);
      if (url === null || !url.includes('/restapi/soa2/')) return;
      const q = url.indexOf('?');
      if (q >= 0) {
        for (const pair of url.slice(q + 1).split('&')) {
          const eq = pair.indexOf('=');
          if (eq < 0 || pair.slice(0, eq) !== '_fxpcqlniredt') continue;
          let v = '';
          try {
            v = decodeURIComponent(pair.slice(eq + 1));
          } catch {
            v = '';
          }
          if (usable(v)) clientId = v;
        }
      }
      if (typeof body !== 'string' || body.length > MAX_BODY_CHARS || body.charCodeAt(0) !== 123 /* { */) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        return;
      }
      const head = typeof parsed === 'object' && parsed !== null ? (parsed as { head?: unknown }).head : null;
      if (typeof head !== 'object' || head === null) return;
      const h = head as { cid?: unknown; sid?: unknown };
      if (usable(h.cid)) cid = h.cid;
      if (usable(h.sid)) sid = h.sid;
      settle();
    },
    waitForHead(timeoutMs, timers) {
      if (cid !== null && sid !== null) return Promise.resolve(true);
      return new Promise((resolve) => {
        let done = false;
        waiters.push(() => {
          if (done) return;
          done = true;
          resolve(true);
        });
        timers.setTimeout(() => {
          if (done) return;
          done = true;
          resolve(false);
        }, timeoutMs);
      });
    },
  };
}

// ------------------------------------------------------------- page hooks

/** Loose window shape: only what the hooks touch. */
export interface HookableWindow {
  fetch?: unknown;
  XMLHttpRequest?: unknown;
}

/**
 * Wraps `window.fetch` and `XMLHttpRequest.prototype.open/send` so every
 * official request is passed to `sniffer.observe` first and then forwarded
 * untouched. Observation errors are swallowed; the page's call always goes
 * through with its original arguments and `this`.
 */
export function installContextHooks(win: HookableWindow, sniffer: ContextSniffer, tap?: TrafficTap): void {
  const origFetch = win.fetch;
  if (typeof origFetch === 'function') {
    const wrapped = function (this: unknown, input: unknown, init?: unknown): unknown {
      let ticket: PageTicket | null = null;
      try {
        const body = typeof init === 'object' && init !== null ? (init as { body?: unknown }).body : undefined;
        sniffer.observe(input, body);
        ticket = tap?.onRequest(input, body) ?? null;
      } catch {
        // observation must never break the page
      }
      const result = (origFetch as (...a: unknown[]) => unknown).apply(this, arguments as unknown as unknown[]);
      if (tap && ticket) tapFetchResult(tap, ticket, result);
      return result;
    };
    win.fetch = wrapped;
  }
  const xhr = win.XMLHttpRequest as { prototype?: { open?: unknown; send?: unknown } } | undefined;
  const proto = xhr?.prototype;
  if (proto && typeof proto.open === 'function' && typeof proto.send === 'function') {
    const urls = new WeakMap<object, unknown>();
    const origOpen = proto.open as (...a: unknown[]) => unknown;
    const origSend = proto.send as (...a: unknown[]) => unknown;
    proto.open = function (this: object, _method: unknown, url: unknown): unknown {
      try {
        urls.set(this, url);
      } catch {
        // ignore
      }
      return origOpen.apply(this, arguments as unknown as unknown[]);
    };
    proto.send = function (this: object, body?: unknown): unknown {
      try {
        const url = urls.get(this);
        sniffer.observe(url, body);
        const ticket = tap?.onRequest(url, body) ?? null;
        if (tap && ticket) tapXhr(tap, ticket, this);
      } catch {
        // ignore
      }
      return origSend.apply(this, arguments as unknown as unknown[]);
    };
  }
}

/**
 * Side branch on the page's own fetch promise. It is registered before the
 * page can attach its handlers, so `Response.clone()` still sees an unread
 * body; the promise handed back to the page is the original, untouched one.
 */
function tapFetchResult(tap: TrafficTap, ticket: PageTicket, result: unknown): void {
  const then = (result as { then?: unknown } | null)?.then;
  if (typeof then !== 'function') {
    tap.onResponse(ticket, 0, null);
    return;
  }
  (then as (a: (r: unknown) => void, b: () => void) => unknown).call(
    result,
    (res: unknown) => {
      try {
        const r = res as { status?: unknown; clone?: () => { text(): Promise<string> } };
        const status = typeof r.status === 'number' ? r.status : 0;
        if (ticket.wantsBody && typeof r.clone === 'function') {
          r.clone()
            .text()
            .then(
              (text) => tap.onResponse(ticket, status, text),
              () => tap.onResponse(ticket, status, null),
            );
        } else {
          tap.onResponse(ticket, status, null);
        }
      } catch {
        // observation must never break the page
      }
    },
    () => {
      try {
        tap.onResponse(ticket, 0, null);
      } catch {
        // ignore
      }
    },
  );
}

function tapXhr(tap: TrafficTap, ticket: PageTicket, xhr: object): void {
  const target = xhr as { addEventListener?: (type: string, cb: () => void) => void; status?: unknown; responseType?: unknown; responseText?: unknown; response?: unknown };
  target.addEventListener?.('loadend', () => {
    try {
      const status = typeof target.status === 'number' ? target.status : 0;
      tap.onResponse(ticket, status, ticket.wantsBody ? xhrBodyText(target) : null);
    } catch {
      // ignore
    }
  });
}

/** Body of a finished XHR as text: `responseText` for text responses, the parsed object re-serialised for `responseType: 'json'`; `null` otherwise. */
function xhrBodyText(target: { responseType?: unknown; responseText?: unknown; response?: unknown }): string | null {
  try {
    if (target.responseType === '' || target.responseType === 'text') return typeof target.responseText === 'string' ? target.responseText : null;
    if (target.responseType === 'json') {
      const r = target.response;
      return typeof r === 'object' && r !== null ? JSON.stringify(r) : null;
    }
  } catch {
    // `responseText` throws for non-text response types; treated as unobservable
  }
  return null;
}

// ------------------------------------------------------------- context

export function readCookie(cookieHeader: string, name: string): string | null {
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const v = part.slice(eq + 1).trim();
    try {
      return v === '' ? null : decodeURIComponent(v);
    } catch {
      return v === '' ? null : v;
    }
  }
  return null;
}

export function localeFromSearch(search: string): string {
  const q = search.startsWith('?') ? search.slice(1) : search;
  for (const pair of q.split('&')) {
    const eq = pair.indexOf('=');
    if (eq < 0 || pair.slice(0, eq) !== 'lang') continue;
    let v = '';
    try {
      v = decodeURIComponent(pair.slice(eq + 1));
    } catch {
      v = '';
    }
    if (/^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})*$/.test(v)) return v;
  }
  return 'zh-CN';
}

export type PageContextResult = { readonly ok: true; readonly context: PageContext } | { readonly ok: false; readonly missing: readonly ('cid' | 'sid')[] };

/** Combines sniffed values with the documented fallbacks; never invents `sid`. */
export function buildPageContext(sniffed: SniffedContext, cookieHeader: string, search: string): PageContextResult {
  const cid = sniffed.cid ?? readCookie(cookieHeader, 'GUID') ?? readCookie(cookieHeader, 'vbk_login_cid');
  const sid = sniffed.sid;
  const missing: ('cid' | 'sid')[] = [];
  if (!cid) missing.push('cid');
  if (!sid) missing.push('sid');
  if (!cid || !sid) return { ok: false, missing };
  return {
    ok: true,
    context: {
      cid,
      sid,
      clientId: sniffed.clientId,
      locale: localeFromSearch(search),
      cookieOrigin: 'https://vbooking.ctrip.com',
    },
  };
}
