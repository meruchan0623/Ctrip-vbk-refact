import { t } from '../../packages/ui-kit/src/i18n.ts';
document.title = t('packageDetailRuntime.heading');
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
function close() { void ipc.invoke(UiCommands.SHELL_WINDOW, { action: 'close' }).catch(() => store.patch({ error: t('packageDetailRuntime.closeFailed') })); }
function fieldTable(title: string, values: readonly UiPackageField[]): HTMLElement {
  return h('section', { class: 'detail-section' }, h('h2', null, title), values.length ? h('dl', { class: 'detail-fields' }, values.map(field => [h('dt', null, field.label), h('dd', null, field.value)])) : h('p', { class: 'empty' }, t('packageDetailRuntime.noData')));
}
function render(s: DetailView): HTMLElement {
  const data = s.data;
  return h('div', { class: 'detail-window' },
    h('header', { class: 'detail-chrome', 'data-tauri-drag-region': 'deep' }, h('span', null, t('packageDetailRuntime.heading')), h('span', { class: 'sp' }), platform === 'windows' ? h('button', { class: 'cap-x', 'aria-label': t('packageDetailRuntime.closeLabel'), onclick: close }, '×') : null),
    h('main', { class: 'detail-body', dataset: { keepScroll: 'detail' } },
      h('div', { class: 'detail-heading' }, h('div', null, h('div', { class: 'eyebrow' }, data ? t('packageDetailRuntime.order', { id: data.order_id }) : t('packageDetailRuntime.orderFallback')), h('h1', null, data?.plan.plan || t('packageDetailRuntime.planFallback')), h('p', { class: 'detail-subtitle' }, t('packageDetailRuntime.subtitle'))), h('button', { class: 'btn pri', disabled: s.busy || s.invalidated, dataset: { action: 'refresh-detail' }, onclick: () => void detail.load() }, s.busy ? t('packageDetailRuntime.refreshing') : t('packageDetailRuntime.refresh'))),
      s.busy ? h('p', { role: 'status', class: 'detail-notice' }, t('packageDetailRuntime.loading')) : null,
      s.error ? h('div', { role: 'alert', class: 'notice-box err' }, s.error) : null,
      data ? [h('section', { class: 'quota-strip' }, h('div', null, h('span', null, t('packageDetailRuntime.remaining')), h('strong', null, data.plan.remain || t('packageDetailRuntime.usagePending')), h('small', null, data.plan.total ? ` / ${data.plan.total}` : '')), h('div', null, h('span', null, t('packageDetailRuntime.status')), h('strong', null, data.plan.status)), h('div', null, h('span', null, 'ICCID'), h('strong', { class: 'identifier' }, data.plan.iccid))),
        fieldTable(t('packageDetailRuntime.information'), data.detail_fields), fieldTable(t('packageDetailRuntime.live'), data.live_fields),
        h('section', { class: 'detail-section' }, h('h2', null, t('packageDetailRuntime.cdrHeading')), data.cdrs.length ? data.cdrs.map((row, index) => h('article', { class: 'cdr-record' }, fieldTable(t('packageDetailRuntime.record', { index: index + 1 }), row))) : h('p', { class: 'empty' }, t('packageDetailRuntime.noCdr'))),
        h('footer', { class: 'detail-fetched' }, t('packageDetailRuntime.fetched', { time: new Date(data.fetched_at_ms).toLocaleString('zh-CN') }))] : null));
}
subscribeBatched(store, state => rerender(root, () => render(state)));
rerender(root, () => render(store.get()));
ipc.listen<unknown>(UiEvents.TSIM_STATUS, value => { if (isTsimStatus(value)) detail.identity(value); else detail.invalidate(t('packageDetailRuntime.identityUnverified')); });
ipc.listen<unknown>(UiEvents.PACKAGE_DETAIL_INVALIDATED, () => detail.invalidate(t('packageDetailRuntime.scopeInvalidated')));
void detail.load();
exposeForTests(sel, { __vbkStore: store });
