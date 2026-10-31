import { UiCommands, type UiPackageDetail, type UiPackageField, type UiTsimStatus } from '../../packages/ipc/src/client.ts';
import { packageFailure, packageInfo } from '../main/package-preview.ts';
export interface DetailView { readonly busy: boolean; readonly data: UiPackageDetail | null; readonly error: string | null; readonly invalidated: boolean }
function fields(value: unknown): UiPackageField[] | null {
  if (!Array.isArray(value)) return null;
  const result: UiPackageField[] = [];
  for (const item of value) { if (!item || typeof item !== 'object' || typeof item.label !== 'string' || typeof item.value !== 'string') return null; result.push({ label: item.label, value: item.value }); }
  return result;
}
function detailProjection(value: unknown): UiPackageDetail | null {
  if (!value || typeof value !== 'object') return null;
  const d = value as UiPackageDetail, plan = packageInfo(d.plan, true), detail_fields = fields(d.detail_fields), live_fields = fields(d.live_fields);
  if (!plan || !detail_fields || !live_fields || typeof d.order_id !== 'string' || !/^(?:\d{10}|\d{16})$/.test(d.order_id) || !Number.isSafeInteger(d.session_epoch) || d.session_epoch < 0 || !Number.isFinite(d.fetched_at_ms) || !Array.isArray(d.cdrs)) return null;
  const cdrs: UiPackageField[][] = [];
  for (const cdr of d.cdrs) { const row = fields(cdr); if (!row) return null; cdrs.push(row); }
  return { order_id: d.order_id, session_epoch: d.session_epoch, plan, detail_fields, live_fields, cdrs, fetched_at_ms: d.fetched_at_ms };
}

/** The host owns the immutable card binding; this page only reads it, never accepts card IDs or URLs. */
export function createPackageDetail(deps: { invoke(command: string, payload: object): Promise<unknown>; publish(view: DetailView): void }) {
  let sequence = 0, epoch: number | null = null;
  let view: DetailView = { busy: false, data: null, error: null, invalidated: false };
  function publish(next: DetailView) { view = next; deps.publish(next); }
  function invalidate(message = '查看范围已变化，请返回当前会话重新打开套餐详情。') { sequence++; publish({ busy: false, data: null, error: message, invalidated: true }); }
  function identity(status: UiTsimStatus) {
    if (!Number.isSafeInteger(status.session_epoch) || status.session_epoch < 0 || !status.logged_in || epoch !== null && epoch !== status.session_epoch) invalidate('TSim 登录身份已变化，旧套餐详情已清除。请从会话重新打开。');
    epoch = status.session_epoch;
  }
  async function load(): Promise<void> {
    if (view.invalidated) return;
    const ticket = ++sequence;
    publish({ busy: true, data: null, error: null, invalidated: false });
    try {
      const raw = await deps.invoke(UiCommands.ASSIST_PACKAGE_DETAIL, {});
      if (ticket !== sequence) return;
      const data = detailProjection(raw);
      if (!data) throw new Error('invalid package detail');
      if (epoch !== null && epoch !== data.session_epoch) { invalidate('TSim 登录身份已变化，请从会话重新打开详情。'); return; }
      epoch = data.session_epoch; publish({ busy: false, data, error: null, invalidated: false });
    } catch (error) { if (ticket === sequence) publish({ busy: false, data: null, error: packageFailure(error).error, invalidated: false }); }
  }
  return { load, identity, invalidate };
}
