/**
 * Page-side entry injected by the host as `initialization_script` into the
 * per-account `acct-*` webviews (bundled to `ui/bundle/adapter/boot.js`).
 * It runs on every navigation, at document start, in every page the
 * webview loads — so the first thing it does is decide whether to do
 * anything at all:
 *
 *   only `https://vbooking.ctrip.com/vbk/im/main` (top frame) boots;
 *   every other page — the login page in particular — returns immediately
 *   without touching globals, network or the host.
 *
 * Boot order on the IM page:
 *   1. install the read-only request-context sniffer (before page scripts run);
 *   2. resolve the Tauri bridge (`__TAURI__` or `__TAURI_INTERNALS__`), listen
 *      for `adapter://request` (answered `adapter.not_ready` until started);
 *   3. `adapter_ready` → ack (account or null, watermark, epoch);
 *   4. wait for `cid`/`sid`, read identity (`identity.ts`, bounded retries),
 *      `adapter_identity`, then `adapter_ready` again until the host binds
 *      the account;
 *   5. wait (bounded) for the official SDK's xmpp client;
 *   6. build real `AdapterDeps` and start the page session.
 *
 * Invariants: no cookies/tickets/bodies are logged; the remote page gets
 * no generic IPC (only the five `adapter_*` commands and the event
 * listener, enforced by `capabilities/adapter.json`).
 */

import type { AccountContext } from '../../ipc/src/contracts.ts';
import { AdapterCommands, AdapterEvents, type AdapterDisplayPayload, type AdapterReadyAck, type AdapterReadyPayload, type AdapterReplyPayload } from '../../ipc/src/adapterProtocol.ts';
import { ImCommands } from '../../ipc/src/commands.ts';
import type { AdapterDeps, FetchLike, ImSdkHandle } from './deps.ts';
import { Endpoints } from './endpoints.ts';
import { sdkHead } from './heads.ts';
import { SoaClient } from './soa.ts';
import { readIdentity } from './identity.ts';
import { buildPageContext, createContextSniffer, installContextHooks, type ContextSniffer } from './pageContext.ts';
import { createPageSdk, type PageSdk } from './sdkGlue.ts';
import { createPageSession, type PageSession } from './session.ts';
import { notReadyReply } from './rpc.ts';

export const OFFICIAL_IM_ORIGIN = 'https://vbooking.ctrip.com';
export const OFFICIAL_IM_PATH = '/vbk/im/main';
const LOG_PREFIX = '[vbk-adapter]';
const BOOT_FLAG = '__VBK_ADAPTER_BOOTED__';

// ------------------------------------------------------------- path guard

export interface LocationLike {
  readonly protocol: string;
  readonly hostname: string;
  readonly port?: string;
  readonly pathname: string;
}

/** True only for the official vbooking IM page (exact origin, exact path, optional trailing slash). */
export function isOfficialImPage(loc: LocationLike | null | undefined): boolean {
  if (!loc) return false;
  if (loc.protocol !== 'https:' || loc.hostname !== 'vbooking.ctrip.com') return false;
  if (loc.port !== undefined && loc.port !== '' && loc.port !== '443') return false;
  return loc.pathname === OFFICIAL_IM_PATH || loc.pathname === `${OFFICIAL_IM_PATH}/`;
}

// ------------------------------------------------------------- host bridge

export interface HostBridge {
  invoke(cmd: string, args: unknown): Promise<unknown>;
  listen(event: string, cb: (payload: unknown) => void): Promise<() => void>;
}

type InvokeFn = (cmd: string, args?: unknown) => Promise<unknown>;

interface TauriGlobals {
  readonly __TAURI__?: { readonly core?: { readonly invoke?: unknown }; readonly event?: { readonly listen?: unknown } };
  readonly __TAURI_INTERNALS__?: { readonly invoke?: unknown; readonly transformCallback?: unknown };
  readonly __TAURI_EVENT_PLUGIN_INTERNALS__?: { readonly unregisterListener?: unknown };
}

/**
 * Resolves invoke/listen from whatever the webview exposes. Remote pages
 * usually have only `__TAURI_INTERNALS__` (no `withGlobalTauri` API
 * object), so `listen` falls back to the event plugin command
 * `plugin:event|listen` with a `transformCallback` handler — the same
 * calls `@tauri-apps/api/event` makes. Returns `null` when neither exists.
 */
export function resolveHostBridge(win: unknown): HostBridge | null {
  const w = (typeof win === 'object' && win !== null ? win : {}) as TauriGlobals;
  const api = w.__TAURI__;
  const internals = w.__TAURI_INTERNALS__;
  const invoke: InvokeFn | null =
    typeof api?.core?.invoke === 'function' ? (api.core.invoke as InvokeFn) : typeof internals?.invoke === 'function' ? (internals.invoke as InvokeFn).bind(internals) : null;
  if (!invoke) return null;
  const apiListen = typeof api?.event?.listen === 'function' ? (api.event.listen as (e: string, h: (ev: { payload: unknown }) => void) => Promise<() => void>) : null;
  const transform = typeof internals?.transformCallback === 'function' ? (internals.transformCallback as (cb: (ev: unknown) => void, once?: boolean) => number) : null;
  if (!apiListen && !transform) return null;
  return {
    invoke: (cmd, args) => {
      try {
        return Promise.resolve(invoke(cmd, args));
      } catch (e: unknown) {
        return Promise.reject(e);
      }
    },
    async listen(event, cb) {
      if (apiListen) return apiListen(event, (ev) => cb(ev?.payload));
      const handler = (transform as (cb: (ev: unknown) => void, once?: boolean) => number)((ev: unknown) => {
        cb(typeof ev === 'object' && ev !== null ? (ev as { payload?: unknown }).payload : undefined);
      });
      const eventId = await invoke('plugin:event|listen', { event, target: { kind: 'Any' }, handler });
      return () => {
        try {
          const unreg = w.__TAURI_EVENT_PLUGIN_INTERNALS__?.unregisterListener;
          if (typeof unreg === 'function') (unreg as (e: string, id: unknown) => void)(event, eventId);
        } catch {
          // ignore
        }
        void Promise.resolve(invoke('plugin:event|unlisten', { event, eventId })).catch(() => undefined);
      };
    },
  };
}

/**
 * Argument object per adapter command (Tauri named args). `adapter_push_fact`
 * mirrors `im_push_fact(envelope)`; the other four take `payload`.
 * See the contract request in the M3 report.
 */
export function hostArgs(cmd: string, payload: unknown): Record<string, unknown> {
  return cmd === AdapterCommands.PUSH_FACT ? { envelope: payload } : { payload };
}

// ------------------------------------------------------------- boot

export interface BootWindow {
  readonly location: LocationLike & { readonly href: string; readonly origin?: string; readonly search: string };
  readonly document?: { readonly cookie?: string };
  readonly top?: unknown;
  readonly self?: unknown;
  fetch?: unknown;
  XMLHttpRequest?: unknown;
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  addEventListener?(type: string, cb: () => void): void;
  [key: string]: unknown;
}

export interface BootLogger {
  info(msg: string): void;
  error(msg: string): void;
}

export interface BootOptions {
  readonly logger?: BootLogger;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly contextTimeoutMs?: number;
  readonly sdkTimeoutMs?: number;
  readonly identityAttempts?: number;
  readonly identityRetryDelayMs?: number;
  readonly bindAttempts?: number;
  readonly bindDelayMs?: number;
}

export type BootResult =
  | { readonly kind: 'skipped'; readonly reason: 'not_im_page' | 'not_top_frame' | 'already_booted' }
  | { readonly kind: 'no_host' }
  | { readonly kind: 'failed'; readonly step: string }
  | { readonly kind: 'started'; readonly session: PageSession };

function consoleLogger(): BootLogger {
  const c = (globalThis as { console?: { info?: (...a: unknown[]) => void; error?: (...a: unknown[]) => void } }).console;
  return {
    info: (m) => c?.info?.(`${LOG_PREFIX} ${m}`),
    error: (m) => c?.error?.(`${LOG_PREFIX} ${m}`),
  };
}

function sleep(win: BootWindow, ms: number): Promise<void> {
  return new Promise((resolve) => {
    win.setTimeout(resolve, ms);
  });
}

function asAck(x: unknown): AdapterReadyAck | null {
  if (typeof x !== 'object' || x === null) return null;
  const r = x as { account?: unknown; begin_msg_time?: unknown; initial_epoch?: unknown };
  if (!('account' in r)) return null;
  return {
    account: asAccount(r.account),
    begin_msg_time: typeof r.begin_msg_time === 'number' && Number.isFinite(r.begin_msg_time) ? r.begin_msg_time : 0,
    initial_epoch: typeof r.initial_epoch === 'number' && Number.isInteger(r.initial_epoch) && r.initial_epoch > 0 ? r.initial_epoch : 1,
  };
}

function asAccount(x: unknown): AccountContext | null {
  if (typeof x !== 'object' || x === null) return null;
  const a = x as { account_id?: unknown; environment?: unknown; session_generation?: unknown };
  if (typeof a.account_id !== 'string' || a.account_id === '' || typeof a.session_generation !== 'number') return null;
  return x as AccountContext;
}

/** Location without query/fragment (the host only needs origin + path). */
function pageUrl(loc: BootWindow['location']): string {
  return `${loc.protocol}//${loc.hostname}${loc.port ? `:${loc.port}` : ''}${loc.pathname}`;
}

interface RequestDispatcher {
  setSession(session: PageSession | null): void;
}

function startRequestListener(host: HostBridge, logger: BootLogger): RequestDispatcher {
  let session: PageSession | null = null;
  const reply = (r: AdapterReplyPayload | null): void => {
    if (!r) return;
    host.invoke(AdapterCommands.REPLY, hostArgs(AdapterCommands.REPLY, r)).catch(() => logger.error('adapter_reply failed'));
  };
  host
    .listen(AdapterEvents.REQUEST, (payload) => {
      if (!session) {
        reply(notReadyReply(payload));
        return;
      }
      void session.rpc.handle(payload).then(reply, () => reply(notReadyReply(payload)));
    })
    .catch(() => logger.error('cannot listen for adapter://request (event permission missing?)'));
  return {
    setSession(s) {
      session = s;
    },
  };
}

export async function boot(win: BootWindow, opts: BootOptions = {}): Promise<BootResult> {
  // ---- 0. path / frame guard: nothing else runs on other pages
  if (!isOfficialImPage(win.location)) return { kind: 'skipped', reason: 'not_im_page' };
  if (win.top !== undefined && win.self !== undefined && win.top !== win.self) return { kind: 'skipped', reason: 'not_top_frame' };
  if (win[BOOT_FLAG] === true) return { kind: 'skipped', reason: 'already_booted' };
  win[BOOT_FLAG] = true;

  const logger = opts.logger ?? consoleLogger();
  const now = opts.now ?? (() => Date.now());
  const random = opts.random ?? (() => Math.random());

  // ---- 1. host bridge (sync), then the sniffer — both before the page's own scripts issue requests
  const host = resolveHostBridge(win);
  if (!host) {
    logger.error('Tauri bridge not found (__TAURI__ / __TAURI_INTERNALS__); adapter disabled');
    return { kind: 'no_host' };
  }
  const rawFetch = win.fetch;
  const sniffer: ContextSniffer = createContextSniffer();
  installContextHooks(win, sniffer);

  // ---- 2. request listener
  const dispatcher = startRequestListener(host, logger);
  const call = (cmd: string, payload: unknown): Promise<unknown> => host.invoke(cmd, hostArgs(cmd, payload));

  const timers = { setTimeout: (cb: () => void, ms: number) => win.setTimeout(cb, ms), clearTimeout: (h: unknown) => win.clearTimeout(h) };
  const sdk: PageSdk = createPageSdk(win, {
    ...timers,
    now,
    log: (m) => logger.info(m),
    httpReadReceipt: async (req) => {
      const outcome = await soa.post<unknown>(Endpoints.PUT_ADVICE_READ_BY_MSG_ID, { partnerJid: req.partnerJid, msgId: req.msgId, type: req.conversationType, head: sdkHead(deps.context) });
      if (outcome.kind === 'success') return { kind: 'success', raw: null };
      if (outcome.kind === 'unknown') throw new Error('read receipt outcome unknown');
      return { kind: 'failure', raw: outcome.kind };
    },
  });

  if (typeof rawFetch !== 'function') {
    logger.error('window.fetch missing; adapter disabled');
    return { kind: 'failed', step: 'fetch' };
  }
  const fetchImpl = rawFetch as (url: string, init: unknown) => Promise<{ status: number; text(): Promise<string> }>;
  const fetchLike: FetchLike = (url, init) => fetchImpl.call(win, url, init);

  // ---- 3. ready
  const readyPayload: AdapterReadyPayload = { url: pageUrl(win.location), sdk_version: null };
  let ack: AdapterReadyAck | null = null;
  try {
    ack = asAck(await call(AdapterCommands.READY, readyPayload));
  } catch {
    logger.error('adapter_ready rejected');
    return { kind: 'failed', step: 'ready' };
  }
  if (!ack) {
    logger.error('adapter_ready returned an unexpected shape');
    return { kind: 'failed', step: 'ready' };
  }

  // ---- 4. context + identity
  const contextReady = await sniffer.waitForHead(opts.contextTimeoutMs ?? 30_000, timers);
  const ctxResult = buildPageContext(sniffer.snapshot(), String(win.document?.cookie ?? ''), win.location.search);
  if (!ctxResult.ok) {
    logger.error(`request context incomplete after waiting (missing ${ctxResult.missing.join(', ')}; head observed: ${contextReady})`);
    return { kind: 'failed', step: 'context' };
  }
  const invokeForAdapter = (cmd: string, payload: unknown): Promise<unknown> => (cmd === ImCommands.PUSH_FACT ? call(AdapterCommands.PUSH_FACT, payload) : call(cmd, payload));
  const deps: AdapterDeps = {
    fetch: fetchLike,
    now,
    random,
    ...timers,
    context: ctxResult.context,
    sdk: sdk as ImSdkHandle,
    invoke: invokeForAdapter,
  };
  const soa = new SoaClient(deps);

  const identity = await readIdentity(deps, soa, {
    ...(opts.identityAttempts !== undefined ? { attempts: opts.identityAttempts } : {}),
    ...(opts.identityRetryDelayMs !== undefined ? { retryDelayMs: opts.identityRetryDelayMs } : {}),
  });
  if (identity.kind === 'auth_invalid') {
    logger.error('identity read: not logged in (auth invalid)');
    return { kind: 'failed', step: 'identity_auth' };
  }
  if (identity.kind === 'failed') {
    logger.error(`identity read failed at ${identity.step} (${identity.detail})`);
    return { kind: 'failed', step: 'identity' };
  }
  let account: AccountContext | null = ack.account;
  try {
    const r = await call(AdapterCommands.IDENTITY, identity.identity);
    account = asAccount(r) ?? asAck(r)?.account ?? account;
    const rAck = asAck(r);
    if (rAck?.account) ack = rAck;
  } catch {
    logger.error('adapter_identity rejected');
    return { kind: 'failed', step: 'identity_publish' };
  }
  for (let i = 0; account === null && i < (opts.bindAttempts ?? 10); i++) {
    await sleep(win, opts.bindDelayMs ?? 1000);
    try {
      const again = asAck(await call(AdapterCommands.READY, readyPayload));
      if (again?.account) {
        ack = again;
        account = again.account;
      }
    } catch {
      // keep trying within the bound
    }
  }
  if (account === null) {
    logger.error('host did not bind an account to this webview');
    return { kind: 'failed', step: 'bind' };
  }
  logger.info('identity published, account bound');

  // ---- 5. SDK (bounded wait; HTTP loops run even without it)
  const sdkReady = await sdk.waitReady(opts.sdkTimeoutMs ?? 30_000);
  if (!sdkReady) logger.error('official IM SDK (window.xmppClient) not found yet; realtime facts start once it appears');
  if (!sdk.canSend) logger.info('SDK send entry not found; im.send_text will answer host.unsupported');

  // ---- 6. session
  const session = createPageSession(deps, {
    account,
    selfUid: identity.identity.uid,
    selfProfile: identity.selfProfile,
    beginMsgTime: ack.begin_msg_time,
    initialEpoch: ack.initial_epoch,
    sdk,
    pushDisplay: (payload: AdapterDisplayPayload) => call(AdapterCommands.PUSH_DISPLAY, payload),
    log: (m) => logger.info(m),
  });
  session.start();
  dispatcher.setSession(session);
  win.addEventListener?.('pagehide', () => {
    dispatcher.setSession(null);
    session.stop();
    sdk.dispose();
  });
  return { kind: 'started', session };
}

// ------------------------------------------------------------- auto-run (bundle entry)

const pageWindow = (globalThis as { window?: unknown }).window;
if (typeof pageWindow === 'object' && pageWindow !== null && 'location' in pageWindow) {
  void boot(pageWindow as BootWindow).catch(() => consoleLogger().error('boot crashed'));
}
