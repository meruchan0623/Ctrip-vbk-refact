import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRecovery, EMPTY_RECOVERY, isRecoveryStatus, recoveryView, type RecoveryState, type RecoveryStatus } from './recovery.ts';
import { UiCommands, UiEvents } from '../../packages/ipc/src/client.ts';
import { installFakeDom } from '../../tests/fake-dom.ts';
const fault: RecoveryStatus = { label: 'main', incarnation: 4, revision: 9, phase: 'manual', attempt: 3 };
function deferred<T>() { let resolve!: (v: T) => void, reject!: (e: unknown) => void; return { promise: new Promise<T>((res, rej) => { resolve = res; reject = rej; }), resolve, reject }; }
function fixture(options: { ready?: Promise<() => void>; noReady?: boolean; timeoutMs?: number } = {}) {
  let state: RecoveryState = { ...EMPTY_RECOVERY }, snapshot: unknown = [], retry: unknown = undefined, listener: ((v: unknown) => void) | null = null, exported: 'opened' | 'saved' | 'cancelled' = 'cancelled', unlistened = 0, diagCalls = 0;
  const calls: { command: string; payload: unknown }[] = [], order: string[] = [];
  const controller = createRecovery({ invoke: async (command, payload) => { calls.push({ command, payload }); order.push(command); const result = await (command === UiCommands.WEBVIEW_RECOVERY_STATUS ? snapshot : retry); if (result instanceof Error) throw result; return result; },
    listenReady: options.noReady ? undefined : async (event, callback) => { assert.equal(event, UiEvents.WEBVIEW_RECOVERY); order.push('listen'); listener = callback; return options.ready ? await options.ready : () => { unlistened++; }; },
    publish: value => { state = value; }, diagnostics: async () => { diagCalls++; return exported; }, ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}) });
  return { controller, calls, order, get state() { return state; }, snapshot: (v: unknown) => { snapshot = v; }, retry: (v: unknown) => { retry = v; }, event: (v: unknown) => listener?.(v), exported: (v: typeof exported) => { exported = v; }, unlistened: () => unlistened, diagnostics: () => diagCalls };
}
async function settle() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
test('handshake installs an awaited listener before initial snapshot; restarting main recovers existing faults', async () => {
  const ready = deferred<() => void>(), f = fixture({ ready: ready.promise }); f.snapshot([fault]); const start = f.controller.connect(); await settle();
  assert.deepEqual(f.order, ['listen']); ready.resolve(() => undefined); await start;
  assert.equal(f.state.connected, true); assert.deepEqual(f.state.rows, [fault]); assert.deepEqual(f.order, ['listen', UiCommands.WEBVIEW_RECOVERY_STATUS]);
});
test('events outrank older in-flight snapshots and healthy tombstones reject stale events and snapshot resurrection', async () => {
  const pending = deferred<unknown>(), f = fixture(); f.snapshot(pending.promise); const start = f.controller.connect(); await settle();
  f.event(fault); pending.resolve([]); await start; assert.deepEqual(f.state.rows, [fault]);
  f.event({ ...fault, phase: 'healthy' }); assert.deepEqual(f.state.rows, []);
  f.event(fault); assert.deepEqual(f.state.rows, []); f.snapshot([fault]); await f.controller.refresh(); assert.deepEqual(f.state.rows, []);
  f.event({ ...fault, revision: 10 }); assert.equal((f.state.rows as readonly RecoveryStatus[])[0]?.revision, 10);
  f.event({ ...fault, incarnation: 3, revision: 999 }); assert.equal((f.state.rows as readonly RecoveryStatus[])[0]?.incarnation, 4);
});
test('manual retry needs explicit confirmation of the exact observed fault, rejects forged targets and ABA', async () => {
  const f = fixture(); f.snapshot([fault]); await f.controller.connect(); const first = f.state.rows[0]!;
  await f.controller.confirmRetry(first); assert.equal(f.calls.filter(c => c.command === UiCommands.WEBVIEW_RECOVERY_RETRY).length, 0);
  f.controller.requestRetry({ ...first, label: 'arbitrary' }); assert.equal(f.state.confirming, null);
  f.controller.requestRetry(first); assert.equal(f.state.confirming, first);
  f.event({ ...fault, revision: 10, phase: 'retrying' }); f.event({ ...fault, revision: 11 }); await f.controller.confirmRetry(first);
  assert.equal(f.calls.filter(c => c.command === UiCommands.WEBVIEW_RECOVERY_RETRY).length, 0);
  const current = f.state.rows[0]!; f.controller.requestRetry(current); f.snapshot([current]); await f.controller.confirmRetry(current);
  assert.deepEqual(f.calls.find(c => c.command === UiCommands.WEBVIEW_RECOVERY_RETRY)?.payload, { label: 'main', incarnation: 4, revision: 11 });
  assert.ok(f.state.notice?.includes('核对')); assert.equal(f.state.pending, null);
});
test('restart-required and reloaded do not offer arbitrary reload or claim content recovery', async () => {
  const f = fixture(); f.snapshot([{ ...fault, phase: 'restart_required' }]); await f.controller.connect(); f.controller.requestRetry(f.state.rows[0]!); assert.equal(f.state.confirming, null);
  const { root } = installFakeDom(); root.appendChild(recoveryView(f.state, f.controller) as any); assert.ok(root.textContent.includes('退出并重新打开应用')); assert.equal(root.textContent.includes('确认重载'), false);
  f.event({ ...fault, revision: 10, phase: 'reloaded' }); root.replaceChildren(recoveryView(f.state, f.controller) as any); assert.ok(root.textContent.includes('核对页面内容')); assert.equal(root.textContent.includes('已恢复正常'), false);
});
test('missing/failed handshake is explicit, pending registrations dispose and timed-out initial status never reports healthy', async () => {
  const noReady = fixture({ noReady: true }); noReady.snapshot([fault]); await noReady.controller.connect(); assert.equal(noReady.state.connected, false); assert.ok(noReady.state.connectionError); assert.deepEqual(noReady.state.rows, [fault]);
  let cleanup = 0; const ready = deferred<() => void>(), closing = fixture({ ready: ready.promise }); const start = closing.controller.connect(); closing.controller.dispose(); ready.resolve(() => { cleanup++; }); await start; assert.equal(cleanup, 1); assert.equal(closing.calls.length, 0);
  const hung = fixture({ timeoutMs: 2 }); hung.snapshot(new Promise(() => {})); await hung.controller.connect(); assert.ok(hung.state.error); assert.equal(hung.state.loading, false); hung.controller.dispose();
});
test('late retry replies after a newer fault cannot clear its confirmation or report success', async () => {
  const f = fixture(), pending = deferred<unknown>(); f.snapshot([fault]); await f.controller.connect(); f.retry(pending.promise);
  const old = f.state.rows[0]!; f.controller.requestRetry(old); const retrying = f.controller.confirmRetry(old); await settle();
  f.event({ ...fault, revision: 10 }); const current = f.state.rows[0]!; f.controller.requestRetry(current);
  pending.reject(new Error('old failure')); await retrying; assert.equal(f.state.confirming, current); assert.equal(f.state.notice, null); assert.equal(f.state.error, null);
});
test('diagnostic export cancellation never reports saved and main/settings wire only their existing permissions', async () => {
  const f = fixture(); await f.controller.diagnostics(); assert.equal(f.state.notice, null); f.exported('saved'); await f.controller.diagnostics(); assert.equal(f.state.notice, '诊断信息已导出。');
  const main = readFileSync(new URL('../main/main.ts', import.meta.url), 'utf8'), settings = readFileSync(new URL('../setting/main.ts', import.meta.url), 'utf8');
  assert.ok(main.includes('void recovery.connect()')); assert.ok(settings.includes('void recovery.connect()'));
  assert.ok(main.includes('UiCommands.SHELL_OPEN_WINDOW, { label: WindowLabels.SETTING }')); assert.equal(main.includes('ShellCommands.EXPORT_DIAGNOSTICS'), false);
  assert.ok(settings.includes('ShellCommands.EXPORT_DIAGNOSTICS')); assert.ok(main.includes('recoveryView(s.recovery, recovery)')); assert.ok(settings.includes('recoveryView(s.recovery, recovery)'));
});
test('status validation rejects unsafe generations, labels, revisions and malformed lists without exposing raw errors', async () => {
  for (const value of [null, { ...fault, incarnation: NaN }, { ...fault, incarnation: -1 }, { ...fault, revision: undefined }, { ...fault, revision: 1.5 }, { ...fault, label: 'https://evil.invalid' }, { ...fault, phase: 'ok' }]) assert.equal(isRecoveryStatus(value), false);
  const f = fixture(); f.snapshot([fault, fault]); await f.controller.connect(); assert.ok(f.state.error); assert.deepEqual(f.state.rows, []);
});
const listenerFault: RecoveryStatus = { ...fault, phase: 'listener_failed', listener_error: { stage: 'subscribe', hresult: -2147467259 } };
test('listener failure is explicit and reenable uses the exact instance without a reload confirmation', async () => {
  const f = fixture(), pending = deferred<unknown>(); f.snapshot([listenerFault]); await f.controller.connect(); f.retry(pending.promise);
  const { root } = installFakeDom(); root.appendChild(recoveryView(f.state, f.controller) as any);
  assert.ok(root.textContent.includes('恢复监控不可用')); assert.ok(root.textContent.includes('重新启用'));
  assert.equal(root.textContent.includes('重载此页面'), false); assert.equal(root.textContent.includes('草稿'), false);
  const current = f.state.rows[0]!; f.controller.requestRetry(current); await settle();
  assert.equal(f.state.confirming, null);
  assert.deepEqual(f.calls.find(c => c.command === UiCommands.WEBVIEW_RECOVERY_RETRY)?.payload, { label: current.label, incarnation: current.incarnation, revision: current.revision });
  f.controller.requestRetry(current); assert.equal(f.calls.filter(c => c.command === UiCommands.WEBVIEW_RECOVERY_RETRY).length, 1);
  pending.resolve(undefined); await settle(); assert.ok(f.state.notice?.includes('查看恢复监控状态')); assert.equal(f.state.notice?.includes('重载'), false);
});
test('late listener retry completion never clears or confirms a newer renderer fault', async () => {
  const f = fixture(), pending = deferred<unknown>(); f.snapshot([listenerFault]); await f.controller.connect(); f.retry(pending.promise);
  f.controller.requestRetry(f.state.rows[0]!); await settle();
  f.event({ ...fault, revision: 20 }); const renderer = f.state.rows[0]!; f.controller.requestRetry(renderer);
  pending.resolve(undefined); await settle(); assert.equal(f.state.confirming, renderer); assert.equal(f.state.notice, null);
  assert.deepEqual(f.state.rows, [{ ...fault, revision: 20 }]);
});
test('listener progress has no reload action and diagnostics remain visible beside a newer crash', async () => {
  const f = fixture(); f.snapshot([{ ...listenerFault, phase: 'listener_retrying' }]); await f.controller.connect();
  const { root } = installFakeDom(); root.appendChild(recoveryView(f.state, f.controller) as any);
  assert.ok(root.textContent.includes('正在重新启用恢复监控')); assert.equal(root.textContent.includes('重载此页面'), false);
  f.event({ ...listenerFault, revision: 20, phase: 'restart_required' }); root.replaceChildren(recoveryView(f.state, f.controller) as any);
  assert.ok(root.textContent.includes('恢复监控不可用')); assert.ok(root.textContent.includes('退出并重新打开应用'));
});
test('listener diagnostic parser accepts only known stages and signed HRESULTs', () => {
  for (const stage of ['dispatch', 'controller', 'subscribe']) assert.equal(isRecoveryStatus({ ...listenerFault, listener_error: { stage, hresult: null } }), true);
  for (const value of [{ ...listenerFault, listener_error: undefined }, { ...listenerFault, listener_error: null }, { ...listenerFault, listener_error: { stage: 'raw error', hresult: -1 } }, { ...listenerFault, listener_error: { stage: 'dispatch', hresult: 2147483648 } }, { ...listenerFault, listener_error: { stage: 'dispatch', hresult: 'secret' } }]) assert.equal(isRecoveryStatus(value), false);
});
