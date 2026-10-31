import type { AccountContext } from '../../packages/ipc/src/contracts.ts';
import { UiCommands, type UiConversation, type UiPackageInfo, type UiOrderPackageSummary, type UiOrderPackagePlan, type UiTsimStatus } from '../../packages/ipc/src/client.ts';

export interface PackageContext { readonly account: AccountContext; readonly conversation: UiConversation; readonly identity: UiTsimStatus; readonly enabled: boolean; readonly iccid: string | null }
export interface PackagePreviewState {
  readonly status: 'idle' | 'busy' | 'done' | 'error'; readonly key: string | null;
  readonly info: UiPackageInfo | null; readonly summary: UiOrderPackageSummary | null;
  readonly selected_iccid: string | null;
  readonly error: string | null; readonly failure: 'login' | 'permission' | 'error' | null;
}
export const EMPTY_PACKAGE_PREVIEW: PackagePreviewState = { status: 'idle', key: null, info: null, summary: null, selected_iccid: null, error: null, failure: null };
export function packageIdentity(value: unknown): value is UiTsimStatus { if (!value || typeof value !== 'object') return false; const s = value as UiTsimStatus; return typeof s.logged_in === 'boolean' && (s.user === null || typeof s.user === 'string') && (!s.logged_in || typeof s.user === 'string' && !!s.user.trim()) && Number.isSafeInteger(s.session_epoch) && s.session_epoch >= 0; }
export function packageFailure(error: unknown): { failure: 'login' | 'permission' | 'error'; error: string } {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
  if (code === 'assistant.tsim_unauthenticated' || code === 'assistant.session_cleared') return { failure: 'login', error: '请先在设置的“商家助手 · TSim 登录”中登录，再刷新套餐。' };
  if (code === 'assistant.forbidden' || code === 'assistant.permission_denied') return { failure: 'permission', error: '当前 TSim 账号无权查看该订单套餐，请核对账号权限。' };
  if (code === 'assistant.package_not_found') return { failure: 'error', error: '未查询到该订单的套餐，请核对会话订单号。' };
  if (code === 'net.timeout') return { failure: 'error', error: '查询超时，请手动刷新；不会自动重复请求。' };
  return { failure: 'error', error: '套餐查询未完成，可能是会话、订单或 TSim 身份已变化。请核对后刷新。' };
}
export type PackagePlanInfo = Omit<UiPackageInfo, 'remain_pct'> & { readonly remain_pct: number | null };
export function packageInfo(value: unknown): UiPackageInfo | null;
export function packageInfo(value: unknown, unknownUsage: true): PackagePlanInfo | null;
export function packageInfo(value: unknown, unknownUsage = false): PackagePlanInfo | null {
  if (!value || typeof value !== 'object') return null;
  const p = value as PackagePlanInfo;
  if (!['iccid', 'plan', 'status', 'remain', 'total', 'supplier', 'apn'].every(k => typeof (p as unknown as Record<string, unknown>)[k] === 'string') || !(unknownUsage && p.remain_pct === null || typeof p.remain_pct === 'number' && Number.isFinite(p.remain_pct) && p.remain_pct >= 0 && p.remain_pct <= 100) || !Number.isFinite(new Date(p.fetched_at_ms).getTime())) return null;
  return { iccid: p.iccid, plan: p.plan, status: p.status, remain_pct: p.remain_pct, remain: p.remain, total: p.total, supplier: p.supplier, apn: p.apn, fetched_at_ms: p.fetched_at_ms };
}
export function packageOrderId(conv: UiConversation): string | null { const id = conv.order?.order_id; return typeof id === 'string' && /^(?:\d{10}|\d{16})$/.test(id) ? id : null; }
function queryKey(context: PackageContext, iccid?: string): string {
  const a = context.account, c = context.conversation, order = iccid ? null : packageOrderId(c);
  return JSON.stringify([a.environment, a.account_id, a.session_generation, c.gid, c.assistant_context_revision, c.service_type, c.biz, order ? 'order' : 'iccid', order ?? iccid ?? context.iccid, context.identity.session_epoch, context.identity.logged_in, context.identity.user]);
}
export function packageViewApplies(view: PackagePreviewState, context: PackageContext | null): boolean { return !!context && (!view.selected_iccid || !packageOrderId(context.conversation)) && view.key === queryKey(context, view.selected_iccid ?? undefined); }
function summaryFrom(value: unknown, c: PackageContext): UiOrderPackageSummary | null {
  if (!value || typeof value !== 'object') return null;
  const s = value as UiOrderPackageSummary, a = c.account;
  if (s.account?.account_id !== a.account_id || s.account.environment !== a.environment || s.account.session_generation !== a.session_generation || s.gid !== c.conversation.gid || s.order_id !== packageOrderId(c.conversation) || s.context_revision !== c.conversation.assistant_context_revision || s.session_epoch !== c.identity.session_epoch || !s.query_handle || typeof s.query_handle !== 'string' || !Array.isArray(s.plans) || !Number.isSafeInteger(s.total) || s.total < s.plans.length || !Number.isFinite(s.fetched_at_ms)) return null;
  const plans: UiOrderPackagePlan[] = [];
  for (const plan of s.plans) { const info = packageInfo(plan, true); if (!info || typeof plan.detail_handle !== 'string' || !plan.detail_handle || plans.some(p => p.detail_handle === plan.detail_handle)) return null; plans.push({ ...info, detail_handle: plan.detail_handle }); }
  return { account: { ...a }, gid: s.gid, order_id: s.order_id, context_revision: s.context_revision, session_epoch: s.session_epoch, query_handle: s.query_handle, plans, total: s.total, fetched_at_ms: s.fetched_at_ms };
}

/** Query keys suppress repeated broadcasts; host handles remain the authority for service/customer identity. */
export function createPackagePreview(deps: { current(): PackageContext | null; invoke(command: string, payload: object): Promise<unknown>; publish(view: PackagePreviewState): void }) {
  let view = EMPTY_PACKAGE_PREVIEW, sequence = 0;
  function publish(next: PackagePreviewState) { view = next; deps.publish(next); }
  function reset() { sequence++; if (view !== EMPTY_PACKAGE_PREVIEW) publish(EMPTY_PACKAGE_PREVIEW); }
  function current(ticket: number, key: string, iccid?: string): boolean { const c = deps.current(); return ticket === sequence && !!c?.enabled && (!iccid || !packageOrderId(c.conversation)) && key === queryKey(c, iccid); }
  async function query(force = false, selectedIccid?: string): Promise<void> {
    const c = deps.current(); if (!c?.enabled) { reset(); return; }
    if (!selectedIccid && view.selected_iccid && packageViewApplies(view, c)) selectedIccid = view.selected_iccid;
    const order = selectedIccid ? null : packageOrderId(c.conversation), iccid = selectedIccid ?? c.iccid;
    if (!order && !iccid) { reset(); return; }
    const key = queryKey(c, selectedIccid); if (!force && view.key === key) return;
    const ticket = ++sequence;
    if (!c.conversation.assistant_context_revision) { publish({ ...EMPTY_PACKAGE_PREVIEW, key, status: 'error', failure: 'error', error: '会话身份尚未核验，请等待会话更新后刷新套餐。' }); return; }
    if (!c.identity.logged_in) { publish({ ...EMPTY_PACKAGE_PREVIEW, key, status: 'error', ...packageFailure({ code: 'assistant.tsim_unauthenticated' }) }); return; }
    publish({ ...EMPTY_PACKAGE_PREVIEW, selected_iccid: selectedIccid ?? null, key, status: 'busy' });
    try {
      const value = await deps.invoke(order ? UiCommands.ASSIST_ORDER_SUMMARY : UiCommands.ASSIST_PACKAGE, order ? { account: c.account, gid: c.conversation.gid, order_id: order, context_revision: c.conversation.assistant_context_revision, session_epoch: c.identity.session_epoch } : { iccid });
      if (!current(ticket, key, selectedIccid)) return;
      const summary = order ? summaryFrom(value, c) : null, info = order ? null : packageInfo(value);
      if (order ? !summary : !info || info.iccid !== iccid) throw new Error('invalid package projection');
      publish({ ...EMPTY_PACKAGE_PREVIEW, selected_iccid: selectedIccid ?? null, key, status: 'done', summary, info });
    } catch (error) { if (current(ticket, key, selectedIccid)) publish({ ...EMPTY_PACKAGE_PREVIEW, selected_iccid: selectedIccid ?? null, key, status: 'error', ...packageFailure(error) }); }
  }
  async function openDetail(selected: PackagePreviewState, plan: UiOrderPackagePlan): Promise<void> {
    const c = deps.current(), summary = selected.summary;
    if (!c || selected !== view || !summary || !c.identity.logged_in || selected.key !== queryKey(c) || !summary.plans.includes(plan)) return;
    try { await deps.invoke(UiCommands.ASSIST_PACKAGE_DETAIL_OPEN, { account: c.account, gid: c.conversation.gid, query_handle: summary.query_handle, detail_handle: plan.detail_handle }); }
    catch (error) { if (view === selected && deps.current() && selected.key === queryKey(deps.current()!)) publish({ ...selected, ...packageFailure(error) }); }
  }
  return { query, reset, openDetail };
}
