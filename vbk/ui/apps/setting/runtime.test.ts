import { t as translate, type I18nKey } from '../../packages/ui-kit/src/i18n.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import * as vm from './viewmodel.ts';
import { SETTING_STRINGS, fmt } from './strings.ts';
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
  const store = createStore<Record<string, any>>({ prefs, section: 'assistant', tsimForm: { user: 'SYNTHETIC_USER', password: 'SYNTHETIC_PASSWORD' }, tsimBusy: false, tsimError: null, tsimStatus: null, tsimImportExpanded: false, tsimImportToken: '', loading: false, loadError: null, settingsRequest: 0, tsimRequest: 0, net: null, version: null, toast: null });
  const calls: { command: string }[] = []; const results = new Map<string, unknown>([[PrefsCommands.SNAPSHOT, prefs], [UiCommands.ASSIST_TSIM_STATUS, { logged_in: false, user: null }], [UiCommands.ASSIST_TSIM_LOGIN, { logged_in: true, user: 'SYNTHETIC_USER' }], [UiCommands.ASSIST_TSIM_LOGOUT, { logged_in: false, user: null }]]);
  let importKeys: string[] = []; const shortcutPayloads: object[] = [];
  const invoke = async (command: string, payload?: object) => { calls.push({ command, payload } as { command: string }); if (command === UiCommands.PREFS_SET && payload && 'section' in payload && payload.section === 'keys') shortcutPayloads.push(payload); if (command === UiCommands.ASSIST_TSIM_IMPORT_SESSION) importKeys = Object.keys(payload ?? {}); const result = await results.get(command); if (result instanceof Error || (result && typeof result === 'object' && 'code' in result)) throw result; return result; };
  const env: Record<string, any> = { recoveryView: () => null, recovery: { refresh() {} }, ...vm, settingsNavigationVersion: 0, ALLOWED_T1_SECONDS, preferenceWrites: new Map(), S: SETTING_STRINGS, fmt, store, ipc: { invoke }, PrefsCommands, ShellCommands, UiCommands, isPrefsSnapshot, cx, h: (tag: string, props: object | null, ...children: unknown[]) => ({ tag, props: props ?? {}, children }), t: (key: string, vars?: Record<string, string | number>) => key.startsWith('set.runtime.') ? translate(key as I18nKey, vars) : key, msg: () => 'SYNTHETIC_UNTRUSTED_ERROR', toast: (value: string) => store.patch({ toast: value }), icon: () => null, IC: {}, sel: { mock: true }, platform: 'windows', windowControls: (o: { closeLabel?: string; onClose?: () => void; closeDataset?: object }) => env['platform'] === 'windows' ? ({ tag: 'div', props: { class: 'wbtns' }, children: [{ tag: 'button', props: { 'aria-label': o.closeLabel, onclick: o.onClose, dataset: o.closeDataset ?? {} }, children: [] }] }) : null, closeWindow() {}, selectSection() {}, onBodyScroll() {}, setPref() {}, setReminder() {}, ...overrides };
  function actual(name: string): (...args: any[]) => any { const a = source.search(new RegExp('(?:async )?function ' + name + '(?:<[^>]+>)?\\(')); assert.ok(a >= 0, name); const tail = source.slice(a); const next = /\n(?:(?:async )?function |(?:let|const) [A-Za-z]|subscribeBatched\()/.exec(tail); assert.ok(next, name); return new Function(...Object.keys(env), stripTypeScriptTypes(tail.slice(0, next.index)) + '\nreturn ' + name + ';')(...Object.values(env)); }
  for (const name of ['head', 'row', 'toggle', 'segment', 'text', 'editShortcut', 'saveShortcut', 'shortcutRow', 'loadSettings', 'refreshTsimStatus', 'tsimLogin', 'tsimLogout', 'tsimImportSession', 'tsimBrowserConnect', 'generalSection', 'displaySection', 'notifySection', 'keysSection', 'assistantSection', 'networkSection', 'storageSection', 'privacySection', 'aboutSection', 'sectionContent', 'body', 'closeWindow', 'titleBar', 'render']) if (new RegExp('function ' + name + '(?:<[^>]+>)?\\(').test(source)) env[name] = actual(name);
  function bootstrap() { if (env['loadSettings']) return env['loadSettings'](); const a = source.lastIndexOf('void (async () => {'), b = source.indexOf('\n})();', a) + '\n})();'.length; assert.ok(a >= 0 && b > a); return new Function(...Object.keys(env), 'return ' + stripTypeScriptTypes(source.slice(a, b).replace('void ', '')))(...Object.values(env)); }
  return { store, calls, shortcutPayloads, actual, bootstrap, importKeys: () => importKeys, setResult: (command: string, value: unknown) => results.set(command, value), tree: () => env['render'](store.get()) };
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

test('actual existing-session section is collapsed until opened; its password field clears before import IPC settles', async () => {
  const f = await fixture(), pending = deferred();
  let tree = f.tree(); const disclosure = nodes(tree).find(n => n.props.dataset?.tsimImport === '1'); assert.ok(disclosure); assert.equal(disclosure.props.open, false);
  assert.equal(nodes(tree).some(n => n.props.dataset?.fid === 'tsim-import-token'), false);
  disclosure.props.ontoggle({ currentTarget: { open: true } }); tree = f.tree();
  const input = nodes(tree).find(n => n.props.dataset?.fid === 'tsim-import-token'); assert.ok(input); assert.equal(input.props.type, 'password'); assert.equal(input.props.autocomplete, 'off');
  input.props.oninput({ target: { value: 'SYNTHETIC_SESSION_TOKEN' } }); f.setResult(UiCommands.ASSIST_TSIM_IMPORT_SESSION, pending.promise);
  const done = new Promise<void>(resolve => { const unsubscribe = f.store.subscribe(s => { if (!s.tsimBusy) { unsubscribe(); resolve(); } }); });
  nodes(tree).find(n => n.props.dataset?.action === 'tsim-import-form')!.props.onsubmit({ preventDefault() {} });
  assert.equal(f.store.get().tsimImportToken, ''); assert.equal(f.store.get().tsimBusy, true); assert.equal(JSON.stringify(f.tree()).includes('SYNTHETIC_SESSION_TOKEN'), false);
  pending.resolve({ logged_in: true, user: 'SYNTHETIC_IMPORTED_USER', session_epoch: 2 }); await done;
  assert.deepEqual(f.importKeys(), ['access_token']); assert.equal(f.store.get().tsimStatus.user, 'SYNTHETIC_IMPORTED_USER'); assert.equal(f.store.get().tsimImportExpanded, false); assert.equal(f.calls[0]?.command, 'assistant_tsim_import_session');
});

test('actual import refuses false/malformed status and never copies credential-bearing backend errors', async () => {
  for (const response of [{ logged_in: false, user: null, session_epoch: 2 }, { logged_in: true, user: 'synthetic' }, { code: 'assistant.session_cleared', message: 'SYNTHETIC_SESSION_TOKEN SYNTHETIC_PRIVATE_DIAGNOSTIC' }]) {
    const f = await fixture(); f.store.patch({ tsimImportExpanded: true, tsimImportToken: 'SYNTHETIC_SESSION_TOKEN' }); f.setResult(UiCommands.ASSIST_TSIM_IMPORT_SESSION, response); await f.actual('tsimImportSession')();
    assert.equal(f.store.get().tsimImportToken, ''); assert.equal(f.store.get().tsimBusy, false); assert.ok(f.store.get().tsimError); assert.equal(f.store.get().tsimStatus?.logged_in === true, false); assert.equal(JSON.stringify(f.tree()).includes('SYNTHETIC_SESSION_TOKEN'), false); assert.equal(JSON.stringify(f.tree()).includes('SYNTHETIC_PRIVATE_DIAGNOSTIC'), false);
  }
});

test('actual import is single-flight and late import cannot overwrite newer status; closing the section drops unsubmitted input; section navigation no longer unmounts it', async () => {
  const f = await fixture(), pending = deferred(); f.store.patch({ tsimImportExpanded: true, tsimImportToken: 'SYNTHETIC_SESSION_TOKEN' }); f.setResult(UiCommands.ASSIST_TSIM_IMPORT_SESSION, pending.promise);
  const importing = f.actual('tsimImportSession')(); await f.actual('tsimImportSession')(); assert.equal(f.calls.length, 1);
  f.setResult(UiCommands.ASSIST_TSIM_STATUS, { logged_in: false, user: null, session_epoch: 3 }); await f.actual('refreshTsimStatus')(); pending.resolve({ logged_in: true, user: 'SYNTHETIC_OLD_IMPORT', session_epoch: 2 }); await importing;
  assert.equal(f.store.get().tsimStatus.session_epoch, 3); assert.equal(f.store.get().tsimStatus.logged_in, false);
  f.store.patch({ tsimImportToken: 'SYNTHETIC_UNSUBMITTED' }); nodes(f.tree()).find(n => n.props.dataset?.tsimImport === '1')!.props.ontoggle({ currentTarget: { open: false } }); assert.equal(f.store.get().tsimImportToken, '');
  f.store.patch({ tsimImportExpanded: true, tsimImportToken: 'SYNTHETIC_UNSUBMITTED' }); nodes(f.tree()).find(n => n.props.dataset?.section === 'general')!.props.onclick(); assert.equal(f.store.get().tsimImportToken, 'SYNTHETIC_UNSUBMITTED'); assert.equal(f.store.get().tsimImportExpanded, true);
});

test('actual close button clears unsubmitted session input before a hung or failed native close resolves', async () => {
  for (const fail of [false, true]) {
    const f = await fixture(), close = deferred(); f.store.patch({ tsimImportExpanded: true, tsimImportToken: 'SYNTHETIC_UNSUBMITTED_SESSION' }); f.setResult(UiCommands.SHELL_WINDOW, close.promise);
    nodes(f.tree()).find(n => n.props.dataset?.action === 'close')!.props.onclick();
    assert.equal(f.store.get().tsimImportToken, ''); assert.equal(f.store.get().tsimImportExpanded, false); assert.equal(JSON.stringify(f.tree()).includes('SYNTHETIC_UNSUBMITTED_SESSION'), false);
    assert.equal(f.calls[0]?.command, 'shell_window'); close.resolve(fail ? new Error('SYNTHETIC CLOSE FAILURE') : null);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); assert.equal(f.store.get().tsimImportToken, '');
  }
});

test('actual close revokes an import request ticket even when the setting window remains open', async () => {
  const f = await fixture(), importing = deferred(), closing = deferred(); f.store.patch({ tsimImportExpanded: true, tsimImportToken: 'SYNTHETIC_SESSION_TOKEN' }); f.setResult(UiCommands.ASSIST_TSIM_IMPORT_SESSION, importing.promise); f.setResult(UiCommands.SHELL_WINDOW, closing.promise);
  const request = f.actual('tsimImportSession')(); nodes(f.tree()).find(n => n.props.dataset?.action === 'close')!.props.onclick();
  importing.resolve({ logged_in: true, user: 'SYNTHETIC_LATE_IMPORT', session_epoch: 2 }); await request;
  assert.equal(f.store.get().tsimStatus, null); assert.equal(f.store.get().tsimImportToken, ''); assert.equal(f.store.get().tsimImportExpanded, false);
  closing.resolve(new Error('SYNTHETIC CLOSE FAILURE')); await Promise.resolve(); await Promise.resolve();
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


test('one browser profile connects directly from Chrome on macOS without exposing a token', async () => {
  const f = await fixture({ platform: 'macos' });
  const button = nodes(f.tree()).find(n => n.props.dataset?.action === 'tsim-browser-connect');
  assert.ok(button); assert.match(button.props.class, /pri/);
  f.setResult(UiCommands.ASSIST_TSIM_BROWSER_PROFILES, [{ id: 'chrome:Default', label: 'Chrome · Default' }]);
  f.setResult(UiCommands.ASSIST_TSIM_BROWSER_CONNECT, { logged_in: true, user: 'synthetic-browser-user', session_epoch: 8 });
  await f.actual('tsimBrowserConnect')();
  assert.deepEqual(f.calls.map(c => c.command), [UiCommands.ASSIST_TSIM_BROWSER_PROFILES, UiCommands.ASSIST_TSIM_BROWSER_CONNECT]);
  assert.equal(f.store.get().tsimStatus.user, 'synthetic-browser-user');
  assert.equal(f.store.get().tsimForm.password, '');
});

test('failed Chrome connection retains account login and renders only a safe error', async () => {
  const f = await fixture({ platform: 'macos' });
  f.setResult(UiCommands.ASSIST_TSIM_BROWSER_PROFILES, [{ id: 'chrome:Default', label: 'Chrome · Default' }]);
  f.setResult(UiCommands.ASSIST_TSIM_BROWSER_CONNECT, { code: 'assistant.browser_storage_unavailable', message: 'SYNTHETIC_PRIVATE_TOKEN' });
  await f.actual('tsimBrowserConnect')();
  assert.equal(f.store.get().tsimStatus, null);
  assert.ok(nodes(f.tree()).some(n => n.props.dataset?.action === 'tsim-login'));
  assert.equal(JSON.stringify(f.tree()).includes('SYNTHETIC_PRIVATE_TOKEN'), false);
});

test('multiple browser profiles require selection and missing profiles retain manual login', async () => {
  const f = await fixture();
  f.setResult(UiCommands.ASSIST_TSIM_BROWSER_PROFILES, [{ id: 'edge:Default', label: 'Edge · Default' }, { id: 'chrome:Default', label: 'Chrome · Default' }]);
  await f.actual('tsimBrowserConnect')();
  assert.equal(f.calls.length, 1);
  assert.equal(nodes(f.tree()).filter(n => n.props.dataset?.browserProfile).length, 2);
  f.setResult(UiCommands.ASSIST_TSIM_BROWSER_PROFILES, []);
  await f.actual('tsimBrowserConnect')();
  assert.match(f.store.get().tsimError, /没有找到/);
  assert.ok(nodes(f.tree()).some(n => n.props.dataset?.action === 'tsim-login'));
});

test('late browser discovery cannot connect after newer user intent', async () => {
  const f = await fixture(), pending = deferred();
  f.setResult(UiCommands.ASSIST_TSIM_BROWSER_PROFILES, pending.promise);
  const request = f.actual('tsimBrowserConnect')();
  f.store.patch({ tsimRequest: f.store.get().tsimRequest + 1, tsimBusy: false });
  pending.resolve([{ id: 'edge:Default', label: 'Edge · Default' }]); await request;
  assert.equal(f.calls.length, 1);
});


test('browser invalidation event removes stale logged-in identity without cancelling an active login', async () => {
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
  const first = f.actual('setPref')('display', 'zoom', 125);
  const latest = { ...before, display: { ...before.display, zoom: 100, gpu: !before.display.gpu } };
  f.setResult(UiCommands.PREFS_SET, latest);
  await f.actual('setPref')('display', 'gpu', !before.display.gpu);
  assert.equal(f.store.get().prefs.display.zoom, 125);
  pending.resolve(new Error('failed')); await first;
  assert.equal(f.store.get().prefs.display.zoom, before.display.zoom);
  assert.equal(f.store.get().prefs.display.gpu, !before.display.gpu);
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

test('settings without a working backend are shown as facts, not as switches', async () => {
  const f = await fixture();
  const controls = nodes(f.tree()).map(n => n.props.dataset?.setting).filter(Boolean);
  for (const key of ['display.gpu', 'storage.cache_days', 'privacy.analytics', 'privacy.crash_upload']) assert.ok(!controls.includes(key), key);
  for (const key of ['display.zoom', 'dnd.schedule_enabled', 'dnd.follow_system', 'network.system_proxy']) assert.ok(controls.includes(key), key);
  assert.equal(nodes(f.tree()).find(n => n.props.dataset?.action === 'clear-cache'), undefined);
});

test('settings diagnostics and data-directory buttons use dedicated host commands', async () => {
  const f = await fixture();
  const storage = nodes(f.tree());
  const open = storage.find(n => n.tag === 'button' && JSON.stringify(n.children).includes('set.storage.open'));
  assert.ok(open); open.props.onclick(); await Promise.resolve();
  assert.equal(f.calls.at(-1)?.command, ShellCommands.OPEN_DATA_DIRECTORY);
  f.setResult(ShellCommands.EXPORT_DIAGNOSTICS, false);
  const exp = nodes(f.tree()).find(n => n.tag === 'button' && JSON.stringify(n.children).includes('set.privacy.export'));
  assert.ok(exp); exp.props.onclick(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(f.calls.at(-1)?.command, ShellCommands.EXPORT_DIAGNOSTICS); assert.equal(f.store.get().toast, null);
  f.setResult(ShellCommands.EXPORT_DIAGNOSTICS, true); exp.props.onclick();
  for (let i = 0; i < 6; i++) await Promise.resolve();
  assert.equal(f.store.get().toast, '诊断信息已导出');
});

test('actual settings page renders every section in one long page; nav is a labelled nav with aria-current and calls selectSection', async () => {
  const picked: string[] = [];
  const f = await fixture({ selectSection: (id: string) => picked.push(id) }); f.store.patch({ section: 'storage' });
  const all = nodes(f.tree());
  assert.deepEqual(all.filter(n => n.tag === 'section').map(n => n.props.dataset?.setSection), vm.SECTIONS.map(s => s.id));
  assert.ok(all.filter(n => n.tag === 'section').every(n => (n.children[0] as Tree).tag === 'h2'));
  const nav = all.find(n => n.tag === 'nav'); assert.ok(nav); assert.equal(all.some(n => n.props.role === 'tablist' || n.props.role === 'tab'), false);
  const buttons = nodes(nav.children).filter(n => n.tag === 'button');
  assert.deepEqual(buttons.map(b => b.props.dataset.section), vm.SECTIONS.map(s => s.id));
  assert.deepEqual(buttons.filter(b => b.props['aria-current'] === 'true').map(b => b.props.dataset.section), ['storage']);
  buttons.find(b => b.props.dataset.section === 'about')!.props.onclick(); assert.deepEqual(picked, ['about']);
  assert.ok(all.find(n => n.props.dataset?.keepScroll === 'set')?.props.onscroll);
  // 已移除的内容：发送模式、只读翻译服务行
  const dump = JSON.stringify(f.tree());
  for (const gone of ['set.asst.sendMode', 'set.asst.outService', 'set.asst.inService']) assert.equal(dump.includes(gone), false, gone);
  assert.equal(all.some(n => n.props.dataset?.sendMode), false);
});

test('general settings open web personal settings under the active account', async () => {
  const f = await fixture({ section: 'general' });
  const button = () => nodes(f.tree()).find(n => n.props.dataset?.action === 'personal-settings')!;
  assert.equal(button().props.disabled, true);
  const account = { account_id: 'synthetic-a', environment: 'synthetic', session_generation: 1 };
  f.store.patch({ account });
  assert.equal(button().props.disabled, false);
  button().props.onclick();
  assert.deepEqual(f.calls.at(-1), { command: UiCommands.SHELL_OPEN_WEBVIEW, payload: { account, url: vm.PERSONAL_SETTINGS_URL } });
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
