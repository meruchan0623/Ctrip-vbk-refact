import type { UiAccount } from '../../packages/ipc/src/client.ts';

/**
 * Account tabs that breathe because a banner-level message arrived for them
 * while the user was elsewhere. Holds account ids only: no conversation or text.
 */

/** Adds `accountId` unless that tab is the one being viewed. */
export function addTabAttention(list: readonly string[], accountId: string, viewing: string | null): readonly string[] {
  if (accountId === viewing || list.includes(accountId)) return list;
  return [...list, accountId];
}

/** Drops tabs that no longer need attention: gone, expired, viewed or already read. */
export function pruneTabAttention(list: readonly string[], accounts: readonly UiAccount[], viewing: string | null): readonly string[] {
  const keep = list.filter((id) => {
    if (id === viewing) return false;
    const a = accounts.find((x) => x.context.account_id === id);
    return !!a && a.state !== 'expired' && a.unread > 0;
  });
  return keep.length === list.length ? list : keep;
}

/** Whether a tab should breathe right now. */
export function tabBreathes(list: readonly string[], account: UiAccount, on: boolean): boolean {
  return !on && account.unread > 0 && account.state !== 'expired' && list.includes(account.context.account_id);
}
