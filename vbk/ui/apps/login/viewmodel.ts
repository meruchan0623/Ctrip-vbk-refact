/** Pure login-header logic (no DOM). */

import type { UiAccountSnapshot } from '../../packages/ipc/src/client.ts';

/**
 * The login attempt this header belongs to. The host passes `?attempt=` in the
 * window URL; without it, fall back to the account currently `logging_in`
 * (its account id doubles as the attempt id until the snapshot carries one —
 * see 契约变更请求 in the UI-secondary report).
 */
export function resolveAttemptId(search: string, snap: UiAccountSnapshot | null): string | null {
  const fromUrl = new URLSearchParams(search).get('attempt');
  if (fromUrl && fromUrl.trim()) return fromUrl.trim();
  const pending = snap?.accounts.find((a) => a.state === 'logging_in') ?? null;
  return pending ? pending.context.account_id : null;
}
