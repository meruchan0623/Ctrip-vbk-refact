import type { AccountContext } from '../../packages/ipc/src/contracts.ts';
import type { UiAccountSnapshot } from '../../packages/ipc/src/client.ts';

/** Serialize host selection writes, while still accepting account lifecycle updates. */
export function createAccountNavigation(deps: {
  switch(account: AccountContext): Promise<unknown>;
  snapshot(): Promise<unknown>;
  valid(value: unknown): value is UiAccountSnapshot;
}) {
  let tail: Promise<unknown> = Promise.resolve();
  let desired: { account: AccountContext; intent: object } | null = null;
  function project(snapshot: UiAccountSnapshot): UiAccountSnapshot {
    if (!desired) return snapshot;
    const account = desired.account;
    const target = snapshot.accounts.find(a => a.context.account_id === account.account_id && a.context.environment === account.environment && a.context.session_generation === account.session_generation);
    // Removal, reauthentication and login lifecycle events remain authoritative.
    if (!target || target.state === 'logging_in' || target.state === 'expired') { desired = null; return snapshot; }
    return snapshot.active_account_id === account.account_id ? snapshot : { ...snapshot, active_account_id: account.account_id };
  }
  function select(account: AccountContext): Promise<UiAccountSnapshot | null> {
    const request = { account: { ...account }, intent: {} };
    desired = request;
    const run = async () => {
      if (desired !== request) return null;
      let result: unknown;
      try { result = await deps.switch(request.account); } catch { result = null; }
      if (desired !== request) return null;
      desired = null;
      if (deps.valid(result)) return result;
      // A rejected latest switch must display the host's actual active account.
      try { const current = await deps.snapshot(); return deps.valid(current) ? current : null; } catch { return null; }
    };
    const result = tail.then(run, run);
    tail = result;
    return result;
  }
  return { select, project, pending: () => desired !== null };
}
