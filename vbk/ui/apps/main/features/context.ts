/**
 * FeatureContext / FeatureModule: the FROZEN plug-in contract of the main
 * window (plan I-23 "B2 start" deliverable, I-30 access rule 1).
 *
 * A sub-item adds `features/<feature>.ts` exporting a `FeatureModule` and
 * one line in `registry.ts`. It never edits `main.ts`. Everything a feature may
 * touch is on `FeatureContext`; nothing else of the window is reachable.
 *
 * Contract rules (changing any of them bumps `FEATURE_CONTEXT_VERSION` and
 * needs an integration-owner decision):
 * - `invoke` reaches ONLY the commands the module declared in `commands`, and
 *   the active account is injected by the runtime, never taken from the module
 *   (plan section 4 item 3: no generic command surface);
 * - a module never reads or writes the store directly, never schedules its own
 *   `setInterval`, and never imports another module;
 * - every promise result is re-checked against `scope()` before it is applied
 *   (account / conversation may have changed while it was in flight);
 * - `dispose` releases everything `mount` created; the runtime also drops all
 *   slots and actions registered through the context.
 */

import type { AccountContext } from '../../../packages/ipc/src/contracts.ts';
import type { UiMessage } from '../../../packages/ipc/src/client.ts';
import type { Child } from '../../../packages/ui-kit/src/h.ts';

export const FEATURE_CONTEXT_VERSION = 1 as const;

/**
 * Host event that carries `FeatureFact`s: the page emits them through
 * `adapter_push_fact` (`AdapterFact {kind: 'feature'}`), the host validates and
 * rate-limits them (`core_im::feature_rules`) and emits this event to the main
 * window only, with the account it bound to the calling webview
 * (`src-tauri/src/events.rs::FEATURE_FACT`).
 */
export const FeatureEvents = { FACT: 'feature://fact' } as const;

/** Where a feature may render. Additions are contract changes. */
export type FeatureSlotName = 'conversation-banner' | 'composer-hint';

/**
 * Facts delivered to `FeatureModule.onFact`; the adapter's `FeatureFact`
 * (contracts.ts) plus the host-injected account scope. The runtime drops a
 * fact whose account is not the active one before any module sees it.
 */
export type FeatureFact =
  | { readonly kind: 'typing'; readonly account: AccountContext; readonly gid: string; readonly from: string; readonly until_ms: number }
  | { readonly kind: 'recalled'; readonly account: AccountContext; readonly gid: string; readonly message_id: string }
  | { readonly kind: 'queue_notice'; readonly account: AccountContext; readonly gid: string };

export interface FeatureScope {
  readonly account: AccountContext;
  /** Active conversation, or null on a non-chat view. */
  readonly gid: string | null;
}

export interface DraftView {
  readonly gid: string | null;
  readonly text: string;
  /** Increments on every edit, send and conversation switch. */
  readonly version: number;
}

export interface ConfirmRequest {
  readonly title: string;
  readonly message: string;
  readonly confirmLabel: string;
  readonly cancelLabel: string;
  /** Irreversible action: the runtime renders it as dangerous and never pre-focuses confirm. */
  readonly danger: boolean;
}

export type TimerHandle = unknown;

export interface FeatureContext {
  readonly version: typeof FEATURE_CONTEXT_VERSION;
  /** Feature strings first (`strings.ts`), then the window's `t()`. Unknown keys return the key. */
  t(key: string, vars?: Readonly<Record<string, string | number>>): string;
  /** Local wall clock. */
  nowMs(): number;
  /** Anchored server time (net://clock), or null while the clock is not trusted. */
  serverNowMs(): number | null;
  /** Active online account + active conversation; null when there is none. */
  scope(): FeatureScope | null;
  /** True while `account` is still the active, online account. */
  isCurrent(account: AccountContext): boolean;
  /** Loaded messages of `gid` for the active account (read-only snapshot). */
  messages(gid: string): readonly UiMessage[];
  draft(): DraftView;
  /** Calls one of the module's declared commands; the active account is injected. Rejects otherwise. */
  invoke<T>(command: string, args?: Readonly<Record<string, unknown>>): Promise<T>;
  confirm(request: ConfirmRequest): Promise<boolean>;
  toast(text: string): void;
  /** Re-render the window (slots are pulled during render). */
  requestRender(): void;
  /** Store changes (batched). Returns unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** True while the window is visible; background work must check it before every tick (no hidden-window polling). */
  visible(): boolean;
  /** One-shot timer owned by the runtime; every pending timer is cleared on `dispose`. */
  setTimer(callback: () => void, ms: number): TimerHandle;
  clearTimer(handle: TimerHandle): void;
  /** Render function pulled while the window renders; one per (module, slot). */
  registerSlot(slot: FeatureSlotName, render: (scope: FeatureScope) => Child): void;
  /** Per-message action button (consumed by the message area once it renders `runtime.messageActions`). */
  registerMessageAction(action: MessageAction): void;
}

export interface MessageAction {
  readonly id: string;
  readonly label: (message: UiMessage) => string;
  /** Pure visibility predicate; must be cheap (called per rendered message). */
  readonly visible: (message: UiMessage, scope: FeatureScope) => boolean;
  readonly run: (message: UiMessage, scope: FeatureScope) => void | Promise<void>;
}

export interface FeatureModule {
  /** Lower-case kebab id, unique. */
  readonly id: string;
  /** Host commands this module may invoke (names from the frozen command list or an approved change request). */
  readonly commands: readonly string[];
  mount(ctx: FeatureContext): void;
  onFact?(fact: FeatureFact): void;
  dispose(): void;
}
