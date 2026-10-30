/** Pure update-window logic (no DOM). */
import { UPDATE_STRINGS as S, fmt } from './strings.ts';

/**
 * `idle` before the first check; `not_configured` until an updater feed and
 * signing key exist (plan M5-6). No download/install phase is reachable yet.
 */
export type UpdatePhase = 'idle' | 'not_configured';

export function versionText(v: string | null): string {
  return v && v.trim() ? fmt(S.version, { v: v.trim() }) : S.versionUnknown;
}

/** Result of pressing 「检查更新」 with no updater configured: never a network call. */
export function checkUpdate(_phase: UpdatePhase): UpdatePhase {
  return 'not_configured';
}
