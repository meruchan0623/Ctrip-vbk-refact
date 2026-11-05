import { t } from '../../packages/ui-kit/src/i18n.ts';
import { UiCommands, UiEvents } from '../../packages/ipc/src/client.ts';
import { h } from '../../packages/ui-kit/src/h.ts';
export interface RecoveryStatus { readonly label: string; readonly incarnation: number; readonly revision: number; readonly phase: 'healthy' | 'retrying' | 'manual' | 'reloaded' | 'restart_required' | 'listener_failed' | 'listener_retrying'; readonly attempt: number; readonly listener_error?: { readonly stage: 'dispatch' | 'controller' | 'subscribe'; readonly hresult: number | null } }
export interface RecoveryState {
  readonly rows: readonly RecoveryStatus[];
  readonly loading: boolean;
  readonly connected: boolean;
  readonly connectionError: string | null;
  readonly error: string | null;
  readonly confirming: RecoveryStatus | null;
  readonly pending: string | null;
  readonly exporting: boolean;
  readonly notice: string | null;
}
export const EMPTY_RECOVERY: RecoveryState = { rows: [], loading: false, connected: false, connectionError: null, error: null, confirming: null, pending: null, exporting: false, notice: null };
export function isRecoveryStatus(value: unknown): value is RecoveryStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Partial<RecoveryStatus>;
  const error = v.listener_error;
  const validError = error === undefined || (!!error && typeof error === 'object' && !Array.isArray(error) && ['dispatch', 'controller', 'subscribe'].includes(error.stage) && (error.hresult === null || (Number.isInteger(error.hresult) && error.hresult >= -2147483648 && error.hresult <= 2147483647)));
  return validError && (v.phase !== 'listener_failed' || error !== undefined) && typeof v.label === 'string' && /^[A-Za-z0-9_.-]{1,160}$/.test(v.label) && Number.isSafeInteger(v.incarnation) && (v.incarnation ?? -1) >= 0 && Number.isSafeInteger(v.revision) && (v.revision ?? -1) >= 0 && Number.isSafeInteger(v.attempt) && (v.attempt ?? -1) >= 0 && ['healthy', 'retrying', 'manual', 'reloaded', 'restart_required', 'listener_failed', 'listener_retrying'].includes(v.phase ?? '');
}
const equal = (a: RecoveryStatus, b: RecoveryStatus) => a.label === b.label && a.incarnation === b.incarnation && a.revision === b.revision && a.phase === b.phase && a.attempt === b.attempt && a.listener_error?.stage === b.listener_error?.stage && a.listener_error?.hresult === b.listener_error?.hresult;
export function createRecovery(deps: {
  invoke(command: string, payload?: unknown): Promise<unknown>;
  listenReady: ((event: string, callback: (payload: unknown) => void) => Promise<() => void>) | undefined;
  publish(state: RecoveryState): void;
  diagnostics(): Promise<'opened' | 'saved' | 'cancelled'>;
  timeoutMs?: number;
}) {
  let state: RecoveryState = { ...EMPTY_RECOVERY }, disposed = false, connection = 0, read = 0, mutation = 0, revision = 0, exporting = 0;
  let stop: (() => void) | null = null;
  function deadline<T>(promise: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('recovery response timeout')), deps.timeoutMs ?? 10000);
      promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
    });
  }
  const changes = new Map<string, number>(), dismissed = new Set<string>();
  const key = (row: RecoveryStatus) => JSON.stringify([row.label, row.incarnation, row.revision, row.phase, row.attempt]);
  const rows = new Map<string, RecoveryStatus>(), observed = new Map<string, RecoveryStatus>();
  function publish(patch: Partial<RecoveryState>) { if (!disposed) { state = { ...state, ...patch }; deps.publish(state); } }
  function invalidate(label: string) {
    if (state.confirming?.label === label) publish({ confirming: null });
    if (state.pending === label) { mutation++; publish({ pending: null }); }
  }
  function viewRows() { return [...rows.values()].filter(row => !dismissed.has(key(row))).sort((a, b) => a.label.localeCompare(b.label)); }
  function receive(value: unknown) {
    if (disposed || !isRecoveryStatus(value)) return;
    const prior = observed.get(value.label);
    if (prior && (value.incarnation < prior.incarnation || (value.incarnation === prior.incarnation && value.revision < prior.revision))) return;
    if (prior?.phase === 'healthy' && value.incarnation === prior.incarnation && value.revision === prior.revision && value.phase !== 'healthy') return;
    if (!rows.has(value.label) && rows.size >= 256 && value.phase !== 'healthy') return;
    observed.set(value.label, { ...value });
    // Every event is a new fault observation, including a round trip to identical wire values.
    changes.set(value.label, ++revision); dismissed.delete(key(value)); invalidate(value.label);
    if (value.phase === 'healthy') rows.delete(value.label); else rows.set(value.label, { ...value }); publish({ rows: viewRows(), notice: null });
  }
  async function refresh() {
    if (disposed) return;
    const ticket = ++read, started = revision;
    publish({ loading: true, error: null });
    try {
      const result = await deadline(deps.invoke(UiCommands.WEBVIEW_RECOVERY_STATUS));
      if (disposed || ticket !== read) return;
      if (!Array.isArray(result) || result.length > 256 || result.some(value => !isRecoveryStatus(value) || value.phase === 'healthy') || new Set(result.map(value => value.label)).size !== result.length) throw new Error('invalid recovery status');
      const returned = new Set<string>();
      for (const value of result as RecoveryStatus[]) {
        returned.add(value.label);
        if ((changes.get(value.label) ?? 0) > started) continue;
        const prior = rows.get(value.label), seen = observed.get(value.label);
        if (seen && (value.incarnation < seen.incarnation || (value.incarnation === seen.incarnation && (value.revision < seen.revision || (seen.phase === 'healthy' && value.revision === seen.revision))))) continue;
        if (prior && (value.incarnation < prior.incarnation || (value.incarnation === prior.incarnation && value.revision < prior.revision))) continue;
        if (!prior || !equal(prior, value)) { invalidate(value.label); rows.set(value.label, { ...value }); observed.set(value.label, { ...value }); }
      }
      for (const label of rows.keys()) if (!returned.has(label) && (changes.get(label) ?? 0) <= started) { invalidate(label); rows.delete(label); }
      publish({ rows: viewRows(), loading: false });
    } catch { if (!disposed && ticket === read) publish({ loading: false, error: t('recoveryRuntime.readFailed') }); }
  }
  async function connect() {
    if (disposed) return;
    const ticket = ++connection;
    stop?.(); stop = null; publish({ connected: false, connectionError: null });
    let expired = false;
    try {
      if (!deps.listenReady) throw new Error('recovery handshake unavailable');
      const unlisten = await deadline(deps.listenReady(UiEvents.WEBVIEW_RECOVERY, payload => { if (!disposed && ticket === connection) receive(payload); }).then(unlisten => {
        if (expired || disposed || ticket !== connection) { unlisten(); return () => undefined; }
        return unlisten;
      }));
      if (disposed || ticket !== connection) { unlisten(); return; }
      stop = unlisten; publish({ connected: true });
    } catch {
      expired = true;
      if (disposed || ticket !== connection) return;
      publish({ connectionError: t('recoveryRuntime.disconnected') });
    }
    if (!disposed && ticket === connection) await refresh();
  }
  function requestRetry(row: RecoveryStatus) {
    if (disposed || rows.get(row.label) !== row || !['manual', 'listener_failed'].includes(row.phase) || state.pending) return;
    publish({ confirming: row, error: null, notice: null });
    if (row.phase === 'listener_failed') void confirmRetry(row);
  }
  async function confirmRetry(row: RecoveryStatus) {
    if (disposed || state.confirming !== row || rows.get(row.label) !== row || !['manual', 'listener_failed'].includes(row.phase) || state.pending) return;
    const ticket = ++mutation; publish({ confirming: null, pending: row.label, error: null, notice: null });
    try {
      await deadline(deps.invoke(UiCommands.WEBVIEW_RECOVERY_RETRY, { label: row.label, incarnation: row.incarnation, revision: row.revision }));
      if (disposed || ticket !== mutation || rows.get(row.label) !== row) return;
      publish({ pending: null, notice: row.phase === 'listener_failed' ? t('recoveryRuntime.listenerRequested') : t('recoveryRuntime.reloadRequested') }); await refresh();
    } catch {
      if (!disposed && ticket === mutation && rows.get(row.label) === row) publish({ pending: null, error: row.phase === 'listener_failed' ? t('recoveryRuntime.listenerUnconfirmed') : t('recoveryRuntime.reloadUnconfirmed') });
    }
  }
  async function diagnostics() {
    if (disposed || state.exporting) return;
    const ticket = ++exporting; publish({ exporting: true, error: null, notice: null });
    try {
      const result = await deps.diagnostics();
      if (!disposed && ticket === exporting) publish({ notice: result === 'saved' ? t('recoveryRuntime.diagnosticsSaved') : result === 'opened' ? t('recoveryRuntime.diagnosticsOpened') : null });
    } catch { if (!disposed && ticket === exporting) publish({ error: t('recoveryRuntime.diagnosticsFailed') }); }
    finally { if (!disposed && ticket === exporting) publish({ exporting: false }); }
  }
  return { connect, refresh, receive, requestRetry, confirmRetry, diagnostics,
    cancelRetry() { publish({ confirming: null }); },
    dismiss(row: RecoveryStatus) { if (rows.get(row.label) === row && row.phase === 'reloaded') { dismissed.add(key(row)); publish({ rows: viewRows() }); } },
    dispose() { if (disposed) return; disposed = true; ++connection; ++read; ++mutation; ++exporting; stop?.(); stop = null; rows.clear(); observed.clear(); changes.clear(); dismissed.clear(); },
  };
}
function recoveryLabel(value: string): string {
  return ({ main: t('recoveryRuntime.main'), setting: t('recoveryRuntime.setting'), alarm: t('recoveryRuntime.alarm'), update: t('recoveryRuntime.update'), 'package-detail': t('recoveryRuntime.packageDetail') } as Record<string, string>)[value] ?? (value.startsWith('login') ? t('recoveryRuntime.login') : t('recoveryRuntime.business'));
}
export function recoveryRowText(row: RecoveryStatus): string {
  const message = row.phase === 'listener_failed' ? t('recoveryRuntime.listenerFailed') : row.phase === 'listener_retrying' ? t('recoveryRuntime.listenerRetrying') : row.phase === 'manual' ? t('recoveryRuntime.manual') : row.phase === 'restart_required' ? t('recoveryRuntime.restartRequired') : row.phase === 'retrying' ? t('recoveryRuntime.retrying', { attempt: row.attempt }) : t('recoveryRuntime.reloaded');
  return t('recoveryRuntime.row', { label: recoveryLabel(row.label), message });
}
export function recoveryView(state: RecoveryState | undefined, controller: ReturnType<typeof createRecovery>): HTMLElement | null {
  if (!state || (!state.rows.length && !state.error && !state.connectionError && !state.notice)) return null;
  return h('aside', { class: 'recovery-panel', 'aria-label': t('recoveryRuntime.label'), dataset: { recoveryPanel: '1' } },
    state.rows.map(row => h('div', { class: 'recovery-row', dataset: { key: `${row.label}:${row.incarnation}:${row.revision}` } },
      h('span', { class: 'recovery-message', role: row.phase === 'manual' || row.phase === 'restart_required' || row.phase === 'listener_failed' ? 'alert' : 'status' }, recoveryRowText(row)),
      row.listener_error && !['listener_failed', 'listener_retrying'].includes(row.phase) ? h('span', { role: 'alert' }, t('recoveryRuntime.listenerFailed')) : null,
      row.phase === 'manual' || row.phase === 'listener_failed' ? h('button', { class: 'btn sm', type: 'button', disabled: !!state.pending, dataset: { fid: `recovery-retry-${row.label}` }, onclick: () => controller.requestRetry(row) }, state.pending === row.label ? t('recoveryRuntime.requesting') : row.phase === 'listener_failed' ? t('recoveryRuntime.enableListener') : t('recoveryRuntime.reload')) : null,
      row.phase === 'reloaded' ? h('button', { class: 'btn sm', type: 'button', 'aria-label': t('recoveryRuntime.dismissLabel'), onclick: () => controller.dismiss(row) }, t('recoveryRuntime.dismiss')) : null)),
    state.confirming ? h('div', { class: 'recovery-confirm', role: 'alert' },
      h('span', null, t('recoveryRuntime.warning', { label: recoveryLabel(state.confirming.label) })),
      h('button', { class: 'btn sm', type: 'button', dataset: { fid: 'recovery-confirm' }, onclick: () => void controller.confirmRetry(state.confirming!) }, t('recoveryRuntime.confirm')),
      h('button', { class: 'btn sm', type: 'button', onclick: controller.cancelRetry }, t('recoveryRuntime.cancel'))) : null,
    state.connectionError ? h('p', { role: 'alert' }, state.connectionError) : null,
    state.error ? h('p', { role: 'alert' }, state.error) : null,
    state.notice ? h('p', { role: 'status' }, state.notice) : null,
    h('div', { class: 'recovery-actions' },
      h('button', { class: 'btn sm', type: 'button', disabled: state.loading, dataset: { fid: 'recovery-refresh' }, onclick: () => void controller.refresh() }, state.loading ? t('recoveryRuntime.reading') : t('recoveryRuntime.refresh')),
      state.connectionError ? h('button', { class: 'btn sm', type: 'button', onclick: () => void controller.connect() }, t('recoveryRuntime.reconnect')) : null,
      h('button', { class: 'btn sm', type: 'button', disabled: state.exporting, dataset: { fid: 'recovery-diagnostics' }, onclick: () => void controller.diagnostics() }, state.exporting ? t('recoveryRuntime.opening') : t('recoveryRuntime.diagnostics'))));
}
