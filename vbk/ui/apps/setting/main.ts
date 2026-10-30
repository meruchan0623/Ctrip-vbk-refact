/**
 * Settings window (prototype 02-main `.fwin` 设置): 通用 / 显示 / 通知与提醒 /
 * 快捷键 / 商家助手 / 网络 / 存储 / 隐私 / 关于与更新.
 * Reminder fields go through `NotifyCommands.*`; everything else through prefs;
 * TSim through `assistant_tsim_*`.
 *
 * Window chrome: macOS uses the overlay title bar (traffic lights in the left
 * 78px of a 40px drag strip, no close button); Windows draws the prototype's
 * 36px `.fwin-h` with its own close button.
 */

import { applyPlatform } from '../_shared/platform.ts';
const platform = applyPlatform();

import type { ReminderSettings } from '../../packages/ipc/src/contracts.ts';
import { ALLOWED_T1_SECONDS, isAppError } from '../../packages/ipc/src/contracts.ts';
import { AccountCommands, Events, PrefsCommands } from '../../packages/ipc/src/commands.ts';
import type { PrefsSection, PrefsSnapshot, UiAccountSnapshot, UiNetStatus, UiTsimStatus } from '../../packages/ipc/src/client.ts';
import { UiCommands } from '../../packages/ipc/src/client.ts';
import { h, icon, rerender, cx } from '../../packages/ui-kit/src/h.ts';
import type { Child } from '../../packages/ui-kit/src/h.ts';
import { createStore, subscribeBatched } from '../../packages/ui-kit/src/store.ts';
import { t } from '../../packages/ui-kit/src/i18n.ts';
import { IC } from '../_shared/icons.ts';
import { exposeForTests, selectIpc } from '../_shared/ipc.ts';
import { guarded, isPrefsSnapshot, isUiAccountSnapshot } from '../_shared/guards.ts';
import { CACHE_DAY_OPTIONS, EMPTY_TSIM_FORM, SECTIONS, ZOOM_OPTIONS, isSectionId, prefsCommand, reminderCommand, sectionLabel, sendModeDescription, tsimFormValid, tsimStatusText } from './viewmodel.ts';
import { SETTING_STRINGS as S, fmt } from './strings.ts';
import type { SectionId, TsimForm } from './viewmodel.ts';

interface SettingState {
  readonly prefs: PrefsSnapshot | null;
  readonly section: SectionId;
  readonly tsimForm: TsimForm;
  readonly tsimBusy: boolean;
  readonly tsimError: string | null;
  readonly net: UiNetStatus | null;
  readonly toast: string | null;
  /** Nick of the active account for the title (prototype 「设置 · 昵称」). */
  readonly nick: string | null;
  readonly version: string | null;
}

const params = new URLSearchParams(location.search).get('section');
const store = createStore<SettingState>({ prefs: null, section: isSectionId(params) ? params : 'notify', tsimForm: EMPTY_TSIM_FORM, tsimBusy: false, tsimError: null, net: null, toast: null, nick: null, version: null });
const sel = selectIpc();
const ipc = sel.ipc;
const root = document.getElementById('app');
if (!root) throw new Error('#app missing');

let toastTimer: ReturnType<typeof setTimeout> | null = null;
function toast(text: string): void {
  store.patch({ toast: text });
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => store.patch({ toast: null }), 2000);
}

function msg(e: unknown): string {
  return isAppError(e) ? e.message : e instanceof Error ? e.message : String(e);
}

async function setReminder<K extends keyof ReminderSettings>(key: K, value: ReminderSettings[K]): Promise<void> {
  const p = store.get().prefs;
  if (!p) return;
  const prev = p.reminder;
  store.patch({ prefs: { ...p, reminder: { ...prev, [key]: value } } }); // optimistic; reverted on failure
  try {
    const { cmd, payload } = reminderCommand(key, value);
    await ipc.invoke(cmd, payload);
    toast(t('set.saved'));
  } catch (e) {
    const cur = store.get().prefs;
    if (cur) store.patch({ prefs: { ...cur, reminder: prev } });
    toast(t('set.saveFailed', { msg: msg(e) }));
  }
}

async function setPref(section: PrefsSection, key: string, value: boolean | string | number): Promise<void> {
  const p = store.get().prefs;
  if (!p) return;
  const prevSection = p[section];
  store.patch({ prefs: { ...p, [section]: { ...prevSection, [key]: value } } as PrefsSnapshot });
  try {
    const { cmd, payload } = prefsCommand(section, key, value);
    const next = await ipc.invoke<PrefsSnapshot>(cmd, payload);
    store.patch({ prefs: next });
    toast(t('set.saved'));
  } catch (e) {
    const cur = store.get().prefs;
    if (cur) store.patch({ prefs: { ...cur, [section]: prevSection } as PrefsSnapshot });
    toast(t('set.saveFailed', { msg: msg(e) }));
  }
}

async function tsimLogin(): Promise<void> {
  const s = store.get();
  if (!tsimFormValid(s.tsimForm) || s.tsimBusy) return;
  store.patch({ tsimBusy: true, tsimError: null });
  try {
    await ipc.invoke<UiTsimStatus>(UiCommands.ASSIST_TSIM_LOGIN, { user: s.tsimForm.user.trim(), password: s.tsimForm.password });
    // never keep the password in UI state after submit
    store.patch({ tsimBusy: false, tsimForm: EMPTY_TSIM_FORM });
    const p = await ipc.invoke<PrefsSnapshot>(PrefsCommands.SNAPSHOT);
    store.patch({ prefs: p });
  } catch (e) {
    store.patch({ tsimBusy: false, tsimError: t('set.asst.tsimFailed', { msg: msg(e) }), tsimForm: { user: s.tsimForm.user, password: '' } });
  }
}

async function tsimLogout(): Promise<void> {
  try {
    await ipc.invoke(UiCommands.ASSIST_TSIM_LOGOUT, {});
    const p = await ipc.invoke<PrefsSnapshot>(PrefsCommands.SNAPSHOT);
    store.patch({ prefs: p });
  } catch (e) {
    toast(t('set.saveFailed', { msg: msg(e) }));
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

function generalSection(p: PrefsSnapshot): Child[] {
  return [
    head(t('set.general.startup')),
    toggle(t('set.general.autostart'), null, p.general.autostart, (v) => void setPref('general', 'autostart', v), 'general.autostart'),
    segment(t('set.general.closeAction'), null, [{ value: 'tray', label: t('set.general.closeTray') }, { value: 'quit', label: t('set.general.closeQuit') }], p.general.close_action, (v) => void setPref('general', 'close_action', v), 'general.close_action'),
    toggle(t('set.general.startHidden'), null, p.general.start_hidden, (v) => void setPref('general', 'start_hidden', v), 'general.start_hidden'),
    head(t('set.general.chat')),
    toggle(t('set.general.msgTime'), null, p.general.show_msg_time, (v) => void setPref('general', 'show_msg_time', v), 'general.show_msg_time'),
    toggle(t('set.general.spell'), t('set.general.spellDesc'), p.general.spell_check, (v) => void setPref('general', 'spell_check', v), 'general.spell_check'),
    h('div', { class: 'notice-box info', style: { 'margin-top': '14px' } }, t('set.webHint')),
  ];
}

function displaySection(p: PrefsSnapshot): Child[] {
  return [
    head(t('set.display')),
    segment(t('set.display.zoom'), null, ZOOM_OPTIONS.map((z) => ({ value: z, label: `${z}%` })), p.display.zoom, (v) => void setPref('display', 'zoom', v), 'display.zoom'),
    toggle(t('set.display.gpu'), t('set.display.gpuDesc'), p.display.gpu, (v) => void setPref('display', 'gpu', v), 'display.gpu'),
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
    toggle(t('set.notify.dndSchedule'), null, p.dnd.schedule_enabled, (v) => void setPref('dnd', 'schedule_enabled', v), 'dnd.schedule_enabled'),
    toggle(t('set.notify.dndFollow'), null, p.dnd.follow_system, (v) => void setPref('dnd', 'follow_system', v), 'dnd.follow_system'),
    toggle(t('set.notify.dndKeep'), t('set.notify.dndKeepDesc'), r.alert_during_dnd, (v) => void setReminder('alert_during_dnd', v), 'reminder.alert_during_dnd'),
    head(t('set.notify.fullscreen')),
    toggle(t('set.notify.fullKeep'), null, r.alert_during_fullscreen, (v) => void setReminder('alert_during_fullscreen', v), 'reminder.alert_during_fullscreen'),
    head(t('set.notify.tray')),
    toggle(t('set.notify.trayFlash'), null, r.tray_flash, (v) => void setReminder('tray_flash', v), 'reminder.tray_flash'),
    toggle(t('set.notify.taskbar'), t('set.notify.taskbarDesc'), r.taskbar_badge, (v) => void setReminder('taskbar_badge', v), 'reminder.taskbar_badge'),
  ];
}

function keysSection(p: PrefsSnapshot): Child[] {
  return [
    head(t('set.keys')),
    segment(t('set.keys.send'), null, [{ value: 'enter', label: t('set.keys.enter') }, { value: 'ctrl_enter', label: t('set.keys.ctrlEnter') }], p.keys.send_key, (v) => void setPref('keys', 'send_key', v), 'keys.send_key'),
    row(t('set.keys.screenshot'), t('set.keys.screenshotDesc'), h('span', { class: 'kbd' }, p.keys.screenshot)),
    row(t('set.keys.toggleMain'), null, h('span', { class: 'kbd' }, p.keys.toggle_main)),
  ];
}

function assistantSection(s: SettingState, p: PrefsSnapshot): Child[] {
  const a = p.assistant;
  return [
    head(t('set.assistant')),
    toggle(t('set.asst.enabled'), null, a.enabled, (v) => void setPref('assistant', 'enabled', v), 'assistant.enabled'),
    toggle(t('set.asst.outbound'), t('set.asst.outboundDesc'), a.outbound_translation, (v) => void setPref('assistant', 'outbound_translation', v), 'assistant.outbound_translation'),
    text(t('set.asst.outService'), t('set.asst.outServiceVal'), t('set.asst.outServiceDesc')),
    text(t('set.asst.inService'), t('set.asst.inServiceVal'), t('set.asst.inServiceDesc')),
    h(
      'div',
      { class: 'set-row col' },
      h('div', { class: 'set-l' }, h('div', { class: 'set-label' }, t('set.asst.sendMode'))),
      h(
        'div',
        { class: 'mode-opts', role: 'radiogroup', 'aria-label': t('set.asst.sendMode') },
        h('button', { class: cx('opt', { on: a.send_mode === 'replace_draft' }), role: 'radio', 'aria-checked': String(a.send_mode === 'replace_draft'), dataset: { sendMode: 'replace_draft' }, onclick: () => void setPref('assistant', 'send_mode', 'replace_draft') }, h('span', { class: 'radio' }), h('span', null, h('b', null, t('set.asst.modeReplace')), h('span', { class: 'muted', style: { display: 'block', 'font-size': '12px' } }, sendModeDescription('replace_draft')))),
        h('button', { class: cx('opt', { on: a.send_mode === 'send_direct' }), role: 'radio', 'aria-checked': String(a.send_mode === 'send_direct'), dataset: { sendMode: 'send_direct' }, onclick: () => void setPref('assistant', 'send_mode', 'send_direct') }, h('span', { class: 'radio' }), h('span', null, h('b', null, t('set.asst.modeDirect')), h('span', { class: 'muted', style: { display: 'block', 'font-size': '12px' } }, sendModeDescription('send_direct')))),
      ),
      h('div', { class: 'set-desc' }, t('set.asst.modeCommon')),
    ),
    h(
      'div',
      { class: 'set-row col', dataset: { tsim: '1' } },
      h('div', { class: 'set-l' }, h('div', { class: 'set-label' }, t('set.asst.tsim'), ' ', h('span', { class: cx('chip', a.tsim_logged_in ? 'chip-ok' : 'chip-muted'), dataset: { tsimStatus: a.tsim_logged_in ? 'in' : 'out' } }, tsimStatusText(a))), h('div', { class: 'set-desc' }, t('set.asst.tsimDesc'))),
      a.tsim_logged_in
        ? h('div', null, h('button', { class: 'btn sm', dataset: { action: 'tsim-logout' }, onclick: () => void tsimLogout() }, t('set.asst.tsimLogout')))
        : h(
            'form',
            { class: 'tsim-form', onsubmit: (e: Event) => { e.preventDefault(); void tsimLogin(); } },
            h('input', { class: 'inp', placeholder: t('set.asst.tsimUser'), 'aria-label': t('set.asst.tsimUser'), value: s.tsimForm.user, autocomplete: 'username', dataset: { fid: 'tsim-user' }, oninput: (e: Event) => store.patch({ tsimForm: { ...store.get().tsimForm, user: (e.target as HTMLInputElement).value } }) }),
            h('input', { class: 'inp', type: 'password', placeholder: t('set.asst.tsimPass'), 'aria-label': t('set.asst.tsimPass'), value: s.tsimForm.password, autocomplete: 'current-password', dataset: { fid: 'tsim-pass' }, oninput: (e: Event) => store.patch({ tsimForm: { ...store.get().tsimForm, password: (e.target as HTMLInputElement).value } }) }),
            h('button', { class: 'btn pri', type: 'submit', disabled: !tsimFormValid(s.tsimForm) || s.tsimBusy, dataset: { action: 'tsim-login' } }, s.tsimBusy ? h('span', { class: 'spin' }) : null, t('set.asst.tsimLogin')),
          ),
      s.tsimError ? h('div', { class: 'notice-box err', role: 'alert' }, s.tsimError) : null,
    ),
    toggle(t('set.asst.pkg'), t('set.asst.pkgDesc'), a.package_quick_view, (v) => void setPref('assistant', 'package_quick_view', v), 'assistant.package_quick_view'),
  ];
}

function networkSection(s: SettingState, p: PrefsSnapshot): Child[] {
  const net = s.net;
  return [
    head(t('set.network')),
    toggle(t('set.net.proxy'), t('set.net.proxyDesc'), p.network.system_proxy, (v) => void setPref('network', 'system_proxy', v), 'network.system_proxy'),
    text(t('set.net.status'), net ? (net.online ? `${t('bar.net.online')} · ${net.transport}` : t('bar.net.offline')) : t('app.loading'), null),
  ];
}

function storageSection(p: PrefsSnapshot): Child[] {
  return [
    head(t('set.storage')),
    segment(t('set.storage.cacheDays'), null, CACHE_DAY_OPTIONS.map((d) => ({ value: d, label: t('set.storage.days', { n: d }) })), p.storage.cache_days, (v) => void setPref('storage', 'cache_days', v), 'storage.cache_days'),
    row(t('set.storage.cache'), t('set.storage.cacheSize', { n: p.storage.cache_mb }), h('button', { class: 'btn sm', onclick: () => void setPref('storage', 'cache_mb', 0) }, t('set.storage.clear'))),
    row(t('set.storage.openData'), null, h('button', { class: 'btn sm', onclick: () => void ipc.invoke(UiCommands.SHELL_OPEN_EXTERNAL, { url: 'file:///data-dir' }).catch((e: unknown) => toast(msg(e))) }, t('set.storage.open'))),
  ];
}

function privacySection(p: PrefsSnapshot): Child[] {
  return [
    head(t('set.privacy')),
    toggle(t('set.privacy.analytics'), t('set.privacy.analyticsDesc'), p.privacy.analytics, (v) => void setPref('privacy', 'analytics', v), 'privacy.analytics'),
    toggle(t('set.privacy.crash'), t('set.privacy.crashDesc'), p.privacy.crash_upload, (v) => void setPref('privacy', 'crash_upload', v), 'privacy.crash_upload'),
    row(t('set.privacy.diag'), t('set.privacy.diagDesc'), h('button', { class: 'btn sm', onclick: () => void ipc.invoke(UiCommands.SHELL_OPEN_WINDOW, { label: 'diag' }).catch((e: unknown) => toast(msg(e))) }, t('set.privacy.export'))),
  ];
}

function aboutSection(s: SettingState): Child[] {
  return [
    head(S.aboutHead),
    text(S.version, s.version ?? S.versionUnknown, null),
    row(S.checkUpdate, S.checkUpdateDesc, h('button', { class: 'btn sm pri', dataset: { action: 'check-update' }, onclick: () => void ipc.invoke(UiCommands.SHELL_OPEN_WINDOW, { label: 'update' }).catch((e: unknown) => toast(msg(e))) }, S.checkUpdate)),
  ];
}

function body(s: SettingState, p: PrefsSnapshot): Child[] {
  switch (s.section) {
    case 'general':
      return generalSection(p);
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
      return storageSection(p);
    case 'privacy':
      return privacySection(p);
    case 'about':
      return aboutSection(s);
    default:
      return [];
  }
}

function closeWindow(): void {
  void ipc.invoke(UiCommands.SHELL_WINDOW, { action: 'close' }).catch((e: unknown) => toast(msg(e)));
}

function titleBar(s: SettingState): HTMLElement {
  const title = s.nick ? fmt(S.titleWithAccount, { nick: s.nick }) : t('set.title');
  return h(
    'div',
    { class: 'fwin-h', 'data-tauri-drag-region': 'deep' },
    icon(IC.gear, 14),
    h('span', { class: 'fwin-title' }, title),
    h('span', { class: 'sp' }),
    sel.mock ? h('span', { class: 'muted mock-tag' }, t('app.mockMode')) : null,
    platform === 'windows' ? h('button', { class: 'cap-x', 'aria-label': S.close, title: S.close, dataset: { action: 'close' }, onclick: closeWindow }, icon(IC.close, 14)) : null,
  );
}

function render(s: SettingState): Node {
  return h(
    'div',
    { class: 'setwin' },
    titleBar(s),
    h(
      'div',
      { class: 'setbody-wrap' },
      h('div', { class: 'setnav', role: 'tablist' }, h('div', { class: 'setnav-g' }, t('set.group.desktop')), SECTIONS.map((sec) => h('button', { class: cx({ on: s.section === sec.id }), role: 'tab', 'aria-selected': String(s.section === sec.id), dataset: { section: sec.id }, onclick: () => store.patch({ section: sec.id }) }, sectionLabel(sec)))),
      h('div', { class: 'setbody', dataset: { keepScroll: 'set' } }, s.prefs ? body(s, s.prefs) : h('div', { class: 'muted' }, t('app.loading'))),
    ),
    s.toast ? h('div', { class: 'toast', role: 'status' }, s.toast) : null,
  );
}

function activeNick(snap: UiAccountSnapshot): string | null {
  const a = snap.accounts.find((x) => x.context.account_id === snap.active_account_id) ?? null;
  return a ? (a.remark ?? a.nick) : null;
}

subscribeBatched(store, (s) => rerender(root, () => render(s)));
rerender(root, () => render(store.get()));

ipc.listen<unknown>(Events.PREFS_CHANGED, guarded(Events.PREFS_CHANGED, isPrefsSnapshot, (p) => store.patch({ prefs: p })));
ipc.listen<unknown>(Events.ACCOUNT_CHANGED, guarded(Events.ACCOUNT_CHANGED, isUiAccountSnapshot, (snap) => store.patch({ nick: activeNick(snap) })));
void ipc
  .invoke<unknown>(AccountCommands.SNAPSHOT)
  .then((snap) => {
    if (isUiAccountSnapshot(snap)) store.patch({ nick: activeNick(snap) });
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
void (async () => {
  try {
    const [p, net] = await Promise.all([ipc.invoke<PrefsSnapshot>(PrefsCommands.SNAPSHOT), ipc.invoke<UiNetStatus>(UiCommands.NET_STATUS, {}).catch(() => null)]);
    store.patch({ prefs: p, net });
  } catch (e) {
    toast(t('set.saveFailed', { msg: msg(e) }));
  }
})();

exposeForTests(sel, { __vbkStore: store });
