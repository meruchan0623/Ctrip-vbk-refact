/** Pure settings logic (no DOM): sections, validation, command mapping. */

import type { ReminderSettings } from '../../packages/ipc/src/contracts.ts';
import { ALLOWED_T1_SECONDS } from '../../packages/ipc/src/contracts.ts';
import { NotifyCommands } from '../../packages/ipc/src/commands.ts';
import type { PrefsSection, PrefsSnapshot, UiTsimStatus } from '../../packages/ipc/src/client.ts';
import { UiCommands } from '../../packages/ipc/src/client.ts';
import { t } from '../../packages/ui-kit/src/i18n.ts';
import type { I18nKey } from '../../packages/ui-kit/src/i18n.ts';
import { SETTING_STRINGS } from './strings.ts';

export type SectionId = 'general' | 'display' | 'notify' | 'keys' | 'assistant' | 'network' | 'storage' | 'privacy' | 'about';

/** Nav entries (prototype 「桌面偏好（本机）」 group); `label` is window-local copy where i18n has no key. */
export const SECTIONS: readonly ({ id: SectionId; labelKey: I18nKey; label?: undefined } | { id: SectionId; labelKey?: undefined; label: string })[] = [
  { id: 'general', labelKey: 'set.general' },
  { id: 'display', labelKey: 'set.display' },
  { id: 'notify', labelKey: 'set.notify' },
  { id: 'keys', labelKey: 'set.keys' },
  { id: 'assistant', label: SETTING_STRINGS.assistant },
  { id: 'network', labelKey: 'set.network' },
  { id: 'storage', labelKey: 'set.storage' },
  { id: 'privacy', labelKey: 'set.privacy' },
  { id: 'about', label: SETTING_STRINGS.about },
];

export function sectionLabel(sec: (typeof SECTIONS)[number]): string {
  return sec.labelKey !== undefined ? t(sec.labelKey) : sec.label;
}

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

export function tsimSessionInputValid(value: string): boolean { return value.trim().length > 0 && value.length <= 16384 && !/[\r\n]/.test(value); }

export function tsimImportErrorText(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
  if (code === 'assistant.tsim_bad_credentials' || code === 'assistant.tsim_unauthenticated' || code === 'assistant.session_cleared') return '已有 TSim 会话无效或已过期，请重新取得会话或使用账号密码登录。';
  if (code === 'assistant.invalid_input') return '已有会话的输入格式不正确，请重新取得有效会话。';
  return tsimErrorText(error);
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
    'assistant.browser_storage_unavailable': '无法读取浏览器会话，可能正在写入、格式不支持或没有访问权限。请稍后重试，或使用账号密码登录。',
    'assistant.tsim_bad_credentials': '用户名或密码未通过验证，请检查后重新输入。',
    'assistant.invalid_input': '登录信息格式不正确，请检查输入。',
    'assistant.forbidden': 'TSim 拒绝了当前账号的权限，请联系管理员。',
    'assistant.permission_denied': '当前窗口或账号没有操作权限，请重新打开设置或联系管理员。',
    'assistant.tsim_unauthenticated': 'TSim 尚未登录，请重新登录。',
    'assistant.session_cleared': 'TSim 会话已失效，请重新登录。',
    'net.timeout': '请求超时，结果尚待核对。请先刷新登录状态。',
    'net.offline': '无法连接 TSim，请检查网络后刷新登录状态。',
    'assistant.service_unavailable': 'TSim 服务暂不可用，请稍后刷新登录状态。',
    'assistant.malformed_response': '返回的登录状态无法识别，请刷新状态后再操作。',
    'store.io': '系统凭据存储不可用，请检查系统权限后重试。',
  };
  return typeof code === 'string' && Object.hasOwn(descriptions, code) ? `${descriptions[code]}（${code}）` : '操作未完成，登录状态尚待核对。请先刷新 TSim 登录状态后再操作。';
}

export const ZOOM_OPTIONS: readonly PrefsSnapshot['display']['zoom'][] = [75, 100, 125, 150];

/** Official IM page that hosts the web personal settings; opened in the main window's browser tabs. */
export const PERSONAL_SETTINGS_URL = 'https://vbooking.ctrip.com/vbk/im/main';
