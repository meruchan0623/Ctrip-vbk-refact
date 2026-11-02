import { companionPackageCard } from './companion-card.ts';
import { historyDiagnostics } from './history-diagnostics.ts';
import { createVisibleRead } from './visible-read.ts';
import { readHistoryPage } from './history-read.ts';
import { personDisplayName } from './person-name.ts';
import { startHistoryLayout, stopHistoryLayout } from './history-layout.ts';
import { createMessagePane, PIN_THRESHOLD } from './message-pane.ts';
import { createDraftBook, createIpcDraftPort } from './draft-book.ts';
import type { MeasuredPane, PaneGeometry, PaneWindow } from './message-pane.ts';
import { sameWindow } from './message-pane.ts';
import type { MessageAnchor } from './message-window.ts';
import { createComposerInput } from './composer-input.ts';
import { createMainFeatureRuntime } from './features/registry.ts';
import { ConfirmController, mountConfirmDialog } from './features/confirm-dialog.ts';
import { FeatureEvents } from './features/context.ts';
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
  UiMessagePage,
  UiNetStatus,
  UiNotice,
  UiNoticeCategory,
  UiOrderSummary,
  UiPackageInfo,
  UiAttachment,
  UiMediaSendResult,
  UiMediaSendProgress,
} from '../../packages/ipc/src/client.ts';
import { UiCommands, UiEvents } from '../../packages/ipc/src/client.ts';
import { MOCK_ORDER_SAMPLES } from '../_shared/mock-loader.ts';
import { appendChildren, h, icon, rerender, cx } from '../../packages/ui-kit/src/h.ts';
import { createStore, subscribeBatched, subscribeFrame } from '../../packages/ui-kit/src/store.ts';
import { hasKey, t } from '../../packages/ui-kit/src/i18n.ts';
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
import { createUnknownOutbound, type UnknownOutboundView } from './unknown-outbound.ts';
import { createReceiveCounters, createReceiveDiagnostics, receiveDiagnosticsJson, type ReceiveDiagnosticsView } from './receive-diagnostics.ts';
import { sendComposer, attachmentSendUnavailable, isRegisteredMediaAttachment, ATTACHMENT_SEND_UNAVAILABLE } from './sendComposer.ts';
import { createPackagePreview, EMPTY_PACKAGE_PREVIEW, packageIdentity, packageOrderId, packageViewApplies, type PackageContext, type PackagePreviewState } from './package-preview.ts';
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
  virtualConversationRange,
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
  safeMediaUrl,
  mergeHistory,
  mergeHistoryIncremental,
  historyScopeKey,
  rowId,
  messageHistoryKey,
  visibleMessages,
  selectedQuoteReference,
  messageQuotePreview,
  mergeQuoteReference,
  sameAccount,
  sendStateView,
  shouldShowTranslationBar,
  tabCounts,
  unreadTotal,
} from './viewmodel.ts';
import type { BannerItem, BusinessTab, ListTab, LogoutMode, OrderContactState, TranslationState, QuotedUiMessage } from './viewmodel.ts';

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
interface MediaOperation {
  readonly attachment: UiAttachment;
  readonly localId: string;
  readonly draftVersion: number;
  readonly stage: 'prepare' | 'upload' | 'send';
  readonly status: 'busy' | 'not_submitted' | 'unknown' | 'rejected';
  readonly error: string | null;
}
interface AttachmentSelection { readonly account: AccountContext; readonly gid: string; readonly draftVersion: number }

interface MainState {
  readonly accounts: UiAccountSnapshot | null;
  readonly accountsError: string | null;
  readonly loginAttempt: string | null;
  readonly view: View;
  readonly agent: UiAgentStatus;
  readonly agentOperation: object | null;
  readonly agentBusy: boolean;
  /** null until the host has reported the network state. */
  readonly net: UiNetStatus | null;
  readonly clockTrusted: boolean;
  readonly alarmCount: number;
  readonly prefs: PrefsSnapshot | null;
  readonly now: number;
  readonly listWindow?: { scope: string; top: number; height: number };
  /** Message pane window + reading anchor `{scope,key,offset}`; survives pane rebuilds (I-08). */
  readonly messageView?: { readonly scope: string; readonly top: number; readonly height: number; readonly anchor: MessageAnchor | null; readonly rev: number };
  // messages
  readonly conversations: readonly UiConversation[];
  readonly business: BusinessTab;
  readonly tab: ListTab;
  readonly query: string;
  readonly activeGid: string | null;
  readonly history: Readonly<Record<string, { hasMore: boolean; beforeMs: number | null; busy: boolean; firstPage?: 'loading' | 'loaded' | 'error'; pageError?: boolean; readContextRevision?: string | undefined }>>;
  readonly messages: Readonly<Record<string, readonly UiMessage[]>>;
  readonly draft: string;
  readonly drafts: Readonly<Record<string, string>>;
  readonly draftVersion: number;
  readonly quote: UiMessage | null;
  readonly attachment: Attachment | null;
  readonly attachmentSelection: AttachmentSelection | null;
  readonly mediaOperation: MediaOperation | null;
  readonly mediaAttempts: Readonly<Record<string, true>>;
  readonly translation: TranslationState;
  /** Local display choices only (never sent to the host). */
  readonly hideInboundTr: boolean;
  readonly trBarOff: boolean;
  readonly emoOpen: boolean;
  readonly sideOpen: boolean;
  readonly hotOrder: boolean;
  readonly pkgOpen: boolean;
  readonly pkgHot: boolean;
  readonly pkg: PackagePreviewState;
  readonly tsimStatus: PackageContext['identity'] | null;
  readonly packageIdentityRequest: number;
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
  readonly unknownOutbound: UnknownOutboundView | null;
  readonly scriptsQuery: string;
  readonly meMenu: boolean;
  readonly logoutDialog: { readonly account: UiAccount; readonly mode: LogoutMode } | null;
  readonly editingTab: { readonly accountId: string; readonly value: string } | null;
  readonly banners: readonly BannerItem[];
  readonly bannerHoverAt: number | null;
  readonly toast: string | null;
}

const PKG_IDLE = EMPTY_PACKAGE_PREVIEW;

const initial: MainState = {
  accounts: null,
  accountsError: null,
  loginAttempt: null,
  view: 'messages',
  agent: { status: 'online', confirmed: false },
  agentOperation: null,
  agentBusy: false,
  net: null,
  clockTrusted: true,
  alarmCount: 0,
  prefs: null,
  now: Date.now(),
  conversations: [],
  business: 'customer',
  tab: 'doing',
  query: '',
  activeGid: null,
  messages: {},
  history: {},
  draft: '',
  drafts: {},
  draftVersion: 0,
  quote: null,
  attachment: null,
  attachmentSelection: null,
  mediaOperation: null,
  mediaAttempts: {},
  translation: TRANSLATION_IDLE,
  hideInboundTr: false,
  trBarOff: false,
  emoOpen: false,
  sideOpen: true,
  hotOrder: false,
  pkgOpen: true,
  pkgHot: false,
  pkg: PKG_IDLE,
  tsimStatus: null,
  packageIdentityRequest: 0,
  ctxMenu: null,
  noticeCats: [],
  noticeCat: null,
  notices: [],
  orderQuery: '',
  order: { kind: 'idle' },
  orderBusyId: null,
  peripheral: null,
  receiveDiagnostics: null,
  unknownOutbound: null,
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

const unknownOutbound = createUnknownOutbound({
  current: () => activeAccount()?.context ?? null,
  invoke: (command, payload) => ipc.invoke(command, payload),
  publish: (view) => {
    const opening = view !== null && S().unknownOutbound === null;
    store.patch({ unknownOutbound: view });
    if (opening) queueMicrotask(() => document.querySelector<HTMLElement>('[data-unknown-outbound]')?.focus());
  },
});

function openUnknownOutbound(): void {
  peripheral.close();
  receiveDiagnostics.close();
  void unknownOutbound.open();
}

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
  business: 'customer',
  tab: 'doing',
  query: '',
  activeGid: null,
  messages: {},
  history: {},
  draft: '',
  drafts: {},
  quote: null,
  attachment: null,
  attachmentSelection: null,
  mediaOperation: null,
  mediaAttempts: {},
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
  agentBusy: false,
  agentOperation: null,
} as const satisfies Partial<MainState>;

/** One persistent polite live region outside the re-rendered tree; the rebuilt root stays aria-live=off. */
function announce(text: string): void {
  const region = document.getElementById('live');
  if (region) region.textContent = text;
}
let toastTimer: ReturnType<typeof setTimeout> | null = null;
function toast(text: string): void {
  announce(text);
  store.patch({ toast: text });
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { announce(''); store.patch({ toast: null }); }, 2600);
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

let accountLoadTicket = 0;
let stopAccountLoadObservation: (() => void) | null = null;

async function loadForActiveAccount(): Promise<void> {
  const ticket = ++accountLoadTicket;
  stopAccountLoadObservation?.();
  stopAccountLoadObservation = null;
  const acc = activeAccount();
  if (!acc) return;
  const account = acc.context;
  const agentAtRead = S().agent;
  const belongs = (c: UiConversation): boolean => sameAccount(c.account, account) && c.account.session_generation === account.session_generation;
  // Preserve mutations received after this read began, including removals. A
  // union of the two lists would resurrect deleted rows from the old snapshot.
  const changes = new Map<string, UiConversation | null>();
  let observed = S().conversations;
  const stop = store.subscribe((next) => {
    if (next.conversations === observed) return;
    const before = new Map(observed.map(c => [c.gid, c]));
    const after = new Map(next.conversations.map(c => [c.gid, c]));
    for (const gid of before.keys()) if (!after.has(gid)) changes.set(gid, null);
    for (const [gid, c] of after) if (before.get(gid) !== c) changes.set(gid, belongs(c) ? c : null);
    observed = next.conversations;
  });
  stopAccountLoadObservation = stop;
  try {
    const [convs, agent, net, cats] = await Promise.all([
      invokeQuiet<UiConversation[]>(UiCommands.IM_CONVERSATIONS, { account }),
      invokeQuiet<unknown>(UiCommands.ACCOUNT_AGENT_STATUS, { account }),
      invokeQuiet<unknown>(UiCommands.NET_STATUS, {}),
      invokeQuiet<UiNoticeCategory[]>(UiCommands.NOTICE_CATEGORIES, { account }),
    ]);
    if (ticket !== accountLoadTicket || !stillActive(account)) return;
    const s = S();
    const snapshot = Array.isArray(convs) ? convs.filter(isUiConversation).filter(belongs) : [];
    const conversations = snapshot.filter(c => !changes.has(c.gid));
    for (const c of changes.values()) if (c) conversations.push(c);
    const lostConversation = !!s.activeGid && !conversations.some(c => c.gid === s.activeGid);
    if (lostConversation && s.attachment) void releaseAttachment(s.attachment);
    const noticeCats = Array.isArray(cats) ? cats : [];
    store.patch({
      conversations,
      noticeCats,
      agent: s.agent === agentAtRead && isUiAgentStatus(agent) ? agent : s.agent,
      net: isUiNetStatus(net) ? net : s.net,
      noticeCat: s.noticeCat && noticeCats.some((c) => c.id === s.noticeCat) ? s.noticeCat : (noticeCats[0]?.id ?? null),
      activeGid: lostConversation ? null : s.activeGid,
      ...(lostConversation ? { attachment: null, attachmentSelection: null, mediaOperation: null } : {}),
    });
    if (S().noticeCat) await loadNotices();
    // Opening a conversation can acknowledge unread messages. Background account
    // refresh must wait for an explicit user selection instead of opening row one.
  } finally {
    stop();
    if (ticket === accountLoadTicket) stopAccountLoadObservation = null;
  }
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
  if (nextAccount?.state !== 'online') { peripheral.close(); receiveDiagnostics.close(); unknownOutbound.close(); }
  const attempt = S().loginAttempt;
  // The login attempt is over once no account is logging in any more.
  const loginAttempt = attempt && snap.accounts.some((a) => a.state === 'logging_in') ? attempt : null;
  if (snap.active_account_id !== prev || activeAccount()?.context.environment !== nextAccount?.context.environment || activeAccount()?.context.session_generation !== nextAccount?.context.session_generation) {
    if (S().attachment) void releaseAttachment(S().attachment);
    peripheral.close();
    receiveDiagnostics.close();
    unknownOutbound.close();
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

/** Server pushes outrank an older command's read-back. */
async function setAgentStatus(status: AgentStatus): Promise<void> {
  const acc = activeAccount();
  if (!acc || S().agentBusy) return;
  const operation = {};
  store.patch({ agentBusy: true, agentOperation: operation, meMenu: false });
  const agentAtWrite = S().agent;
  try {
    const r = await ipc.invoke<unknown>(UiCommands.ACCOUNT_SET_AGENT_STATUS, { account: acc.context, status });
    if (!stillActive(acc.context) || S().agentOperation !== operation) return;
    if (isUiAgentStatus(r)) {
      if (S().agent === agentAtWrite) store.patch({ agent: r });
      const current = S().agent;
      toast(current.confirmed && current.status === status ? t('me.statusOk', { s: agentStatusLabel(current.status) }) : t('me.statusUnconfirmed'));
    }
  } catch (e) {
    if (stillActive(acc.context) && S().agentOperation === operation) toast(t('me.statusFailed', { msg: errorMessage(e) }));
  } finally {
    if (stillActive(acc.context) && S().agentOperation === operation) store.patch({ agentBusy: false, agentOperation: null });
  }
}

// --------------------------------------------------------------- messages

/** `reveal`: switch to the messages view (user action); the automatic first-open keeps the current view. */
async function openConversation(gid: string, reveal = true): Promise<void> {
  const acc = activeAccount();
  if (!acc) return;
  const s = S();
  const readContextRevision = s.conversations.find(c => c.gid === gid)?.assistant_context_revision;
  if (reveal) visibleReads.retry(acc.context, gid, readContextRevision);
  const previousHistory = s.history[gid];
  if (previousHistory && previousHistory.readContextRevision !== readContextRevision) {
    const history = { ...s.history }; delete history[gid];
    store.patch({ history, messages: { ...s.messages, [gid]: [] } });
  }
  const view: View = reveal ? 'messages' : s.view;
  // Opening a conversation dismisses its banner; it never touches the alarm round (host-owned).
  const banners = s.banners.filter((b) => !(b.gid === gid && sameAccount(b.account, acc.context)));
  if (s.activeGid === gid) {
    store.patch({ view, ctxMenu: null, banners });
    if (S().history[gid]?.firstPage === 'loaded') {
      return;
    }
  } else {
    peripheral.close();
    if (s.attachment) void releaseAttachment(s.attachment);
    store.patch({ activeGid: gid, view, banners, draft: s.drafts[gid] ?? s.conversations.find((c) => c.gid === gid)?.draft ?? '', draftVersion: s.draftVersion + 1, quote: null, attachment: null, attachmentSelection: null, mediaOperation: null, translation: TRANSLATION_IDLE, pkg: PKG_IDLE, pkgHot: false, hotOrder: false, ctxMenu: null, emoOpen: false });
  }
  if (S().history[gid]?.firstPage === 'loading' || S().history[gid]?.firstPage === 'loaded') return;
  const request = { hasMore: false, beforeMs: null, busy: true, firstPage: 'loading' as const, readContextRevision };
  store.patch({ history: { ...S().history, [gid]: request } });
  const page = await readHistoryPage(invokeQuiet<UiMessagePage>(UiCommands.IM_MESSAGE_PAGE, { account: acc.context, gid, ...(readContextRevision ? { expected_context_revision: readContextRevision } : {}) }));
  if (!stillActive(acc.context) || S().history[gid] !== request) return;
  if (S().conversations.find(c => c.gid === gid)?.assistant_context_revision !== readContextRevision) {
    store.patch({ history: { ...S().history, [gid]: { ...request, busy: false, firstPage: 'error' } } });
    return;
  }
  if (!page || page.items.some((m) => !isUiMessage(m) || m.gid !== gid)) {
    store.patch({ history: { ...S().history, [gid]: { ...request, busy: false, firstPage: 'error' } } });
    return;
  }
  store.patch({ messages: { ...S().messages, [gid]: mergeHistory(page.items.filter((m) => isUiMessage(m) && m.gid === gid), S().messages[gid] ?? []) }, history: { ...S().history, [gid]: { hasMore: page.has_more, beforeMs: page.before_ms, busy: false, firstPage: 'loaded', readContextRevision } } });
  if (S().activeGid === gid && S().view === 'messages' && (typeof document === 'undefined' || document.visibilityState === 'visible')) {
    autoQueryPackage();
  }
}

async function loadEarlier(conv: UiConversation): Promise<void> {
  if (!stillActive(conv.account)) return;
  const entry = S().history[conv.gid];
  if (!entry?.hasMore || entry.busy || entry.beforeMs === null || entry.readContextRevision !== conv.assistant_context_revision) return;
  const request = { ...entry, busy: true, pageError: false };
  store.patch({ history: { ...S().history, [conv.gid]: request } });
  const page = await readHistoryPage(invokeSafe<UiMessagePage>(UiCommands.IM_MESSAGE_PAGE, { account: conv.account, gid: conv.gid, before_ms: entry.beforeMs, ...(entry.readContextRevision ? { expected_context_revision: entry.readContextRevision } : {}) }));
  if (!stillActive(conv.account) || S().history[conv.gid] !== request) return;
  if (S().conversations.find(c => c.gid === conv.gid)?.assistant_context_revision !== entry.readContextRevision) {
    store.patch({ history: { ...S().history, [conv.gid]: { ...entry, busy: false, hasMore: false, firstPage: 'error', pageError: true } } });
    return;
  }
  const validPage = page && (!page.has_more || (page.before_ms !== null && page.before_ms < entry.beforeMs)) && page.items.every((m) => isUiMessage(m) && m.gid === conv.gid) ? page : null;
  store.patch({
    ...(validPage ? { messages: { ...S().messages, [conv.gid]: mergeHistory(validPage.items, S().messages[conv.gid] ?? []) } } : {}),
    history: { ...S().history, [conv.gid]: { ...entry, hasMore: validPage?.has_more ?? entry.hasMore, beforeMs: validPage?.before_ms ?? entry.beforeMs, busy: false, pageError: !validPage } },
  });

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

/** A removal invalidates the list; never apply a delayed gid deletion to a newer cache. */
function receiveConversationInvalidation(payload: unknown): void {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return;
  const account = payload as Partial<AccountContext>;
  if (typeof account.account_id !== 'string' || !account.account_id.trim() || typeof account.environment !== 'string' || !account.environment.trim() || !Number.isSafeInteger(account.session_generation) || (account.session_generation ?? -1) < 0) return;
  if (stillActive(account as AccountContext)) void loadForActiveAccount();
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
  const next = mergeHistoryIncremental(list, m);
  const quote = s.quote?.gid === m.gid && !selectedQuoteReference(s.quote, next, m.gid) ? null : s.quote;
  store.patch({ messages: { ...s.messages, [m.gid]: next }, quote });
  return true;
}

function upsertConversation(c: UiConversation): void {
  const s = S();
  const exists = s.conversations.some((x) => x.gid === c.gid);
  store.patch({ conversations: exists ? s.conversations.map((x) => (x.gid === c.gid ? c : x)) : [...s.conversations, c] });
  // Conversation previews do not prove that their latest message has been displayed.
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
  store.patch({ messages: { ...s.messages, [conv.gid]: [...(s.messages[conv.gid] ?? []), local] }, drafts: { ...s.drafts, [conv.gid]: '' }, draft: '', draftVersion: s.draftVersion + 1, quote: null, attachment: null, translation: { ...TRANSLATION_IDLE, target: s.translation.target } });
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
  }, (attachment) => sendMediaAttachment(attachment));
  if (result === 'blocked_attachment') toast(ATTACHMENT_SEND_UNAVAILABLE);
}

function ownedAttachment(attachment: unknown, account: AccountContext, gid: string): attachment is UiAttachment {
  return isRegisteredMediaAttachment(attachment) && attachment.owner.gid === gid && sameAccount(attachment.owner.account, account) && attachment.owner.account.session_generation === account.session_generation;
}

function mediaOperationCurrent(operation: MediaOperation): boolean {
  const s = S(), a = operation.attachment;
  return stillActive(a.owner.account) && s.activeGid === a.owner.gid && s.attachment === a && s.mediaOperation?.localId === operation.localId;
}

async function sendMediaAttachment(attachment: UiAttachment): Promise<void> {
  const s = S(), account = activeAccount(s)?.context, conv = activeConv(s);
  if (!account || !conv || isDone(conv) || s.attachment !== attachment || !ownedAttachment(attachment, account, conv.gid)) { toast('附件不属于当前会话，请重新选择。'); return; }
  if (s.mediaOperation && s.mediaOperation.status !== 'not_submitted') return;
  const attemptKey = JSON.stringify([account.environment, account.account_id, account.session_generation, conv.gid, attachment.attachment_id]);
  if (s.mediaAttempts?.[attemptKey]) { toast('该附件已有发送操作，请核对原记录，勿重复发送。'); return; }
  const operation: MediaOperation = { attachment, localId: nextLocalId(Date.now()), draftVersion: s.draftVersion, stage: 'prepare', status: 'busy', error: null };
  const local: UiMessage = { gid: conv.gid, local_id: operation.localId, message_id: null, sender_role: 'merchant_self', kind: attachment.kind, media_filename: attachment.name, text: '', create_time_ms: Date.now(), translation: null, original: null, quote: null, order_id: null, disposition: null };
  store.patch({ mediaOperation: operation, mediaAttempts: { ...s.mediaAttempts, [attemptKey]: true }, attachmentSelection: null, messages: { ...s.messages, [conv.gid]: [...(s.messages[conv.gid] ?? []), local] } });
  let result: UiMediaSendResult;
  try {
    result = await ipc.invoke<UiMediaSendResult>(UiCommands.IM_SEND_MEDIA, { account, gid: conv.gid, local_id: operation.localId, attachment_id: attachment.attachment_id });
    if (!result || !['prepare', 'upload', 'send'].includes(result.stage) || !['not_submitted', 'unknown', 'confirmed', 'rejected'].includes(result.kind) || typeof result.write_started !== 'boolean' || (result.error !== null && typeof result.error !== 'string')) throw new Error('invalid media result');
    if (result.replay_only !== undefined && typeof result.replay_only !== 'boolean') throw new Error('invalid media replay marker');
    if (result.stage === 'send' && !result.write_started) throw new Error('invalid media submission stage');
    const d = result.disposition;
    if (result.kind === 'confirmed' && (!result.write_started || d?.kind !== 'confirmed' || typeof d.server_message_id !== 'string' || !d.server_message_id || typeof d.server_time_ms !== 'number' || !Number.isFinite(d.server_time_ms))) throw new Error('invalid media confirmation');
    if (result.kind === 'rejected' && (d?.kind !== 'rejected' || typeof d.code !== 'string' || typeof d.reason !== 'string')) throw new Error('invalid media rejection');
  } catch {
    // IPC failure does not prove whether upload/submission started. Never create a retry.
    result = { stage: 'send', kind: 'unknown', write_started: true, disposition: { kind: 'unknown' }, message: null, error: '结果未知，请核对消息记录，勿重复发送。' };
  }
  if (result.replay_only === true) {
    if (!stillActive(account)) return;
    // This is evidence about an older intent, never proof that the current attachment was sent.
    store.patch({ messages: { ...S().messages, [conv.gid]: (S().messages[conv.gid] ?? []).filter(m => m !== local) } });
    if (mediaOperationCurrent(operation)) store.patch({ mediaOperation: { ...operation, status: 'unknown', error: '已有意图记录，仅供核验；当前附件未发送。请核对原记录，勿重复发送。' } });
    return;
  }
  if (result.kind === 'confirmed' && result.disposition?.kind === 'confirmed') void releaseAttachment(attachment);
  if (!stillActive(account)) return;
  const projected = (S().messages[conv.gid] ?? []).some(m => m.local_id === operation.localId && m !== local);
  const responseConflict = !result.write_started && projected;
  const notSubmitted = result.kind === 'not_submitted' && !result.write_started && !responseConflict;
  if (!result.write_started) {
    const attempts = { ...S().mediaAttempts }; if (notSubmitted) delete attempts[attemptKey];
    // Remove only our exact optimistic placeholder, never an independently projected SDK event.
    store.patch({ mediaAttempts: attempts, messages: { ...S().messages, [conv.gid]: (S().messages[conv.gid] ?? []).filter(m => m !== local) } });
  } else {
    const projection = result.message;
    const verified = projection && isUiMessage(projection) && projection.gid === conv.gid && projection.local_id === operation.localId && projection.kind === attachment.kind && projection.sender_role === 'merchant_self';
    const disposition: SendDisposition = result.kind === 'confirmed' && result.disposition?.kind === 'confirmed' ? result.disposition
      : result.kind === 'rejected' && result.disposition?.kind === 'rejected' ? result.disposition : { kind: 'unknown' };
    upsertMessage({ ...(verified ? projection : local), disposition, message_id: disposition.kind === 'confirmed' ? disposition.server_message_id : verified ? projection.message_id : null });
  }
  if (!mediaOperationCurrent(operation)) return;
  if (result.kind === 'confirmed' && result.disposition?.kind === 'confirmed') store.patch({ attachment: null, mediaOperation: null });
  else {
    const status = responseConflict ? 'unknown' : notSubmitted ? 'not_submitted' : result.kind === 'rejected' ? 'rejected' : 'unknown';
    const error = responseConflict ? '附件返回与已收到的消息事件不一致，请核对原记录，勿重复发送。'
      : !result.write_started && !notSubmitted ? `${result.kind === 'rejected' ? '附件上传被拒绝' : '附件上传结果待核对'}，消息尚未提交；勿重复上传或发送。${result.error ? ` ${result.error}` : ''}`
      : result.error ?? (notSubmitted ? '附件未发送，可检查后重试。' : result.kind === 'rejected' ? '附件发送被拒绝。' : '结果未知，请核对消息记录，勿重复发送。');
    store.patch({ mediaOperation: { ...operation, stage: result.stage, status, error } });
  }
}

function receiveMediaProgress(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  const p = value as Partial<UiMediaSendProgress>, operation = S().mediaOperation;
  if (!operation || operation.status !== 'busy' || !mediaOperationCurrent(operation) || !p.account || !ownedAttachment(operation.attachment, p.account, p.gid ?? '') || p.attachment_id !== operation.attachment.attachment_id || p.local_id !== operation.localId || !['prepare', 'upload', 'send'].includes(p.stage ?? '')) return;
  const order = { prepare: 0, upload: 1, send: 2 };
  if (order[p.stage!] < order[operation.stage]) return;
  store.patch({ mediaOperation: { ...operation, stage: p.stage! } });
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
  const request: TranslationState = { status: 'busy', gid: conv.gid, draftVersion: version, target, text: '', error: null };
  store.patch({ translation: request });
  try {
    const r = await ipc.invoke<{ draft_version: number; text: string }>(UiCommands.ASSIST_TRANSLATE, { account: acc.context, gid: conv.gid, draft_version: version, text, target });
    if (!stillActive(acc.context) || S().activeGid !== conv.gid || S().draftVersion !== version || S().translation !== request || r.draft_version !== version) return; // account, room, draft or translation request changed
    await sendText(r.text, text);
  } catch (e) {
    if (!stillActive(acc.context) || S().activeGid !== conv.gid || S().draftVersion !== version || S().translation !== request) return;
    const msg = isAppError(e) && e.code === 'assistant.tsim_unauthenticated' ? t('tr.needLogin') : errorMessage(e);
    store.patch({ translation: { status: 'error', gid: conv.gid, draftVersion: version, target, text: '', error: msg } });
  }
}

let trTimer: ReturnType<typeof setTimeout> | null = null;
const composerInput = createComposerInput({
  context: () => composerInputContext(S()),
  invalidateTranslation: () => {
    if (trTimer) clearTimeout(trTimer);
    trTimer = null;
    const s = S();
    store.patch({ draftVersion: s.draftVersion + 1, translation: { ...TRANSLATION_IDLE, gid: s.translation.gid, target: s.translation.target } });
  },
  commit: setDraft,
  refresh: () => store.patch({}),
});
function composerInputContext(s: MainState): { scope: string; version: number } | null {
  const account = activeAccount(s), conv = activeConv(s);
  if (s.view !== 'messages' || account?.state !== 'online' || !conv || isDone(conv) || !sameAccount(account.context, conv.account) || account.context.session_generation !== conv.account.session_generation) return null;
  return { scope: historyScopeKey(account.context, conv.gid), version: s.draftVersion };
}
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
  // The busy object owns this request, including overlapping requests for the same draft/target.
  const request: TranslationState = { status: 'busy', gid: conv.gid, draftVersion: version, target, text: '', error: null };
  store.patch({ translation: request });
  try {
    const r = await ipc.invoke<{ draft_version: number; text: string }>(UiCommands.ASSIST_TRANSLATE, { account: acc.context, gid: conv.gid, draft_version: version, text, target });
    if (!stillActive(acc.context) || S().activeGid !== conv.gid || S().draftVersion !== version || S().translation !== request || r.draft_version !== version) return;
    store.patch({ translation: { status: 'done', gid: conv.gid, draftVersion: version, target, text: r.text, error: null } });
  } catch (e) {
    if (!stillActive(acc.context) || S().activeGid !== conv.gid || S().draftVersion !== version || S().translation !== request) return;
    const msg = isAppError(e) && e.code === 'assistant.tsim_unauthenticated' ? t('tr.needLogin') : errorMessage(e);
    store.patch({ translation: { status: 'error', gid: conv.gid, draftVersion: version, target, text: '', error: msg } });
  }
}

function setDraft(value: string): void {
  const s = S();
  store.patch({ draft: value, drafts: s.activeGid ? { ...s.drafts, [s.activeGid]: value } : s.drafts, draftVersion: s.draftVersion + 1 });
  scheduleTranslation();
}

async function resend(m: UiMessage): Promise<void> {
  if (m.kind !== 'text') { toast('媒体消息不能按文字重发，请核对发送结果。'); return; }
  const s = S();
  const list = s.messages[m.gid] ?? [];
  store.patch({ messages: { ...s.messages, [m.gid]: list.filter((x) => x !== m) } });
  await sendText(m.text, m.original);
}

async function releaseAttachment(attachment: Attachment | null): Promise<void> {
  if (isRegisteredMediaAttachment(attachment)) await invokeQuiet(UiCommands.MEDIA_RELEASE, { account: attachment.owner.account, gid: attachment.owner.gid, attachment_id: attachment.attachment_id });
}

async function attach(kind: 'screenshot' | 'image' | 'file' | 'video'): Promise<void> {
  const s = S(), account = activeAccount(s)?.context, conv = activeConv(s);
  if (!account || !conv || isDone(conv) || (s.mediaOperation && s.mediaOperation.status !== 'not_submitted')) return;
  const selection: AttachmentSelection = { account: { ...account }, gid: conv.gid, draftVersion: s.draftVersion };
  store.patch({ attachmentSelection: selection });
  const args = { account: selection.account, gid: selection.gid };
  const attachment = kind === 'screenshot' ? await invokeSafe<unknown>(UiCommands.MEDIA_SCREENSHOT, args) : await invokeSafe<unknown>(UiCommands.MEDIA_PICK, { ...args, kind });
  if (S().attachmentSelection !== selection || !stillActive(selection.account) || S().activeGid !== selection.gid || S().draftVersion !== selection.draftVersion) {
    if (S().attachmentSelection === selection) store.patch({ attachmentSelection: null });
    if (isRegisteredMediaAttachment(attachment)) await releaseAttachment(attachment);
    return;
  }
  store.patch({ attachmentSelection: null });
  if (!attachment) return;
  if (!ownedAttachment(attachment, selection.account, selection.gid) || attachment.kind !== (kind === 'screenshot' ? 'image' : kind)) {
    if (isRegisteredMediaAttachment(attachment)) await releaseAttachment(attachment);
    toast('附件不可用或不属于当前会话，请重新选择。'); return;
  }
  const previous = S().attachment;
  store.patch({ attachment, mediaOperation: null, translation: { ...TRANSLATION_IDLE, gid: conv.gid, target: translationTarget(S(), conv) } });
  await releaseAttachment(previous);
}

async function removeAttachment(attachment: Attachment): Promise<void> {
  const s = S();
  if (s.attachment !== attachment || s.mediaOperation?.status === 'busy') return;
  if (isRegisteredMediaAttachment(attachment) && (!stillActive(attachment.owner.account) || s.activeGid !== attachment.owner.gid)) return;
  // This only removes the local selection. An uploaded/submitted message is never recalled.
  store.patch({ attachment: null, mediaOperation: null, attachmentSelection: null });
  await releaseAttachment(attachment);
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

const packagePreview = createPackagePreview({ current: () => packageContext(), invoke: (command, payload) => ipc.invoke(command, payload), publish: pkg => store.patch({ pkg }) });

function packageContext(): PackageContext | null {
  const s = S(), account = activeAccount(s)?.context, conversation = activeConv(s);
  if (!account || !conversation || !s.tsimStatus || !sameAccount(account, conversation.account) || account.session_generation !== conversation.account.session_generation) return null;
  return { account, conversation, identity: s.tsimStatus, enabled: packageEnabled(s), iccid: findIccids(s.messages[conversation.gid] ?? [])[0] ?? null };
}

async function queryPackage(iccid: string, force = false): Promise<void> {
  if (!iccid) return;
  // An associated order always wins; an order number is never passed to the ICCID command.
  await packagePreview.query(force, activeConv() && packageOrderId(activeConv()!) ? undefined : iccid);
}

async function refreshPackages(): Promise<void> {
  const previous = S().tsimStatus;
  await refreshPackageIdentity();
  const current = S().tsimStatus;
  // A newly observed identity already starts one automatic query in receivePackageIdentity.
  if (!current || !previous || current.session_epoch !== previous.session_epoch || current.logged_in !== previous.logged_in || current.user !== previous.user) return;
  await packagePreview.query(true);
}

function openTsimSettings(): void { void invokeSafe(UiCommands.SHELL_OPEN_WINDOW, { label: WindowLabels.SETTING }); }

function receivePackageIdentity(value: unknown): void {
  if (!packageIdentity(value)) { packagePreview.reset(); store.patch({ packageIdentityRequest: (S().packageIdentityRequest ?? 0) + 1, tsimStatus: null, pkg: { ...PKG_IDLE, status: 'error', failure: 'login', error: '无法核对 TSim 登录状态，请打开设置登录或刷新状态。' } }); return; }
  const previous = S().tsimStatus;
  if (!previous || previous.session_epoch !== value.session_epoch || previous.logged_in !== value.logged_in || previous.user !== value.user) packagePreview.reset();
  store.patch({ tsimStatus: value, packageIdentityRequest: (S().packageIdentityRequest ?? 0) + 1 });
  autoQueryPackage();
}

async function refreshPackageIdentity(): Promise<void> {
  const ticket = (S().packageIdentityRequest ?? 0) + 1;
  store.patch({ packageIdentityRequest: ticket });
  try { const status = await ipc.invoke<unknown>(UiCommands.ASSIST_TSIM_STATUS, {}); if (S().packageIdentityRequest === ticket) receivePackageIdentity(status); }
  catch { if (S().packageIdentityRequest === ticket) receivePackageIdentity(null); }
}

function packageEnabled(s: MainState): boolean {
  return !!s.prefs?.assistant.enabled && !!s.prefs?.assistant.package_quick_view;
}

/** Stable query keys prevent repeated broadcasts and errors from becoming repeated HTTP requests. */
function autoQueryPackage(): void {
  void packagePreview.query();
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
        dataset: { account: a.context.account_id, state: a.state, fid: `acct-tab:${a.context.account_id}` },
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
      { class: cx('nav-i', { on: s.view === view }), 'aria-label': label, 'aria-current': s.view === view ? 'page' : undefined, dataset: { nav: view, fid: `nav:${view}` }, onclick: () => store.patch({ view, ctxMenu: null, meMenu: false }) },
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
    h('button', { class: 'nav-i', 'aria-label': t('nav.settings'), dataset: { nav: 'settings', fid: 'nav:settings' } , onclick: () => void invokeSafe(UiCommands.SHELL_OPEN_WINDOW, { label: WindowLabels.SETTING }) }, icon(IC.gear, 20), h('span', null, t('nav.settings'))),
    h(
      'button',
      {
        class: 'me',
        style: { background: acc?.color ?? '#5B6676' },
        'aria-label': `${t('nav.account')}：${av.label}`,
        'aria-expanded': String(s.meMenu),
        disabled: !acc,
        dataset: { nav: 'me', fid: 'nav:me' } ,
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
        { class: 'mi', role: 'menuitem', dataset: { agentStatus: st, fid: `agent-status:${st}` }, disabled: s.agentBusy, onclick: () => void setAgentStatus(st) },
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
    h('button', { class: 'mi', role: 'menuitem', dataset: { me: 'suspend', fid: 'me-menu:suspend' } , onclick: () => store.patch({ meMenu: false, logoutDialog: { account: acc, mode: 'suspend' } }) }, t('me.logoutSuspend')),
    h('button', { class: 'mi dan', role: 'menuitem', dataset: { me: 'logout', fid: 'me-menu:logout' } , onclick: () => store.patch({ meMenu: false, logoutDialog: { account: acc, mode: 'logout' } }) }, t('me.logoutFull')),
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
  const counts = tabCounts(s.conversations, 'customer');
  const list = filterConversations(s.conversations, s.tab, s.query, 'customer');
  const scope = JSON.stringify([activeAccount(s)?.context, s.tab, s.query]);
  const window = s.listWindow?.scope === scope ? s.listWindow : undefined;
  const range = virtualConversationRange(list.length, window?.top ?? 0, window?.height ?? 900);
  const acc = activeAccount(s);
  const av = agentView(s.agent);
  const nv = netView(s.net);
  const rows = list.slice(range.start, range.end).map((c) => {
    const on = c.gid === s.activeGid;
    const waiting = c.waiting_since_ms !== null && !isDone(c);
    const waited = waiting ? waitedSeconds(c, s.now) : 0;
    const mark = MARK_COLORS.find((m) => m.action === c.mark);
    const draft = s.drafts[c.gid] ?? c.draft;
    const hasDraft = !!draft && !on;
    return h(
      'div',
      {
        class: cx('conv', { on, top: c.is_top }),
        role: 'button',
        tabindex: '0',
        dataset: { gid: c.gid, fid: `conv:${c.gid}` },
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
        h('div', { class: 'crow' }, h('span', { class: 'cname' }, c.title), c.lang !== 'zh' ? h('span', { class: 'chip chip-lang' }, langName(c.lang)) : null, h('span', { class: 'ctime', dataset: { relativeTime: String(c.last_message_time_ms ?? 0) } }, c.last_message_time_ms ? formatRelativeTime(c.last_message_time_ms, s.now) : '')),
        h('div', { class: 'crow' }, hasDraft ? h('span', { class: 'cdraft' }, t('list.draft')) : null, h('span', { class: 'cprev' }, hasDraft ? draft : c.preview), accBadge(c.unread_count)),
        h(
          'div',
          { class: 'crow', style: { 'margin-top': '2px' } },
          c.vendor_name ? h('span', { class: 'conv-vendor' }, c.vendor_name) : c.biz ? h('span', { class: 'chip chip-biz' }, c.biz) : null,
          waiting ? h('span', { class: cx('wait', waited >= RED_AFTER_SECONDS ? 'red' : 'amber'), dataset: { waitingGid: c.gid }, title: c.waiting_confirmed ? undefined : t('alarm.pendingTitle') }, icon(IC.clock, 11), c.waiting_confirmed ? t('list.waiting', { t: formatDuration(waited) }) : `${t('list.waiting', { t: formatDuration(waited) })} · ${t('list.waitingPending')}`) : null,
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
        h('button', { class: cx('ftab', { on: s.tab === 'doing' }), role: 'tab', 'aria-selected': String(s.tab === 'doing'), dataset: { tab: 'doing', fid: 'list-tab:doing' } , onclick: () => store.patch({ tab: 'doing' }) }, `${t('list.doing')} ${counts.doing}`),
        h('button', { class: cx('ftab', { on: s.tab === 'done' }), role: 'tab', 'aria-selected': String(s.tab === 'done'), dataset: { tab: 'done', fid: 'list-tab:done' } , onclick: () => store.patch({ tab: 'done' }) }, `${t('list.done')} ${counts.done}`),
      ),
    ),
    nv.offline ? h('div', { class: 'netbar' }, h('span', { class: 'spin', style: { 'border-top-color': '#87500A' } }), h('span', { style: { flex: '1' } }, t('list.offline')), h('button', { class: 'link', onclick: () => void loadForActiveAccount() }, t('list.retryNow'))) : null,
    acc?.state === 'expired' ? h('div', { class: 'netbar err', dataset: { expired: '1' } }, icon(IC.alert, 15), h('span', { style: { flex: '1' } }, t('list.expired')), h('button', { class: 'link', onclick: () => void startLogin(acc.context) }, t('list.relogin'))) : null,
    h('div', { class: 'cscroll', dataset: { keepScroll: `clist:${scope}`, listScope: scope }, onscroll: (event: Event) => {
      const el = event.currentTarget as HTMLElement;
      const next = virtualConversationRange(list.length, el.scrollTop, el.clientHeight);
      if (next.start !== range.start || next.end !== range.end) store.patch({ listWindow: { scope, top: el.scrollTop, height: el.clientHeight } });
    } }, h('div', { style: { height: `${range.start * 96}px` }, 'aria-hidden': 'true' }), rows, h('div', { style: { height: `${(list.length - range.end) * 96}px` }, 'aria-hidden': 'true' }), rows.length === 0 ? h('div', { class: 'empty', style: { margin: '16px' } }, s.query ? t('list.emptySearch') : t('list.empty')) : null),
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
    h('button', { class: 'mi', role: 'menuitem', dataset: { ctx: 'top', fid: 'ctx-menu:top' } , onclick: () => void toggleTop(c) }, icon(IC.pin, 13), items.topLabel),
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
          dataset: { mark: String(mc.action), fid: `mark:${mc.action}` },
          onclick: () => void setMark(c, mc.action),
        }),
      ),
    ),
    items.showClear ? h('button', { class: 'mi', role: 'menuitem', dataset: { ctx: 'clear', fid: 'ctx-menu:clear' } , onclick: () => void setMark(c, 0) }, t('ctx.clearMark')) : null,
  );
}

function richText(text: string): HTMLElement[] {
  const packageOwner = packageContext();
  const sourceMessages = packageOwner ? S().messages[packageOwner.conversation.gid] : undefined;
  const sourceKey = packageOwner ? JSON.stringify([packageOwner.account.environment, packageOwner.account.account_id, packageOwner.account.session_generation, packageOwner.conversation.gid, packageOwner.conversation.assistant_context_revision, packageOwner.identity.session_epoch]) : null;
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
                const current = packageContext();
                if (!current || !sourceKey || JSON.stringify([current.account.environment, current.account.account_id, current.account.session_generation, current.conversation.gid, current.conversation.assistant_context_revision, current.identity.session_epoch]) !== sourceKey || S().messages[current.conversation.gid] !== sourceMessages || !findIccids(sourceMessages ?? []).includes(p.text)) return;
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

// Window model of the message pane (I-28a): which rows are mounted, measured heights, the reading anchor.
const messagePaneModel = createMessagePane();
// Anchor captured just before a redraw; consumed by messagePane() while that redraw runs.
let liveAnchor: MessageAnchor | null = null;
let messageViewPatches = 0;
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

/** Playback state belongs to one verified account generation, room and message identity. */
function mediaNodeKey(account: AccountContext | null, conv: UiConversation, message: UiMessage): string {
  const id = message.message_id ?? message.local_id;
  if (!account || !id || message.gid !== conv.gid || !sameAccount(account, conv.account) || account.session_generation !== conv.account.session_generation) return '';
  return JSON.stringify([account.environment, account.account_id, account.session_generation, conv.gid, message.message_id ? 'server' : 'local', id]);
}

function paneGeometry(scroll: HTMLElement): PaneGeometry {
  return { scrollTop: scroll.scrollTop, clientHeight: scroll.clientHeight, scrollHeight: scroll.scrollHeight };
}
/** Measure the mounted rows: height includes the row's bottom margin, header is whatever precedes row 0. */
function measureMessagePane(scroll: HTMLElement): MeasuredPane {
  const rows = [...scroll.querySelectorAll<HTMLElement>('[data-row-id]')];
  const origin = scroll.querySelector<HTMLElement>('[data-msg-spacer="top"]') ?? rows[0];
  const header = origin ? origin.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop : 0;
  return { header, rows: rows.filter(row => row.dataset['rowId']).map(row => ({ id: row.dataset['rowId']!, height: row.getBoundingClientRect().height + (Number.parseFloat(getComputedStyle(row).marginBottom) || 0) })) };
}

/** Model-based reading anchor `{scope, key, offset}`: no per-row DOM reads or JSON.parse. */
function captureMessageAnchor(s: MainState): MessageAnchor | null {
  const conv = activeConv(s), account = activeAccount(s)?.context ?? null;
  if (!conv) { historyDiagnostics.record('capture_skip', {}, 'no_conversation'); return null; }
  const scope = historyScopeKey(account, conv.gid);
  const scroll = document.querySelector<HTMLElement>('[data-keep-scroll="msgs"]');
  const geometry = scroll ? paneGeometry(scroll) : null;
  const result = messagePaneModel.capture(scope && scroll?.dataset['historyScope'] === scope ? scope : null, geometry);
  if ('skip' in result) {
    historyDiagnostics.record('capture_skip', geometry ?? {}, result.skip === 'pinned' ? 'pinned' : result.skip === 'no_anchor' ? 'no_candidates' : 'wrong_scope');
    return null;
  }
  const diagnosticId = historyDiagnostics.record('capture', { ...(geometry ?? {}), offset: result.anchor.offset });
  historyDiagnostics.record('capture_done', { capture: diagnosticId, candidates: 1 }, 'observed');
  return result.anchor;
}
/** Put the anchor row back after a redraw or after media changed a row's height. */
function restoreMessageAnchor(anchor: MessageAnchor | null): void {
  const current = S(), conv = activeConv(current), account = activeAccount(current)?.context ?? null;
  const scroll = document.querySelector<HTMLElement>('[data-keep-scroll="msgs"]');
  const scope = conv ? historyScopeKey(account, conv.gid) : '';
  if (!conv || !scope || !scroll || scroll.dataset['historyScope'] !== scope) { historyDiagnostics.record('restore_skip', {}, 'wrong_scope'); return; }
  const pinned = scroll.dataset['scrollBottom'] === '1';
  const view = current.messageView?.scope === scope ? current.messageView : undefined;
  const target = pinned ? null : anchor ?? view?.anchor ?? null;
  const result = messagePaneModel.sync(scope, paneGeometry(scroll), measureMessagePane(scroll), target, pinned);
  if (!result) { historyDiagnostics.record('restore_skip', {}, 'wrong_scope'); return; }
  if (result.scrollTo !== null) {
    const before = scroll.scrollTop;
    scroll.scrollTop = result.scrollTo;
    historyDiagnostics.record('restore', { offset: target?.offset ?? 0, before, after: scroll.scrollTop, delta: scroll.scrollTop - before, scrollHeight: scroll.scrollHeight, clientHeight: scroll.clientHeight }, 'applied');
  } else if (!target) historyDiagnostics.record('restore_skip', {}, 'no_anchor');
  // The window moves only when the model says so; a bounded retry keeps measure and render from chasing each other.
  const stale = !view || view.height !== scroll.clientHeight;
  if ((result.rerender || stale) && scroll.clientHeight > 0 && messageViewPatches < 4) {
    messageViewPatches++;
    persistMessageView(scroll, scope, pinned);
  } else if (!result.rerender) messageViewPatches = 0;
}
/** Persist `{scope, top, height, anchor}` in the store so a rebuilt pane resumes at the same row. */
function persistMessageView(scroll: HTMLElement, scope: string, pinned: boolean): void {
  const captured = pinned ? null : messagePaneModel.capture(scope, paneGeometry(scroll));
  const top = Math.max(0, scroll.scrollTop - messagePaneModel.header());
  store.patch({ messageView: { scope, top, height: scroll.clientHeight, anchor: captured && 'anchor' in captured ? captured.anchor : null, rev: (S().messageView?.rev ?? 0) + 1 } });
}
/** Scrolling needs a new window, or (debounced) a fresh stored anchor. */
let messageViewTimer: ReturnType<typeof setTimeout> | undefined;
function onMessageScroll(scroll: HTMLElement): void {
  messageViewPatches = 0;
  const conv = activeConv(S()), scope = conv ? historyScopeKey(activeAccount(S())?.context ?? null, conv.gid) : '';
  if (!scope || scroll.dataset['historyScope'] !== scope) return;
  const need = messagePaneModel.rangeFor(paneGeometry(scroll));
  const pinned = scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop < PIN_THRESHOLD;
  if (need?.changed) { persistMessageView(scroll, scope, pinned); return; }
  clearTimeout(messageViewTimer);
  messageViewTimer = setTimeout(() => {
    if (scroll.isConnected && scroll.dataset['historyScope'] === scope) persistMessageView(scroll, scope, scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop < PIN_THRESHOLD);
  }, 250);
}
function withMessageAnchor(s: MainState, redraw: () => void): void {
  const anchor = captureMessageAnchor(s);
  liveAnchor = anchor;
  stopHistoryLayout();
  try { redraw(); } finally { liveAnchor = null; }
  restoreMessageAnchor(anchor);
  const scroll = document.querySelector<HTMLElement>('[data-keep-scroll="msgs"]');
  const scope = scroll?.dataset['historyScope'];
  startHistoryLayout(scroll, () => captureMessageAnchor(S()), restoreMessageAnchor, () => {
    const current = S(), conv = activeConv(current);
    return !!scroll?.isConnected && !!scope && !!conv && historyScopeKey(activeAccount(current)?.context ?? null, conv.gid) === scope;
  });
}

function messageRow(s: MainState, m: UiMessage, conv: UiConversation, acc: UiAccount | null): HTMLElement {
  const alignment = messageAlignment(m);
  if (alignment.side === 'system') {
    const account = acc?.context ?? null;
    const key = messageHistoryKey(account, conv, m);
    return h('div', { class: 'msg-sys', dataset: { historyKey: key, rowId: rowId(m) } }, h('span', null, `${formatDate(m.create_time_ms)} ${formatClock(m.create_time_ms, true)} ${m.text}`));
  }
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
  } else if (m.kind === 'image' || m.kind === 'video' || m.kind === 'file') {
    const url = safeMediaUrl(m.media_url ?? (m.kind !== 'file' ? m.text : null));
    const thumbnail = safeMediaUrl(m.media_thumbnail);
    const name = m.media_filename || (m.kind === 'file' ? m.text : previewOf(m));
    if (url && m.kind === 'image') {
      body = h('a', { class: 'media-image', href: url, onclick: (e: Event) => { e.preventDefault(); void invokeSafe(UiCommands.SHELL_OPEN_EXTERNAL, { url }); }, title: '查看原图' }, h('img', { src: thumbnail ?? url, alt: name, loading: 'lazy', referrerpolicy: 'no-referrer', onerror: (e: Event) => (e.target as HTMLImageElement).replaceWith(h('span', { class: 'bubble' }, '图片加载失败，点击查看原图')) }));
    } else if (url && m.kind === 'video') {
      body = h('video', { dataset: { mediaKey: mediaNodeKey(acc?.context ?? null, conv, m) }, class: 'media-video', src: url, poster: thumbnail, controls: true, preload: 'metadata', 'aria-label': name });
    } else if (url) {
      body = h('a', { class: 'bubble media-file', href: url, onclick: (e: Event) => { e.preventDefault(); void invokeSafe(UiCommands.SHELL_OPEN_EXTERNAL, { url }); } }, icon(IC.file, 22), name);
    } else body = h('div', { class: 'bubble' }, name || previewOf(m));
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
  const who = personDisplayName(m.sender_name?.trim() || null, '') || m.sender_id?.trim() || (isSelf ? (acc ? accountLabel(acc) : roleLabel('merchant_self')) : m.sender_role === 'customer' ? conv.title : roleLabel(m.sender_role));
  return h(
    'div',
    { class: cx('msg', { mine: alignRight }), dataset: { mid: m.local_id ?? m.message_id ?? '', rowId: rowId(m), historyKey: messageHistoryKey(acc?.context ?? null, conv, m) } },
    h('div', { class: 'ava sm', style: { background: isSelf ? (acc?.color ?? '#5B6676') : conv.color } }, renderMessageAvatar(document, who, m.sender_avatar)),
    h(
      'div',
      { class: 'mcol' },
      h('div', { class: 'mmeta' }, who),
      quotePreview ? h('div', { class: 'quote-in' }, t('chat.quotePrefix'), quotePreview) : null,
      body,
      showTime ? h('div', { class: 'message-time' }, isSelf && m.read_status && m.read_status !== 'unknown' ? h('span', { class: m.read_status === 'unread' ? 'receipt-unread' : 'receipt-read' }, m.read_status === 'unread' ? '未读' : '已读') : null, `${formatDate(m.create_time_ms)} ${formatClock(m.create_time_ms, true)}`) : null,
      st
        ? h(
            'div',
            { class: cx('mst', st.cls), dataset: { sendState: st.cls } },
            st.spin ? h('span', { class: 'spin' }) : null,
            h('span', null, st.label),
            st.canRetry && m.kind === 'text' ? h('button', { class: 'act', onclick: () => void resend(m) }, t('send.retry')) : null,
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
  const account = activeAccount(s)?.context;
  const owner = account ? { ...account } : null;
  const draftVersion = s.draftVersion;
  const attachment = s.attachment;
  const applies = (): boolean => {
    const current = S();
    return !!owner && stillActive(owner) && current.activeGid === conv.gid && current.draftVersion === draftVersion && current.translation === tr && current.attachment === attachment;
  };
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
      h('button', { class: 'btn sm', dataset: { tr: 'send-original', fid: 'tr:send-original' } , onclick: () => { if (applies()) void sendText(S().draft.trim(), null); } }, t('tr.sendOriginal')),
      h('button', { class: 'btn sm pri', dataset: { tr: 'retry', fid: 'tr:retry' } , onclick: () => { if (applies()) { if (direct) void translateAndSend(S().draft.trim()); else void runPreviewTranslation(); } } }, t('tr.retry')),
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
        h('button', { class: 'btn sm', dataset: { tr: 'replace', fid: 'tr:replace' } , onclick: () => { if (applies()) store.patch({ draft: tr.text, drafts: { ...S().drafts, [conv.gid]: tr.text }, draftVersion: S().draftVersion + 1, translation: { ...TRANSLATION_IDLE, gid: conv.gid, target } }); } }, t('tr.replace')),
        h('button', { class: 'btn sm pri', dataset: { tr: 'send', fid: 'tr:send' } , onclick: () => { if (applies()) void sendText(tr.text, S().draft.trim()); } }, t('tr.sendTranslated')),
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
            if (!applies()) return;
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
  const media = s.attachment && isRegisteredMediaAttachment(s.attachment) ? s.attachment : null;
  const operation = s.mediaOperation?.attachment === s.attachment ? s.mediaOperation : null;
  const mediaLocked = !!operation && operation.status !== 'not_submitted';
  const mediaLabel = operation?.status === 'busy' ? ({ prepare: '正在准备附件…', upload: '正在上传附件…', send: '正在提交附件消息…' } as const)[operation.stage]
    : operation?.error ?? (media ? '仅发送附件，文字/引用保留。' : s.attachment ? ATTACHMENT_SEND_UNAVAILABLE : '');
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
      h('button', { class: 'chipbtn', dataset: { chip: 'phrases', fid: 'chip:phrases' } , onclick: () => openPeripheral('scripts') }, icon(IC.chat, 13), t('composer.phrases')),
      chip(t('composer.recommend'), IC.box, 'recommend'),
      h('button', { class: cx('chipbtn', { on: s.hideInboundTr }), dataset: { chip: 'hide-tr', fid: 'chip:hide-tr' } , title: s.hideInboundTr ? t('composer.showTr') : t('composer.hideTr'), onclick: () => store.patch({ hideInboundTr: !S().hideInboundTr }) }, icon(IC.translate, 13), s.hideInboundTr ? t('composer.showTr') : t('composer.hideTr')),
    ),
    h(
      'div',
      { class: 'ctools' },
      h('button', { class: cx('ibtn', { on: s.emoOpen }), 'aria-label': t('composer.emoji'), title: t('composer.emoji'), disabled: finished, dataset: { tool: 'emoji', fid: 'tool:emoji' } , onclick: (e: Event) => { e.stopPropagation(); store.patch({ emoOpen: !S().emoOpen }); } }, icon(IC.smile, 18)),
      h('button', { class: 'ibtn', 'aria-label': t('composer.screenshot'), title: shotKey ? `${t('composer.screenshot')} ${shotKey}` : t('composer.screenshot'), disabled: finished || mediaLocked, dataset: { tool: 'screenshot', fid: 'tool:screenshot' } , onclick: () => void attach('screenshot') }, icon(IC.scissors, 18)),
      h('button', { class: 'ibtn', 'aria-label': t('composer.image'), title: t('composer.image'), disabled: finished || mediaLocked, dataset: { tool: 'image', fid: 'tool:image' } , onclick: () => void attach('image') }, icon(IC.image, 18)),
      h('button', { class: 'ibtn', 'aria-label': t('composer.file'), title: t('composer.file'), disabled: finished || mediaLocked, dataset: { tool: 'file', fid: 'tool:file' } , onclick: () => void attach('file') }, icon(IC.file, 18)),
      h('button', { class: 'ibtn', 'aria-label': '视频', title: '视频', disabled: finished || mediaLocked, dataset: { tool: 'video', fid: 'tool:video' } , onclick: () => void attach('video') }, icon(IC.file, 18)),
      h('button', { class: 'ibtn', 'aria-label': t('composer.phrases'), dataset: { tool: 'phrases', fid: 'tool:phrases' } , onclick: () => openPeripheral('scripts') }, icon(IC.chat, 18)),
      conv.lang !== 'zh' && s.prefs?.assistant.enabled && s.prefs.assistant.outbound_translation
        ? h('button', { class: cx('ibtn', { on: !s.trBarOff }), 'aria-label': t('composer.trToggle'), title: t('composer.trToggleTitle'), dataset: { tool: 'translate', fid: 'tool:translate' } , onclick: () => store.patch({ trBarOff: !S().trBarOff }) }, icon(IC.translate, 18))
        : null,
      h('span', { class: 'hint', style: { 'margin-left': 'auto', 'padding-right': '6px' } }, '本客户端：单附件≤10MiB，视频≤3分钟。'),
    ),
    quote ? h('div', { class: 'quote-bar' }, h('span', { style: { flex: '1', overflow: 'hidden', 'white-space': 'nowrap', 'text-overflow': 'ellipsis' } }, t('chat.quotePrefix'), quote.text), h('button', { class: 'ibtn', style: { width: '22px', height: '22px' }, 'aria-label': t('chat.cancelQuote'), onclick: () => store.patch({ quote: null }) }, icon(IC.close, 12))) : null,
    s.attachment ? h('div', { class: 'attach', title: mediaLabel, dataset: { mediaStatus: operation?.status ?? (media ? 'ready' : 'unsupported') } }, operation?.status === 'busy' ? h('span', { class: 'spin' }) : null, h('span', { style: { 'font-size': '12px' }, role: 'status', 'aria-live': 'polite' }, `${s.attachment.name} · ${mediaLabel}`), h('button', { class: 'ibtn', style: { width: '22px', height: '22px' }, 'aria-label': t('composer.removeAttach'), title: operation && operation.status !== 'not_submitted' ? '仅移除本地选择，不会撤回已上传或提交的消息。' : '移除本地附件', disabled: operation?.status === 'busy', onclick: () => void removeAttachment(s.attachment!) }, icon(IC.close, 12))) : null,
    h('textarea', {
      class: 'ta',
      placeholder: finished ? t('composer.placeholderFinished') : t('composer.placeholder'),
      'aria-label': '输入消息',
      value: s.draft,
      disabled: finished,
      dataset: { fid: 'draft' },
      ...composerInput.bind(composerInputContext(s)?.scope ?? null),
      onkeydown: (e: KeyboardEvent) => {
        if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229 || composerInput.active() || e.altKey) return;
        const want = sendKey === 'enter' ? !e.shiftKey && !e.ctrlKey && !e.metaKey : e.ctrlKey || e.metaKey;
        if (want) {
          e.preventDefault();
          void handleSend();
        }
      },
    }),
    h('div', { class: 'cfoot' }, h('span', { class: 'hint' }, media ? '仅发送附件，文字/引用保留；结果未知时请先核对，勿重复发送。' : direct ? t('composer.directMode') : sendKey === 'enter' ? t('composer.hintEnter') : t('composer.hintCtrlEnter')), h('button', { class: 'btn pri', dataset: { action: 'send' }, disabled: finished || mediaLocked, onclick: () => { if (!composerInput.active()) void handleSend(); } }, icon(IC.send, 14), media ? '发送附件' : t('composer.send'))),
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
  const view: PackagePreviewState = !s.tsimStatus ? { ...PKG_IDLE, status: 'error', failure: 'login', error: s.pkg.error ?? 'TSim 登录状态尚未核验，请刷新状态或打开设置登录。' } : packageViewApplies(s.pkg, packageContext()) ? s.pkg : PKG_IDLE;
  const order = packageOrderId(conv), iccids = findIccids(s.messages[conv.gid] ?? []);
  const plans = view.summary?.plans ?? (view.info ? [view.info] : []);
  const busy = view.status === 'busy';
  const owner = { ...conv.account };
  const applies = (): boolean => stillActive(owner) && activeConv()?.gid === conv.gid && (view === S().pkg || !S().tsimStatus) && (view.key === null || packageViewApplies(view, packageContext()));
  const notice = [
    !s.tsimStatus?.logged_in || view.failure === 'login' ? h('div', { class: 'callout', dataset: { tone: 'info' } }, h('div', null, h('p', null, s.tsimStatus ? 'TSim 尚未登录' : 'TSim 登录状态待核对'), h('button', { class: 'solid', dataset: { packageAction: 'login' }, onclick: () => { if (applies()) openTsimSettings(); } }, '打开设置登录 TSim'))) : null,
    view.error ? h('div', { class: 'callout', dataset: { tone: 'bad' }, role: 'alert' }, h('div', null, h('p', null, view.error), h('button', { class: 'outline', disabled: busy, dataset: { packageAction: 'retry' }, onclick: () => { if (applies()) void refreshPackages(); } }, '重新核对'))) : null,
    busy ? h('div', { class: 'skeleton', role: 'status' }, h('i'), h('i'), h('span', null, '正在查询订单套餐…')) : null,
    view.status === 'done' && !plans.length ? h('div', { class: 'callout' }, h('p', null, '该订单暂无可查看套餐')) : null,
    view.status === 'idle' && !order && !iccids.length ? h('div', { class: 'callout' }, h('p', null, '当前会话暂无有效订单号或 ICCID')) : null,
  ];
  return companionPackageCard({ plans, total: view.summary?.total ?? plans.length, open: s.pkgOpen, busy, hot: s.pkgHot, scope: view.key ?? JSON.stringify([owner, conv.gid, conv.assistant_context_revision]),
    identity: order ? `关联订单：${order}` : iccids.length ? '按 ICCID 查询' : '暂无关联订单',
    refreshDisabled: busy || !order && !iccids.length, notice,
    refresh: () => { if (applies()) void refreshPackages(); },
    toggle: () => store.patch({ pkgOpen: !S().pkgOpen }),
    canDetail: !!view.summary,
    detail: (index) => { if (applies() && view.summary) void packagePreview.openDetail(view, view.summary.plans[index]!); },
    copy: (value) => { if (applies()) void copyText(value, '已复制'); },
  }, h, icon);
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
              row('订单号', o.order_id),
              row('商品名称', o.product),
              row('使用日期', o.use_date),
              row('订单总额', o.total_amount),
              row('备注名称', o.remark_name),
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

// Retain the expensive message subtree across draft, sidebar and unrelated updates.
// Only one active pane is retained, so old accounts/rooms do not accumulate DOM caches.
let messagePaneCache: { deps: readonly unknown[]; msgs: readonly UiMessage[]; win: PaneWindow; node: HTMLElement } | undefined;
function messagePane(s: MainState, conv: UiConversation, acc: UiAccount | null, pinned: boolean): HTMLElement {
  const deps = [s.messages[conv.gid], s.history[conv.gid], conv, acc, s.prefs, s.hideInboundTr, s.tsimStatus];
  const sameInputs = !!messagePaneCache && deps.every((value, i) => value === messagePaneCache!.deps[i]);
  const scope = historyScopeKey(acc?.context ?? null, conv.gid);
  const msgs = sameInputs ? messagePaneCache!.msgs : visibleMessages(s.messages[conv.gid] ?? []);
  const view = s.messageView?.scope === scope ? s.messageView : undefined;
  // The window is planned on every render (cheap: the layout is cached) so the model always describes the
  // mounted pane; the rows are rebuilt only when the inputs or the window itself changed, not on every
  // persisted `{top, anchor}` of the same window.
  const win = messagePaneModel.plan({ scope, list: msgs, view, pinned, anchor: liveAnchor ?? view?.anchor ?? null });
  if (sameInputs && sameWindow(win, messagePaneCache!.win)) {
    messagePaneCache!.node.dataset['scrollBottom'] = pinned ? '1' : '0';
    return messagePaneCache!.node;
  }
  const spacer = (kind: 'top' | 'bottom', height: number): HTMLElement => h('div', { class: 'msgs-spacer', 'aria-hidden': 'true', dataset: { msgSpacer: kind }, style: { height: `${height}px`, flex: 'none' } });
  const node = h('div', { class: 'msgs', dataset: { keepScroll: 'msgs', scrollBottom: pinned ? '1' : '0', thread: conv.gid, historyScope: scope, readContextRevision: s.history[conv.gid]?.readContextRevision ?? '' } },
      s.history[conv.gid]?.firstPage === 'loading' ? h('div', { class: 'history-more', role: 'status' }, '正在读取聊天记录…') : null,
      s.history[conv.gid]?.firstPage === 'error' ? h('button', { class: 'history-more', onclick: () => void openConversation(conv.gid) }, '聊天记录读取失败或超时，点击重试') : null,
      s.history[conv.gid]?.hasMore ? h('button', { class: 'history-more', disabled: s.history[conv.gid]?.busy, onclick: () => void loadEarlier(conv) }, s.history[conv.gid]?.busy ? '加载中…' : s.history[conv.gid]?.pageError ? '历史记录读取失败或超时，点击重试' : '加载更早消息') : null,
      win.range.start > 0 ? spacer('top', win.topSpacer) : null,
      msgs.slice(win.range.start, win.range.end).map((m) => messageRow(s, m, conv, acc)),
      win.range.end < msgs.length ? spacer('bottom', win.bottomSpacer) : null);
  messagePaneCache = { deps, msgs, win, node };
  return node;
}

function chatPane(s: MainState): HTMLElement {
  const conv = activeConv(s);
  const acc = activeAccount(s);
  if (!conv) return h('div', { class: 'chat-empty' }, icon(IC.chat, 40), h('div', null, t('chat.empty')));
  const previousScroll = document.querySelector<HTMLElement>('[data-keep-scroll="msgs"]');
  const scope = historyScopeKey(acc?.context ?? null, conv.gid);
  // A pane rebuilt for a scope with a stored reading anchor resumes there instead of jumping to the bottom.
  const pinned = previousScroll?.dataset['historyScope'] === scope ? previousScroll.scrollHeight - previousScroll.clientHeight - previousScroll.scrollTop < PIN_THRESHOLD : !(s.messageView?.scope === scope && s.messageView.anchor);
  const waiting = conv.waiting_since_ms !== null && !isDone(conv);
  const sub = [conv.vendor_name, isDone(conv) ? t('chat.finished') : waiting ? t('chat.waiting', { t: formatDuration(waitedSeconds(conv, s.now)) }) : ''].filter(Boolean).join(' · ');
  const type = /^[A-Za-z][A-Za-z0-9]{0,5}$/.test(conv.service_type) ? `${conv.service_type} · ${conv.biz}` : conv.biz;
  return h(
    'div',
    { class: 'chat' },
    h(
      'div',
      { class: 'chat-h' },
      h('div', { class: 'ava sm', style: { background: conv.color } }, renderMessageAvatar(document, conv.title, conv.customer_avatar)),
      h('div', { class: 'chat-title' }, h('div', { class: 'chat-name' }, conv.title, conv.lang !== 'zh' ? h('span', { class: 'chip chip-lang' }, t('chat.lang', { lang: langName(conv.lang) })) : null, h('span', { class: 'chip chip-biz' }, type)), sub ? h('div', { class: 'chat-sub', dataset: { chatWaitingGid: conv.gid } }, sub) : null),
      h('button', { class: 'ibtn', 'aria-label': t('chat.transfer'), disabled: isDone(conv), dataset: { chatAct: 'transfer', fid: 'chat-act:transfer' } , onclick: () => openPeripheral('transfer') }, icon(IC.swap, 17)),
      h('button', { class: 'ibtn', 'aria-label': t('chat.invite'), disabled: isDone(conv), dataset: { chatAct: 'invite', fid: 'chat-act:invite' } , onclick: () => openPeripheral('invite') }, icon(IC.userPlus, 17)),
      h('button', { class: 'btn sm', disabled: isDone(conv), dataset: { chatAct: 'end', fid: 'chat-act:end' } , onclick: () => openPeripheral('finish') }, icon(IC.exit, 14), t('chat.end')),
      h('button', { class: 'ibtn', 'aria-label': '会话成员', title: '会话成员', dataset: { chatAct: 'members', fid: 'chat-act:members' } , onclick: () => openPeripheral('members') }, icon(IC.userPlus, 17)),
      h('button', { class: cx('ibtn', { on: s.sideOpen }), title: t('chat.side'), 'aria-label': t('chat.toggleSide'), dataset: { chatAct: 'side', fid: 'chat-act:side' } , onclick: () => store.patch({ sideOpen: !S().sideOpen }) }, icon(IC.sidebar, 17)),
    ),
    netView(s.net).offline ? h('div', { class: 'netbar', style: { margin: '8px 16px 0' } }, t('chat.offlineNotice')) : null,
    h('div', { dataset: { featureSlot: 'conversation-banner' } }),
    messagePane(s, conv, acc, pinned),
    h('div', { dataset: { featureSlot: 'composer-hint' } }),
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
            h('div', { style: { display: 'flex', 'flex-direction': 'column', 'align-items': 'flex-end', gap: '6px' } }, h('span', { class: 'muted', dataset: { relativeTime: String(n.time_ms) }, style: { 'font-size': '12px' } }, formatRelativeTime(n.time_ms, s.now)), h('button', { class: 'link', onclick: () => void openNotice(n) }, t('notice.open'), ' ', icon(IC.external, 11))),
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
    h('button', { class: 'link sb-diagnostics', disabled: !hasAccount, dataset: { action: 'unknown-outbound' }, onclick: openUnknownOutbound }, '未知发送核验'),
    h('button', { class: 'link sb-diagnostics', dataset: { action: 'receive-diagnostics' }, onclick: () => void receiveDiagnostics.open() }, '接收诊断'),
    h('span', { class: 'sp' }),
    sel.mock ? h('span', { class: 'sb-item muted' }, t('app.mockMode')) : null,
    s.clockTrusted ? null : h('span', { class: 'sb-item sb-warn', title: t('bar.clockUntrustedTitle'), dataset: { sb: 'clock-untrusted' } }, icon(IC.alert, 13), t('bar.clockUntrusted')),
    clockEl,
  );
}

/** Metadata and one manually requested latest page only; no journal settlement or send actions. */
function unknownOutboundDialog(s: MainState): HTMLElement | null {
  const view = s.unknownOutbound;
  if (!view || !stillActive(view.scope)) return null;
  return h('div', { class: 'shade', onclick: () => unknownOutbound.close() },
    h('div', { class: 'dlg peripheral-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'unknown-outbound-title', tabindex: '-1', dataset: { unknownOutbound: '1' }, onclick: (e: Event) => e.stopPropagation() },
      h('div', { class: 'dlg-h' }, h('span', { id: 'unknown-outbound-title' }, '未知发送只读核验'), h('button', { class: 'ibtn', 'aria-label': '关闭未知发送核验', onclick: () => unknownOutbound.close() }, icon(IC.close, 16))),
      h('div', { class: 'peripheral-body' },
        h('p', null, '仅查询当前账号的操作元数据。上传阶段不代表消息已发送，也不能查询消息页；消息提交阶段可选择后读取当前最新页。不会重发、清除账本或标记客户消息已读。'),
        view.notice ? h('p', { class: 'notice-box', role: 'status' }, view.notice) : null,
        view.busy ? h('p', { role: 'status' }, '正在只读查询…') : null,
        !view.busy && !view.records.length ? h('p', null, '当前没有可显示的未知发送记录。') : null,
        h('div', { class: 'peripheral-list', role: 'radiogroup', 'aria-label': '未知发送记录' }, view.records.map((row) => h('label', { class: 'peripheral-member' },
          h('input', { type: 'radio', name: 'unknown-outbound-record', checked: view.selected?.gid === row.gid && view.selected?.local_id === row.local_id, disabled: view.busy || !row.write_started, onchange: () => unknownOutbound.select(row.gid, row.local_id) }),
          h('span', null, h('b', null, `本地ID：${row.local_id}`), h('span', { class: 'peripheral-id' }, `会话：${row.gid}`), h('span', { class: 'peripheral-id' }, `${formatDate(row.created_at_ms)} ${formatClock(row.created_at_ms, true)} · 创建代次 ${row.creation_generation} · ${row.write_started ? row.phase === 'write_started' ? '消息提交已开始，结果未知' : '消息提交结果未知' : row.phase === 'uploaded' ? '附件已上传，消息尚未提交' : '附件上传已开始，上传结果待核对；消息尚未提交'}`))))),
        view.result ? h('div', { class: 'notice-box', role: 'status' }, view.result.message, view.result.server_id ? h('div', { class: 'mono' }, `服务端消息ID：${view.result.server_id}`) : null) : null),
      h('div', { class: 'dlg-f' },
        h('button', { class: 'btn', disabled: view.busy, onclick: () => void unknownOutbound.refresh() }, '只读刷新列表'),
        h('button', { class: 'btn pri', disabled: view.busy || !view.selected || !view.records.some(row => row.gid === view.selected?.gid && row.local_id === view.selected?.local_id && row.write_started), onclick: () => void unknownOutbound.verify() }, '读取所选会话最新页'),
        h('button', { class: 'btn', onclick: () => unknownOutbound.close() }, '关闭'))));
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
        snapshot ? h('pre', { class: 'receive-diagnostics-json', tabindex: '0', 'aria-label': '不含身份或消息正文的接收诊断JSON' }, receiveDiagnosticsJson(snapshot)) : null,
        h('p', { class: 'muted' }, `滚动诊断：${historyDiagnostics.active() ? '记录中' : '已停止'}。仅在本机内存保留行数、匹配数量与位置，不记录消息正文或身份。`),
        h('button', { class: 'btn', dataset: { historyDiagnostic: 'start' }, onclick: () => { historyDiagnostics.start(); store.patch({}); } }, '开始滚动诊断'),
        h('button', { class: 'btn', dataset: { historyDiagnostic: 'stop' }, onclick: () => { historyDiagnostics.stop(); store.patch({}); } }, '停止滚动诊断'),
        h('button', { class: 'btn', dataset: { historyDiagnostic: 'clear' }, onclick: () => { historyDiagnostics.clear(); store.patch({}); } }, '清空滚动诊断'),
        h('button', { class: 'btn', dataset: { historyDiagnostic: 'copy' }, onclick: () => copyText(JSON.stringify(historyDiagnostics.snapshot(), null, 2)) }, '复制滚动诊断'),
        h('pre', { class: 'receive-diagnostics-json', tabindex: '0', 'aria-label': '不含身份或正文的滚动诊断JSON' }, JSON.stringify(historyDiagnostics.snapshot(), null, 2))),
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

/** Current-generation dialogs; writes are fenced by the controller before IPC. */
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
    unknownOutboundDialog(s),
    bannerStack(s),
    s.toast ? h('div', { class: 'toast', role: 'status' }, s.toast) : null,
  );
}

// --------------------------------------------------------------- wiring

const visibleReads = createVisibleRead({
  current: () => {
    const s = S(), conversation = activeConv(s);
    return { account: activeAccount(s)?.context ?? null, conversation,
      messages: conversation ? s.messages[conversation.gid] ?? [] : [],
      firstPage: conversation ? s.history[conversation.gid]?.firstPage : undefined,
      readContextRevision: conversation ? s.history[conversation.gid]?.readContextRevision : undefined,
      view: s.view, blocked: !!(s.logoutDialog || s.peripheral || s.receiveDiagnostics || s.unknownOutbound) };
  },
  pane: () => root.querySelector<HTMLElement>('[data-keep-scroll="msgs"]'),
  visible: () => document.visibilityState === 'visible' && document.hasFocus(),
  invoke: args => ipc.invoke(UiCommands.IM_MARK_READ, args),
});

// ---- drafts per (account, conversation) (I-09)
// The state map is per account generation and is reset on every account switch; the book remembers each
// persistent account's drafts (and, once the host registers draft commands, stores them via core-store).
const draftCommands: Readonly<Record<string, string | undefined>> = UiCommands;
const draftLoad = draftCommands['DRAFT_LOAD'], draftSave = draftCommands['DRAFT_SAVE'];
const draftBook = createDraftBook(draftLoad && draftSave
  ? createIpcDraftPort((command, payload) => ipc.invoke(command, payload), { load: draftLoad, save: draftSave }, owner => S().accounts?.accounts.find(a => a.context.account_id === owner.account_id && a.context.environment === owner.environment)?.context ?? null)
  : null);
async function restoreDrafts(context: AccountContext): Promise<void> {
  const stored = await draftBook.restore(context);
  if (!stillActive(context)) return;
  const s = S();
  const drafts = { ...s.drafts };
  let changed = false;
  for (const [gid, text] of Object.entries(stored)) if (drafts[gid] === undefined) { drafts[gid] = text; changed = true; }
  if (!changed) return;
  const active = s.activeGid;
  // Never overwrite what the agent has typed since the account became active.
  const fill = !!active && s.draft === '' && s.drafts[active] === undefined && drafts[active] !== undefined;
  store.patch({ drafts, ...(fill ? { draft: drafts[active]!, draftVersion: s.draftVersion + 1 } : {}) });
}
store.subscribe((s, prev) => {
  const a = activeAccount(s)?.context ?? null, b = activeAccount(prev)?.context ?? null;
  if (!a) return;
  if (!b || !sameAccount(a, b) || a.session_generation !== b.session_generation) { void restoreDrafts(a); return; }
  if (s.drafts === prev.drafts) return;
  for (const [gid, text] of Object.entries(s.drafts)) if (prev.drafts[gid] !== text) draftBook.write(a, gid, text);
  for (const gid of Object.keys(prev.drafts)) if (!(gid in s.drafts)) draftBook.write(a, gid, '');
});
window.addEventListener('pagehide', () => void draftBook.flush());
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') void draftBook.flush(); });

function syncConversationViewport(): void {
  const pane = root?.querySelector<HTMLElement>('[data-list-scope]');
  const scope = pane?.dataset['listScope'];
  if (!pane || !scope || pane.clientHeight <= 0) return;
  const current = S().listWindow;
  if (current?.scope !== scope || current.height !== pane.clientHeight) {
    store.patch({ listWindow: { scope, top: pane.scrollTop, height: pane.clientHeight } });
  }
}

function fillHistoryViewport(): void {
  const pane = root?.querySelector<HTMLElement>('[data-keep-scroll="msgs"]');
  const conv = activeConv(S());
  if (pane && conv && pane.clientHeight > 0 && pane.scrollHeight <= pane.clientHeight + 1 && !S().history[conv.gid]?.pageError) void loadEarlier(conv);
}

// Feature plug-ins (plan I-23/I-30): the only wiring main.ts owns is this block, the two slot calls in
// chatPane and the fact listener below. Features reach the window solely through `FeatureContext`.
let featureClock: { readonly serverMs: number; readonly perfMs: number } | null = null;
const featureConfirm = new ConfirmController();
mountConfirmDialog(featureConfirm, document.body);
const featureRuntime = createMainFeatureRuntime({
  t: (key, vars) => (hasKey(key) ? t(key, vars) : null),
  nowMs: () => Date.now(),
  serverNowMs: () => (featureClock ? featureClock.serverMs + (performance.now() - featureClock.perfMs) : null),
  scope: () => {
    const acc = activeAccount();
    return acc?.state === 'online' ? { account: acc.context, gid: S().activeGid } : null;
  },
  isCurrent: (account) => stillActive(account),
  messages: (gid) => S().messages[gid] ?? [],
  draft: () => ({ gid: S().activeGid, text: S().draft, version: S().draftVersion }),
  invoke: (command, payload) => ipc.invoke(command, payload),
  confirm: (request) => featureConfirm.request(request),
  toast,
  requestRender: () => store.patch({}),
  subscribe: (listener) => subscribeBatched(store, () => listener()),
  visible: () => document.visibilityState === 'visible',
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
});
featureRuntime.start();
/** Slots are empty placeholders in `render` (it is a full re-render); features paint into them right after each render. */
const fillFeatureSlots = (): void => {
  for (const el of root.querySelectorAll<HTMLElement>('[data-feature-slot]')) {
    const name = el.dataset['featureSlot'];
    if (name !== 'conversation-banner' && name !== 'composer-hint') continue;
    el.replaceChildren();
    appendChildren(el, featureRuntime.renderSlot(name));
  }
};

subscribeFrame(store, (s) => {
  if (composerInput.deferRender()) return;
  withMessageAnchor(s, () => rerender(root, () => {
  const next = render({ ...s, now: Date.now() });
  // Keep the actual video node so waiting timers and live updates do not restart playback.
  if (next instanceof Element) {
    for (const video of next.querySelectorAll<HTMLVideoElement>('video[data-media-key]')) {
      const key = video.dataset['mediaKey'];
      if (!key) continue;
      const current = root.querySelector<HTMLVideoElement>(`video[data-media-key="${CSS.escape(key)}"]`);
      if (current && current.getAttribute('src') === video.getAttribute('src')) video.replaceWith(current);
    }
  }
  return next;
  }));
  visibleReads.afterRender();
  fillHistoryViewport();
  syncConversationViewport();
});
rerender(root, () => render(S()));
// Registered after the render subscriber (same frame, later callback), outside the render wiring itself.
fillFeatureSlots();
subscribeFrame(store, () => fillFeatureSlots());
// Scrolling into view and returning focus must re-check the live scope and mounted rows.
root.addEventListener('scroll', (event) => {
  visibleReads.afterRender();
  const pane = event.target as HTMLElement;
  if (pane.isConnected && pane.dataset?.['keepScroll'] === 'msgs') onMessageScroll(pane);
  if (!pane.isConnected || pane.dataset?.['keepScroll'] !== 'msgs' || pane.scrollTop > 120) return;
  const s = S(), conv = activeConv(s);
  if (conv && pane.dataset['historyScope'] === historyScopeKey(activeAccount(s)?.context ?? null, conv.gid) && !s.history[conv.gid]?.pageError) void loadEarlier(conv);
}, true);
window.addEventListener('resize', syncConversationViewport);
if (typeof ResizeObserver !== 'undefined') new ResizeObserver(syncConversationViewport).observe(root);
window.addEventListener('focus', () => visibleReads.afterRender());
document.addEventListener('visibilitychange', () => visibleReads.afterRender());

document.addEventListener('mousedown', () => {
  const s = S();
  if (s.ctxMenu || s.meMenu || s.emoOpen) store.patch({ ctxMenu: null, meMenu: false, emoOpen: false });
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Tab' && (S().peripheral || S().receiveDiagnostics || S().unknownOutbound)) {
    const dialog = document.querySelector<HTMLElement>(S().unknownOutbound ? '[data-unknown-outbound]' : S().receiveDiagnostics ? '[data-receive-diagnostics]' : '[data-peripheral-dialog]');
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
    if (S().unknownOutbound) unknownOutbound.close();
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
ipc.listen<unknown>(Events.IM_CONVERSATIONS_INVALIDATED, receiveConversationInvalidation);
ipc.listen<unknown>(UiEvents.MEDIA_SEND_PROGRESS, receiveMediaProgress);
ipc.listen<unknown>(UiEvents.TSIM_STATUS, receivePackageIdentity);
subscribeBatched(store, () => autoQueryPackage());
ipc.listen<unknown>(HostEvents.LOCATE, guarded(HostEvents.LOCATE, isLocatePayload, (p) => void locateConversation(p.account, p.gid)));
ipc.listen<unknown>(Events.PREFS_CHANGED, guarded(Events.PREFS_CHANGED, isPrefsSnapshot, (p) => store.patch({ prefs: p })));
ipc.listen<unknown>(Events.NET_CLOCK, guarded(Events.NET_CLOCK, isClockReading, (c) => store.patch({ clockTrusted: c.quality.kind === 'anchored' })));
// Anchored server time for feature windows (recall); anything but `anchored` clears it.
ipc.listen<unknown>(Events.NET_CLOCK, guarded(Events.NET_CLOCK, isClockReading, (c) => { featureClock = c.quality.kind === 'anchored' ? { serverMs: c.server_now_ms, perfMs: performance.now() } : null; }));
ipc.listen<unknown>(FeatureEvents.FACT, (fact) => featureRuntime.onFact(fact));
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
  if (document.visibilityState !== 'visible') return;
  const s = S(), now = Date.now();
  // Dialog expiry affects actions, so it still gets a state update.
  if (s.peripheral) { store.patch({ now }); return; }
  const byGid = new Map(s.conversations.map(c => [c.gid, c]));
  for (const el of root.querySelectorAll<HTMLElement>('[data-relative-time]')) {
    const time = Number(el.dataset['relativeTime']);
    el.textContent = time ? formatRelativeTime(time, now) : '';
  }
  for (const el of root.querySelectorAll<HTMLElement>('[data-waiting-gid]')) {
    const c = byGid.get(el.dataset['waitingGid'] ?? '');
    if (!c) continue;
    const waited = waitedSeconds(c, now);
    el.className = cx('wait', waited >= RED_AFTER_SECONDS ? 'red' : 'amber');
    el.replaceChildren(icon(IC.clock, 11), document.createTextNode(c.waiting_confirmed ? t('list.waiting', { t: formatDuration(waited) }) : `${t('list.waiting', { t: formatDuration(waited) })} · ${t('list.waitingPending')}`));
  }
  for (const el of root.querySelectorAll<HTMLElement>('[data-chat-waiting-gid]')) {
    const c = byGid.get(el.dataset['chatWaitingGid'] ?? '');
    if (c) el.textContent = [c.vendor_name, isDone(c) ? t('chat.finished') : c.waiting_since_ms !== null ? t('chat.waiting', { t: formatDuration(waitedSeconds(c, now)) }) : ''].filter(Boolean).join(' · ');
  }
}, 5000);

void (async () => {
  await Promise.all([loadAccounts(), loadPrefs(), loadNet()]);
  await refreshPackageIdentity();
  // Alarm counts arrive only through `Events.ALARM_SNAPSHOT`: notify commands are reserved for the alarm window (strong-alert §6).
  await loadForActiveAccount();
})();

exposeForTests(sel, { __vbkStore: store, __vbkOpenConversation: openConversation, __vbkSoundLog: soundLog });
