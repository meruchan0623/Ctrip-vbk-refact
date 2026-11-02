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
 */

import type { PageContext } from './deps.ts';
import { classifySoaBody, type SoaOutcome } from './soa.ts';

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

/** Body-free timing records use canonical paths, never query strings or credentials. */
export interface RequestTiming {
  readonly id: number;
  readonly path: string;
  readonly initiator: 'official' | 'adapter';
  readonly phase: 'request' | 'response';
  readonly at: number;
}
export interface ObservedRequest extends RequestTiming {
  readonly startTime: number | null;
  readonly outcome?: SoaOutcome<unknown>;
}
export interface PageRequestObserver {
  begin(url: unknown, body: unknown, initiator: 'official' | 'adapter'): ObservedRequest | null;
  complete(request: ObservedRequest, status: number, body: unknown): void;
  subscribe(cb: (event: ObservedRequest) => void): () => void;
  lastOfficial(path: string): number | null;
  latestOfficial(path: string): ObservedRequest | null;
}
const OBSERVED_PATHS = new Set(['16037/getConversationList', '16037/getConversationList.json', '16037/getRemarkList', '16037/getConversationInfoByGidList', '11679/getRecentMessages', '11679/getRecentMessages.json', '15529/getSessionEmpathyPhraseInfo', '11679/batchTranslateByMsgIds', '15529/queryToken', '14735/getOrderDetailsForVbk', '11679/PutAdviceOfReadByMsgId.json']);

export function createPageRequestObserver(now: () => number, timing?: (record: RequestTiming) => void): PageRequestObserver {
  let sequence = 0;
  const listeners = new Set<(event: ObservedRequest) => void>();
  const last = new Map<string, number>();
  const latest = new Map<string, ObservedRequest>();
  const unreadable = new Set<string>();
  const publish = (event: ObservedRequest): void => {
    try { timing?.({ id: event.id, path: event.path, initiator: event.initiator, phase: event.phase, at: event.at }); } catch { /* passive observer */ }
    for (const cb of [...listeners]) { try { cb(event); } catch { /* passive observer */ } }
  };
  return {
    begin(rawUrl, body, initiator) {
      let url: URL;
      try { url = new URL(urlString(rawUrl) ?? '', 'https://vbooking.ctrip.com'); } catch { return null; }
      // Only the already-authorized SOA hosts can contribute adapter facts.
      if (url.protocol !== 'https:' || !['m.ctrip.com', 'vbooking.ctrip.com', 'imvendor.ctrip.com', 's.c-ctrip.com'].includes(url.hostname) || (url.port !== '' && url.port !== '443')) return null;
      const path = url.pathname.startsWith('/restapi/soa2/') ? url.pathname.slice('/restapi/soa2/'.length) : url.hostname === 's.c-ctrip.com' && url.pathname === '/bee/collect' ? 'telemetry' : '';
      if (!OBSERVED_PATHS.has(path) && path !== 'telemetry') return null;
      let parsed: unknown;
      try { if (typeof body === 'string' && body.length <= MAX_BODY_CHARS) parsed = JSON.parse(body); } catch { /* unknown request cursor */ }
      const value = typeof parsed === 'object' && parsed !== null ? (parsed as { startTime?: unknown }).startTime : undefined;
      // Unknown/non-string request bodies must never be mistaken for a full snapshot.
      const startTime = typeof value === 'number' && Number.isFinite(value) ? value : parsed && typeof parsed === 'object' && !('startTime' in parsed) ? null : -1;
      const event: ObservedRequest = { id: ++sequence, path, initiator, phase: 'request', at: now(), startTime };
      if (initiator === 'official') { last.set(path, event.at); if (path.startsWith('16037/getConversationList')) latest.set(path, event); }
      publish(event);
      return event;
    },
    complete(request, status, body) {
      const outcome: SoaOutcome<unknown> = status < 200 || status >= 300 ? { kind: 'http_error', httpStatus: status } : classifySoaBody(body, status);
      const event: ObservedRequest = { ...request, phase: 'response', at: now(), outcome };
      if (request.initiator === 'official' && latest.get(request.path)?.id === request.id) {
        if (status === 0) unreadable.add(request.path); else unreadable.delete(request.path);
        latest.set(request.path, event);
      }
      publish(event);
    },
    subscribe(cb) { listeners.add(cb); return () => { listeners.delete(cb); }; },
    latestOfficial(path) { return latest.get(path) ?? null; },
    lastOfficial(path) { return unreadable.has(path) ? null : last.get(path) ?? null; },
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
export function installContextHooks(win: HookableWindow, sniffer: ContextSniffer, requests?: PageRequestObserver): void {
  const origFetch = win.fetch;
  if (typeof origFetch === 'function') {
    const wrapped = function (this: unknown, input: unknown, init?: unknown): unknown {
      let request: ObservedRequest | null = null;
      try {
        const body = typeof init === 'object' && init !== null ? (init as { body?: unknown }).body : undefined;
        sniffer.observe(input, body);
        request = requests?.begin(input, body, 'official') ?? null;
      } catch {
        // observation must never break the page
      }
      const result = (origFetch as (...a: unknown[]) => unknown).apply(this, arguments as unknown as unknown[]);
      if (request) {
        const captured = request;
        // Clone only observed responses; return the original promise/response unchanged.
        void Promise.resolve(result).then(async (response: unknown) => {
          const r = response as { status: number; clone?: () => { text(): Promise<string> } };
          if (typeof r?.clone !== 'function') { requests?.complete(captured, 0, null); return; }
          const text = await r.clone().text();
          if (text.length > MAX_BODY_CHARS) { requests?.complete(captured, 0, null); return; }
          let body: unknown;
          try { body = JSON.parse(text); } catch { body = null; }
          requests?.complete(captured, r.status, body);
        }).catch(() => requests?.complete(captured, 0, null));
      }
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
        sniffer.observe(urls.get(this), body);
      } catch {
        // ignore
      }
      return origSend.apply(this, arguments as unknown as unknown[]);
    };
  }
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
