import { createRecovery, recoveryView, type RecoveryState } from '../_shared/recovery.ts';
/**
 * Settings window (prototype 02-main `.fwin` 设置): 通用 / 显示 / 通知与提醒 /
 * 快捷键 / 商家助手 / 网络 / 存储 / 隐私 / 关于与更新.
 * 左侧是分类导航，右侧所有分类连成一个长页面（点导航滚到对应分类，滚动时 scroll-spy 高亮当前分类）。
 * Reminder fields go through `NotifyCommands.*`; everything else through prefs;
 * TSim through `assistant_tsim_*`.
 *
 * Window chrome: macOS uses the overlay title bar (traffic lights in the left
 * 78px of a 40px drag strip, no close button); Windows draws the prototype's
 * 36px `.fwin-h` with its own close button.
 */

import { applyPlatform } from '../_shared/platform.ts';
const platform = applyPlatform();

import type { AccountContext, ReminderSettings } from '../../packages/ipc/src/contracts.ts';
import { ALLOWED_T1_SECONDS, isAppError } from '../../packages/ipc/src/contracts.ts';
import { AccountCommands, Events, PrefsCommands, ShellCommands } from '../../packages/ipc/src/commands.ts';
import type { PrefsSection, PrefsSnapshot, UiAccountSnapshot, UiNetStatus, UiTsimStatus } from '../../packages/ipc/src/client.ts';
import { UiCommands, UiEvents } from '../../packages/ipc/src/client.ts';
import { h, icon, rerender, cx } from '../../packages/ui-kit/src/h.ts';
import type { Child } from '../../packages/ui-kit/src/h.ts';
import { createStore, subscribeBatched } from '../../packages/ui-kit/src/store.ts';
import { t } from '../../packages/ui-kit/src/i18n.ts';
document.title = t('set.title');
import { IC } from '../_shared/icons.ts';
import { installWindowChrome, windowControls } from '../_shared/window-controls.ts';
import { exposeForTests, selectIpc } from '../_shared/ipc.ts';
import { guarded, isPrefsSnapshot, isUiAccountSnapshot } from '../_shared/guards.ts';
import { EMPTY_TSIM_FORM, PERSONAL_SETTINGS_URL, SECTIONS, SPY_LOCK_MS, ZOOM_OPTIONS, isSectionId, isTsimStatus, pickActiveSection, prefsCommand, reminderCommand, sectionLabel, tsimErrorText, tsimFormValid, tsimStatusText, tsimSessionInputValid, tsimImportErrorText } from './viewmodel.ts';
import { SETTING_STRINGS as S } from './strings.ts';
import type { SectionId, SpyLock, TsimForm } from './viewmodel.ts';

type ShortcutKey = 'toggle_main';

interface SettingState {
  readonly recovery?: RecoveryState;
  readonly shortcutDrafts?: Partial<Record<ShortcutKey, string>>;
  readonly shortcutErrors?: Partial<Record<ShortcutKey, string | null>>;
  readonly shortcutBusy?: Partial<Record<ShortcutKey, boolean>>;
  readonly prefs: PrefsSnapshot | null;
  /** 导航里高亮的分类（点击或 scroll-spy 更新）。 */
  readonly section: SectionId;
  readonly tsimForm: TsimForm;
  readonly tsimBusy: boolean;
  readonly tsimError: string | null;
  readonly tsimStatus: UiTsimStatus | null;
  readonly tsimRequest: number;
  readonly tsimBrowserProfiles?: readonly { id: string; label: string }[];
  readonly tsimImportExpanded: boolean;
  readonly tsimImportToken: string;
  readonly settingsRequest: number;
  readonly loading: boolean;
  readonly loadError: string | null;
  readonly net: UiNetStatus | null;
  readonly toast: string | null;
  /** Active account; web personal settings open under its identity. */
  readonly account: AccountContext | null;
  readonly version: string | null;
}

const params = new URLSearchParams(location.search).get('section');
const store = createStore<SettingState>({ prefs: null, section: isSectionId(params) ? params : 'general', tsimForm: EMPTY_TSIM_FORM, tsimBusy: false, tsimError: null, tsimStatus: null, tsimRequest: 0, tsimImportExpanded: false, tsimImportToken: '', settingsRequest: 0, loading: false, loadError: null, net: null, toast: null, account: null, version: null });
const sel = selectIpc();
const ipc = sel.ipc;
installWindowChrome((command, payload) => ipc.invoke(command, payload));
const root = document.getElementById('app');
if (!root) throw new Error('#app missing');
const recovery = createRecovery({
  invoke: (command, payload) => ipc.invoke(command, payload),
  listenReady: ipc.listenReady?.bind(ipc),
  publish: (recovery) => store.patch({ recovery }),
  diagnostics: async () => {
    const saved = await ipc.invoke<unknown>(ShellCommands.EXPORT_DIAGNOSTICS);
    if (typeof saved !== 'boolean') throw new Error('invalid diagnostics result');
    return saved ? 'saved' : 'cancelled';
  },
});
void recovery.connect();
const refreshRecovery = () => void recovery.refresh();
window.addEventListener('focus', refreshRecovery);
window.addEventListener('pagehide', () => { recovery.dispose(); window.removeEventListener('focus', refreshRecovery); }, { once: true });


let toastTimer: ReturnType<typeof setTimeout> | null = null;
function toast(text: string): void {
  store.patch({ toast: text });
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => store.patch({ toast: null }), 2000);
}

function msg(e: unknown): string {
  return isAppError(e) ? e.message : e instanceof Error ? e.message : String(e);
}

function applySettingsSnapshot(prefs: PrefsSnapshot): void {
  preferenceWrites.clear();
  store.patch({ prefs, settingsRequest: store.get().settingsRequest + 1, loading: false, loadError: null });
}

async function loadSettings(): Promise<void> {
  const ticket = store.get().settingsRequest + 1;
  store.patch({ settingsRequest: ticket, loading: true, loadError: null });
  try {
    const [prefs, net] = await Promise.all([ipc.invoke<unknown>(PrefsCommands.SNAPSHOT), ipc.invoke<UiNetStatus>(UiCommands.NET_STATUS, {}).catch(() => null)]);
    if (store.get().settingsRequest !== ticket) return;
    if (!isPrefsSnapshot(prefs)) throw new Error('invalid preferences snapshot');
    store.patch({ prefs, net, loading: false });
  } catch {
    if (store.get().settingsRequest === ticket) store.patch({ loading: false, loadError: t('set.runtime.loadFailed') });
  }
}

interface PreferenceWrite { confirmed: unknown; confirmedOrder: number; sequence: number; latest: object | null; pending: number }
const preferenceWrites = new Map<string, PreferenceWrite>();

async function setReminder<K extends keyof ReminderSettings>(key: K, value: ReminderSettings[K]): Promise<void> {
  const p = store.get().prefs;
  if (!p) return;
  const field = `reminder.${key}`;
  const write = preferenceWrites.get(field) ?? { confirmed: p.reminder[key], confirmedOrder: 0, sequence: 0, latest: null, pending: 0 };
  const operation = { order: ++write.sequence };
  write.latest = operation; write.pending++;
  preferenceWrites.set(field, write);
  store.patch({ prefs: { ...p, reminder: { ...p.reminder, [key]: value } } });
  try {
    const { cmd, payload } = reminderCommand(key, value);
    await ipc.invoke(cmd, payload);
    // 宿主的 prefs://changed 可能先于命令返回到达并已带上新值：只差告诉用户保存成功。
    if (preferenceWrites.get(field) !== write) { if (write.latest === operation) toast(t('set.saved')); return; }
    if (operation.order >= write.confirmedOrder) { write.confirmed = value; write.confirmedOrder = operation.order; }
    if (write.latest === operation) write.latest = null;
    if (!write.latest) {
      const cur = store.get().prefs;
      if (cur) store.patch({ prefs: { ...cur, reminder: { ...cur.reminder, [key]: write.confirmed } } as PrefsSnapshot });
      toast(t('set.saved'));
    }
  } catch (e) {
    if (preferenceWrites.get(field) !== write || write.latest !== operation) return;
    write.latest = null;
    if (!write.latest) {
      const cur = store.get().prefs;
      if (cur) store.patch({ prefs: { ...cur, reminder: { ...cur.reminder, [key]: write.confirmed } } as PrefsSnapshot });
      toast(t('set.saveFailed', { msg: msg(e) }));
    }
  } finally {
    if (--write.pending === 0 && preferenceWrites.get(field) === write) preferenceWrites.delete(field);
  }
}

async function setPref(section: PrefsSection, key: string, value: boolean | string | number): Promise<void> {
  const p = store.get().prefs;
  if (!p) return;
  const field = `${section}.${key}`;
  const write = preferenceWrites.get(field) ?? { confirmed: (p[section] as unknown as Record<string, unknown>)[key], confirmedOrder: 0, sequence: 0, latest: null, pending: 0 };
  const operation = { order: ++write.sequence };
  write.latest = operation; write.pending++;
  preferenceWrites.set(field, write);
  store.patch({ prefs: { ...p, [section]: { ...p[section], [key]: value } } as PrefsSnapshot });
  try {
    const { cmd, payload } = prefsCommand(section, key, value);
    const next = await ipc.invoke<PrefsSnapshot>(cmd, payload);
    if (!isPrefsSnapshot(next)) throw new Error('invalid preferences snapshot');
    if (preferenceWrites.get(field) !== write) { if (write.latest === operation) toast(t('set.saved')); return; }
    if (operation.order >= write.confirmedOrder) { write.confirmed = (next[section] as unknown as Record<string, unknown>)[key]; write.confirmedOrder = operation.order; }
    if (write.latest === operation) write.latest = null;
    if (!write.latest) {
      const cur = store.get().prefs;
      if (cur) store.patch({ prefs: { ...cur, [section]: { ...cur[section], [key]: write.confirmed } } as PrefsSnapshot });
      toast(t('set.saved'));
    }
  } catch (e) {
    if (preferenceWrites.get(field) !== write || write.latest !== operation) return;
    write.latest = null;
    if (!write.latest) {
      const cur = store.get().prefs;
      if (cur) store.patch({ prefs: { ...cur, [section]: { ...cur[section], [key]: write.confirmed } } as PrefsSnapshot });
      toast(t('set.saveFailed', { msg: msg(e) }));
    }
  } finally {
    if (--write.pending === 0 && preferenceWrites.get(field) === write) preferenceWrites.delete(field);
  }
}

async function tsimLogin(form?: HTMLFormElement): Promise<void> {
  const s = store.get();
  if (s.tsimBusy) return;
  // Password managers can fill the DOM without dispatching input events.
  const data = form ? new FormData(form) : null;
  const credentials = data ? { user: String(data.get('username') ?? ''), password: String(data.get('password') ?? '') } : s.tsimForm;
  if (!tsimFormValid(credentials)) return;
  const ticket = s.tsimRequest + 1;
  if (form) form.reset();
  store.patch({ tsimRequest: ticket, tsimBusy: true, tsimError: null, tsimStatus: null, tsimForm: { user: credentials.user, password: '' } });
  try {
    const status = await ipc.invoke<unknown>(UiCommands.ASSIST_TSIM_LOGIN, { user: credentials.user.trim(), password: credentials.password });
    if (store.get().tsimRequest !== ticket) return;
    if (!isTsimStatus(status)) throw { code: 'assistant.malformed_response' };
    const observed = store.get().tsimStatus;
    if (observed && observed.session_epoch > status.session_epoch) { store.patch({ tsimBusy: false }); return; }
    store.patch({ tsimBusy: false, tsimStatus: status, tsimError: status.logged_in ? null : t('set.runtime.loginUnconfirmed') });
  } catch (e) {
    if (store.get().tsimRequest === ticket) store.patch({ tsimBusy: false, tsimError: tsimErrorText(e) });
  }
}

async function tsimLogout(): Promise<void> {
  const s = store.get();
  if (s.tsimBusy) return;
  const ticket = s.tsimRequest + 1;
  store.patch({ tsimRequest: ticket, tsimBusy: true, tsimError: null, tsimForm: EMPTY_TSIM_FORM });
  try {
    const status = await ipc.invoke<unknown>(UiCommands.ASSIST_TSIM_LOGOUT, {});
    if (store.get().tsimRequest !== ticket) return;
    if (!isTsimStatus(status)) throw { code: 'assistant.malformed_response' };
    const observed = store.get().tsimStatus;
    if (observed && observed.session_epoch > status.session_epoch) { store.patch({ tsimBusy: false }); return; }
    store.patch({ tsimBusy: false, tsimStatus: status, tsimError: status.logged_in ? t('set.runtime.logoutUnconfirmed') : null });
  } catch (e) {
    if (store.get().tsimRequest === ticket) store.patch({ tsimBusy: false, tsimError: tsimErrorText(e) });
  }
}

function receiveTsimStatus(value: unknown): void {
  if (!isTsimStatus(value) || !Number.isSafeInteger(value.session_epoch) || value.session_epoch < 0) return;
  const previous = store.get().tsimStatus;
  if (previous && Number.isSafeInteger(previous.session_epoch) && value.session_epoch < previous.session_epoch) return;
  store.patch({ tsimStatus: value });
}

async function refreshTsimStatus(): Promise<void> {
  const ticket = store.get().tsimRequest + 1;
  store.patch({ tsimRequest: ticket, tsimBusy: true, tsimError: null });
  try {
    const status = await ipc.invoke<unknown>(UiCommands.ASSIST_TSIM_STATUS, {});
    if (store.get().tsimRequest !== ticket) return;
    if (!isTsimStatus(status)) throw { code: 'assistant.malformed_response' };
    const observed = store.get().tsimStatus;
    if (observed && observed.session_epoch > status.session_epoch) { store.patch({ tsimBusy: false }); return; }
    store.patch({ tsimStatus: status, tsimBusy: false });
  } catch (e) {
    if (store.get().tsimRequest === ticket) store.patch({ tsimStatus: null, tsimBusy: false, tsimError: tsimErrorText(e) });
  }
}

async function tsimImportSession(): Promise<void> {
  const s = store.get();
  if (s.tsimBusy || !tsimSessionInputValid(s.tsimImportToken)) return;
  const accessToken = s.tsimImportToken.trim(), ticket = s.tsimRequest + 1;
  // Keep the session input only for this IPC intent, never in state after submission.
  store.patch({ tsimRequest: ticket, tsimBusy: true, tsimError: null, tsimImportToken: '' });
  try {
    const status = await ipc.invoke<unknown>(UiCommands.ASSIST_TSIM_IMPORT_SESSION, { access_token: accessToken });
    if (store.get().tsimRequest !== ticket) return;
    if (!isTsimStatus(status) || !Number.isSafeInteger(status.session_epoch) || status.session_epoch < 0) throw { code: 'assistant.malformed_response' };
    const observed = store.get().tsimStatus;
    if (observed && observed.session_epoch > status.session_epoch) { store.patch({ tsimBusy: false }); return; }
    store.patch({ tsimBusy: false, tsimStatus: status, tsimImportExpanded: !status.logged_in, tsimError: status.logged_in ? null : t('set.runtime.importUnconfirmed') });
  } catch (error) {
    if (store.get().tsimRequest === ticket) store.patch({ tsimBusy: false, tsimStatus: null, tsimError: tsimImportErrorText(error) });
  }
}

async function tsimBrowserConnect(profileId?: string): Promise<void> {
  const s = store.get();
  if (s.tsimBusy) return;
  const ticket = s.tsimRequest + 1;
  store.patch({ tsimRequest: ticket, tsimBusy: true, tsimError: null, tsimBrowserProfiles: [], tsimForm: EMPTY_TSIM_FORM, tsimImportToken: '' });
  try {
    if (!profileId) {
      const profiles = await ipc.invoke<unknown>(UiCommands.ASSIST_TSIM_BROWSER_PROFILES, {});
      if (store.get().tsimRequest !== ticket) return;
      if (!Array.isArray(profiles) || profiles.length > 64 || profiles.some(p => !p || typeof p.id !== 'string' || typeof p.label !== 'string')) throw { code: 'assistant.malformed_response' };
      // A single source completes the explicit browser-login action directly.
      // With several sources, let the user choose the account's Chrome profile.
      if (profiles.length !== 1) {
        store.patch({ tsimBusy: false, tsimBrowserProfiles: profiles, tsimError: profiles.length ? null : t('set.runtime.browserMissing') });
        return;
      }
      profileId = profiles[0].id;
    }
    const status = await ipc.invoke<unknown>(UiCommands.ASSIST_TSIM_BROWSER_CONNECT, { profile_id: profileId });
    if (store.get().tsimRequest !== ticket) return;
    if (!isTsimStatus(status) || !status.logged_in) throw { code: 'assistant.malformed_response' };
    const observed = store.get().tsimStatus;
    if (observed && observed.session_epoch > status.session_epoch) { store.patch({ tsimBusy: false }); return; }
    store.patch({ tsimBusy: false, tsimStatus: status });
  } catch (error) {
    if (store.get().tsimRequest === ticket) store.patch({ tsimBusy: false, tsimStatus: null, tsimError: tsimImportErrorText(error) });
  }
}

// ---- row helpers

function head(label: string): HTMLElement {
  return h('div', { class: 'set-h' }, label);
}

function row(label: string, desc: string | null, control: Child, extra?: Child): HTMLElement {
  return h('div', { class: 'set-row' }, h('div', { class: 'set-l' }, h('div', { class: 'set-label' }, label), desc ? h('div', { class: 'set-desc' }, desc) : null, extra), control);
}

function toggle(label: string, desc: string | null, on: boolean, onChange: (v: boolean) => void, key: string): HTMLElement {
  return row(label, desc, h('button', { class: cx('tog', { on }), role: 'switch', 'aria-checked': String(on), 'aria-label': label, dataset: { setting: key }, onclick: () => onChange(!on) }, h('span', { class: 'knob' })));
}

function segment<V extends string | number>(label: string, desc: string | null, options: readonly { value: V; label: string }[], current: V, onPick: (v: V) => void, key: string): HTMLElement {
  return row(label, desc, h('div', { class: 'seg', role: 'radiogroup', 'aria-label': label, dataset: { setting: key } }, options.map((o) => h('button', { class: cx('seg-b', { on: o.value === current }), role: 'radio', 'aria-checked': String(o.value === current), dataset: { value: String(o.value) }, onclick: () => onPick(o.value) }, o.label))));
}

function text(label: string, value: string, desc: string | null): HTMLElement {
  return row(label, desc, h('span', { class: 'muted', style: { 'font-size': '13px' } }, value));
}

// ---- sections

function generalSection(s: SettingState, p: PrefsSnapshot): Child[] {
  return [
    head(t('set.general.startup')),
    toggle(t('set.general.autostart'), null, p.general.autostart, (v) => void setPref('general', 'autostart', v), 'general.autostart'),
    segment(t('set.general.closeAction'), null, [{ value: 'tray', label: t('set.general.closeTray') }, { value: 'quit', label: t('set.general.closeQuit') }], p.general.close_action, (v) => void setPref('general', 'close_action', v), 'general.close_action'),
    head(t('set.general.chat')),
    toggle(t('set.general.msgTime'), null, p.general.show_msg_time, (v) => void setPref('general', 'show_msg_time', v), 'general.show_msg_time'),
    head(S.account),
    row(S.personalSettings, t('set.webHint'), h('button', { class: 'btn sm', disabled: !s.account, dataset: { action: 'personal-settings' }, onclick: () => void ipc.invoke(UiCommands.SHELL_OPEN_WEBVIEW, { account: s.account, url: PERSONAL_SETTINGS_URL }).catch((e: unknown) => toast(msg(e))) }, S.open)),
  ];
}

function displaySection(p: PrefsSnapshot): Child[] {
  return [
    segment(t('set.display.zoom'), t('set.display.zoomDesc'), ZOOM_OPTIONS.map((z) => ({ value: z, label: `${z}%` })), p.display.zoom, (v) => void setPref('display', 'zoom', v), 'display.zoom'),
    text(t('set.display.gpu'), t('set.display.managed'), t('set.display.gpuDesc')),
  ];
}

function notifySection(p: PrefsSnapshot): Child[] {
  const r = p.reminder;
  return [
    head(t('set.notify.timeout')),
    toggle(t('set.notify.enabled'), t('set.notify.enabledDesc'), r.enabled, (v) => void setReminder('enabled', v), 'reminder.enabled'),
    row(
      t('set.notify.t1'),
      t('set.notify.t1Desc'),
      h(
        'select',
        { class: 'sel', 'aria-label': t('set.notify.t1'), dataset: { setting: 'reminder.t1_seconds' }, disabled: !r.enabled, onchange: (e: Event) => void setReminder('t1_seconds', Number((e.target as HTMLSelectElement).value)) },
        ALLOWED_T1_SECONDS.map((v) => h('option', { value: String(v), selected: v === r.t1_seconds }, t('set.notify.seconds', { n: v }))),
      ),
    ),
    toggle(t('set.notify.sound'), t('set.notify.soundDesc'), r.timeout_sound, (v) => void setReminder('timeout_sound', v), 'reminder.timeout_sound'),
    toggle(t('set.notify.l4'), t('set.notify.l4Desc'), r.continuous_l4, (v) => void setReminder('continuous_l4', v), 'reminder.continuous_l4'),
    segment(t('set.notify.position'), null, [{ value: 'br', label: t('set.notify.posBR') }, { value: 'bl', label: t('set.notify.posBL') }], r.position_bottom_right ? 'br' : 'bl', (v) => void setReminder('position_bottom_right', v === 'br'), 'reminder.position'),
    head(t('set.notify.dnd')),
    toggle(t('set.notify.dndSchedule'), t('set.notify.dndScheduleDesc'), p.dnd.schedule_enabled, (v) => void setPref('dnd', 'schedule_enabled', v), 'dnd.schedule_enabled'),
    toggle(t('set.notify.dndFollow'), platform === 'macos' ? t('set.notify.dndFollowMac') : t('set.notify.dndFollowWin'), p.dnd.follow_system, (v) => void setPref('dnd', 'follow_system', v), 'dnd.follow_system'),
    toggle(t('set.notify.dndKeep'), t('set.notify.dndKeepDesc'), r.alert_during_dnd, (v) => void setReminder('alert_during_dnd', v), 'reminder.alert_during_dnd'),
    head(t('set.notify.fullscreen')),
    toggle(t('set.notify.fullKeep'), null, r.alert_during_fullscreen, (v) => void setReminder('alert_during_fullscreen', v), 'reminder.alert_during_fullscreen'),
    head(t('set.notify.tray')),
    toggle(t('set.notify.trayFlash'), null, r.tray_flash, (v) => void setReminder('tray_flash', v), 'reminder.tray_flash'),
    toggle(t('set.notify.taskbar'), t('set.notify.taskbarDesc'), r.taskbar_badge, (v) => void setReminder('taskbar_badge', v), 'reminder.taskbar_badge'),
  ];
}

function editShortcut(key: ShortcutKey, value: string): void {
  const s = store.get();
  store.patch({ shortcutDrafts: { ...s.shortcutDrafts, [key]: value }, shortcutErrors: { ...s.shortcutErrors, [key]: null } });
}

async function saveShortcut(key: ShortcutKey): Promise<void> {
  const s = store.get();
  if (!s.prefs || s.shortcutBusy?.[key]) return;
  const value = (s.shortcutDrafts?.[key] ?? s.prefs.keys[key]).trim();
  if (!value) { store.patch({ shortcutErrors: { ...s.shortcutErrors, [key]: t('set.runtime.shortcutRequired') } }); return; }
  store.patch({ shortcutBusy: { ...s.shortcutBusy, [key]: true }, shortcutErrors: { ...s.shortcutErrors, [key]: null } });
  try {
    const next = await ipc.invoke<unknown>(UiCommands.PREFS_SET, { section: 'keys', key, value });
    if (!isPrefsSnapshot(next)) throw new Error(t('set.runtime.shortcutConfirm'));
    const current = store.get(), drafts = { ...current.shortcutDrafts };
    if ((drafts[key] ?? '').trim() === value) delete drafts[key];
    store.patch({ ...(current.prefs ? { prefs: { ...current.prefs, keys: { ...current.prefs.keys, [key]: next.keys[key] } } } : {}), shortcutDrafts: drafts });
    toast(t('set.runtime.shortcutSaved'));
  } catch (e) {
    const current = store.get();
    store.patch({ shortcutErrors: { ...current.shortcutErrors, [key]: t('set.runtime.shortcutFailed', { message: msg(e) }) } });
  } finally {
    const current = store.get();
    store.patch({ shortcutBusy: { ...current.shortcutBusy, [key]: false } });
  }
}

function shortcutRow(p: PrefsSnapshot, key: ShortcutKey, label: string): HTMLElement {
  const s = store.get(), error = s.shortcutErrors?.[key], fid = `shortcut-${key}`;
  const stopKey = (e: KeyboardEvent) => e.stopPropagation();
  return row(label, t('set.runtime.shortcutCurrent', { shortcut: p.keys[key] }), h('form', { class: 'shortcut-form', onsubmit: (e: Event) => { e.preventDefault(); e.stopPropagation(); void saveShortcut(key); } },
    h('input', { class: 'inp', type: 'text', value: s.shortcutDrafts?.[key] ?? p.keys[key], 'aria-label': label, 'aria-describedby': `${fid}-help`, 'aria-invalid': error ? 'true' : 'false', placeholder: t('set.runtime.shortcutPlaceholder'), autocomplete: 'off', spellcheck: false, dataset: { fid }, oninput: (e: Event) => editShortcut(key, (e.target as HTMLInputElement).value), onkeydown: stopKey, onkeyup: stopKey }),
    h('button', { class: 'btn sm', type: 'submit', disabled: !!s.shortcutBusy?.[key], dataset: { fid: `${fid}-save` } }, s.shortcutBusy?.[key] ? t('set.runtime.saving') : t('set.runtime.save')),
    h('span', { id: `${fid}-help`, class: error ? 'hint-bad' : 'muted', ...(error ? { role: 'alert' } : {}) }, error ?? t('set.runtime.shortcutHelp'))));
}

function keysSection(p: PrefsSnapshot): Child[] {
  return [
    segment(t('set.keys.send'), null, [{ value: 'enter', label: t('set.keys.enter') }, { value: 'ctrl_enter', label: t('set.keys.ctrlEnter') }], p.keys.send_key, (v) => void setPref('keys', 'send_key', v), 'keys.send_key'),
    shortcutRow(p, 'toggle_main', t('set.keys.toggleMain')),
  ];
}

function assistantSection(s: SettingState, p: PrefsSnapshot): Child[] {
  const a = p.assistant;
  const status = s.tsimStatus;
  return [
    toggle(t('set.asst.enabled'), null, a.enabled, (v) => void setPref('assistant', 'enabled', v), 'assistant.enabled'),
    toggle(t('set.asst.outbound'), t('set.asst.outboundDesc'), a.outbound_translation, (v) => void setPref('assistant', 'outbound_translation', v), 'assistant.outbound_translation'),
    h(
      'div',
      { class: 'set-row col', dataset: { tsim: '1' } },
      h('div', { class: 'set-l' }, h('div', { class: 'set-label' }, t('set.asst.tsim'), ' ', h('span', { class: cx('chip', status?.logged_in ? 'chip-ok' : 'chip-muted'), dataset: { tsimStatus: status ? status.logged_in ? 'in' : 'out' : 'unknown' } }, status ? tsimStatusText({ ...a, tsim_logged_in: status.logged_in, tsim_user: status.user }) : t('set.runtime.statusUnknown'))), h('div', { class: 'set-desc' }, t('set.asst.tsimDesc'))),
      h('button', { class: 'btn sm', disabled: s.tsimBusy, dataset: { action: 'tsim-refresh' }, onclick: () => void refreshTsimStatus() }, s.tsimBusy ? t('set.runtime.checking') : t('set.runtime.refreshLogin')),
      h('button', { class: 'btn pri', disabled: s.tsimBusy, dataset: { action: 'tsim-browser-connect' }, onclick: () => void tsimBrowserConnect() }, s.tsimBusy ? t('set.runtime.reading') : t('set.runtime.fromChrome')),
      h('p', { class: 'set-desc' }, t('set.runtime.browserDescription')),
      ...(s.tsimBrowserProfiles ?? []).map(p => h('button', { class: 'btn sm', disabled: s.tsimBusy, dataset: { browserProfile: p.id }, onclick: () => void tsimBrowserConnect(p.id) }, t('set.runtime.connectProfile', { label: p.label }))),
      status?.logged_in
        ? h('div', null, h('button', { class: 'btn sm', disabled: s.tsimBusy, dataset: { action: 'tsim-logout' }, onclick: () => void tsimLogout() }, t('set.asst.tsimLogout')))
        : h(
            'form',
            { class: 'tsim-form', onsubmit: (e: Event) => { e.preventDefault(); void tsimLogin(e.currentTarget as HTMLFormElement); } },
            h('input', { class: 'inp', disabled: s.tsimBusy, name: 'username', required: true, placeholder: t('set.asst.tsimUser'), 'aria-label': t('set.asst.tsimUser'), value: s.tsimForm.user, autocomplete: 'username', dataset: { fid: 'tsim-user' }, oninput: (e: Event) => store.patch({ tsimForm: { ...store.get().tsimForm, user: (e.target as HTMLInputElement).value } }) }),
            h('input', { class: 'inp', disabled: s.tsimBusy, type: 'password', name: 'password', required: true, placeholder: t('set.asst.tsimPass'), 'aria-label': t('set.asst.tsimPass'), value: s.tsimForm.password, autocomplete: 'current-password', dataset: { fid: 'tsim-pass' }, oninput: (e: Event) => store.patch({ tsimForm: { ...store.get().tsimForm, password: (e.target as HTMLInputElement).value } }) }),
            h('button', { class: 'btn', type: 'submit', disabled: s.tsimBusy, dataset: { action: 'tsim-login' } }, s.tsimBusy ? h('span', { class: 'spin' }) : null, t('set.asst.tsimLogin')),
          ),
      s.tsimError ? h('div', { class: 'notice-box err', role: 'alert' }, s.tsimError) : null,
      h('details', { open: s.tsimImportExpanded, dataset: { tsimImport: '1' }, ontoggle: (e: Event) => { const expanded = (e.currentTarget as HTMLDetailsElement).open; if (expanded !== store.get().tsimImportExpanded) store.patch({ tsimImportExpanded: expanded, ...(!expanded ? { tsimImportToken: '' } : {}) }); } },
        h('summary', { style: { cursor: 'pointer', 'font-weight': '600' } }, t('set.asst.importTitle')),
        s.tsimImportExpanded ? h('form', { class: 'tsim-form', dataset: { action: 'tsim-import-form' }, onsubmit: (e: Event) => { e.preventDefault(); void tsimImportSession(); } },
          h('p', { class: 'set-desc', style: { width: '100%' } }, t('set.asst.importDesc')),
          h('input', { class: 'inp', type: 'password', name: 'tsim-session-token', 'aria-label': t('set.asst.importToken'), placeholder: t('set.asst.importToken'), value: s.tsimImportToken, autocomplete: 'off', spellcheck: false, autocapitalize: 'off', maxlength: 16384, disabled: s.tsimBusy, dataset: { fid: 'tsim-import-token' }, oninput: (e: Event) => store.patch({ tsimImportToken: (e.target as HTMLInputElement).value }) }),
          h('button', { class: 'btn pri', type: 'submit', dataset: { action: 'tsim-import' }, disabled: s.tsimBusy || !tsimSessionInputValid(s.tsimImportToken) }, s.tsimBusy ? t('set.asst.importBusy') : t('set.asst.importSubmit'))) : null),
    ),
    toggle(t('set.asst.pkg'), t('set.asst.pkgDesc'), a.package_quick_view, (v) => void setPref('assistant', 'package_quick_view', v), 'assistant.package_quick_view'),
  ];
}

function networkSection(s: SettingState, p: PrefsSnapshot): Child[] {
  const net = s.net;
  return [
    toggle(t('set.net.proxy'), t('set.net.proxyDesc'), p.network.system_proxy, (v) => void setPref('network', 'system_proxy', v), 'network.system_proxy'),
    text(t('set.net.status'), net ? (net.online ? `${t('bar.net.online')} · ${net.transport}` : t('bar.net.offline')) : t('app.loading'), null),
  ];
}

function storageSection(): Child[] {
  return [
    text(t('set.storage.cacheDays'), t('set.storage.cacheNone'), t('set.storage.cacheNoneDesc')),
    row(t('set.storage.openData'), null, h('button', { class: 'btn sm', onclick: () => void ipc.invoke(ShellCommands.OPEN_DATA_DIRECTORY).catch((e: unknown) => toast(msg(e))) }, t('set.storage.open'))),
  ];
}

function privacySection(): Child[] {
  return [
    text(t('set.privacy.analytics'), t('set.privacy.notCollected'), t('set.privacy.analyticsDesc')),
    text(t('set.privacy.crash'), t('set.privacy.notCollected'), t('set.privacy.crashDesc')),
    row(t('set.privacy.diag'), t('set.privacy.diagDesc'), h('button', { class: 'btn sm', onclick: () => void ipc.invoke<boolean>(ShellCommands.EXPORT_DIAGNOSTICS).then((saved) => { if (saved) toast(t('set.runtime.diagnosticsExported')); }).catch((e: unknown) => toast(msg(e))) }, t('set.privacy.export'))),
  ];
}

function aboutSection(s: SettingState): Child[] {
  return [
    text(S.version, s.version ?? S.versionUnknown, null),
    row(S.checkUpdate, S.checkUpdateDesc, h('button', { class: 'btn sm pri', dataset: { action: 'check-update' }, onclick: () => void ipc.invoke(UiCommands.SHELL_OPEN_WINDOW, { label: 'update' }).catch((e: unknown) => toast(msg(e))) }, S.checkUpdate)),
  ];
}

function sectionContent(id: SectionId, s: SettingState, p: PrefsSnapshot): Child[] {
  switch (id) {
    case 'general':
      return generalSection(s, p);
    case 'display':
      return displaySection(p);
    case 'notify':
      return notifySection(p);
    case 'keys':
      return keysSection(p);
    case 'assistant':
      return assistantSection(s, p);
    case 'network':
      return networkSection(s, p);
    case 'storage':
      return storageSection();
    case 'privacy':
      return privacySection();
    case 'about':
      return aboutSection(s);
    default:
      return [];
  }
}

/** 全部分类依次排开；每个分类以大标题开头，小标题仍由各 section 自己给。 */
function body(s: SettingState, p: PrefsSnapshot): Child[] {
  return SECTIONS.map((sec) => h('section', { class: 'set-sec', dataset: { setSection: sec.id }, 'aria-labelledby': `set-sec-${sec.id}` }, h('h2', { class: 'set-sec-h', id: `set-sec-${sec.id}` }, sectionLabel(sec)), ...sectionContent(sec.id, s, p)));
}

function closeWindow(): void {
  const s = store.get();
  store.patch({ tsimImportToken: '', tsimImportExpanded: false, tsimRequest: s.tsimRequest + 1, tsimBusy: false });
  void ipc.invoke(UiCommands.SHELL_WINDOW, { action: 'close' }).catch((e: unknown) => toast(msg(e)));
}

function titleBar(s: SettingState): HTMLElement {
  return h(
    'div',
    { class: 'fwin-h', 'data-tauri-drag-region': 'deep' },
    icon(IC.gear, 14),
    h('span', { class: 'fwin-title' }, t('set.title')),
    h('span', { class: 'sp' }),
    sel.mock ? h('span', { class: 'muted mock-tag' }, t('app.mockMode')) : null,
    windowControls({ invoke: (command, payload) => ipc.invoke(command, payload), onClose: closeWindow, closeLabel: S.close, closeDataset: { action: 'close' } }),
  );
}

// ---- 长页面导航：点击滚动 + scroll-spy

/** 点击导航后短时间内不让 scroll-spy 改回高亮。 */
let spyLock: SpyLock | null = null;
let spyFrame = 0;
/** 首次拿到设置内容后，把 URL 指定的分类滚到顶部（只做一次）。 */
let pendingInitialScroll: SectionId | null = isSectionId(params) ? params : null;

function sectionTops(scroller: HTMLElement): { id: SectionId; top: number }[] {
  const base = scroller.getBoundingClientRect().top - scroller.scrollTop;
  const tops: { id: SectionId; top: number }[] = [];
  for (const el of scroller.querySelectorAll<HTMLElement>('[data-set-section]')) {
    const id = el.dataset['setSection'] ?? null;
    if (isSectionId(id)) tops.push({ id, top: el.getBoundingClientRect().top - base });
  }
  return tops;
}

function scrollToSection(id: SectionId, instant: boolean): boolean {
  const scroller = root?.querySelector<HTMLElement>('.setbody');
  const top = scroller ? sectionTops(scroller).find((x) => x.id === id)?.top : undefined;
  if (!scroller || top === undefined) return false;
  const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  scroller.scrollTo({ top, behavior: instant || reduce ? 'auto' : 'smooth' });
  return true;
}

/** 导航点击：先锁住高亮再滚动。仅换分类，不碰 TSim 表单/导入凭据（它们只在提交与关窗时清除）。 */
function selectSection(id: SectionId, fromUser = true): void {
  if (fromUser) settingsNavigationVersion++; // a user choice supersedes a pending deep-link section
  spyLock = { id, until: performance.now() + SPY_LOCK_MS };
  if (store.get().section !== id) store.patch({ section: id });
  scrollToSection(id, false);
}

function onBodyScroll(e: Event): void {
  if (spyFrame) return;
  const scroller = e.currentTarget as HTMLElement;
  spyFrame = requestAnimationFrame(() => {
    spyFrame = 0;
    const current = store.get().section;
    const next = pickActiveSection({ tops: sectionTops(scroller), scrollTop: scroller.scrollTop, clientHeight: scroller.clientHeight, scrollHeight: scroller.scrollHeight, now: performance.now(), current, lock: spyLock });
    // 只有分类变化才 patch，避免滚动期间重复触发重渲染。
    if (next !== current) store.patch({ section: next });
  });
}

function render(s: SettingState): Node {
  return h(
    'div',
    { class: 'setwin' },
    titleBar(s),
    recoveryView(s.recovery, recovery),
    h(
      'div',
      { class: 'setbody-wrap' },
      h('nav', { class: 'setnav', 'aria-label': t('set.group.desktop') }, h('div', { class: 'setnav-g' }, t('set.group.desktop')), SECTIONS.map((sec) => h('button', { class: cx({ on: s.section === sec.id }), type: 'button', 'aria-current': s.section === sec.id ? 'true' : null, dataset: { section: sec.id }, onclick: () => selectSection(sec.id) }, sectionLabel(sec)))),
      h('div', { class: 'setbody', dataset: { keepScroll: 'set' }, onscroll: onBodyScroll }, s.loadError ? h('div', { class: 'notice-box err', role: 'alert' }, s.loadError, h('button', { class: 'btn sm', dataset: { action: 'retry-settings' }, disabled: s.loading, onclick: () => void loadSettings() }, s.loading ? t('set.runtime.retrying') : t('set.runtime.retrySettings'))) : null, s.prefs ? body(s, s.prefs) : !s.loadError ? h('div', { class: 'muted', role: 'status' }, t('app.loading')) : null),
    ),
    s.toast ? h('div', { class: 'toast', role: 'status' }, s.toast) : null,
  );
}

function activeAccountPatch(snap: UiAccountSnapshot): Pick<SettingState, 'account'> {
  const a = snap.accounts.find((x) => x.context.account_id === snap.active_account_id) ?? null;
  return { account: a?.context ?? null };
}

// 增量 morph：滚动容器 .setbody 原地保留，滚动（含平滑滚动）不会被重渲染打断。
function paint(s: SettingState): void {
  rerender(root!, () => render(s), { morph: true });
  if (pendingInitialScroll && s.prefs && scrollToSection(pendingInitialScroll, true)) pendingInitialScroll = null;
}
subscribeBatched(store, paint);
paint(store.get());
let settingsNavigationVersion = 0;
let takingDeepLinkSection = false;
let deepLinkSectionIntent = settingsNavigationVersion;
let deepLinkSectionSerial = 0;
async function takeDeepLinkSection(): Promise<void> {
  if (takingDeepLinkSection) return;
  takingDeepLinkSection = true;
  const previous = deepLinkSectionIntent;
  const serial = deepLinkSectionSerial;
  try {
    const section = await ipc.invoke<unknown>(UiCommands.DEEP_LINK_SETTING_TAKE);
    if (serial === deepLinkSectionSerial && typeof section === 'string' && isSectionId(section) && settingsNavigationVersion === previous) selectSection(section, false);
  } catch { /* The settings window can mount before the host contract is ready. */ }
  finally { takingDeepLinkSection = false; if (serial !== deepLinkSectionSerial) void takeDeepLinkSection(); }
}
if (!sel.mock) {
  void ipc.listen('deeplink://setting-pending', () => { deepLinkSectionSerial++; deepLinkSectionIntent = settingsNavigationVersion; void takeDeepLinkSection(); });
  const deepLinkTimer = setInterval(() => void takeDeepLinkSection(), 2000);
  window.addEventListener('pagehide', () => clearInterval(deepLinkTimer), { once: true });
  void takeDeepLinkSection();
}


ipc.listen<unknown>(Events.PREFS_CHANGED, guarded(Events.PREFS_CHANGED, isPrefsSnapshot, applySettingsSnapshot));
ipc.listen<unknown>(Events.ACCOUNT_CHANGED, guarded(Events.ACCOUNT_CHANGED, isUiAccountSnapshot, (snap) => store.patch(activeAccountPatch(snap))));
void ipc
  .invoke<unknown>(AccountCommands.SNAPSHOT)
  .then((snap) => {
    if (isUiAccountSnapshot(snap)) store.patch(activeAccountPatch(snap));
  })
  .catch(() => undefined);
// Tauri core `app` plugin (granted by core:default); the mock has no version.
if (!sel.mock) {
  void ipc
    .invoke<unknown>('plugin:app|version')
    .then((v) => {
      if (typeof v === 'string' && v) store.patch({ version: v });
    })
    .catch(() => undefined);
}
ipc.listen<unknown>(UiEvents.TSIM_STATUS, receiveTsimStatus);
void loadSettings();
void refreshTsimStatus();

exposeForTests(sel, { __vbkStore: store });
