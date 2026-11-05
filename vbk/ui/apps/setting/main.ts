import { createRecovery, recoveryView, type RecoveryState } from '../_shared/recovery.ts';
/**
 * Settings window, one long page in two nav groups:
 *  - 「账号业务」: 快捷回复 (the shared `_shared/quick-reply-manager.ts`, bound to a chosen
 *    logged-in account) and the entry to the remaining web personal settings;
 *  - 「桌面偏好」: 通用 / 通知与提醒 / 快捷键 / 商家助手 · TSim 登录 / 关于与更新.
 * 左侧是分类导航，右侧所有分类连成一个长页面（点导航滚到对应分类，滚动时 scroll-spy 高亮当前分类）。
 * Reminder fields go through `NotifyCommands.*`; everything else through prefs;
 * TSim through `assistant_tsim_*`; quick replies through `im_quick_reply_*` (inside the manager).
 *
 * Window chrome: macOS uses the overlay title bar (traffic lights in the left
 * 78px of a 40px drag strip, no close button); Windows draws the prototype's
 * 36px `.fwin-h` with its own close button.
 */

import { applyPlatform } from '../_shared/platform.ts';
const platform = applyPlatform();

import type { AccountContext, AlarmCorner, ReminderSettings } from '../../packages/ipc/src/contracts.ts';
import { ALLOWED_T1_SECONDS, isAppError } from '../../packages/ipc/src/contracts.ts';
import { AccountCommands, Events, PrefsCommands, ShellCommands } from '../../packages/ipc/src/commands.ts';
import type { PrefsSection, PrefsSnapshot, UiAccount, UiAccountSnapshot, UiNetStatus, UiTsimStatus } from '../../packages/ipc/src/client.ts';
import { UiCommands, UiEvents } from '../../packages/ipc/src/client.ts';
import { h, icon, rerender, cx } from '../../packages/ui-kit/src/h.ts';
import type { Child } from '../../packages/ui-kit/src/h.ts';
import { createStore, subscribeBatched } from '../../packages/ui-kit/src/store.ts';
import { t } from '../../packages/ui-kit/src/i18n.ts';
import { getSoundProfile, playSound, setSoundProfile } from '../main/sound.ts';
import type { SoundProfile } from '../main/sound.ts';
document.title = t('set.title');
import { IC } from '../_shared/icons.ts';
import { installWindowChrome, windowControls } from '../_shared/window-controls.ts';
import { exposeForTests, selectIpc } from '../_shared/ipc.ts';
import { guarded, isPrefsSnapshot, isUiAccountSnapshot } from '../_shared/guards.ts';
import { mountQuickReplyManager } from '../_shared/quick-reply-manager.ts';
import { EMPTY_TSIM_FORM, PERSONAL_SETTINGS_URL, SECTIONS, SECTION_GROUPS, SPY_LOCK_MS, ZOOM_OPTIONS, accountKey, accountOptionLabel, isSectionId, isTsimStatus, loggedInAccounts, pickActiveSection, pickQuickReplyAccount, prefsCommand, reminderCommand, sectionLabel, sectionNeedsPrefs, tsimErrorText, tsimFormValid, tsimStatusText } from './viewmodel.ts';
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
  readonly settingsRequest: number;
  readonly loading: boolean;
  readonly loadError: string | null;
  readonly net: UiNetStatus | null;
  readonly toast: string | null;
  /** Logged-in accounts, in snapshot order: the choices of the quick-reply account picker. */
  readonly accounts: readonly UiAccount[];
  /** `accountKey` of the account the user wants quick replies for (picked, or the first default); kept while it is offline. */
  readonly qrPreferred: string | null;
  /** The account quick replies and the web personal settings act for (current generation); `null` while the preferred one is offline. */
  readonly qrAccount: AccountContext | null;
  /** A quick-reply write is in flight: the account picker is locked until it settles. */
  readonly qrBusy: boolean;
  readonly version: string | null;
}

const params = new URLSearchParams(location.search).get('section');
const store = createStore<SettingState>({ prefs: null, section: isSectionId(params) ? params : 'quick_replies', tsimForm: EMPTY_TSIM_FORM, tsimBusy: false, tsimError: null, tsimStatus: null, tsimRequest: 0, settingsRequest: 0, loading: false, loadError: null, net: null, toast: null, accounts: [], qrPreferred: null, qrAccount: null, qrBusy: false, version: null });
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

/**
 * The quick-reply manager owns this host's children. The settings page passes the same
 * (connected) element on every paint, so the morph keeps it in place with its state.
 */
const qrHost = document.createElement('div');
qrHost.className = 'set-qr-host';
const quickReplies = mountQuickReplyManager(qrHost, { invoke: (command, payload) => ipc.invoke(command, payload), account: null, onBusyChange: (busy) => store.patch({ qrBusy: busy }) });
window.addEventListener('pagehide', () => quickReplies.destroy(), { once: true });

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

// ---- quick replies: account binding

/**
 * Account list or generation changed: follow the preferred account (with its new generation)
 * while it is logged in; while it is offline bind none and say so, never silently another one.
 * This runs even while a quick-reply write is in flight: the old context is no longer valid.
 * `setAccount` is a no-op for the same context, so an unrelated account change keeps the manager as is.
 */
function applyAccounts(snap: UiAccountSnapshot): void {
  const accounts = loggedInAccounts(snap);
  const { preferred, account } = pickQuickReplyAccount(accounts, store.get().qrPreferred);
  store.patch({ accounts, qrPreferred: preferred, qrAccount: account });
  quickReplies.setAccount(account);
}

/**
 * Subscribe first and wait until the host has the listener, then read the snapshot; an account
 * event that arrives before the reply is newer, so the reply is dropped.
 */
async function loadAccounts(): Promise<void> {
  let events = 0;
  const onChanged = guarded(Events.ACCOUNT_CHANGED, isUiAccountSnapshot, (snap) => { events++; applyAccounts(snap); });
  try {
    if (ipc.listenReady) await ipc.listenReady<unknown>(Events.ACCOUNT_CHANGED, onChanged);
    else ipc.listen<unknown>(Events.ACCOUNT_CHANGED, onChanged);
  } catch { /* no live updates; the snapshot below still fills the picker */ }
  const seen = events;
  try {
    const snap = await ipc.invoke<unknown>(AccountCommands.SNAPSHOT);
    if (events === seen && isUiAccountSnapshot(snap)) applyAccounts(snap);
  } catch { /* the picker stays as it is */ }
}

/**
 * A manual pick becomes the preference. While a quick-reply write is in flight the picker is
 * disabled and a pick is ignored; the repaint puts the select back on the bound account.
 */
function pickQrAccount(key: string): void {
  const picked = store.get().accounts.find((a) => accountKey(a.context) === key);
  if (!picked || store.get().qrBusy || quickReplies.busy()) { store.patch({}); return; }
  store.patch({ qrPreferred: key, qrAccount: picked.context });
  quickReplies.setAccount(picked.context);
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

/**
 * 账号业务 · 快捷回复: account picker, the shared manager (fixed height, scrolls inside), web personal settings.
 * While the preferred account is offline the picker shows a placeholder for it and a hint, and binds nothing.
 */
function quickRepliesSection(s: SettingState): Child[] {
  const current = s.qrAccount ? accountKey(s.qrAccount) : '';
  const offline = s.qrPreferred !== null && !s.qrAccount;
  const options = s.accounts.map((a) => h('option', { value: accountKey(a.context), selected: accountKey(a.context) === current }, accountOptionLabel(a)));
  return [
    row(
      S.account,
      t('set.qr.accountDesc'),
      h(
        'select',
        { class: 'sel', 'aria-label': S.account, disabled: s.accounts.length === 0 || s.qrBusy, dataset: { action: 'qr-account' }, onchange: (e: Event) => pickQrAccount((e.target as HTMLSelectElement).value) },
        offline ? h('option', { value: '', selected: true, disabled: true }, t('set.qr.preferredOffline')) : null,
        options.length > 0 || offline ? options : h('option', { value: '' }, t('set.qr.noAccount')),
      ),
      offline ? h('div', { class: 'notice-box warn', role: 'status', dataset: { qrOffline: '1' } }, t('set.qr.preferredOfflineHint')) : null,
    ),
    qrHost,
    row(S.personalSettings, t('set.webHint'), h('button', { class: 'btn sm', disabled: !s.qrAccount, dataset: { action: 'personal-settings' }, onclick: () => void ipc.invoke(UiCommands.SHELL_OPEN_WEBVIEW, { account: s.qrAccount, url: PERSONAL_SETTINGS_URL }).catch((e: unknown) => toast(msg(e))) }, S.open)),
  ];
}

function generalSection(p: PrefsSnapshot): Child[] {
  return [
    head(t('set.general.startup')),
    toggle(t('set.general.autostart'), null, p.general.autostart, (v) => void setPref('general', 'autostart', v), 'general.autostart'),
    segment(t('set.general.closeAction'), null, [{ value: 'tray', label: t('set.general.closeTray') }, { value: 'quit', label: t('set.general.closeQuit') }], p.general.close_action, (v) => void setPref('general', 'close_action', v), 'general.close_action'),
    head(t('set.general.display')),
    toggle(t('set.general.msgTime'), null, p.general.show_msg_time, (v) => void setPref('general', 'show_msg_time', v), 'general.show_msg_time'),
    segment(t('set.display.zoom'), t('set.display.zoomDesc'), ZOOM_OPTIONS.map((z) => ({ value: z, label: `${z}%` })), p.display.zoom, (v) => void setPref('display', 'zoom', v), 'display.zoom'),
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
    segment(t('set.notify.tone'), t('set.notify.toneDesc'), [{ value: 'soft' as SoundProfile, label: t('set.notify.toneSoft') }, { value: 'strong' as SoundProfile, label: t('set.notify.toneStrong') }], getSoundProfile(), (v) => { setSoundProfile(v); playSound('timeout'); store.patch({}); }, 'local.sound_profile'),
    toggle(t('set.notify.l4'), t('set.notify.l4Desc'), r.continuous_l4, (v) => void setReminder('continuous_l4', v), 'reminder.continuous_l4'),
    segment(t('set.notify.position'), null, [{ value: 'top_left' as AlarmCorner, label: t('set.notify.posTL') }, { value: 'top_right' as AlarmCorner, label: t('set.notify.posTR') }, { value: 'bottom_left' as AlarmCorner, label: t('set.notify.posBL') }, { value: 'bottom_right' as AlarmCorner, label: t('set.notify.posBR') }], r.alarm_corner, (v) => void setReminder('alarm_corner', v), 'reminder.alarm_corner'),
    head(t('set.notify.dnd')),
    toggle(t('set.notify.dndSchedule'), t('set.notify.dndScheduleDesc'), p.dnd.schedule_enabled, (v) => void setPref('dnd', 'schedule_enabled', v), 'dnd.schedule_enabled'),
    toggle(t('set.notify.dndFollow'), platform === 'macos' ? t('set.notify.dndFollowMac') : t('set.notify.dndFollowWin'), p.dnd.follow_system, (v) => void setPref('dnd', 'follow_system', v), 'dnd.follow_system'),
    toggle(t('set.notify.dndKeep'), t('set.notify.dndKeepDesc'), r.alert_during_dnd, (v) => void setReminder('alert_during_dnd', v), 'reminder.alert_during_dnd'),
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
    h('input', { class: 'inp', type: 'text', value: s.shortcutDrafts?.[key] ?? p.keys[key], 'aria-label': label, 'aria-describedby': `${fid}-help`, 'aria-invalid': error ? 'true' : 'false', placeholder: t('set.runtime.shortcutPlaceholder'), autocomplete: 'off', spellcheck: false, dataset: { fid, setting: `keys.${key}` }, oninput: (e: Event) => editShortcut(key, (e.target as HTMLInputElement).value), onkeydown: stopKey, onkeyup: stopKey }),
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
    ),
    toggle(t('set.asst.pkg'), t('set.asst.pkgDesc'), a.package_quick_view, (v) => void setPref('assistant', 'package_quick_view', v), 'assistant.package_quick_view'),
  ];
}

/** 关于与更新: version / update, IM status and proxy, data directory and diagnostics. */
function aboutSection(s: SettingState, p: PrefsSnapshot): Child[] {
  const net = s.net;
  return [
    text(S.version, s.version ?? S.versionUnknown, null),
    row(S.checkUpdate, S.checkUpdateDesc, h('button', { class: 'btn sm pri', dataset: { action: 'check-update' }, onclick: () => void ipc.invoke(UiCommands.SHELL_OPEN_WINDOW, { label: 'update' }).catch((e: unknown) => toast(msg(e))) }, S.checkUpdate)),
    head(t('set.about.network')),
    text(t('set.net.status'), net ? (net.online ? `${t('bar.net.online')} · ${net.transport}` : t('bar.net.offline')) : t('app.loading'), null),
    toggle(t('set.net.proxy'), t('set.net.proxyDesc'), p.network.system_proxy, (v) => void setPref('network', 'system_proxy', v), 'network.system_proxy'),
    head(t('set.about.data')),
    row(t('set.about.dataDir'), null, h('button', { class: 'btn sm', dataset: { action: 'open-data-dir' }, onclick: () => void ipc.invoke(ShellCommands.OPEN_DATA_DIRECTORY).catch((e: unknown) => toast(msg(e))) }, S.open)),
    row(t('set.about.diag'), t('set.about.diagDesc'), h('button', { class: 'btn sm', dataset: { action: 'export-diagnostics' }, onclick: () => void ipc.invoke<boolean>(ShellCommands.EXPORT_DIAGNOSTICS).then((saved) => { if (saved) toast(t('set.runtime.diagnosticsExported')); }).catch((e: unknown) => toast(msg(e))) }, t('set.about.export'))),
  ];
}

function sectionContent(id: SectionId, s: SettingState): Child[] {
  if (id === 'quick_replies') return quickRepliesSection(s);
  const p = s.prefs;
  if (!p) return [];
  switch (id) {
    case 'general':
      return generalSection(p);
    case 'notify':
      return notifySection(p);
    case 'keys':
      return keysSection(p);
    case 'assistant':
      return assistantSection(s, p);
    case 'about':
      return aboutSection(s, p);
    default:
      return [];
  }
}

/**
 * 全部分类依次排开；每个分类以大标题开头，小标题仍由各 section 自己给。
 * 账号业务不依赖本机设置快照，总是渲染；桌面偏好等快照到达，在此之前由加载中或错误与重试占位。
 */
function body(s: SettingState): Child[] {
  return [
    ...SECTIONS.filter((sec) => s.prefs || !sectionNeedsPrefs(sec.id)).map((sec) => h('section', { class: 'set-sec', dataset: { setSection: sec.id }, 'aria-labelledby': `set-sec-${sec.id}` }, h('h2', { class: 'set-sec-h', id: `set-sec-${sec.id}` }, sectionLabel(sec)), ...sectionContent(sec.id, s))),
    s.loadError ? h('div', { class: 'notice-box err', role: 'alert' }, s.loadError, h('button', { class: 'btn sm', dataset: { action: 'retry-settings' }, disabled: s.loading, onclick: () => void loadSettings() }, s.loading ? t('set.runtime.retrying') : t('set.runtime.retrySettings'))) : null,
    !s.prefs && !s.loadError ? h('div', { class: 'muted', role: 'status' }, t('app.loading')) : null,
  ];
}

/** 两组导航：组名 + 该组分类按钮，顺序与长页面一致。 */
function nav(s: SettingState): HTMLElement {
  return h(
    'nav',
    { class: 'setnav', 'aria-label': t('set.title') },
    SECTION_GROUPS.flatMap((g) => [
      h('div', { class: 'setnav-g', dataset: { group: g.id } }, sectionLabel(g)),
      ...SECTIONS.filter((sec) => sec.group === g.id).map((sec) => h('button', { class: cx({ on: s.section === sec.id }), type: 'button', 'aria-current': s.section === sec.id ? 'true' : null, dataset: { section: sec.id }, onclick: () => void selectSection(sec.id) }, sectionLabel(sec))),
    ]),
  );
}

function closeWindow(): void {
  const s = store.get();
  store.patch({ tsimRequest: s.tsimRequest + 1, tsimBusy: false });
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
/**
 * 还没能滚过去的分类：URL 指定的，或在它渲染出来之前（设置快照未到）经深链、导航选中的。
 * 每次绘制后若它已渲染就滚到顶部，只做一次；之后的任何选择都会替换它。
 */
let pendingInitialScroll: SectionId | null = isSectionId(params) ? params : null;
/** 深链指向商家助手：滚到之后还要露出 TSim 登录行；之后的任何选择都会取消它。 */
let pendingTsimReveal = false;
/** 用户每次点导航都 +1；深链结果到达前用户已自己选过，深链就不再改分类。 */
let settingsNavigationVersion = 0;
let takingDeepLinkSection = false;
let deepLinkSectionIntent = settingsNavigationVersion;
let deepLinkSectionSerial = 0;

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

/**
 * 导航点击或深链：先锁住高亮再滚动。仅换分类，不碰 TSim 表单/导入凭据（它们只在提交与关窗时清除）。
 * 该分类还没渲染时记为待滚动，由 paint 补上；返回是否已经滚过去。
 */
function selectSection(id: SectionId, fromUser = true): boolean {
  if (fromUser) settingsNavigationVersion++; // a user choice supersedes a pending deep-link section
  pendingTsimReveal = false;
  spyLock = { id, until: performance.now() + SPY_LOCK_MS };
  if (store.get().section !== id) store.patch({ section: id });
  const scrolled = scrollToSection(id, false);
  pendingInitialScroll = scrolled ? null : id;
  return scrolled;
}

/** TSim 入口：滚到登录行中部；未登录时聚焦用户名。 */
function revealTsimLogin(): void {
  const row = root?.querySelector<HTMLElement>('[data-tsim="1"]');
  if (!row) return;
  const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  row.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
  root?.querySelector<HTMLInputElement>('[data-fid="tsim-user"]')?.focus({ preventScroll: true });
}

/** 绘制之后：待滚动的分类已渲染就瞬时滚过去，并补上深链要求的 TSim 登录行定位。 */
function flushPendingSection(): void {
  const id = pendingInitialScroll;
  if (!id || !scrollToSection(id, true)) return;
  pendingInitialScroll = null;
  spyLock = { id, until: performance.now() + SPY_LOCK_MS };
  if (pendingTsimReveal) { pendingTsimReveal = false; revealTsimLogin(); }
}

/** 取走宿主暂存的深链分类；设置快照未到时先记下，由 paint 在分类渲染后滚动并定位 TSim。 */
async function takeDeepLinkSection(): Promise<void> {
  if (takingDeepLinkSection) return;
  takingDeepLinkSection = true;
  const previous = deepLinkSectionIntent;
  const serial = deepLinkSectionSerial;
  try {
    const section = await ipc.invoke<unknown>(UiCommands.DEEP_LINK_SETTING_TAKE);
    if (serial === deepLinkSectionSerial && typeof section === 'string' && isSectionId(section) && settingsNavigationVersion === previous) {
      const scrolled = selectSection(section, false);
      if (section === 'assistant') { if (scrolled) revealTsimLogin(); else pendingTsimReveal = true; }
    }
  } catch { /* The settings window can mount before the host contract is ready. */ }
  finally { takingDeepLinkSection = false; if (serial !== deepLinkSectionSerial) void takeDeepLinkSection(); }
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
      nav(s),
      h('div', { class: 'setbody', dataset: { keepScroll: 'set' }, onscroll: onBodyScroll }, body(s)),
    ),
    s.toast ? h('div', { class: 'toast', role: 'status' }, s.toast) : null,
  );
}

// 增量 morph：滚动容器 .setbody 原地保留，滚动（含平滑滚动）不会被重渲染打断。
function paint(s: SettingState): void {
  rerender(root!, () => render(s), { morph: true });
  flushPendingSection();
}
subscribeBatched(store, paint);
paint(store.get());
if (!sel.mock) {
  void ipc.listen('deeplink://setting-pending', () => { deepLinkSectionSerial++; deepLinkSectionIntent = settingsNavigationVersion; void takeDeepLinkSection(); });
  // The event above is the live path; the poll only covers a missed event, so a hidden page skips it.
  const visible = (): boolean => document.visibilityState !== 'hidden';
  const deepLinkTimer = setInterval(() => { if (visible()) void takeDeepLinkSection(); }, 2000);
  document.addEventListener('visibilitychange', () => { if (visible()) void takeDeepLinkSection(); });
  window.addEventListener('pagehide', () => clearInterval(deepLinkTimer), { once: true });
  void takeDeepLinkSection();
}


ipc.listen<unknown>(Events.PREFS_CHANGED, guarded(Events.PREFS_CHANGED, isPrefsSnapshot, applySettingsSnapshot));
void loadAccounts();
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
