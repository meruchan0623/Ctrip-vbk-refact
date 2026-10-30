import type { AccountContext } from '../../packages/ipc/src/contracts.ts';

export type ScopedSendResult<T> = { readonly kind: 'result'; readonly value: T } | { readonly kind: 'error'; readonly error: unknown } | { readonly kind: 'stale' };

/** Await once; callers must not project an old account's success OR failure into the active store. */
export async function settleAccountSend<T>(owner: AccountContext, operation: () => Promise<T>, current: () => AccountContext | null): Promise<ScopedSendResult<T>> {
  const captured = { ...owner };
  let result: ScopedSendResult<T>;
  try { result = { kind: 'result', value: await operation() }; }
  catch (error) { result = { kind: 'error', error }; }
  const active = current();
  if (!active || active.account_id !== captured.account_id || active.environment !== captured.environment || active.session_generation !== captured.session_generation) return { kind: 'stale' };
  return result;
}
