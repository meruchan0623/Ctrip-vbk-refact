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
async function fixture() {
  const mock = createMockIpc('default', { tick: false, latency: 0 }); const prefs = await mock.invoke(PrefsCommands.SNAPSHOT); mock.dispose();
  const store = createStore<Record<string, any>>({ prefs, section: 'assistant', tsimForm: { user: 'SYNTHETIC_USER', password: 'SYNTHETIC_PASSWORD' }, tsimBusy: false, tsimError: null, tsimStatus: null, loading: false, loadError: null, settingsRequest: 0, tsimRequest: 0, net: null, nick: null, version: null, toast: null });
  const calls: { command: string }[] = []; const results = new Map<string, unknown>([[PrefsCommands.SNAPSHOT, prefs], [UiCommands.ASSIST_TSIM_STATUS, { logged_in: false, user: null }], [UiCommands.ASSIST_TSIM_LOGIN, { logged_in: true, user: 'SYNTHETIC_USER' }], [UiCommands.ASSIST_TSIM_LOGOUT, { logged_in: false, user: null }]]);
  const invoke = async (command: string) => { calls.push({ command }); const result = await results.get(command); if (result instanceof Error || (result && typeof result === 'object' && 'code' in result)) throw result; return result; };
  const env: Record<string, any> = { ...vm, S: SETTING_STRINGS, fmt, store, ipc: { invoke }, PrefsCommands, UiCommands, isPrefsSnapshot, cx, h: (tag: string, props: object | null, ...children: unknown[]) => ({ tag, props: props ?? {}, children }), t: (key: string) => key, msg: () => 'SYNTHETIC_UNTRUSTED_ERROR', toast: (value: string) => store.patch({ toast: value }), icon: () => null, IC: {}, sel: { mock: true }, platform: 'windows', closeWindow() {}, setPref() {}, setReminder() {} };
  function actual(name: string): (...args: any[]) => any { const a = source.search(new RegExp('(?:async )?function ' + name + '\\(')); assert.ok(a >= 0, name); const tail = source.slice(a); const next = /\n(?:(?:async )?function |(?:let|const) [A-Za-z]|subscribeBatched\()/.exec(tail); assert.ok(next, name); return new Function(...Object.keys(env), stripTypeScriptTypes(tail.slice(0, next.index)) + '\nreturn ' + name + ';')(...Object.values(env)); }
  for (const name of ['head', 'row', 'toggle', 'segment', 'text', 'loadSettings', 'refreshTsimStatus', 'tsimLogin', 'tsimLogout', 'generalSection', 'displaySection', 'notifySection', 'keysSection', 'assistantSection', 'networkSection', 'storageSection', 'privacySection', 'aboutSection', 'body', 'titleBar', 'render']) if (source.includes(`function ${name}(`)) env[name] = actual(name);
  function bootstrap() { if (env['loadSettings']) return env['loadSettings'](); const a = source.lastIndexOf('void (async () => {'), b = source.indexOf('\n})();', a) + '\n})();'.length; assert.ok(a >= 0 && b > a); return new Function(...Object.keys(env), 'return ' + stripTypeScriptTypes(source.slice(a, b).replace('void ', '')))(...Object.values(env)); }
  return { store, calls, actual, bootstrap, setResult: (command: string, value: unknown) => results.set(command, value), tree: () => env['render'](store.get()) };
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
