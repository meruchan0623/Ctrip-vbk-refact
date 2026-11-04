/** Pure derivations for the alarm window (no DOM). */

import type { AlarmEntry, AlarmSnapshot } from '../../packages/ipc/src/contracts.ts';
import { RED_AFTER_SECONDS } from '../../packages/ipc/src/contracts.ts';
import { NotifyCommands } from '../../packages/ipc/src/commands.ts';
import { formatClock, formatDuration } from '../../packages/ui-kit/src/format.ts';
import { t } from '../../packages/ui-kit/src/i18n.ts';

export interface AlarmRow {
  readonly key: string;
  readonly entry: AlarmEntry;
  readonly label: string;
  readonly waitedText: string;
  readonly red: boolean;
  readonly pending: boolean;
  readonly snoozed: boolean;
  readonly snoozedUntilText: string | null;
  readonly preview: string | null;
}

export function rowKey(e: Pick<AlarmEntry, 'account' | 'gid' | 'round_id'>): string {
  return JSON.stringify([e.account.environment, e.account.account_id, e.account.session_generation, e.gid, e.round_id]);
}

/**
 * Rows sorted by waited time (desc). Red when `waited_seconds >= RED_AFTER_SECONDS`,
 * `待核对` when the round start is not confirmed, snoozed when `snoozed_until_ms`
 * is in the future. Rounds snoozed by an earlier build stay dimmed until that pause runs out.
 */
export function deriveAlarmRows(snapshot: AlarmSnapshot, nowMs: number): AlarmRow[] {
  return snapshot.entries
    .map((entry) => {
      const snoozed = entry.snoozed_until_ms !== null && entry.snoozed_until_ms > nowMs;
      return {
        key: rowKey(entry),
        entry,
        label: entry.label,
        waitedText: formatDuration(entry.waited_seconds),
        red: entry.waited_seconds >= RED_AFTER_SECONDS,
        pending: !entry.start_confirmed,
        snoozed,
        snoozedUntilText: snoozed && entry.snoozed_until_ms !== null ? formatClock(entry.snoozed_until_ms) : null,
        preview: entry.preview,
      };
    })
    .sort((a, b) => {
      if (a.snoozed !== b.snoozed) return a.snoozed ? 1 : -1;
      return b.entry.waited_seconds - a.entry.waited_seconds;
    });
}

export function activeCount(snapshot: AlarmSnapshot, nowMs: number): number {
  return snapshot.entries.filter((e) => e.snoozed_until_ms === null || e.snoozed_until_ms <= nowMs).length;
}

export function headerTitle(snapshot: AlarmSnapshot, nowMs: number): string {
  return t('alarm.title', { n: activeCount(snapshot, nowMs) });
}

export function thresholdText(snapshot: AlarmSnapshot): string {
  return t('alarm.threshold', { t: snapshot.settings.t1_seconds });
}

export function hasL4(snapshot: AlarmSnapshot): boolean {
  return snapshot.settings.continuous_l4 && snapshot.entries.some((e) => e.level === 'L4');
}

/**
 * Whether a snapshot returned by `notify_snapshot` may replace the one the
 * window currently shows. The window subscribes to the event stream before it
 * requests the snapshot, so an event can arrive while the request is in
 * flight; the response is then older than what is displayed and must not
 * win. Pushed events are always applied (the host stream is ordered); this
 * guard is only for command responses.
 */
export function acceptsSnapshotResponse(current: AlarmSnapshot | null, response: AlarmSnapshot): boolean {
  return current === null || response.generated_at_ms >= current.generated_at_ms;
}

export interface RoundRef {
  readonly account: AlarmEntry['account'];
  readonly gid: string;
  readonly round_id: string;
  readonly version: number;
}

export function roundRef(e: AlarmEntry): RoundRef {
  return { account: e.account, gid: e.gid, round_id: e.round_id, version: e.version };
}

export type AlarmAction = { kind: 'open' } | { kind: 'hide' };

/** Command + payload for a per-entry action; the version is echoed from the snapshot. */
export function entryCommand(e: AlarmEntry, action: AlarmAction): { cmd: string; payload: Record<string, unknown> } {
  const ref = roundRef(e);
  switch (action.kind) {
    case 'open':
      return { cmd: NotifyCommands.OPEN_CONVERSATION, payload: { round: ref } };
    case 'hide':
      return { cmd: NotifyCommands.HIDE_ROUND, payload: { round: ref } };
    default:
      return { cmd: NotifyCommands.OPEN_CONVERSATION, payload: { round: ref } };
  }
}

export function hideAllCommand(snapshot: AlarmSnapshot): { cmd: string; payload: { seen: RoundRef[] } } {
  return {
    cmd: NotifyCommands.HIDE_ALL,
    payload: { seen: snapshot.entries.map(roundRef) },
  };
}

/** Prototype avatar palette; the colour is a stable function of the conversation id. */
export const AVATAR_COLORS: readonly string[] = ['#2C7F8F', '#3A6FD8', '#8A5CD6', '#C7672B', '#2FA36B', '#B8487A', '#5B7FB8', '#A07A1E'];

export function avatarColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length] ?? '#5B7FB8';
}
