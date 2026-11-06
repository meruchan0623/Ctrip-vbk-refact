import { t } from '../../packages/ui-kit/src/i18n.ts';
import { EMPTY_NOTICE_QUERY } from './notice-query.ts';
import { EMPTY_EVENT_QUERY } from './event-query.ts';
import { EVENT_PICKER_CLOSED } from './events-view.ts';
import { companionPackageCard } from './companion-card.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { createStore, subscribeBatched } from '../../packages/ui-kit/src/store.ts';
import { UiCommands, type UiConversation } from '../../packages/ipc/src/client.ts';
import * as productionPreview from './package-preview.ts';
import * as vm from './viewmodel.ts';
import { guarded, isUiAccountSnapshot } from '../_shared/guards.ts';
const source = readFileSync(process.env['VBK_PACKAGE_MAIN_SOURCE'] ?? new URL('./main.ts', import.meta.url), 'utf8');
const preview: typeof productionPreview = process.env['VBK_PACKAGE_PREVIEW_SOURCE'] ? new Function('UiCommands', 't', stripTypeScriptTypes(readFileSync(process.env['VBK_PACKAGE_PREVIEW_SOURCE'], 'utf8').replace(/^import .*$/gm, '').replace(/^export /gm, '')) + '\nreturn { createPackagePreview, EMPTY_PACKAGE_PREVIEW, packageIdentity, packageOrderId, packageViewApplies, packageInfo, packageFailure };')(UiCommands, t) : productionPreview;
const account = { account_id: 'synthetic-package-account', environment: 'synthetic', session_generation: 1 };
const order = '1234567890123456', gid = 'synthetic-package-room';
const plan = { iccid: '8986000000000000001', plan: 'SYNTHETIC PLAN', status: 'active', remain_pct: 50, remain: '5 GB', total: '10 GB', supplier: 'Synthetic', apn: 'synthetic', fetched_at_ms: 1000, detail_handle: 'synthetic-detail' };
function deferred() { let resolve!: (v: unknown) => void; return { promise: new Promise(r => { resolve = r; }), resolve: (v: unknown) => resolve(v) }; }
async function settle() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
function fixture(wire = false) {
  const conv = { gid, account, assistant_context_revision: 'synthetic-context-1', service_type: 'chat', biz: 'synthetic', order: { order_id: order }, unread_count: 0 } as unknown as UiConversation;
  const store = createStore<Record<string, any>>({ accounts: { active_account_id: account.account_id, accounts: [{ context: account }] }, conversations: [conv], activeGid: gid, messages: { [gid]: [] }, prefs: { assistant: { enabled: true, package_quick_view: true } }, tsimStatus: { logged_in: true, user: 'synthetic', session_epoch: 1 }, pkg: preview.EMPTY_PACKAGE_PREVIEW, pkgOpen: true, now: 1000 });
  const calls: { command: string; payload: any }[] = [];
  let identityResult: unknown = null;
  let result: unknown = { account, gid, order_id: order, query_handle: 'synthetic-query', context_revision: 'synthetic-context-1', session_epoch: 1, total: 2, plans: [plan, { ...plan, detail_handle: 'synthetic-detail-2' }], fetched_at_ms: 1000 };
  const invoke = async (command: string, payload: any) => { calls.push({ command, payload }); const value = await (command === UiCommands.ASSIST_TSIM_STATUS ? identityResult ?? store.get().tsimStatus : result); if (value instanceof Error || value && typeof value === 'object' && 'code' in value) throw value; return value; };
  const controller = preview.createPackagePreview({ current: () => { const s = store.get(), a = s.accounts.accounts.find((x: any) => x.context.account_id === s.accounts.active_account_id), c = s.conversations.find((x: any) => x.gid === s.activeGid); return a && c && s.tsimStatus ? { account: a.context, conversation: c, identity: s.tsimStatus, enabled: !!s.prefs.assistant.enabled && !!s.prefs.assistant.package_quick_view, iccid: vm.findIccids(s.messages[s.activeGid] ?? [])[0] ?? null } : null; }, invoke, publish: pkg => store.patch({ pkg }) });
  const eventHandlers = new Map<string, ((value: unknown) => void)[]>();
  const env: Record<string, any> = { pruneTabAttention: (list: readonly string[]) => list, viewingAccountId: () => null, tsimOrder: { open() {}, openIccid() {} }, closeRuntimeLog() {}, accountNavigation: { project: (snapshot: unknown) => snapshot, pending: () => false }, closeCommerce() {}, noticeQuery: { reset() {} }, companionPackageCard, ...vm, ...preview, UiCommands, PKG_IDLE: preview.EMPTY_PACKAGE_PREVIEW, autoQueryPackage: () => actual('autoQueryPackage')(), Events: { ACCOUNT_CHANGED: 'account://changed' }, guarded, isUiAccountSnapshot, peripheral: { close() {} }, receiveDiagnostics: { close() {} }, unknownOutbound: { close() {} }, loadForActiveAccount: async () => {}, WindowLabels: { SETTING: 'setting' }, packagePreview: controller, store, S: () => store.get(), ipc: { invoke, listen: (event: string, callback: (value: unknown) => void) => eventHandlers.set(event, [...eventHandlers.get(event) ?? [], callback]) }, invokeSafe: invoke, t, h: (tag: string, props: object | null, ...children: unknown[]) => ({ tag, props: props ?? {}, children }), icon: () => null, IC: {}, cx: () => '', toast() {} };
  function actual(name: string): (...args: any[]) => any { const a = source.search(new RegExp('(?:async )?function ' + name + '\\(')); assert.ok(a >= 0, name); const tail = source.slice(a), next = /\n(?:(?:async )?function |(?:let|const) [A-Za-z])/.exec(tail); assert.ok(next, name); return new Function(...Object.keys(env), stripTypeScriptTypes(tail.slice(0, next.index)) + '\nreturn ' + name + ';')(...Object.values(env)); }
  const resetStart = source.indexOf('const ACCOUNT_SCOPED_RESET ='), resetEnd = source.indexOf('} as const satisfies Partial<MainState>;', resetStart) + '} as const satisfies Partial<MainState>;'.length;
  env['eventQuery'] = { reset() {} };
  env['ACCOUNT_SCOPED_RESET'] = new Function('TRANSLATION_IDLE', 'PKG_IDLE', 'EMPTY_NOTICE_QUERY', 'EMPTY_EVENT_QUERY', 'EVENT_PICKER_CLOSED', stripTypeScriptTypes(source.slice(resetStart, resetEnd)) + '\nreturn ACCOUNT_SCOPED_RESET;')(vm.TRANSLATION_IDLE, preview.EMPTY_PACKAGE_PREVIEW, EMPTY_NOTICE_QUERY, EMPTY_EVENT_QUERY, EVENT_PICKER_CLOSED);
  for (const name of ['activeAccount', 'activeConv', 'stillActive', 'applyAccountSnapshot', 'packageEnabled', 'packageContext', 'queryPackage', 'openTsimSettings', 'receivePackageIdentity', 'refreshPackageIdentity', 'refreshPackages']) if (source.includes(`function ${name}(`)) env[name] = actual(name);
  if (wire) { const statement = 'subscribeBatched(store, () => autoQueryPackage());', a = source.indexOf(statement); assert.ok(a >= 0); new Function('store', 'subscribeBatched', 'autoQueryPackage', stripTypeScriptTypes(source.slice(a, a + statement.length)))(store, subscribeBatched, env['autoQueryPackage']); for (const line of source.matchAll(/^ipc.listen<unknown>\(Events.ACCOUNT_CHANGED,.*\);$/gm)) new Function(...Object.keys(env), stripTypeScriptTypes(line[0]))(...Object.values(env)); }
  return { store, controller, calls, actual, auto: () => actual('autoQueryPackage')(), event: (name: string, payload: unknown) => eventHandlers.get(name)?.forEach(callback => callback(payload)), result: (v: unknown) => { result = v; }, identity: (value: unknown) => { identityResult = value; } };
}
function nodes(tree: any): any[] { if (Array.isArray(tree)) return tree.flatMap(nodes); return tree && typeof tree === 'object' ? [tree, ...nodes(tree.children)] : []; }

test('actual autoQueryPackage prefers the complete conversation order and repeated same-order broadcasts do not refetch', async () => {
  const f = fixture(); f.auto(); await settle(); assert.equal(f.calls.length, 1); assert.equal(f.calls[0]?.command, UiCommands.ASSIST_ORDER_SUMMARY); assert.deepEqual(f.calls[0]?.payload, { account, gid, order_id: order, context_revision: 'synthetic-context-1', session_epoch: 1 });
  for (let i = 0; i < 5; i++) { f.store.patch({ conversations: [{ ...f.store.get().conversations[0] }] }); f.auto(); } await settle(); assert.equal(f.calls.length, 1); assert.equal(f.store.get().pkg.summary?.plans.length, 2);
});

test('actual package response success and failure cannot cross account, room, order or TSim epoch', async () => {
  for (const field of ['account_id', 'environment', 'session_generation', 'gid', 'order', 'session_epoch']) for (const result of [new Error('SYNTHETIC FAILURE'), { account, gid, order_id: order, query_handle: 'synthetic-query', context_revision: 'synthetic-context-1', session_epoch: 1, total: 1, plans: [plan], fetched_at_ms: 1000 }]) {
    const f = fixture(), pending = deferred(); f.result(pending.promise); f.auto();
    if (field === 'gid') f.store.patch({ activeGid: 'synthetic-other-room' });
    else if (field === 'order') f.store.patch({ conversations: [{ ...f.store.get().conversations[0], order: { order_id: '1234567890' } }] });
    else if (field === 'session_epoch') f.store.patch({ tsimStatus: { logged_in: true, user: 'synthetic', session_epoch: 2 } });
    else f.store.patch({ accounts: { active_account_id: field === 'account_id' ? 'synthetic-other' : account.account_id, accounts: [{ context: { ...account, [field]: field === 'session_generation' ? 2 : 'synthetic-other' } }] } });
    const current = f.store.get().pkg; pending.resolve(result); await settle(); assert.equal(f.store.get().pkg, current, field);
  }
});

test('actual package login status event clears old data and resumes the order query after login', async () => {
  const f = fixture(); f.store.patch({ tsimStatus: { logged_in: false, user: null, session_epoch: 1 } }); f.auto(); await settle(); assert.equal(f.calls.length, 0); assert.equal(f.store.get().pkg.failure, 'login');
  f.result({ account, gid, order_id: order, query_handle: 'synthetic-query', context_revision: 'synthetic-context-1', session_epoch: 2, total: 1, plans: [plan], fetched_at_ms: 1000 });
  f.actual('receivePackageIdentity')({ logged_in: true, user: 'synthetic', session_epoch: 2 }); f.auto(); await settle(); assert.equal(f.calls.length, 1); assert.equal(f.store.get().pkg.summary?.session_epoch, 2);
});

test('ICCID fallback uses the original ICCID command and a stale plan button cannot open another order', async () => {
  const f = fixture(); f.auto(); await settle(); const view = f.store.get().pkg, selected = view.summary.plans[0];
  f.store.patch({ conversations: [{ ...f.store.get().conversations[0], order: null }], messages: { [gid]: [{ kind: 'text', text: plan.iccid }] } });
  await f.controller.openDetail(view, selected); assert.equal(f.calls.length, 1);
  f.result(plan); f.auto(); await settle(); assert.equal(f.calls[1]?.command, UiCommands.ASSIST_PACKAGE); assert.deepEqual(f.calls[1]?.payload, { iccid: plan.iccid }); assert.equal(f.store.get().pkg.info?.iccid, plan.iccid);
});

test('actual same-gid service/customer revision changes hide old cards immediately, invalidate old buttons and query once', async () => {
  const f = fixture(); f.auto(); await settle(); const original = f.store.get().pkg;
  const card = f.actual('packageCard'), tree = card(f.store.get(), f.store.get().conversations[0]);
  const oldRefresh = nodes(tree).find(n => n.props?.dataset?.packageAction === 'refresh').props.onclick;
  const next = { ...f.store.get().conversations[0], assistant_context_revision: 'synthetic-context-2' }; f.store.patch({ conversations: [next] });
  const hidden = card(f.store.get(), next); assert.equal(JSON.stringify(hidden).includes('SYNTHETIC PLAN'), false); oldRefresh(); await settle(); assert.equal(f.calls.length, 1);
  f.result({ account, gid, order_id: order, context_revision: 'synthetic-context-2', query_handle: 'synthetic-query-2', session_epoch: 1, total: 1, plans: [plan], fetched_at_ms: 1000 }); f.auto(); await settle();
  assert.notEqual(f.store.get().pkg, original); assert.equal(f.store.get().pkg.summary.context_revision, 'synthetic-context-2'); assert.equal(f.calls.length, 2); assert.equal(f.calls[1]?.payload.context_revision, 'synthetic-context-2');
  f.auto(); await settle(); assert.equal(f.calls.length, 2);
});

test('actual in-flight revision replacement rejects old success/error and missing identity never guesses a scope', async () => {
  for (const result of [new Error('SYNTHETIC PRIVATE ERROR'), { account, gid, order_id: order, context_revision: 'synthetic-context-1', query_handle: 'synthetic-old', session_epoch: 1, total: 1, plans: [plan], fetched_at_ms: 1000 }]) {
    const f = fixture(), pending = deferred(); f.result(pending.promise); f.auto(); const busy = f.store.get().pkg;
    f.store.patch({ conversations: [{ ...f.store.get().conversations[0], assistant_context_revision: 'synthetic-context-2' }] }); pending.resolve(result); await settle(); assert.equal(f.store.get().pkg, busy);
  }
  const f = fixture(); f.store.patch({ conversations: [{ ...f.store.get().conversations[0], assistant_context_revision: undefined }] }); f.auto(); await settle(); assert.equal(f.calls.length, 0); assert.ok(f.store.get().pkg.error.includes('身份尚未核验'));
});

test('package card omits detail action and keeps the native settings login', async () => {
  const f = fixture(); f.auto(); await settle(); let tree = f.actual('packageCard')(f.store.get(), f.store.get().conversations[0]);
  assert.equal(nodes(tree).filter(n => n.props?.dataset?.packageAction === 'detail').length, 0);
  f.actual('receivePackageIdentity')({ logged_in: false, user: null, session_epoch: 2 }); await settle(); tree = f.actual('packageCard')(f.store.get(), f.store.get().conversations[0]);
  nodes(tree).find(n => n.props?.dataset?.packageAction === 'login').props.onclick(); await settle(); assert.equal(f.calls[1]?.command, UiCommands.SHELL_OPEN_WINDOW); assert.deepEqual(f.calls[1]?.payload, { label: 'setting', section: 'assistant' });
});

test('query errors do not auto-retry on broadcasts; a current explicit refresh starts exactly one fresh request', async () => {
  const f = fixture(); f.result({ code: 'assistant.forbidden', message: 'SYNTHETIC_PRIVATE_ERROR' }); f.auto(); await settle();
  assert.equal(f.store.get().pkg.failure, 'permission'); for (let i = 0; i < 4; i++) f.auto(); await settle(); assert.equal(f.calls.length, 1); assert.equal(JSON.stringify(f.store.get().pkg).includes('PRIVATE_ERROR'), false);
  const tree = f.actual('packageCard')(f.store.get(), f.store.get().conversations[0]); nodes(tree).find(n => n.props?.dataset?.packageAction === 'retry').props.onclick(); await settle(); assert.equal(f.calls.filter(c => c.command === UiCommands.ASSIST_ORDER_SUMMARY).length, 2); assert.equal(f.calls.filter(c => c.command === UiCommands.ASSIST_TSIM_STATUS).length, 1);
});

test('actual explicit ICCID selection remains selected across automatic broadcasts and manual refresh', async () => {
  const f = fixture(), second = '8986000000000000002';
  f.store.patch({ conversations: [{ ...f.store.get().conversations[0], order: null }], messages: { [gid]: [{ kind: 'text', text: `${plan.iccid} ${second}` }] } });
  f.result({ ...plan, iccid: second }); await f.actual('queryPackage')(second); f.auto(); await settle();
  assert.equal(f.calls.length, 1); assert.equal(f.store.get().pkg.info.iccid, second); await f.actual('refreshPackages')(); assert.equal(f.calls.length, 3); assert.equal(f.calls[2]?.payload.iccid, second);
});

test('unknown order usage stays null and renders pending detail text without invented percentages', async () => {
  const f = fixture(); f.result({ account, gid, order_id: order, context_revision: 'synthetic-context-1', query_handle: 'synthetic-query', session_epoch: 1, total: 1, plans: [{ ...plan, remain_pct: null, remain: '', total: '' }], fetched_at_ms: 1000 });
  f.auto(); await settle(); assert.equal(f.store.get().pkg.summary.plans[0].remain_pct, null);
  const tree = f.actual('packageCard')(f.store.get(), f.store.get().conversations[0]); const content = JSON.stringify(nodes(tree).filter(n => n.tag !== 'style').map(n => ({ props: n.props, text: n.children?.filter((x: unknown) => typeof x === 'string') }))); assert.ok(content.includes('用量待查询')); assert.equal(content.includes('0%'), false); assert.equal(content.includes('100%'), false);
});

test('actual manual refresh detects a missed same-user identity epoch event and issues only one new order query', async () => {
  const f = fixture(); f.auto(); await settle(); f.identity({ logged_in: true, user: 'synthetic', session_epoch: 2 });
  f.result({ account, gid, order_id: order, context_revision: 'synthetic-context-1', query_handle: 'synthetic-new-query', session_epoch: 2, total: 1, plans: [plan], fetched_at_ms: 1000 });
  await f.actual('refreshPackages')(); await settle(); assert.equal(f.store.get().pkg.summary.session_epoch, 2);
  assert.equal(f.calls.filter(c => c.command === UiCommands.ASSIST_TSIM_STATUS).length, 1); assert.equal(f.calls.filter(c => c.command === UiCommands.ASSIST_ORDER_SUMMARY).length, 2);
});

test('actual main subscription starts an order query when a conversation gains an order and ignores repeated broadcasts', async () => {
  const f = fixture(true), conversation = f.store.get().conversations[0];
  f.store.patch({ conversations: [{ ...conversation, order: null }] }); await settle(); assert.equal(f.calls.length, 0);
  f.store.patch({ conversations: [{ ...conversation }] }); await settle(); assert.equal(f.calls.filter(c => c.command === UiCommands.ASSIST_ORDER_SUMMARY).length, 1);
  for (let i = 0; i < 5; i++) { f.store.patch({ conversations: [{ ...conversation, unread_count: i }] }); await settle(); }
  assert.equal(f.calls.filter(c => c.command === UiCommands.ASSIST_ORDER_SUMMARY).length, 1); assert.equal(f.store.get().pkg.summary.order_id, order);
});

test('actual account listener plus subscription preserves package cache on unread/remark/profile broadcasts', async () => {
  const f = fixture(true); f.store.patch({ now: 1001 }); await settle(); const cached = f.store.get().pkg;
  for (let unread = 1; unread < 4; unread++) {
    f.event('account://changed', { active_account_id: account.account_id, max_accounts: 16, accounts: [{ context: account, nick: 'synthetic', remark: `synthetic-${unread}`, party: 'synthetic', color: '#aaa', state: 'online', unread, self_profile: { uid: 'synthetic', name: `Synthetic ${unread}`, avatar: null } }] }); await settle();
    assert.equal(f.store.get().pkg, cached); assert.equal(f.calls.filter(c => c.command === UiCommands.ASSIST_ORDER_SUMMARY).length, 1);
  }
});

test('actual detached ICCID highlight never redirects its captured message into a later package scope', async () => {
  for (const change of ['account_id', 'environment', 'session_generation', 'gid', 'revision', 'epoch', 'source', 'current']) {
    const f = fixture(), conversation = { ...f.store.get().conversations[0], order: null };
    const messages = [{ kind: 'text', text: plan.iccid }]; f.store.patch({ conversations: [conversation], messages: { [gid]: messages } }); f.result(plan);
    const old = nodes(f.actual('richText')(plan.iccid)).find(n => n.props?.dataset?.hl === 'iccid').props.onclick;
    if (change === 'gid') f.store.patch({ activeGid: 'synthetic-next', conversations: [{ ...conversation, gid: 'synthetic-next' }], messages: { 'synthetic-next': [] } });
    else if (change === 'revision') f.store.patch({ conversations: [{ ...conversation, assistant_context_revision: 'synthetic-context-2' }] });
    else if (change === 'epoch') f.store.patch({ tsimStatus: { logged_in: true, user: 'synthetic', session_epoch: 2 } });
    else if (change === 'source') f.store.patch({ messages: { [gid]: [{ ...messages[0] }] } });
    else if (change !== 'current') f.store.patch({ accounts: { active_account_id: change === 'account_id' ? 'synthetic-next' : account.account_id, accounts: [{ context: { ...account, [change]: change === 'session_generation' ? 2 : 'synthetic-next' } }] } });
    old(); await settle(); assert.equal(f.calls.filter(c => c.command === UiCommands.ASSIST_PACKAGE).length, change === 'current' ? 1 : 0, change);
    if (change !== 'current') assert.equal(f.store.get().pkg.info, null, change);
  }
});

test('actual account listener still clears cached and pending package state on real owner or active-account changes', async () => {
  for (const field of ['account_id', 'environment', 'session_generation', 'active_none']) {
    const f = fixture(true), pending = deferred(); f.result(pending.promise); f.store.patch({ now: 1001 }); await settle(); assert.equal(f.calls.length, 1);
    const context = field === 'active_none' ? account : { ...account, [field]: field === 'session_generation' ? 2 : 'synthetic-next' };
    f.event('account://changed', { active_account_id: field === 'active_none' ? null : context.account_id, max_accounts: 16, accounts: [{ context, nick: 'synthetic', remark: null, party: 'synthetic', color: '#aaa', state: 'online', unread: 0 }] }); await settle();
    assert.equal(f.store.get().pkg.status, 'idle', field); pending.resolve({ account, gid, order_id: order, context_revision: 'synthetic-context-1', query_handle: 'synthetic-old', session_epoch: 1, total: 1, plans: [plan], fetched_at_ms: 1000 }); await settle(); assert.equal(f.store.get().pkg.status, 'idle', field); assert.equal(f.store.get().pkg.summary, null);
  }
});

test('order summary validates the reissue timeline and keeps only well-formed order_time/reissues', async () => {
  const ready = { create_time_ms: 1_700_000_000_000, state: 'ready', info: { ...plan, plan: 'REISSUE' } }, failed = { create_time_ms: null, state: 'error', info: null };
  async function summaryWith(extra: Record<string, unknown>) {
    const f = fixture(); f.result({ account, gid, order_id: order, query_handle: 'synthetic-query', context_revision: 'synthetic-context-1', session_epoch: 1, total: 1, plans: [{ ...plan, ...extra }], fetched_at_ms: 1000 });
    f.auto(); await settle(); return f.store.get().pkg;
  }
  const good = await summaryWith({ order_time: '2026-10-28 09:30:00', reissues: [ready, failed] });
  assert.equal(good.status, 'done'); const first = good.summary.plans[0];
  assert.equal(first.order_time, '2026-10-28 09:30:00'); assert.deepEqual(first.reissues.map((r: any) => r.state), ['ready', 'error']); assert.equal(first.reissues[0].info.plan, 'REISSUE'); assert.equal(first.reissues[1].info, null);
  assert.equal((await summaryWith({ reissues: [] })).summary.plans[0].reissues, undefined);
  for (const extra of [
    { order_time: 7 }, { order_time: 'x'.repeat(65) }, { reissues: 'nope' }, { reissues: Array(11).fill(failed) },
    { reissues: [{ ...failed, info: plan }] }, { reissues: [{ ...ready, info: null }] }, { reissues: [{ ...ready, info: { ...plan, detail_fields: [{ label: 'IMSI', value: 'x' }] } }] },
    { reissues: [{ ...ready, state: 'pending' }] }, { reissues: [{ ...ready, create_time_ms: '1' }] }, { reissues: [{ ...ready, create_time_ms: -1 }] }, { reissues: [null] },
  ]) assert.equal((await summaryWith(extra)).status, 'error', JSON.stringify(extra).slice(0, 80));
});

test('package failure copy preserves every original message and does not expose diagnostic text', () => {
  const cases = [
    ['assistant.tsim_unauthenticated', 'login', '请先在设置的“商家助手 · TSim 登录”中登录，再刷新套餐。'],
    ['assistant.session_cleared', 'login', '请先在设置的“商家助手 · TSim 登录”中登录，再刷新套餐。'],
    ['assistant.forbidden', 'permission', '当前 TSim 账号无权查看该订单套餐，请核对账号权限。'],
    ['assistant.permission_denied', 'permission', '当前 TSim 账号无权查看该订单套餐，请核对账号权限。'],
    ['assistant.package_not_found', 'error', '未查询到该订单的套餐，请核对会话订单号。'],
    ['net.timeout', 'error', '查询超时，请手动刷新；不会自动重复请求。'],
    ['unknown', 'error', '套餐查询未完成，可能是会话、订单或 TSim 身份已变化。请核对后刷新。'],
  ] as const;
  for (const [code, failure, error] of cases) assert.deepEqual(preview.packageFailure({ code, message: 'SYNTHETIC_PRIVATE_DIAGNOSTIC' }), { failure, error });
});
