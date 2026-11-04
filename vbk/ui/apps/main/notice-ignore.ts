import type { AccountContext } from '../../packages/ipc/src/contracts.ts';

/** 被忽略的通知分类只是本机的界面偏好：按账号分开保存，不影响服务端已读状态和宿主提醒。 */
const PREFIX = 'vbk.notice-ignored.';

export function ignoredKey(account: Pick<AccountContext, 'environment' | 'account_id'>): string {
  return `${PREFIX}${account.environment}.${account.account_id}`;
}

export function loadIgnored(account: Pick<AccountContext, 'environment' | 'account_id'>, storage: Pick<Storage, 'getItem'> | null = defaultStorage()): readonly string[] {
  try {
    const saved = JSON.parse(storage?.getItem(ignoredKey(account)) ?? 'null');
    return Array.isArray(saved) ? [...new Set(saved.filter((id): id is string => typeof id === 'string'))] : [];
  } catch { return []; }
}

export function saveIgnored(account: Pick<AccountContext, 'environment' | 'account_id'>, ids: readonly string[], storage: Pick<Storage, 'setItem' | 'removeItem'> | null = defaultStorage()): void {
  try {
    if (ids.length) storage?.setItem(ignoredKey(account), JSON.stringify(ids));
    else storage?.removeItem(ignoredKey(account));
  } catch { /* Storage may be unavailable in a restricted webview. */ }
}

export function toggleIgnored(ids: readonly string[], id: string, ignored: boolean): readonly string[] {
  const rest = ids.filter(x => x !== id);
  return ignored ? [...rest, id] : rest;
}

export function splitCategories<T extends { readonly id: string }>(cats: readonly T[], ignored: readonly string[]): { visible: T[]; hidden: T[] } {
  const set = new Set(ignored);
  return { visible: cats.filter(c => !set.has(c.id)), hidden: cats.filter(c => set.has(c.id)) };
}

/** `notice_banner.accounts` 的键，换代次重新登录后设置仍然有效。 */
export function bannerKey(account: Pick<AccountContext, 'environment' | 'account_id'>): string {
  return `${account.environment}:${account.account_id}`;
}

/** 开关一个分类的横幅提醒后的完整映射；账号已无分类时删掉这一项。 */
export function withBannerCategory(accounts: Readonly<Record<string, readonly string[]>>, account: Pick<AccountContext, 'environment' | 'account_id'>, id: string, on: boolean): Record<string, readonly string[]> {
  const key = bannerKey(account);
  const { [key]: current = [], ...rest } = accounts;
  const next = toggleIgnored(current, id, on);
  return next.length ? { ...rest, [key]: next } : rest;
}

function defaultStorage(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}
