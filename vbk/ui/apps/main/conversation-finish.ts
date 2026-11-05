/**
 * Direct and batch「结束会话」. Each conversation is ended with the same two-step
 * protocol as the official member dialog: a fresh member read issues a
 * selection token, then `im_finish` spends it. Writes are never replayed: a
 * lost reply or an unconfirmed acceptance stays fenced for this page lifetime.
 */
import type { AccountContext } from '../../packages/ipc/src/contracts.ts';
import type { UiPeripheralWrite } from '../../packages/ipc/src/client.ts';
import { UiCommands } from '../../packages/ipc/src/client.ts';
import { errorMessage } from './viewmodel.ts';

/** confirmed: server read-back shows the session ended. pending: submitted but
 * unconfirmed (accepted / unknown) — never resubmitted. failed: nothing written. */
export type FinishOutcome = 'confirmed' | 'pending' | 'failed';
export interface FinishResult { readonly gid: string; readonly outcome: FinishOutcome; readonly reason?: string }
export interface FinishSummary { readonly confirmed: number; readonly pending: number; readonly failed: number; readonly skipped: number }

interface Dependencies {
  invoke(command: string, payload: unknown): Promise<unknown>;
  now(): number;
}

function selectionToken(value: unknown, now: number): string | null {
  if (value === null || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const token = row['selection_token'], expires = row['expires_at_ms'];
  return typeof token === 'string' && token.trim() !== '' && typeof expires === 'number' && Number.isFinite(expires) && expires > now ? token : null;
}

export function summarizeFinish(results: readonly FinishResult[], total: number): FinishSummary {
  const count = (outcome: FinishOutcome) => results.filter(r => r.outcome === outcome).length;
  return { confirmed: count('confirmed'), pending: count('pending'), failed: count('failed'), skipped: Math.max(0, total - results.length) };
}

export function createConversationFinisher(deps: Dependencies) {
  /** Unresolved writes per account generation + gid: shown again, never resubmitted. */
  const unresolved = new Set<string>();
  const inflight = new Map<string, Promise<FinishResult>>();
  const keyOf = (account: AccountContext, gid: string) => JSON.stringify([account.environment, account.account_id, account.session_generation, gid]);

  async function attempt(account: AccountContext, gid: string, key: string): Promise<FinishResult> {
    const base = { account: { ...account }, gid };
    let token: string | null;
    try {
      token = selectionToken(await deps.invoke(UiCommands.IM_MEMBERS, base), deps.now());
    } catch (error) {
      return { gid, outcome: 'failed', reason: errorMessage(error) };
    }
    if (!token) return { gid, outcome: 'failed' };
    // Fence before crossing IPC: a lost reply must not authorize another write.
    unresolved.add(key);
    let raw: UiPeripheralWrite;
    try {
      raw = await deps.invoke(UiCommands.IM_FINISH, { ...base, selection_token: token }) as UiPeripheralWrite;
    } catch (error) {
      return { gid, outcome: 'pending', reason: errorMessage(error) };
    }
    if (raw?.kind === 'confirmed' && raw.confirmed === true) { unresolved.delete(key); return { gid, outcome: 'confirmed' }; }
    if (raw?.kind === 'not_submitted' && raw.confirmed === false) {
      unresolved.delete(key);
      return { gid, outcome: 'failed', ...(typeof raw.reason === 'string' ? { reason: raw.reason } : {}) };
    }
    return { gid, outcome: 'pending', ...(typeof raw?.reason === 'string' ? { reason: raw.reason } : {}) };
  }

  /** End one conversation. Concurrent calls for the same conversation share one attempt. */
  function finish(account: AccountContext, gid: string): Promise<FinishResult> {
    const key = keyOf(account, gid);
    if (unresolved.has(key)) return Promise.resolve({ gid, outcome: 'pending' });
    const running = inflight.get(key);
    if (running) return running;
    const p = attempt(account, gid, key).finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  /** End conversations one at a time; `proceed` is checked before each new write. */
  async function finishMany(account: AccountContext, gids: readonly string[], options: { proceed(): boolean; progress?(done: number, total: number): void }): Promise<FinishResult[]> {
    const unique = [...new Set(gids)];
    const results: FinishResult[] = [];
    for (const gid of unique) {
      if (!options.proceed()) break;
      results.push(await finish(account, gid));
      options.progress?.(results.length, unique.length);
    }
    return results;
  }

  return { finish, finishMany, isUnresolved: (account: AccountContext, gid: string) => unresolved.has(keyOf(account, gid)) };
}
