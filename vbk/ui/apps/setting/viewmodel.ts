/** Pure settings logic (no DOM): sections, validation, command mapping. */

import type { ReminderSettings } from '../../packages/ipc/src/contracts.ts';
import { ALLOWED_T1_SECONDS } from '../../packages/ipc/src/contracts.ts';
import { NotifyCommands } from '../../packages/ipc/src/commands.ts';
import type { PrefsSection, PrefsSnapshot, SendMode } from '../../packages/ipc/src/client.ts';
import { UiCommands } from '../../packages/ipc/src/client.ts';
import { t } from '../../packages/ui-kit/src/i18n.ts';
import type { I18nKey } from '../../packages/ui-kit/src/i18n.ts';

export type SectionId = 'general' | 'display' | 'notify' | 'keys' | 'assistant' | 'network' | 'storage' | 'privacy';

export const SECTIONS: readonly { id: SectionId; labelKey: I18nKey }[] = [
  { id: 'general', labelKey: 'set.general' },
  { id: 'display', labelKey: 'set.display' },
  { id: 'notify', labelKey: 'set.notify' },
  { id: 'keys', labelKey: 'set.keys' },
  { id: 'assistant', labelKey: 'set.assistant' },
  { id: 'network', labelKey: 'set.network' },
  { id: 'storage', labelKey: 'set.storage' },
  { id: 'privacy', labelKey: 'set.privacy' },
];

export function isSectionId(s: string | null): s is SectionId {
  return SECTIONS.some((x) => x.id === s);
}

export function isAllowedT1(n: number): n is (typeof ALLOWED_T1_SECONDS)[number] {
  return (ALLOWED_T1_SECONDS as readonly number[]).includes(n);
}

/** Returns the keys that violate the contract (empty = valid). */
export function validateReminderSettings(s: ReminderSettings): string[] {
  const bad: string[] = [];
  if (!isAllowedT1(s.t1_seconds)) bad.push('t1_seconds');
  for (const k of ['enabled', 'timeout_sound', 'continuous_l4', 'position_bottom_right', 'alert_during_dnd', 'alert_during_fullscreen', 'tray_flash', 'taskbar_badge'] as const) {
    if (typeof s[k] !== 'boolean') bad.push(k);
  }
  return bad;
}

export interface SettingCommand {
  readonly cmd: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/**
 * Reminder fields with a dedicated notify command go through `NotifyCommands`
 * (the alarm core owns them); the rest of the reminder block is persisted via
 * prefs with section `reminder` (契约变更请求: notify_set_* only covers
 * enabled/threshold/sound).
 */
export function reminderCommand<K extends keyof ReminderSettings>(key: K, value: ReminderSettings[K]): SettingCommand {
  switch (key) {
    case 'enabled':
      return { cmd: NotifyCommands.SET_ENABLED, payload: { enabled: value } };
    case 't1_seconds': {
      if (typeof value !== 'number' || !isAllowedT1(value)) throw new RangeError(`t1_seconds must be one of ${ALLOWED_T1_SECONDS.join('/')}`);
      return { cmd: NotifyCommands.SET_THRESHOLD, payload: { t1_seconds: value } };
    }
    case 'timeout_sound':
      return { cmd: NotifyCommands.SET_SOUND_ENABLED, payload: { enabled: value } };
    default:
      return { cmd: UiCommands.PREFS_SET, payload: { section: 'reminder', key, value } };
  }
}

export function prefsCommand(section: PrefsSection, key: string, value: boolean | string | number): SettingCommand {
  return { cmd: UiCommands.PREFS_SET, payload: { section, key, value } };
}

export function sendModeDescription(mode: SendMode): string {
  return mode === 'send_direct' ? t('set.asst.modeDirectDesc') : t('set.asst.modeReplaceDesc');
}

export function tsimStatusText(p: PrefsSnapshot['assistant']): string {
  return p.tsim_logged_in && p.tsim_user ? t('set.asst.tsimLoggedIn', { user: p.tsim_user }) : t('set.asst.tsimLoggedOut');
}

/** The login form never keeps the password after submit. */
export interface TsimForm {
  readonly user: string;
  readonly password: string;
}

export const EMPTY_TSIM_FORM: TsimForm = { user: '', password: '' };

export function tsimFormValid(f: TsimForm): boolean {
  return f.user.trim().length > 0 && f.password.length > 0;
}

export const ZOOM_OPTIONS: readonly PrefsSnapshot['display']['zoom'][] = [75, 100, 125, 150];
export const CACHE_DAY_OPTIONS: readonly PrefsSnapshot['storage']['cache_days'][] = [30, 90, 180, 365];
