/**
 * Adapter-side feature plug-in contract (plan I-23 / I-30 access rule 2).
 *
 * Every I-30 sub-item adds one `web-adapter/src/<feature>.ts` exporting an
 * `AdapterFeature` and one line in `ADAPTER_FEATURES` (`index.ts`, single
 * owner). Features never touch `boot.ts`, `sdkGlue.ts`, `send.ts` or
 * `conversationList.ts`; what they need from the page arrives through the
 * narrow `FeatureOpContext` below, so each one is testable under Node.
 *
 * Op names are `<feature>.<action>`. The host reaches them through
 * `adapter://request`: `rpc.ts` forwards an op that is not one of its own
 * `HANDLERS` to `FeatureDispatcher.call` with a per-request
 * `FeatureOpContext` (`serverNowMs` comes from the host's `server_now_ms`
 * argument, see `rpc.ts`). Facts (`emit`) still have no channel to the host
 * (`feature://fact` is a host integration request) and are dropped there.
 *
 * Rules every feature obeys:
 * - nothing runs at import time, no timers/polling of its own beyond what the
 *   feature documents (plan section 4 item 8);
 * - a write whose outcome is unknown is reported as `unknown`, never retried;
 * - missing page capability or unverified wire shape is `unsupported`
 *   (nothing is sent), never a guess.
 */

import type { AdapterDeps, SdkMessageEvent } from './deps.ts';
import type { PeripheralConversation } from './peripheral.ts';
import type { SoaClient } from './soa.ts';

/** Optional page-SDK capabilities a feature may use. Absent means unsupported. */
export interface FeatureSdk {
  /**
   * XMPP typing state (`<message type="input_state">`). The facade method and
   * its argument shape are NOT verified on the web page (desktop capture
   * only shows the wire frame), so the page glue must provide this after
   * verification. Resolves true when the frame was handed to the socket.
   */
  sendInputState?(req: { readonly gid: string; readonly partnerJid: string | null }): boolean | Promise<boolean>;
}

/** Facts a feature pushes towards the host/UI feature runtime (not `AdapterFact`). */
export type FeatureFact =
  | { readonly kind: 'typing'; readonly gid: string; readonly from: string; readonly until_ms: number }
  | { readonly kind: 'recalled'; readonly gid: string; readonly message_id: string }
  /** A realtime queue system message (`action` NBZ11) arrived for `gid`. */
  | { readonly kind: 'queue_notice'; readonly gid: string };

export interface FeatureOpContext {
  readonly deps: AdapterDeps;
  readonly soa: SoaClient;
  readonly sdk: FeatureSdk;
  /**
   * Anchored server time (ms) or null when no trusted sample exists. In
   * production this is the host's anchored clock passed per request as
   * `server_now_ms`; the page never substitutes its own wall clock.
   */
  serverNowMs(): number | null;
  /** In-page cached conversation row for `gid`; null when unknown. */
  conversation(gid: string): PeripheralConversation | null;
  /** The logged-in agent's uid (frames from it are never shown as "customer typing"); null while unknown. */
  selfUid(): string | null;
  emit(fact: FeatureFact): void;
}

export class FeatureOpError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.code = code;
    this.retryable = retryable;
  }
}

export type FeatureOpHandler = (args: unknown, ctx: FeatureOpContext) => Promise<unknown>;

export interface AdapterFeature {
  /** Lower-case id; also the op prefix (`recall` owns `recall.*`). */
  readonly id: string;
  readonly ops: Readonly<Record<string, FeatureOpHandler>>;
  /** Realtime frames, forwarded by the integration; must not throw or block. */
  onSdkMessage?(evt: SdkMessageEvent, ctx: FeatureOpContext): void;
  dispose?(): void;
}

export interface FeatureDispatcher {
  has(op: string): boolean;
  call(op: string, args: unknown, ctx: FeatureOpContext): Promise<unknown>;
  /** Fans a realtime frame out to every feature; a throwing feature never affects the others. */
  onSdkMessage(evt: SdkMessageEvent, ctx: FeatureOpContext): void;
  dispose(): void;
}

const OP_RE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

/** Builds a dispatcher; duplicate ids or ops outside the feature's own prefix are programming errors. */
export function createFeatureDispatcher(features: readonly AdapterFeature[]): FeatureDispatcher {
  const table = new Map<string, FeatureOpHandler>();
  const ids = new Set<string>();
  for (const f of features) {
    if (ids.has(f.id)) throw new Error(`duplicate adapter feature id: ${f.id}`);
    ids.add(f.id);
    for (const [op, handler] of Object.entries(f.ops)) {
      if (!OP_RE.test(op) || !op.startsWith(`${f.id}.`)) throw new Error(`feature ${f.id} may not register op ${op}`);
      if (table.has(op)) throw new Error(`duplicate adapter op: ${op}`);
      table.set(op, handler);
    }
  }
  return {
    has: (op) => table.has(op),
    async call(op, args, ctx) {
      const handler = table.get(op);
      if (!handler) throw new FeatureOpError('adapter.failed', `unknown feature op: ${op}`);
      return handler(args, ctx);
    },
    onSdkMessage(evt, ctx) {
      for (const f of features) {
        try {
          f.onSdkMessage?.(evt, ctx);
        } catch {
          // a feature bug must not break message delivery
        }
      }
    },
    dispose() {
      for (const f of features) f.dispose?.();
    },
  };
}

// ---------------------------------------------------------------- arg helpers

export function argRecord(args: unknown): Record<string, unknown> {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) throw new FeatureOpError('adapter.failed', 'arguments must be an object');
  return args as Record<string, unknown>;
}

export function argString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || v === '') throw new FeatureOpError('adapter.failed', `argument ${key} must be a non-empty string`);
  return v;
}

export function argNumber(args: Record<string, unknown>, key: string): number {
  const v = args[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new FeatureOpError('adapter.failed', `argument ${key} must be a finite number`);
  return v;
}

/** A conversation id on the wire: ASCII digits, bounded. */
export function validGid(gid: string): boolean {
  return /^\d{1,32}$/.test(gid);
}
