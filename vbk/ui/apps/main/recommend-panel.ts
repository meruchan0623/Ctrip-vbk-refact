import { UiCommands } from '../../packages/ipc/src/client.ts';
import type { UiRecommendProduct, UiRecommendProducts, UiRecommendCities, UiRecommendSend } from '../../packages/ipc/src/recommend.ts';
import { h, icon } from '../../packages/ui-kit/src/h.ts';
import { IC } from '../_shared/icons.ts';
import { errorMessage } from './viewmodel.ts';
import { sameReplyScope, type ReplyScope } from './quick-replies.ts';

type City = UiRecommendCities['items'][number];
type CityField = 'departure' | 'destination';
export interface RecommendFilters { readonly text: string; readonly sendableOnly: boolean; readonly sort: 'default' | 'name' }
const defaultFilters = (): RecommendFilters => ({ text: '', sendableOnly: false, sort: 'default' });
/** 距底部多少像素内就预取下一页，让滑动到底前新卡片已就位。 */
const LOAD_AHEAD_PX = 240;
const isFiltering = (filters: RecommendFilters) => filters.text.trim() !== '' || filters.sendableOnly;
export function nearRecommendEnd(g: { readonly scrollTop: number; readonly clientHeight: number; readonly scrollHeight: number }): boolean {
  return g.scrollHeight - g.clientHeight - g.scrollTop <= LOAD_AHEAD_PX;
}
/** 内容没撑满列表时滚动事件不会触发，由渲染后补查；本地筛选下不自动补页，否则一个冷门词会连续拉完全部产品。 */
export function shouldAutoFill(state: RecommendState): boolean {
  return state.result?.kind === 'ready' && state.result.has_more && !state.busy && !state.loadingMore && !state.sending && !state.moreError && !isFiltering(state.filters);
}
/** 多页合并成一份视图；服务端翻页间数据可能漂移，同一产品只保留首次出现。 */
function mergeRecommendPages(pages: readonly UiRecommendProducts[]): UiRecommendProducts | null {
  const last = pages.at(-1);
  if (!last) return null;
  const seen = new Set<string>();
  return { ...last, items: pages.flatMap(page => page.items).filter(item => !seen.has(item.id) && !!seen.add(item.id)) };
}
export function visibleRecommendProducts(state: RecommendState) {
  const words = state.filters.text.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const items = (state.result?.kind === 'ready' ? state.result.items : []).filter(item => {
    const text = [item.name, item.id, item.departure_city, item.destination_city].join(' ').toLocaleLowerCase();
    const write = state.writes[item.id];
    return words.every(word => text.includes(word)) && (!state.filters.sendableOnly || (item.sendable && (!write || write.kind === 'not_submitted')));
  });
  return state.filters.sort === 'name' ? items.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true })) : items;
}
export interface RecommendState {
  readonly filters: RecommendFilters;
  readonly scope: ReplyScope;
  readonly query: string;
  readonly departure: City | null;
  readonly destination: City | null;
  readonly departureText: string;
  readonly destinationText: string;
  readonly cityField: CityField | null;
  readonly cities: readonly City[];
  readonly cityBusy: boolean;
  readonly busy: boolean;
  /** 已加载的各页。selection_token 按页签发且各自过期，发送时必须用产品所在页的令牌。 */
  readonly pages: readonly UiRecommendProducts[];
  readonly result: UiRecommendProducts | null;
  readonly loadingMore: boolean;
  readonly moreError: string | null;
  readonly error: string | null;
  readonly sending: string | null;
  /** 令牌过期、正在为这次点击刷新所在页的产品。 */
  readonly preparing: string | null;
  readonly writes: Readonly<Record<string, UiRecommendSend>>;
}
const noResults = { pages: [], result: null, busy: false, loadingMore: false, moreError: null, preparing: null } as const;
/** 刷新后客服看到的内容完全没变，原来那次点击才算数；任何字段变了都要重新核对。 */
const sameRecommendProduct = (a: UiRecommendProduct, b: UiRecommendProduct) => a.name === b.name && a.image_url === b.image_url && a.departure_city === b.departure_city && a.destination_city === b.destination_city && a.detail_url === b.detail_url && a.price_text === b.price_text && a.sendable === b.sendable;
const pageHolding = (s: RecommendState, id: string) => s.pages.find(page => page.items.some(item => item.id === id));
const withPages = (s: RecommendState, pages: readonly UiRecommendProducts[]): RecommendState => ({ ...s, pages, result: mergeRecommendPages(pages) });
export function createRecommendPanel(deps: {
  current(): ReplyScope | null;
  canSend(): boolean;
  invoke(command: string, payload: unknown): Promise<unknown>;
  publish(state: RecommendState | null): void;
  refresh(scope: ReplyScope): Promise<void>;
  now(): number;
}) {
  let state: RecommendState | null = null;
  let ticket = 0, cityTicket = 0;
  const attempts = new Map<string, UiRecommendSend>();
  const publish = (s: RecommendState | null) => { state = s; deps.publish(s); };
  const valid = (id: number, scope: ReplyScope) => id === ticket && state !== null && sameReplyScope(scope, deps.current());
  const key = (scope: ReplyScope, id: string) => JSON.stringify([scope.account, scope.gid, scope.revision, id]);
  const priorWrites = (scope: ReplyScope, page: UiRecommendProducts): Record<string, UiRecommendSend> => Object.fromEntries(page.items.flatMap(item => { const prior = attempts.get(key(scope, item.id)); return prior ? [[item.id, prior]] : []; }));
  // 当页产品的写入状态以尝试记录为准（not_submitted 可重试），其他页不受影响。
  const mergedWrites = (s: RecommendState, scope: ReplyScope, page: UiRecommendProducts) => ({ ...Object.fromEntries(Object.entries(s.writes).filter(([id]) => !page.items.some(item => item.id === id))), ...priorWrites(scope, page) });
  async function fetchPage(s: RecommendState, page: number): Promise<UiRecommendProducts> {
    const result = await deps.invoke(UiCommands.IM_RECOMMEND_PRODUCTS, { account: s.scope.account, gid: s.scope.gid, query: s.query.trim(), departure_city_id: s.departure?.id ?? -1, destination_city_id: s.destination?.id ?? -1, page_index: page }) as UiRecommendProducts;
    if (!result || !Array.isArray(result.items) || !['ready', 'forbidden'].includes(result.kind)) throw new Error('产品返回格式无效');
    return result;
  }
  function close() { ticket++; cityTicket++; publish(null); }
  async function open() {
    close(); const scope = deps.current(); if (!scope) return;
    publish({ scope, filters: defaultFilters(), query: '', departure: null, destination: null, departureText: '', destinationText: '', cityField: null, cities: [], cityBusy: false, ...noResults, error: null, sending: null, writes: {} });
    await search(0);
  }
  function filter(patch: Partial<RecommendFilters>) {
    if (!state || state.sending) return;
    publish({ ...state, filters: { ...state.filters, ...patch } });
  }
  async function reset() {
    if (!state || state.sending) return;
    cityTicket++;
    publish({ ...state, query: '', departure: null, destination: null, departureText: '', destinationText: '', cityField: null, cities: [], cityBusy: false, filters: defaultFilters() });
    await search(0);
  }
  function query(value: string) {
    if (!state || state.sending) return;
    ticket++; publish({ ...state, query: value, ...noResults, error: null });
  }
  function cityText(field: CityField, value: string) {
    if (!state || state.sending) return;
    ticket++; cityTicket++;
    publish({ ...state, [field]: null, [`${field}Text`]: value, cityField: field, cities: [], cityBusy: false, ...noResults });
  }
  async function findCities(field: CityField) {
    if (!state || !sameReplyScope(state.scope, deps.current())) return;
    const scope = state.scope, text = state[`${field}Text`].trim(), id = ++cityTicket;
    if (!text) return;
    publish({ ...state, cityField: field, cities: [], cityBusy: true, error: null });
    try {
      const result = await deps.invoke(UiCommands.IM_RECOMMEND_CITIES, { account: scope.account, query: text }) as UiRecommendCities;
      if (id === cityTicket && state && sameReplyScope(scope, deps.current())) publish({ ...state, cities: result.items, cityBusy: false });
    } catch (error) { if (id === cityTicket && state && sameReplyScope(scope, deps.current())) publish({ ...state, cityBusy: false, error: errorMessage(error) }); }
  }
  function chooseCity(field: CityField, city: City | null) {
    if (!state || state.sending || (city && !state.cities.some(c => c.id === city.id && c.name === city.name))) return;
    ticket++; cityTicket++;
    publish({ ...state, [field]: city, [`${field}Text`]: city?.name ?? '', cities: [], cityField: null, cityBusy: false, ...noResults, error: null });
  }
  async function search(page = 0) {
    if (!state || state.sending || !sameReplyScope(state.scope, deps.current())) return;
    if ((!state.departure && state.departureText.trim()) || (!state.destination && state.destinationText.trim())) { publish({ ...state, error: '请从城市候选中选择，或清空城市条件。' }); return; }
    const scope = state.scope, id = ++ticket, request = fetchPage(state, page);
    publish({ ...state, ...noResults, busy: true, error: null });
    try {
      const result = await request;
      if (valid(id, scope) && state) publish({ ...withPages(state, [result]), writes: priorWrites(scope, result) });
    } catch (error) { if (valid(id, scope) && state) publish({ ...state, error: errorMessage(error) }); }
    finally { if (valid(id, scope) && state) publish({ ...state, busy: false }); }
  }
  /** 追加下一页。查询条件一变结果就被清空，所以已有结果时 state 里的条件就是生效条件。自动触发遇到失败即停，只有 retry 才重试。 */
  async function loadMore(retry = false) {
    if (!state || state.busy || state.sending || state.loadingMore || (state.moreError && !retry) || !sameReplyScope(state.scope, deps.current())) return;
    const last = state.result;
    if (last?.kind !== 'ready' || !last.has_more) return;
    const scope = state.scope, id = ++ticket, request = fetchPage(state, last.page_index + 1);
    publish({ ...state, loadingMore: true, moreError: null });
    try {
      const result = await request;
      if (valid(id, scope) && state) publish({ ...withPages(state, result.kind === 'forbidden' ? [result] : [...state.pages, result]), writes: mergedWrites(state, scope, result) });
    } catch (error) { if (valid(id, scope) && state) publish({ ...state, moreError: errorMessage(error) }); }
    finally { if (valid(id, scope) && state) publish({ ...state, loadingMore: false }); }
  }
  /** 判定放在这里取最新状态：渲染时排下的这一帧执行前，用户可能已经输入了筛选词。 */
  async function autoFill() { if (state && shouldAutoFill(state)) await loadMore(); }
  /** 令牌过期时只原位刷新产品所在页，列表和滚动位置不动。 */
  async function refreshPage(pageIndex: number): Promise<boolean> {
    if (!state || state.sending || !sameReplyScope(state.scope, deps.current())) return false;
    const scope = state.scope, id = ++ticket, request = fetchPage(state, pageIndex);
    publish({ ...state, busy: true, loadingMore: false, moreError: null, error: null });
    try {
      const result = await request;
      if (!valid(id, scope) || !state) return false;
      publish({ ...withPages(state, result.kind === 'forbidden' ? [result] : state.pages.map(page => page.page_index === pageIndex ? result : page)), writes: mergedWrites(state, scope, result) });
      return true;
    } catch (error) { if (valid(id, scope) && state) publish({ ...state, error: errorMessage(error) }); return false; }
    finally { if (valid(id, scope) && state) publish({ ...state, busy: false }); }
  }
  async function send(productId: string) {
    if (!state || state.busy || state.sending || !sameReplyScope(state.scope, deps.current()) || !deps.canSend()) return;
    const held = pageHolding(state, productId), product = held?.items.find(p => p.id === productId);
    if (!held || held.kind !== 'ready' || !product?.sendable) return;
    const scope = state.scope, attemptKey = key(scope, productId);
    if (attempts.has(attemptKey)) return;
    let page = held;
    if (page.expires_at_ms <= deps.now()) {
      const expected = ticket + 1;
      publish({ ...state, preparing: productId });
      const refreshed = await refreshPage(page.page_index);
      if (!valid(expected, scope) || !state) return;
      publish({ ...state, preparing: null });
      if (!refreshed) return;
      const fresh = pageHolding(state, productId), latest = fresh?.items.find(p => p.id === productId);
      if (!fresh || fresh.kind !== 'ready' || !latest || !sameRecommendProduct(product, latest) || fresh.expires_at_ms <= deps.now()) { publish({ ...state, error: '产品信息已变化，请核对后再次选择。' }); return; }
      if (!deps.canSend()) return;
      page = fresh;
    }
    const id = ticket;
    const pending: UiRecommendSend = { kind: 'unknown', confirmed: false };
    attempts.set(attemptKey, pending);
    publish({ ...state, sending: productId, error: null, writes: { ...state.writes, [productId]: pending } });
    try {
      const raw = await deps.invoke(UiCommands.IM_SEND_PRODUCT_CARD, { account: scope.account, gid: scope.gid, selection_token: page.selection_token, product_id: productId }) as UiRecommendSend;
      const outcome: UiRecommendSend = raw?.kind === 'confirmed' && raw.confirmed === true ? raw : raw?.kind === 'not_submitted' && raw.confirmed === false ? raw : pending;
      if (outcome.kind === 'not_submitted') attempts.delete(attemptKey); else attempts.set(attemptKey, outcome);
      if (valid(id, scope) && state) publish({ ...state, writes: { ...state.writes, [productId]: outcome } });
      if (outcome.kind === 'confirmed') await deps.refresh(scope);
    } catch (error) { if (valid(id, scope) && state) publish({ ...state, error: errorMessage(error) }); }
    finally { if (valid(id, scope) && state) publish({ ...state, sending: null }); }
  }
  return { open, close, filter, reset, query, cityText, findCities, chooseCity, search, loadMore, autoFill, send };
}
export function recommendCountText(result: UiRecommendProducts, visible: number, filtering: boolean): string {
  const loaded = `已加载 ${result.items.length}${result.total !== null ? ` / ${result.total}` : ''} 项`;
  return filtering ? `匹配 ${visible} · ${loaded}` : loaded;
}
export function recommendView(state: RecommendState | null, scope: ReplyScope | null, canSend: boolean, controller: ReturnType<typeof createRecommendPanel>): HTMLElement | null {
  if (!state || !sameReplyScope(state.scope, scope)) return null;
  const result = state.result;
  const items = visibleRecommendProducts(state);
  const filtering = isFiltering(state.filters);
  const cityInput = (field: CityField, label: string) => h('div', { class: 'recommend-city' },
    h('input', { class: 'inp', 'aria-label': label, placeholder: label, value: state[`${field}Text`], disabled: !!state.sending, dataset: { fid: `recommend-${field}` }, oninput: (e: Event) => controller.cityText(field, (e.target as HTMLInputElement).value), onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); void controller.findCities(field); } } }),
    state[`${field}Text`] ? h('button', { class: 'ibtn', type: 'button', 'aria-label': `清空${label}`, disabled: !!state.sending, onclick: () => controller.chooseCity(field, null) }, '×') : null,
    h('button', { class: 'ibtn', type: 'button', 'aria-label': `查找${label}`, title: `查找${label}`, disabled: state.cityBusy || !!state.sending, onclick: () => void controller.findCities(field) }, icon(IC.search, 14)));
  const more = result?.kind === 'ready' && result.items.length ? h('div', { class: 'recommend-more' },
    state.loadingMore ? h('span', { class: 'muted', role: 'status' }, '正在加载更多…')
      : state.moreError ? [h('span', { class: 'hint-bad', role: 'alert' }, state.moreError), h('button', { class: 'btn sm', type: 'button', disabled: state.busy || !!state.sending, onclick: () => void controller.loadMore(true) }, '重试')]
      : result.has_more ? h('button', { class: 'btn sm', type: 'button', disabled: state.busy || !!state.sending, onclick: () => void controller.loadMore() }, '加载更多')
      : h('span', { class: 'muted' }, '已全部加载')) : null;
  return h('div', { class: 'shade', onclick: controller.close }, h('div', { class: 'dlg recommend-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': '产品推荐', tabindex: '-1', dataset: { commerceDialog: 'recommend' }, onclick: (e: Event) => e.stopPropagation() },
    h('div', { class: 'dlg-h' }, '产品推荐', h('button', { class: 'ibtn', 'aria-label': '关闭产品推荐', onclick: controller.close }, '×')),
    h('div', { class: 'dlg-b' },
      h('div', { class: 'recommend-toolbar' },
        h('form', { class: 'recommend-search', onsubmit: (e: Event) => { e.preventDefault(); void controller.search(0); } },
          h('input', { class: 'inp', type: 'search', 'aria-label': '产品名称或编号', placeholder: '产品名称或编号', value: state.query, disabled: !!state.sending, dataset: { fid: 'recommend-query' }, oninput: (e: Event) => controller.query((e.target as HTMLInputElement).value) }),
          cityInput('departure', '出发城市'), cityInput('destination', '目的城市'),
          h('button', { class: 'btn pri', type: 'submit', disabled: state.busy || !!state.sending }, '查询'), h('button', { class: 'btn', type: 'button', disabled: !!state.sending, onclick: () => void controller.reset() }, '重置')),
        state.cityBusy ? h('p', { role: 'status' }, '正在查找城市…') : state.cityField ? h('div', { class: 'recommend-cities' }, state.cities.map(city => h('button', { class: 'btn sm', onclick: () => controller.chooseCity(state.cityField!, city) }, city.name))) : null,
        h('div', { class: 'recommend-refine' },
          h('input', { class: 'inp', type: 'search', 'aria-label': '筛选已加载产品', placeholder: '筛选已加载：名称、编号、城市，空格组合', value: state.filters.text, disabled: !!state.sending, dataset: { fid: 'recommend-local' }, oninput: (e: Event) => controller.filter({ text: (e.target as HTMLInputElement).value }) }),
          h('label', { class: 'recommend-check' }, h('input', { type: 'checkbox', checked: state.filters.sendableOnly, disabled: !!state.sending, onchange: (e: Event) => controller.filter({ sendableOnly: (e.target as HTMLInputElement).checked }) }), '仅可发送'),
          h('select', { class: 'inp', 'aria-label': '已加载产品排序', disabled: !!state.sending, onchange: (e: Event) => controller.filter({ sort: (e.target as HTMLSelectElement).value === 'name' ? 'name' : 'default' }) },
            h('option', { value: 'default', selected: state.filters.sort === 'default' }, '默认排序'), h('option', { value: 'name', selected: state.filters.sort === 'name' }, '名称排序')),
          h('span', { class: 'recommend-count muted', role: 'status' }, result?.kind === 'ready' ? recommendCountText(result, items.length, filtering) : '')),
        state.error ? h('p', { class: 'hint-bad', role: 'alert' }, state.error) : null),
      h('div', { class: 'recommend-list', dataset: { keepScroll: 'recommend-list' },
        onscroll: (e: Event) => { if (nearRecommendEnd(e.currentTarget as HTMLElement)) void controller.loadMore(); },
        ref: (el: Element) => { if (shouldAutoFill(state)) requestAnimationFrame(() => { if (el.isConnected && nearRecommendEnd(el)) void controller.autoFill(); }); } },
        state.busy && !result ? h('p', { class: 'peripheral-empty', role: 'status' }, '正在查询产品…') : result?.kind === 'forbidden' ? h('p', { class: 'peripheral-empty', role: 'status' }, '当前会话没有产品推荐权限') : result?.kind === 'ready' && !items.length ? h('p', { class: 'peripheral-empty' }, result.items.length ? '已加载的产品里没有匹配项，可调整筛选或继续加载。' : '没有匹配的产品，请调整查询条件。') : null,
        h('div', { class: 'recommend-grid' }, items.map(item => { const write = state.writes[item.id]; const label = state.sending === item.id || state.preparing === item.id ? '发送中…' : write?.kind === 'confirmed' ? '已发送' : write?.kind === 'unknown' || write?.kind === 'accepted' ? '结果待核对' : '发送'; const route = [item.departure_city, item.destination_city].filter(Boolean).join(' → '); const meta = [`编号 ${item.id}`, route].filter(Boolean).join(' · '); return h('article', { class: 'recommend-item', dataset: { productId: item.id, key: item.id } },
          item.image_url ? h('img', { src: item.image_url, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : null,
          h('div', { class: 'recommend-info' }, h('h3', { title: item.name }, item.name), h('p', { class: 'recommend-meta muted', title: meta }, meta),
            !item.sendable && item.unavailable_reason ? h('p', { class: 'muted' }, item.unavailable_reason) : null,
            write?.kind === 'unknown' ? h('p', { role: 'status' }, '请在聊天记录中核对，勿重复发送。') : write?.kind === 'not_submitted' ? h('p', { role: 'status' }, write.reason || '尚未提交，请刷新产品后再试。') : null),
          h('div', { class: 'recommend-foot' }, h('span', { class: 'recommend-price' }, item.price_text),
            h('button', { class: 'btn sm pri', 'aria-label': `发送产品卡片：${item.name}`, disabled: !canSend || !item.sendable || state.busy || !!state.sending || (!!write && write.kind !== 'not_submitted'), onclick: () => void controller.send(item.id) }, label))); })),
        more))));
}
