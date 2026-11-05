import { t as translate, type I18nKey } from '../../packages/ui-kit/src/i18n.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import * as vm from './viewmodel.ts';
import { SETTING_STRINGS } from './strings.ts';
import { createStore } from '../../packages/ui-kit/src/store.ts';
import { cx, h as domH, rerender } from '../../packages/ui-kit/src/h.ts';
import { installFakeDom, fakeDocument, readCounters, resetCounters } from '../../tests/fake-dom.ts';
import { createMockIpc } from '../../packages/ipc/src/mock.ts';
import { PrefsCommands, ShellCommands } from '../../packages/ipc/src/commands.ts';
import { UiCommands } from '../../packages/ipc/src/client.ts';
import { ALLOWED_T1_SECONDS } from '../../packages/ipc/src/contracts.ts';
import { isPrefsSnapshot } from '../_shared/guards.ts';
const source = readFileSync(process.env['VBK_SETTING_MAIN_SOURCE'] ?? new URL('./main.ts', import.meta.url), 'utf8');
interface Tree { tag: string; props: Record<string, any>; children: unknown[] }
function nodes(tree: unknown): Tree[] { if (Array.isArray(tree)) return tree.flatMap(nodes); if (!tree || typeof tree !== 'object') return []; const node = tree as Tree; return [node, ...nodes(node.children ?? [])]; }
function deferred() { let resolve!: (value: unknown) => void; return { promise: new Promise(r => { resolve = r; }), resolve: (v: unknown) => resolve(v) }; }
async function fixture(overrides: Record<string, any> = {}) {
  const mock = createMockIpc('default', { tick: false, latency: 0 }); const prefs = await mock.invoke(PrefsCommands.SNAPSHOT); mock.dispose();
  const store = createStore<Record<string, any>>({ prefs, section: 'assistant', tsimForm: { user: 'SYNTHETIC_USER', password: 'SYNTHETIC_PASSWORD' }, tsimBusy: false, tsimError: null, tsimStatus: null, loading: false, loadError: null, settingsRequest: 0, tsimRequest: 0, net: null, version: null, toast: null, accounts: [], qrPreferred: null, qrAccount: null, qrBusy: false });
  const calls: { command: string }[] = []; const results = new Map<string, unknown>([[PrefsCommands.SNAPSHOT, prefs], [UiCommands.ASSIST_TSIM_STATUS, { logged_in: false, user: null }], [UiCommands.ASSIST_TSIM_LOGIN, { logged_in: true, user: 'SYNTHETIC_USER' }], [UiCommands.ASSIST_TSIM_LOGOUT, { logged_in: false, user: null }]]);
  const shortcutPayloads: object[] = [];
  const managerAccounts: unknown[] = [];
  let managerBusy = false;
  // the real DOM `h` needs a real (fake-DOM) host; the tree-building `h` a tree node
  const qrHost = overrides['h'] ? (globalThis as unknown as { document: { createElement(tag: string): object } }).document.createElement('div') : { tag: 'div', props: { class: 'set-qr-host' }, children: [] };
  const invoke = async (command: string, payload?: object) => { calls.push({ command, payload } as { command: string }); if (command === UiCommands.PREFS_SET && payload && 'section' in payload && payload.section === 'keys') shortcutPayloads.push(payload); const result = await results.get(command); if (result instanceof Error || (result && typeof result === 'object' && 'code' in result)) throw result; return result; };
  const env: Record<string, any> = { getSoundProfile: () => 'soft', setSoundProfile() {}, playSound: () => 0, recoveryView: () => null, recovery: { refresh() {} }, ...vm, settingsNavigationVersion: 0, ALLOWED_T1_SECONDS, preferenceWrites: new Map(), S: SETTING_STRINGS, store, qrHost, quickReplies: { setAccount: (account: unknown) => managerAccounts.push(account), busy: () => managerBusy }, pickQrAccount() {}, ipc: { invoke }, PrefsCommands, ShellCommands, UiCommands, isPrefsSnapshot, cx, h: (tag: string, props: object | null, ...children: unknown[]) => ({ tag, props: props ?? {}, children }), t: (key: string, vars?: Record<string, string | number>) => key.startsWith('set.runtime.') ? translate(key as I18nKey, vars) : key, msg: () => 'SYNTHETIC_UNTRUSTED_ERROR', toast: (value: string) => store.patch({ toast: value }), icon: () => null, IC: {}, sel: { mock: true }, platform: 'windows', windowControls: (o: { closeLabel?: string; onClose?: () => void; closeDataset?: object }) => env['platform'] === 'windows' ? ({ tag: 'div', props: { class: 'wbtns' }, children: [{ tag: 'button', props: { 'aria-label': o.closeLabel, onclick: o.onClose, dataset: o.closeDataset ?? {} }, children: [] }] }) : null, closeWindow() {}, selectSection() {}, onBodyScroll() {}, setPref() {}, setReminder() {}, ...overrides };
  function actual(name: string): (...args: any[]) => any { const a = source.search(new RegExp('(?:async )?function ' + name + '(?:<[^>]+>)?\\(')); assert.ok(a >= 0, name); const tail = source.slice(a); const next = /\n(?:(?:async )?function |(?:let|const) [A-Za-z]|subscribeBatched\()/.exec(tail); assert.ok(next, name); return new Function(...Object.keys(env), stripTypeScriptTypes(tail.slice(0, next.index)) + '\nreturn ' + name + ';')(...Object.values(env)); }
  for (const name of ['head', 'row', 'toggle', 'segment', 'text', 'editShortcut', 'saveShortcut', 'shortcutRow', 'loadSettings', 'refreshTsimStatus', 'tsimLogin', 'tsimLogout', 'quickRepliesSection', 'generalSection', 'notifySection', 'keysSection', 'assistantSection', 'aboutSection', 'sectionContent', 'body', 'nav', 'closeWindow', 'titleBar', 'render']) if (new RegExp('function ' + name + '(?:<[^>]+>)?\\(').test(source)) env[name] = actual(name);
  function bootstrap() { if (env['loadSettings']) return env['loadSettings'](); const a = source.lastIndexOf('void (async () => {'), b = source.indexOf('\n})();', a) + '\n})();'.length; assert.ok(a >= 0 && b > a); return new Function(...Object.keys(env), 'return ' + stripTypeScriptTypes(source.slice(a, b).replace('void ', '')))(...Object.values(env)); }
  /** Evaluates a top-level slice of main.ts in one scope (its own lets and functions shadow the env), returning `exports`. */
  function evaluate(slice: string, exports: string): any {
    const declared = new Set([...slice.matchAll(/^(?:let|const|(?:async )?function) ([A-Za-z_$][\w$]*)/gm)].map(m => m[1]!));
    const keys = Object.keys(env).filter(k => !declared.has(k));
    return new Function(...keys, stripTypeScriptTypes(slice) + '\nreturn ' + exports + ';')(...keys.map(k => env[k]));
  }
  return { store, calls, shortcutPayloads, managerAccounts, qrHost, actual, bootstrap, evaluate, setManagerBusy: (busy: boolean) => { managerBusy = busy; }, setResult: (command: string, value: unknown) => results.set(command, value), tree: () => env['render'](store.get()) };
}

test('actual settings bootstrap failure exposes a retry control that loads a real preferences snapshot', async () => {
  const f = await fixture(), prefs = f.store.get().prefs; f.store.patch({ prefs: null }); f.setResult(PrefsCommands.SNAPSHOT, new Error('SYNTHETIC_PRIVATE_DIAGNOSTIC'));
  await f.bootstrap(); const retry = nodes(f.tree()).find(n => n.props.dataset?.action === 'retry-settings'); assert.ok(retry); assert.equal(JSON.stringify(f.tree()).includes('SYNTHETIC_PRIVATE_DIAGNOSTIC'), false);
  f.setResult(PrefsCommands.SNAPSHOT, prefs);
  const loaded = new Promise<void>(resolve => { const unsubscribe = f.store.subscribe(state => { if (!state.loading) { unsubscribe(); resolve(); } }); });
  retry.props.onclick(); await loaded;
  assert.equal(f.store.get().prefs, prefs); assert.equal(f.store.get().loadError, null);
});

test('actual TSim login clears the UI password before IPC settles and requires a confirmed login response', async () => {
  const f = await fixture(), pending = deferred(); f.setResult(UiCommands.ASSIST_TSIM_LOGIN, pending.promise);
  const request = f.actual('tsimLogin')(); assert.equal(f.store.get().tsimForm.password, ''); assert.equal(f.store.get().tsimBusy, true);
  pending.resolve({ logged_in: false, user: null }); await request;
  assert.equal(f.store.get().tsimStatus?.logged_in, false); assert.ok(f.store.get().tsimError); assert.equal(f.store.get().tsimBusy, false);
});

test('actual TSim status readback controls login UI even when preference metadata is stale', async () => {
  const f = await fixture(); f.store.patch({ prefs: { ...f.store.get().prefs, assistant: { ...f.store.get().prefs.assistant, tsim_logged_in: true, tsim_user: 'SYNTHETIC_STALE_USER' } } });
  await f.actual('refreshTsimStatus')(); const tree = f.tree();
  assert.ok(nodes(tree).some(n => n.props.dataset?.action === 'tsim-login')); assert.equal(nodes(tree).some(n => n.props.dataset?.action === 'tsim-logout'), false);
});

test('actual TSim late status response cannot overwrite a later login and backend errors never reappear as credentials', async () => {
  const f = await fixture(), pending = deferred(); f.setResult(UiCommands.ASSIST_TSIM_STATUS, pending.promise); const reading = f.actual('refreshTsimStatus')();
  f.store.patch({ tsimBusy: false }); await f.actual('tsimLogin')(); pending.resolve({ logged_in: false, user: null }); await reading;
  assert.equal(f.store.get().tsimStatus?.logged_in, true);
  f.store.patch({ tsimForm: { user: 'SYNTHETIC_USER', password: 'SYNTHETIC_PASSWORD' } }); f.setResult(UiCommands.ASSIST_TSIM_LOGIN, { code: 'assistant.tsim_bad_credentials', message: 'SYNTHETIC_PASSWORD SYNTHETIC_PRIVATE_DIAGNOSTIC' });
  await f.actual('tsimLogin')(); assert.equal(f.store.get().tsimForm.password, ''); assert.equal(JSON.stringify(f.tree()).includes('SYNTHETIC_PASSWORD'), false); assert.equal(JSON.stringify(f.tree()).includes('SYNTHETIC_PRIVATE_DIAGNOSTIC'), false);
});

test('actual login form inputs, submit and logout button use only the explicit TSim commands', async () => {
  const f = await fixture(); f.store.patch({ tsimForm: { user: '', password: '' } });
  const tree = f.tree(); nodes(tree).find(n => n.props.dataset?.fid === 'tsim-user')!.props.oninput({ target: { value: 'SYNTHETIC_USER' } });
  nodes(tree).find(n => n.props.dataset?.fid === 'tsim-pass')!.props.oninput({ target: { value: 'SYNTHETIC_PASSWORD' } });
  function settled() { return new Promise<void>(resolve => { const unsubscribe = f.store.subscribe(s => { if (!s.tsimBusy) { unsubscribe(); resolve(); } }); }); }
  const loggedIn = settled(); nodes(tree).find(n => n.tag === 'form' && n.props.class !== 'shortcut-form')!.props.onsubmit({ preventDefault() {} }); await loggedIn;
  assert.equal(f.store.get().tsimStatus.logged_in, true); assert.equal(f.store.get().tsimForm.password, '');
  const loggedOut = settled(); nodes(f.tree()).find(n => n.props.dataset?.action === 'tsim-logout')!.props.onclick(); await loggedOut;
  assert.equal(f.store.get().tsimStatus.logged_in, false); assert.deepEqual(f.calls.map(c => c.command), [UiCommands.ASSIST_TSIM_LOGIN, UiCommands.ASSIST_TSIM_LOGOUT]);
});

test('actual overlapping settings reads keep the newest snapshot and malformed TSim status remains unknown', async () => {
  const f = await fixture(), pending = deferred(); f.setResult(PrefsCommands.SNAPSHOT, pending.promise); const old = f.bootstrap();
  const current = { ...f.store.get().prefs, display: { ...f.store.get().prefs.display, zoom: 125 } }; f.setResult(PrefsCommands.SNAPSHOT, current); await f.bootstrap();
  pending.resolve(null); await old; assert.equal(f.store.get().prefs, current); assert.equal(f.store.get().loadError, null);
  const late = deferred(); f.setResult(PrefsCommands.SNAPSHOT, late.promise); const loading = f.bootstrap();
  const broadcast = { ...current, display: { ...current.display, zoom: 150 } }; f.actual('applySettingsSnapshot')(broadcast); late.resolve(current); await loading;
  assert.equal(f.store.get().prefs, broadcast); assert.equal(f.store.get().loading, false);
  for (const status of [null, { logged_in: true, user: null }, { logged_in: 'true', user: 'synthetic' }]) {
    f.setResult(UiCommands.ASSIST_TSIM_STATUS, status); await f.actual('refreshTsimStatus')(); assert.equal(f.store.get().tsimStatus, null); assert.ok(f.store.get().tsimError); assert.equal(f.store.get().tsimBusy, false);
  }
});

test('TSim errors use distinct safe categories and never copy unknown codes or private messages', () => {
  const cases = [['assistant.tsim_bad_credentials', '用户名或密码'], ['assistant.forbidden', '权限'], ['net.timeout', '超时'], ['net.offline', '网络'], ['assistant.service_unavailable', '服务暂不可用'], ['store.io', '凭据存储']];
  for (const [code, label] of cases) { const result = vm.tsimErrorText({ code, message: 'SYNTHETIC_PRIVATE_PASSWORD' }); assert.ok(result.includes(label!)); assert.equal(result.includes('PRIVATE_PASSWORD'), false); }
  for (const code of ['SYNTHETIC_PRIVATE_CODE', 'toString']) { const result = vm.tsimErrorText({ code, message: 'SYNTHETIC_PRIVATE_PASSWORD' }); assert.equal(result.includes(code), false); assert.equal(result.includes('网络'), false); assert.ok(result.includes('状态尚待核对')); }
});

test('autofilled login fields submit without input events and clear before IPC settles', async () => {
  let reset = false;
  const f = await fixture({ FormData: class {
    constructor(form: unknown) { assert.equal(form, domForm); }
    get(name: string) { return name === 'username' ? ' AUTOFILLED_USER ' : 'AUTOFILLED_PASSWORD'; }
  } });
  const domForm = { reset() { reset = true; } };
  f.store.patch({ tsimForm: { user: '', password: '' } });
  const tree = f.tree();
  assert.equal(nodes(tree).find(n => n.props.dataset?.action === 'tsim-login')!.props.disabled, false);
  for (const name of ['username', 'password']) {
    assert.ok(nodes(tree).some(n => n.tag === 'input' && n.props.name === name && n.props.required));
  }
  const pending = deferred(); f.setResult(UiCommands.ASSIST_TSIM_LOGIN, pending.promise);
  const request = f.actual('tsimLogin')(domForm);
  assert.equal(reset, true);
  assert.equal(f.calls[0]?.command, UiCommands.ASSIST_TSIM_LOGIN);
  assert.equal(f.store.get().tsimForm.user, ' AUTOFILLED_USER ');
  assert.equal(f.store.get().tsimForm.password, '');
  pending.resolve({ logged_in: true, user: 'AUTOFILLED_USER', session_epoch: 1 }); await request;
  assert.equal(f.store.get().tsimStatus.user, 'AUTOFILLED_USER');
});

test('failed replacement login does not retain the previous logged-in UI identity', async () => {
  const f = await fixture();
  f.store.patch({ tsimStatus: { logged_in: true, user: 'OLD_USER', session_epoch: 1 } });
  f.setResult(UiCommands.ASSIST_TSIM_LOGIN, { code: 'assistant.tsim_bad_credentials' });
  await f.actual('tsimLogin')();
  assert.equal(f.store.get().tsimStatus, null);
  assert.ok(nodes(f.tree()).some(n => n.props.dataset?.action === 'tsim-login'));
});


test('TSim offers only username/password login; no browser or token import entry remains', async () => {
  const f = await fixture();
  const tree = nodes(f.tree());
  assert.ok(tree.some(n => n.props.dataset?.action === 'tsim-login'));
  for (const action of ['tsim-browser-connect', 'tsim-import', 'tsim-import-form']) assert.equal(tree.some(n => n.props.dataset?.action === action), false, action);
  assert.equal(tree.some(n => n.props.dataset?.tsimImport || n.props.dataset?.browserProfile), false);
});

test('session invalidation event removes stale logged-in identity without cancelling an active login', async () => {
  const f = await fixture();
  f.store.patch({ tsimStatus: { logged_in: true, user: 'synthetic', session_epoch: 4 }, tsimBusy: true, tsimRequest: 8 });
  f.actual('receiveTsimStatus')({ logged_in: false, user: null, session_epoch: 5 });
  assert.equal(f.store.get().tsimStatus.logged_in, false);
  assert.equal(f.store.get().tsimBusy, true);
  assert.equal(f.store.get().tsimRequest, 8);
  f.actual('receiveTsimStatus')({ logged_in: true, user: 'old', session_epoch: 4 });
  assert.equal(f.store.get().tsimStatus.logged_in, false);
});


test('failed setting saves preserve successful changes in the same section', async () => {
  const f = await fixture(), pending = deferred();
  const before = f.store.get().prefs;
  f.setResult(UiCommands.PREFS_SET, pending.promise);
  const first = f.actual('setPref')('general', 'autostart', !before.general.autostart);
  const latest = { ...before, general: { ...before.general, autostart: before.general.autostart, show_msg_time: !before.general.show_msg_time } };
  f.setResult(UiCommands.PREFS_SET, latest);
  await f.actual('setPref')('general', 'show_msg_time', !before.general.show_msg_time);
  assert.equal(f.store.get().prefs.general.autostart, !before.general.autostart);
  pending.resolve(new Error('failed')); await first;
  assert.equal(f.store.get().prefs.general.autostart, before.general.autostart);
  assert.equal(f.store.get().prefs.general.show_msg_time, !before.general.show_msg_time);
});

test('late settings replies cannot overwrite a newer write of the same field', async () => {
  for (const fail of [false, true]) {
    const f = await fixture(), pending = deferred(), before = f.store.get().prefs;
    f.setResult(UiCommands.PREFS_SET, pending.promise);
    const first = f.actual('setPref')('display', 'zoom', 125);
    const next = { ...before, display: { ...before.display, zoom: 150 } };
    f.setResult(UiCommands.PREFS_SET, next); await f.actual('setPref')('display', 'zoom', 150);
    pending.resolve(fail ? new Error('old failure') : { ...before, display: { ...before.display, zoom: 125 } }); await first;
    assert.equal(f.store.get().prefs.display.zoom, 150);
  }
});

test('failed reminder changes roll back only their field', async () => {
  const f = await fixture(), pending = deferred(), before = f.store.get().prefs;
  const { cmd } = vm.reminderCommand('enabled', !before.reminder.enabled);
  f.setResult(cmd, pending.promise);
  const first = f.actual('setReminder')('enabled', !before.reminder.enabled);
  const sound = vm.reminderCommand('timeout_sound', !before.reminder.timeout_sound);
  f.setResult(sound.cmd, undefined); await f.actual('setReminder')('timeout_sound', !before.reminder.timeout_sound);
  pending.resolve(new Error('failed')); await first;
  assert.equal(f.store.get().prefs.reminder.enabled, before.reminder.enabled);
  assert.equal(f.store.get().prefs.reminder.timeout_sound, !before.reminder.timeout_sound);
});


test('an authoritative preferences event outranks an earlier save reply or failure', async () => {
  for (const fail of [false, true]) {
    const f = await fixture(), pending = deferred(), before = f.store.get().prefs;
    f.setResult(UiCommands.PREFS_SET, pending.promise);
    const first = f.actual('setPref')('display', 'zoom', 125);
    const broadcast = { ...before, display: { ...before.display, zoom: 150 } };
    f.actual('applySettingsSnapshot')(broadcast);
    pending.resolve(fail ? new Error('old failure') : { ...before, display: { ...before.display, zoom: 125 } }); await first;
    assert.equal(f.store.get().prefs, broadcast);
  }
});

test('same-field failures restore confirmed preferences for either response order', async () => {
  for (const reminder of [false, true]) for (const oldFirst of [false, true]) for (const oldSucceeds of [false, true]) {
    const f = await fixture(), first = deferred(), second = deferred(), before = f.store.get().prefs;
    const key = reminder ? 't1_seconds' : 'zoom';
    const command = reminder ? vm.reminderCommand('t1_seconds', 60).cmd : UiCommands.PREFS_SET;
    const save = (value: number) => reminder ? f.actual('setReminder')(key, value) : f.actual('setPref')('display', key, value);
    f.setResult(command, first.promise); const old = save(reminder ? 60 : 125);
    f.setResult(command, second.promise); const latest = save(reminder ? 90 : 150);
    const confirmed = reminder ? undefined : { ...before, display: { ...before.display, zoom: 125 } };
    const settleOld = async () => { first.resolve(oldSucceeds ? confirmed : new Error('old failed')); await old; };
    const settleLatest = async () => { second.resolve(new Error('latest failed')); await latest; };
    if (oldFirst) { await settleOld(); await settleLatest(); } else { await settleLatest(); await settleOld(); }
    assert.equal(reminder ? f.store.get().prefs.reminder.t1_seconds : f.store.get().prefs.display.zoom,
      oldSucceeds ? reminder ? 60 : 125 : reminder ? before.reminder.t1_seconds : before.display.zoom,
      JSON.stringify({ reminder, oldFirst, oldSucceeds }));
  }
});


test('a change the host already announced still reports saved', async () => {
  const f = await fixture(), pending = deferred(), before = f.store.get().prefs;
  const next = { ...before, general: { ...before.general, show_msg_time: !before.general.show_msg_time } };
  f.setResult(UiCommands.PREFS_SET, pending.promise);
  const saving = f.actual('setPref')('general', 'show_msg_time', next.general.show_msg_time);
  f.actual('applySettingsSnapshot')(next);
  pending.resolve(next); await saving;
  assert.equal(f.store.get().prefs.general.show_msg_time, next.general.show_msg_time);
  assert.equal(f.store.get().toast, 'set.saved');
});

test('removed preferences render nothing; the remaining ones are real controls', async () => {
  const f = await fixture();
  const controls = nodes(f.tree()).map(n => n.props.dataset?.setting).filter(Boolean);
  for (const key of ['display.gpu', 'general.start_hidden', 'general.spell_check', 'storage.cache_days', 'storage.cache_mb', 'privacy.analytics', 'privacy.crash_upload']) assert.ok(!controls.includes(key), key);
  for (const key of ['general.show_msg_time', 'display.zoom', 'dnd.schedule_enabled', 'dnd.follow_system', 'network.system_proxy', 'keys.toggle_main']) assert.ok(controls.includes(key), key);
  assert.equal(nodes(f.tree()).find(n => n.props.dataset?.action === 'clear-cache'), undefined);
  // the old fact rows (GPU, cache, analytics, crash upload) left no copy behind
  const dump = JSON.stringify(f.tree());
  for (const gone of ['set.display.gpu', 'set.display.managed', 'set.storage.', 'set.privacy.', 'set.general.startHidden', 'set.general.spell']) assert.equal(dump.includes(gone), false, gone);
});

test('settings diagnostics and data-directory buttons use dedicated host commands', async () => {
  const f = await fixture();
  const about = nodes(f.tree());
  const open = about.find(n => n.tag === 'button' && n.props.dataset?.action === 'open-data-dir');
  assert.ok(open); assert.deepEqual(open.children, [SETTING_STRINGS.open]); open.props.onclick(); await Promise.resolve();
  assert.equal(f.calls.at(-1)?.command, ShellCommands.OPEN_DATA_DIRECTORY);
  f.setResult(ShellCommands.EXPORT_DIAGNOSTICS, false);
  const exp = nodes(f.tree()).find(n => n.tag === 'button' && n.props.dataset?.action === 'export-diagnostics');
  assert.ok(exp); assert.deepEqual(exp.children, ['set.about.export']);
  exp.props.onclick(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(f.calls.at(-1)?.command, ShellCommands.EXPORT_DIAGNOSTICS); assert.equal(f.store.get().toast, null);
  f.setResult(ShellCommands.EXPORT_DIAGNOSTICS, true); exp.props.onclick();
  for (let i = 0; i < 6; i++) await Promise.resolve();
  assert.equal(f.store.get().toast, '诊断信息已导出');
});

test('actual settings page renders every section in one long page; nav is a labelled nav with aria-current and calls selectSection', async () => {
  const picked: string[] = [];
  const f = await fixture({ selectSection: (id: string) => picked.push(id) }); f.store.patch({ section: 'keys' });
  const all = nodes(f.tree());
  assert.deepEqual(all.filter(n => n.tag === 'section').map(n => n.props.dataset?.setSection), vm.SECTIONS.map(s => s.id));
  assert.ok(all.filter(n => n.tag === 'section').every(n => (n.children[0] as Tree).tag === 'h2'));
  const nav = all.find(n => n.tag === 'nav'); assert.ok(nav); assert.equal(all.some(n => n.props.role === 'tablist' || n.props.role === 'tab'), false);
  assert.equal(nav.props['aria-label'], 'set.title');
  const buttons = nodes(nav.children).filter(n => n.tag === 'button');
  assert.deepEqual(buttons.map(b => b.props.dataset.section), vm.SECTIONS.map(s => s.id));
  assert.deepEqual(buttons.filter(b => b.props['aria-current'] === 'true').map(b => b.props.dataset.section), ['keys']);
  // two groups, each heading followed by exactly its own sections: 账号业务 → 快捷回复, 桌面偏好 → the rest
  const items = nodes(nav.children).filter(n => n.props.class === 'setnav-g' || n.tag === 'button').map(n => n.tag === 'button' ? n.props.dataset.section : `group:${n.props.dataset.group}`);
  assert.deepEqual(items, ['group:account', 'quick_replies', 'group:desktop', 'general', 'notify', 'keys', 'assistant', 'about']);
  assert.deepEqual(nodes(nav.children).filter(n => n.props.class === 'setnav-g').map(n => n.children[0]), vm.SECTION_GROUPS.map(g => vm.sectionLabel(g)));
  buttons.find(b => b.props.dataset.section === 'about')!.props.onclick(); assert.deepEqual(picked, ['about']);
  assert.ok(all.find(n => n.props.dataset?.keepScroll === 'set')?.props.onscroll);
  // 已移除的内容：发送模式、只读翻译服务行
  const dump = JSON.stringify(f.tree());
  for (const gone of ['set.asst.sendMode', 'set.asst.outService', 'set.asst.inService']) assert.equal(dump.includes(gone), false, gone);
  assert.equal(all.some(n => n.props.dataset?.sendMode), false);
});

test('quick replies section opens web personal settings under the chosen account', async () => {
  const f = await fixture();
  const button = () => nodes(f.tree()).find(n => n.props.dataset?.action === 'personal-settings')!;
  assert.equal(button().props.disabled, true);
  const account = { account_id: 'synthetic-a', environment: 'synthetic', session_generation: 1 };
  f.store.patch({ qrAccount: account });
  assert.equal(button().props.disabled, false);
  button().props.onclick();
  assert.deepEqual(f.calls.at(-1), { command: UiCommands.SHELL_OPEN_WEBVIEW, payload: { account, url: vm.PERSONAL_SETTINGS_URL } });
  // the entry sits at the end of 快捷回复, after the manager host
  const section = nodes(f.tree()).find(n => n.tag === 'section' && n.props.dataset?.setSection === 'quick_replies')!;
  assert.equal(section.children.indexOf(f.qrHost), 2);
  assert.ok(nodes(section.children.at(-1)).some(n => n.props.dataset?.action === 'personal-settings'));
});

function synthAccount(id: string, state: string, generation = 1, remark: string | null = null) {
  return { context: { account_id: id, environment: 'synthetic', session_generation: generation }, nick: `nick-${id}`, remark, party: 'p', color: '#000', state, unread: 0 };
}

test('quick replies: the picker lists logged-in accounts only and the manager follows the preferred account through picks, logouts and generations', async () => {
  const picked: string[] = [];
  const f = await fixture({ pickQrAccount: (key: string) => picked.push(key) });
  const select = () => nodes(f.tree()).find(n => n.tag === 'select' && n.props.dataset?.action === 'qr-account')!;
  const options = () => nodes(select().children).filter(n => n.tag === 'option').map(o => [o.props.value, !!o.props.selected, !!o.props.disabled, o.children[0]]);
  const offlineHint = () => nodes(f.tree()).find(n => n.props.dataset?.qrOffline === '1');
  const webEntry = () => nodes(f.tree()).find(n => n.props.dataset?.action === 'personal-settings')!;
  const snap = (accounts: unknown[]) => ({ accounts, active_account_id: null, max_accounts: 5 });
  // nobody logged in and nothing chosen yet: disabled picker with the empty hint, no offline notice, no web entry
  assert.equal(select().props.disabled, true);
  assert.deepEqual(options(), [['', false, false, 'set.qr.noAccount']]);
  assert.equal(offlineHint(), undefined);
  const applyAccounts = f.actual('applyAccounts');
  const a = synthAccount('a', 'online'), b = synthAccount('b', 'online', 1, 'remark-b'), c = synthAccount('c', 'expired');
  applyAccounts({ accounts: [c, a, b], active_account_id: 'b', max_accounts: 5 });
  assert.deepEqual(f.store.get().accounts.map((x: { context: { account_id: string } }) => x.context.account_id), ['a', 'b']);
  assert.deepEqual(f.store.get().qrAccount, a.context, 'first logged-in account by default, not the active one');
  assert.equal(f.store.get().qrPreferred, 'synthetic:a', 'the default becomes the preference');
  assert.deepEqual(f.managerAccounts.at(-1), a.context);
  assert.deepEqual(options(), [['synthetic:a', true, false, 'nick-a'], ['synthetic:b', false, false, 'remark-b']]);
  select().props.onchange({ target: { value: 'synthetic:b' } });
  assert.deepEqual(picked, ['synthetic:b']);
  // the real pick handler: the pick becomes the preference and binds the manager; unknown keys are ignored
  const pick = f.actual('pickQrAccount');
  pick('synthetic:b'); assert.deepEqual(f.store.get().qrAccount, b.context); assert.equal(f.store.get().qrPreferred, 'synthetic:b'); assert.deepEqual(f.managerAccounts.at(-1), b.context);
  const calls = f.managerAccounts.length; pick('synthetic:zzz'); assert.equal(f.managerAccounts.length, calls); assert.deepEqual(f.store.get().qrAccount, b.context); assert.equal(f.store.get().qrPreferred, 'synthetic:b');
  // b gets a new generation: kept, with the new context
  const b2 = synthAccount('b', 'online', 2, 'remark-b');
  applyAccounts(snap([a, b2]));
  assert.deepEqual(f.store.get().qrAccount, b2.context); assert.deepEqual(f.managerAccounts.at(-1), b2.context);
  // b logs out: no silent switch to a; the manager is unbound and the picker says the chosen account is offline
  applyAccounts(snap([a, { ...b2, state: 'expired' }]));
  assert.equal(f.store.get().qrAccount, null); assert.equal(f.store.get().qrPreferred, 'synthetic:b'); assert.equal(f.managerAccounts.at(-1), null);
  assert.deepEqual(options(), [['', true, true, 'set.qr.preferredOffline'], ['synthetic:a', false, false, 'nick-a']]);
  assert.equal(select().props.disabled, false, 'another logged-in account can still be picked');
  assert.deepEqual(offlineHint()?.children, ['set.qr.preferredOfflineHint']); assert.equal(offlineHint()?.props.role, 'status');
  assert.equal(webEntry().props.disabled, true);
  // b logs back in with a new generation: restored automatically, the notice goes away
  const b3 = synthAccount('b', 'online', 3, 'remark-b');
  applyAccounts(snap([a, b3]));
  assert.deepEqual(f.store.get().qrAccount, b3.context); assert.deepEqual(f.managerAccounts.at(-1), b3.context);
  assert.deepEqual(options(), [['synthetic:a', false, false, 'nick-a'], ['synthetic:b', true, false, 'remark-b']]);
  assert.equal(offlineHint(), undefined); assert.equal(webEntry().props.disabled, false);
  // everyone logs out: only the offline placeholder, picker disabled, nothing bound
  applyAccounts(snap([{ ...a, state: 'suspended' }, { ...b3, state: 'expired' }]));
  assert.equal(f.store.get().qrAccount, null); assert.equal(f.managerAccounts.at(-1), null);
  assert.deepEqual(options(), [['', true, true, 'set.qr.preferredOffline']]); assert.equal(select().props.disabled, true);
  assert.ok(offlineHint()); assert.equal(webEntry().props.disabled, true);
  // while b is offline the user picks a instead: a becomes the preference and b coming back does not pull the manager away
  applyAccounts(snap([a, { ...b3, state: 'expired' }]));
  pick('synthetic:a'); assert.equal(f.store.get().qrPreferred, 'synthetic:a'); assert.deepEqual(f.managerAccounts.at(-1), a.context);
  applyAccounts(snap([a, synthAccount('b', 'online', 4, 'remark-b')]));
  assert.deepEqual(f.store.get().qrAccount, a.context); assert.deepEqual(f.managerAccounts.at(-1), a.context);
});

test('quick replies: while a write is in flight the picker is locked and picks are ignored, but logout and new generations still rebind', async () => {
  const f = await fixture();
  const select = () => nodes(f.tree()).find(n => n.tag === 'select' && n.props.dataset?.action === 'qr-account')!;
  const applyAccounts = f.actual('applyAccounts'), pick = f.actual('pickQrAccount');
  const a = synthAccount('a', 'online'), b = synthAccount('b', 'online');
  const snap = (accounts: unknown[]) => ({ accounts, active_account_id: null, max_accounts: 5 });
  applyAccounts(snap([a, b]));
  assert.equal(select().props.disabled, false);
  // the manager reports busy through onBusyChange: the select is disabled
  f.store.patch({ qrBusy: true });
  assert.equal(select().props.disabled, true);
  let repaints = 0; const unsubscribe = f.store.subscribe(() => { repaints++; });
  const bound = f.managerAccounts.length;
  pick('synthetic:b');
  assert.deepEqual(f.store.get().qrAccount, a.context); assert.equal(f.store.get().qrPreferred, 'synthetic:a'); assert.equal(f.managerAccounts.length, bound);
  assert.equal(repaints, 1, 'an ignored pick repaints so the select shows the bound account again');
  // busy() is checked too, for a pick that lands before the busy flag was painted
  f.store.patch({ qrBusy: false }); f.setManagerBusy(true);
  pick('synthetic:b'); assert.deepEqual(f.store.get().qrAccount, a.context); assert.equal(f.managerAccounts.length, bound);
  unsubscribe();
  // the forced rebinding still happens while busy: a new generation, then a logout
  f.store.patch({ qrBusy: true });
  const a2 = synthAccount('a', 'online', 2);
  applyAccounts(snap([a2, b])); assert.deepEqual(f.managerAccounts.at(-1), a2.context);
  applyAccounts(snap([{ ...a2, state: 'expired' }, b])); assert.equal(f.managerAccounts.at(-1), null); assert.equal(f.store.get().qrAccount, null);
  // settled: picks work again and become the preference
  f.store.patch({ qrBusy: false }); f.setManagerBusy(false);
  pick('synthetic:b'); assert.deepEqual(f.store.get().qrAccount, b.context); assert.equal(f.store.get().qrPreferred, 'synthetic:b');
  // the manager's busy callback is wired to the store
  assert.match(source, /mountQuickReplyManager\(qrHost, \{[^}]*onBusyChange: \(busy\) => store\.patch\(\{ qrBusy: busy \}\)/);
});

test('quick replies: account events wait for the listener to be registered, and an event after that outranks the snapshot reply', async () => {
  const listenerReady = deferred(), reply = deferred();
  const listened: string[] = [], bus: { emit?: (payload: unknown) => void } = {};
  const applied: unknown[] = [];
  const invoked: string[] = [];
  const settle = () => new Promise<void>(resolve => setImmediate(resolve));
  const ipc = {
    listenReady: (event: string, cb: (payload: unknown) => void) => { listened.push(event); bus.emit = cb; return listenerReady.promise.then(() => () => undefined); },
    listen: () => assert.fail('listenReady is available, so the plain listen is not used'),
    invoke: (command: string) => { invoked.push(command); return reply.promise; },
  };
  const f = await fixture({ ipc, applyAccounts: (snap: unknown) => applied.push(snap), guarded: (_event: string, guard: (v: unknown) => boolean, fn: (v: unknown) => void) => (v: unknown) => { if (guard(v)) fn(v); }, isUiAccountSnapshot: (v: unknown) => !!v && typeof v === 'object' && 'accounts' in v, Events: { ACCOUNT_CHANGED: 'account://changed' }, AccountCommands: { SNAPSHOT: 'account_snapshot' } });
  const loading = f.actual('loadAccounts')();
  await settle();
  assert.deepEqual(listened, ['account://changed']);
  assert.deepEqual(invoked, [], 'no snapshot read before the listener is registered');
  listenerReady.resolve(undefined); await settle();
  assert.deepEqual(invoked, ['account_snapshot']);
  const live = { accounts: ['live'] }; bus.emit!(live);
  reply.resolve({ accounts: ['stale'] }); await loading;
  assert.deepEqual(applied, [live], 'the older snapshot reply is dropped');
  // without an event in between, the snapshot is applied
  const again = deferred(); const ipc2 = { listenReady: () => Promise.resolve(() => undefined), invoke: () => again.promise };
  const applied2: unknown[] = [];
  const f2 = await fixture({ ipc: ipc2, applyAccounts: (snap: unknown) => applied2.push(snap), isUiAccountSnapshot: (v: unknown) => !!v && typeof v === 'object' && 'accounts' in v, guarded: () => () => undefined, Events: { ACCOUNT_CHANGED: 'account://changed' }, AccountCommands: { SNAPSHOT: 'account_snapshot' } });
  const loading2 = f2.actual('loadAccounts')(); const snapshot = { accounts: [] }; again.resolve(snapshot); await loading2;
  assert.deepEqual(applied2, [snapshot]);
});

test('settings morph keeps the quick-reply manager host and its content in place across repaints', async () => {
  const { root } = installFakeDom(), f = await fixture({ h: domH });
  const host = f.qrHost as unknown as ReturnType<typeof fakeDocument.createElement>;
  host.setAttribute('data-qr-host', '1');
  const inner = fakeDocument.createElement('div'); inner.setAttribute('data-qr', 'root'); host.appendChild(inner);
  const draw = () => rerender(root as unknown as Element, () => f.tree() as unknown as Node, { morph: true });
  draw();
  assert.equal(root.querySelector('[data-qr-host="1"]'), host); assert.equal(host.isConnected, true);
  // the account list changing swaps <option>s around the host but never the host itself
  f.store.patch({ accounts: [synthAccount('a', 'online')], qrAccount: synthAccount('a', 'online').context }); draw();
  assert.equal(root.querySelector('[data-qr-host="1"]'), host); assert.equal(root.querySelector('[data-qr="root"]'), inner);
  // scroll-spy moving the highlight repaints the nav (its buttons re-pair by class), never the host
  f.store.patch({ section: 'about' }); draw();
  assert.equal(root.querySelector('[data-qr-host="1"]'), host); assert.equal(root.querySelector('[data-qr="root"]'), inner);
  resetCounters();
  f.store.patch({ toast: 'x' }); draw();
  assert.equal(root.querySelector('[data-qr-host="1"]'), host); assert.equal(root.querySelector('[data-qr="root"]'), inner);
  assert.equal(host.isConnected, true); assert.equal(readCounters().detached, 0);
});

test('quick replies render without the preferences snapshot; the desktop sections wait behind loading or the retry notice', async () => {
  const f = await fixture(), prefs = f.store.get().prefs;
  f.store.patch({ prefs: null, loading: true });
  const sections = () => nodes(f.tree()).filter(n => n.tag === 'section').map(n => n.props.dataset.setSection);
  const qr = () => nodes(f.tree()).find(n => n.tag === 'section' && n.props.dataset.setSection === 'quick_replies')!;
  const retry = () => nodes(f.tree()).find(n => n.props.dataset?.action === 'retry-settings');
  const loadingStatus = () => nodes(f.tree()).find(n => n.props.role === 'status' && n.children[0] === 'app.loading');
  assert.deepEqual(sections(), ['quick_replies']);
  assert.ok(qr().children.includes(f.qrHost)); assert.ok(nodes(qr().children).some(n => n.props.dataset?.action === 'qr-account'));
  assert.ok(loadingStatus()); assert.equal(retry(), undefined);
  // loading failed: quick replies stay usable, the retry notice stands in for the rest
  f.store.patch({ loading: false, loadError: 'failed' });
  assert.deepEqual(sections(), ['quick_replies']); assert.ok(qr().children.includes(f.qrHost));
  assert.ok(retry()); assert.equal(loadingStatus(), undefined);
  // the nav still lists every section
  assert.deepEqual(nodes(f.tree()).filter(n => n.tag === 'button' && n.props.dataset?.section).map(n => n.props.dataset.section), vm.SECTIONS.map(s => s.id));
  f.store.patch({ prefs, loadError: null });
  assert.deepEqual(sections(), vm.SECTIONS.map(s => s.id)); assert.equal(retry(), undefined); assert.equal(loadingStatus(), undefined);
});

test('settings morph keeps the quick-reply manager host and the scroller in place while the preferences snapshot fails and then arrives', async () => {
  const { root } = installFakeDom(), f = await fixture({ h: domH }), prefs = f.store.get().prefs;
  const host = f.qrHost as unknown as ReturnType<typeof fakeDocument.createElement>;
  host.setAttribute('data-qr-host', '1');
  const inner = fakeDocument.createElement('div'); inner.setAttribute('data-qr', 'root'); host.appendChild(inner);
  const draw = () => rerender(root as unknown as Element, () => f.tree() as unknown as Node, { morph: true });
  f.store.patch({ prefs: null, loading: true }); draw();
  assert.equal(root.querySelector('[data-qr-host="1"]'), host); assert.equal(root.querySelectorAll('[data-set-section]').length, 1);
  // a detached (or moved) element loses its scroll position: the fake DOM counts that as a scroll reset
  const scroller = root.querySelector('[data-keep-scroll="set"]')!; scroller.scrollTop = 120; host.scrollTop = 40; resetCounters();
  f.store.patch({ loading: false, loadError: 'failed' }); draw();
  assert.equal(root.querySelector('[data-qr="root"]'), inner); assert.ok(root.querySelector('[data-action="retry-settings"]'));
  f.store.patch({ prefs, loadError: null }); draw();
  assert.equal(root.querySelectorAll('[data-set-section]').length, vm.SECTIONS.length); assert.equal(root.querySelector('[data-action="retry-settings"]'), null);
  assert.equal(root.querySelector('[data-qr-host="1"]'), host); assert.equal(root.querySelector('[data-qr="root"]'), inner); assert.equal(host.isConnected, true);
  assert.equal(root.querySelector('[data-keep-scroll="set"]'), scroller);
  assert.equal(readCounters().scrollResets, 0); assert.equal(host.scrollTop, 40); assert.equal(scroller.scrollTop, 120);
});

/** The long-page navigation block of main.ts (state, scroll, deep link, render, paint), evaluated in one scope. */
function navSlice(): string {
  const a = source.indexOf('\nlet spyLock'), b = source.indexOf('\nsubscribeBatched(store, paint)', a);
  assert.ok(a >= 0 && b > a, 'navigation block'); return source.slice(a, b);
}

/** Just enough DOM for the navigation code: the last rendered tree, section tops 100px apart, recorded scrolls and focus. */
function navDom() {
  let tree: unknown = null;
  const scrolls: { top: number; behavior: string }[] = [], reveals: unknown[] = [], focuses: unknown[] = [];
  const has = (pick: (n: Tree) => boolean) => nodes(tree).some(pick);
  const scroller = {
    scrollTop: 0,
    getBoundingClientRect: () => ({ top: 0 }),
    querySelectorAll: () => nodes(tree).filter(n => n.tag === 'section').map((n, i) => ({ dataset: { setSection: n.props.dataset.setSection }, getBoundingClientRect: () => ({ top: 100 * i }) })),
    scrollTo: (o: { top: number; behavior: string }) => { scrolls.push(o); },
  };
  const root = {
    querySelector: (q: string) => q === '.setbody' ? (has(n => n.props.class === 'setbody') ? scroller : null)
      : q === '[data-tsim="1"]' ? (has(n => n.props.dataset?.tsim === '1') ? { scrollIntoView: (o: unknown) => { reveals.push(o); } } : null)
      : q === '[data-fid="tsim-user"]' ? (has(n => n.props.dataset?.fid === 'tsim-user') ? { focus: (o: unknown) => { focuses.push(o); } } : null)
      : null,
  };
  return { env: { root, rerender: (_root: unknown, build: () => unknown) => { tree = build(); }, params: null }, scrolls, reveals, focuses };
}

test('a deep link taken before the preferences snapshot arrives scrolls to its section and reveals TSim once that renders', async () => {
  const dom = navDom(), f = await fixture(dom.env), prefs = f.store.get().prefs, snapshot = deferred();
  f.store.patch({ prefs: null, section: 'quick_replies', tsimForm: { user: '', password: '' } });
  f.setResult(PrefsCommands.SNAPSHOT, snapshot.promise); f.setResult(UiCommands.DEEP_LINK_SETTING_TAKE, 'assistant');
  const page = f.evaluate(navSlice(), '{ paint, selectSection, takeDeepLinkSection }');
  // the window opens from closed: the host hands out the section before loadSettings has its reply
  page.paint(f.store.get());
  const loading = f.bootstrap();
  await page.takeDeepLinkSection(); page.paint(f.store.get());
  assert.equal(f.store.get().section, 'assistant', 'the nav highlights the deep-linked section at once');
  assert.deepEqual(dom.scrolls, []); assert.deepEqual(dom.reveals, []); assert.deepEqual(dom.focuses, []);
  snapshot.resolve(prefs); await loading; page.paint(f.store.get());
  assert.deepEqual(dom.scrolls, [{ top: 400, behavior: 'auto' }]);
  assert.equal(dom.reveals.length, 1); assert.deepEqual(dom.focuses, [{ preventScroll: true }]);
  page.paint(f.store.get()); page.paint(f.store.get());
  assert.equal(dom.scrolls.length, 1, 'only once'); assert.equal(dom.reveals.length, 1); assert.equal(dom.focuses.length, 1);
});

test('a nav click before the preferences snapshot replaces a pending deep link and drops its TSim reveal', async () => {
  const dom = navDom(), f = await fixture(dom.env), prefs = f.store.get().prefs, snapshot = deferred();
  f.store.patch({ prefs: null, section: 'quick_replies', tsimForm: { user: '', password: '' } });
  f.setResult(PrefsCommands.SNAPSHOT, snapshot.promise); f.setResult(UiCommands.DEEP_LINK_SETTING_TAKE, 'assistant');
  const page = f.evaluate(navSlice(), '{ paint, selectSection, takeDeepLinkSection }');
  page.paint(f.store.get()); const loading = f.bootstrap();
  await page.takeDeepLinkSection(); page.paint(f.store.get());
  page.selectSection('general'); page.paint(f.store.get());
  assert.equal(f.store.get().section, 'general'); assert.deepEqual(dom.scrolls, []);
  snapshot.resolve(prefs); await loading; page.paint(f.store.get());
  assert.deepEqual(dom.scrolls, [{ top: 100, behavior: 'auto' }]); assert.deepEqual(dom.reveals, []); assert.deepEqual(dom.focuses, []);
  // quick replies render without the snapshot, so a click on them scrolls at once
  const early = navDom(), g = await fixture(early.env); g.store.patch({ prefs: null });
  const page2 = g.evaluate(navSlice(), '{ paint, selectSection }'); page2.paint(g.store.get());
  assert.equal(page2.selectSection('quick_replies'), true); assert.deepEqual(early.scrolls, [{ top: 0, behavior: 'smooth' }]);
  g.store.patch({ prefs }); page2.paint(g.store.get()); assert.equal(early.scrolls.length, 1);
});

test('a deep link taken after the preferences snapshot scrolls and reveals TSim at once', async () => {
  const dom = navDom(), f = await fixture(dom.env);
  f.store.patch({ section: 'quick_replies', tsimForm: { user: '', password: '' } }); f.setResult(UiCommands.DEEP_LINK_SETTING_TAKE, 'assistant');
  const page = f.evaluate(navSlice(), '{ paint, takeDeepLinkSection }');
  page.paint(f.store.get()); await page.takeDeepLinkSection();
  assert.deepEqual(dom.scrolls, [{ top: 400, behavior: 'smooth' }]); assert.equal(dom.reveals.length, 1); assert.equal(dom.focuses.length, 1);
  page.paint(f.store.get()); assert.equal(dom.scrolls.length, 1); assert.equal(dom.reveals.length, 1);
});

test('every preference control in the settings body carries data-setting; only the account picker, the TSim login fields and the manager host are exempt', async () => {
  const f = await fixture();
  // the manager owns its host's fields; a planted one proves the walk skips the host rather than missing it
  (f.qrHost as Tree).children.push({ tag: 'input', props: { class: 'inp' }, children: [] });
  const EXEMPT: Record<string, (n: Tree) => boolean> = {
    'qr-account picker': n => n.tag === 'select' && n.props.dataset?.action === 'qr-account',
    'TSim user': n => n.tag === 'input' && n.props.dataset?.fid === 'tsim-user',
    'TSim password': n => n.tag === 'input' && n.props.dataset?.fid === 'tsim-pass',
  };
  const seen = new Set<string>(), missing: string[] = [];
  let skippedHost = false, controls = 0;
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== 'object') return;
    const n = node as Tree;
    if (String(n.props.class ?? '').split(/\s+/).includes('set-qr-host')) { skippedHost = true; return; }
    if (n.props.role === 'switch' || n.props.role === 'radiogroup' || ['select', 'input', 'textarea'].includes(n.tag)) {
      controls++;
      if (typeof n.props.dataset?.setting !== 'string') {
        const exempt = Object.keys(EXEMPT).find(k => EXEMPT[k]!(n));
        if (exempt) seen.add(exempt); else missing.push(`<${n.tag} role=${n.props.role} ${JSON.stringify(n.props.dataset ?? {})}>`);
      }
    }
    walk(n.children);
  };
  walk(nodes(f.tree()).find(n => n.props.dataset?.keepScroll === 'set')!.children);
  assert.deepEqual(missing, []);
  assert.ok(skippedHost, 'the manager host was reached and skipped');
  assert.deepEqual([...seen].sort(), Object.keys(EXEMPT).sort(), 'every exemption still matches a rendered control');
  assert.ok(controls > Object.keys(EXEMPT).length);
});

// Each rendered preference has a registered consumer: the file that reads it to take effect. This is a textual
// check (the field is read there), not proof of behaviour; it fails when a consumer is removed or renamed.
const CONSUMERS: Record<string, readonly [file: string, read: RegExp]> = {
  'general.autostart': ['../../../src-tauri/src/integration.rs', /snapshot\(app\)\.local\.general\.autostart/],
  'general.close_action': ['../../../src-tauri/src/prefs.rs', /local\.general\.close_action == CloseAction::Quit/],
  'general.show_msg_time': ['../main/main.ts', /prefs\?\.general\.show_msg_time/],
  'display.zoom': ['../../../src-tauri/src/prefs.rs', /ui_zoom::apply\(app, new\.display\.zoom\)/],
  'network.system_proxy': ['../../../src-tauri/src/prefs.rs', /set_use_system_proxy\(new\.network\.system_proxy\)/],
  'dnd.schedule_enabled': ['../../../src-tauri/src/prefs.rs', /set_dnd_schedule_enabled\(file\.local\.dnd\.schedule_enabled\)/],
  'dnd.follow_system': ['../../../src-tauri/src/attention.rs', /dnd\.follow_system && os\.quiet/],
  'keys.send_key': ['../main/main.ts', /prefs\?\.keys\.send_key/],
  'keys.toggle_main': ['../../../src-tauri/src/system_integration.rs', /parse_shortcut\(&next\.keys\.toggle_main\)/],
  'assistant.enabled': ['../main/main.ts', /prefs\?\.assistant\.enabled/],
  'assistant.outbound_translation': ['../main/main.ts', /prefs\?\.assistant\.outbound_translation/],
  'assistant.package_quick_view': ['../main/main.ts', /prefs\?\.assistant\.package_quick_view/],
  'reminder.enabled': ['../../../crates/core-notify/src/engine.rs', /self\.settings\.enabled/],
  'reminder.t1_seconds': ['../../../crates/core-notify/src/engine.rs', /settings\.t1_seconds\) \* 1000/],
  'reminder.timeout_sound': ['../../../crates/core-notify/src/engine.rs', /pol\.sound && settings\.timeout_sound/],
  'reminder.tray_flash': ['../../../crates/core-notify/src/engine.rs', /self\.settings\.tray_flash/],
  'reminder.taskbar_badge': ['../../../crates/core-notify/src/engine.rs', /self\.settings\.taskbar_badge/],
  'reminder.alert_during_dnd': ['../../../crates/core-notify/src/escalation.rs', /dnd_active && !settings\.alert_during_dnd/],
  'reminder.alert_during_fullscreen': ['../../../crates/core-notify/src/escalation.rs', /fullscreen_app && !settings\.alert_during_fullscreen/],
  'reminder.continuous_l4': ['../../../crates/core-notify/src/rounds.rs', /settings\.continuous_l4/],
  'reminder.alarm_corner': ['../../../src-tauri/src/scheduler.rs', /state\.settings\(\)\.alarm_corner/],
  'local.sound_profile': ['../main/sound.ts', /const profile = getSoundProfile\(\)/],
};

test('every rendered settings control has a registered consumer that reads its preference', async () => {
  const f = await fixture();
  const rendered = nodes(f.tree()).map(n => n.props.dataset?.setting).filter((key): key is string => typeof key === 'string');
  assert.deepEqual([...rendered].sort(), Object.keys(CONSUMERS).sort(), 'one registered consumer per rendered key, none stale');
  for (const [key, [file, read]] of Object.entries(CONSUMERS)) assert.match(readFileSync(new URL(file, import.meta.url), 'utf8'), read, `${key}: consumer ${file}`);
});


test('editable shortcuts submit exact prefs commands and keep confirmed values on registration failure', async () => {
  const key = 'toggle_main', f = await fixture(), pending = deferred(), before = f.store.get().prefs.keys[key];
  f.store.patch({ section: 'keys' });
  const input = nodes(f.tree()).find(n => n.props.dataset?.fid === `shortcut-${key}`); assert.ok(input);
  input.props.oninput({ target: { value: 'Ctrl+Shift+Y' } });
  assert.equal(nodes(f.tree()).find(n => n.props.dataset?.fid === `shortcut-${key}`)?.props.value, 'Ctrl+Shift+Y');
  f.setResult(UiCommands.PREFS_SET, pending.promise);
  const saving = f.actual('saveShortcut')(key);
  assert.equal(f.store.get().prefs.keys[key], before, 'unconfirmed shortcut never replaces the effective value');
  assert.deepEqual(f.shortcutPayloads, [{ section: 'keys', key, value: 'Ctrl+Shift+Y' }]);
  pending.resolve(new Error('shortcut conflict')); await saving;
  assert.equal(f.store.get().prefs.keys[key], before);
  assert.equal(f.store.get().shortcutDrafts[key], 'Ctrl+Shift+Y');
  assert.ok(nodes(f.tree()).some(n => n.props.role === 'alert' && JSON.stringify(n.children).includes('快捷键未保存')));
  assert.equal(f.store.get().shortcutBusy[key], false);
});

test('shortcut success preserves another setting and a newer edit, with stable focus identity', async () => {
  const f = await fixture(), pending = deferred(), before = f.store.get().prefs;
  f.store.patch({ section: 'keys' }); f.actual('editShortcut')('toggle_main', 'Ctrl+Shift+Y');
  f.setResult(UiCommands.PREFS_SET, pending.promise); const saving = f.actual('saveShortcut')('toggle_main');
  f.actual('editShortcut')('toggle_main', 'Ctrl+Shift+Z');
  f.store.patch({ prefs: { ...before, keys: { ...before.keys, send_key: 'ctrl_enter' } } });
  pending.resolve({ ...before, keys: { ...before.keys, toggle_main: 'Ctrl+Shift+Y' } }); await saving;
  assert.equal(f.store.get().prefs.keys.toggle_main, 'Ctrl+Shift+Y'); assert.equal(f.store.get().prefs.keys.send_key, 'ctrl_enter');
  const input = nodes(f.tree()).find(n => n.props.dataset?.fid === 'shortcut-toggle_main'); assert.ok(input);
  assert.equal(input.props.value, 'Ctrl+Shift+Z');
  let stopped = 0; input.props.onkeydown({ key: 'Enter', stopPropagation() { stopped++; } }); input.props.onkeyup({ key: 'Enter', stopPropagation() { stopped++; } });
  assert.equal(stopped, 2); assert.equal(f.shortcutPayloads.length, 1, 'keyup does not submit or send');
  f.actual('editShortcut')('toggle_main', '   '); await f.actual('saveShortcut')('toggle_main');
  assert.equal(f.shortcutPayloads.length, 1); assert.ok(f.store.get().shortcutErrors.toggle_main.includes('请输入快捷键'));
});


test('settings morph keeps shortcut editor DOM and focus connected across input while save uses the latest draft', async () => {
  const { root } = installFakeDom(), f = await fixture({ h: domH }); f.store.patch({ section: 'keys' });
  const draw = () => rerender(root as unknown as Element, () => f.tree() as unknown as Node, { morph: true });
  draw(); const input = root.querySelector('[data-fid="shortcut-toggle_main"]')!, form = root.querySelector('form')!;
  input.focus(); input.value = 'Ctrl+Shift+Y'; input.dispatch('input'); resetCounters(); draw();
  assert.equal(root.querySelector('[data-fid="shortcut-toggle_main"]'), input); assert.equal(input.isConnected, true);
  assert.equal(fakeDocument.activeElement, input); assert.equal(readCounters().detached, 0);
  input.value = 'Ctrl+Shift+Z'; input.dispatch('input'); draw();
  assert.equal(root.querySelector('form'), form);
  const before = f.store.get().prefs; f.setResult(UiCommands.PREFS_SET, { ...before, keys: { ...before.keys, toggle_main: 'Ctrl+Shift+Z' } });
  for (const fn of form.listeners.get('submit') ?? []) fn.call(form, { type: 'submit', target: form, currentTarget: form, preventDefault() {}, stopPropagation() {} } as any);
  for (let i = 0; i < 8; i++) await Promise.resolve(); draw();
  assert.deepEqual(f.shortcutPayloads, [{ section: 'keys', key: 'toggle_main', value: 'Ctrl+Shift+Z' }]);
  assert.equal(root.querySelector('[data-fid="shortcut-toggle_main"]'), input); assert.equal(fakeDocument.activeElement, input);
  assert.match(source, /rerender\(root!, \(\) => render\(s\), \{ morph: true \}\)[\s\S]*subscribeBatched\(store, paint\)/);
});

test('settings morph clears a retained TSim password input before login IPC settles', async () => {
  const { root } = installFakeDom(), f = await fixture({ h: domH }), pending = deferred();
  f.setResult(UiCommands.ASSIST_TSIM_LOGIN, pending.promise);
  const draw = () => rerender(root as unknown as Element, () => f.tree() as unknown as Node, { morph: true });
  draw(); const password = root.querySelector('[data-fid="tsim-pass"]')!;
  assert.ok(password.value.length > 0);
  const login = f.actual('tsimLogin')(); draw();
  assert.equal(root.querySelector('[data-fid="tsim-pass"]'), password); assert.equal(password.value, '');
  assert.equal(password.getAttribute('value'), null);
  pending.resolve({ logged_in: false, user: null, session_epoch: 1 }); await login; draw(); assert.equal(password.value, '');
});


test('actual scheduled DND control writes local preferences and renders saved state', async () => {
  const calls: unknown[][] = [];
  const f = await fixture({ ALLOWED_T1_SECONDS: [30, 60, 90, 120, 180], setPref: (...args: unknown[]) => calls.push(args) });
  f.store.patch({ section: 'notify' });
  const control = () => nodes(f.tree()).find(n => n.props.dataset?.setting === 'dnd.schedule_enabled');
  assert.equal(control()?.props.role, 'switch');
  assert.equal(control()?.props['aria-checked'], 'false');
  control()!.props.onclick();
  assert.deepEqual(calls, [['dnd', 'schedule_enabled', true]]);
  const prefs = f.store.get().prefs;
  f.store.patch({ prefs: { ...prefs, dnd: { ...prefs.dnd, schedule_enabled: true } } });
  assert.equal(control()?.props['aria-checked'], 'true');
  control()!.props.onclick();
  assert.deepEqual(calls[1], ['dnd', 'schedule_enabled', false]);
  assert.equal(f.store.get().prefs.reminder.alert_during_dnd, true);
});

// I-20: the settings page must not show a switch that is only stored and never applied. Every rendered
// control maps to a real host preference in src-tauri/src/prefs.rs and writes exactly that key; every
// host-writable preference is either rendered here or owned, with a reason, by another surface.
const prefsRs = readFileSync(new URL('../../../src-tauri/src/prefs.rs', import.meta.url), 'utf8');
function rustBlock(re: RegExp): string { const m = re.exec(prefsRs); assert.ok(m, String(re)); return m[1]!; }
function hostPreferenceKeys() {
  const fields = (struct: string) => [...rustBlock(new RegExp(`pub struct ${struct} \\{([\\s\\S]*?)\\n\\}`)).matchAll(/^\s*pub ([a-z_0-9]+): ([A-Za-z0-9_]+)/gm)].map(m => [m[1]!, m[2]!] as const);
  const strs = (name: string) => [...rustBlock(new RegExp(`const ${name}: &\\[&str\\] = &\\[([\\s\\S]*?)\\];`)).matchAll(/"([a-z_0-9]+)"/g)].map(m => m[1]!);
  const local = fields('LocalPrefs').flatMap(([section, type]) => fields(type).map(([key]) => `${section}.${key}`));
  const readOnly = [...rustBlock(/const READ_ONLY_KEYS: [^=]+=\s*&\[([\s\S]*?)\];/).matchAll(/\("([a-z_]+)",\s*"([a-z_0-9]+)"\)/g)].map(m => `${m[1]}.${m[2]}`);
  const reminder = [...strs('REMINDER_LOCAL_KEYS'), ...strs('REMINDER_NOTIFY_KEYS')].map(k => `reminder.${k}`);
  return { local, readOnly, reminder };
}

test('I-20: the TS preference snapshot carries exactly the host preference keys, removed ones included in neither', async () => {
  const { local, readOnly, reminder } = hostPreferenceKeys();
  assert.ok(local.length >= 15 && reminder.length === 9, 'prefs.rs parsed');
  const prefs = (await fixture()).store.get().prefs as Record<string, Record<string, unknown>>;
  const tsLocal = Object.entries(prefs).filter(([section]) => section !== 'reminder').flatMap(([section, value]) => Object.keys(value).map(key => `${section}.${key}`));
  assert.deepEqual(tsLocal.sort(), [...local].sort());
  assert.deepEqual(Object.keys(prefs['reminder']!).map(key => `reminder.${key}`).sort(), [...reminder].sort());
  for (const key of readOnly) assert.ok(local.includes(key), key);
  for (const gone of ['general.start_hidden', 'general.spell_check', 'display.gpu', 'storage.cache_days', 'privacy.analytics']) assert.equal(local.includes(gone) || tsLocal.includes(gone), false, gone);
});

test('I-20: every rendered settings control writes the real host preference it is labelled with; nothing is stored but unused', async () => {
  const { local, readOnly, reminder } = hostPreferenceKeys();
  const writes: string[] = [];
  const f = await fixture({ setPref: (section: string, key: string) => { writes.push(`${section}.${key}`); }, setReminder: (key: string) => { writes.push(`reminder.${key}`); }, setSoundProfile: () => { writes.push('local.sound_profile'); } });
  // The alarm tone is this machine's sound-player choice, not a host preference.
  const LOCAL_ONLY = new Set(['local.sound_profile']);
  const writable = new Set([...local.filter(key => !readOnly.includes(key)), ...reminder]);
  const controls = nodes(f.tree()).filter(n => typeof n.props.dataset?.setting === 'string');
  const rendered = controls.map(n => n.props.dataset.setting as string);
  assert.equal(new Set(rendered).size, rendered.length, 'one control per preference');
  for (const key of rendered) assert.ok(writable.has(key) || LOCAL_ONLY.has(key), `${key} is not a writable host preference`);
  for (const key of readOnly) assert.equal(rendered.includes(key), false, `${key} is read-only and shown as status only`);
  for (const control of controls) {
    const key = control.props.dataset.setting as string, w0 = writes.length, s0 = f.shortcutPayloads.length;
    if (control.props.role === 'switch') control.props.onclick();
    else if (control.props.role === 'radiogroup') (nodes(control.children).find(b => b.tag === 'button' && b.props['aria-checked'] === 'false') ?? assert.fail(key)).props.onclick();
    else if (control.tag === 'select') control.props.onchange({ target: { value: String(nodes(control.children).at(-1)!.props.value) } });
    else if (control.tag === 'input') {
      control.props.oninput({ target: { value: 'Ctrl+Alt+K' } });
      const form = nodes(f.tree()).find(n => n.tag === 'form' && nodes(n.children).some(c => c.props.dataset?.setting === key));
      assert.ok(form, key); form.props.onsubmit({ preventDefault() {}, stopPropagation() {} });
    } else assert.fail(`${key}: unexpected control <${control.tag}>`);
    const made = [...writes.slice(w0), ...(f.shortcutPayloads.slice(s0) as { section: string; key: string }[]).map(p => `${p.section}.${p.key}`)];
    assert.deepEqual(made, [key], `${key} writes its own key`);
  }
  // Writable host preferences without a control here are owned by the main window.
  const ELSEWHERE: Record<string, RegExp> = {
    'assistant.send_mode': /section: 'assistant', key: 'send_mode'/, // the input bar's send-mode switch
    'notice_banner.accounts': /section: 'notice_banner', key: 'accounts'/, // per-account banner toggles in the notice panel
  };
  const mainDir = new URL('../main/', import.meta.url);
  const mainSource = readdirSync(mainDir).filter(name => name.endsWith('.ts') && !name.endsWith('.test.ts')).map(name => readFileSync(new URL(name, mainDir), 'utf8')).join('\n');
  for (const key of writable) {
    if (rendered.includes(key)) continue;
    assert.ok(key in ELSEWHERE, `${key} is stored but neither rendered here nor owned elsewhere`);
    assert.match(mainSource, ELSEWHERE[key]!, `${key} owner`);
  }
  for (const key of Object.keys(ELSEWHERE)) assert.equal(rendered.includes(key), false, `${key} stays out of settings`);
});
