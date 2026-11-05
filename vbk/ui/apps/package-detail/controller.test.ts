import { t } from '../../packages/ui-kit/src/i18n.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { createPackageDetail as productionDetail, type DetailView } from './controller.ts';
import { UiCommands, UiEvents } from '../../packages/ipc/src/client.ts';
import { Events } from '../../packages/ipc/src/commands.ts';
import { packageFailure, packageInfo } from '../main/package-preview.ts';
const createPackageDetail: typeof productionDetail = process.env['VBK_PACKAGE_DETAIL_SOURCE'] ? new Function('UiCommands', 'packageFailure', 'packageInfo', 't', stripTypeScriptTypes(readFileSync(process.env['VBK_PACKAGE_DETAIL_SOURCE'], 'utf8').replace(/^import .*$/gm, '').replace(/^export /gm, '')) + '\nreturn createPackageDetail;')(UiCommands, packageFailure, packageInfo, t) : productionDetail;
const plan = { iccid: '8986000000000000001', plan: 'SYNTHETIC PLAN', status: 'active', remain_pct: 50, remain: '5 GB', total: '10 GB', supplier: 'Synthetic', apn: 'synthetic', fetched_at_ms: 1000 };
const snapshot = { order_id: '1234567890123456', session_epoch: 1, plan, detail_fields: [{ label: '套餐', value: 'SYNTHETIC PLAN' }], live_fields: [{ label: '网络', value: 'SYNTHETIC NETWORK' }], cdrs: [[{ label: '流量', value: '1 MB' }]], fetched_at_ms: 1000 };
function deferred() { let resolve!: (v: unknown) => void; return { promise: new Promise(r => { resolve = r; }), resolve: (v: unknown) => resolve(v) }; }
function fixture() { let view: DetailView = { busy: false, data: null, error: null, invalidated: false }, result: unknown = snapshot; const calls: { command: string; payload: object }[] = []; const controller = createPackageDetail({ publish: next => { view = next; }, invoke: async (command, payload) => { calls.push({ command, payload }); const value = await result; if (value instanceof Error || value && typeof value === 'object' && 'code' in value) throw value; return value; } }); return { controller, calls, get view() { return view; }, result: (v: unknown) => { result = v; } }; }
test('real detail controller reads only the host-bound command and projects safe fields including CDRs', async () => {
  const f = fixture(); f.result({ ...snapshot, token: 'SYNTHETIC_SECRET_TOKEN', detail_fields: [{ label: 'HTML', value: '<img src=x onerror=alert(1)>', token: 'SYNTHETIC_SECRET_TOKEN' }] }); await f.controller.load();
  assert.deepEqual(f.calls, [{ command: UiCommands.ASSIST_PACKAGE_DETAIL, payload: {} }]); assert.equal(f.view.data?.cdrs.length, 1); assert.equal(JSON.stringify(f.view).includes('SECRET_TOKEN'), false); assert.ok(f.view.data?.detail_fields[0]?.value.startsWith('<img'));
});
test('logout or same-user epoch change clears details and fences every late success or error without rebinding', async () => {
  for (const logged_in of [false, true]) for (const result of [snapshot, new Error('SYNTHETIC_PRIVATE_ERROR')]) {
    const f = fixture(); await f.controller.load(); const pending = deferred(); f.result(pending.promise); const reading = f.controller.load();
    f.controller.identity({ logged_in, user: logged_in ? 'synthetic' : null, session_epoch: 2 }); pending.resolve(result); await reading;
    assert.equal(f.view.data, null); assert.equal(f.view.invalidated, true); const count = f.calls.length; await f.controller.load(); assert.equal(f.calls.length, count);
  }
});
test('newer manual detail refresh wins; malformed fields fail closed without private upstream errors', async () => {
  const f = fixture(), pending = deferred(); f.result(pending.promise); const first = f.controller.load(); f.result({ ...snapshot, plan: { ...plan, remain: '4 GB' } }); await f.controller.load(); pending.resolve(snapshot); await first; assert.equal(f.view.data?.plan.remain, '4 GB');
  f.result({ ...snapshot, cdrs: [[{ label: 'invalid', value: 123 }]] }); await f.controller.load(); assert.equal(f.view.data, null); assert.ok(f.view.error);
  f.result({ code: 'assistant.forbidden', message: 'SYNTHETIC_SECRET_TOKEN' }); await f.controller.load(); assert.ok(f.view.error?.includes('权限')); assert.equal(JSON.stringify(f.view).includes('SECRET_TOKEN'), false);
});
test('actual detail render refresh button invokes the same read controller and field values remain text children', async () => {
  const f = fixture(); await f.controller.load();
  const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  const env: Record<string, any> = { t, h: (tag: string, props: object | null, ...children: unknown[]) => ({ tag, props: props ?? {}, children }), windowControls: (o: { closeLabel?: string; onClose?: () => void; closeDataset?: object }) => ({ tag: 'div', props: { class: 'wbtns' }, children: [{ tag: 'button', props: { 'aria-label': o.closeLabel, onclick: o.onClose, dataset: o.closeDataset ?? {} }, children: [] }] }), ipc: {}, detail: f.controller, close() {} };
  function actual(name: string, next: string) { const a = source.indexOf('function ' + name + '('), b = source.indexOf('\n' + next, a); assert.ok(a >= 0 && b > a); return new Function(...Object.keys(env), stripTypeScriptTypes(source.slice(a, b)) + '\nreturn ' + name + ';')(...Object.values(env)); }
  env['fieldTable'] = actual('fieldTable', 'function render('); const render = actual('render', 'subscribeBatched(');
  function nodes(tree: any): any[] { if (Array.isArray(tree)) return tree.flatMap(nodes); return tree && typeof tree === 'object' ? [tree, ...nodes(tree.children)] : []; }
  const tree = render(f.view), refresh = nodes(tree).find(n => n.props?.dataset?.action === 'refresh-detail'); assert.ok(refresh); refresh.props.onclick(); await Promise.resolve(); await Promise.resolve(); assert.equal(f.calls.length, 2);
  assert.equal(nodes(tree).some(n => n.props?.innerHTML !== undefined), false); assert.ok(JSON.stringify(tree).includes('SYNTHETIC NETWORK')); assert.ok(JSON.stringify(tree).includes('1 MB'));
});

test('unknown detail usage remains null and an account/source invalidation fences a held reply', async () => {
  const f = fixture(); f.result({ ...snapshot, plan: { ...plan, remain_pct: null, remain: '', total: '' } }); await f.controller.load(); assert.equal(f.view.data?.plan.remain_pct, null);
  const pending = deferred(); f.result(pending.promise); const reading = f.controller.load(); f.controller.invalidate('账号范围已变化'); pending.resolve(snapshot); await reading;
  assert.equal(f.view.data, null); assert.equal(f.view.invalidated, true); assert.ok(f.view.error?.includes('账号范围'));
});

test('a same-user epoch event immediately clears an already displayed detail and cannot refresh into a new identity', async () => {
  const f = fixture(); await f.controller.load(); assert.ok(f.view.data);
  f.controller.identity({ logged_in: true, user: 'synthetic', session_epoch: 2 }); assert.equal(f.view.data, null); assert.equal(f.view.invalidated, true); await f.controller.load(); assert.equal(f.calls.length, 1);
});

test('actual directed host context-invalidation event clears the displayed detail without issuing another read', async () => {
  const f = fixture(); await f.controller.load(); const handlers = new Map<string, (value: unknown) => void>();
  const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8'), a = source.indexOf('ipc.listen<unknown>(UiEvents.TSIM_STATUS'), b = source.indexOf('\nvoid detail.load();', a);
  assert.ok(a >= 0 && b > a);
  new Function('ipc', 'UiEvents', 'Events', 'detail', 'isTsimStatus', 't', stripTypeScriptTypes(source.slice(a, b)))({ listen: (event: string, callback: (value: unknown) => void) => handlers.set(event, callback) }, UiEvents, Events, f.controller, () => true, t);
  const invalidated = handlers.get('assistant://package-detail-invalidated'); assert.ok(invalidated); invalidated({}); assert.equal(f.view.data, null); assert.equal(f.view.invalidated, true); assert.equal(f.calls.length, 1);
});

test('actual same-scope unread/remark account broadcasts leave detail data readable and refreshable', async () => {
  const f = fixture(); await f.controller.load(); const handlers = new Map<string, ((value: unknown) => void)[]>();
  const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8'), a = source.indexOf('ipc.listen<unknown>(UiEvents.TSIM_STATUS'), b = source.indexOf('\nvoid detail.load();', a);
  assert.ok(a >= 0 && b > a);
  new Function('ipc', 'UiEvents', 'Events', 'detail', 'isTsimStatus', 't', stripTypeScriptTypes(source.slice(a, b)))({ listen: (event: string, callback: (value: unknown) => void) => handlers.set(event, [...handlers.get(event) ?? [], callback]) }, UiEvents, Events, f.controller, () => true, t);
  const displayed = f.view.data;
  for (let unread = 1; unread < 4; unread++) handlers.get(Events.ACCOUNT_CHANGED)?.forEach(callback => callback({ active_account_id: 'synthetic', accounts: [{ context: { account_id: 'synthetic', environment: 'synthetic', session_generation: 1 }, unread, remark: `synthetic-${unread}` }] }));
  assert.equal(f.view.data, displayed); assert.equal(f.view.invalidated, false); await f.controller.load(); assert.equal(f.calls.length, 2); assert.ok(f.view.data);
});
