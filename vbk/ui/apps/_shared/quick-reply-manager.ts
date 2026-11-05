/**
 * Shared quick-reply manager: the official "个人设置 → 快捷回复" editor, mounted by
 * the main-window reply popup and by the settings window. It depends only on the
 * `invoke` and `account` it is given (no `../main/` imports), so both windows can
 * host it.
 *
 * API
 *
 *   mountQuickReplyManager(host, {
 *     invoke,        // (command, payload?) => Promise<unknown>: the window's IPC invoke
 *     account,       // AccountContext | null: bound by account_id + environment + session_generation
 *     type?,         // 'VAGENT' (personal, default) | 'VSKILLGROUP' (team)
 *     onChanged?,    // ({ account, type, categories }) after an `applied` or `unknown` write;
 *                    //   `categories` is the read-back list, or null when the manager re-reads
 *     onTypeChange?, // (type) after the user switches the personal/team tab
 *     onBusyChange?, // (busy) when a write goes out or settles; the host locks whatever would
 *                    //   drop its result (closing the editor, switching the account)
 *   }) → {
 *     setAccount(account | null), // new identity or generation: drops forms, confirms and
 *                                 //   in-flight results, then re-reads; same context is a no-op
 *     setType(type),              // same reset + re-read for the other list
 *     refresh(): Promise<void>,   // re-read list + manage info (resolves when settled or discarded)
 *     busy(): boolean,            // a write is out: setAccount/setType/destroy would drop its result
 *     destroy(),                  // empties `host`; late results are ignored
 *   }
 *
 * The manager owns `host`'s children and re-renders them with `rerender(..., {morph: true})`.
 * Styles: `quick-reply-manager.css` (`.qrm*`), built on the shared tokens and `base.css` buttons.
 *
 * Commands: `im_quick_reply_categories` / `im_quick_reply_manage_info` ({account, type}) and
 * `im_quick_reply_edit` ({account, type, edit}). One write at a time; every control is
 * disabled while it is out. Outcomes:
 *  - applied: adopt the read-back list (re-read when the host sent none);
 *  - rejected: roll back to the read-back list or the pre-write list, explain the reason;
 *  - unknown (also a malformed answer, a timeout or a non-AppError throw): never resend, adopt
 *    the read-back list or re-read, ask the user to check it. No retry control.
 * A thrown AppError means nothing was sent (host contract): roll back, "未提交，可重试".
 * Reordering (native HTML5 drag and drop) is applied optimistically; see `moveItem`.
 */
import { t } from '../../packages/ui-kit/src/i18n.ts';
import { h, rerender } from '../../packages/ui-kit/src/h.ts';
import {
  UiCommands,
  type UiQuickReplyCategory,
  type UiQuickReplyEdit,
  type UiQuickReplyManageInfo,
  type UiQuickReplyScript,
  type UiQuickReplySkillGroup,
  type UiQuickReplyType,
} from '../../packages/ipc/src/client.ts';
import { ErrorCodes, isAppError, sameAccountContext, type AccountContext } from '../../packages/ipc/src/contracts.ts';

/** Official limits (adapter `validateEdit`): trimmed name 1–15, trimmed content 1–5000 (UTF-16 units). */
export const QUICK_REPLY_NAME_MAX = 15;
export const QUICK_REPLY_CONTENT_MAX = 5000;

export interface QuickReplyChange {
  readonly account: AccountContext;
  readonly type: UiQuickReplyType;
  readonly categories: readonly UiQuickReplyCategory[] | null;
}

export interface QuickReplyManagerOptions {
  invoke(command: string, payload?: unknown): Promise<unknown>;
  readonly account: AccountContext | null;
  readonly type?: UiQuickReplyType;
  onChanged?(change: QuickReplyChange): void;
  onTypeChange?(type: UiQuickReplyType): void;
  onBusyChange?(busy: boolean): void;
}

export interface QuickReplyManager {
  setAccount(account: AccountContext | null): void;
  setType(type: UiQuickReplyType): void;
  refresh(): Promise<void>;
  busy(): boolean;
  destroy(): void;
}

/**
 * Moves `list[from]` to index `to` (clamped into range) and returns a new array.
 * Out-of-range or non-integer `from`, non-integer `to`, or a move onto itself returns an
 * unchanged copy. Dropping on a row puts the dragged item at that row's index.
 */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const out = [...list];
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from >= out.length) return out;
  const target = Math.min(Math.max(to, 0), out.length - 1);
  if (target === from) return out;
  const [item] = out.splice(from, 1);
  out.splice(target, 0, item as T);
  return out;
}

// ------------------------------------------------------------------ guards

type Rec = Readonly<Record<string, unknown>>;
const rec = (x: unknown): Rec | null => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Rec) : null);
const isText = (x: unknown): x is string => typeof x === 'string';
const LIST_MAX = 1000;

function isSkillGroup(x: unknown): x is UiQuickReplySkillGroup {
  const r = rec(x);
  return !!r && isText(r['id']) && isText(r['name']);
}
function isScript(x: unknown): x is UiQuickReplyScript {
  const r = rec(x);
  return !!r && isText(r['id']) && isText(r['content']);
}
function uniqueIds(list: readonly { readonly id: string }[]): boolean {
  return new Set(list.map(x => x.id)).size === list.length;
}
function isCategory(x: unknown, depth: number): x is UiQuickReplyCategory {
  const r = rec(x);
  if (!r || depth > 8 || !isText(r['id']) || !isText(r['name'])) return false;
  const scripts = r['scripts'], groups = r['skill_groups'], subs = r['sub_categories'];
  if (!Array.isArray(scripts) || scripts.length > LIST_MAX || !scripts.every(isScript) || !uniqueIds(scripts)) return false;
  if (groups !== undefined && groups !== null && !(Array.isArray(groups) && groups.every(isSkillGroup))) return false;
  return subs === undefined || (Array.isArray(subs) && subs.length <= LIST_MAX && subs.every(s => isCategory(s, depth + 1)));
}
function categoryList(x: unknown): readonly UiQuickReplyCategory[] | null {
  return Array.isArray(x) && x.length <= LIST_MAX && x.every(c => isCategory(c, 0)) && uniqueIds(x) ? x : null;
}
function manageInfo(x: unknown): UiQuickReplyManageInfo | null {
  const r = rec(x), groups = r?.['skill_groups'];
  return r && typeof r['can_edit'] === 'boolean' && Array.isArray(groups) && groups.every(isSkillGroup) ? (r as unknown as UiQuickReplyManageInfo) : null;
}

const scriptsOf = (c: UiQuickReplyCategory): readonly UiQuickReplyScript[] => c.scripts;
const subsOf = (c: UiQuickReplyCategory): readonly UiQuickReplyCategory[] => c.sub_categories ?? [];
/** What a delete removes: the adapter's server-row total when present (the list may be shorter), else the listed rows. */
function countScripts(c: UiQuickReplyCategory): number {
  const listed = listedScripts(c);
  const total = c.script_total;
  return typeof total === 'number' && Number.isSafeInteger(total) && total >= listed ? total : listed;
}
const listedScripts = (c: UiQuickReplyCategory): number => scriptsOf(c).length + subsOf(c).reduce((n, s) => n + listedScripts(s), 0);
const sameOrder = (a: readonly { id: string }[], b: readonly { id: string }[]) => a.length === b.length && a.every((x, i) => x.id === b[i]?.id);
const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every(x => b.includes(x));
/** Business codes are shown only when they look like codes, never as free text. */
const DETAIL_CODE = /^[A-Za-z0-9_.:-]{1,64}$/;

// ------------------------------------------------------------------ state

type Form =
  | { kind: 'create_category'; name: string; groups: string[]; error: string | null }
  | { kind: 'rename_category'; id: string; name: string; groups: string[]; error: string | null }
  | { kind: 'add_script'; categoryId: string; content: string; error: string | null }
  | { kind: 'edit_script'; id: string; content: string; error: string | null };
type CategoryForm = Extract<Form, { kind: 'create_category' | 'rename_category' }>;
type ScriptForm = Extract<Form, { kind: 'add_script' | 'edit_script' }>;
/** Name and count are read from the current list at render time, so a re-read never shows a stale count. */
type Confirm = { readonly kind: 'category' | 'script'; readonly id: string };
type Notice = { readonly tone: 'warn' | 'error'; readonly text: string };
type DragKind = 'category' | 'script';

const FID_NAME = 'qrm-name', FID_CONTENT = 'qrm-content';

export function mountQuickReplyManager(host: HTMLElement, opts: QuickReplyManagerOptions): QuickReplyManager {
  let account: AccountContext | null = opts.account;
  let type: UiQuickReplyType = opts.type ?? 'VAGENT';
  let categories: readonly UiQuickReplyCategory[] | null = null;
  let info: UiQuickReplyManageInfo | null = null;
  let selected: string | null = null;
  let loading = false, loadError = false, busy = false, destroyed = false;
  /**
   * A write settled without a list (unknown, or applied with no read-back): the pre-write list is
   * not shown again, nothing is editable until a re-read lands, and a failed re-read says so.
   */
  let unverified = false;
  /** The pre-write list of a `create_category` whose result came without a list: the re-read selects the new group. */
  let createdFrom: readonly UiQuickReplyCategory[] | null = null;
  let form: Form | null = null, confirm: Confirm | null = null, notice: Notice | null = null;
  let drag: { readonly kind: DragKind; readonly id: string } | null = null;
  let focusFid: string | null = null;
  /** `scope` changes with the account/type binding, `reads` with every read; results carry both. */
  let scope = 0, reads = 0;

  const editable = () => !!account && !!categories && info?.can_edit === true;
  function setBusy(next: boolean): void {
    if (busy === next) return;
    busy = next;
    try { opts.onBusyChange?.(next); } catch { /* the host window's callback must not break the editor */ }
  }
  const findCategory = (id: string) => categories?.find(c => c.id === id) ?? null;
  const findScript = (id: string) => {
    for (const c of categories ?? []) for (const s of scriptsOf(c)) if (s.id === id) return s;
    return null;
  };

  function render(): void {
    if (destroyed) return;
    rerender(host, view, { morph: true });
    if (focusFid) {
      const target = host.querySelector<HTMLElement>(`[data-fid="${focusFid}"]`);
      focusFid = null;
      target?.focus();
    }
  }

  function reset(): void {
    scope++; reads++;
    categories = null; info = null; selected = null;
    loading = false; loadError = false; unverified = false; createdFrom = null;
    form = null; confirm = null; notice = null; drag = null;
    setBusy(false);
  }

  function adopt(list: readonly UiQuickReplyCategory[], prefer: string | null = null): void {
    categories = list;
    if (prefer && list.some(c => c.id === prefer)) selected = prefer;
    else if (!selected || !list.some(c => c.id === selected)) selected = list[0]?.id ?? null;
    if (form) {
      const gone = form.kind === 'rename_category' ? !findCategory(form.id)
        : form.kind === 'add_script' ? form.categoryId !== selected || !findCategory(form.categoryId)
        : form.kind === 'edit_script' ? !findScript(form.id) : false;
      if (gone) form = null;
    }
    if (confirm && !(confirm.kind === 'category' ? findCategory(confirm.id) : findScript(confirm.id))) confirm = null;
  }

  async function refresh(): Promise<void> {
    if (destroyed) return;
    const acct = account;
    if (!acct) { render(); return; }
    const s = scope, ticket = ++reads, kind = type;
    loading = true; loadError = false;
    render();
    let list: readonly UiQuickReplyCategory[] | null = null, manage: UiQuickReplyManageInfo | null = null;
    try {
      const [read, meta] = await Promise.all([
        opts.invoke(UiCommands.IM_QUICK_REPLY_CATEGORIES, { account: acct, type: kind }),
        opts.invoke(UiCommands.IM_QUICK_REPLY_MANAGE_INFO, { account: acct, type: kind }),
      ]);
      list = categoryList(rec(read)?.['categories']);
      manage = manageInfo(meta);
    } catch { list = null; }
    if (destroyed || s !== scope || ticket !== reads) return;
    loading = false;
    if (!list || !manage) {
      loadError = true;
      if (unverified) notice = { tone: 'warn', text: t('qrManage.result.unknownUnread') };
      render();
      return;
    }
    info = manage;
    // A write that is out will bring a newer list (or re-read) when it settles.
    if (!busy) {
      const from = createdFrom;
      // The list now on screen is the server's: an unconfirmed write still needs checking against it.
      if (unverified) notice = { tone: 'warn', text: t('qrManage.result.unknown') };
      createdFrom = null; unverified = false;
      adopt(list, from ? list.find(c => !from.some(b => b.id === c.id))?.id ?? null : null);
    }
    render();
  }

  function changed(list: readonly UiQuickReplyCategory[] | null, acct: AccountContext, kind: UiQuickReplyType): void {
    try { opts.onChanged?.({ account: acct, type: kind, categories: list }); } catch { /* the host window's callback must not break the editor */ }
  }

  function rejectedNotice(reason: unknown, detail: unknown): Notice {
    switch (reason) {
      case 'busy': return { tone: 'warn', text: t('qrManage.result.busy') };
      case 'not_leader': return { tone: 'warn', text: t('qrManage.readonlyTeam') };
      case 'stale': return { tone: 'warn', text: t('qrManage.result.stale') };
      case 'auth': return { tone: 'error', text: t('qrManage.result.auth') };
      case 'business':
        return { tone: 'error', text: isText(detail) && DETAIL_CODE.test(detail) ? t('qrManage.result.businessCode', { code: detail }) : t('qrManage.result.business') };
      case 'invalid': return { tone: 'error', text: t('qrManage.result.invalid') };
      default: return { tone: 'error', text: t('qrManage.result.notSubmitted') };
    }
  }

  /** Runs one write. `optimistic` is shown while it is out and rolled back unless applied. */
  async function run(edit: UiQuickReplyEdit, optimistic?: readonly UiQuickReplyCategory[]): Promise<void> {
    const acct = account, before = categories;
    if (!acct || !before || busy || !editable()) return;
    const s = scope, kind = type;
    notice = null;
    if (optimistic) categories = optimistic;
    setBusy(true);
    render();
    let answer: unknown, thrown: unknown, threw = false;
    try { answer = await opts.invoke(UiCommands.IM_QUICK_REPLY_EDIT, { account: acct, type: kind, edit }); }
    catch (e) { threw = true; thrown = e; }
    if (destroyed || s !== scope) return;
    setBusy(false);
    // Any read still out started before this write's read-back: drop it.
    reads++; loading = false;
    const created = edit.op === 'create_category';
    const preferNew = (list: readonly UiQuickReplyCategory[]) => (created ? list.find(c => !before.some(b => b.id === c.id))?.id ?? null : null);

    /** No list came back: the pre-write list may be wrong, so it is not shown (or editable) again until a re-read lands. */
    const reread = (uncertain: boolean) => {
      categories = null; unverified = uncertain; createdFrom = created ? before : null;
      void refresh();
    };
    const settleUnknown = (list: readonly UiQuickReplyCategory[] | null) => {
      form = null; confirm = null;
      notice = { tone: 'warn', text: t('qrManage.result.unknown') };
      changed(list, acct, kind);
      if (list) { adopt(list, preferNew(list)); render(); } else reread(true);
    };

    if (threw) {
      const timedOut = isAppError(thrown) && (thrown.code === ErrorCodes.ADAPTER_TIMEOUT || thrown.code === ErrorCodes.NET_TIMEOUT);
      if (!isAppError(thrown) || timedOut) { settleUnknown(null); return; }
      adopt(before); confirm = null;
      notice = thrown.code === ErrorCodes.ACCOUNT_TICKET_EXPIRED ? { tone: 'error', text: t('qrManage.result.auth') } : { tone: 'error', text: t('qrManage.result.notSubmitted') };
      render();
      return;
    }
    const r = rec(answer);
    const kindOf = r?.['kind'];
    const hasList = r !== null && r['categories'] !== undefined;
    const list = hasList ? categoryList(r['categories']) : null;
    if (!r || (kindOf !== 'applied' && kindOf !== 'rejected' && kindOf !== 'unknown') || (hasList && !list)) { settleUnknown(null); return; }
    if (kindOf === 'unknown') { settleUnknown(list); return; }
    if (kindOf === 'applied') {
      form = null; confirm = null;
      changed(list, acct, kind);
      if (list) { adopt(list, preferNew(list)); render(); } else reread(false);
      return;
    }
    // rejected: nothing changed on the server.
    const reason = r['reason'];
    adopt(list ?? before);
    confirm = null;
    if (reason === 'not_leader' && info) info = { ...info, can_edit: false };
    if (reason === 'not_leader' || reason === 'stale') form = null;
    notice = rejectedNotice(reason, r['detail']);
    if (reason === 'stale' && !list) void refresh(); else render();
  }

  // ---------------------------------------------------------------- actions

  function setForm(next: Form | null, fid: string | null): void {
    if (busy) return;
    form = next; confirm = null; focusFid = fid;
    render();
  }
  const teamGroups = () => (type === 'VSKILLGROUP' ? info?.skill_groups ?? [] : []);

  function saveCategory(f: CategoryForm): void {
    if (busy) return;
    const name = f.name.trim(), team = type === 'VSKILLGROUP';
    const offered = teamGroups().map(g => g.id), groups = team ? f.groups.filter(id => offered.includes(id)) : [];
    f.error = !name ? t('qrManage.validate.nameRequired')
      : name.length > QUICK_REPLY_NAME_MAX ? t('qrManage.validate.nameTooLong', { max: QUICK_REPLY_NAME_MAX })
      : team && groups.length === 0 ? t('qrManage.validate.scopeRequired') : null;
    if (f.error) { render(); return; }
    if (f.kind === 'create_category') { void run({ op: 'create_category', name, skill_group_ids: groups }); return; }
    const current = findCategory(f.id);
    if (!current) { form = null; render(); return; }
    const was = team ? (current.skill_groups ?? []).map(g => g.id) : [];
    if (name === current.name && sameSet(groups, was)) { form = null; render(); return; }
    void run({ op: 'update_category', category_id: f.id, name, skill_group_ids: groups });
  }

  function saveScript(f: ScriptForm): void {
    if (busy) return;
    const content = f.content.trim();
    f.error = !content ? t('qrManage.validate.contentRequired')
      : content.length > QUICK_REPLY_CONTENT_MAX ? t('qrManage.validate.contentTooLong', { max: QUICK_REPLY_CONTENT_MAX }) : null;
    if (f.error) { render(); return; }
    if (f.kind === 'add_script') { void run({ op: 'add_script', category_id: f.categoryId, content }); return; }
    const current = findScript(f.id);
    if (!current || current.content.trim() === content) { form = null; render(); return; }
    void run({ op: 'update_script', script_id: f.id, content });
  }

  function askDelete(next: Confirm): void {
    if (busy) return;
    confirm = next; form = null;
    render();
  }

  function confirmDelete(): void {
    const c = confirm;
    if (!c || busy) return;
    void run(c.kind === 'category' ? { op: 'delete_category', category_id: c.id } : { op: 'delete_script', script_id: c.id });
  }

  function select(id: string): void {
    if (busy || id === selected) return;
    selected = id;
    if (form && (form.kind === 'add_script' || form.kind === 'edit_script')) form = null;
    if (confirm?.kind === 'script') confirm = null;
    render();
  }

  function moveScript(scriptId: string, target: string): void {
    if (busy || !findCategory(target)) return;
    void run({ op: 'move_script', script_id: scriptId, target_category_id: target });
  }

  function reorder(kind: DragKind, fromId: string, toId: string): void {
    const list = categories;
    if (!list || busy || !editable() || fromId === toId) return;
    if (kind === 'category') {
      const next = moveItem(list, list.findIndex(c => c.id === fromId), list.findIndex(c => c.id === toId));
      if (sameOrder(next, list)) return;
      void run({ op: 'sort_categories', category_ids: next.map(c => c.id) }, next);
      return;
    }
    const owner = list.find(c => scriptsOf(c).some(s => s.id === fromId));
    if (!owner || !scriptsOf(owner).some(s => s.id === toId) || countScripts(owner) > listedScripts(owner)) return;
    const scripts = moveItem(scriptsOf(owner), scriptsOf(owner).findIndex(s => s.id === fromId), scriptsOf(owner).findIndex(s => s.id === toId));
    if (sameOrder(scripts, scriptsOf(owner))) return;
    void run({ op: 'sort_scripts', category_id: owner.id, script_ids: scripts.map(s => s.id) }, list.map(c => (c.id === owner.id ? { ...c, scripts } : c)));
  }

  function switchType(next: UiQuickReplyType): void {
    if (busy || next === type) return;
    api.setType(next);
    try { opts.onTypeChange?.(next); } catch { /* host callback */ }
  }

  // ---------------------------------------------------------------- view

  const value = (e: Event) => (e.currentTarget as HTMLInputElement | HTMLTextAreaElement).value;
  const isEnter = (e: KeyboardEvent) => e.key === 'Enter' && !e.isComposing;

  /** Drag-and-drop handlers for a sortable row; none while read-only or busy. */
  function sortable(kind: DragKind, id: string): Record<string, unknown> {
    if (!editable() || busy) return {};
    const mark = (e: Event, on: boolean) => {
      const el = e.currentTarget as HTMLElement | null;
      if (on) el?.setAttribute('data-drop', 'true'); else el?.removeAttribute('data-drop');
    };
    return {
      draggable: 'true',
      title: t('qrManage.dragHint'),
      ondragstart: (e: DragEvent) => {
        drag = { kind, id };
        try { e.dataTransfer?.setData('text/plain', id); if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'; } catch { /* some engines refuse during setup */ }
      },
      ondragover: (e: DragEvent) => {
        if (drag?.kind !== kind) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        mark(e, drag.id !== id);
      },
      ondragleave: (e: DragEvent) => mark(e, false),
      ondrop: (e: DragEvent) => {
        const from = drag;
        drag = null;
        mark(e, false);
        if (!from || from.kind !== kind) return;
        e.preventDefault();
        reorder(kind, from.id, id);
      },
      ondragend: () => { drag = null; render(); },
    };
  }

  function view(): Node {
    const team = type === 'VSKILLGROUP';
    const readonly = team && !!info && !info.can_edit;
    return h('div', { class: ['qrm', busy && 'is-busy'], 'data-qr': 'root', 'aria-busy': busy || loading ? 'true' : null },
      h('div', { class: 'qrm-top' },
        h('div', { class: ['qrm-tabs', 'seg'], role: 'tablist', 'aria-label': t('qrManage.tabsLabel') },
          tab('VAGENT', t('qrManage.tab.personal')),
          tab('VSKILLGROUP', t('qrManage.tab.team'))),
        readonly ? h('div', { class: 'qrm-readonly', role: 'note', 'data-qr': 'readonly' }, t('qrManage.readonlyTeam')) : null),
      notice ? h('div', { class: 'qrm-notice', role: notice.tone === 'error' ? 'alert' : 'status', 'data-qr': 'notice', 'data-tone': notice.tone }, notice.text) : null,
      confirm ? confirmBar(confirm) : null,
      loadError ? h('div', { class: 'qrm-load-error', role: 'alert', 'data-qr': 'load-error' },
        h('span', null, t('qrManage.loadFailed')),
        h('button', { class: 'btn sm', type: 'button', 'data-qr': 'reload', disabled: loading, onclick: () => void refresh() }, t('qrManage.reload'))) : null,
      body());
  }

  function tab(kind: UiQuickReplyType, label: string): Node {
    const on = type === kind;
    return h('button', {
      class: ['seg-b', 'qrm-tab', on && 'on'], type: 'button', role: 'tab', 'data-qr-tab': kind,
      'aria-selected': on ? 'true' : 'false', disabled: busy, onclick: () => switchType(kind),
    }, label);
  }

  function confirmBar(c: Confirm): Node | null {
    const cat = c.kind === 'category' ? findCategory(c.id) : null;
    if (c.kind === 'category' && !cat) return null;
    const text = cat ? t('qrManage.confirm.group', { name: cat.name, count: countScripts(cat) }) : t('qrManage.confirm.script');
    return h('div', { class: 'qrm-confirm', role: 'alert', 'data-qr': 'confirm' },
      h('span', { class: 'qrm-confirm-text' }, text),
      h('button', { class: 'btn dan sm', type: 'button', 'data-qr': 'confirm-ok', disabled: busy, onclick: confirmDelete }, t('qrManage.delete')),
      h('button', { class: 'btn sm', type: 'button', 'data-qr': 'confirm-cancel', disabled: busy, onclick: () => { if (!busy) { confirm = null; render(); } } }, t('qrManage.cancel')));
  }

  function body(): Node {
    if (!account) return h('div', { class: 'qrm-state', 'data-qr': 'no-account' }, t('qrManage.noAccount'));
    if (!categories) return loadError ? h('div', { class: 'qrm-state' }) : h('div', { class: 'qrm-state', 'data-qr': 'loading' }, t('qrManage.loading'));
    return h('div', { class: 'qrm-body' }, groupsColumn(categories), scriptsColumn(categories));
  }

  function groupsColumn(list: readonly UiQuickReplyCategory[]): Node {
    const canEdit = editable();
    const blocked = type === 'VSKILLGROUP' && teamGroups().length === 0;
    const creating = form?.kind === 'create_category' ? form : null;
    return h('section', { class: 'qrm-groups' },
      h('ul', { class: 'qrm-list', 'data-keep-scroll': 'qrm-groups' },
        list.map(c => (form?.kind === 'rename_category' && form.id === c.id
          ? h('li', { class: 'qrm-group is-editing', 'data-key': `g:${c.id}` }, categoryForm(form))
          : groupRow(c, canEdit)))),
      list.length === 0 ? h('div', { class: 'qrm-empty', 'data-qr': 'groups-empty' }, t('qrManage.groupsEmpty')) : null,
      canEdit ? (creating
        ? h('div', { class: 'qrm-foot' }, categoryForm(creating))
        : h('div', { class: 'qrm-foot' },
          h('button', { class: 'btn sm qrm-add', type: 'button', 'data-qr': 'create-cat', disabled: busy || blocked, onclick: () => setForm({ kind: 'create_category', name: '', groups: [], error: null }, FID_NAME) }, t('qrManage.createGroup')),
          blocked ? h('div', { class: 'qrm-hint', 'data-qr': 'no-skill-groups' }, t('qrManage.noSkillGroups')) : null)) : null);
  }

  function groupRow(c: UiQuickReplyCategory, canEdit: boolean): Node {
    const on = c.id === selected, count = countScripts(c);
    return h('li', { class: ['qrm-group', on && 'is-selected'], 'data-key': `g:${c.id}`, 'data-qr': 'group', 'data-id': c.id, ...sortable('category', c.id) },
      h('button', { class: 'qrm-group-main', type: 'button', 'data-qr': 'select-cat', 'aria-current': on ? 'true' : null, disabled: busy, onclick: () => select(c.id) },
        h('span', { class: 'qrm-group-name' }, c.name),
        h('span', { class: 'qrm-count' }, t('qrManage.groupCount', { count }))),
      canEdit ? h('span', { class: 'qrm-ops' },
        h('button', {
          class: 'qrm-op', type: 'button', 'data-qr': 'rename-cat', disabled: busy,
          onclick: () => setForm({ kind: 'rename_category', id: c.id, name: c.name, groups: (c.skill_groups ?? []).map(g => g.id), error: null }, FID_NAME),
        }, t('qrManage.renameGroup')),
        h('button', { class: 'qrm-op is-danger', type: 'button', 'data-qr': 'delete-cat', disabled: busy, onclick: () => askDelete({ kind: 'category', id: c.id }) }, t('qrManage.delete'))) : null);
  }

  function categoryForm(f: CategoryForm): Node {
    const groups = teamGroups();
    return h('div', { class: 'qrm-form', 'data-qr': f.kind === 'create_category' ? 'create-form' : 'rename-form' },
      h('input', {
        class: 'inp', type: 'text', 'data-qr': 'name', 'data-fid': FID_NAME, value: f.name, maxlength: String(QUICK_REPLY_NAME_MAX),
        placeholder: t('qrManage.form.namePlaceholder', { max: QUICK_REPLY_NAME_MAX }), 'aria-label': t('qrManage.form.name'), disabled: busy,
        oninput: (e: Event) => { f.name = value(e); },
        onkeydown: (e: KeyboardEvent) => { if (isEnter(e)) { e.preventDefault(); saveCategory(f); } else if (e.key === 'Escape') setForm(null, null); },
      }),
      type === 'VSKILLGROUP' ? h('fieldset', { class: 'qrm-scope' },
        h('legend', null, t('qrManage.form.scope')),
        groups.map(g => h('label', { class: 'qrm-check', 'data-key': `sg:${g.id}` },
          h('input', {
            type: 'checkbox', 'data-qr': 'group-option', 'data-id': g.id, checked: f.groups.includes(g.id), disabled: busy,
            onchange: (e: Event) => {
              const on = (e.currentTarget as HTMLInputElement).checked;
              f.groups = on ? [...f.groups.filter(id => id !== g.id), g.id] : f.groups.filter(id => id !== g.id);
            },
          }),
          h('span', null, g.name)))) : null,
      formTail(f.error, () => saveCategory(f)));
  }

  function formTail(error: string | null, save: () => void): (Node | null)[] {
    return [
      error ? h('div', { class: 'qrm-error', role: 'alert', 'data-qr': 'form-error' }, error) : null,
      h('div', { class: 'qrm-form-actions' },
        h('button', { class: 'btn pri sm', type: 'button', 'data-qr': 'save', disabled: busy, onclick: save }, t('qrManage.save')),
        h('button', { class: 'btn sm', type: 'button', 'data-qr': 'cancel', disabled: busy, onclick: () => setForm(null, null) }, t('qrManage.cancel'))),
    ];
  }

  function scriptsColumn(list: readonly UiQuickReplyCategory[]): Node {
    const cat = selected ? list.find(c => c.id === selected) ?? null : null;
    if (!cat) return h('section', { class: 'qrm-scripts' }, h('div', { class: 'qrm-empty' }, t('qrManage.noGroupSelected')));
    const canEdit = editable();
    const scope = type === 'VSKILLGROUP' && cat.skill_groups?.length
      ? t('qrManage.scopeList', { names: cat.skill_groups.map(g => g.name).join(t('qrManage.listSeparator')) }) : null;
    const others = list.filter(c => c.id !== cat.id);
    const adding = form?.kind === 'add_script' && form.categoryId === cat.id ? form : null;
    // The adapter sorts the server's whole row set; rows the list leaves out (blank, past the budget) would make every sort stale.
    const hidden = countScripts(cat) > listedScripts(cat);
    return h('section', { class: 'qrm-scripts' },
      h('header', { class: 'qrm-scripts-head' },
        h('div', { class: 'qrm-scripts-title' }, cat.name),
        scope ? h('div', { class: 'qrm-scope-list', 'data-qr': 'scope' }, scope) : null,
        canEdit && hidden && scriptsOf(cat).length > 1 ? h('div', { class: 'qrm-hint', 'data-qr': 'sort-unavailable' }, t('qrManage.sortUnavailable')) : null),
      h('ul', { class: 'qrm-list', 'data-keep-scroll': `qrm-scripts:${cat.id}` },
        scriptsOf(cat).map(s => (form?.kind === 'edit_script' && form.id === s.id
          ? h('li', { class: 'qrm-script is-editing', 'data-key': `s:${s.id}` }, scriptForm(form))
          : scriptRow(s, others, canEdit, !hidden)))),
      scriptsOf(cat).length === 0 ? h('div', { class: 'qrm-empty', 'data-qr': 'scripts-empty' }, t('qrManage.scriptsEmpty')) : null,
      canEdit ? h('div', { class: 'qrm-foot' }, adding ? scriptForm(adding)
        : h('button', { class: 'btn sm qrm-add', type: 'button', 'data-qr': 'add-script', disabled: busy, onclick: () => setForm({ kind: 'add_script', categoryId: cat.id, content: '', error: null }, FID_CONTENT) }, t('qrManage.addScript'))) : null);
  }

  function scriptRow(s: UiQuickReplyScript, others: readonly UiQuickReplyCategory[], canEdit: boolean, canSort: boolean): Node {
    return h('li', { class: 'qrm-script', 'data-key': `s:${s.id}`, 'data-qr': 'script', 'data-id': s.id, ...(canSort ? sortable('script', s.id) : {}) },
      h('div', { class: 'qrm-script-text' }, s.content),
      canEdit ? h('div', { class: 'qrm-ops' },
        h('button', { class: 'qrm-op', type: 'button', 'data-qr': 'edit-script', disabled: busy, onclick: () => setForm({ kind: 'edit_script', id: s.id, content: s.content, error: null }, FID_CONTENT) }, t('qrManage.editScript')),
        others.length ? h('select', {
          class: 'sel qrm-move', 'data-qr': 'move-script', 'aria-label': t('qrManage.moveTo'), disabled: busy,
          onchange: (e: Event) => { const target = (e.currentTarget as HTMLSelectElement).value; if (target) moveScript(s.id, target); },
        },
        h('option', { value: '', selected: true }, t('qrManage.moveTo')),
        others.map(c => h('option', { value: c.id, 'data-key': `m:${c.id}` }, c.name))) : null,
        h('button', { class: 'qrm-op is-danger', type: 'button', 'data-qr': 'delete-script', disabled: busy, onclick: () => askDelete({ kind: 'script', id: s.id }) }, t('qrManage.delete'))) : null);
  }

  function scriptForm(f: ScriptForm): Node {
    return h('div', { class: 'qrm-form', 'data-qr': f.kind === 'add_script' ? 'add-form' : 'edit-form' },
      h('textarea', {
        class: 'inp qrm-textarea', 'data-qr': 'content', 'data-fid': FID_CONTENT, value: f.content, maxlength: String(QUICK_REPLY_CONTENT_MAX), rows: '4',
        placeholder: t('qrManage.scriptPlaceholder', { max: QUICK_REPLY_CONTENT_MAX }), disabled: busy,
        oninput: (e: Event) => { f.content = value(e); },
        onkeydown: (e: KeyboardEvent) => { if (e.key === 'Escape') setForm(null, null); else if (isEnter(e) && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveScript(f); } },
      }),
      formTail(f.error, () => saveScript(f)));
  }

  // ---------------------------------------------------------------- API

  const api: QuickReplyManager = {
    setAccount(next) {
      if (destroyed) return;
      if (next === account || (next && account && sameAccountContext(next, account))) return;
      account = next;
      reset();
      void refresh();
    },
    setType(next) {
      if (destroyed || next === type) return;
      type = next;
      reset();
      void refresh();
    },
    refresh,
    busy: () => busy,
    destroy() {
      if (destroyed) return;
      destroyed = true; scope++; reads++;
      host.replaceChildren();
    },
  };

  render();
  void refresh();
  return api;
}
