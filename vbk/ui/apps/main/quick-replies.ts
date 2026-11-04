import { t } from '../../packages/ui-kit/src/i18n.ts';
import type { AccountContext } from '../../packages/ipc/src/contracts.ts';
import { UiCommands, type UiCustomerScripts, type UiQuickReplyCategories, type UiQuickReplyCategory, type UiQuickReplyScript } from '../../packages/ipc/src/client.ts';
import { h } from '../../packages/ui-kit/src/h.ts';
import { errorMessage } from './viewmodel.ts';

export interface ReplyScope { readonly account: AccountContext; readonly gid: string; readonly revision: string }
export interface ReplyContext extends ReplyScope { readonly draft: string; readonly version: number }
export interface QuickRepliesState {
  readonly scope: ReplyScope;
  readonly mode: 'categories' | 'suggestions';
  readonly type: 'VAGENT' | 'VSKILLGROUP';
  readonly query: string;
  readonly version: number;
  readonly categories: readonly UiQuickReplyCategory[];
  readonly items: readonly UiQuickReplyScript[];
  readonly busy: boolean;
  readonly error: string | null;
}
const scopeKey = (s: ReplyScope) => JSON.stringify([s.account.environment, s.account.account_id, s.account.session_generation, s.gid, s.revision]);
export function sameReplyScope(a: ReplyScope, b: ReplyScope | null): boolean { return !!b && scopeKey(a) === scopeKey(b); }
export function createQuickReplies(deps: {
  current(): ReplyContext | null;
  invoke(command: string, payload: unknown): Promise<unknown>;
  publish(state: QuickRepliesState | null): void;
  insert(text: string, replace: boolean): void;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
}) {
  let state: QuickRepliesState | null = null;
  let ticket = 0, timer: unknown = null;
  const publish = (s: QuickRepliesState | null) => { state = s; deps.publish(s); };
  function close() { ticket++; if (timer !== null) deps.clearTimer(timer); timer = null; publish(null); }
  function valid(id: number, scope: ReplyScope) { return id === ticket && sameReplyScope(scope, deps.current()); }
  async function open(type: QuickRepliesState['type'] = 'VAGENT') {
    close();
    const context = deps.current(); if (!context) return;
    const id = ++ticket;
    publish({ scope: context, mode: 'categories', type, query: '', version: context.version, categories: [], items: [], busy: true, error: null });
    try {
      const result = await deps.invoke(UiCommands.IM_QUICK_REPLY_CATEGORIES, { account: context.account, type }) as UiQuickReplyCategories;
      if (!result || !Array.isArray(result.categories)) throw new Error(t('repliesRuntime.malformed'));
      if (valid(id, context) && state) publish({ ...state, categories: result.categories, busy: false });
    } catch (error) { if (valid(id, context) && state) publish({ ...state, busy: false, error: errorMessage(error) }); }
  }
  function filter(query: string) { if (state?.mode === 'categories') publish({ ...state, query }); }
  function suggest() {
    close();
    const context = deps.current();
    if (!context?.draft.trim()) return;
    const id = ++ticket;
    timer = deps.setTimer(() => {
      timer = null;
      if (!valid(id, context) || deps.current()?.version !== context.version) return;
      void deps.invoke(UiCommands.IM_CUSTOMER_SCRIPTS, { account: context.account, content: context.draft.trim() }).then((raw) => {
        if (!valid(id, context) || deps.current()?.version !== context.version) return;
        const result = raw as UiCustomerScripts;
        if (result?.kind !== 'ready' || !result.items?.length) return;
        publish({ scope: context, mode: 'suggestions', type: 'VAGENT', query: context.draft, version: context.version, categories: [], items: result.items, busy: false, error: null });
      }).catch(() => { /* Optional suggestions must not interrupt composition. */ });
    }, 200);
  }
  function select(item: UiQuickReplyScript) {
    if (!state || !sameReplyScope(state.scope, deps.current())) return;
    const replace = state.mode === 'suggestions';
    if (replace && deps.current()?.version !== state.version) return;
    const all = replace ? state.items : flattenReplyCategories(state.categories).flatMap(c => c.scripts);
    if (!all.some(x => x.id === item.id && x.content === item.content)) return;
    close(); deps.insert(item.content, replace);
  }
  return { open, close, filter, suggest, select };
}

export function flattenReplyCategories(categories: readonly UiQuickReplyCategory[]): UiQuickReplyCategory[] {
  return categories.flatMap(c => [c, ...flattenReplyCategories(c.sub_categories)]);
}
// Category snapshots are immutable. Retain only the current tree and query.
let replyIndex: { categories: readonly UiQuickReplyCategory[]; groups: { category: UiQuickReplyCategory; scripts: { item: UiQuickReplyScript; text: string; shortcut: string }[] }[]; query: string | null; result: UiQuickReplyCategory[] } | null = null;
export function filteredReplyCategories(categories: readonly UiQuickReplyCategory[], query: string): UiQuickReplyCategory[] {
  if (!replyIndex || replyIndex.categories !== categories) {
    replyIndex = { categories, groups: flattenReplyCategories(categories).map(category => ({ category, scripts: category.scripts.map(item => ({ item, text: item.content.toLocaleLowerCase(), shortcut: item.short_cut.toLocaleLowerCase() })) })), query: null, result: [] };
  }
  const normalized = query.trim().toLocaleLowerCase();
  if (replyIndex.query !== normalized) {
    replyIndex.result = replyIndex.groups.map(({ category, scripts }) => ({ ...category, scripts: scripts.filter(({ text, shortcut }) => !normalized || text.includes(normalized) || shortcut.includes(normalized)).map(({ item }) => item) })).filter(category => category.scripts.length);
    replyIndex.query = normalized;
  }
  return replyIndex.result;
}
export function quickRepliesView(state: QuickRepliesState | null, context: ReplyContext | null, controller: ReturnType<typeof createQuickReplies>): HTMLElement | null {
  if (!state || !sameReplyScope(state.scope, context)) return null;
  const row = (item: UiQuickReplyScript) => h('button', { class: 'reply-choice', type: 'button', dataset: { replyId: item.id }, onclick: () => controller.select(item) }, item.content);
  if (state.mode === 'suggestions') return h('div', { class: 'reply-suggestions', 'aria-label': t('repliesRuntime.suggestions') },
    h('button', { class: 'ibtn reply-dismiss', 'aria-label': t('repliesRuntime.closeSuggestions'), onclick: controller.close }, '×'), state.items.map(row));
  const query = state.query.trim().toLocaleLowerCase();
  const groups = filteredReplyCategories(state.categories, query);
  const count = groups.reduce((total, group) => total + group.scripts.length, 0);
  return h('div', { class: 'shade', onclick: controller.close }, h('div', { class: 'dlg replies-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('repliesRuntime.heading'), tabindex: '-1', dataset: { commerceDialog: 'replies' }, onclick: (e: Event) => e.stopPropagation() },
    h('div', { class: 'dlg-h' }, h('span', null, t('repliesRuntime.heading')), h('button', { class: 'ibtn', 'aria-label': t('repliesRuntime.close'), onclick: controller.close }, '×')),
    h('div', { class: 'reply-toolbar' },
      h('div', { class: 'reply-tabs', role: 'group', 'aria-label': t('repliesRuntime.source') }, (['VAGENT', 'VSKILLGROUP'] as const).map(type => h('button', { class: 'reply-tab', type: 'button', 'aria-pressed': String(state.type === type), onclick: () => void controller.open(type) }, type === 'VAGENT' ? t('repliesRuntime.personal') : t('repliesRuntime.team')))),
      h('input', { class: 'inp reply-search', type: 'search', 'aria-label': t('repliesRuntime.searchLabel'), placeholder: t('repliesRuntime.searchPlaceholder'), value: state.query, dataset: { fid: 'reply-search' }, oninput: (e: Event) => controller.filter((e.target as HTMLInputElement).value) }),
      h('button', { class: 'btn reply-refresh', disabled: state.busy, onclick: () => void controller.open(state.type) }, t('repliesRuntime.refresh'))),
    h('div', { class: 'reply-body', 'aria-busy': String(state.busy), dataset: { keepScroll: 'quick-replies' } },
      state.busy ? h('p', { class: 'reply-empty', role: 'status' }, t('repliesRuntime.loading'))
        : state.error ? h('p', { class: 'reply-empty', role: 'alert' }, state.error)
        : groups.length ? h('div', { class: 'reply-masonry' }, groups.flatMap(c => c.scripts.map(item =>
          h('button', { class: 'reply-choice reply-card', type: 'button', dataset: { replyId: item.id }, title: t('repliesRuntime.insert'), onclick: () => controller.select(item) },
            h('span', { class: 'reply-card-heading' }, h('span', { class: 'reply-card-category' }, c.name), item.short_cut ? h('span', { class: 'reply-shortcut' }, item.short_cut) : null),
            h('span', { class: 'reply-card-content' }, item.content)))))
        : h('p', { class: 'reply-empty', role: 'status' }, state.query ? t('repliesRuntime.noMatches') : t('repliesRuntime.empty'))),
    h('div', { class: 'reply-footer' }, h('span', { role: 'status' }, state.busy || state.error ? '' : t('repliesRuntime.count', { count })), h('span', null, t('repliesRuntime.insertHint')))));
}
