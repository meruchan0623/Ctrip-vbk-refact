/** Pure derivations for the alarm window (no DOM). */

import type { AlarmEntry, AlarmSnapshot, SnoozeMinutes } from '../../packages/ipc/src/contracts.ts';
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
  readonly level: AlarmEntry['level'];
}

export function rowKey(e: Pick<AlarmEntry, 'account' | 'gid' | 'round_id'>): string {
  return `${e.account.account_id}:${e.gid}:${e.round_id}`;
}

/**
 * Rows sorted by waited time (desc). Red when `waited_seconds >= RED_AFTER_SECONDS`,
 * `待核对` when the round start is not confirmed, snoozed when `snoozed_until_ms`
 * is in the future. Snoozed rows are kept (dimmed) so the user sees what is paused.
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
        level: entry.level,
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

export type AlarmAction = { kind: 'open' } | { kind: 'hide' } | { kind: 'snooze'; minutes: SnoozeMinutes };

/** Command + payload for a per-entry action; the version is echoed from the snapshot. */
export function entryCommand(e: AlarmEntry, action: AlarmAction): { cmd: string; payload: Record<string, unknown> } {
  const ref = roundRef(e);
  switch (action.kind) {
    case 'open':
      return { cmd: NotifyCommands.OPEN_CONVERSATION, payload: { ...ref } };
    case 'hide':
      return { cmd: NotifyCommands.HIDE_ROUND, payload: { ...ref } };
    case 'snooze':
      return { cmd: NotifyCommands.SNOOZE, payload: { ...ref, minutes: action.minutes } };
    default:
      return { cmd: NotifyCommands.OPEN_CONVERSATION, payload: { ...ref } };
  }
}

export function hideAllCommand(snapshot: AlarmSnapshot): { cmd: string; payload: { seen: { gid: string; round_id: string; version: number }[] } } {
  return {
    cmd: NotifyCommands.HIDE_ALL,
    payload: { seen: snapshot.entries.map((e) => ({ gid: e.gid, round_id: e.round_id, version: e.version })) },
  };
}

export const SNOOZE_OPTIONS: readonly { minutes: SnoozeMinutes; labelKey: 'alarm.snooze5' | 'alarm.snooze10' | 'alarm.snooze30' }[] = [
  { minutes: 5, labelKey: 'alarm.snooze5' },
  { minutes: 10, labelKey: 'alarm.snooze10' },
  { minutes: 30, labelKey: 'alarm.snooze30' },
];
