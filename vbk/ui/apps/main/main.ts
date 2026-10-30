/**
 * Main window: title bar with account tabs, left nav (消息 / 通知 / 订单联系,
 * bottom 设置 / 账号), messages workspace, notification centre, order contact,
 * status bar. All state lives in one store; the view is re-rendered on change
 * (focus/caret/scroll preserved by `rerender`).
 */

import type { AlarmSnapshot, ClockReading, SendDisposition } from '../../packages/ipc/src/contracts.ts';
import { isAppError } from '../../packages/ipc/src/contracts.ts';
import { AccountCommands, Events, PrefsCommands, WindowLabels } from '../../packages/ipc/src/commands.ts';
import type {
  PrefsSnapshot,
  UiAccount,
  UiAccountSnapshot,
  UiAgentStatus,
  UiConversation,
  UiMessage,
  UiNetStatus,
  UiNotice,
  UiNoticeCategory,
  UiOrderSummary,
  UiPackageInfo,
} from '../../packages/ipc/src/client.ts';
import { UiCommands, UiEvents } from '../../packages/ipc/src/client.ts';
import { h, icon, rerender, cx } from '../../packages/ui-kit/src/h.ts';
import { createStore, subscribeBatched } from '../../packages/ui-kit/src/store.ts';
import { t } from '../../packages/ui-kit/src/i18n.ts';
import { badgeText, formatClock, formatDate, formatDuration, formatRelativeTime, initialOf } from '../../packages/ui-kit/src/format.ts';
import { IC } from '../_shared/icons.ts';
import { exposeForTests, selectIpc } from '../_shared/ipc.ts';
import {
  AGENT_STATUS_ORDER,
  MARK_COLORS,
  TRANSLATION_IDLE,
  accountInitial,
  accountLabel,
  agentStatusColorVar,
  agentStatusLabel,
  contextMenuCommand,
  contextMenuItems,
  errorMessage,
  filterConversations,
  findIccids,
  isDone,
  isOutbound,
  isValidOrderId,
  langName,
  logoutCommand,
  nextLocalId,
  orderContactReduce,
  orderDetailUrl,
  previewOf,
  roleLabel,
  sendStateView,
  shouldShowTranslationBar,
  tabCounts,
  translationApplies,
  unreadTotal,
} from './viewmodel.ts';
import type { ListTab, LogoutMode, OrderContactState, TranslationState } from './viewmodel.ts';

type View = 'messages' | 'notifications' | 'order';

interface Attachment {
  readonly attachment_id: string;
  readonly name: string;
}

interface MainState {
  readonly accounts: UiAccountSnapshot | null;
  readonly view: View;
  readonly agent: UiAgentStatus;
  readonly net: UiNetStatus;
  readonly clockTrusted: boolean;
  readonly alarmCount: number;
  readonly prefs: PrefsSnapshot | null;
  readonly now: number;
  // messages
  readonly conversations: readonly UiConversation[];
  readonly tab: ListTab;
  readonly query: string;
  readonly activeGid: string | null;
  readonly messages: Readonly<Record<string, readonly UiMessage[]>>;
  readonly draft: string;
  readonly draftVersion: number;
  readonly quote: UiMessage | null;
  readonly attachment: Attachment | null;
  readonly translation: TranslationState;
  readonly sideOpen: boolean;
  readonly pkg: { readonly status: 'idle' | 'busy' | 'done' | 'error'; readonly info: UiPackageInfo | null; readonly error: string | null };
  readonly ctxMenu: { readonly gid: string; readonly x: number; readonly y: number } | null;
  // notifications
  readonly noticeCats: readonly UiNoticeCategory[];
  readonly noticeCat: string | null;
  readonly notices: readonly UiNotice[];
  // order contact
  readonly orderQuery: string;
  readonly order: OrderContactState;
  readonly orderBusyId: string | null;
  // overlays
  readonly meMenu: boolean;
  readonly logoutDialog: { readonly account: UiAccount; readonly mode: LogoutMode } | null;
  readonly editingTab: { readonly accountId: string; readonly value: string } | null;
  readonly toast: string | null;
}

const initial: MainState = {
  accounts: null,
  view: 'messages',
  agent: { status: 'online', confirmed: false },
  net: { online: true, transport: 'connecting' },
  clockTrusted: true,
  alarmCount: 0,
  prefs: null,
  now: Date.now(),
  conversations: [],
  tab: 'doing',
  query: '',
  activeGid: null,
  messages: {},
  draft: '',
  draftVersion: 0,
  quote: null,
  attachment: null,
  translation: TRANSLATION_IDLE,
  sideOpen: true,
  pkg: { status: 'idle', info: null, error: null },
  ctxMenu: null,
  noticeCats: [],
  noticeCat: null,
  notices: [],
  orderQuery: '',
  order: { kind: 'idle' },
  orderBusyId: null,
  meMenu: false,
  logoutDialog: null,
  editingTab: null,
  toast: null,
};

const store = createStore<MainState>(initial);
const sel = selectIpc();
const ipc = sel.ipc;
const root = document.getElementById('app');
if (!root) throw new Error('#app missing');

// --------------------------------------------------------------- helpers

function S(): MainState {
  return store.get();
}

function activeAccount(s: MainState = S()): UiAccount | null {
  const snap = s.accounts;
  if (!snap) return null;
  return snap.accounts.find((a) => a.context.account_id === snap.active_account_id) ?? snap.accounts[0] ?? null;
}

function activeConv(s: MainState = S()): UiConversation | null {
  return s.conversations.find((c) => c.gid === s.activeGid) ?? null;
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;
function toast(text: string): void {
  store.patch({ toast: text });
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => store.patch({ toast: null }), 2600);
}

async function invokeSafe<T>(cmd: string, payload?: unknown): Promise<T | null> {
  try {
    return await ipc.invoke<T>(cmd, payload);
  } catch (e) {
    toast(t('misc.failed', { msg: errorMessage(e) }));
    return null;
  }
}

function copyText(text: string): void {
  try {
    void navigator.clipboard?.writeText(text);
  } catch {
    /* clipboard may be unavailable */
  }
  toast(t('misc.copied'));
}

// --------------------------------------------------------------- loading

async function loadAccounts(): Promise<void> {
  const snap = await invokeSafe<UiAccountSnapshot>(AccountCommands.SNAPSHOT);
  if (snap) store.patch({ accounts: snap });
}

async function loadForActiveAccount(): Promise<void> {
  const acc = activeAccount();
  if (!acc) return;
  const account = acc.context;
  const [convs, agent, net, cats] = await Promise.all([
    invokeSafe<UiConversation[]>(UiCommands.IM_CONVERSATIONS, { account }),
    invokeSafe<UiAgentStatus>(UiCommands.ACCOUNT_AGENT_STATUS, { account }),
    invokeSafe<UiNetStatus>(UiCommands.NET_STATUS, {}),
    invokeSafe<UiNoticeCategory[]>(UiCommands.NOTICE_CATEGORIES, { account }),
  ]);
  const s = S();
  const conversations = convs ?? [];
  store.patch({
    conversations,
    noticeCats: cats ?? [],
    agent: agent ?? s.agent,
    net: net ?? s.net,
    noticeCat: !s.noticeCat && cats && cats.length > 0 ? (cats[0]?.id ?? null) : s.noticeCat,
    activeGid: s.activeGid && !conversations.some((c) => c.gid === s.activeGid) ? null : s.activeGid,
  });
  if (S().noticeCat) await loadNotices();
}

async function loadNotices(): Promise<void> {
  const acc = activeAccount();
  const s = S();
  if (!acc || !s.noticeCat) return;
  const list = await invokeSafe<UiNotice[]>(UiCommands.NOTICE_LIST, { account: acc.context, category_id: s.noticeCat });
  if (list) store.patch({ notices: list });
}

async function loadPrefs(): Promise<void> {
  const p = await invokeSafe<PrefsSnapshot>(PrefsCommands.SNAPSHOT);
  if (p) store.patch({ prefs: p });
}

// --------------------------------------------------------------- accounts

async function switchAccount(a: UiAccount): Promise<void> {
  if (a.state === 'logging_in') return;
  const snap = await invokeSafe<UiAccountSnapshot>(AccountCommands.SWITCH, { account: a.context });
  if (snap) {
    store.patch({ accounts: snap, activeGid: null, messages: {}, draft: '', quote: null, attachment: null, translation: TRANSLATION_IDLE, meMenu: false });
    await loadForActiveAccount();
  }
}

async function addAccount(): Promise<void> {
  await invokeSafe(AccountCommands.START_LOGIN, {});
  toast(t('misc.placeholderInvoke', { cmd: AccountCommands.START_LOGIN }));
}

async function saveRemark(): Promise<void> {
  const s = S();
  const e = s.editingTab;
  if (!e) return;
  const acc = s.accounts?.accounts.find((a) => a.context.account_id === e.accountId);
  store.patch({ editingTab: null });
  if (!acc) return;
  if ((acc.remark ?? '') === e.value.trim()) return;
  const snap = await invokeSafe<UiAccountSnapshot>(UiCommands.ACCOUNT_SET_REMARK, { account: acc.context, remark: e.value });
  if (snap) store.patch({ accounts: snap });
}

async function confirmLogout(): Promise<void> {
  const d = S().logoutDialog;
  if (!d) return;
  store.patch({ logoutDialog: null });
  const snap = await invokeSafe<UiAccountSnapshot>(logoutCommand(d.mode), { account: d.account.context });
  if (snap) {
    store.patch({ accounts: snap });
    await loadForActiveAccount();
  }
}

// --------------------------------------------------------------- messages

async function openConversation(gid: string): Promise<void> {
  const acc = activeAccount();
  if (!acc) return;
  const s = S();
  if (s.activeGid === gid && s.messages[gid]) {
    store.patch({ view: 'messages', ctxMenu: null });
    return;
  }
  store.patch({ activeGid: gid, view: 'messages', draft: s.conversations.find((c) => c.gid === gid)?.draft ?? '', draftVersion: s.draftVersion + 1, quote: null, attachment: null, translation: TRANSLATION_IDLE, pkg: { status: 'idle', info: null, error: null }, ctxMenu: null });
  const list = await invokeSafe<UiMessage[]>(UiCommands.IM_MESSAGES, { account: acc.context, gid });
  if (list && S().activeGid === gid) {
    store.patch({ messages: { ...S().messages, [gid]: list } });
    const conv = S().conversations.find((c) => c.gid === gid);
    if (conv && conv.unread_count > 0) {
      await invokeSafe(UiCommands.IM_MARK_READ, { account: acc.context, gid });
    }
  }
}

function upsertMessage(m: UiMessage): void {
  const s = S();
  const list = s.messages[m.gid];
  if (!list) return;
  const idx = list.findIndex((x) => (m.local_id && x.local_id === m.local_id) || (m.message_id && x.message_id === m.message_id));
  const next = idx >= 0 ? list.map((x, i) => (i === idx ? m : x)) : [...list, m];
  store.patch({ messages: { ...s.messages, [m.gid]: next } });
}

function upsertConversation(c: UiConversation): void {
  const s = S();
  const exists = s.conversations.some((x) => x.gid === c.gid);
  store.patch({ conversations: exists ? s.conversations.map((x) => (x.gid === c.gid ? c : x)) : [...s.conversations, c] });
}

async function sendText(text: string, original: string | null): Promise<void> {
  const acc = activeAccount();
  const conv = activeConv();
  if (!acc || !conv || isDone(conv)) return;
  const s = S();
  const localId = nextLocalId(Date.now());
  const quote = s.quote;
  const local: UiMessage = { gid: conv.gid, message_id: null, local_id: localId, create_time_ms: Date.now(), sender_role: 'merchant_self', kind: 'text', text, translation: null, original, quote: quote ? quote.text : null, order_id: null, disposition: null };
  store.patch({ messages: { ...s.messages, [conv.gid]: [...(s.messages[conv.gid] ?? []), local] }, draft: '', draftVersion: s.draftVersion + 1, quote: null, attachment: null, translation: TRANSLATION_IDLE });
  try {
    const d = await ipc.invoke<SendDisposition>(UiCommands.IM_SEND_TEXT, { account: acc.context, gid: conv.gid, local_id: localId, text, original: original ?? undefined, quote_id: quote?.message_id ?? quote?.local_id ?? undefined });
    upsertMessage({ ...local, disposition: d, message_id: d.kind === 'confirmed' ? d.server_message_id : null });
  } catch (e) {
    // An IPC failure is not a server rejection: the result is unknown and must not be auto-resent.
    upsertMessage({ ...local, disposition: isAppError(e) && e.code === 'im.permission_denied' ? { kind: 'rejected', code: e.code, reason: e.message } : { kind: 'unknown' } });
  }
}

async function handleSend(): Promise<void> {
  const s = S();
  const conv = activeConv(s);
  if (!conv || isDone(conv)) return;
  let text = s.draft.trim();
  if (s.attachment) text = text ? `${text}\n[附件] ${s.attachment.name}` : `[附件] ${s.attachment.name}`;
  if (!text) return;
  const direct = s.prefs?.assistant.send_mode === 'send_direct';
  if (direct && shouldShowTranslationBar(conv, !!s.prefs?.assistant.enabled, !!s.prefs?.assistant.outbound_translation)) {
    await translateAndSend(text);
    return;
  }
  await sendText(text, null);
}

async function translateAndSend(text: string): Promise<void> {
  const acc = activeAccount();
  const conv = activeConv();
  if (!acc || !conv) return;
  const s = S();
  const version = s.draftVersion;
  store.patch({ translation: { status: 'busy', gid: conv.gid, draftVersion: version, target: s.translation.target, text: '', error: null } });
  try {
    const r = await ipc.invoke<{ draft_version: number; text: string }>(UiCommands.ASSIST_TRANSLATE, { account: acc.context, gid: conv.gid, draft_version: version, text, target: s.translation.target });
    if (S().draftVersion !== version) return; // draft changed meanwhile: translation is stale
    await sendText(r.text, text);
  } catch (e) {
    const msg = isAppError(e) && e.code === 'assistant.tsim_unauthenticated' ? t('tr.needLogin') : errorMessage(e);
    store.patch({ translation: { status: 'error', gid: conv.gid, draftVersion: version, target: s.translation.target, text: '', error: msg } });
  }
}

let trTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleTranslation(): void {
  if (trTimer) clearTimeout(trTimer);
  const s = S();
  const conv = activeConv(s);
  if (!conv || !s.prefs || !shouldShowTranslationBar(conv, s.prefs.assistant.enabled, s.prefs.assistant.outbound_translation)) return;
  if (s.prefs.assistant.send_mode !== 'replace_draft') return;
  const text = s.draft.trim();
  if (!text) {
    store.patch({ translation: { ...TRANSLATION_IDLE, target: s.translation.target } });
    return;
  }
  trTimer = setTimeout(() => void runPreviewTranslation(), 500);
}

async function runPreviewTranslation(): Promise<void> {
  const acc = activeAccount();
  const s = S();
  const conv = activeConv(s);
  if (!acc || !conv) return;
  const version = s.draftVersion;
  const text = s.draft.trim();
  if (!text) return;
  store.patch({ translation: { status: 'busy', gid: conv.gid, draftVersion: version, target: s.translation.target, text: '', error: null } });
  try {
    const r = await ipc.invoke<{ draft_version: number; text: string }>(UiCommands.ASSIST_TRANSLATE, { account: acc.context, gid: conv.gid, draft_version: version, text, target: s.translation.target });
    if (!translationApplies(S().translation, conv.gid, version) || r.draft_version !== version) return;
    store.patch({ translation: { status: 'done', gid: conv.gid, draftVersion: version, target: s.translation.target, text: r.text, error: null } });
  } catch (e) {
    if (!translationApplies(S().translation, conv.gid, version)) return;
    const msg = isAppError(e) && e.code === 'assistant.tsim_unauthenticated' ? t('tr.needLogin') : errorMessage(e);
    store.patch({ translation: { status: 'error', gid: conv.gid, draftVersion: version, target: s.translation.target, text: '', error: msg } });
  }
}

function setDraft(value: string): void {
  const s = S();
  store.patch({ draft: value, draftVersion: s.draftVersion + 1 });
  scheduleTranslation();
}

async function resend(m: UiMessage): Promise<void> {
  const s = S();
  const list = s.messages[m.gid] ?? [];
  store.patch({ messages: { ...s.messages, [m.gid]: list.filter((x) => x !== m) } });
  await sendText(m.text, m.original);
}

async function attach(kind: 'screenshot' | 'image' | 'file' | 'video'): Promise<void> {
  const r = kind === 'screenshot' ? await invokeSafe<Attachment>(UiCommands.MEDIA_SCREENSHOT, {}) : await invokeSafe<Attachment | null>(UiCommands.MEDIA_PICK, { kind });
  if (r) store.patch({ attachment: r });
}

async function toggleTop(c: UiConversation): Promise<void> {
  const { cmd, payload } = contextMenuCommand(c, { kind: 'toggle_top' });
  store.patch({ ctxMenu: null });
  const next = await invokeSafe<UiConversation>(cmd, payload);
  if (next) upsertConversation(next);
}

async function setMark(c: UiConversation, action: 0 | 1 | 2 | 3 | 4 | 5): Promise<void> {
  const { cmd, payload } = contextMenuCommand(c, { kind: 'mark', action });
  store.patch({ ctxMenu: null });
  const next = await invokeSafe<UiConversation>(cmd, payload);
  if (next) upsertConversation(next); // failure keeps the old value
}

async function queryPackage(iccid: string, force = false): Promise<void> {
  const s = S();
  if (!force && s.pkg.info && s.pkg.info.iccid === iccid && Date.now() - s.pkg.info.fetched_at_ms < 60_000) return;
  store.patch({ pkg: { status: 'busy', info: s.pkg.info, error: null } });
  try {
    const info = await ipc.invoke<UiPackageInfo>(UiCommands.ASSIST_PACKAGE, { iccid });
    store.patch({ pkg: { status: 'done', info, error: null } });
  } catch (e) {
    store.patch({ pkg: { status: 'error', info: null, error: errorMessage(e) } });
  }
}

// --------------------------------------------------------------- notifications

async function pickNoticeCat(id: string): Promise<void> {
  store.patch({ noticeCat: id });
  await loadNotices();
}

async function openNotice(n: UiNotice): Promise<void> {
  const acc = activeAccount();
  if (!acc) return;
  if (n.unread) {
    await invokeSafe(UiCommands.NOTICE_MARK_READ, { account: acc.context, category_id: n.category_id, id: n.id });
    store.patch({ notices: S().notices.map((x) => (x.id === n.id ? { ...x, unread: false } : x)) });
    await refreshNoticeCats();
  }
  await invokeSafe(UiCommands.SHELL_OPEN_EXTERNAL, { url: n.url });
}

async function markAllNotices(): Promise<void> {
  const acc = activeAccount();
  const s = S();
  if (!acc || !s.noticeCat) return;
  await invokeSafe(UiCommands.NOTICE_MARK_READ, { account: acc.context, category_id: s.noticeCat, id: null });
  store.patch({ notices: S().notices.map((x) => ({ ...x, unread: false })) });
  await refreshNoticeCats();
}

async function refreshNoticeCats(): Promise<void> {
  const acc = activeAccount();
  if (!acc) return;
  const cats = await invokeSafe<UiNoticeCategory[]>(UiCommands.NOTICE_CATEGORIES, { account: acc.context });
  if (cats) store.patch({ noticeCats: cats });
}

// --------------------------------------------------------------- order contact

async function runOrderQuery(id?: string): Promise<void> {
  const acc = activeAccount();
  const orderId = (id ?? S().orderQuery).trim();
  if (!acc) return;
  if (!isValidOrderId(orderId)) {
    toast(t('order.invalid'));
    return;
  }
  store.patch({ orderQuery: orderId, order: orderContactReduce(S().order, { type: 'query', orderId }) });
  try {
    const result = await ipc.invoke<import('../../packages/ipc/src/client.ts').OrderSearchResult>(UiCommands.ORDER_SEARCH, { account: acc.context, order_id: orderId });
    store.patch({ order: orderContactReduce(S().order, { type: 'result', orderId, result }) });
  } catch (e) {
    store.patch({ order: orderContactReduce(S().order, { type: 'error', orderId, error: e }) });
  }
}

async function contactViaIm(o: UiOrderSummary): Promise<void> {
  const acc = activeAccount();
  if (!acc || S().orderBusyId) return;
  store.patch({ orderBusyId: o.order_id });
  try {
    const r = await ipc.invoke<{ gid: string; reused: boolean }>(UiCommands.ORDER_CREATE_IM_CHAT, { account: acc.context, order_id: o.order_id });
    const convs = await ipc.invoke<UiConversation[]>(UiCommands.IM_CONVERSATIONS, { account: acc.context });
    store.patch({ conversations: convs, orderBusyId: null, tab: 'doing' });
    await openConversation(r.gid);
  } catch (e) {
    store.patch({ orderBusyId: null });
    toast(t('order.imFailed', { msg: errorMessage(e) }));
  }
}

async function openWebAdvanced(o: UiOrderSummary): Promise<void> {
  const acc = activeAccount();
  if (!acc) return;
  await invokeSafe(UiCommands.SHELL_OPEN_WEBVIEW, { account: acc.context, url: orderDetailUrl(o.order_id) });
}

// --------------------------------------------------------------- rendering

function accBadge(n: number): HTMLElement | null {
  const txt = badgeText(n);
  return txt ? h('span', { class: 'badge' }, txt) : null;
}

function titleBar(s: MainState): HTMLElement {
  const snap = s.accounts;
  const tabs = (snap?.accounts ?? []).map((a) => {
    const on = a.context.account_id === snap?.active_account_id;
    const editing = s.editingTab?.accountId === a.context.account_id;
    return h(
      'div',
      {
        class: cx('tab', { on }),
        role: 'tab',
        'aria-selected': String(on),
        title: t('tab.editRemark'),
        dataset: { account: a.context.account_id },
        onclick: () => void switchAccount(a),
        ondblclick: (e: Event) => {
          e.preventDefault();
          store.patch({ editingTab: { accountId: a.context.account_id, value: a.remark ?? '' } });
        },
      },
      h('span', { class: 'tab-ava', style: { background: a.color } }, accountInitial(a)),
      editing
        ? h('input', {
            class: 'tab-edit',
            'aria-label': t('tab.remarkLabel'),
            value: s.editingTab?.value ?? '',
            dataset: { fid: 'tab-edit' },
            placeholder: a.nick,
            ref: (el: Element) => queueMicrotask(() => (el as HTMLInputElement).focus()),
            oninput: (e: Event) => store.patch({ editingTab: { accountId: a.context.account_id, value: (e.target as HTMLInputElement).value } }),
            onkeydown: (e: KeyboardEvent) => {
              if (e.key === 'Enter') void saveRemark();
              if (e.key === 'Escape') store.patch({ editingTab: null });
            },
            onblur: () => void saveRemark(),
            onclick: (e: Event) => e.stopPropagation(),
            ondblclick: (e: Event) => e.stopPropagation(),
          })
        : h('span', { class: 'tab-name' }, accountLabel(a)),
      a.state === 'logging_in' ? h('span', { class: 'tab-warn' }, h('span', { class: 'spin' }), t('tab.loggingIn')) : null,
      a.state === 'expired' ? h('span', { class: 'tab-warn' }, icon(IC.alert, 13), t('tab.expired')) : null,
      a.state === 'suspended' ? h('span', { class: 'tab-warn muted' }, t('tab.suspended')) : null,
      a.unread > 0 ? h('span', { class: 'tab-badge' }, badgeText(a.unread)) : null,
      h(
        'button',
        {
          class: 'tab-x',
          'aria-label': t('tab.logout'),
          title: t('tab.logout'),
          onclick: (e: Event) => {
            e.stopPropagation();
            store.patch({ logoutDialog: { account: a, mode: 'suspend' }, meMenu: false });
          },
        },
        icon(IC.close, 12),
      ),
    );
  });
  const canAdd = !snap || snap.accounts.length < snap.max_accounts;
  return h(
    'div',
    { class: 'tb' },
    h('div', { class: 'tb-logo' }, h('div', { class: 'logo', 'aria-hidden': 'true' }, 'V')),
    h('div', { class: 'tabs', role: 'tablist', 'aria-label': '已登录账号' }, tabs, canAdd ? h('button', { class: 'tab-add', 'aria-label': t('tab.add'), title: t('tab.addTitle', { max: snap?.max_accounts ?? 16 }), onclick: () => void addAccount() }, icon(IC.plus, 16)) : null),
    h(
      'div',
      { class: 'wbtns' },
      h('button', { class: 'wbtn', 'aria-label': t('win.minimize'), onclick: () => void invokeSafe(UiCommands.SHELL_WINDOW, { action: 'minimize' }) }, icon(IC.min, 14)),
      h('button', { class: 'wbtn', 'aria-label': t('win.maximize'), onclick: () => void invokeSafe(UiCommands.SHELL_WINDOW, { action: 'toggle_maximize' }) }, icon(IC.max, 13)),
      h('button', { class: 'wbtn x', 'aria-label': t('win.close'), onclick: () => void invokeSafe(UiCommands.SHELL_WINDOW, { action: 'close' }) }, icon(IC.close, 14)),
    ),
  );
}

function navBar(s: MainState): HTMLElement {
  const acc = activeAccount(s);
  const unreadMsgs = unreadTotal(s.conversations);
  const unreadNotice = s.noticeCats.reduce((n, c) => n + c.unread, 0);
  const item = (view: View, label: string, d: string, badge: number) =>
    h(
      'button',
      { class: cx('nav-i', { on: s.view === view }), 'aria-label': label, 'aria-current': s.view === view ? 'page' : undefined, dataset: { nav: view }, onclick: () => store.patch({ view, ctxMenu: null, meMenu: false }) },
      icon(d, 20),
      h('span', null, label),
      badge > 0 ? h('span', { class: 'nav-badge' }, badgeText(badge)) : null,
    );
  return h(
    'nav',
    { class: 'nav', 'aria-label': '导航' },
    item('messages', t('nav.messages'), IC.chat, unreadMsgs),
    item('notifications', t('nav.notifications'), IC.bell, unreadNotice),
    item('order', t('nav.orderContact'), IC.order, 0),
    h('div', { class: 'nav-sp' }),
    h('button', { class: 'nav-i', 'aria-label': t('nav.settings'), dataset: { nav: 'settings' }, onclick: () => void invokeSafe(UiCommands.SHELL_OPEN_WINDOW, { label: WindowLabels.SETTING }) }, icon(IC.gear, 20), h('span', null, t('nav.settings'))),
    h(
      'button',
      { class: 'me', style: { background: acc?.color ?? '#5B6676' }, 'aria-label': `${t('nav.account')}：${agentStatusLabel(s.agent.status)}`, 'aria-expanded': String(s.meMenu), dataset: { nav: 'me' }, onclick: (e: Event) => { e.stopPropagation(); store.patch({ meMenu: !s.meMenu, ctxMenu: null }); } },
      acc ? accountInitial(acc) : '?',
      h('span', { class: 'me-dot', style: { background: `var(${agentStatusColorVar(s.agent.status)})` } }),
    ),
  );
}

function meMenu(s: MainState): HTMLElement | null {
  if (!s.meMenu) return null;
  const acc = activeAccount(s);
  if (!acc) return null;
  return h(
    'div',
    { class: 'menu me-menu', role: 'menu', onmousedown: (e: Event) => e.stopPropagation() },
    h('div', { class: 'me-head' }, h('div', { class: 'ava', style: { background: acc.color } }, accountInitial(acc)), h('div', { class: 'me-head-t' }, h('div', { style: { 'font-weight': '600' } }, accountLabel(acc)), h('div', { class: 'muted', style: { 'font-size': '12px' } }, acc.party))),
    h('div', { class: 'msep' }),
    h('div', { class: 'mhead' }, t('me.status')),
    AGENT_STATUS_ORDER.map((st) =>
      h(
        'button',
        { class: 'mi', role: 'menuitem', 'aria-disabled': 'true', onclick: () => toast(t('me.status')) },
        h('span', { class: 'dot', style: { background: `var(${agentStatusColorVar(st)})` } }),
        h('span', { style: { flex: '1' } }, agentStatusLabel(st)),
        st === s.agent.status ? icon(IC.check, 14, { style: 'color: var(--c-primary)' }) : null,
      ),
    ),
    h('div', { class: 'msep' }),
    h('button', { class: 'mi', role: 'menuitem', onclick: () => { store.patch({ meMenu: false }); void invokeSafe(UiCommands.SHELL_OPEN_EXTERNAL, { url: 'https://vbooking.ctrip.com/vbk/im/main' }); } }, t('me.personalSettings')),
    h('button', { class: 'mi', role: 'menuitem', onclick: () => { store.patch({ meMenu: false }); void invokeSafe(UiCommands.SHELL_OPEN_WINDOW, { label: WindowLabels.SETTING }); } }, t('me.desktopSettings')),
    h('button', { class: 'mi', role: 'menuitem', onclick: () => { store.patch({ meMenu: false }); void invokeSafe(UiCommands.SHELL_OPEN_WINDOW, { label: WindowLabels.UPDATE }); } }, t('me.checkUpdate')),
    h('div', { class: 'msep' }),
    h('button', { class: 'mi', role: 'menuitem', onclick: () => store.patch({ meMenu: false, logoutDialog: { account: acc, mode: 'suspend' } }) }, t('me.logoutSuspend')),
    h('button', { class: 'mi', role: 'menuitem', onclick: () => store.patch({ meMenu: false, logoutDialog: { account: acc, mode: 'logout' } }) }, t('me.logoutFull')),
    h('button', { class: 'mi dan', role: 'menuitem', onclick: () => store.patch({ meMenu: false, logoutDialog: { account: acc, mode: 'forget' } }) }, t('me.forget')),
  );
}

// ---- messages view

function conversationList(s: MainState): HTMLElement {
  const counts = tabCounts(s.conversations);
  const list = filterConversations(s.conversations, s.tab, s.query);
  const rows = list.map((c) => {
    const on = c.gid === s.activeGid;
    const waiting = c.waiting_since_ms !== null && !isDone(c);
    const waitedSec = waiting ? Math.max(0, Math.floor((s.now - (c.waiting_since_ms ?? s.now)) / 1000)) : 0;
    const mark = MARK_COLORS.find((m) => m.action === c.mark);
    return h(
      'div',
      {
        class: cx('conv', { on, top: c.is_top }),
        role: 'button',
        tabindex: '0',
        dataset: { gid: c.gid },
        onclick: () => void openConversation(c.gid),
        onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') void openConversation(c.gid); },
        oncontextmenu: (e: MouseEvent) => {
          e.preventDefault();
          store.patch({ ctxMenu: { gid: c.gid, x: e.clientX, y: e.clientY }, meMenu: false });
        },
      },
      mark ? h('span', { class: 'cmark', style: { background: `var(${mark.cssVar})` }, 'aria-label': t('ctx.markAs', { color: t(mark.nameKey) }) }) : null,
      h('div', { class: 'ava', style: { background: c.color } }, initialOf(c.title)),
      h(
        'div',
        { class: 'conv-main' },
        h('div', { class: 'crow' }, h('span', { class: 'cname' }, c.title), c.lang !== 'zh' ? h('span', { class: 'chip chip-lang' }, langName(c.lang)) : null, h('span', { class: 'ctime' }, c.last_message_time_ms ? formatRelativeTime(c.last_message_time_ms, s.now) : '')),
        h('div', { class: 'crow' }, c.draft && !on ? h('span', { class: 'cdraft' }, t('list.draft')) : null, h('span', { class: 'cprev' }, c.draft && !on ? c.draft : c.preview), accBadge(c.unread_count)),
        h(
          'div',
          { class: 'crow', style: { 'margin-top': '2px' } },
          h('span', { class: 'chip chip-biz' }, c.biz),
          waiting ? h('span', { class: cx('wait', waitedSec >= 90 ? 'red' : 'amber') }, icon(IC.clock, 11), c.waiting_confirmed ? t('list.waiting', { t: formatDuration(waitedSec) }) : `${t('list.waiting', { t: formatDuration(waitedSec) })} · ${t('list.waitingPending')}`) : null,
          isDone(c) ? h('span', { class: 'chip chip-muted' }, t('list.finished')) : null,
          c.is_top ? icon(IC.pin, 12, { style: 'color: var(--c-text-faint)', 'aria-label': t('list.pinned') }) : null,
        ),
      ),
      h('button', { class: 'ibtn cmore', 'aria-label': t('list.more'), onclick: (e: MouseEvent) => { e.stopPropagation(); store.patch({ ctxMenu: { gid: c.gid, x: e.clientX, y: e.clientY } }); } }, icon(IC.more, 14)),
    );
  });
  return h(
    'div',
    { class: 'clist' },
    h(
      'div',
      { class: 'clist-h' },
      h(
        'div',
        { class: 'stat-row' },
        h('span', { class: 'stat-pill', title: t('me.status') }, h('span', { class: 'dot', style: { background: `var(${agentStatusColorVar(s.agent.status)})` } }), agentStatusLabel(s.agent.status), h('span', { class: 'muted', style: { 'font-size': '11px' } }, `· ${t('status.readback')}`)),
        h('span', { class: 'muted', style: { 'font-size': '12px' } }, t('list.serving', { n: counts.doing })),
      ),
      h('label', { class: 'search', title: t('list.searchHint') }, icon(IC.search, 15), h('input', { class: 'inp', placeholder: t('list.search'), 'aria-label': t('list.search'), value: s.query, dataset: { fid: 'search' }, oninput: (e: Event) => store.patch({ query: (e.target as HTMLInputElement).value }) })),
      h(
        'div',
        { class: 'ftabs', role: 'tablist' },
        h('button', { class: cx('ftab', { on: s.tab === 'doing' }), role: 'tab', 'aria-selected': String(s.tab === 'doing'), dataset: { tab: 'doing' }, onclick: () => store.patch({ tab: 'doing' }) }, `${t('list.doing')} ${counts.doing}`),
        h('button', { class: cx('ftab', { on: s.tab === 'done' }), role: 'tab', 'aria-selected': String(s.tab === 'done'), dataset: { tab: 'done' }, onclick: () => store.patch({ tab: 'done' }) }, `${t('list.done')} ${counts.done}`),
      ),
    ),
    !s.net.online ? h('div', { class: 'netbar' }, h('span', { class: 'spin', style: { 'border-top-color': '#87500A' } }), h('span', { style: { flex: '1' } }, t('list.offline')), h('button', { class: 'link', onclick: () => void loadForActiveAccount() }, t('list.retryNow'))) : null,
    h('div', { class: 'cscroll', dataset: { keepScroll: 'clist' } }, rows, rows.length === 0 ? h('div', { class: 'empty', style: { margin: '16px' } }, s.query ? t('list.emptySearch') : t('list.empty')) : null),
  );
}

function contextMenu(s: MainState): HTMLElement | null {
  const m = s.ctxMenu;
  if (!m) return null;
  const c = s.conversations.find((x) => x.gid === m.gid);
  if (!c) return null;
  const items = contextMenuItems(c);
  const maxX = Math.max(0, window.innerWidth - 200);
  const maxY = Math.max(0, window.innerHeight - 190);
  return h(
    'div',
    { class: 'menu ctx-menu', role: 'menu', style: { left: `${Math.min(m.x, maxX)}px`, top: `${Math.min(m.y, maxY)}px` }, onmousedown: (e: Event) => e.stopPropagation() },
    h('button', { class: 'mi', role: 'menuitem', dataset: { ctx: 'top' }, onclick: () => void toggleTop(c) }, icon(IC.pin, 13), items.topLabel),
    h('div', { class: 'msep' }),
    h('div', { class: 'mhead' }, t('ctx.markColor')),
    h(
      'div',
      { class: 'mk-row' },
      MARK_COLORS.map((mc) =>
        h('button', {
          class: cx('mk', { on: c.mark === mc.action }),
          style: { background: `var(${mc.cssVar})` },
          title: t(mc.nameKey),
          'aria-label': t('ctx.markAs', { color: t(mc.nameKey) }),
          dataset: { mark: String(mc.action) },
          onclick: () => void setMark(c, mc.action),
        }),
      ),
    ),
    items.showClear ? h('button', { class: 'mi', role: 'menuitem', dataset: { ctx: 'clear' }, onclick: () => void setMark(c, 0) }, t('ctx.clearMark')) : null,
    h('div', { class: 'mhead' }, t('ctx.markHint')),
  );
}

function messageRow(s: MainState, m: UiMessage, conv: UiConversation, acc: UiAccount | null): HTMLElement {
  if (m.kind === 'system') return h('div', { class: 'msg-sys' }, h('span', null, m.text));
  const mine = isOutbound(m);
  const showTime = s.prefs?.general.show_msg_time ?? true;
  let body: HTMLElement;
  if (m.kind === 'order_card') {
    body = h(
      'div',
      { class: 'card' },
      h('div', { class: 'card-h' }, icon(IC.order, 14), t('chat.orderCard'), h('span', { class: 'mono', style: { 'margin-left': 'auto' } }, m.order_id ?? '')),
      h('div', { class: 'card-b' }, h('div', { class: 'card-t' }, m.text)),
      h('div', { class: 'card-f' }, h('button', { class: 'link', onclick: () => store.patch({ sideOpen: true }) }, t('chat.viewOrder'))),
    );
  } else if (m.kind === 'image' || m.kind === 'file' || m.kind === 'video') {
    body = h('div', { class: 'bubble' }, previewOf(m), ' ', m.text);
  } else {
    body = h(
      'div',
      { class: 'bubble' },
      h('span', null, m.text),
      m.translation ? h('div', { class: 'btr' }, h('span', { class: 'trtag' }, t('chat.translated')), h('span', null, m.translation)) : null,
      m.original ? h('div', { class: 'btr' }, h('span', { class: 'trtag' }, t('chat.original')), h('span', null, m.original)) : null,
    );
  }
  const st = mine ? sendStateView(m.disposition) : null;
  return h(
    'div',
    { class: cx('msg', { mine }), dataset: { mid: m.local_id ?? m.message_id ?? '' } },
    h('div', { class: 'ava sm', style: { background: mine ? (acc?.color ?? '#5B6676') : conv.color } }, mine ? (acc ? accountInitial(acc) : '我') : initialOf(conv.title)),
    h(
      'div',
      { class: 'mcol' },
      h('div', { class: 'mmeta' }, mine ? roleLabel('merchant_self') : m.sender_role === 'customer' ? conv.title : roleLabel(m.sender_role), showTime ? ` · ${formatClock(m.create_time_ms, true)}` : ''),
      m.quote ? h('div', { class: 'quote-in' }, t('chat.quotePrefix'), m.quote) : null,
      body,
      st
        ? h(
            'div',
            { class: cx('mst', st.cls), dataset: { sendState: st.cls } },
            st.spin ? h('span', { class: 'spin' }) : null,
            h('span', null, st.label),
            st.canRetry ? h('button', { class: 'act', onclick: () => void resend(m) }, t('send.retry')) : null,
          )
        : null,
    ),
    h('div', { class: 'macts' }, h('button', { onclick: () => store.patch({ quote: m }) }, t('chat.quote')), h('button', { onclick: () => copyText(m.text) }, t('chat.copy'))),
  );
}

function translationBar(s: MainState, conv: UiConversation): HTMLElement | null {
  const p = s.prefs;
  if (!p || !shouldShowTranslationBar(conv, p.assistant.enabled, p.assistant.outbound_translation)) return null;
  const direct = p.assistant.send_mode === 'send_direct';
  const tr = s.translation;
  const target = tr.target === 'en' && conv.lang !== 'zh' && tr.gid !== conv.gid ? conv.lang : tr.target;
  const stale = tr.status === 'done' && tr.draftVersion !== s.draftVersion;
  const targets = ['en', 'ja', 'ko', 'th', 'vi', 'id', 'ms', 'es', 'fr', 'de', 'ru', 'zh-TW'];
  let bodyEl: HTMLElement;
  if (tr.status === 'error') {
    bodyEl = h(
      'div',
      { class: 'trrow', dataset: { trState: 'error' } },
      icon(IC.alert, 14, { style: 'color: var(--c-alert)' }),
      h('span', { style: { color: 'var(--c-alert-text)' } }, `${t('tr.failed')}：${tr.error ?? ''}`),
      h('span', { class: 'sp' }),
      h('button', { class: 'btn sm', dataset: { tr: 'send-original' }, onclick: () => void sendText(s.draft.trim(), null) }, t('tr.sendOriginal')),
      h('button', { class: 'btn sm pri', dataset: { tr: 'retry' }, onclick: () => (direct ? void translateAndSend(s.draft.trim()) : void runPreviewTranslation()) }, t('tr.retry')),
    );
  } else if (direct) {
    bodyEl = h('div', { class: 'trprev wait', dataset: { trState: tr.status } }, tr.status === 'busy' ? h('span', { class: 'spin' }) : null, tr.status === 'busy' ? t('tr.busy') : t('composer.directMode'));
  } else if (tr.status === 'busy' || stale) {
    bodyEl = h('div', { class: 'trprev wait', dataset: { trState: 'busy' } }, h('span', { class: 'spin' }), stale ? t('tr.stale') : t('tr.busy'));
  } else if (tr.status === 'done') {
    bodyEl = h(
      'div',
      { dataset: { trState: 'done' } },
      h('div', { class: 'trprev' }, tr.text),
      h('div', { class: 'trrow' }, h('span', { class: 'sp' }), h('button', { class: 'btn sm', onclick: () => copyText(tr.text) }, t('tr.copy')), h('button', { class: 'btn sm pri', dataset: { tr: 'replace' }, onclick: () => { store.patch({ draft: tr.text, draftVersion: s.draftVersion + 1, translation: { ...TRANSLATION_IDLE, target } }); } }, t('tr.replace'))),
    );
  } else {
    bodyEl = h('div', { class: 'trprev wait', dataset: { trState: 'idle' } }, t('tr.idle'));
  }
  return h(
    'div',
    { class: 'trbar' },
    h(
      'div',
      { class: 'trrow' },
      icon(IC.translate, 15, { style: 'color: var(--c-primary)' }),
      h('span', { style: { 'font-weight': '600' } }, t('tr.title')),
      h('span', { class: 'muted' }, t('tr.target')),
      h(
        'select',
        { class: 'sel', style: { height: '24px' }, 'aria-label': t('tr.target'), value: target, onchange: (e: Event) => { store.patch({ translation: { ...TRANSLATION_IDLE, target: (e.target as HTMLSelectElement).value } }); scheduleTranslation(); } },
        targets.map((code) => h('option', { value: code, selected: code === target }, `${langName(code)} ${code}`)),
      ),
      h('span', { class: 'muted', style: { 'margin-left': 'auto' } }, `${t('tr.provider')} · ${direct ? t('tr.modeDirect') : t('tr.modeReplace')}`),
    ),
    bodyEl,
  );
}

function composer(s: MainState, conv: UiConversation): HTMLElement {
  const finished = isDone(conv);
  const direct = s.prefs?.assistant.send_mode === 'send_direct' && shouldShowTranslationBar(conv, !!s.prefs?.assistant.enabled, !!s.prefs?.assistant.outbound_translation);
  const sendKey = s.prefs?.keys.send_key ?? 'enter';
  return h(
    'div',
    { class: 'composer' },
    translationBar(s, conv),
    h(
      'div',
      { class: 'ctools' },
      h('button', { class: 'ibtn', 'aria-label': t('composer.screenshot'), title: `${t('composer.screenshot')} ${s.prefs?.keys.screenshot ?? ''}`, disabled: finished, onclick: () => void attach('screenshot') }, icon(IC.scissors, 18)),
      h('button', { class: 'ibtn', 'aria-label': t('composer.image'), title: t('composer.image'), disabled: finished, onclick: () => void attach('image') }, icon(IC.image, 18)),
      h('button', { class: 'ibtn', 'aria-label': t('composer.file'), title: t('composer.file'), disabled: finished, onclick: () => void attach('file') }, icon(IC.file, 18)),
      h('button', { class: 'ibtn', 'aria-label': t('composer.video'), title: t('composer.video'), disabled: finished, onclick: () => void attach('video') }, icon(IC.video, 18)),
      h('span', { class: 'hint', style: { 'margin-left': 'auto', 'padding-right': '6px' } }, t('composer.attachHint')),
    ),
    s.quote ? h('div', { class: 'quote-bar' }, h('span', { style: { flex: '1', overflow: 'hidden', 'white-space': 'nowrap', 'text-overflow': 'ellipsis' } }, t('chat.quotePrefix'), s.quote.text), h('button', { class: 'ibtn', style: { width: '22px', height: '22px' }, 'aria-label': t('chat.cancelQuote'), onclick: () => store.patch({ quote: null }) }, icon(IC.close, 12))) : null,
    s.attachment ? h('div', { class: 'attach' }, h('div', { class: 'attach-img' }), h('span', { style: { 'font-size': '12px' } }, t('composer.attached', { name: s.attachment.name })), h('button', { class: 'ibtn', style: { width: '22px', height: '22px' }, 'aria-label': t('composer.removeAttach'), onclick: () => store.patch({ attachment: null }) }, icon(IC.close, 12))) : null,
    h('textarea', {
      class: 'ta',
      placeholder: finished ? t('composer.placeholderFinished') : t('composer.placeholder'),
      'aria-label': t('composer.placeholder'),
      value: s.draft,
      disabled: finished,
      dataset: { fid: 'draft' },
      oninput: (e: Event) => setDraft((e.target as HTMLTextAreaElement).value),
      onkeydown: (e: KeyboardEvent) => {
        if (e.key !== 'Enter') return;
        const want = sendKey === 'enter' ? !e.shiftKey && !e.ctrlKey : e.ctrlKey;
        if (want) {
          e.preventDefault();
          void handleSend();
        }
      },
    }),
    h('div', { class: 'cfoot' }, h('span', { class: 'hint' }, direct ? t('composer.directMode') : t('composer.hintEnter')), h('button', { class: 'btn pri', dataset: { action: 'send' }, disabled: finished, onclick: () => void handleSend() }, icon(IC.send, 14), t('composer.send'))),
  );
}

function sidePanel(s: MainState, conv: UiConversation): HTMLElement {
  const msgs = s.messages[conv.gid] ?? [];
  const iccids = findIccids(msgs);
  const pkgOn = s.prefs?.assistant.enabled && s.prefs?.assistant.package_quick_view;
  const o = conv.order;
  let pkgBody: HTMLElement;
  if (!pkgOn) pkgBody = h('div', { class: 'empty', style: { margin: '10px' } }, t('side.pkgOff'));
  else if (iccids.length === 0) pkgBody = h('div', { class: 'empty', style: { margin: '10px' } }, t('side.pkgEmpty'));
  else {
    const info = s.pkg.info;
    pkgBody = h(
      'div',
      { class: 'pkg-b' },
      iccids.map((id) => h('div', { class: 'pkg-id' }, h('span', { class: 'muted' }, 'ICCID'), h('span', { class: 'mono' }, id), h('button', { class: 'btn sm', dataset: { pkgQuery: id }, disabled: s.pkg.status === 'busy', onclick: () => void queryPackage(id, true) }, s.pkg.status === 'busy' ? t('side.pkgBusy') : t('side.pkgQuery')))),
      s.pkg.status === 'error' ? h('div', { class: 'notice-box err' }, s.pkg.error ?? '') : null,
      info
        ? h(
            'div',
            { class: 'pkg-info', dataset: { pkgInfo: '1' } },
            h('div', { style: { display: 'flex', gap: '12px', 'align-items': 'center' } }, h('div', { class: 'ring', style: { background: `conic-gradient(var(--c-primary) ${info.remain_pct}%, var(--c-border) 0)` } }, h('span', null, `${info.remain_pct}%`)), h('div', null, h('div', { style: { 'font-size': '12px' } }, h('span', { class: 'chip chip-warn' }, info.status), ' ', h('span', { class: 'muted' }, t('side.pkgRemain'))), h('div', null, h('b', { style: { 'font-size': '20px' } }, info.remain), h('span', { class: 'muted', style: { 'font-size': '12px' } }, ` / ${info.total}`)))),
            h('div', { style: { 'font-weight': '600' } }, info.plan),
            h('div', { class: 'pkg-tiles' }, h('div', null, h('span', null, t('side.pkgSupplier')), h('b', null, info.supplier)), h('div', null, h('span', null, t('side.pkgApn')), h('b', null, info.apn))),
            h('div', { class: 'muted', style: { 'font-size': '11.5px' } }, t('side.pkgUpdated', { t: formatClock(info.fetched_at_ms, true) })),
          )
        : null,
    );
  }
  return h(
    'aside',
    { class: 'side' },
    h('div', { class: 'stabs' }, h('span', { class: 'stab on' }, t('side.customer')), h('span', { class: 'sp' }), h('button', { class: 'ibtn', style: { 'align-self': 'center' }, title: t('chat.toggleSide'), 'aria-label': t('chat.toggleSide'), onclick: () => store.patch({ sideOpen: false }) }, icon(IC.chevRight, 16))),
    h(
      'div',
      { class: 'sbody', dataset: { keepScroll: 'side' } },
      h(
        'div',
        { class: 'ucard' },
        h('div', { class: 'ucard-h' }, h('div', { class: 'ava sm', style: { background: conv.color } }, initialOf(conv.title)), h('div', { style: { flex: '1', 'min-width': '0' } }, h('b', null, conv.title), h('div', { class: 'tagrow' }, h('span', { class: 'chip chip-lang' }, `${t('side.lang')}：${langName(conv.lang)}`), conv.customer_tags.map((tag) => h('span', { class: 'chip chip-biz' }, tag))))),
        h('div', { class: 'ucard-sep' }),
        h('div', { class: 'sec-t' }, t('side.order')),
        o
          ? h(
              'div',
              { class: 'info-grid' },
              h('span', { class: 'ik' }, t('side.orderNo')), h('span', { class: 'iv mono' }, o.order_id, ' ', h('button', { class: 'ibtn', style: { width: '20px', height: '20px' }, 'aria-label': t('side.copyOrder'), onclick: () => copyText(o.order_id) }, icon(IC.copy, 12))),
              h('span', { class: 'ik' }, t('side.product')), h('span', { class: 'iv' }, o.product),
              h('span', { class: 'ik' }, t('side.useDate')), h('span', { class: 'iv' }, o.use_date),
              h('span', { class: 'ik' }, t('side.quantity')), h('span', { class: 'iv' }, o.quantity),
              h('span', { class: 'ik' }, t('side.statusLabel')), h('span', { class: 'iv' }, h('span', { class: 'chip chip-info' }, o.status)),
            )
          : h('div', { class: 'muted', style: { 'font-size': '12px' } }, t('side.noOrder')),
        o ? h('div', { style: { display: 'flex', gap: '6px' } }, h('button', { class: 'btn sm', onclick: () => { store.patch({ view: 'order', orderQuery: o.order_id }); void runOrderQuery(o.order_id); } }, t('side.goOrder')), h('button', { class: 'btn sm', onclick: () => void openWebAdvanced(o) }, icon(IC.lock, 12), t('order.web'))) : null,
      ),
      h('div', { class: 'pkg' }, h('div', { class: 'pkg-h' }, h('b', null, t('side.pkg')), h('span', { class: 'sp' }), s.pkg.info ? h('button', { class: 'ibtn', style: { width: '26px', height: '26px' }, title: t('side.pkgRefresh'), 'aria-label': t('side.pkgRefresh'), onclick: () => void queryPackage(s.pkg.info?.iccid ?? '', true) }, icon(IC.refresh, 14)) : null), pkgBody),
    ),
  );
}

function chatPane(s: MainState): HTMLElement {
  const conv = activeConv(s);
  const acc = activeAccount(s);
  if (!conv) return h('div', { class: 'chat' }, h('div', { class: 'chat-empty' }, icon(IC.chat, 40), h('div', null, t('chat.empty'))));
  const msgs = s.messages[conv.gid] ?? [];
  const waiting = conv.waiting_since_ms !== null && !isDone(conv);
  const sub = isDone(conv) ? t('chat.finished') : `${t('chat.owner')}${waiting ? ` · ${t('chat.waiting', { t: formatDuration(Math.max(0, Math.floor((s.now - (conv.waiting_since_ms ?? s.now)) / 1000))) })}` : ''}`;
  return h(
    'div',
    { class: 'chat' },
    h(
      'div',
      { class: 'chat-h' },
      h('div', { class: 'ava sm', style: { background: conv.color } }, initialOf(conv.title)),
      h('div', { class: 'chat-title' }, h('div', { class: 'chat-name' }, conv.title, conv.lang !== 'zh' ? h('span', { class: 'chip chip-lang' }, t('chat.lang', { lang: langName(conv.lang) })) : null, h('span', { class: 'chip chip-biz' }, conv.biz)), h('div', { class: 'chat-sub' }, sub)),
      !s.sideOpen ? h('button', { class: 'ibtn', title: t('chat.toggleSide'), 'aria-label': t('chat.toggleSide'), onclick: () => store.patch({ sideOpen: true }) }, icon(IC.sidebar, 17)) : null,
    ),
    !s.net.online ? h('div', { class: 'netbar', style: { margin: '8px 16px 0' } }, t('chat.offlineNotice')) : null,
    h('div', { class: 'msgs', dataset: { keepScroll: 'msgs', scrollBottom: '1' } }, msgs.map((m) => messageRow(s, m, conv, acc))),
    composer(s, conv),
  );
}

function messagesView(s: MainState): HTMLElement {
  const conv = activeConv(s);
  return h('div', { class: 'content' }, conversationList(s), chatPane(s), conv && s.sideOpen ? sidePanel(s, conv) : null);
}

// ---- notifications view

function notificationsView(s: MainState): HTMLElement {
  const cat = s.noticeCats.find((c) => c.id === s.noticeCat) ?? null;
  const catIcons: Record<string, string> = { order: IC.order, product: IC.box, finance: IC.coin, system: IC.megaphone };
  return h(
    'div',
    { class: 'content' },
    h(
      'div',
      { class: 'ncat' },
      h('div', { class: 'ncat-title' }, t('notice.title')),
      s.noticeCats.map((c) =>
        h('button', { class: cx('ncat-i', { on: c.id === s.noticeCat }), dataset: { cat: c.id }, onclick: () => void pickNoticeCat(c.id) }, icon(catIcons[c.id] ?? IC.bell, 16), h('span', { style: { flex: '1' } }, c.name), accBadge(c.unread)),
      ),
      s.noticeCats.length === 0 ? h('div', { class: 'empty' }, t('notice.empty')) : null,
    ),
    h(
      'div',
      { class: 'nlist' },
      h('div', { class: 'ph' }, cat ? cat.name : t('notice.title'), cat ? h('span', { class: 'muted', style: { 'font-size': '12px', 'font-weight': '400', 'margin-left': '8px' } }, t('notice.unread', { n: cat.unread })) : null, h('span', { class: 'sp' }), h('button', { class: 'btn sm', dataset: { action: 'mark-all' }, onclick: () => void markAllNotices() }, t('notice.markAll'))),
      h(
        'div',
        { class: 'nscroll', dataset: { keepScroll: 'notices' } },
        s.notices.map((n) =>
          h(
            'div',
            { class: cx('nitem', { unread: n.unread }), dataset: { notice: n.id } },
            h('div', { style: { flex: '1', display: 'flex', 'flex-direction': 'column', gap: '4px' } }, h('div', { class: 'nt' }, n.title), h('div', { class: 'muted', style: { 'font-size': '12.5px' } }, n.body)),
            h('div', { style: { display: 'flex', 'flex-direction': 'column', 'align-items': 'flex-end', gap: '6px' } }, h('span', { class: 'muted', style: { 'font-size': '12px' } }, formatRelativeTime(n.time_ms, s.now)), h('button', { class: 'link', onclick: () => void openNotice(n) }, t('notice.open'), ' ', icon(IC.external, 11))),
          ),
        ),
        s.notices.length === 0 ? h('div', { class: 'empty', style: { margin: '16px' } }, t('notice.empty')) : null,
      ),
    ),
  );
}

// ---- order contact view

function orderRow(s: MainState, o: UiOrderSummary): HTMLElement {
  const busy = s.orderBusyId === o.order_id;
  return h(
    'div',
    { class: 'grid-r', dataset: { order: o.order_id } },
    h('span', { class: 'cell mono' }, o.order_id),
    h('span', { class: 'cell', title: o.product }, o.product),
    h('span', { class: 'cell' }, o.use_date),
    h('span', { class: 'cell' }, o.quantity),
    h('span', null, h('span', { class: 'chip chip-info' }, o.status)),
    h('span', { class: 'cell' }, o.contact),
    h(
      'span',
      { style: { display: 'flex', gap: '6px' } },
      h('button', { class: 'btn sm pri', dataset: { action: 'im' }, disabled: busy, onclick: () => void contactViaIm(o) }, busy ? h('span', { class: 'spin' }) : icon(IC.chat, 13), busy ? t('order.imBusy') : t('order.im')),
      h('button', { class: 'btn sm', dataset: { action: 'web' }, title: t('order.webTitle'), onclick: () => void openWebAdvanced(o) }, icon(IC.lock, 13), t('order.web')),
    ),
  );
}

function orderView(s: MainState): HTMLElement {
  const st = s.order;
  const samples = ['0000000001', '0000000002', '0000000003', '0000000008', '0000000009'];
  let result: HTMLElement | null = null;
  if (st.kind === 'loading') result = h('div', { class: 'panel', style: { padding: '16px', display: 'flex', 'flex-direction': 'column', gap: '10px' }, dataset: { orderState: 'loading' } }, h('div', { class: 'skel', style: { height: '30px' } }), h('div', { class: 'skel', style: { height: '30px', width: '70%' } }));
  else if (st.kind === 'none') result = h('div', { class: 'empty', style: { background: '#fff' }, dataset: { orderState: 'none' } }, t('order.none'));
  else if (st.kind === 'forbidden') result = h('div', { class: 'notice-box err', dataset: { orderState: 'forbidden' } }, t('order.forbidden'));
  else if (st.kind === 'unknown') result = h('div', { class: 'notice-box warn', dataset: { orderState: 'unknown' } }, t('order.unknown'), st.message ? ` （${st.message}）` : '');
  else if (st.kind === 'one' || st.kind === 'multiple') {
    const orders = st.kind === 'one' ? [st.order] : st.orders;
    result = h(
      'div',
      { class: 'panel', dataset: { orderState: st.kind } },
      h('div', { class: 'ph' }, t('order.result', { n: orders.length }), st.kind === 'multiple' ? h('span', { class: 'chip chip-warn', style: { 'margin-left': '8px' } }, t('order.multiple')) : h('span', { class: 'muted', style: { 'font-size': '12px', 'font-weight': '400', 'margin-left': '8px' } }, t('order.verify'))),
      h('div', { class: 'grid-h' }, h('span', null, t('order.col.id')), h('span', null, t('order.col.product')), h('span', null, t('order.col.date')), h('span', null, t('order.col.qty')), h('span', null, t('order.col.status')), h('span', null, t('order.col.contact')), h('span', null, t('order.col.actions'))),
      orders.map((o) => orderRow(s, o)),
    );
  }
  return h(
    'div',
    { class: 'content' },
    h(
      'div',
      { class: 'biz' },
      h(
        'div',
        { class: 'page', dataset: { keepScroll: 'order' } },
        h(
          'div',
          { class: 'panel', style: { padding: '16px 18px', display: 'flex', 'flex-direction': 'column', gap: '10px' } },
          h('b', { style: { 'font-size': '15px' } }, t('order.title')),
          h('span', { class: 'muted', style: { 'font-size': '12.5px' } }, t('order.desc')),
          h('div', { style: { display: 'flex', gap: '8px' } }, h('input', { class: 'inp', style: { width: '300px', height: '34px' }, placeholder: t('order.placeholder'), 'aria-label': t('order.placeholder'), value: s.orderQuery, dataset: { fid: 'order-query' }, inputmode: 'numeric', oninput: (e: Event) => store.patch({ orderQuery: (e.target as HTMLInputElement).value }), onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') void runOrderQuery(); } }), h('button', { class: 'btn pri', style: { height: '34px' }, dataset: { action: 'order-query' }, onclick: () => void runOrderQuery() }, t('order.query'))),
          h('div', { style: { display: 'flex', 'flex-wrap': 'wrap', gap: '8px', 'align-items': 'center' } }, h('span', { class: 'muted', style: { 'font-size': '12px' } }, t('order.samples')), samples.map((id) => h('button', { class: 'chipbtn', dataset: { sample: id }, onclick: () => void runOrderQuery(id) }, `示例订单 ${id}`))),
        ),
        result,
      ),
    ),
  );
}

// ---- status bar, dialogs

let clockEl: HTMLElement | null = null;
function statusBar(s: MainState): HTMLElement {
  const netLabel = s.net.online ? t('bar.net.online') : s.net.transport === 'reconnecting' ? t('bar.net.reconnecting') : t('bar.net.offline');
  clockEl = h('span', { class: 'sb-clock' }, `${formatDate(s.now)} ${formatClock(s.now, true)}`);
  return h(
    'div',
    { class: 'statusbar', role: 'status' },
    h('span', { class: 'sb-item', dataset: { sb: 'agent' } }, h('span', { class: 'dot', style: { background: `var(${agentStatusColorVar(s.agent.status)})` } }), agentStatusLabel(s.agent.status), h('span', { class: 'muted' }, ` · ${t('status.readback')}`)),
    h('span', { class: cx('sb-item', { 'sb-bad': !s.net.online }), dataset: { sb: 'net' } }, icon(s.net.online ? IC.wifi : IC.wifiOff, 13), netLabel),
    s.alarmCount > 0 ? h('span', { class: 'sb-item sb-alarm', dataset: { sb: 'alarm' } }, icon(IC.clock, 13), t('bar.alarmCount', { n: s.alarmCount })) : null,
    h('span', { class: 'sp' }),
    sel.mock ? h('span', { class: 'sb-item muted' }, t('app.mockMode')) : null,
    s.clockTrusted ? null : h('span', { class: 'sb-item sb-warn', title: t('bar.clockUntrustedTitle'), dataset: { sb: 'clock-untrusted' } }, icon(IC.alert, 13), t('bar.clockUntrusted')),
    clockEl,
  );
}

function logoutDialog(s: MainState): HTMLElement | null {
  const d = s.logoutDialog;
  if (!d) return null;
  const opt = (mode: LogoutMode, label: string, desc: string) =>
    h('button', { class: cx('opt', { on: d.mode === mode }), role: 'radio', 'aria-checked': String(d.mode === mode), dataset: { logout: mode }, onclick: () => store.patch({ logoutDialog: { account: d.account, mode } }) }, h('span', { class: 'radio' }), h('span', null, h('b', { style: { 'font-weight': '600' } }, label), h('span', { class: 'muted', style: { 'font-size': '12px', display: 'block' } }, desc)));
  return h(
    'div',
    { class: 'shade', onclick: () => store.patch({ logoutDialog: null }) },
    h(
      'div',
      { class: 'dlg', style: { width: '420px' }, role: 'dialog', 'aria-modal': 'true', onclick: (e: Event) => e.stopPropagation() },
      h('div', { class: 'dlg-h' }, t('logout.title', { name: accountLabel(d.account) })),
      h('div', { class: 'dlg-b', role: 'radiogroup' }, opt('suspend', t('logout.suspend'), t('logout.suspendDesc')), opt('logout', t('logout.full'), t('logout.fullDesc')), opt('forget', t('logout.forget'), t('logout.forgetDesc'))),
      h('div', { class: 'dlg-f' }, h('button', { class: 'btn', onclick: () => store.patch({ logoutDialog: null }) }, t('dlg.cancel')), h('button', { class: cx('btn', d.mode === 'forget' ? 'dan' : 'pri'), dataset: { action: 'logout-confirm' }, onclick: () => void confirmLogout() }, t('dlg.confirm'))),
    ),
  );
}

function render(s: MainState): Node {
  const view = s.view === 'messages' ? messagesView(s) : s.view === 'notifications' ? notificationsView(s) : orderView(s);
  return h(
    'div',
    { class: 'app', dataset: { view: s.view } },
    titleBar(s),
    h('div', { class: 'body' }, navBar(s), view),
    statusBar(s),
    meMenu(s),
    contextMenu(s),
    logoutDialog(s),
    s.toast ? h('div', { class: 'toast', role: 'status' }, s.toast) : null,
  );
}

// --------------------------------------------------------------- wiring

subscribeBatched(store, (s) => rerender(root, () => render(s)));
rerender(root, () => render(S()));

document.addEventListener('mousedown', () => {
  const s = S();
  if (s.ctxMenu || s.meMenu) store.patch({ ctxMenu: null, meMenu: false });
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const s = S();
    if (s.ctxMenu || s.meMenu || s.logoutDialog) store.patch({ ctxMenu: null, meMenu: false, logoutDialog: null });
  }
});

// subscribe first, then request snapshots
ipc.listen<UiAccountSnapshot>(Events.ACCOUNT_CHANGED, (snap) => {
  const prev = S().accounts?.active_account_id ?? null;
  store.patch({ accounts: snap });
  if (snap.active_account_id !== prev) void loadForActiveAccount();
});
ipc.listen<UiConversation>(Events.IM_CONVERSATION_CHANGED, (c) => {
  const acc = activeAccount();
  if (acc && c.account.account_id === acc.context.account_id) upsertConversation(c);
});
ipc.listen<UiMessage>(Events.IM_MESSAGE_NEW, (m) => upsertMessage(m));
ipc.listen<PrefsSnapshot>(Events.PREFS_CHANGED, (p) => store.patch({ prefs: p }));
ipc.listen<ClockReading>(Events.NET_CLOCK, (c) => store.patch({ clockTrusted: c.quality.kind === 'anchored' }));
ipc.listen<AlarmSnapshot>(Events.ALARM_SNAPSHOT, (snap) => {
  const s = S();
  const count = snap.entries.filter((e) => e.snoozed_until_ms === null || e.snoozed_until_ms <= snap.generated_at_ms).length;
  if (count !== s.alarmCount || snap.clock_trusted !== s.clockTrusted) store.patch({ alarmCount: count, clockTrusted: snap.clock_trusted });
});
ipc.listen<UiNetStatus>(UiEvents.NET_STATUS, (n) => store.patch({ net: n }));
ipc.listen<UiAgentStatus>(UiEvents.AGENT_STATUS, (a) => store.patch({ agent: a }));
ipc.listen<{ text: string }>(UiEvents.TOAST, (p) => toast(p.text));

setInterval(() => {
  if (clockEl) clockEl.textContent = `${formatDate(Date.now())} ${formatClock(Date.now(), true)}`;
}, 1000);
setInterval(() => store.patch({ now: Date.now() }), 5000);

void (async () => {
  await loadAccounts();
  await Promise.all([loadForActiveAccount(), loadPrefs()]);
  // Alarm counts arrive only through `Events.ALARM_SNAPSHOT`: notify commands are reserved for the alarm window (strong-alert §6).
  const first = filterConversations(S().conversations, 'doing', '')[0];
  if (first && !S().activeGid) await openConversation(first.gid);
})();

exposeForTests(sel, { __vbkStore: store, __vbkOpenConversation: openConversation });
