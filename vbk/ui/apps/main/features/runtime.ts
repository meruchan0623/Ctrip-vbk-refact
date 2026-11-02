/**
 * Feature runtime: builds one scoped `FeatureContext` per module and pulls
 * their slots/actions during render. Pure TypeScript with no DOM access, so
 * it is unit-tested under Node; `main.ts` supplies the primitives through
 * `RuntimeHost` (the only wiring it needs).
 */

import type { AccountContext } from '../../../packages/ipc/src/contracts.ts';
import type { UiMessage } from '../../../packages/ipc/src/client.ts';
import type { Child } from '../../../packages/ui-kit/src/h.ts';
import {
  FEATURE_CONTEXT_VERSION,
  type ConfirmRequest,
  type DraftView,
  type FeatureContext,
  type FeatureFact,
  type FeatureModule,
  type FeatureScope,
  type FeatureSlotName,
  type MessageAction,
  type TimerHandle,
} from './context.ts';
import { featureText, hasFeatureString } from './strings.ts';

export interface RuntimeHost {
  /** Window-level translation; returns null for unknown keys. */
  t(key: string, vars?: Readonly<Record<string, string | number>>): string | null;
  nowMs(): number;
  serverNowMs(): number | null;
  scope(): FeatureScope | null;
  isCurrent(account: AccountContext): boolean;
  messages(gid: string): readonly UiMessage[];
  draft(): DraftView;
  invoke(command: string, payload: Record<string, unknown>): Promise<unknown>;
  confirm(request: ConfirmRequest): Promise<boolean>;
  toast(text: string): void;
  requestRender(): void;
  subscribe(listener: () => void): () => void;
  visible(): boolean;
  setTimeout(callback: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

export interface FeatureRuntime {
  start(): void;
  stop(): void;
  onFact(fact: unknown): void;
  /** Children for one slot, in registration order; a throwing renderer yields nothing. */
  renderSlot(slot: FeatureSlotName): Child[];
  /** Actions whose `visible` predicate holds for this message. */
  messageActions(message: UiMessage): MessageAction[];
  /** Ids of modules that mounted; failed ones are listed in `failures`. */
  readonly mounted: readonly string[];
  readonly failures: ReadonlyMap<string, string>;
}

const ID_RE = /^[a-z][a-z0-9-]{0,40}$/;
const COMMAND_RE = /^[a-z][a-z0-9_]{0,60}$/;

interface Registration {
  readonly slots: Map<FeatureSlotName, (scope: FeatureScope) => Child>;
  readonly actions: MessageAction[];
  readonly unsubscribes: (() => void)[];
  readonly timers: Set<TimerHandle>;
}

export function isFeatureFact(x: unknown): x is FeatureFact {
  if (typeof x !== 'object' || x === null) return false;
  const f = x as Record<string, unknown>;
  const acc = f['account'] as Record<string, unknown> | null | undefined;
  if (typeof acc !== 'object' || acc === null || typeof acc['account_id'] !== 'string' || typeof acc['environment'] !== 'string' || typeof acc['session_generation'] !== 'number') return false;
  if (typeof f['gid'] !== 'string' || f['gid'] === '') return false;
  if (f['kind'] === 'typing') return typeof f['from'] === 'string' && typeof f['until_ms'] === 'number' && Number.isFinite(f['until_ms']);
  if (f['kind'] === 'recalled') return typeof f['message_id'] === 'string' && f['message_id'] !== '';
  return f['kind'] === 'queue_notice';
}

export function createFeatureRuntime(modules: readonly FeatureModule[], host: RuntimeHost): FeatureRuntime {
  const seen = new Set<string>();
  for (const m of modules) {
    if (!ID_RE.test(m.id)) throw new Error(`invalid feature id: ${m.id}`);
    if (seen.has(m.id)) throw new Error(`duplicate feature id: ${m.id}`);
    seen.add(m.id);
    for (const c of m.commands) if (!COMMAND_RE.test(c)) throw new Error(`feature ${m.id}: invalid command name ${c}`);
  }

  const regs = new Map<string, Registration>();
  const mounted: string[] = [];
  const failures = new Map<string, string>();
  let running = false;

  function contextFor(module: FeatureModule, reg: Registration): FeatureContext {
    const allowed = new Set(module.commands);
    return {
      version: FEATURE_CONTEXT_VERSION,
      t: (key, vars) => (hasFeatureString(key) ? featureText(key, vars) : (host.t(key, vars) ?? key)),
      nowMs: () => host.nowMs(),
      serverNowMs: () => host.serverNowMs(),
      scope: () => host.scope(),
      isCurrent: (account) => host.isCurrent(account),
      messages: (gid) => host.messages(gid),
      draft: () => host.draft(),
      invoke: <T>(command: string, args: Readonly<Record<string, unknown>> = {}): Promise<T> => {
        if (!allowed.has(command)) return Promise.reject(new Error(`feature ${module.id} may not call ${command}`));
        const scope = host.scope();
        if (!scope) return Promise.reject(new Error('no active account'));
        // account last: a module cannot aim a command at another account
        return host.invoke(command, { ...args, account: scope.account }) as Promise<T>;
      },
      confirm: (request) => host.confirm(request),
      toast: (text) => host.toast(text),
      requestRender: () => {
        if (running) host.requestRender();
      },
      subscribe: (listener) => {
        const off = host.subscribe(listener);
        reg.unsubscribes.push(off);
        return off;
      },
      visible: () => host.visible(),
      setTimer: (callback, ms) => {
        const handle = host.setTimeout(() => {
          reg.timers.delete(handle);
          if (running) callback();
        }, ms);
        reg.timers.add(handle);
        return handle;
      },
      clearTimer: (handle) => {
        reg.timers.delete(handle);
        host.clearTimeout(handle);
      },
      registerSlot: (slot, render) => {
        reg.slots.set(slot, render);
      },
      registerMessageAction: (action) => {
        if (!reg.actions.some((a) => a.id === action.id)) reg.actions.push(action);
      },
    };
  }

  function release(id: string): void {
    const reg = regs.get(id);
    if (!reg) return;
    for (const off of reg.unsubscribes.splice(0)) {
      try {
        off();
      } catch {
        // ignore: releasing must always finish
      }
    }
    for (const t of reg.timers) host.clearTimeout(t);
    reg.timers.clear();
    reg.slots.clear();
    reg.actions.length = 0;
  }

  return {
    mounted,
    failures,
    start() {
      if (running) return;
      running = true;
      for (const m of modules) {
        const reg: Registration = { slots: new Map(), actions: [], unsubscribes: [], timers: new Set() };
        regs.set(m.id, reg);
        try {
          m.mount(contextFor(m, reg));
          mounted.push(m.id);
        } catch (e) {
          failures.set(m.id, e instanceof Error ? e.message : String(e));
          try {
            m.dispose();
          } catch {
            // a half-mounted module must not take the window down
          }
          release(m.id);
        }
      }
    },
    stop() {
      if (!running) return;
      running = false;
      for (const m of modules) {
        try {
          m.dispose();
        } catch {
          // keep releasing the rest
        }
        release(m.id);
      }
      mounted.length = 0;
    },
    onFact(fact) {
      if (!running || !isFeatureFact(fact)) return;
      for (const m of modules) {
        if (!mounted.includes(m.id)) continue;
        try {
          m.onFact?.(fact);
        } catch {
          // a faulty module never blocks the others
        }
      }
    },
    renderSlot(slot) {
      const scope = host.scope();
      if (!running || !scope) return [];
      const out: Child[] = [];
      for (const m of modules) {
        const render = regs.get(m.id)?.slots.get(slot);
        if (!render || !mounted.includes(m.id)) continue;
        try {
          const node = render(scope);
          if (node !== null && node !== undefined && node !== false) out.push(node);
        } catch {
          // a throwing renderer shows nothing
        }
      }
      return out;
    },
    messageActions(message) {
      const scope = host.scope();
      if (!running || !scope) return [];
      const out: MessageAction[] = [];
      for (const m of modules) {
        if (!mounted.includes(m.id)) continue;
        for (const a of regs.get(m.id)?.actions ?? []) {
          try {
            if (a.visible(message, scope)) out.push(a);
          } catch {
            // hidden on error
          }
        }
      }
      return out;
    },
  };
}
