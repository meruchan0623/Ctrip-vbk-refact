import { t } from '../../packages/ui-kit/src/i18n.ts';
import { sameAccountContext, type AccountContext } from '../../packages/ipc/src/contracts.ts';
import { UiCommands, type UiCustomerScripts, type UiQuickReplyCategories, type UiQuickReplyCategory, type UiQuickReplyScript } from '../../packages/ipc/src/client.ts';
import { h } from '../../packages/ui-kit/src/h.ts';
import { mountQuickReplyManager, type QuickReplyManager, type QuickReplyManagerOptions } from '../_shared/quick-reply-manager.ts';
import { errorMessage } from './viewmodel.ts';

export interface ReplyScope { readonly account: AccountContext; readonly gid: string; readonly revision: string }
export interface ReplyContext extends ReplyScope { readonly draft: string; readonly version: number }
export interface QuickRepliesState {
  readonly scope: ReplyScope;
  /** `categories` picks a reply, `manage` hosts the shared editor in the same dialog, `suggestions` is the inline list. */
  readonly mode: 'categories' | 'suggestions' | 'manage';
  readonly type: 'VAGENT' | 'VSKILLGROUP';
  readonly query: string;
  /** Selected top-level category; `null` is the all-groups view. A search always covers every group. */
  readonly group: string | null;
  readonly version: number;
  readonly categories: readonly UiQuickReplyCategory[];
  readonly items: readonly UiQuickReplyScript[];
  readonly busy: boolean;
  readonly error: string | null;
}
const scopeKey = (s: ReplyScope) => JSON.stringify([s.account.environment, s.account.account_id, s.account.session_generation, s.gid, s.revision]);
export function sameReplyScope(a: ReplyScope, b: ReplyScope | null): boolean { return !!b && scopeKey(a) === scopeKey(b); }
/** The modal reply dialog is up (picking or managing). Inline suggestions are not modal. */
export function replyDialogOpen(state: QuickRepliesState | null | undefined): boolean { return state?.mode === 'categories' || state?.mode === 'manage'; }
export function createQuickReplies(deps: {
  current(): ReplyContext | null;
  invoke(command: string, payload: unknown): Promise<unknown>;
  publish(state: QuickRepliesState | null): void;
  insert(text: string, replace: boolean): void;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
  /** Defaults to the shared manager; tests substitute a recorder. */
  mountManager?(host: HTMLElement, options: QuickReplyManagerOptions): QuickReplyManager;
  /** Shows a transient notice (the main window's toast). */
  notify?(text: string): void;
}) {
  let state: QuickRepliesState | null = null;
  let ticket = 0, timer: unknown = null;
  let manager: QuickReplyManager | null = null, managerHost: HTMLElement | null = null, mounts = 0;
  const publish = (s: QuickRepliesState | null) => { state = s; deps.publish(s); };
  function unmount() { const mounted = manager; manager = null; managerHost = null; mounts++; mounted?.destroy(); }
  /** Something other than the user closes the dialog (account, generation or conversation change): a write still out loses its result here, so say so. */
  function close() {
    const cut = state?.mode === 'manage' && !!manager?.busy();
    ticket++; if (timer !== null) deps.clearTimer(timer); timer = null; unmount(); publish(null);
    if (cut) try { deps.notify?.(t('repliesRuntime.manageInterrupted')); } catch { /* notice only */ }
  }
  /** The user closes the dialog (×, shade, Escape): refused while the editor's write is out, so its result is shown. */
  function dismiss(): boolean {
    if (state?.mode === 'manage' && manager?.busy()) return false;
    close();
    return true;
  }
  function valid(id: number, scope: ReplyScope) { return id === ticket && sameReplyScope(scope, deps.current()); }
  async function open(type: QuickRepliesState['type'] = 'VAGENT') {
    // Re-reading the same list keeps the selected group while it still has replies; another list starts at all groups.
    const group = state && state.mode !== 'suggestions' && state.type === type ? state.group : null;
    close();
    const context = deps.current(); if (!context) return;
    const id = ++ticket;
    publish({ scope: context, mode: 'categories', type, query: '', group, version: context.version, categories: [], items: [], busy: true, error: null });
    try {
      const result = await deps.invoke(UiCommands.IM_QUICK_REPLY_CATEGORIES, { account: context.account, type }) as UiQuickReplyCategories;
      if (!result || !Array.isArray(result.categories)) throw new Error(t('repliesRuntime.malformed'));
      if (valid(id, context) && state) publish({ ...state, categories: result.categories, group: keptGroup(result.categories, state.group), busy: false });
    } catch (error) { if (valid(id, context) && state) publish({ ...state, group: null, busy: false, error: errorMessage(error) }); }
  }
  function filter(query: string) { if (state?.mode === 'categories') publish({ ...state, query, group: null }); }
  /** Picking a group leaves the search, which always spans every group; the all-groups entry keeps it. */
  function selectGroup(group: string | null) {
    if (state?.mode !== 'categories' || (group !== null && keptGroup(state.categories, group) === null)) return;
    publish({ ...state, group, query: group === null ? state.query : '' });
  }
  function manage() {
    if (state?.mode !== 'categories' || !sameReplyScope(state.scope, deps.current())) return;
    ticket++; // a list read still in flight must not land in the editor
    const mount = ++mounts;
    const host = h('div', { class: 'reply-manage', dataset: { key: `reply-manage-${mount}` } });
    const live = () => mount === mounts && state?.mode === 'manage';
    managerHost = host;
    manager = (deps.mountManager ?? mountQuickReplyManager)(host, {
      invoke: (command, payload) => deps.invoke(command, payload),
      account: { ...state.scope.account }, type: state.type,
      onTypeChange: (type) => { if (live() && state && state.type !== type) publish({ ...state, type, group: null }); },
      // The picker's list is stale after a write; leaving the editor always re-reads it.
      onChanged: () => { if (live() && state) publish({ ...state, categories: [] }); },
      // Back and close are locked while a write is out (see `dismiss`).
      onBusyChange: (busy) => { if (live() && state) publish({ ...state, busy }); },
    });
    publish({ ...state, mode: 'manage', query: '', busy: false, error: null });
  }
  function back(): Promise<void> {
    if (state?.mode !== 'manage' || manager?.busy()) return Promise.resolve();
    unmount();
    return open(state.type);
  }
  /** The editor follows the live context: a new identity or generation rebinds it instead of editing the old account. */
  function sync() {
    if (state?.mode !== 'manage' || !manager) return;
    const context = deps.current();
    // No reply context (the conversation was transferred out, the account went offline): the dialog cannot be shown, so it must not stay open and keep the page covered.
    if (!context) { close(); return; }
    if (sameReplyScope(state.scope, context)) return;
    if (!sameAccountContext(state.scope.account, context.account)) manager.setAccount({ ...context.account });
    publish({ ...state, scope: context, version: context.version });
  }
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
        publish({ scope: context, mode: 'suggestions', type: 'VAGENT', query: context.draft, group: null, version: context.version, categories: [], items: result.items, busy: false, error: null });
      }).catch(() => { /* Optional suggestions must not interrupt composition. */ });
    }, 200);
  }
  function select(item: UiQuickReplyScript) {
    if (!state || state.mode === 'manage' || !sameReplyScope(state.scope, deps.current())) return;
    const replace = state.mode === 'suggestions';
    if (replace && deps.current()?.version !== state.version) return;
    const all = replace ? state.items : flattenReplyCategories(state.categories).flatMap(c => c.scripts);
    if (!all.some(x => x.id === item.id && x.content === item.content)) return;
    close(); deps.insert(item.content, replace);
  }
  return { open, close, dismiss, filter, selectGroup, manage, back, sync, managerHost: () => managerHost, suggest, select };
}

export function flattenReplyCategories(categories: readonly UiQuickReplyCategory[]): UiQuickReplyCategory[] {
  return categories.flatMap(c => [c, ...flattenReplyCategories(c.sub_categories)]);
}
// Groups are the top-level categories that hold at least one reply in their subtree.
let groupIndex: { categories: readonly UiQuickReplyCategory[]; groups: UiQuickReplyCategory[]; members: Map<string, ReadonlySet<string>> } | null = null;
function groupIndexOf(categories: readonly UiQuickReplyCategory[]) {
  if (!groupIndex || groupIndex.categories !== categories) {
    const groups: UiQuickReplyCategory[] = [], members = new Map<string, ReadonlySet<string>>();
    for (const category of categories) {
      const subtree = flattenReplyCategories([category]);
      if (!subtree.some(c => c.scripts.length)) continue;
      groups.push(category); members.set(category.id, new Set(subtree.map(c => c.id)));
    }
    groupIndex = { categories, groups, members };
  }
  return groupIndex;
}
export function replyGroups(categories: readonly UiQuickReplyCategory[]): readonly UiQuickReplyCategory[] { return groupIndexOf(categories).groups; }
function keptGroup(categories: readonly UiQuickReplyCategory[], group: string | null): string | null {
  return group !== null && groupIndexOf(categories).members.has(group) ? group : null;
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
  const managing = state.mode === 'manage';
  const dismiss = () => { controller.dismiss(); };
  const locked = managing && state.busy;
  return h('div', { class: 'shade', onclick: dismiss }, h('div', {
    class: 'dlg replies-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': managing ? t('repliesRuntime.manageHeading') : t('repliesRuntime.heading'), tabindex: '-1',
    dataset: { commerceDialog: 'replies', mode: state.mode }, onclick: (e: Event) => e.stopPropagation(),
    // Escape in the editor's name or content field cancels that form only; elsewhere (a checkbox, the move menu) it still closes the dialog.
    onkeydown: (e: KeyboardEvent) => { if (managing && e.key === 'Escape' && (e.target as Element | null)?.getAttribute?.('data-fid')?.startsWith('qrm-')) e.stopPropagation(); },
  },
    h('div', { class: 'dlg-h' }, h('span', null, managing ? t('repliesRuntime.manageHeading') : t('repliesRuntime.heading')),
      h('div', { class: 'reply-head-actions' },
        managing ? h('button', { class: 'btn sm reply-head-btn', type: 'button', disabled: locked, dataset: { action: 'reply-back' }, onclick: () => void controller.back() }, t('repliesRuntime.back'))
          : h('button', { class: 'btn sm reply-head-btn', type: 'button', dataset: { action: 'reply-manage' }, onclick: controller.manage }, t('repliesRuntime.manage')),
        h('button', { class: 'ibtn', 'aria-label': t('repliesRuntime.close'), disabled: locked, onclick: dismiss }, '×'))),
    managing ? h('div', { class: 'reply-manage-body' }, controller.managerHost()) : pickerView(state, controller)));
}
function pickerView(state: QuickRepliesState, controller: ReturnType<typeof createQuickReplies>): Node[] {
  const query = state.query.trim().toLocaleLowerCase();
  const index = groupIndexOf(state.categories);
  const members = query || state.group === null ? null : index.members.get(state.group) ?? null;
  const selected = members ? state.group : null;
  const all = filteredReplyCategories(state.categories, query);
  const sections = members ? all.filter(c => members.has(c.id)) : all;
  const count = sections.reduce((total, section) => total + section.scripts.length, 0);
  const groupButton = (id: string | null, name: string) => h('button', {
    class: 'reply-group', type: 'button', title: name, 'aria-pressed': String(selected === id),
    dataset: id === null ? { key: 'reply-group-all', replyGroupAll: '1' } : { key: `reply-group:${id}`, replyGroup: id }, onclick: () => controller.selectGroup(id),
  }, name);
  return [
    h('div', { class: 'reply-toolbar' },
      h('div', { class: 'reply-tabs', role: 'group', 'aria-label': t('repliesRuntime.source') }, (['VAGENT', 'VSKILLGROUP'] as const).map(type => h('button', { class: 'reply-tab', type: 'button', 'aria-pressed': String(state.type === type), onclick: () => void controller.open(type) }, type === 'VAGENT' ? t('repliesRuntime.personal') : t('repliesRuntime.team')))),
      h('input', { class: 'inp reply-search', type: 'search', 'aria-label': t('repliesRuntime.searchLabel'), placeholder: t('repliesRuntime.searchPlaceholder'), value: state.query, dataset: { fid: 'reply-search' }, oninput: (e: Event) => controller.filter((e.target as HTMLInputElement).value) }),
      h('button', { class: 'btn reply-refresh', disabled: state.busy, onclick: () => void controller.open(state.type) }, t('repliesRuntime.refresh'))),
    h('div', { class: 'reply-main' },
      h('div', { class: 'reply-groups', role: 'group', 'aria-label': t('repliesRuntime.groups') },
        groupButton(null, t('repliesRuntime.allGroups')), index.groups.map(c => groupButton(c.id, c.name))),
      h('div', { class: 'reply-body', 'aria-busy': String(state.busy), dataset: { keepScroll: 'quick-replies' } },
        state.busy ? h('p', { class: 'reply-empty', role: 'status' }, t('repliesRuntime.loading'))
          : state.error ? h('p', { class: 'reply-empty', role: 'alert' }, state.error)
          : sections.length ? h('div', { class: 'reply-masonry' }, sections.flatMap(c => c.scripts.map(item =>
            h('button', { class: 'reply-choice reply-card', type: 'button', dataset: { replyId: item.id }, title: t('repliesRuntime.insert'), onclick: () => controller.select(item) },
              // Inside one group the group name is already selected on the left; all groups keep the label.
              !selected || item.short_cut ? h('span', { class: 'reply-card-heading' }, selected ? null : h('span', { class: 'reply-card-category' }, c.name), item.short_cut ? h('span', { class: 'reply-shortcut' }, item.short_cut) : null) : null,
              h('span', { class: 'reply-card-content' }, item.content)))))
          : h('p', { class: 'reply-empty', role: 'status' }, state.query ? t('repliesRuntime.noMatches') : t('repliesRuntime.empty')))),
    h('div', { class: 'reply-footer' }, h('span', { role: 'status' }, state.busy || state.error ? '' : t('repliesRuntime.count', { count })), h('span', null, t('repliesRuntime.insertHint'))),
  ];
}
