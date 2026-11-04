import { t } from '../../packages/ui-kit/src/i18n.ts';
/** The host checks the order scope and returns an ephemeral operator grant. */
import type { AccountContext } from '../../packages/ipc/src/contracts.ts';
import { UiCommands, type UiConversation, type UiOrderSummary, type UiTsimStatus } from '../../packages/ipc/src/client.ts';
import type { Child, h as dom, icon as glyph } from '../../packages/ui-kit/src/h.ts';

/** 参考图的标签顺序；没有值的行整行隐藏，不编造。 */
export const ORDER_INFO_LABELS = [
  ['来源渠道', 'source_channel'],
  ['订单ID', 'order_id'],
  ['客户语言', 'customer_language'],
  ['产品ID', 'product_id'],
  ['产品名称', 'product'],
  ['产品价格', 'product_price'],
  ['使用日期', 'use_date'],
  ['订单总额', 'total_amount'],
  ['备注名称', 'remark_name'],
  ['数量', 'quantity'],
  ['订单状态', 'status'],
] as const satisfies readonly (readonly [string, keyof UiOrderSummary])[];

export function orderInfoRows(order: UiOrderSummary): readonly (readonly [label: string, key: keyof UiOrderSummary, value: string])[] {
  return ORDER_INFO_LABELS.flatMap(([label, key]) => { const value = order[key]; return typeof value === 'string' && value.trim() ? [[label, key, value.trim()] as const] : []; });
}

/** 与宿主 `core_assistant::order::validate_order_id` 一致：完整的 10/16 位纯数字。 */
export function tsimQueryableOrder(orderId: unknown): orderId is string {
  return typeof orderId === 'string' && /^(?:\d{10}|\d{16})$/.test(orderId);
}

export interface TsimOrderContext { readonly account: AccountContext; readonly conversation: UiConversation; readonly identity: UiTsimStatus | null }
export interface TsimOrderPayload { readonly account: AccountContext; readonly gid: string; readonly order_id: string; readonly context_revision: string; readonly session_epoch: number }
export type TsimOrderRequest = { readonly ok: true; readonly payload: TsimOrderPayload } | { readonly ok: false; readonly reason: 'order' | 'revision' | 'login' };

export function tsimOrderRequest(c: TsimOrderContext): TsimOrderRequest {
  const orderId = c.conversation.order?.order_id;
  if (!tsimQueryableOrder(orderId)) return { ok: false, reason: 'order' };
  const revision = c.conversation.assistant_context_revision;
  if (!revision) return { ok: false, reason: 'revision' };
  if (!c.identity?.logged_in) return { ok: false, reason: 'login' };
  return { ok: true, payload: { account: { ...c.account }, gid: c.conversation.gid, order_id: orderId, context_revision: revision, session_epoch: c.identity.session_epoch } };
}

const NOTICE: Record<'order' | 'revision' | 'login' | 'failed', string> = {
  order: t('orderInfo.notice.order'),
  revision: t('orderInfo.notice.revision'),
  login: t('orderInfo.notice.login'),
  failed: t('orderInfo.notice.failed'),
};

/** 单飞：同一时刻只发一次打开请求；结果只提示，不自动重试。 */
export function createTsimOrderOpener(deps: { current(): TsimOrderContext | null; invoke(command: string, payload: object): Promise<unknown>; notify(text: string): void; login(): void; show?(grant: unknown, current: () => boolean): void }) {
  let inFlight = false;
  async function open(gid: string): Promise<void> {
    const c = deps.current();
    if (!c || c.conversation.gid !== gid || inFlight) return;
    const request = tsimOrderRequest(c);
    if (!request.ok) { deps.notify(NOTICE[request.reason]); if (request.reason === 'login') deps.login(); return; }
    inFlight = true;
    const applies = () => { const now = deps.current(); const next = now && tsimOrderRequest(now); return !!next?.ok && JSON.stringify(next.payload) === JSON.stringify(request.payload); };
    try {
      const grant = await deps.invoke(UiCommands.ASSIST_TSIM_ORDER_OPEN, request.payload);
      if (applies()) deps.show?.(grant, applies);
    }
    catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
      if (applies()) deps.notify(code === 'assistant.tsim_unauthenticated' || code === 'assistant.session_cleared' ? NOTICE.login : NOTICE.failed);
    } finally { inFlight = false; }
  }
  return { open };
}

export interface OrderInfoView {
  readonly order: UiOrderSummary; readonly hot: boolean;
  readonly labels: { readonly copy: string; readonly pcDetail: string };
  copy(): void; pcDetail(): void; queryTsim(): void;
}

/** 两列键值（灰色标签列 + 可换行值列），底部一个「打开网页订单详情」按钮，以分隔线收尾。 */
export function orderInfoSection(v: OrderInfoView, h: typeof dom, icon: typeof glyph, copyGlyph: string): HTMLElement {
  const o = v.order;
  const value = (key: keyof UiOrderSummary, text: string): Child => {
    if (key !== 'order_id') return h('div', { class: 'iv' }, text);
    const queryable = tsimQueryableOrder(text);
    return h('div', { class: 'iv iv-order' },
      queryable
        ? h('button', { type: 'button', class: 'order-link', dataset: { side: 'tsim-order' }, title: t('orderInfo.queryTitle'), 'aria-label': t('orderInfo.queryLabel', { order: text }), onclick: () => v.queryTsim() }, text)
        : h('span', null, text),
      h('button', { type: 'button', class: 'ibtn order-copy', title: v.labels.copy, 'aria-label': v.labels.copy, onclick: () => v.copy() }, icon(copyGlyph, 12)));
  };
  return h('div', { class: `source-info${v.hot ? ' hot' : ''}` },
    o.source_title ? h('div', { class: 'source-title' }, o.source_title) : null,
    o.source_description ? h('div', { class: 'source-description' }, o.source_description) : null,
    h('div', { class: 'info-grid' }, orderInfoRows(o).map(([label, key, text]) => [h('div', { class: 'ik' }, label), value(key, text)])),
    o.order_id ? h('div', { class: 'source-actions' },
      h('button', { type: 'button', class: 'btn sm', dataset: { side: 'pc' }, onclick: () => v.pcDetail() }, v.labels.pcDetail)) : null);
}
