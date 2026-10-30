import { personDisplayName } from './person-name.ts';
/**
 * Main window (prototype 02-main): title bar with account tabs, left nav
 * (消息 / 通知 / 订单联系, bottom 设置 / 账号), messages workspace,
 * notification centre, order contact, banner notifier, status bar.
 *
 * Every displayed status comes from a host read-back (command result or
 * event); nothing is assumed: the agent status starts as 「状态未知」 and
 * the network as 「未连接」. All state lives in one store; the view is
 * re-rendered on change (focus/caret/scroll preserved by `rerender`).
 */

import { sendComposer, attachmentSendUnavailable, ATTACHMENT_SEND_UNAVAILABLE } from './sendComposer.ts';
import { applyPlatform } from '../_shared/platform.ts';
const platform = applyPlatform();

import type { AccountContext, SendDisposition } from '../../packages/ipc/src/contracts.ts';
import { RED_AFTER_SECONDS, isAppError } from '../../packages/ipc/src/contracts.ts';
import { AccountCommands, Events, PrefsCommands, WindowLabels } from '../../packages/ipc/src/commands.ts';
import type {
  AgentStatus,
  OrderSearchResult,
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
import { MOCK_ORDER_SAMPLES } from '../../packages/ipc/src/mock.ts';
import { h, icon, rerender, cx } from '../../packages/ui-kit/src/h.ts';
import { createStore, subscribeBatched } from '../../packages/ui-kit/src/store.ts';
import { t } from '../../packages/ui-kit/src/i18n.ts';
import { badgeText, formatClock, formatDate, formatDuration, formatRelativeTime } from '../../packages/ui-kit/src/format.ts';
import { IC } from '../_shared/icons.ts';
import { exposeForTests, selectIpc } from '../_shared/ipc.ts';
import {
  guarded,
  isAlarmSnapshot,
  isAttemptResult,
  isBannerPayload,
  isClockReading,
  isLocatePayload,
  isPrefsSnapshot,
  isSoundName,
  isToastPayload,
  isUiAccountSnapshot,
  isUiAgentStatus,
  isUiConversation,
  isUiMessage,
  isUiNetStatus,
  messageAccount,
} from '../_shared/guards.ts';
import type { SoundName } from '../_shared/guards.ts';
import { playSound, stopSound } from './sound.ts';
import { createPeripheralPanel, type PeripheralKind, type PeripheralPanelState } from './peripheralPanel.ts';
import { settleAccountSend } from './sendScope.ts';
import { messageAlignment } from './message-alignment.ts';
import { mergeMessageProfile, renderMessageAvatar } from './message-profile.ts';
import { createReceiveCounters, createReceiveDiagnostics, receiveDiagnosticsJson, type ReceiveDiagnosticsView } from './receive-diagnostics.ts';
import {
  AGENT_STATUS_ORDER,
  BANNER_VISIBLE,
  MARK_COLORS,
  TRANSLATION_IDLE,
  accountLabel,
  agentStatusColorVar,
  agentStatusDesc,
  agentStatusLabel,
  agentView,
  alarmActiveCount,
  canContactOrder,
  contextMenuCommand,
  contextMenuItems,
  errorMessage,
  expireBanners,
  filterConversations,
  findIccids,
  highlightParts,
  isDone,
  isValidOrderId,
  langName,
  logoutCommand,
  netView,
  nextLocalId,
  orderContactReduce,
  orderDetailUrl,
  previewOf,
  peripheralWriteView,
  pushBanner,
  resumeBanners,
  roleLabel,
  visibleMessages,
  selectedQuoteReference,
  messageQuotePreview,
  mergeQuoteReference,
  sameAccount,
  sendStateView,
  shouldShowTranslationBar,
  tabCounts,
  translationApplies,
  unreadTotal,
} from './viewmodel.ts';
import type { BannerItem, ListTab, LogoutMode, OrderContactState, TranslationState, QuotedUiMessage } from './viewmodel.ts';

/** Host events not (yet) listed in the frozen `Events` / `UiEvents` tables; names mirror `src-tauri/src/events.rs`. */
const HostEvents = {
  LOCATE: 'im://locate-conversation',
  BANNER: 'notify://banner',
  PLAY_SOUND: 'notify://play-sound',
  STOP_SOUND: 'notify://stop-sound',
} as const;

const PERSONAL_SETTINGS_URL = 'https://vbooking.ctrip.com/vbk/im/main';
const EMOJI = ['😀', '😊', '😂', '🙏', '👍', '👌', '👏', '🎉', '❤️', '😅', '🤔', '😢', '🌹', '☀️', '✈️', '🏨', '🎫', '🚌', '📍', '⏰', '✅', '❗', '💡', '🙂'];
const TR_TARGETS = ['en', 'ja', 'ko', 'th', 'vi', 'id', 'ms', 'es', 'fr', 'de', 'ru', 'ar', 'zh-TW', 'pt', 'it', 'tr'];

type View = 'messages' | 'notifications' | 'order';

interface Attachment {
  readonly attachment_id: string;
  readonly name: string;
}

interface MainState {
  readonly accounts: UiAccountSnapshot | null;
  readonly accountsError: string | null;
  readonly loginAttempt: string | null;
  readonly view: View;
  readonly agent: UiAgentStatus;
  readonly agentBusy: boolean;
  /** null until the host has reported the network state. */
  readonly net: UiNetStatus | null;
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
  /** Local display choices only (never sent to the host). */
  readonly hideInboundTr: boolean;
  readonly trBarOff: boolean;
  readonly emoOpen: boolean;
  readonly sideOpen: boolean;
  readonly hotOrder: boolean;
  readonly pkgOpen: boolean;
  readonly pkgHot: boolean;
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
  readonly peripheral: PeripheralPanelState | null;
  readonly receiveDiagnostics: ReceiveDiagnosticsView | null;
  readonly scriptsQuery: string;
  readonly meMenu: boolean;
  readonly logoutDialog: { readonly account: UiAccount; readonly mode: LogoutMode } | null;
  readonly editingTab: { readonly accountId: string; readonly value: string } | null;
  readonly banners: readonly BannerItem[];
  readonly bannerHoverAt: number | null;
  readonly toast: string | null;
}

const PKG_IDLE = { status: 'idle', info: null, error: null } as const;

const initial: MainState = {
  accounts: null,
  accountsError: null,
  loginAttempt: null,
  view: 'messages',
  agent: { status: 'online', confirmed: false },
  agentBusy: false,
  net: null,
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
  hideInboundTr: false,
  trBarOff: false,
  emoOpen: false,
  sideOpen: true,
  hotOrder: false,
  pkgOpen: true,
  pkgHot: false,
  pkg: PKG_IDLE,
  ctxMenu: null,
  noticeCats: [],
  noticeCat: null,
  notices: [],
  orderQuery: '',
  order: { kind: 'idle' },
  orderBusyId: null,
  peripheral: null,
  receiveDiagnostics: null,
  scriptsQuery: '',
  meMenu: false,
  logoutDialog: null,
  editingTab: null,
  banners: [],
  bannerHoverAt: null,
  toast: null,
};

const store = createStore<MainState>(initial);
const sel = selectIpc();
const ipc = sel.ipc;
const root = document.getElementById('app');
if (!root) throw new Error('#app missing');

const peripheral = createPeripheralPanel({
  current: () => {
    const acc = activeAccount();
    const gid = S().activeGid;
    return acc?.state === 'online' && gid ? { account: acc.context, gid } : null;
  },
  invoke: (command, payload) => ipc.invoke(command, payload),
  now: Date.now,
  publish: (state) => {
    const opening = state !== null && S().peripheral === null;
    store.patch({ peripheral: state });
    if (opening) queueMicrotask(() => document.querySelector<HTMLElement>('[data-peripheral-dialog]')?.focus());
  },
  refreshConversation: async (scope) => {
    const rows = await ipc.invoke<unknown>(UiCommands.IM_CONVERSATIONS, { account: scope.account });
    if (stillActive(scope.account) && S().activeGid === scope.gid && Array.isArray(rows)) {
      store.patch({ conversations: rows.filter(isUiConversation) });
    }
  },
});

const receiveCounters = createReceiveCounters();
const receiveDiagnostics = createReceiveDiagnostics({
  current: () => activeAccount()?.context ?? null,
  invoke: (payload) => ipc.invoke(UiCommands.NET_STATUS, payload),
  counters: receiveCounters,
  now: Date.now,
  publish: (view) => {
    const opening = view !== null && S().receiveDiagnostics === null;
    store.patch({ receiveDiagnostics: view });
    if (opening) queueMicrotask(() => document.querySelector<HTMLElement>('[data-receive-diagnostics]')?.focus());
  },
});

function openPeripheral(kind: PeripheralKind): void {
  if (activeAccount() && activeConv()) {
    if (kind === 'scripts') store.patch({ scriptsQuery: '' });
    void peripheral.open(kind);
  }
}

// --------------------------------------------------------------- helpers

function S(): MainState {
  return store.get();
}

function activeAccount(s: MainState = S()): UiAccount | null {
  const snap = s.accounts;
  if (!snap) return null;
  // No fallback: with no active account (first start, login still running) the welcome state is shown.
  return snap.accounts.find((a) => a.context.account_id === snap.active_account_id) ?? null;
}

function accountAvatarName(account: UiAccount): string {
  return account.self_profile?.name ?? accountLabel(account);
}

function activeConv(s: MainState = S()): UiConversation | null {
  return s.conversations.find((c) => c.gid === s.activeGid) ?? null;
}

/** True when `account` is still the active one: results of an in-flight command for another account are dropped. */
function stillActive(account: AccountContext): boolean {
  const acc = activeAccount();
  return !!acc && sameAccount(acc.context, account) && acc.context.session_generation === account.session_generation;
}

/** Per-account state that must not leak across an account switch (navigation itself is kept). */
const ACCOUNT_SCOPED_RESET = {
  conversations: [],
  activeGid: null,
  messages: {},
  draft: '',
  quote: null,
  attachment: null,
  translation: TRANSLATION_IDLE,
  pkg: PKG_IDLE,
  hotOrder: false,
  pkgHot: false,
  noticeCats: [],
  notices: [],
  noticeCat: null,
  order: { kind: 'idle' },
  orderBusyId: null,
  ctxMenu: null,
  meMenu: false,
  emoOpen: false,
  // The read-back belongs to the previous account; the new one starts unknown until the host answers.
  agent: { status: 'online', confirmed: false },
} as const satisfies Partial<MainState>;

let toastTimer: ReturnType<typeof setTimeout> | null = null;
function toast(text: string): void {
  store.patch({ toast: text });
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => store.patch({ toast: null }), 2600);
}

/** User-initiated command: a failure is shown. */
async function invokeSafe<T>(cmd: string, payload?: unknown): Promise<T | null> {
  try {
    return await ipc.invoke<T>(cmd, payload);
  } catch (e) {
    toast(t('misc.failed', { msg: errorMessage(e) }));
    return null;
  }
}

/** Background read: a failure (e.g. `adapter.not_ready`) leaves the view in its unknown state without a toast. */
async function invokeQuiet<T>(cmd: string, payload?: unknown): Promise<T | null> {
  try {
    return await ipc.invoke<T>(cmd, payload);
  } catch (e) {
    console.warn(`[main] ${cmd} failed: ${errorMessage(e)}`);
    return null;
  }
}

function copyText(text: string, done: string = t('misc.copied')): void {
  try {
    void navigator.clipboard?.writeText(text).catch(() => undefined);
  } catch {
    /* clipboard may be unavailable */
  }
  toast(done);
}

/** A control whose official entry has no frozen host command yet: rendered disabled with the reason as tooltip. */
function notWired(control: HTMLElement, reason: string): HTMLElement {
  control.setAttribute('aria-disabled', 'true');
  (control as HTMLButtonElement).disabled = true;
  return h('span', { class: 'dis-wrap', title: reason, dataset: { notWired: '1' } }, control);
}

// --------------------------------------------------------------- loading

async function loadAccounts(): Promise<void> {
  try {
    const snap = await ipc.invoke<unknown>(AccountCommands.SNAPSHOT);
    if (!isUiAccountSnapshot(snap)) throw new Error('account_snapshot 返回格式不正确');
    store.patch({ accounts: snap, accountsError: null });
  } catch (e) {
    store.patch({ accounts: { accounts: [], active_account_id: null, max_accounts: 16 }, accountsError: errorMessage(e) });
  }
}

async function loadForActiveAccount(): Promise<void> {
  const acc = activeAccount();
  if (!acc) return;
  const account = acc.context;
  const [convs, agent, net, cats] = await Promise.all([
    invokeQuiet<UiConversation[]>(UiCommands.IM_CONVERSATIONS, { account }),
    invokeQuiet<unknown>(UiCommands.ACCOUNT_AGENT_STATUS, { account }),
    invokeQuiet<unknown>(UiCommands.NET_STATUS, {}),
    invokeQuiet<UiNoticeCategory[]>(UiCommands.NOTICE_CATEGORIES, { account }),
  ]);
  if (!stillActive(account)) return; // the user switched accounts meanwhile: these belong to the old one
  const s = S();
  const conversations = Array.isArray(convs) ? convs.filter(isUiConversation) : [];
  const noticeCats = Array.isArray(cats) ? cats : [];
  store.patch({
    conversations,
    noticeCats,
    agent: isUiAgentStatus(agent) ? agent : s.agent,
    net: isUiNetStatus(net) ? net : s.net,
    noticeCat: s.noticeCat && noticeCats.some((c) => c.id === s.noticeCat) ? s.noticeCat : (noticeCats[0]?.id ?? null),
    activeGid: s.activeGid && !conversations.some((c) => c.gid === s.activeGid) ? null : s.activeGid,
  });
  if (S().noticeCat) await loadNotices();
  // Opening a conversation can acknowledge unread messages. Background account
  // refresh must wait for an explicit user selection instead of opening row one.
}

async function loadNotices(): Promise<void> {
  const acc = activeAccount();
  const s = S();
  if (!acc || !s.noticeCat) return;
  const list = await invokeQuiet<UiNotice[]>(UiCommands.NOTICE_LIST, { account: acc.context, category_id: s.noticeCat });
  if (list && stillActive(acc.context)) store.patch({ notices: list });
}

async function loadPrefs(): Promise<void> {
  const p = await invokeQuiet<unknown>(PrefsCommands.SNAPSHOT);
  if (isPrefsSnapshot(p)) store.patch({ prefs: p });
}

async function loadNet(): Promise<void> {
  const n = await invokeQuiet<unknown>(UiCommands.NET_STATUS, {});
  if (isUiNetStatus(n)) store.patch({ net: n });
}

// --------------------------------------------------------------- accounts

function applyAccountSnapshot(snap: UiAccountSnapshot): void {
  const prev = S().accounts?.active_account_id ?? null;
  const nextAccount = snap.accounts.find((a) => a.context.account_id === snap.active_account_id);
  if (nextAccount?.state !== 'online') { peripheral.close(); receiveDiagnostics.close(); }
  const attempt = S().loginAttempt;
  // The login attempt is over once no account is logging in any more.
  const loginAttempt = attempt && snap.accounts.some((a) => a.state === 'logging_in') ? attempt : null;
  if (snap.active_account_id !== prev || activeAccount()?.context.environment !== nextAccount?.context.environment || activeAccount()?.context.session_generation !== nextAccount?.context.session_generation) {
    peripheral.close();
    receiveDiagnostics.close();
    store.patch({ accounts: snap, accountsError: null, loginAttempt, ...ACCOUNT_SCOPED_RESET });
    void loadForActiveAccount();
  } else {
    store.patch({ accounts: snap, accountsError: null, loginAttempt });
  }
}

async function switchAccount(a: UiAccount): Promise<void> {
  if (a.state === 'logging_in') return;
  // Clicking the tab that is already active is a no-op: it must not close the open conversation or drop the draft.
  if (a.context.account_id === S().accounts?.active_account_id) return;
  const snap = await invokeSafe<unknown>(AccountCommands.SWITCH, { account: a.context });
  if (isUiAccountSnapshot(snap)) applyAccountSnapshot(snap);
}

/** `account_start_login` → `{attempt_id}`; the host opens the login window and publishes the account itself. */
async function startLogin(relogin?: AccountContext): Promise<void> {
  try {
    const r = await ipc.invoke<unknown>(AccountCommands.START_LOGIN, relogin ? { account: relogin } : {});
    if (isAttemptResult(r)) store.patch({ loginAttempt: r.attempt_id });
  } catch (e) {
    toast(t('misc.failed', { msg: errorMessage(e) }));
  }
}

async function cancelLogin(): Promise<void> {
  const attempt = S().loginAttempt;
  if (!attempt) return;
  const snap = await invokeSafe<unknown>(UiCommands.ACCOUNT_CANCEL_LOGIN, { attempt_id: attempt });
  store.patch({ loginAttempt: null });
  if (isUiAccountSnapshot(snap)) applyAccountSnapshot(snap);
}

async function saveRemark(): Promise<void> {
  const s = S();
  const e = s.editingTab;
  if (!e) return;
  const acc = s.accounts?.accounts.find((a) => a.context.account_id === e.accountId);
  store.patch({ editingTab: null });
  if (!acc) return;
  if ((acc.remark ?? '') === e.value.trim()) return;
  const snap = await invokeSafe<unknown>(UiCommands.ACCOUNT_SET_REMARK, { account: acc.context, remark: e.value });
  if (isUiAccountSnapshot(snap)) applyAccountSnapshot(snap);
}

async function confirmLogout(): Promise<void> {
  const d = S().logoutDialog;
  if (!d) return;
  store.patch({ logoutDialog: null });
  const snap = await invokeSafe<unknown>(logoutCommand(d.mode), { account: d.account.context });
  if (isUiAccountSnapshot(snap)) applyAccountSnapshot(snap);
}

/** Work status changes only after the server read-back (`account_set_agent_status` result). */
async function setAgentStatus(status: AgentStatus): Promise<void> {
  const acc = activeAccount();
  if (!acc || S().agentBusy) return;
  store.patch({ agentBusy: true, meMenu: false });
  try {
    const r = await ipc.invoke<unknown>(UiCommands.ACCOUNT_SET_AGENT_STATUS, { account: acc.context, status });
    if (!stillActive(acc.context)) return;
    if (isUiAgentStatus(r)) {
      store.patch({ agent: r });
      toast(r.confirmed && r.status === status ? t('me.statusOk', { s: agentStatusLabel(r.status) }) : t('me.statusUnconfirmed'));
    }
  } catch (e) {
    toast(t('me.statusFailed', { msg: errorMessage(e) }));
  } finally {
    store.patch({ agentBusy: false });
  }
}

// --------------------------------------------------------------- messages

/** `reveal`: switch to the messages view (user action); the automatic first-open keeps the current view. */
async function openConversation(gid: string, reveal = true): Promise<void> {
  const acc = activeAccount();
  if (!acc) return;
  const s = S();
  const view: View = reveal ? 'messages' : s.view;
  // Opening a conversation dismisses its banner; it never touches the alarm round (host-owned).
  const banners = s.banners.filter((b) => !(b.gid === gid && sameAccount(b.account, acc.context)));
  if (s.activeGid === gid && s.messages[gid]) {
    store.patch({ view, ctxMenu: null, banners });
    return;
  }
  peripheral.close();
  store.patch({ activeGid: gid, view, banners, draft: s.conversations.find((c) => c.gid === gid)?.draft ?? '', draftVersion: s.draftVersion + 1, quote: null, attachment: null, translation: TRANSLATION_IDLE, pkg: PKG_IDLE, pkgHot: false, hotOrder: false, ctxMenu: null, emoOpen: false });
  const list = await invokeQuiet<UiMessage[]>(UiCommands.IM_MESSAGES, { account: acc.context, gid });
  if (list && S().activeGid === gid && stillActive(acc.context)) {
    store.patch({ messages: { ...S().messages, [gid]: list.filter(isUiMessage) } });
    const conv = S().conversations.find((c) => c.gid === gid);
    if (conv && conv.unread_count > 0) await invokeQuiet(UiCommands.IM_MARK_READ, { account: acc.context, gid });
    autoQueryPackage();
  }
}

/** `im://locate-conversation` (alarm click, tray, banner): activate the owning account and open the conversation. */
async function locateConversation(account: AccountContext, gid: string): Promise<void> {
  const snap = S().accounts;
  const target = snap?.accounts.find((a) => a.context.account_id === account.account_id && a.context.environment === account.environment);
  if (!target || target.context.session_generation !== account.session_generation) return; // stale generation or unknown account
  if (snap?.active_account_id !== target.context.account_id) {
    const next = await invokeSafe<unknown>(AccountCommands.SWITCH, { account: target.context });
    if (!isUiAccountSnapshot(next)) return;
    applyAccountSnapshot(next);
    // wait for the new account's list before opening
    for (let i = 0; i < 50 && !S().conversations.some((c) => c.gid === gid); i += 1) await new Promise((r) => setTimeout(r, 40));
  }
  store.patch({ tab: S().conversations.find((c) => c.gid === gid && isDone(c)) ? 'done' : 'doing' });
  await openConversation(gid);
}

function receiveMainMessage(payload: unknown): void {
  const scope = activeAccount()?.context ?? null;
  receiveCounters.count(scope, 'received');
  guarded(Events.IM_MESSAGE_NEW, (value): value is UiMessage => {
    const accepted = isUiMessage(value);
    if (!accepted) receiveCounters.count(scope, 'guard_rejected');
    return accepted;
  }, (m) => {
    const owner = messageAccount(m);
    if (owner && !stillActive(owner)) { receiveCounters.count(scope, 'account_dropped'); return; }
    if (upsertMessage(m)) receiveCounters.count(scope, 'upserted');
  })(payload);
}

function upsertMessage(m: UiMessage): boolean {
  const s = S();
  const list = s.messages[m.gid];
  if (!list) return false;
  const idx = list.findIndex((x) => (m.local_id && x.local_id === m.local_id) || (m.message_id && x.message_id === m.message_id));
  const next = idx >= 0 ? list.map((x, i) => (i === idx ? mergeQuoteReference(x, mergeMessageProfile(x, m)) : x)) : [...list, m];
  const quote = s.quote?.gid === m.gid && !selectedQuoteReference(s.quote, next, m.gid) ? null : s.quote;
  store.patch({ messages: { ...s.messages, [m.gid]: next }, quote });
  return true;
}

function upsertConversation(c: UiConversation): void {
  const s = S();
  const exists = s.conversations.some((x) => x.gid === c.gid);
  store.patch({ conversations: exists ? s.conversations.map((x) => (x.gid === c.gid ? c : x)) : [...s.conversations, c] });
  // Viewing the conversation reads it; the waiting round stays host-owned (read ≠ replied).
  if (c.gid === S().activeGid && c.unread_count > 0 && S().view === 'messages' && document.visibilityState === 'visible') {
    void invokeQuiet(UiCommands.IM_MARK_READ, { account: c.account, gid: c.gid });
  }
}

async function sendText(text: string, original: string | null): Promise<void> {
  if (attachmentSendUnavailable(S().attachment)) { toast(ATTACHMENT_SEND_UNAVAILABLE); return; }
  const acc = activeAccount();
  const conv = activeConv();
  if (!acc || !conv || isDone(conv)) return;
  const s = S();
  const localId = nextLocalId(Date.now());
  const quote = selectedQuoteReference(s.quote, s.messages[conv.gid] ?? [], conv.gid);
  const local: QuotedUiMessage = { gid: conv.gid, message_id: null, local_id: localId, create_time_ms: Date.now(), sender_role: 'merchant_self', kind: 'text', text, translation: null, original, quote: quote?.target_id ?? null, quote_target_id: quote?.target_id ?? null, order_id: null, disposition: null };
  store.patch({ messages: { ...s.messages, [conv.gid]: [...(s.messages[conv.gid] ?? []), local] }, draft: '', draftVersion: s.draftVersion + 1, quote: null, attachment: null, translation: { ...TRANSLATION_IDLE, target: s.translation.target } });
  const result = await settleAccountSend(acc.context,
    () => ipc.invoke<SendDisposition>(UiCommands.IM_SEND_TEXT, { account: acc.context, gid: conv.gid, local_id: localId, text, original: original ?? undefined, quote_id: quote?.target_id }),
    () => activeAccount()?.context ?? null);
  // The helper guards success and failure; re-check at the actual projection boundary too.
  if (result.kind === 'stale' || !stillActive(acc.context)) return;
  if (result.kind === 'result') {
    const d = result.value;
    upsertMessage({ ...local, disposition: d, message_id: d.kind === 'confirmed' ? d.server_message_id : null });
  } else {
    const e = result.error;
    // An IPC failure is not a server rejection: the result is unknown and must not be auto-resent.
    upsertMessage({ ...local, disposition: isAppError(e) && e.code === 'im.permission_denied' ? { kind: 'rejected', code: e.code, reason: e.message } : { kind: 'unknown' } });
  }
}

function translationOn(s: MainState, conv: UiConversation): boolean {
  return !s.trBarOff && shouldShowTranslationBar(conv, !!s.prefs?.assistant.enabled, !!s.prefs?.assistant.outbound_translation);
}

async function handleSend(): Promise<void> {
  const s = S();
  const conv = activeConv(s);
  if (!conv || isDone(conv)) return;
  const result = await sendComposer({ draft: s.draft, attachment: s.attachment }, async (text) => {
    if (s.prefs?.assistant.send_mode === 'send_direct' && translationOn(s, conv)) {
      await translateAndSend(text);
      return;
    }
    await sendText(text, null);
  });
  if (result === 'blocked_attachment') toast(ATTACHMENT_SEND_UNAVAILABLE);
}

function translationTarget(s: MainState, conv: UiConversation): string {
  return s.translation.gid === conv.gid || s.translation.target !== 'en' ? s.translation.target : conv.lang === 'zh' ? 'en' : conv.lang;
}

async function translateAndSend(text: string): Promise<void> {
  if (attachmentSendUnavailable(S().attachment)) { toast(ATTACHMENT_SEND_UNAVAILABLE); return; }
  const acc = activeAccount();
  const conv = activeConv();
  if (!acc || !conv) return;
  const s = S();
  const version = s.draftVersion;
  const target = translationTarget(s, conv);
  store.patch({ translation: { status: 'busy', gid: conv.gid, draftVersion: version, target, text: '', error: null } });
  try {
    const r = await ipc.invoke<{ draft_version: number; text: string }>(UiCommands.ASSIST_TRANSLATE, { account: acc.context, gid: conv.gid, draft_version: version, text, target });
    if (!stillActive(acc.context) || S().activeGid !== conv.gid || S().draftVersion !== version || r.draft_version !== version) return; // account, room or draft changed while translating
    await sendText(r.text, text);
  } catch (e) {
    if (!stillActive(acc.context) || S().activeGid !== conv.gid || S().draftVersion !== version) return;
    const msg = isAppError(e) && e.code === 'assistant.tsim_unauthenticated' ? t('tr.needLogin') : errorMessage(e);
    store.patch({ translation: { status: 'error', gid: conv.gid, draftVersion: version, target, text: '', error: msg } });
  }
}

let trTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleTranslation(): void {
  if (trTimer) clearTimeout(trTimer);
  const s = S();
  const conv = activeConv(s);
  if (!conv || !s.prefs || !translationOn(s, conv)) return;
  if (s.prefs.assistant.send_mode !== 'replace_draft') return;
  const text = s.draft.trim();
  if (!text) {
    store.patch({ translation: { ...TRANSLATION_IDLE, gid: conv.gid, target: translationTarget(s, conv) } });
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
  const target = translationTarget(s, conv);
  store.patch({ translation: { status: 'busy', gid: conv.gid, draftVersion: version, target, text: '', error: null } });
  try {
    const r = await ipc.invoke<{ draft_version: number; text: string }>(UiCommands.ASSIST_TRANSLATE, { account: acc.context, gid: conv.gid, draft_version: version, text, target });
    if (!stillActive(acc.context) || S().activeGid !== conv.gid || S().draftVersion !== version || !translationApplies(S().translation, conv.gid, version) || r.draft_version !== version) return;
    store.patch({ translation: { status: 'done', gid: conv.gid, draftVersion: version, target, text: r.text, error: null } });
  } catch (e) {
    if (!stillActive(acc.context) || S().activeGid !== conv.gid || S().draftVersion !== version || !translationApplies(S().translation, conv.gid, version)) return;
    const msg = isAppError(e) && e.code === 'assistant.tsim_unauthenticated' ? t('tr.needLogin') : errorMessage(e);
    store.patch({ translation: { status: 'error', gid: conv.gid, draftVersion: version, target, text: '', error: msg } });
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

async function attach(kind: 'screenshot' | 'image' | 'file'): Promise<void> {
  const r = kind === 'screenshot' ? await invokeSafe<Attachment>(UiCommands.MEDIA_SCREENSHOT, {}) : await invokeSafe<Attachment | null>(UiCommands.MEDIA_PICK, { kind });
  if (r) store.patch({ attachment: r });
}

async function toggleTop(c: UiConversation): Promise<void> {
  const { cmd, payload } = contextMenuCommand(c, { kind: 'toggle_top' });
  store.patch({ ctxMenu: null });
  const next = await invokeSafe<unknown>(cmd, payload);
  if (isUiConversation(next) && stillActive(next.account)) upsertConversation(next);
}

async function setMark(c: UiConversation, action: 0 | 1 | 2 | 3 | 4 | 5): Promise<void> {
  const { cmd, payload } = contextMenuCommand(c, { kind: 'mark', action });
  store.patch({ ctxMenu: null });
  const next = await invokeSafe<unknown>(cmd, payload);
  if (isUiConversation(next) && stillActive(next.account)) upsertConversation(next); // failure keeps the old value
}

async function queryPackage(iccid: string, force = false): Promise<void> {
  const s = S();
  if (!iccid) return;
  if (!force && s.pkg.info && s.pkg.info.iccid === iccid && Date.now() - s.pkg.info.fetched_at_ms < 60_000) return;
  const gid = s.activeGid;
  store.patch({ pkg: { status: 'busy', info: s.pkg.info, error: null } });
  try {
    const info = await ipc.invoke<UiPackageInfo>(UiCommands.ASSIST_PACKAGE, { iccid });
    if (S().activeGid !== gid) return;
    store.patch({ pkg: { status: 'done', info, error: null } });
  } catch (e) {
    if (S().activeGid !== gid) return;
    store.patch({ pkg: { status: 'error', info: null, error: errorMessage(e) } });
  }
}

function packageEnabled(s: MainState): boolean {
  return !!s.prefs?.assistant.enabled && !!s.prefs?.assistant.package_quick_view;
}

/** Prototype: the package card fills in as soon as an ICCID shows up in the conversation (host caches 60 s). */
function autoQueryPackage(): void {
  const s = S();
  const gid = s.activeGid;
  if (!gid || !packageEnabled(s) || s.pkg.status !== 'idle') return;
  const id = findIccids(s.messages[gid] ?? [])[0];
  if (id) void queryPackage(id);
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
  const cats = await invokeQuiet<UiNoticeCategory[]>(UiCommands.NOTICE_CATEGORIES, { account: acc.context });
  if (cats && stillActive(acc.context)) store.patch({ noticeCats: cats });
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
    const result = await ipc.invoke<OrderSearchResult>(UiCommands.ORDER_SEARCH, { account: acc.context, order_id: orderId });
    if (!stillActive(acc.context)) return; // the result is scoped to the account that issued the query
    store.patch({ order: orderContactReduce(S().order, { type: 'result', orderId, result }) });
  } catch (e) {
    if (!stillActive(acc.context)) return;
    store.patch({ order: orderContactReduce(S().order, { type: 'error', orderId, error: e }) });
  }
}

function selectOrder(o: UiOrderSummary): void {
  store.patch({ order: orderContactReduce(S().order, { type: 'select', orderId: o.order_id }) });
}

async function contactViaIm(o: UiOrderSummary): Promise<void> {
  const acc = activeAccount();
  if (!acc || S().orderBusyId || !canContactOrder(S().order)) return;
  store.patch({ orderBusyId: o.order_id });
  try {
    // Both calls carry the account that was active when the user clicked, even if they switch tabs meanwhile.
    const r = await ipc.invoke<{ gid: string; reused: boolean }>(UiCommands.ORDER_CREATE_IM_CHAT, { account: acc.context, order_id: o.order_id });
    const convs = await ipc.invoke<UiConversation[]>(UiCommands.IM_CONVERSATIONS, { account: acc.context });
    if (!stillActive(acc.context)) return; // never show another account's conversations under the active tab
    store.patch({ conversations: convs.filter(isUiConversation), orderBusyId: null, tab: 'doing' });
    await openConversation(r.gid);
  } catch (e) {
    if (!stillActive(acc.context)) return;
    store.patch({ orderBusyId: null });
    toast(t('order.imFailed', { msg: errorMessage(e) }));
  }
}

async function openWebAdvanced(o: UiOrderSummary | string): Promise<void> {
  const acc = activeAccount();
  if (!acc) return;
  await invokeSafe(UiCommands.SHELL_OPEN_WEBVIEW, { account: acc.context, url: orderDetailUrl(typeof o === 'string' ? o : o.order_id) });
}

function goOrderDetail(orderId: string): void {
  store.patch({ view: 'order', orderQuery: orderId });
  void runOrderQuery(orderId);
}

// --------------------------------------------------------------- banners & sounds

let bannerSeq = 0;
function onBanner(p: { account: AccountContext; gid: string; count: number; stay_ms: number; system?: boolean }): void {
  const s = S();
  const acc = activeAccount(s);
  // No banner for the conversation the user is looking at.
  if (acc && sameAccount(acc.context, p.account) && s.activeGid === p.gid && s.view === 'messages' && document.visibilityState === 'visible') return;
  bannerSeq += 1;
  store.patch({ banners: pushBanner(s.banners, { id: bannerSeq, account: p.account, gid: p.gid, count: p.count, system: p.system === true, at: Date.now(), stayMs: p.stay_ms }) });
}

function dismissBanner(id: number): void {
  store.patch({ banners: S().banners.filter((b) => b.id !== id) });
}

const soundLog: SoundName[] = [];
function onPlaySound(name: SoundName): void {
  soundLog.push(name);
  playSound(name);
}

// --------------------------------------------------------------- rendering

function accBadge(n: number): HTMLElement | null {
  const txt = badgeText(n);
  return txt ? h('span', { class: 'badge' }, txt) : null;
}

/** Windows: double-click on the drag region maximizes through the host command (Tauri's own handler is bypassed). */
function onTitleMouseDown(e: MouseEvent): void {
  if (platform !== 'windows' || e.button !== 0 || e.detail !== 2) return;
  const target = e.target as HTMLElement | null;
  if (!target || !target.hasAttribute('data-tauri-drag-region')) return;
  e.preventDefault();
  e.stopPropagation();
  void invokeSafe(UiCommands.SHELL_WINDOW, { action: 'toggle_maximize' });
}

function titleBar(s: MainState): HTMLElement {
  const snap = s.accounts;
  const tabs = (snap?.accounts ?? []).map((a) => {
    const on = a.context.account_id === snap?.active_account_id;
    const editing = s.editingTab?.accountId === a.context.account_id;
    const logging = a.state === 'logging_in';
    return h(
      'div',
      {
        class: cx('tab', { on, logging }),
        role: 'tab',
        'aria-selected': String(on),
        title: t('tab.editRemark'),
        dataset: { account: a.context.account_id, state: a.state },
        onclick: () => void switchAccount(a),
        ondblclick: (e: Event) => {
          e.preventDefault();
          if (logging) return;
          store.patch({ editingTab: { accountId: a.context.account_id, value: a.remark ?? a.nick } });
        },
      },
      h('span', { class: 'tab-ava', style: { background: a.color } }, renderMessageAvatar(document, accountAvatarName(a), a.self_profile?.avatar)),
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
      logging ? h('span', { class: 'tab-warn', dataset: { tabState: 'logging_in' } }, h('span', { class: 'spin' }), t('tab.loggingIn')) : null,
      a.state === 'expired' ? h('span', { class: 'tab-warn', dataset: { tabState: 'expired' } }, icon(IC.alert, 13), t('tab.expired')) : null,
      a.state === 'suspended' ? h('span', { class: 'tab-warn muted', dataset: { tabState: 'suspended' } }, t('tab.suspended')) : null,
      a.unread > 0 && !on && a.state !== 'expired' ? h('span', { class: 'tab-badge' }, badgeText(a.unread)) : null,
      h(
        'button',
        {
          class: 'tab-x',
          'aria-label': logging && s.loginAttempt ? t('tab.cancelLogin') : t('tab.logout'),
          title: logging && s.loginAttempt ? t('tab.cancelLogin') : t('tab.logout'),
          onclick: (e: Event) => {
            e.stopPropagation();
            if (logging && s.loginAttempt) void cancelLogin();
            else store.patch({ logoutDialog: { account: a, mode: 'suspend' }, meMenu: false });
          },
        },
        icon(IC.close, 12),
      ),
    );
  });
  const canAdd = !snap || snap.accounts.length < snap.max_accounts;
  return h(
    'div',
    { class: 'tb', 'data-tauri-drag-region': true, onmousedown: onTitleMouseDown },
    h('div', { class: 'tb-logo', 'data-tauri-drag-region': true }, h('div', { class: 'logo', 'aria-hidden': 'true', 'data-tauri-drag-region': true }, 'V')),
    h(
      'div',
      { class: 'tabs', role: 'tablist', 'aria-label': '已登录账号', 'data-tauri-drag-region': true },
      tabs,
      canAdd ? h('button', { class: 'tab-add', 'aria-label': t('tab.add'), title: t('tab.addTitle', { max: snap?.max_accounts ?? 16 }), dataset: { action: 'add-account' }, onclick: () => void startLogin() }, icon(IC.plus, 16)) : null,
    ),
    s.alarmCount > 0
      ? h('button', { class: 'tb-alarm', title: t('tb.alarmTitle', { n: s.alarmCount }), dataset: { tbAlarm: String(s.alarmCount) }, onclick: () => void invokeSafe(UiCommands.SHELL_OPEN_WINDOW, { label: WindowLabels.ALARM }) }, icon(IC.clock, 13), t('tb.alarm', { n: s.alarmCount }))
      : null,
    h(
      'div',
      { class: 'wbtns' },
      h('button', { class: 'wbtn', 'aria-label': t('win.minimize'), dataset: { win: 'minimize' }, onclick: () => void invokeSafe(UiCommands.SHELL_WINDOW, { action: 'minimize' }) }, icon(IC.min, 14)),
      h('button', { class: 'wbtn', 'aria-label': t('win.maximize'), dataset: { win: 'toggle_maximize' }, onclick: () => void invokeSafe(UiCommands.SHELL_WINDOW, { action: 'toggle_maximize' }) }, icon(IC.max, 13)),
      h('button', { class: 'wbtn x', 'aria-label': t('win.close'), dataset: { win: 'close' }, onclick: () => void invokeSafe(UiCommands.SHELL_WINDOW, { action: 'close' }) }, icon(IC.close, 14)),
    ),
  );
}

function navBar(s: MainState): HTMLElement {
  const acc = activeAccount(s);
  const unreadMsgs = unreadTotal(s.conversations);
  const unreadNotice = s.noticeCats.reduce((n, c) => n + c.unread, 0);
  const av = agentView(s.agent);
  const item = (view: View, label: string, d: string, badge: number, extra: HTMLElement | null = null) =>
    h(
      'button',
      { class: cx('nav-i', { on: s.view === view }), 'aria-label': label, 'aria-current': s.view === view ? 'page' : undefined, dataset: { nav: view }, onclick: () => store.patch({ view, ctxMenu: null, meMenu: false }) },
      icon(d, 20),
      h('span', null, label),
      badge > 0 ? h('span', { class: 'nav-badge' }, badgeText(badge)) : null,
      extra,
    );
  const alarm = s.alarmCount > 0 ? h('span', { class: 'nav-alarm', title: t('tb.alarmTitle', { n: s.alarmCount }), dataset: { navAlarm: String(s.alarmCount) } }, icon(IC.clock, 9), String(s.alarmCount)) : null;
  return h(
    'nav',
    { class: 'nav', 'aria-label': '导航' },
    item('messages', t('nav.messages'), IC.chat, unreadMsgs, alarm),
    item('notifications', t('nav.notifications'), IC.bell, unreadNotice),
    item('order', t('nav.orderContact'), IC.order, 0),
    h('div', { class: 'nav-sp' }),
    h('button', { class: 'nav-i', 'aria-label': t('nav.settings'), dataset: { nav: 'settings' }, onclick: () => void invokeSafe(UiCommands.SHELL_OPEN_WINDOW, { label: WindowLabels.SETTING }) }, icon(IC.gear, 20), h('span', null, t('nav.settings'))),
    h(
      'button',
      {
        class: 'me',
        style: { background: acc?.color ?? '#5B6676' },
        'aria-label': `${t('nav.account')}：${av.label}`,
        'aria-expanded': String(s.meMenu),
        disabled: !acc,
        dataset: { nav: 'me' },
        onclick: (e: Event) => {
          e.stopPropagation();
          store.patch({ meMenu: !s.meMenu, ctxMenu: null });
        },
      },
      acc ? renderMessageAvatar(document, accountAvatarName(acc), acc.self_profile?.avatar) : '?',
      acc ? h('span', { class: 'me-dot', style: { background: `var(${av.colorVar})` } }) : null,
    ),
  );
}

function meMenu(s: MainState): HTMLElement | null {
  if (!s.meMenu) return null;
  const acc = activeAccount(s);
  if (!acc) return null;
  const close = () => store.patch({ meMenu: false });
  return h(
    'div',
    { class: 'menu me-menu', role: 'menu', onmousedown: (e: Event) => e.stopPropagation() },
    h('div', { class: 'me-head' }, h('div', { class: 'ava', style: { background: acc.color } }, renderMessageAvatar(document, accountAvatarName(acc), acc.self_profile?.avatar)), h('div', { class: 'me-head-t' }, h('div', { style: { 'font-weight': '600' } }, accountLabel(acc)), h('div', { class: 'muted', style: { 'font-size': '12px' } }, acc.party))),
    h('div', { class: 'msep' }),
    h('div', { class: 'mhead' }, t('me.statusHead')),
    AGENT_STATUS_ORDER.map((st) =>
      h(
        'button',
        { class: 'mi', role: 'menuitem', dataset: { agentStatus: st }, disabled: s.agentBusy, onclick: () => void setAgentStatus(st) },
        h('span', { class: 'dot', style: { background: `var(${agentStatusColorVar(st)})` } }),
        h('span', { style: { flex: '1' } }, agentStatusLabel(st)),
        h('span', { class: 'muted', style: { 'font-size': '11.5px' } }, agentStatusDesc(st)),
        s.agent.confirmed && st === s.agent.status ? icon(IC.check, 14, { style: 'color: var(--c-primary)' }) : null,
      ),
    ),
    h('div', { class: 'msep' }),
    h('button', { class: 'mi', role: 'menuitem', onclick: () => { close(); void invokeSafe(UiCommands.SHELL_OPEN_WEBVIEW, { account: acc.context, url: PERSONAL_SETTINGS_URL }); } }, t('me.personalSettings')),
    h('button', { class: 'mi', role: 'menuitem', onclick: () => { close(); void invokeSafe(UiCommands.SHELL_OPEN_WINDOW, { label: WindowLabels.SETTING }); } }, t('me.desktopSettings')),
    h('button', { class: 'mi', role: 'menuitem', onclick: () => { close(); void invokeSafe(UiCommands.SHELL_OPEN_WINDOW, { label: WindowLabels.UPDATE }); } }, t('me.checkUpdate')),
    h('div', { class: 'msep' }),
    h('button', { class: 'mi', role: 'menuitem', dataset: { me: 'suspend' }, onclick: () => store.patch({ meMenu: false, logoutDialog: { account: acc, mode: 'suspend' } }) }, t('me.logoutSuspend')),
    h('button', { class: 'mi dan', role: 'menuitem', dataset: { me: 'logout' }, onclick: () => store.patch({ meMenu: false, logoutDialog: { account: acc, mode: 'logout' } }) }, t('me.logoutFull')),
  );
}

// ---- welcome (no account)

function welcomeView(s: MainState): HTMLElement {
  const snap = s.accounts;
  const loggingIn = !!snap?.accounts.some((a) => a.state === 'logging_in');
  return h(
    'div',
    { class: 'content' },
    h(
      'div',
      { class: 'welcome', dataset: { welcome: snap ? 'ready' : 'loading' } },
      h(
        'div',
        { class: 'welcome-card' },
        h('div', { class: 'welcome-logo', 'aria-hidden': 'true' }, 'V'),
        h('div', { class: 'welcome-title' }, t('welcome.title')),
        h('div', { class: 'welcome-desc' }, snap ? t('welcome.desc') : t('welcome.loading')),
        s.accountsError ? h('div', { class: 'notice-box err', dataset: { welcomeError: '1' } }, t('welcome.loadFailed', { msg: s.accountsError }), ' ', h('button', { class: 'link', onclick: () => void loadAccounts() }, t('welcome.retry'))) : null,
        loggingIn ? h('div', { class: 'notice-box info' }, t('welcome.loggingIn')) : null,
        h('button', { class: 'btn pri welcome-add', dataset: { action: 'welcome-add' }, disabled: !snap || loggingIn, onclick: () => void startLogin() }, icon(IC.plus, 15), t('welcome.add')),
        h('div', { class: 'welcome-foot' }, t('welcome.foot', { max: snap?.max_accounts ?? 16 })),
      ),
    ),
  );
}

// ---- messages view

function waitedSeconds(c: UiConversation, now: number): number {
  return Math.max(0, Math.floor((now - (c.waiting_since_ms ?? now)) / 1000));
}

function conversationList(s: MainState): HTMLElement {
  const counts = tabCounts(s.conversations);
  const list = filterConversations(s.conversations, s.tab, s.query);
  const acc = activeAccount(s);
  const av = agentView(s.agent);
  const nv = netView(s.net);
  const rows = list.map((c) => {
    const on = c.gid === s.activeGid;
    const waiting = c.waiting_since_ms !== null && !isDone(c);
    const waited = waiting ? waitedSeconds(c, s.now) : 0;
    const mark = MARK_COLORS.find((m) => m.action === c.mark);
    const hasDraft = !!c.draft && !on;
    return h(
      'div',
      {
        class: cx('conv', { on, top: c.is_top }),
        role: 'button',
        tabindex: '0',
        dataset: { gid: c.gid },
        onclick: () => void openConversation(c.gid),
        onkeydown: (e: KeyboardEvent) => {
          if (e.key === 'Enter') void openConversation(c.gid);
        },
        oncontextmenu: (e: MouseEvent) => {
          e.preventDefault();
          store.patch({ ctxMenu: { gid: c.gid, x: e.clientX, y: e.clientY }, meMenu: false });
        },
      },
      mark ? h('span', { class: 'cmark', style: { background: `var(${mark.cssVar})` }, 'aria-label': t('ctx.markAs', { color: t(mark.nameKey) }) }) : null,
      h('div', { class: 'ava', style: { background: c.color } }, renderMessageAvatar(document, c.title, c.customer_avatar)),
      h(
        'div',
        { class: 'conv-main' },
        h('div', { class: 'crow' }, h('span', { class: 'cname' }, c.title), c.lang !== 'zh' ? h('span', { class: 'chip chip-lang' }, langName(c.lang)) : null, h('span', { class: 'ctime' }, c.last_message_time_ms ? formatRelativeTime(c.last_message_time_ms, s.now) : '')),
        h('div', { class: 'crow' }, hasDraft ? h('span', { class: 'cdraft' }, t('list.draft')) : null, h('span', { class: 'cprev' }, hasDraft ? c.draft : c.preview), accBadge(c.unread_count)),
        h(
          'div',
          { class: 'crow', style: { 'margin-top': '2px' } },
          h('span', { class: 'chip chip-biz' }, c.biz),
          waiting ? h('span', { class: cx('wait', waited >= RED_AFTER_SECONDS ? 'red' : 'amber'), title: c.waiting_confirmed ? undefined : t('alarm.pendingTitle') }, icon(IC.clock, 11), c.waiting_confirmed ? t('list.waiting', { t: formatDuration(waited) }) : `${t('list.waiting', { t: formatDuration(waited) })} · ${t('list.waitingPending')}`) : null,
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
        h(
          'button',
          { class: 'stat-pill', title: t('me.statusHead'), dataset: { agent: av.known ? s.agent.status : 'unknown' }, onclick: (e: Event) => { e.stopPropagation(); store.patch({ meMenu: !S().meMenu, ctxMenu: null }); } },
          h('span', { class: 'dot', style: { background: `var(${av.colorVar})` } }),
          av.label,
          s.agentBusy ? h('span', { class: 'spin' }) : null,
          icon(IC.chevDown, 12),
        ),
        h('span', { class: 'muted', style: { 'font-size': '12px' }, title: t('list.queueTitle'), dataset: { serving: String(counts.doing) } }, `${t('list.serving', { n: counts.doing })} · ${t('list.queue')}`),
      ),
      h('label', { class: 'search', title: t('list.searchHint') }, icon(IC.search, 15), h('input', { class: 'inp', placeholder: t('list.search'), 'aria-label': t('list.searchLabel'), value: s.query, dataset: { fid: 'search' }, oninput: (e: Event) => store.patch({ query: (e.target as HTMLInputElement).value }) })),
      h(
        'div',
        { class: 'ftabs', role: 'tablist' },
        h('button', { class: cx('ftab', { on: s.tab === 'doing' }), role: 'tab', 'aria-selected': String(s.tab === 'doing'), dataset: { tab: 'doing' }, onclick: () => store.patch({ tab: 'doing' }) }, `${t('list.doing')} ${counts.doing}`),
        h('button', { class: cx('ftab', { on: s.tab === 'done' }), role: 'tab', 'aria-selected': String(s.tab === 'done'), dataset: { tab: 'done' }, onclick: () => store.patch({ tab: 'done' }) }, `${t('list.done')} ${counts.done}`),
      ),
    ),
    nv.offline ? h('div', { class: 'netbar' }, h('span', { class: 'spin', style: { 'border-top-color': '#87500A' } }), h('span', { style: { flex: '1' } }, t('list.offline')), h('button', { class: 'link', onclick: () => void loadForActiveAccount() }, t('list.retryNow'))) : null,
    acc?.state === 'expired' ? h('div', { class: 'netbar err', dataset: { expired: '1' } }, icon(IC.alert, 15), h('span', { style: { flex: '1' } }, t('list.expired')), h('button', { class: 'link', onclick: () => void startLogin(acc.context) }, t('list.relogin'))) : null,
    h('div', { class: 'cscroll', dataset: { keepScroll: 'clist' } }, rows, rows.length === 0 ? h('div', { class: 'empty', style: { margin: '16px' } }, s.query ? t('list.emptySearch') : t('list.empty')) : null),
  );
}

function contextMenu(s: MainState): HTMLElement | null {
  const m = s.ctxMenu;
  if (!m) return null;
  const c = s.conversations.find((x) => x.gid === m.gid);
  if (!c) return null;
  const items = contextMenuItems(c);
  const maxX = Math.max(0, window.innerWidth - 190);
  const maxY = Math.max(0, window.innerHeight - 170);
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
  );
}

function richText(text: string): HTMLElement[] {
  return highlightParts(text).map((p) =>
    p.kind === 'plain'
      ? h('span', null, p.text)
      : h(
          'button',
          {
            class: 'hl',
            title: p.kind === 'iccid' ? t('side.iccidHint') : t('side.orderHint'),
            dataset: { hl: p.kind },
            onclick: () => {
              if (p.kind === 'iccid') {
                store.patch({ sideOpen: true, pkgOpen: true, pkgHot: true });
                void queryPackage(p.text);
              } else {
                store.patch({ sideOpen: true, hotOrder: true });
              }
            },
          },
          p.text,
        ),
  );
}

/** A card may reveal only its own current order in its original account/session scope. */
function openMessageOrder(m: UiMessage, rendered: UiConversation, account: UiAccount | null): void {
  if (!account || !sameAccount(rendered.account, account.context) || rendered.account.session_generation !== account.context.session_generation || !stillActive(account.context)) return;
  const current = activeConv();
  if (S().activeGid !== m.gid || m.gid !== rendered.gid || !current || current.gid !== m.gid || !sameAccount(current.account, account.context) || current.account.session_generation !== account.context.session_generation) return;
  if (!m.order_id || current.order?.order_id !== m.order_id) {
    toast('当前未提供此订单的可用详情，请在订单查询中核对。');
    return;
  }
  store.patch({ sideOpen: true, hotOrder: true });
}

function messageRow(s: MainState, m: UiMessage, conv: UiConversation, acc: UiAccount | null): HTMLElement {
  const alignment = messageAlignment(m);
  if (alignment.side === 'system') return h('div', { class: 'msg-sys' }, h('span', null, m.text));
  const alignRight = alignment.side === 'right';
  const isSelf = alignment.self;
  const quotePreview = messageQuotePreview(m, s.messages[conv.gid] ?? []);
  const showTime = s.prefs?.general.show_msg_time ?? true;
  let body: HTMLElement;
  if (m.kind === 'order_card') {
    const o = conv.order && conv.order.order_id === m.order_id ? conv.order : null;
    body = h(
      'div',
      { class: 'card' },
      h('div', { class: 'card-h' }, icon(IC.order, 14), t('chat.orderCard'), h('span', { class: 'mono', style: { 'margin-left': 'auto' } }, m.order_id ?? '')),
      h('div', { class: 'card-b' }, h('div', { class: 'card-t' }, o?.product ?? m.text), o ? h('div', { class: 'kv' }, h('span', { class: 'k' }, t('side.useDate')), h('span', null, o.use_date)) : null, o ? h('div', { class: 'kv' }, h('span', { class: 'k' }, t('side.quantity')), h('span', null, o.quantity)) : null),
      h('div', { class: 'card-f' }, o ? h('span', { class: 'chip chip-info', style: { 'margin-right': 'auto' } }, o.status) : null, h('button', { class: 'link', onclick: () => openMessageOrder(m, conv, acc) }, t('chat.viewOrder'))),
    );
  } else if (m.kind === 'image') {
    body = h('div', { class: 'shot', title: m.text }, h('span', { class: 'shot-t' }, t('chat.image')), h('span', { class: 'shot-l' }, m.text), h('span', { class: 'shot-bar', style: { width: '70%' } }), h('span', { class: 'shot-bar', style: { width: '45%' } }));
  } else if (m.kind === 'file' || m.kind === 'video') {
    body = h('div', { class: 'bubble' }, previewOf(m), ' ', m.text);
  } else {
    body = h(
      'div',
      { class: 'bubble' },
      richText(m.text),
      m.translation && !s.hideInboundTr ? h('div', { class: 'btr' }, h('span', { class: 'trtag' }, t('chat.translated')), h('span', null, m.translation)) : null,
      m.original ? h('div', { class: 'btr' }, h('span', { class: 'trtag' }, t('chat.original')), h('span', null, m.original)) : null,
    );
  }
  const st = isSelf ? sendStateView(m.disposition) : null;
  const who = m.sender_name?.trim() || m.sender_id?.trim() || (isSelf ? (acc ? accountLabel(acc) : roleLabel('merchant_self')) : m.sender_role === 'customer' ? conv.title : roleLabel(m.sender_role));
  return h(
    'div',
    { class: cx('msg', { mine: alignRight }), dataset: { mid: m.local_id ?? m.message_id ?? '' } },
    h('div', { class: 'ava sm', style: { background: isSelf ? (acc?.color ?? '#5B6676') : conv.color } }, renderMessageAvatar(document, who, m.sender_avatar)),
    h(
      'div',
      { class: 'mcol' },
      h('div', { class: 'mmeta' }, who, showTime ? ` · ${formatClock(m.create_time_ms)}` : ''),
      quotePreview ? h('div', { class: 'quote-in' }, t('chat.quotePrefix'), quotePreview) : null,
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
    h('div', { class: 'macts' }, h('button', { onclick: () => store.patch({ quote: m }) }, t('chat.quote')), h('button', { onclick: () => copyText(m.text) }, t('chat.copy')), h('button', { onclick: () => toast(m.message_id ? `服务端消息ID：${m.message_id}` : '尚无服务端消息ID，请核对发送结果'), 'aria-label': '查看服务端消息ID' }, '消息ID')),
  );
}

function translationBar(s: MainState, conv: UiConversation): HTMLElement | null {
  const p = s.prefs;
  if (!p || !translationOn(s, conv)) return null;
  const direct = p.assistant.send_mode === 'send_direct';
  const tr = s.translation;
  const target = translationTarget(s, conv);
  const stale = tr.status === 'done' && tr.draftVersion !== s.draftVersion;
  let bodyEl: HTMLElement;
  if (tr.status === 'error' && tr.gid === conv.gid) {
    bodyEl = h(
      'div',
      { class: 'trrow', dataset: { trState: 'error' } },
      icon(IC.alert, 14, { style: 'color: var(--c-alert)' }),
      h('span', { style: { color: 'var(--c-alert-text)' } }, `${t('tr.failed')}：${tr.error ?? ''}`),
      h('span', { class: 'sp' }),
      h('button', { class: 'btn sm', dataset: { tr: 'send-original' }, onclick: () => void sendText(S().draft.trim(), null) }, t('tr.sendOriginal')),
      h('button', { class: 'btn sm pri', dataset: { tr: 'retry' }, onclick: () => (direct ? void translateAndSend(S().draft.trim()) : void runPreviewTranslation()) }, t('tr.retry')),
    );
  } else if (direct) {
    bodyEl = h('div', { class: 'trprev wait', dataset: { trState: tr.status } }, tr.status === 'busy' ? h('span', { class: 'spin' }) : null, tr.status === 'busy' ? t('tr.busy') : t('composer.directMode'));
  } else if ((tr.status === 'busy' || stale) && tr.gid === conv.gid) {
    bodyEl = h('div', { class: 'trprev wait', dataset: { trState: 'busy' } }, h('span', { class: 'spin' }), stale ? t('tr.stale') : t('tr.busy'));
  } else if (tr.status === 'done' && tr.gid === conv.gid) {
    bodyEl = h(
      'div',
      { class: 'trdone', dataset: { trState: 'done' } },
      h('div', { class: 'trprev' }, tr.text),
      h(
        'div',
        { class: 'trrow' },
        h('span', { class: 'sp' }),
        h('button', { class: 'btn sm', onclick: () => copyText(tr.text) }, t('tr.copy')),
        h('button', { class: 'btn sm', dataset: { tr: 'replace' }, onclick: () => store.patch({ draft: tr.text, draftVersion: S().draftVersion + 1, translation: { ...TRANSLATION_IDLE, gid: conv.gid, target } }) }, t('tr.replace')),
        h('button', { class: 'btn sm pri', dataset: { tr: 'send' }, onclick: () => void sendText(tr.text, S().draft.trim()) }, t('tr.sendTranslated')),
      ),
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
        {
          class: 'sel',
          style: { height: '24px' },
          'aria-label': '目标语言',
          value: target,
          onchange: (e: Event) => {
            store.patch({ translation: { ...TRANSLATION_IDLE, gid: conv.gid, target: (e.target as HTMLSelectElement).value } });
            scheduleTranslation();
          },
        },
        TR_TARGETS.map((code) => h('option', { value: code, selected: code === target }, `${langName(code)} ${code}`)),
      ),
      h('span', { class: 'muted', style: { 'margin-left': 'auto' } }, `${t('tr.provider')} · ${direct ? t('tr.modeDirect') : t('tr.modeReplace')}`),
    ),
    bodyEl,
  );
}

function composer(s: MainState, conv: UiConversation): HTMLElement {
  const quote = selectedQuoteReference(s.quote, s.messages[conv.gid] ?? [], conv.gid);
  const finished = isDone(conv);
  const trOn = translationOn(s, conv);
  const direct = s.prefs?.assistant.send_mode === 'send_direct' && trOn;
  const sendKey = s.prefs?.keys.send_key ?? 'enter';
  const shotKey = s.prefs?.keys.screenshot ?? '';
  const chip = (label: string, d: string, data: string) => notWired(h('button', { class: 'chipbtn', dataset: { chip: data } }, icon(d, 13), label), t('composer.notWired', { action: label }));
  return h(
    'div',
    { class: 'composer' },
    translationBar(s, conv),
    h(
      'div',
      { class: 'chips' },
      h('button', { class: 'chipbtn', dataset: { chip: 'phrases' }, onclick: () => openPeripheral('scripts') }, icon(IC.chat, 13), t('composer.phrases')),
      chip(t('composer.recommend'), IC.box, 'recommend'),
      h('button', { class: cx('chipbtn', { on: s.hideInboundTr }), dataset: { chip: 'hide-tr' }, title: s.hideInboundTr ? t('composer.showTr') : t('composer.hideTr'), onclick: () => store.patch({ hideInboundTr: !S().hideInboundTr }) }, icon(IC.translate, 13), s.hideInboundTr ? t('composer.showTr') : t('composer.hideTr')),
    ),
    h(
      'div',
      { class: 'ctools' },
      h('button', { class: cx('ibtn', { on: s.emoOpen }), 'aria-label': t('composer.emoji'), title: t('composer.emoji'), disabled: finished, dataset: { tool: 'emoji' }, onclick: (e: Event) => { e.stopPropagation(); store.patch({ emoOpen: !S().emoOpen }); } }, icon(IC.smile, 18)),
      h('button', { class: 'ibtn', 'aria-label': t('composer.screenshot'), title: shotKey ? `${t('composer.screenshot')} ${shotKey}` : t('composer.screenshot'), disabled: finished, dataset: { tool: 'screenshot' }, onclick: () => void attach('screenshot') }, icon(IC.scissors, 18)),
      h('button', { class: 'ibtn', 'aria-label': t('composer.image'), title: t('composer.image'), disabled: finished, dataset: { tool: 'image' }, onclick: () => void attach('image') }, icon(IC.image, 18)),
      h('button', { class: 'ibtn', 'aria-label': t('composer.file'), title: t('composer.file'), disabled: finished, dataset: { tool: 'file' }, onclick: () => void attach('file') }, icon(IC.file, 18)),
      h('button', { class: 'ibtn', 'aria-label': t('composer.phrases'), dataset: { tool: 'phrases' }, onclick: () => openPeripheral('scripts') }, icon(IC.chat, 18)),
      conv.lang !== 'zh' && s.prefs?.assistant.enabled && s.prefs.assistant.outbound_translation
        ? h('button', { class: cx('ibtn', { on: !s.trBarOff }), 'aria-label': t('composer.trToggle'), title: t('composer.trToggleTitle'), dataset: { tool: 'translate' }, onclick: () => store.patch({ trBarOff: !S().trBarOff }) }, icon(IC.translate, 18))
        : null,
      h('span', { class: 'hint', style: { 'margin-left': 'auto', 'padding-right': '6px' } }, t('composer.attachHint')),
    ),
    quote ? h('div', { class: 'quote-bar' }, h('span', { style: { flex: '1', overflow: 'hidden', 'white-space': 'nowrap', 'text-overflow': 'ellipsis' } }, t('chat.quotePrefix'), quote.text), h('button', { class: 'ibtn', style: { width: '22px', height: '22px' }, 'aria-label': t('chat.cancelQuote'), onclick: () => store.patch({ quote: null }) }, icon(IC.close, 12))) : null,
    s.attachment ? h('div', { class: 'attach', title: ATTACHMENT_SEND_UNAVAILABLE }, h('div', { class: 'attach-img' }), h('span', { style: { 'font-size': '12px' } }, `${s.attachment.name} · 附件发送尚未实现`), h('button', { class: 'ibtn', style: { width: '22px', height: '22px' }, 'aria-label': t('composer.removeAttach'), onclick: () => store.patch({ attachment: null }) }, icon(IC.close, 12))) : null,
    h('textarea', {
      class: 'ta',
      placeholder: finished ? t('composer.placeholderFinished') : t('composer.placeholder'),
      'aria-label': '输入消息',
      value: s.draft,
      disabled: finished,
      dataset: { fid: 'draft' },
      oninput: (e: Event) => setDraft((e.target as HTMLTextAreaElement).value),
      onkeydown: (e: KeyboardEvent) => {
        if (e.key !== 'Enter' || e.isComposing) return;
        const want = sendKey === 'enter' ? !e.shiftKey && !e.ctrlKey && !e.metaKey : e.ctrlKey || e.metaKey;
        if (want) {
          e.preventDefault();
          void handleSend();
        }
      },
    }),
    h('div', { class: 'cfoot' }, h('span', { class: 'hint' }, direct ? t('composer.directMode') : sendKey === 'enter' ? t('composer.hintEnter') : t('composer.hintCtrlEnter')), h('button', { class: 'btn pri', dataset: { action: 'send' }, disabled: finished, onclick: () => void handleSend() }, icon(IC.send, 14), t('composer.send'))),
  );
}

function emojiPicker(s: MainState): HTMLElement | null {
  if (!s.emoOpen) return null;
  return h(
    'div',
    { class: 'emo', onmousedown: (e: Event) => e.stopPropagation() },
    EMOJI.map((ch) => h('button', { 'aria-label': t('composer.insertEmoji'), onclick: () => { setDraft(S().draft + ch); store.patch({ emoOpen: false }); } }, ch)),
  );
}

function packageCard(s: MainState, conv: UiConversation): HTMLElement | null {
  if (!packageEnabled(s)) return null;
  const iccids = findIccids(s.messages[conv.gid] ?? []);
  const info = s.pkg.info;
  const busy = s.pkg.status === 'busy';
  let body: HTMLElement | null = null;
  if (s.pkgOpen) {
    if (iccids.length === 0) body = h('div', { class: 'empty', style: { margin: '12px' } }, t('side.pkgEmpty'));
    else if (s.pkg.status === 'error') body = h('div', { class: 'pkg-b' }, h('div', { class: 'notice-box err' }, s.pkg.error ?? ''), h('button', { class: 'btn sm', style: { 'align-self': 'flex-start' }, onclick: () => void queryPackage(iccids[0] ?? '', true) }, t('tr.retry')));
    else if (!info) body = h('div', { class: 'pkg-b' }, h('div', { class: 'skel', style: { height: '54px' } }), h('div', { class: 'skel', style: { height: '18px', width: '70%' } }));
    else {
      const ago = Math.max(0, Math.floor((s.now - info.fetched_at_ms) / 60_000));
      body = h(
        'div',
        { class: 'pkg-scroll' },
        h(
          'div',
          { class: 'pkg-b', dataset: { pkgInfo: '1' } },
          h(
            'div',
            { style: { display: 'flex', gap: '12px', 'align-items': 'center' } },
            h('div', { class: 'ring', style: { background: `conic-gradient(var(--c-primary) ${info.remain_pct}%, var(--c-border) 0)` } }, h('span', null, `${info.remain_pct}%`)),
            h('div', { style: { display: 'flex', 'flex-direction': 'column', gap: '2px' } }, h('div', { style: { display: 'flex', gap: '8px', 'align-items': 'center', 'font-size': '12px' } }, h('span', { class: 'chip chip-warn' }, info.status), h('span', { class: 'muted' }, t('side.pkgRemain'))), h('div', null, h('b', { style: { 'font-size': '22px' } }, info.remain), h('span', { class: 'muted', style: { 'font-size': '12px' } }, ` / ${info.total}`))),
          ),
          h('div', { style: { 'font-weight': '600', 'font-size': '13px', 'line-height': '1.45' } }, info.plan),
          h('div', { class: 'pkg-tiles' }, h('div', null, h('span', null, t('side.pkgSupplier')), h('b', null, info.supplier)), h('div', null, h('span', null, t('side.pkgApn')), h('b', null, info.apn))),
          iccids.map((id) => h('div', { class: 'pkg-id' }, h('span', { class: 'muted' }, 'ICCID'), h('span', { class: 'mono' }, id), h('button', { class: 'ibtn', style: { width: '24px', height: '24px' }, 'aria-label': t('side.copyId', { k: 'ICCID' }), onclick: () => copyText(id, t('side.copied', { k: 'ICCID' })) }, icon(IC.copy, 13)))),
        ),
        h('div', { class: 'pkg-f' }, t('side.pkgFoot', { t: ago < 1 ? t('side.pkgJustNow') : t('side.pkgMinutes', { n: ago }) })),
      );
    }
  }
  return h(
    'div',
    { class: cx('pkg', { hot: s.pkgHot }) },
    h(
      'div',
      { class: 'pkg-h' },
      h('b', null, t('side.pkg')),
      h('span', { class: 'chip chip-muted' }, t('side.pkgCount', { n: info ? 1 : 0 })),
      h('span', { class: 'sp' }),
      h('button', { class: 'ibtn', style: { width: '26px', height: '26px' }, title: t('side.pkgRefresh'), 'aria-label': t('side.pkgRefresh'), disabled: iccids.length === 0 || busy, onclick: () => void queryPackage(info?.iccid ?? iccids[0] ?? '', true) }, busy ? h('span', { class: 'spin' }) : icon(IC.refresh, 14)),
      h('button', { class: 'ibtn', style: { width: '26px', height: '26px' }, title: t('side.pkgToggle'), 'aria-label': t('side.pkgToggle'), onclick: () => store.patch({ pkgOpen: !S().pkgOpen }) }, icon(s.pkgOpen ? IC.chevDown : IC.chevUp, 14)),
    ),
    body,
  );
}

function sidePanel(s: MainState, conv: UiConversation): HTMLElement {
  const o = conv.order;
  const row = (label: string, value: string | undefined) => value?.trim() ? [h('div', { class: 'ik' }, label), h('div', { class: 'iv' }, value)] : null;
  return h(
    'aside',
    { class: 'side' },
    h('div', { class: 'stabs' }, h('span', { class: 'stab on' }, t('side.customer')), h('span', { class: 'sp' }), h('button', { class: 'ibtn', style: { 'align-self': 'center' }, title: t('side.collapse'), 'aria-label': t('side.collapse'), onclick: () => store.patch({ sideOpen: false }) }, icon(IC.chevRight, 16))),
    h(
      'div',
      { class: 'sbody', dataset: { keepScroll: 'side' } },
      h('div', { class: 'side-customer' }, h('div', { class: 'ava', style: { background: conv.color } }, renderMessageAvatar(document, conv.title, conv.customer_avatar)), h('span', { class: 'side-customer-name' }, conv.title)),
      h('div', { class: 'source-heading' }, '咨询来源'),
      o
        ? h('div', { class: cx('source-info', { hot: s.hotOrder }) },
            o.source_title ? h('div', { class: 'source-title' }, o.source_title) : null,
            o.source_description ? h('div', { class: 'source-description' }, o.source_description) : null,
            h('div', { class: 'info-grid' },
              row('来源渠道', o.source_channel),
              row('订单ID', o.order_id),
              row('产品名称', o.product),
              row('使用日期', o.use_date),
              row('订单总额', o.total_amount),
              row('数量', o.quantity),
              row('订单状态', o.status),
            ),
            h('div', { class: 'source-actions' },
              h('button', { class: 'ibtn', 'aria-label': t('side.copyOrder'), onclick: () => copyText(o.order_id, t('side.orderCopied')) }, icon(IC.copy, 12)),
              h('button', { class: 'link', dataset: { side: 'detail' }, onclick: () => goOrderDetail(o.order_id) }, t('side.detail')),
              h('button', { class: 'link', dataset: { side: 'pc' }, onclick: () => void openWebAdvanced(o) }, t('side.pcDetail')),
            ),
          )
        : h('div', { class: 'muted', style: { 'font-size': '12px' } }, t('side.noOrder')),
    ),
    packageCard(s, conv),
  );
}

function chatPane(s: MainState): HTMLElement {
  const conv = activeConv(s);
  const acc = activeAccount(s);
  if (!conv) return h('div', { class: 'chat-empty' }, icon(IC.chat, 40), h('div', null, t('chat.empty')));
  const msgs = visibleMessages(s.messages[conv.gid] ?? []);
  const waiting = conv.waiting_since_ms !== null && !isDone(conv);
  const sub = isDone(conv) ? t('chat.finished') : `${t('chat.owner')}${waiting ? ` · ${t('chat.waiting', { t: formatDuration(waitedSeconds(conv, s.now)) })}` : ''}`;
  const type = /^[A-Za-z][A-Za-z0-9]{0,5}$/.test(conv.service_type) ? `${conv.service_type} · ${conv.biz}` : conv.biz;
  return h(
    'div',
    { class: 'chat' },
    h(
      'div',
      { class: 'chat-h' },
      h('div', { class: 'ava sm', style: { background: conv.color } }, renderMessageAvatar(document, conv.title, conv.customer_avatar)),
      h('div', { class: 'chat-title' }, h('div', { class: 'chat-name' }, conv.title, conv.lang !== 'zh' ? h('span', { class: 'chip chip-lang' }, t('chat.lang', { lang: langName(conv.lang) })) : null, h('span', { class: 'chip chip-biz' }, type)), h('div', { class: 'chat-sub' }, sub)),
      h('button', { class: 'ibtn', 'aria-label': t('chat.transfer'), disabled: isDone(conv), dataset: { chatAct: 'transfer' }, onclick: () => openPeripheral('transfer') }, icon(IC.swap, 17)),
      h('button', { class: 'ibtn', 'aria-label': t('chat.invite'), disabled: isDone(conv), dataset: { chatAct: 'invite' }, onclick: () => openPeripheral('invite') }, icon(IC.userPlus, 17)),
      h('button', { class: 'btn sm', disabled: isDone(conv), dataset: { chatAct: 'end' }, onclick: () => openPeripheral('finish') }, icon(IC.exit, 14), t('chat.end')),
      h('button', { class: 'ibtn', 'aria-label': '会话成员', title: '会话成员', dataset: { chatAct: 'members' }, onclick: () => openPeripheral('members') }, icon(IC.userPlus, 17)),
      h('button', { class: cx('ibtn', { on: s.sideOpen }), title: t('chat.side'), 'aria-label': t('chat.toggleSide'), dataset: { chatAct: 'side' }, onclick: () => store.patch({ sideOpen: !S().sideOpen }) }, icon(IC.sidebar, 17)),
    ),
    netView(s.net).offline ? h('div', { class: 'netbar', style: { margin: '8px 16px 0' } }, t('chat.offlineNotice')) : null,
    h('div', { class: 'msgs', dataset: { keepScroll: 'msgs', scrollBottom: '1' } }, msgs.map((m) => messageRow(s, m, conv, acc))),
    composer(s, conv),
    emojiPicker(s),
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
      s.noticeCats.map((c) => h('button', { class: cx('ncat-i', { on: c.id === s.noticeCat }), dataset: { cat: c.id }, onclick: () => void pickNoticeCat(c.id) }, icon(catIcons[c.id] ?? IC.bell, 16), h('span', { style: { flex: '1' } }, c.name), accBadge(c.unread))),
      s.noticeCats.length === 0 ? h('div', { class: 'empty' }, t('notice.empty')) : null,
    ),
    h(
      'div',
      { class: 'nlist' },
      h('div', { class: 'ph' }, h('span', null, cat ? cat.name : t('notice.title'), cat && cat.unread > 0 ? h('span', { class: 'muted', style: { 'font-size': '12px', 'font-weight': '400', 'margin-left': '8px' } }, t('notice.unread', { n: cat.unread })) : null), h('button', { class: 'btn sm', dataset: { action: 'mark-all' }, disabled: !cat, onclick: () => void markAllNotices() }, t('notice.markAll'))),
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

const ORDER_COLS = '1.1fr 2.4fr 1fr .8fr .8fr .9fr 1.6fr';

function orderRow(s: MainState, o: UiOrderSummary, verified: boolean): HTMLElement {
  const busy = s.orderBusyId === o.order_id;
  // 「IM 联系」/「网页高级操作」only for exactly one verified order; a row of a multiple result must be picked first.
  const actions = verified
    ? [
        h('button', { class: 'btn sm pri', dataset: { action: 'im' }, disabled: busy, onclick: () => void contactViaIm(o) }, busy ? h('span', { class: 'spin' }) : icon(IC.chat, 13), busy ? t('order.imBusy') : t('order.im')),
        h('button', { class: 'btn sm', dataset: { action: 'web' }, title: t('order.webTitle'), onclick: () => void openWebAdvanced(o) }, icon(IC.lock, 13), t('order.web')),
      ]
    : [h('button', { class: 'btn sm', dataset: { action: 'select' }, title: t('order.selectTitle'), onclick: () => selectOrder(o) }, icon(IC.check, 13), t('order.select'))];
  return h(
    'div',
    { class: cx('grid-r', { hot: verified }), style: { 'grid-template-columns': ORDER_COLS }, dataset: { order: o.order_id } },
    h('span', { class: 'cell mono' }, o.order_id),
    h('span', { class: 'cell', title: o.product }, o.product),
    h('span', { class: 'cell' }, o.use_date),
    h('span', { class: 'cell' }, o.quantity),
    h('span', null, h('span', { class: 'chip chip-info' }, o.status)),
    h('span', { class: 'cell' }, o.contact),
    h('span', { style: { display: 'flex', gap: '6px' } }, actions),
  );
}

function orderView(s: MainState): HTMLElement {
  const st = s.order;
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
      h('div', { class: 'ph', style: { 'justify-content': 'flex-start', gap: '8px' } }, t('order.result', { n: orders.length }), st.kind === 'multiple' ? h('span', { class: 'chip chip-warn' }, t('order.multiple')) : h('span', { class: 'muted', style: { 'font-size': '12px', 'font-weight': '400' } }, t('order.verify'))),
      h('div', { class: 'grid-h', style: { 'grid-template-columns': ORDER_COLS } }, h('span', null, t('order.col.id')), h('span', null, t('order.col.product')), h('span', null, t('order.col.date')), h('span', null, t('order.col.qty')), h('span', null, t('order.col.status')), h('span', null, t('order.col.contact')), h('span', null, t('order.col.actions'))),
      orders.map((o) => orderRow(s, o, st.kind === 'one')),
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
          h(
            'div',
            { style: { display: 'flex', gap: '8px' } },
            h('input', { class: 'inp', style: { width: '300px', height: '34px' }, placeholder: t('order.placeholder'), 'aria-label': '订单号', value: s.orderQuery, dataset: { fid: 'order-query' }, inputmode: 'numeric', oninput: (e: Event) => store.patch({ orderQuery: (e.target as HTMLInputElement).value }), onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter') void runOrderQuery(); } }),
            h('button', { class: 'btn pri', style: { height: '34px' }, dataset: { action: 'order-query' }, onclick: () => void runOrderQuery() }, t('order.query')),
          ),
          // Sample chips exist only in the browser demo; the real host never shows fake orders.
          sel.mock ? h('div', { style: { display: 'flex', 'flex-wrap': 'wrap', gap: '8px', 'align-items': 'center' } }, h('span', { class: 'muted', style: { 'font-size': '12px' } }, t('order.samples')), MOCK_ORDER_SAMPLES.map((x) => h('button', { class: 'chipbtn', title: `查询 ${x.id}`, dataset: { sample: x.id }, onclick: () => void runOrderQuery(x.id) }, x.label))) : null,
        ),
        result,
      ),
    ),
  );
}

// ---- banners, status bar, dialogs

function bannerStack(s: MainState): HTMLElement | null {
  if (s.banners.length === 0) return null;
  const snap = s.accounts;
  const active = activeAccount(s);
  const shown = s.banners.slice(0, BANNER_VISIBLE);
  const more = s.banners.length - shown.length;
  return h(
    'div',
    {
      class: 'pop-stack',
      onmousedown: (e: Event) => e.stopPropagation(),
      onmouseenter: () => {
        if (S().bannerHoverAt === null) store.patch({ bannerHoverAt: Date.now() });
      },
      onmouseleave: () => {
        const at = S().bannerHoverAt;
        if (at !== null) store.patch({ bannerHoverAt: null, banners: resumeBanners(S().banners, at, Date.now()) });
      },
    },
    shown.map((b) => {
      const acc = snap?.accounts.find((a) => sameAccount(a.context, b.account));
      const conv = active && sameAccount(active.context, b.account) && active.context.session_generation === b.account.session_generation ? s.conversations.find((c) => c.gid === b.gid) : undefined;
      // The view is rebuilt on every change: only a banner that just arrived slides in.
      const fresh = Date.now() - b.at < 250;
      const open = () => {
        dismissBanner(b.id);
        void locateConversation(b.account, b.gid);
      };
      if (b.system) {
        return h(
          'div',
          { class: cx('banner sys', { enter: fresh }), role: 'alert', dataset: { banner: b.gid }, onclick: open },
          h('div', { style: { display: 'flex', 'flex-direction': 'column', gap: '6px', flex: '1', 'min-width': '0' } }, h('div', { class: 'bn-app' }, h('span', { class: 'mini-ic' }, 'V'), `${t('app.name')} · ${t('banner.system')}`), h('div', { style: { 'font-weight': '600' } }, conv?.title ?? (acc ? accountLabel(acc) : t('banner.newMsg'))), h('div', { class: 'muted', style: { 'font-size': '12.5px' } }, b.count > 1 ? t('banner.count', { n: b.count }) : t('banner.newMsg'))),
          h('button', { class: 'ibtn bn-x', style: { width: '24px', height: '24px' }, 'aria-label': t('banner.close'), onclick: (e: Event) => { e.stopPropagation(); dismissBanner(b.id); } }, icon(IC.close, 12)),
        );
      }
      return h(
        'div',
        { class: cx('banner', { enter: fresh }), role: 'alert', dataset: { banner: b.gid }, onclick: open },
        h('div', { class: 'ava', style: { background: conv?.color ?? '#5B6676' } }, conv ? renderMessageAvatar(document, conv.title, conv.customer_avatar) : 'V'),
        h(
          'div',
          { style: { flex: '1', 'min-width': '0', display: 'flex', 'flex-direction': 'column', gap: '2px' } },
          h('div', { class: 'bn-app' }, h('span', { class: 'mini-ic' }, 'V'), acc ? accountLabel(acc) : t('app.name'), h('span', { style: { 'margin-left': 'auto', 'padding-right': '22px' } }, formatClock(b.at))),
          h('div', { style: { 'font-weight': '600', display: 'flex', gap: '6px', 'align-items': 'center' } }, conv?.title ?? t('banner.newMsg'), b.count > 1 ? h('span', { class: 'badge' }, badgeText(b.count)) : null),
          h('div', { class: 'muted', style: { 'font-size': '12.5px', 'white-space': 'nowrap', overflow: 'hidden', 'text-overflow': 'ellipsis' } }, conv?.preview || t('banner.newMsg')),
        ),
        h('button', { class: 'ibtn bn-x', style: { width: '24px', height: '24px' }, 'aria-label': t('banner.close'), onclick: (e: Event) => { e.stopPropagation(); dismissBanner(b.id); } }, icon(IC.close, 12)),
      );
    }),
    more > 0 ? h('button', { class: 'more-bn', onclick: () => store.patch({ view: 'messages', banners: [] }) }, t('banner.more', { n: more })) : null,
  );
}

let clockEl: HTMLElement | null = null;
function statusBar(s: MainState): HTMLElement {
  const av = agentView(s.agent);
  const nv = netView(s.net);
  const hasAccount = !!activeAccount(s);
  clockEl = h('span', { class: 'sb-clock' }, `${formatDate(s.now)} ${formatClock(s.now, true)}`);
  return h(
    'div',
    { class: 'statusbar', role: 'status' },
    hasAccount ? h('span', { class: 'sb-item', dataset: { sb: 'agent', known: String(av.known) } }, h('span', { class: 'dot', style: { background: `var(${av.colorVar})` } }), av.label, av.known ? h('span', { class: 'muted' }, ` · ${t('status.readback')}`) : null) : null,
    h('span', { class: cx('sb-item', { 'sb-bad': nv.offline, 'sb-muted': !nv.ok && !nv.offline }), dataset: { sb: 'net' } }, icon(nv.ok ? IC.wifi : IC.wifiOff, 13), nv.label),
    s.alarmCount > 0 ? h('span', { class: 'sb-item sb-alarm', dataset: { sb: 'alarm' } }, icon(IC.clock, 13), t('bar.alarmCount', { n: s.alarmCount })) : null,
    h('button', { class: 'link sb-diagnostics', dataset: { action: 'receive-diagnostics' }, onclick: () => void receiveDiagnostics.open() }, '接收诊断'),
    h('span', { class: 'sp' }),
    sel.mock ? h('span', { class: 'sb-item muted' }, t('app.mockMode')) : null,
    s.clockTrusted ? null : h('span', { class: 'sb-item sb-warn', title: t('bar.clockUntrustedTitle'), dataset: { sb: 'clock-untrusted' } }, icon(IC.alert, 13), t('bar.clockUntrusted')),
    clockEl,
  );
}

function receiveDiagnosticsDialog(s: MainState): HTMLElement | null {
  const view = s.receiveDiagnostics;
  if (!view) return null;
  const snapshot = view.snapshot;
  const labels = { ready: '已读取', no_account: '未选择账号', timeout: '页面诊断超时', unavailable: '暂不可用', invalid: '诊断格式无效' };
  return h('div', { class: 'shade', onclick: () => receiveDiagnostics.close() },
    h('div', { class: 'dlg receive-diagnostics', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'receive-diagnostics-title', tabindex: '-1', dataset: { receiveDiagnostics: '1' }, onclick: (e: Event) => e.stopPropagation() },
      h('div', { class: 'dlg-h' }, h('span', { id: 'receive-diagnostics-title' }, '接收诊断'), h('button', { class: 'ibtn', 'aria-label': '关闭接收诊断', onclick: () => receiveDiagnostics.close() }, icon(IC.close, 16))),
      h('div', { class: 'receive-diagnostics-body' },
        h('p', { class: 'muted' }, '当前账号的只读快照。手动刷新不会重连、加载历史或发送消息。'),
        view.busy ? h('p', { role: 'status' }, '正在读取接收链路…') : null,
        snapshot ? h('div', { class: 'receive-diagnostics-summary', role: 'status' },
          h('p', null, `${labels[snapshot.availability]} · ${formatClock(snapshot.captured_at_ms, true)}`),
          h('p', null, `SDK：${snapshot.page?.sdk?.binding.listener_health ?? '无数据'}；页面消息：${snapshot.page?.session.received ?? '—'}；宿主投影：${snapshot.host?.changed_messages ?? '—'}`),
          h('p', null, `主界面：收到 ${snapshot.main.received} / 格式拒绝 ${snapshot.main.guard_rejected} / 账号丢弃 ${snapshot.main.account_dropped} / 已写入 ${snapshot.main.upserted}`)) : null,
        snapshot ? h('pre', { class: 'receive-diagnostics-json', tabindex: '0', 'aria-label': '不含身份或消息正文的接收诊断JSON' }, receiveDiagnosticsJson(snapshot)) : null),
      h('div', { class: 'dlg-f' },
        h('button', { class: 'btn', disabled: view.busy, onclick: () => void receiveDiagnostics.refresh() }, '只读刷新'),
        h('button', { class: 'btn', disabled: view.busy || !snapshot, onclick: () => { if (snapshot) copyText(receiveDiagnosticsJson(snapshot)); } }, '复制安全JSON'),
        h('button', { class: 'btn', onclick: () => receiveDiagnostics.close() }, '关闭'))));
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

function peripheralDialog(s: MainState): HTMLElement | null {
  const d = s.peripheral;
  if (!d || !stillActive(d.scope.account) || s.activeGid !== d.scope.gid) return null;
  const titles: Record<PeripheralKind, string> = { members: '会话成员', scripts: '快捷话术', invite: '邀请客服', transfer: '转交主客服', finish: '结束会话' };
  const title = titles[d.kind];
  const target = activeConv(s)?.title || d.scope.gid;
  const writable = d.kind === 'invite' || d.kind === 'transfer' || d.kind === 'finish';
  const selection = d.kind === 'invite' ? d.candidates : d.members;
  const selectedExpired = selection?.expires_at_ms ?? 0;
  const expired = selectedExpired > 0 && selectedExpired <= s.now;
  const tokenReady = !!selection?.selection_token?.trim() && Number.isFinite(selectedExpired) && selectedExpired > s.now;
  const result = d.write?.kind === 'not_submitted'
    ? { title: '尚未提交', message: '未进入上游写入。请只读刷新成员和会话后，再次确认。', confirmed: false }
    : d.write ? peripheralWriteView(d.write) : null;
  const memberRows = d.members?.members ?? [];
  const transferRows = d.kind === 'transfer' ? memberRows.filter((member) => member.can_transfer === true) : memberRows;
  const submitDisabled = d.busy || d.submitted || !tokenReady || (d.kind !== 'finish' && d.selected.length === 0);
  let body: Node;
  if (d.kind === 'scripts') {
    body = h('div', { class: 'peripheral-body' },
      h('form', { class: 'peripheral-search', onsubmit: (e: Event) => { e.preventDefault(); void peripheral.refresh(undefined, S().scriptsQuery); } },
        h('input', { class: 'inp', 'aria-label': '搜索话术', placeholder: '搜索话术', value: s.scriptsQuery, dataset: { fid: 'scripts-search' }, oninput: (e: Event) => store.patch({ scriptsQuery: (e.target as HTMLInputElement).value }) }),
        h('button', { class: 'btn', type: 'submit', disabled: d.busy }, '搜索')),
      d.scripts?.kind === 'empty' ? h('p', { class: 'peripheral-empty' }, '暂无可用话术') : null,
      d.scripts?.kind === 'unsupported' ? h('div', { class: 'notice-box' }, '返回了话术条目，但内容格式尚未验证，暂不支持插入或发送。') : null);
  } else if (d.kind === 'invite') {
    body = h('div', { class: 'peripheral-body' },
      h('p', { class: 'muted' }, '展开技能组，再明确选择需要邀请的客服。'),
      h('div', { class: 'peripheral-groups' },
        h('button', { class: 'btn sm', disabled: d.busy, onclick: () => void peripheral.refresh() }, '根技能组'),
        (d.candidates?.skill_groups ?? []).map((group) => h('button', { class: 'btn sm', disabled: d.busy, onclick: () => void peripheral.refresh([group.skill_group_id]) }, group.name))),
      h('div', { class: 'peripheral-list', role: 'group', 'aria-label': '可邀请客服' }, (d.candidates?.agents ?? []).map((agent) => h('label', { class: 'peripheral-member' },
        h('input', { type: 'checkbox', checked: d.selected.includes(agent.uid), disabled: d.busy || d.submitted || expired, onchange: () => peripheral.select(agent.uid) }),
        h('span', { class: 'ava sm', 'aria-hidden': 'true' }, renderMessageAvatar(document, personDisplayName(agent.nickname, agent.uid), agent.avatar)),
        h('span', null, h('b', null, personDisplayName(agent.nickname, agent.uid)), h('span', { class: 'peripheral-id' }, agent.uid))))),
      !d.busy && d.candidates && !d.candidates.agents.length ? h('p', { class: 'peripheral-empty' }, '当前技能组没有可选客服，请选择其他技能组。') : null);
  } else if (d.kind === 'finish') {
    body = h('div', { class: 'peripheral-body' },
      h('p', null, '确认结束当前服务会话？'),
      h('p', { class: 'muted' }, '请先确认客户已得到回复，并完成必要的主客服交接。结束后以服务器读回的会话状态为准。'));
  } else {
    body = h('div', { class: 'peripheral-body' },
      d.kind === 'transfer' ? h('p', { class: 'muted' }, '选择一位当前可接任的成员。可转交范围由服务器核验。') : null,
      h('div', { class: 'peripheral-list', role: d.kind === 'transfer' ? 'radiogroup' : 'list', 'aria-label': title }, transferRows.map((member) => h(d.kind === 'transfer' ? 'label' : 'div', { class: 'peripheral-member', ...(d.kind === 'members' ? { role: 'listitem' } : {}) },
        d.kind === 'transfer' ? h('input', { type: 'radio', name: 'transfer-member', checked: d.selected.includes(member.uid), disabled: d.busy || d.submitted || expired, onchange: () => peripheral.select(member.uid) }) : null,
        h('span', { class: 'ava sm', 'aria-hidden': 'true' }, renderMessageAvatar(document, personDisplayName(member.nickname, member.uid), member.avatar)),
        h('span', null, h('b', null, personDisplayName(member.nickname, member.uid)), h('span', { class: 'peripheral-id' }, member.uid)),
        h('span', { class: 'peripheral-member-status' }, `状态 ${member.status}`)))),
      !d.busy && d.members && transferRows.length === 0 ? h('p', { class: 'peripheral-empty' }, d.kind === 'transfer' ? '当前没有可转交的成员' : '未返回会话成员') : null);
  }
  return h('div', { class: 'shade peripheral-shade', onclick: () => peripheral.close() },
    h('div', { class: 'dlg peripheral-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'peripheral-title', tabindex: '-1', dataset: { peripheralDialog: d.kind }, onclick: (e: Event) => e.stopPropagation() },
      h('div', { class: 'dlg-h' }, h('span', { id: 'peripheral-title' }, title), h('button', { class: 'ibtn', 'aria-label': '关闭对话框', onclick: () => peripheral.close() }, icon(IC.close, 16))),
      h('div', { class: 'peripheral-context' }, target),
      body,
      d.busy ? h('div', { class: 'peripheral-note', role: 'status' }, h('span', { class: 'spin' }), d.submitted ? '正在提交，请勿重复操作…' : '正在只读加载…') : null,
      d.error ? h('div', { class: 'notice-box err peripheral-note', role: 'alert' }, d.error) : null,
      d.notice || expired ? h('div', { class: 'notice-box peripheral-note', role: 'status' }, d.notice || '候选已过期。请只读刷新后重新选择。') : null,
      result ? h('div', { class: cx('notice-box', 'peripheral-note', { 'peripheral-confirmed': result.confirmed }), role: 'status' }, h('b', null, result.title), h('p', null, result.message)) : null,
      h('div', { class: 'dlg-f' },
        h('button', { class: 'btn', disabled: d.busy, onclick: () => void peripheral.refresh(undefined, S().scriptsQuery) }, d.kind === 'scripts' ? '刷新话术' : '只读刷新成员/会话'),
        h('button', { class: 'btn', onclick: () => peripheral.close() }, '关闭'),
        writable && !d.submitted ? h('button', { class: 'btn pri', disabled: submitDisabled, dataset: { action: `peripheral-${d.kind}-confirm` }, onclick: () => void peripheral.submit() }, d.kind === 'finish' ? '确认结束' : d.kind === 'transfer' ? '确认转交' : '确认邀请') : null)));
}

function render(s: MainState): Node {
  const hasAccount = !!activeAccount(s);
  const view = !hasAccount ? welcomeView(s) : s.view === 'messages' ? messagesView(s) : s.view === 'notifications' ? notificationsView(s) : orderView(s);
  return h(
    'div',
    { class: 'app', dataset: { view: hasAccount ? s.view : 'welcome' } },
    titleBar(s),
    h('div', { class: 'body' }, navBar(s), view),
    statusBar(s),
    meMenu(s),
    contextMenu(s),
    logoutDialog(s),
    peripheralDialog(s),
    receiveDiagnosticsDialog(s),
    bannerStack(s),
    s.toast ? h('div', { class: 'toast', role: 'status' }, s.toast) : null,
  );
}

// --------------------------------------------------------------- wiring

subscribeBatched(store, (s) => rerender(root, () => render(s)));
rerender(root, () => render(S()));

document.addEventListener('mousedown', () => {
  const s = S();
  if (s.ctxMenu || s.meMenu || s.emoOpen) store.patch({ ctxMenu: null, meMenu: false, emoOpen: false });
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Tab' && (S().peripheral || S().receiveDiagnostics)) {
    const dialog = document.querySelector<HTMLElement>(S().receiveDiagnostics ? '[data-receive-diagnostics]' : '[data-peripheral-dialog]');
    const controls = dialog ? [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)')] : [];
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (first && last && (e.shiftKey ? document.activeElement === first || document.activeElement === dialog : document.activeElement === last || document.activeElement === dialog)) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    }
  }
  if (e.key === 'Escape') {
    if (S().peripheral) peripheral.close();
    if (S().receiveDiagnostics) receiveDiagnostics.close();
    const s = S();
    if (s.ctxMenu || s.meMenu || s.logoutDialog || s.emoOpen) store.patch({ ctxMenu: null, meMenu: false, logoutDialog: null, emoOpen: false });
  }
});

// subscribe first, then request snapshots; every payload is validated before it reaches the store
ipc.listen<unknown>(Events.ACCOUNT_CHANGED, guarded(Events.ACCOUNT_CHANGED, isUiAccountSnapshot, applyAccountSnapshot));
ipc.listen<unknown>(
  Events.IM_CONVERSATION_CHANGED,
  guarded(Events.IM_CONVERSATION_CHANGED, isUiConversation, (c) => {
    if (stillActive(c.account)) upsertConversation(c);
  }),
);
ipc.listen<unknown>(Events.IM_MESSAGE_NEW, receiveMainMessage);
ipc.listen<unknown>(HostEvents.LOCATE, guarded(HostEvents.LOCATE, isLocatePayload, (p) => void locateConversation(p.account, p.gid)));
ipc.listen<unknown>(Events.PREFS_CHANGED, guarded(Events.PREFS_CHANGED, isPrefsSnapshot, (p) => store.patch({ prefs: p })));
ipc.listen<unknown>(Events.NET_CLOCK, guarded(Events.NET_CLOCK, isClockReading, (c) => store.patch({ clockTrusted: c.quality.kind === 'anchored' })));
ipc.listen<unknown>(
  Events.ALARM_SNAPSHOT,
  guarded(Events.ALARM_SNAPSHOT, isAlarmSnapshot, (snap) => {
    const s = S();
    const count = alarmActiveCount(snap.entries, snap.generated_at_ms);
    if (count !== s.alarmCount || snap.clock_trusted !== s.clockTrusted) store.patch({ alarmCount: count, clockTrusted: snap.clock_trusted });
  }),
);
ipc.listen<unknown>(UiEvents.NET_STATUS, guarded(UiEvents.NET_STATUS, isUiNetStatus, (n) => store.patch({ net: n })));
ipc.listen<unknown>(UiEvents.AGENT_STATUS, guarded(UiEvents.AGENT_STATUS, isUiAgentStatus, (a) => store.patch({ agent: a })));
ipc.listen<unknown>(UiEvents.TOAST, guarded(UiEvents.TOAST, isToastPayload, (p) => toast(p.text)));
ipc.listen<unknown>(HostEvents.BANNER, guarded(HostEvents.BANNER, isBannerPayload, onBanner));
ipc.listen<unknown>(HostEvents.PLAY_SOUND, guarded(HostEvents.PLAY_SOUND, isSoundName, onPlaySound));
ipc.listen<unknown>(HostEvents.STOP_SOUND, () => stopSound());

setInterval(() => {
  const now = Date.now();
  if (clockEl) clockEl.textContent = `${formatDate(now)} ${formatClock(now, true)}`;
  const s = S();
  if (s.banners.length === 0) return;
  // A hover that ended while the DOM was being replaced never fires mouseleave: re-check the real pointer state.
  let hoverAt = s.bannerHoverAt;
  let banners = s.banners;
  if (hoverAt !== null && !document.querySelector('.pop-stack:hover')) {
    banners = resumeBanners(banners, hoverAt, now);
    hoverAt = null;
  }
  const next = expireBanners(banners, now, hoverAt !== null);
  if (next !== s.banners || hoverAt !== s.bannerHoverAt) store.patch({ banners: next, bannerHoverAt: hoverAt });
}, 500);
setInterval(() => {
  // Waiting chips tick every 5 s; skipped while a popup is open so its pop-in animation does not replay.
  const s = S();
  if (!s.meMenu && !s.ctxMenu && !s.emoOpen) store.patch({ now: Date.now() });
}, 5000);

void (async () => {
  await Promise.all([loadAccounts(), loadPrefs(), loadNet()]);
  // Alarm counts arrive only through `Events.ALARM_SNAPSHOT`: notify commands are reserved for the alarm window (strong-alert §6).
  await loadForActiveAccount();
})();

exposeForTests(sel, { __vbkStore: store, __vbkOpenConversation: openConversation, __vbkSoundLog: soundLog });
