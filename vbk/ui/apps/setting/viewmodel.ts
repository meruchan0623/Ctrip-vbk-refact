/** Pure settings logic (no DOM): sections, validation, command mapping. */

import type { AccountContext, AlarmCorner, ReminderSettings } from '../../packages/ipc/src/contracts.ts';
import { ALLOWED_T1_SECONDS } from '../../packages/ipc/src/contracts.ts';
import { NotifyCommands } from '../../packages/ipc/src/commands.ts';
import type { PrefsSection, PrefsSnapshot, UiAccount, UiAccountSnapshot, UiTsimStatus } from '../../packages/ipc/src/client.ts';
import { UiCommands } from '../../packages/ipc/src/client.ts';
import { t } from '../../packages/ui-kit/src/i18n.ts';
import type { I18nKey } from '../../packages/ui-kit/src/i18n.ts';

/** Mirrored by `SETTING_SECTIONS` in `crates/core-update/src/deeplink.rs` (checked by `sections-consistency.test.ts`). */
export type SectionId = 'quick_replies' | 'general' | 'notify' | 'keys' | 'assistant' | 'about';

/** Nav groups: `account` edits the chosen account's data on the official site, `desktop` only this machine. */
export type SectionGroup = 'account' | 'desktop';

export interface SectionEntry {
  readonly id: SectionId;
  readonly group: SectionGroup;
  readonly labelKey: I18nKey;
}

/** Page and nav order; each group's entries are contiguous. */
export const SECTIONS: readonly SectionEntry[] = [
  { id: 'quick_replies', group: 'account', labelKey: 'set.quickReplies' },
  { id: 'general', group: 'desktop', labelKey: 'set.general' },
  { id: 'notify', group: 'desktop', labelKey: 'set.notify' },
  { id: 'keys', group: 'desktop', labelKey: 'set.keys' },
  { id: 'assistant', group: 'desktop', labelKey: 'set.assistant' },
  { id: 'about', group: 'desktop', labelKey: 'set.about' },
];

export const SECTION_GROUPS: readonly { readonly id: SectionGroup; readonly labelKey: I18nKey }[] = [
  { id: 'account', labelKey: 'set.group.account' },
  { id: 'desktop', labelKey: 'set.group.desktop' },
];

export function sectionLabel(sec: { readonly labelKey: I18nKey }): string {
  return t(sec.labelKey);
}

export function isSectionId(s: string | null): s is SectionId {
  return SECTIONS.some((x) => x.id === s);
}

/**
 * Desktop sections render from the preferences snapshot and wait for it; account sections
 * (quick replies) act on the chosen account and render without it.
 */
export function sectionNeedsPrefs(id: SectionId): boolean {
  return SECTIONS.find((x) => x.id === id)?.group !== 'account';
}

export function isAllowedT1(n: number): n is (typeof ALLOWED_T1_SECONDS)[number] {
  return (ALLOWED_T1_SECONDS as readonly number[]).includes(n);
}

/** Returns the keys that violate the contract (empty = valid). */
export function validateReminderSettings(s: ReminderSettings): string[] {
  const bad: string[] = [];
  if (!isAllowedT1(s.t1_seconds)) bad.push('t1_seconds');
  for (const k of ['enabled', 'timeout_sound', 'continuous_l4', 'alert_during_dnd', 'alert_during_fullscreen', 'tray_flash', 'taskbar_badge'] as const) {
    if (typeof s[k] !== 'boolean') bad.push(k);
  }
  if (!(ALARM_CORNERS as readonly string[]).includes(s.alarm_corner)) bad.push('alarm_corner');
  return bad;
}

export const ALARM_CORNERS: readonly AlarmCorner[] = ['top_left', 'top_right', 'bottom_left', 'bottom_right'];

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

/** 点击导航后锁定高亮的时长：覆盖平滑滚动，且让末尾几个很短的分类（滚不到顶）也能高亮被点的那个。 */
export const SPY_LOCK_MS = 900;
/** 分类标题距容器顶部不足这么多像素时，就算“已进入”该分类。 */
export const SPY_OFFSET_PX = 24;

/** 滚动容器里某个分类的顶边，相对容器内容起点（与 scrollTop 同一坐标系）。 */
export interface SectionTop {
  readonly id: SectionId;
  readonly top: number;
}

/** 点击导航后的高亮锁：`until` 之前不允许滚动把高亮改回去。 */
export interface SpyLock {
  readonly id: SectionId;
  readonly until: number;
}

export interface SpyInput {
  /** 按页面顺序排列的各分类顶边。 */
  readonly tops: readonly SectionTop[];
  readonly scrollTop: number;
  readonly clientHeight: number;
  readonly scrollHeight: number;
  readonly now: number;
  readonly current: SectionId;
  readonly lock: SpyLock | null;
}

/**
 * scroll-spy：滚动时该高亮哪个分类。
 * 锁未过期 → 被点的分类；内容放不满一屏 → 保持现状；滚到底 → 最后一个；
 * 否则取顶边已越过视口上沿（含 SPY_OFFSET_PX）的最后一个分类。
 */
export function pickActiveSection(input: SpyInput): SectionId {
  const { tops, scrollTop, clientHeight, scrollHeight, now, current, lock } = input;
  if (lock && now < lock.until) return lock.id;
  const last = tops[tops.length - 1];
  if (!last) return current;
  if (scrollHeight - clientHeight <= 1) return current;
  if (scrollTop + clientHeight >= scrollHeight - 2) return last.id;
  let picked = tops[0]!.id;
  for (const sec of tops) {
    if (sec.top <= scrollTop + SPY_OFFSET_PX) picked = sec.id;
    else break;
  }
  return picked;
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

export function isTsimStatus(value: unknown): value is UiTsimStatus {
  if (!value || typeof value !== 'object') return false;
  const s = value as Partial<UiTsimStatus>;
  return typeof s.logged_in === 'boolean' && (s.user === null || typeof s.user === 'string') && (!s.logged_in || typeof s.user === 'string' && !!s.user.trim());
}

/** Whitelisted codes only: upstream messages can echo credentials or transport details. */
export function tsimErrorText(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
  const descriptions: Readonly<Record<string, string>> = {
    'assistant.tsim_bad_credentials': t('set.runtime.badCredentials'),
    'assistant.invalid_input': t('set.runtime.invalidLogin'),
    'assistant.forbidden': t('set.runtime.forbidden'),
    'assistant.permission_denied': t('set.runtime.permissionDenied'),
    'assistant.tsim_unauthenticated': t('set.runtime.unauthenticated'),
    'assistant.session_cleared': t('set.runtime.sessionCleared'),
    'net.timeout': t('set.runtime.timeout'),
    'net.offline': t('set.runtime.offline'),
    'assistant.service_unavailable': t('set.runtime.serviceUnavailable'),
    'assistant.malformed_response': t('set.runtime.malformedResponse'),
    'store.io': t('set.runtime.credentialStoreUnavailable'),
  };
  return typeof code === 'string' && Object.hasOwn(descriptions, code) ? t('set.runtime.errorCode', { message: descriptions[code]!, code }) : t('set.runtime.operationUnconfirmed');
}

export const ZOOM_OPTIONS: readonly PrefsSnapshot['display']['zoom'][] = [75, 100, 125, 150];

/** Official IM page that hosts the web personal settings; opened in the main window's browser tabs. */
export const PERSONAL_SETTINGS_URL = 'https://vbooking.ctrip.com/vbk/im/main';

// ---- quick replies: account picker

/** Accounts the quick-reply manager may act for: only logged-in (`online`) ones, in snapshot order. */
export function loggedInAccounts(snap: UiAccountSnapshot): readonly UiAccount[] {
  return snap.accounts.filter((a) => a.state === 'online');
}

/** Stable option value for an account (identity without the generation). */
export function accountKey(ctx: AccountContext): string {
  return `${ctx.environment}:${ctx.account_id}`;
}

/** Same naming as the main window's account tabs: remark first, else nick. */
export function accountOptionLabel(a: UiAccount): string {
  return a.remark && a.remark.trim() ? a.remark : a.nick;
}

/** The quick-reply account binding: whom the user wants, and the context the manager acts for now. */
export interface QuickReplyBinding {
  /** `accountKey` of the account the user picked (or the default adopted for them); `null` until there is one. */
  readonly preferred: string | null;
  /** The preferred account's current context while it is logged in; `null` while it is offline. */
  readonly account: AccountContext | null;
}

/**
 * Follows the preferred account: while it is logged in, its current context (a new
 * `session_generation` included); while it is offline, none, never silently another account.
 * Without a preference yet, the first logged-in account is adopted as the preference.
 */
export function pickQuickReplyAccount(online: readonly UiAccount[], preferred: string | null): QuickReplyBinding {
  if (preferred === null) {
    const first = online[0]?.context ?? null;
    return { preferred: first ? accountKey(first) : null, account: first };
  }
  return { preferred, account: online.find((a) => accountKey(a.context) === preferred)?.context ?? null };
}
