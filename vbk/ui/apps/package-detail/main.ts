import { applyPlatform } from '../_shared/platform.ts';
const platform = applyPlatform();
import { h, rerender } from '../../packages/ui-kit/src/h.ts';
import { createStore, subscribeBatched } from '../../packages/ui-kit/src/store.ts';
import { UiCommands, UiEvents, type UiPackageField } from '../../packages/ipc/src/client.ts';
import { selectIpc, exposeForTests } from '../_shared/ipc.ts';
import { isTsimStatus } from '../setting/viewmodel.ts';
import { createPackageDetail, type DetailView } from './controller.ts';
const sel = selectIpc(), ipc = sel.ipc;
const store = createStore<DetailView>({ busy: false, data: null, error: null, invalidated: false });
const detail = createPackageDetail({ invoke: (command, payload) => ipc.invoke(command, payload), publish: view => store.set(view) });
const root = document.getElementById('app');
if (!root) throw new Error('#app missing');
function close() { void ipc.invoke(UiCommands.SHELL_WINDOW, { action: 'close' }).catch(() => store.patch({ error: '无法关闭窗口，请使用系统窗口关闭操作。' })); }
function fieldTable(title: string, values: readonly UiPackageField[]): HTMLElement {
  return h('section', { class: 'detail-section' }, h('h2', null, title), values.length ? h('dl', { class: 'detail-fields' }, values.map(field => [h('dt', null, field.label), h('dd', null, field.value)])) : h('p', { class: 'empty' }, '未返回可显示的数据'));
}
function render(s: DetailView): HTMLElement {
  const data = s.data;
  return h('div', { class: 'detail-window' },
    h('header', { class: 'detail-chrome', 'data-tauri-drag-region': 'deep' }, h('span', null, 'TSim 套餐详情'), h('span', { class: 'sp' }), platform === 'windows' ? h('button', { class: 'cap-x', 'aria-label': '关闭套餐详情', onclick: close }, '×') : null),
    h('main', { class: 'detail-body', dataset: { keepScroll: 'detail' } },
      h('div', { class: 'detail-heading' }, h('div', null, h('div', { class: 'eyebrow' }, data ? `订单 ${data.order_id}` : '订单套餐'), h('h1', null, data?.plan.plan || '套餐详情'), h('p', { class: 'detail-subtitle' }, '套餐信息 · 实时状态 · 用量记录')), h('button', { class: 'btn pri', disabled: s.busy || s.invalidated, dataset: { action: 'refresh-detail' }, onclick: () => void detail.load() }, s.busy ? '正在刷新…' : '刷新详情')),
      s.busy ? h('p', { role: 'status', class: 'detail-notice' }, '正在读取套餐详情、实时状态和用量记录…') : null,
      s.error ? h('div', { role: 'alert', class: 'notice-box err' }, s.error) : null,
      data ? [h('section', { class: 'quota-strip' }, h('div', null, h('span', null, '剩余流量'), h('strong', null, data.plan.remain || '用量待查询'), h('small', null, data.plan.total ? ` / ${data.plan.total}` : '')), h('div', null, h('span', null, '套餐状态'), h('strong', null, data.plan.status)), h('div', null, h('span', null, 'ICCID'), h('strong', { class: 'identifier' }, data.plan.iccid))),
        fieldTable('套餐信息', data.detail_fields), fieldTable('实时状态', data.live_fields),
        h('section', { class: 'detail-section' }, h('h2', null, '用量记录 CDR（最多展示前 100 条）'), data.cdrs.length ? data.cdrs.map((row, index) => h('article', { class: 'cdr-record' }, fieldTable(`记录 ${index + 1}`, row))) : h('p', { class: 'empty' }, '未返回可显示的用量记录')),
        h('footer', { class: 'detail-fetched' }, `数据读取时间：${new Date(data.fetched_at_ms).toLocaleString('zh-CN')}`)] : null));
}
subscribeBatched(store, state => rerender(root, () => render(state)));
rerender(root, () => render(store.get()));
ipc.listen<unknown>(UiEvents.TSIM_STATUS, value => { if (isTsimStatus(value)) detail.identity(value); else detail.invalidate('TSim 登录状态无法核对，请从会话重新打开详情。'); });
ipc.listen<unknown>(UiEvents.PACKAGE_DETAIL_INVALIDATED, () => detail.invalidate('会话、账号或订单范围已变化，旧套餐详情已清除。请从当前会话重新打开。'));
void detail.load();
exposeForTests(sel, { __vbkStore: store });
