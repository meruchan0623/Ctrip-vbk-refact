import { t } from '../../packages/ui-kit/src/i18n.ts';
import { isUiMessage } from '../_shared/guards.ts';
import type { AccountContext } from '../../packages/ipc/src/contracts.ts';
import { UiCommands, type UiMessage } from '../../packages/ipc/src/client.ts';
import type { UiSearchHistoryPage, UiServerSearchPage, UiServerSearchHit, UiServerSearchQuery, ServerSearchGroup, ServerSearchType } from '../../packages/ipc/src/server-search.ts';
import { h } from '../../packages/ui-kit/src/h.ts';

export interface ServerSearchState {
  readonly type: ServerSearchType;
  readonly text: string;
  readonly from: string;
  readonly to: string;
  readonly status: 'idle' | 'loading' | 'loaded' | 'error';
  readonly error: string | null;
  readonly result: UiServerSearchPage | null;
  readonly selected: UiServerSearchHit | null;
  readonly messages: readonly UiMessage[];
  readonly history: Readonly<Record<'prev' | 'next', { readonly status: 'idle' | 'loading' | 'loaded' | 'error'; readonly error: string | null; readonly cursor: number | null; readonly more: boolean }>>;
}
const emptyDirection = () => ({ status: 'idle' as const, error: null, cursor: null, more: false });
export const EMPTY_SERVER_SEARCH: ServerSearchState = { type: 3, text: '', from: '', to: '', status: 'idle', error: null, result: null, selected: null, messages: [], history: { prev: emptyDirection(), next: emptyDirection() } };
const groupTypes: Record<ServerSearchGroup, ServerSearchType> = { customer: 1, content: 0, order: 2, date: 4 };
const groupLabels: Record<ServerSearchGroup, string> = { customer: t('searchRuntime.customer'), content: t('searchRuntime.content'), order: t('searchRuntime.order'), date: t('searchRuntime.date') };
const groups = Object.keys(groupTypes) as ServerSearchGroup[];
const hitKey = (hit: UiServerSearchHit): string => JSON.stringify(hit.message_id !== null ? [hit.gid, hit.message_id] : [hit.gid, hit.time_ms, hit.preview]);
export function searchDateBounds(now = new Date()): { min: string; max: string } {
  const date = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const min = new Date(now.getFullYear(), now.getMonth() - 3, 1);
  min.setDate(Math.min(now.getDate(), new Date(min.getFullYear(), min.getMonth() + 1, 0).getDate()));
  return { min: date(min), max: date(now) };
}
export function dateSearchRange(from: string, to: string, now = new Date()): { start_ms: number; end_ms: number } {
  const bounds = searchDateBounds(now);
  const parse = (raw: string): Date => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || raw < bounds.min || raw > bounds.max) throw new Error(t('searchRuntime.dateBounds'));
    const parts = raw.split('-').map(Number), date = new Date(parts[0]!, parts[1]! - 1, parts[2]!);
    if (date.getFullYear() !== parts[0] || date.getMonth() + 1 !== parts[1] || date.getDate() !== parts[2]) throw new Error(t('searchRuntime.invalidDate'));
    return date;
  };
  const start = parse(from), end = parse(to);
  if (start > end) throw new Error(t('searchRuntime.reversedDates'));
  return { start_ms: start.getTime(), end_ms: new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1).getTime() - 1 };
}
function validPage(value: UiServerSearchPage, query: UiServerSearchQuery): boolean {
  return !!value && value.query_id === query.query_id && value.search_type === query.search_type && value.page_no === query.page_no && Number.isSafeInteger(value.page_count) && value.page_count >= 0 && typeof value.has_more === 'boolean' && !!value.groups && groups.every(group => Array.isArray(value.groups[group]) && value.groups[group].every(hit => !!hit && typeof hit.selection_token === 'string' && !!hit.selection_token && typeof hit.gid === 'string' && typeof hit.title === 'string' && typeof hit.preview === 'string' && Number.isFinite(hit.time_ms) && (hit.message_id === null || typeof hit.message_id === 'string')));
}
export function createServerSearchPanel(port: {
  account(): AccountContext | null;
  current(): ServerSearchState;
  publish(state: ServerSearchState): void;
  invoke<T>(command: string, payload: unknown): Promise<T>;
  error(error: unknown): string;
}) {
  let epoch = 0, searchTicket = 0, historyTicket = 0, id = 0;
  let activeQuery: UiServerSearchQuery | null = null;
  const historyRequests = { prev: 0, next: 0 };
  const scope = () => {
    const account = port.account(), captured = epoch;
    return account ? { account, valid: () => { const now = port.account(); return epoch === captured && now?.account_id === account.account_id && now.environment === account.environment && now.session_generation === account.session_generation; } } : null;
  };
  const patch = (state: Partial<ServerSearchState>) => port.publish({ ...port.current(), ...state });
  const configure = (form: Partial<Pick<ServerSearchState, 'type' | 'text' | 'from' | 'to'>>) => {
    ++searchTicket; ++historyTicket; activeQuery = null;
    patch({ ...form, status: 'idle', error: null, result: null, selected: null, messages: [], history: { prev: emptyDirection(), next: emptyDirection() } });
  };
  async function search(append = false): Promise<void> {
    const owner = scope(), state = port.current();
    if (!owner || (append && (!activeQuery || !state.result?.has_more || state.status === 'loading'))) return;
    const ticket = ++searchTicket;
    let query: UiServerSearchQuery;
    try {
      query = append && activeQuery && state.result ? { ...activeQuery, page_no: state.result.page_no + 1 } : {
        query_id: `search-${epoch}-${++id}`, search_type: state.type, page_no: 1,
        ...(state.type === 4 ? dateSearchRange(state.from, state.to) : { search_value: state.text.trim() }),
      };
      if (query.search_type !== 4 && (!query.search_value || query.search_value.length > 100)) throw new Error(t('searchRuntime.queryRequired'));
    } catch (error) { patch({ status: 'error', error: port.error(error) }); return; }
    if (!append) { ++historyTicket; activeQuery = query; }
    const valid = () => owner.valid() && ticket === searchTicket;
    patch({ status: 'loading', error: null, ...(!append ? { result: null, selected: null, messages: [], history: { prev: emptyDirection(), next: emptyDirection() } } : {}) });
    try {
      const result = await port.invoke<UiServerSearchPage>(UiCommands.SERVER_SEARCH, { account: owner.account, query });
      if (!valid()) return;
      if (!validPage(result, query)) throw new Error(t('searchRuntime.invalidResults'));
      const previous = append ? port.current().result : null;
      const merged = { ...result, groups: { ...result.groups } };
      if (previous) for (const group of groups) {
        const rows = new Map(previous.groups[group].map(hit => [hitKey(hit), hit]));
        for (const hit of result.groups[group]) rows.set(hitKey(hit), hit);
        merged.groups[group] = [...rows.values()];
      }
      patch({ result: merged, status: 'loaded', error: null });
    } catch (error) { if (valid()) patch({ status: 'error', error: port.error(error) }); }
  }
  async function history(direction: 'prev' | 'next', initial = false): Promise<void> {
    const owner = scope(), state = port.current(), selected = state.selected, visit = historyTicket;
    if (!owner || !selected) return;
    const currentPage = state.history[direction];
    if (!initial && (!currentPage.more || currentPage.cursor === null || currentPage.status === 'loading')) return;
    const request = ++historyRequests[direction];
    const valid = () => owner.valid() && visit === historyTicket && request === historyRequests[direction] && port.current().selected?.selection_token === selected.selection_token;
    const update = (page: ServerSearchState['history']['prev']) => patch({ history: { ...port.current().history, [direction]: page } });
    update({ ...currentPage, status: 'loading', error: null });
    try {
      const result = await port.invoke<UiSearchHistoryPage>(UiCommands.SEARCH_HISTORY, { account: owner.account, query: { selection_token: selected.selection_token, direction, ...(!initial ? { cursor_ms: currentPage.cursor } : {}) } });
      if (!valid()) return;
      if (!result || result.selection_token !== selected.selection_token || result.direction !== direction || !Array.isArray(result.items) || result.items.some(m => !isUiMessage(m) || m.gid !== selected.gid) || typeof result.has_more !== 'boolean' || (result.cursor_ms !== null && !Number.isSafeInteger(result.cursor_ms))) throw new Error(t('searchRuntime.invalidHistory'));
      const merged = new Map(port.current().messages.map(m => [m.message_id ?? m.local_id ?? `${m.sender_id}/${m.create_time_ms}`, m]));
      for (const message of result.items) merged.set(message.message_id ?? message.local_id ?? `${message.sender_id}/${message.create_time_ms}`, message);
      patch({ messages: [...merged.values()].sort((a, b) => a.create_time_ms - b.create_time_ms) });
      update({ status: 'loaded', error: null, cursor: result.cursor_ms, more: result.has_more });
    } catch (error) { if (valid()) update({ ...port.current().history[direction], status: 'error', error: port.error(error) }); }
  }
  return { configure, search: () => search(false), more: () => search(true), history,
    async pick(hit: UiServerSearchHit) {
      if (!port.current().result || !groups.some(group => port.current().result!.groups[group].some(row => row.selection_token === hit.selection_token))) return;
      ++historyTicket;
      patch({ selected: hit, messages: [], history: { prev: emptyDirection(), next: emptyDirection() } });
      await Promise.all([history('prev', true), history('next', true)]);
    },
    category(group: ServerSearchGroup) { configure({ type: groupTypes[group] }); return search(false); },
    reset() { ++epoch; ++id; ++searchTicket; ++historyTicket; activeQuery = null; port.publish({ ...EMPTY_SERVER_SEARCH }); },
    closeHistory() { ++historyTicket; patch({ selected: null, messages: [] }); },
  };
}
export type ServerSearchPanel = ReturnType<typeof createServerSearchPanel>;

export function serverSearchView(state: ServerSearchState, controller: ServerSearchPanel): HTMLElement {
  const bounds = searchDateBounds();
  const page = state.result;
  const historyButton = (direction: 'prev' | 'next', label: string) => {
    const part = state.history[direction];
    return h('div', { class: 'search-history-page' }, part.status === 'error' ? h('p', { role: 'alert' }, part.error, h('button', { class: 'btn sm', onclick: () => void controller.history(direction, part.cursor === null) }, t('searchRuntime.retry'))) : null,
      part.status === 'loading' ? h('span', { role: 'status' }, t('searchRuntime.loading')) : part.more ? h('button', { class: 'btn sm', onclick: () => void controller.history(direction) }, label) : null);
  };
  return h('section', { class: 'server-search', 'aria-label': t('searchRuntime.heading') },
    h('header', { class: 'search-toolbar' }, h('h2', null, t('searchRuntime.heading')),
      h('form', { onsubmit: (e: Event) => { e.preventDefault(); void controller.search(); } },
        h('select', { class: 'inp', 'aria-label': t('searchRuntime.scope'), value: String(state.type), onchange: (e: Event) => controller.configure({ type: Number((e.target as HTMLSelectElement).value) as ServerSearchType }) },
          ...([[3, t('searchRuntime.all')], [0, t('searchRuntime.content')], [1, t('searchRuntime.customerName')], [2, t('searchRuntime.orderId')], [4, t('searchRuntime.date')]] as const).map(([value, label]) => h('option', { value: String(value), selected: value === state.type }, label))),
        state.type === 4 ? h('span', { class: 'search-date-range' }, h('input', { class: 'inp', type: 'date', min: bounds.min, max: bounds.max, value: state.from, 'aria-label': t('searchRuntime.startDate'), onchange: (e: Event) => controller.configure({ from: (e.target as HTMLInputElement).value }) }), h('span', null, t('searchRuntime.dateTo')), h('input', { class: 'inp', type: 'date', min: bounds.min, max: bounds.max, value: state.to, 'aria-label': t('searchRuntime.endDate'), onchange: (e: Event) => controller.configure({ to: (e.target as HTMLInputElement).value }) })) : h('input', { class: 'inp', type: 'search', maxlength: '100', placeholder: t('searchRuntime.inputPlaceholder'), 'aria-label': t('searchRuntime.inputLabel'), value: state.text, dataset: { fid: 'server-search-text' }, oninput: (e: Event) => controller.configure({ text: (e.target as HTMLInputElement).value }) }),
        h('button', { class: 'btn pri', type: 'submit', disabled: state.status === 'loading' }, state.status === 'loading' ? t('searchRuntime.searching') : t('searchRuntime.search')))),
    h('div', { class: 'search-workspace' },
      h('div', { class: 'search-results' },
        state.status === 'error' ? h('p', { role: 'alert', class: 'notice-box err' }, state.error, h('button', { class: 'btn sm', onclick: () => void controller.search() }, t('searchRuntime.retry'))) : null,
        !page && state.status === 'idle' ? h('p', { class: 'muted' }, t('searchRuntime.idleHint')) : null,
        page ? groups.filter(group => page.search_type === 3 || groupTypes[group] === page.search_type).map(group => h('section', { class: 'search-group', dataset: { searchGroup: group } },
          h('h3', null, groupLabels[group], page.search_type === 3 && page.groups[group].length > 3 ? h('button', { class: 'link', onclick: () => void controller.category(group) }, t('searchRuntime.viewAll')) : null),
          page.groups[group].length ? (page.search_type === 3 ? page.groups[group].slice(0, 3) : page.groups[group]).map(hit => h('button', { class: `search-hit${state.selected?.selection_token === hit.selection_token ? ' on' : ''}`, onclick: () => void controller.pick(hit) }, h('strong', null, hit.title), h('time', null, new Date(hit.time_ms).toLocaleString()), h('span', null, hit.preview || t('searchRuntime.viewHistory')))) : h('p', { class: 'muted' }, t('searchRuntime.noResults')))) : null,
        page?.has_more ? h('button', { class: 'btn sm', disabled: state.status === 'loading', onclick: () => void controller.more() }, t('searchRuntime.moreResults')) : null),
      h('section', { class: 'search-history', 'aria-label': t('searchRuntime.historyLabel') }, state.selected ? [
        h('header', null, h('h3', null, state.selected.title), h('button', { class: 'btn sm', onclick: () => controller.closeHistory() }, t('searchRuntime.closeHistory'))),
        historyButton('prev', t('searchRuntime.earlierHistory')),
        h('div', { class: 'search-history-messages' }, ...state.messages.map(message => h('article', { class: `search-history-message${!!state.selected?.message_id && message.message_id === state.selected.message_id ? ' anchor' : ''}`, dataset: { searchMessage: message.message_id ?? '', anchor: String(!!state.selected?.message_id && message.message_id === state.selected.message_id) } },
          h('header', null, message.sender_name || message.sender_id || t('searchRuntime.message'), h('time', null, new Date(message.create_time_ms).toLocaleString())),
          message.kind === 'image' ? h('p', null, t('searchRuntime.image')) : message.kind === 'video' ? h('p', null, t('searchRuntime.video')) : message.kind === 'file' ? h('p', null, t('searchRuntime.file', { name: message.media_filename ?? message.text })) : h('p', null, message.text)))),
        state.history.prev.status === 'loaded' && state.history.next.status === 'loaded' && !state.messages.length ? h('p', { class: 'muted' }, t('searchRuntime.emptyHistory')) : null,
        historyButton('next', t('searchRuntime.laterHistory')),
      ] : h('p', { class: 'muted' }, t('searchRuntime.selectHint')))));
}
