/**
 * SOA client for `https://{host}/restapi/soa2/{path}` POSTs from inside the
 * official page (docs/api/authentication.md "SOA：Cookie、请求头和业务结果").
 *
 * Classification rules (never trust HTTP 200 alone):
 * - `ResponseStatus.Ack === 'Success'` → `success`
 * - `Ack === 'Failure'` with `ErrorCode === 'AccountsMobileRequestFilterException'`
 *   → `auth_invalid` (observed when cookies were omitted, evidence 43)
 * - any other `Failure` → `business_failure` with the error list
 * - non-2xx → `http_error`; unparsable JSON → `malformed`
 * - no response within the timeout → `timeout` for reads, `unknown` for
 *   writes (a write may have been applied; caller must read back)
 * - reads may retry once on a transport error; writes never auto-retry.
 *
 * Server time: `ResponseStatus.Timestamp` is `/Date(<ms>+0800)/`; the client
 * reports `{server_ms, received_at_ms}` through `onServerTime` so the host
 * clock service can anchor itself. Nothing here logs bodies or cookies.
 */

import type { AdapterDeps, FetchInit } from './deps.ts';

export type SideEffect = 'read' | 'write' | 'may_create_conversation';

export interface EndpointSpec {
  readonly name: string;
  readonly host: string;
  /** e.g. `16037/getConversationList` or `16037/getConversationList.json` — distinct specs. */
  readonly path: string;
  readonly sideEffect: SideEffect;
}

export function endpoint(name: string, host: string, path: string, sideEffect: SideEffect): EndpointSpec {
  return { name, host, path, sideEffect };
}

export interface SoaError {
  readonly ErrorCode: string | null;
  readonly Message: string | null;
  readonly SeverityCode: string | null;
  readonly ErrorClassification: string | null;
}

export type SoaOutcome<T> =
  | { readonly kind: 'success'; readonly body: T; readonly httpStatus: number }
  | { readonly kind: 'business_failure'; readonly ack: string; readonly errors: readonly SoaError[]; readonly body: unknown }
  | { readonly kind: 'auth_invalid'; readonly errors: readonly SoaError[] }
  | { readonly kind: 'http_error'; readonly httpStatus: number }
  | { readonly kind: 'malformed'; readonly detail: string }
  | { readonly kind: 'network_error'; readonly detail: string }
  | { readonly kind: 'timeout' }
  /** Write that got no classified answer: may or may not have been applied. */
  | { readonly kind: 'unknown'; readonly detail: string };

export interface ServerTimeSample {
  readonly server_ms: number;
  readonly received_at_ms: number;
}

export interface SoaClientOptions {
  readonly defaultTimeoutMs?: number;
  readonly onServerTime?: (sample: ServerTimeSample) => void;
}

export interface PostOptions {
  readonly timeoutMs?: number;
  /** Extra HTTP headers (never cookies/authorization). */
  readonly headers?: Readonly<Record<string, string>>;
}

export const AUTH_INVALID_ERROR_CODE = 'AccountsMobileRequestFilterException';
export const DEFAULT_TIMEOUT_MS = 15000;

const DATE_RE = /^\/Date\((-?\d+)([+-]\d{4})?\)\/$/;

/** `/Date(1700000000000+0800)/` → 1700000000000; `null` when not that shape. */
export function parseSoaTimestamp(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const m = DATE_RE.exec(v);
  if (!m) return null;
  const ms = Number(m[1]);
  return Number.isFinite(ms) ? ms : null;
}

export function traceId(clientId: string, nowMs: number, random: number): string {
  return `${clientId}-${nowMs}-${Math.floor(1e7 * random)}`;
}

export function buildSoaUrl(spec: EndpointSpec, ctx: AdapterDeps['context'], nowMs: number, random: number): string {
  const base = `https://${spec.host}/restapi/soa2/${spec.path}`;
  const t = ctx.clientId;
  if (t === null || t === '') return base;
  const q = `_fxpcqlniredt=${encodeURIComponent(t)}&x-traceID=${encodeURIComponent(traceId(t, nowMs, random))}`;
  return `${base}?${q}`;
}

export function soaHeaders(ctx: AdapterDeps['context'], extra?: Readonly<Record<string, string>>): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-tour-auth-from': 'vbk_online',
    cookieOrigin: ctx.cookieOrigin,
    'x-ctx-Locale': ctx.locale,
    'x-ctx-Currency': ctx.currency ?? 'CNY',
    'x-ctx-Country': ctx.country ?? 'CN',
    ...(extra ?? {}),
  };
}

function asRecord(x: unknown): Record<string, unknown> | null {
  return typeof x === 'object' && x !== null && !Array.isArray(x) ? (x as Record<string, unknown>) : null;
}

function str(x: unknown): string | null {
  return typeof x === 'string' ? x : null;
}

export function readSoaErrors(responseStatus: Record<string, unknown>): SoaError[] {
  const raw = responseStatus['Errors'];
  if (!Array.isArray(raw)) return [];
  const out: SoaError[] = [];
  for (const e of raw) {
    const r = asRecord(e);
    if (!r) continue;
    out.push({
      ErrorCode: str(r['ErrorCode']),
      Message: str(r['Message']),
      SeverityCode: str(r['SeverityCode']),
      ErrorClassification: str(r['ErrorClassification']),
    });
  }
  return out;
}

/** Pure classification of an already-parsed JSON body. */
export function classifySoaBody<T>(body: unknown, httpStatus: number): SoaOutcome<T> {
  const rec = asRecord(body);
  if (!rec) return { kind: 'malformed', detail: 'body is not an object' };
  const rs = asRecord(rec['ResponseStatus']);
  if (!rs) return { kind: 'malformed', detail: 'missing ResponseStatus' };
  const ack = str(rs['Ack']) ?? '';
  if (ack === 'Success') return { kind: 'success', body: body as T, httpStatus };
  const errors = readSoaErrors(rs);
  if (errors.some((e) => e.ErrorCode === AUTH_INVALID_ERROR_CODE)) return { kind: 'auth_invalid', errors };
  return { kind: 'business_failure', ack, errors, body };
}

interface Raced<T> {
  readonly timedOut: boolean;
  readonly value?: T;
  readonly error?: unknown;
}

function raceTimeout<T>(deps: AdapterDeps, p: Promise<T>, ms: number): Promise<Raced<T>> {
  return new Promise((resolve) => {
    let settled = false;
    const handle = deps.setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ timedOut: true });
    }, ms);
    p.then(
      (value) => {
        if (settled) return;
        settled = true;
        deps.clearTimeout(handle);
        resolve({ timedOut: false, value });
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        deps.clearTimeout(handle);
        resolve({ timedOut: false, error });
      },
    );
  });
}

function errorDetail(e: unknown): string {
  if (e instanceof Error) return e.name;
  return typeof e === 'string' ? e : 'error';
}

export class SoaClient {
  readonly #deps: AdapterDeps;
  readonly #opts: SoaClientOptions;

  constructor(deps: AdapterDeps, opts: SoaClientOptions = {}) {
    this.#deps = deps;
    this.#opts = opts;
  }

  async post<T>(spec: EndpointSpec, body: unknown, opts: PostOptions = {}): Promise<SoaOutcome<T>> {
    const isWrite = spec.sideEffect !== 'read';
    const first = await this.#attempt<T>(spec, body, opts);
    if (isWrite) {
      if (first.kind === 'timeout') return { kind: 'unknown', detail: 'timeout' };
      if (first.kind === 'network_error') return { kind: 'unknown', detail: first.detail };
      return first;
    }
    if (first.kind === 'network_error') {
      // reads: one retry on a transport error only
      return this.#attempt<T>(spec, body, opts);
    }
    return first;
  }

  async #attempt<T>(spec: EndpointSpec, body: unknown, opts: PostOptions): Promise<SoaOutcome<T>> {
    const deps = this.#deps;
    const url = buildSoaUrl(spec, deps.context, deps.now(), deps.random());
    const init: FetchInit = {
      method: 'POST',
      headers: soaHeaders(deps.context, opts.headers),
      body: JSON.stringify(body),
      credentials: 'include',
    };
    const timeoutMs = opts.timeoutMs ?? this.#opts.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;

    const exchange = (async () => {
      const res = await deps.fetch(url, init);
      const text = await res.text();
      return { status: res.status, text };
    })();

    const raced = await raceTimeout(deps, exchange, timeoutMs);
    if (raced.timedOut) return { kind: 'timeout' };
    if (raced.error !== undefined || raced.value === undefined) {
      return { kind: 'network_error', detail: errorDetail(raced.error) };
    }
    const { status, text } = raced.value;
    const receivedAt = deps.now();
    if (status < 200 || status >= 300) return { kind: 'http_error', httpStatus: status };

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { kind: 'malformed', detail: 'invalid json' };
    }
    this.#reportServerTime(parsed, receivedAt);
    return classifySoaBody<T>(parsed, status);
  }

  #reportServerTime(parsed: unknown, receivedAt: number): void {
    const cb = this.#opts.onServerTime;
    if (!cb) return;
    const rs = asRecord(asRecord(parsed)?.['ResponseStatus']);
    const ms = parseSoaTimestamp(rs?.['Timestamp']);
    if (ms !== null) cb({ server_ms: ms, received_at_ms: receivedAt });
  }
}

/** `bizResponseStatus.resultCode === 'SUCCESS'` gate shared by several 16037 endpoints. */
export function bizResultCode(body: unknown): string | null {
  const biz = asRecord(asRecord(body)?.['bizResponseStatus']);
  return str(biz?.['resultCode']);
}

export function isBizSuccess(body: unknown): boolean {
  return bizResultCode(body) === 'SUCCESS';
}

export { asRecord as recordOrNull };
