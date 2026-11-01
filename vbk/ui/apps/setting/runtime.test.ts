import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import * as vm from './viewmodel.ts';
import { SETTING_STRINGS, fmt } from './strings.ts';
import { createStore } from '../../packages/ui-kit/src/store.ts';
import { cx } from '../../packages/ui-kit/src/h.ts';
import { createMockIpc } from '../../packages/ipc/src/mock.ts';
import { PrefsCommands } from '../../packages/ipc/src/commands.ts';
import { UiCommands } from '../../packages/ipc/src/client.ts';
import { isPrefsSnapshot } from '../_shared/guards.ts';
const source = readFileSync(process.env['VBK_SETTING_MAIN_SOURCE'] ?? new URL('./main.ts', import.meta.url), 'utf8');
interface Tree { tag: string; props: Record<string, any>; children: unknown[] }
function nodes(tree: unknown): Tree[] { if (Array.isArray(tree)) return tree.flatMap(nodes); if (!tree || typeof tree !== 'object') return []; const node = tree as Tree; return [node, ...nodes(node.children ?? [])]; }
function deferred() { let resolve!: (value: unknown) => void; return { promise: new Promise(r => { resolve = r; }), resolve: (v: unknown) => resolve(v) }; }
async function fixture(overrides: Record<string, any> = {}) {
  const mock = createMockIpc('default', { tick: false, latency: 0 }); const prefs = await mock.invoke(PrefsCommands.SNAPSHOT); mock.dispose();
  const store = createStore<Record<string, any>>({ prefs, section: 'assistant', tsimForm: { user: 'SYNTHETIC_USER', password: 'SYNTHETIC_PASSWORD' }, tsimBusy: false, tsimError: null, tsimStatus: null, tsimImportExpanded: false, tsimImportToken: '', loading: false, loadError: null, settingsRequest: 0, tsimRequest: 0, net: null, nick: null, version: null, toast: null });
  const calls: { command: string }[] = []; const results = new Map<string, unknown>([[PrefsCommands.SNAPSHOT, prefs], [UiCommands.ASSIST_TSIM_STATUS, { logged_in: false, user: null }], [UiCommands.ASSIST_TSIM_LOGIN, { logged_in: true, user: 'SYNTHETIC_USER' }], [UiCommands.ASSIST_TSIM_LOGOUT, { logged_in: false, user: null }]]);
  let importKeys: string[] = [];
  const invoke = async (command: string, payload?: object) => { calls.push({ command }); if (command === UiCommands.ASSIST_TSIM_IMPORT_SESSION) importKeys = Object.keys(payload ?? {}); const result = await results.get(command); if (result instanceof Error || (result && typeof result === 'object' && 'code' in result)) throw result; return result; };
  const env: Record<string, any> = { ...vm, S: SETTING_STRINGS, fmt, store, ipc: { invoke }, PrefsCommands, UiCommands, isPrefsSnapshot, cx, h: (tag: string, props: object | null, ...children: unknown[]) => ({ tag, props: props ?? {}, children }), t: (key: string) => key, msg: () => 'SYNTHETIC_UNTRUSTED_ERROR', toast: (value: string) => store.patch({ toast: value }), icon: () => null, IC: {}, sel: { mock: true }, platform: 'windows', closeWindow() {}, setPref() {}, setReminder() {}, ...overrides };
  function actual(name: string): (...args: any[]) => any { const a = source.search(new RegExp('(?:async )?function ' + name + '\\(')); assert.ok(a >= 0, name); const tail = source.slice(a); const next = /\n(?:(?:async )?function |(?:let|const) [A-Za-z]|subscribeBatched\()/.exec(tail); assert.ok(next, name); return new Function(...Object.keys(env), stripTypeScriptTypes(tail.slice(0, next.index)) + '\nreturn ' + name + ';')(...Object.values(env)); }
  for (const name of ['head', 'row', 'toggle', 'segment', 'text', 'loadSettings', 'refreshTsimStatus', 'tsimLogin', 'tsimLogout', 'tsimImportSession', 'tsimBrowserConnect', 'generalSection', 'displaySection', 'notifySection', 'keysSection', 'assistantSection', 'networkSection', 'storageSection', 'privacySection', 'aboutSection', 'body', 'closeWindow', 'titleBar', 'render']) if (source.includes(`function ${name}(`)) env[name] = actual(name);
  function bootstrap() { if (env['loadSettings']) return env['loadSettings'](); const a = source.lastIndexOf('void (async () => {'), b = source.indexOf('\n})();', a) + '\n})();'.length; assert.ok(a >= 0 && b > a); return new Function(...Object.keys(env), 'return ' + stripTypeScriptTypes(source.slice(a, b).replace('void ', '')))(...Object.values(env)); }
  return { store, calls, actual, bootstrap, importKeys: () => importKeys, setResult: (command: string, value: unknown) => results.set(command, value), tree: () => env['render'](store.get()) };
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
  const loggedIn = settled(); nodes(tree).find(n => n.tag === 'form')!.props.onsubmit({ preventDefault() {} }); await loggedIn;
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

test('actual import is single-flight and late import cannot overwrite newer status; closing the section drops unsubmitted input', async () => {
  const f = await fixture(), pending = deferred(); f.store.patch({ tsimImportExpanded: true, tsimImportToken: 'SYNTHETIC_SESSION_TOKEN' }); f.setResult(UiCommands.ASSIST_TSIM_IMPORT_SESSION, pending.promise);
  const importing = f.actual('tsimImportSession')(); await f.actual('tsimImportSession')(); assert.equal(f.calls.length, 1);
  f.setResult(UiCommands.ASSIST_TSIM_STATUS, { logged_in: false, user: null, session_epoch: 3 }); await f.actual('refreshTsimStatus')(); pending.resolve({ logged_in: true, user: 'SYNTHETIC_OLD_IMPORT', session_epoch: 2 }); await importing;
  assert.equal(f.store.get().tsimStatus.session_epoch, 3); assert.equal(f.store.get().tsimStatus.logged_in, false);
  f.store.patch({ tsimImportToken: 'SYNTHETIC_UNSUBMITTED' }); nodes(f.tree()).find(n => n.props.dataset?.tsimImport === '1')!.props.ontoggle({ currentTarget: { open: false } }); assert.equal(f.store.get().tsimImportToken, '');
  f.store.patch({ tsimImportExpanded: true, tsimImportToken: 'SYNTHETIC_UNSUBMITTED' }); nodes(f.tree()).find(n => n.props.dataset?.section === 'general')!.props.onclick(); assert.equal(f.store.get().tsimImportToken, ''); assert.equal(f.store.get().tsimImportExpanded, false);
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


test('one browser profile requires explicit source selection without exposing a token', async () => {
  const f = await fixture();
  f.setResult(UiCommands.ASSIST_TSIM_BROWSER_PROFILES, [{ id: 'edge:Default', label: 'Edge · Default' }]);
  f.setResult(UiCommands.ASSIST_TSIM_BROWSER_CONNECT, { logged_in: true, user: 'synthetic-browser-user', session_epoch: 8 });
  await f.actual('tsimBrowserConnect')();
  assert.equal(f.calls.length, 1);
  assert.equal(nodes(f.tree()).filter(n => n.props.dataset?.browserProfile).length, 1);
  await f.actual('tsimBrowserConnect')('edge:Default');
  assert.deepEqual(f.calls.map(c => c.command), [UiCommands.ASSIST_TSIM_BROWSER_PROFILES, UiCommands.ASSIST_TSIM_BROWSER_CONNECT]);
  assert.equal(f.store.get().tsimStatus.user, 'synthetic-browser-user');
  assert.equal(f.store.get().tsimForm.password, '');
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
