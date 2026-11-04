import { readMessageReadStatusEvent, applyMessageReadStatuses } from './message-read-status.ts';
import { createContextMenu } from '../../packages/ui-kit/src/context-menu.ts';
import { createForwardDialog, createSavedEmojiPanel, type MessageToolOptions } from './message-tools.ts';
import { createMessageContextMenu, type MessageMenuAction } from './message-context-menu.ts';
import { createWorkspaceColumns } from './workspace-columns.ts';
import { browserStage, createBrowserTabs, webTabView } from './browser-tabs.ts';
import { voiceBubble } from './voice-bubble.ts';
import { voicePlayerOf } from './features/voice-player.ts';
import { createAccountNavigation } from './account-navigation.ts';
import { bannerKey, loadIgnored, saveIgnored, splitCategories, toggleIgnored, withBannerCategory } from './notice-ignore.ts';
import { createNoticeQuery, EMPTY_NOTICE_QUERY, type NoticeQueryState } from './notice-query.ts';
import { createQuickReplies, quickRepliesView, type QuickRepliesState, type ReplyContext } from './quick-replies.ts';
import { createRecommendPanel, recommendView, type RecommendState } from './recommend-panel.ts';
import { companionPackageCard } from './companion-card.ts';
import { createOperatorOverlay, operatorGrant } from './operator-overlay.ts';
import { historyDiagnostics } from './history-diagnostics.ts';
import { createVisibleRead } from './visible-read.ts';
import { readHistoryPage } from './history-read.ts';
import { createInboundTranslation } from './inbound-translation.ts';
import { personDisplayName } from './person-name.ts';
import { createHistoryLayoutFrames, startHistoryLayout } from './history-layout.ts';
import { createMessagePane, historyPrefetchDistance, HISTORY_RUNWAY, PIN_THRESHOLD } from './message-pane.ts';
import { createDraftBook, createIpcDraftPort } from './draft-book.ts';
import type { MeasuredPane, PaneGeometry, PaneWindow } from './message-pane.ts';
import { sameWindow } from './message-pane.ts';
import type { MessageAnchor } from './message-window.ts';
import { createComposerInput } from './composer-input.ts';
import { createMainFeatureRuntime, FEATURES } from './features/registry.ts';
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
 * re-rendered on change, once per animation frame, by an incremental
 * `rerender(..., { morph: true })`: mounted nodes (scroll containers, rows,
 * media) stay in the document, so focus/caret/scroll and in-flight scrolling survive.
 */

import { applyPlatform } from '../_shared/platform.ts';
const platform = applyPlatform();

import type { AccountContext, SendDisposition } from '../../packages/ipc/src/contracts.ts';
import { isAppError } from '../../packages/ipc/src/contracts.ts';
import { AccountCommands, Events, ImCommands, NotifyCommands, PrefsCommands, WindowLabels } from '../../packages/ipc/src/commands.ts';
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
  UiOrderSummary,
  UiPackageInfo,
  UiAttachment,
  UiBrowserTab,
  UiMediaSendResult,
  UiMediaSendProgress,
  UiInviteAgent,
  UiMemberRole,
} from '../../packages/ipc/src/client.ts';
import { UiCommands, UiEvents } from '../../packages/ipc/src/client.ts';
import { MOCK_ORDER_SAMPLES } from '../_shared/mock-loader.ts';
import { h, icon, rerender, cx } from '../../packages/ui-kit/src/h.ts';
import { createStore, subscribeBatched, subscribeFrame } from '../../packages/ui-kit/src/store.ts';
import { hasKey, t } from '../../packages/ui-kit/src/i18n.ts';
import { badgeText, formatClock, formatDate, formatDuration, formatRelativeTime, formatStopwatch } from '../../packages/ui-kit/src/format.ts';
import { IC } from '../_shared/icons.ts';
import { exposeForTests, selectIpc } from '../_shared/ipc.ts';
import {
  guarded,
  isAlarmSnapshot,
  isAttemptResult,
  isBannerPayload,
  isClockReading,
  isLocatePayload,
  isNoticeCategoryPayload,
  isPrefsSnapshot,
  isSoundName,
  isToastPayload,
  isUiAccountSnapshot,
  isUiAgentStatus,
  isUiAgentStatusEvent,
  isUiConversation,
  isUiMessage,
  isUiNetStatus,
  messageAccount,
} from '../_shared/guards.ts';
import type { SoundName } from '../_shared/guards.ts';
import { playSound, stopSound } from './sound.ts';
import { createMemberPreload } from './member-preload.ts';
import { memberPills, memberScanGids } from './member-pills.ts';
import { createPeripheralPanel, filteredInviteAgents, type PeripheralKind, type PeripheralPanelState } from './peripheralPanel.ts';
import { settleAccountSend } from './sendScope.ts';
import { messageAlignment } from './message-alignment.ts';
import { mergeMessageProfile, renderMessageAvatar } from './message-profile.ts';
import { createUnknownOutbound, type UnknownOutboundView } from './unknown-outbound.ts';
import { createReceiveCounters, createReceiveDiagnostics, receiveDiagnosticsJson, type ReceiveDiagnosticsView } from './receive-diagnostics.ts';
import { sendComposer, attachmentSendUnavailable, isRegisteredMediaAttachment, ATTACHMENT_SEND_UNAVAILABLE } from './sendComposer.ts';
import { createTsimOrderOpener, orderInfoSection } from './order-info.ts';
import { createPackagePreview, EMPTY_PACKAGE_PREVIEW, packageIdentity, packageOrderId, packageViewApplies, type PackageContext, type PackagePreviewState } from './package-preview.ts';
import {
  AGENT_STATUS_ORDER,
  BANNER_VISIBLE,
  MARK_COLORS,
  TRANSLATION_IDLE,
  accountLabel,
  agentStatusColorVar,
  mergeAgentStatus,
  type AgentDisplayStatus,
  agentStatusDesc,
  agentStatusLabel,
  agentView,
  alarmActiveCount,
  longestWaitingAlarm,
  waitTier,
  canContactOrder,
  contextMenuCommand,
  contextMenuItems,
  errorMessage,
  expireBanners,
  filterConversations,
  virtualConversationRange,
  conversationWindowStale,
  latestPreview,
  EMPTY_MESSAGES,
  findIccids,
  highlightParts,
  isDone,
  isValidOrderId,
  langName,
  logoutCommand,
  netView,
  nextLocalId,
  orderContactReduce,
  persistFailed,
  persistFailedView,
  sendFailureDisposition,
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
  visibleSendState,
  orderCardView,
  shouldShowTranslationBar,
  composerLocked,
  customerLanguage,
  needsOutboundTranslation,
  outboundTarget,
  OUTBOUND_TARGETS,
  tabCounts,
  unreadTotal,
  viewingGid,
} from './viewmodel.ts';
import type { BannerItem, BusinessTab, ListTab, LogoutMode, OrderContactState, TranslationState, QuotedUiMessage } from './viewmodel.ts';

/** Host events not (yet) listed in the frozen `Events` / `UiEvents` tables; names mirror `src-tauri/src/events.rs`. */
const HostEvents = {
  LOCATE: 'im://locate-conversation',
  NOTICE_NEW: 'notice://new',
  NOTICE_LOCATE_CATEGORY: 'notice://locate-category',
  BANNER: 'notify://banner',
  PLAY_SOUND: 'notify://play-sound',
  STOP_SOUND: 'notify://stop-sound',
} as const;

const workspaceColumns = createWorkspaceColumns();

const EMOJI = ['😀', '😊', '😂', '🙏', '👍', '👌', '👏', '🎉', '❤️', '😅', '🤔', '😢', '🌹', '☀️', '✈️', '🏨', '🎫', '🚌', '📍', '⏰', '✅', '❗', '💡', '🙂'];
const TR_TARGETS = OUTBOUND_TARGETS;

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
  readonly navigationOperation?: object;
  readonly accounts: UiAccountSnapshot | null;
  readonly accountsError: string | null;
  readonly loginAttempt: string | null;
  readonly view: View;
  readonly agent: AgentDisplayStatus;
  readonly agentOperation: object | null;
  readonly agentBusy: boolean;
  /** null until the host has reported the network state. */
  readonly net: UiNetStatus | null;
  readonly clockTrusted: boolean;
  readonly alarmCount: number;
  /** Longest-waiting active alarm entry: where the top-right alarm button jumps. */
  readonly alarmTarget: { readonly account: AccountContext; readonly gid: string } | null;
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
  /** Bumped when a row's platform translation state changes (the state itself lives in the controller). */
  readonly inboundTrRevision: number;
  /** Bumped when the member cache changes: makes a render frame non-scroll so pills re-read the cache. */
  readonly memberCacheRevision: number;
  readonly trBarOff: boolean;
  readonly composerMore: boolean;
  readonly webTabs: readonly UiBrowserTab[];
  readonly activeWeb: string | null;
  readonly fileDrag: boolean;
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
  readonly noticeCats: NoticeQueryState['noticeCats'];
  readonly noticeCat: NoticeQueryState['noticeCat'];
  readonly notices: NoticeQueryState['notices'];
  readonly noticeCatsStatus: NoticeQueryState['noticeCatsStatus'];
  readonly noticeListStatus: NoticeQueryState['noticeListStatus'];
  readonly noticeCatsError: string | null;
  readonly noticeListError: string | null;
  readonly noticeMoreStatus: NoticeQueryState['noticeMoreStatus'];
  readonly noticeMoreError: string | null;
  readonly noticeHasMore: boolean;
  readonly noticeBeforeMs: number | null;
  /** 本机忽略的通知分类，按账号（环境:账号 ID）缓存；未缓存时从本地存储读取。 */
  readonly noticeIgnored: Readonly<Record<string, readonly string[]>>;
  readonly noticeIgnoredOpen: boolean;
  // order contact
  readonly orderQuery: string;
  readonly order: OrderContactState;
  readonly orderBusyId: string | null;
  // overlays
  readonly peripheral: PeripheralPanelState | null;
  readonly quickReplies: QuickRepliesState | null;
  readonly recommendations: RecommendState | null;
  readonly receiveDiagnostics: ReceiveDiagnosticsView | null;
  readonly unknownOutbound: UnknownOutboundView | null;
  readonly scriptsQuery: string;
  readonly inviteQuery: string;
  readonly meMenu: false | 'status';
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
  alarmTarget: null,
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
  inboundTrRevision: 0,
  memberCacheRevision: 0,
  trBarOff: false,
  composerMore: false,
  webTabs: [],
  activeWeb: null,
  fileDrag: false,
  emoOpen: false,
  sideOpen: true,
  hotOrder: false,
  pkgOpen: true,
  pkgHot: false,
  pkg: PKG_IDLE,
  tsimStatus: null,
  packageIdentityRequest: 0,
  ctxMenu: null,
  ...EMPTY_NOTICE_QUERY,
  noticeIgnored: {},
  noticeIgnoredOpen: false,
  orderQuery: '',
  order: { kind: 'idle' },
  orderBusyId: null,
  peripheral: null,
  quickReplies: null,
  recommendations: null,
  receiveDiagnostics: null,
  unknownOutbound: null,
  scriptsQuery: '',
  inviteQuery: '',
  meMenu: false,
  logoutDialog: null,
  editingTab: null,
  banners: [],
  bannerHoverAt: null,
  toast: null,
};

const store = createStore<MainState>(initial);
const messageContextMenu = createMessageContextMenu();
store.subscribe((s, prev) => {
  if (s.accounts !== prev.accounts || s.activeGid !== prev.activeGid || s.view !== prev.view || s.messages !== prev.messages) messageContextMenu.close();
});
window.addEventListener('pagehide', () => messageContextMenu.close());

const sel = selectIpc();
const ipc = sel.ipc;
const conversationContextMenu = createContextMenu('ctx-menu', '会话操作');
const messageToolOptions: MessageToolOptions = {
  current: account => stillActive(account),
  conversations: () => S().conversations,
  invoke: (command, payload) => ipc.invoke(command, payload),
  toast,
  nextLocalId: () => nextLocalId(Date.now()),
  validTarget: (account, gid) => stillActive(account) && !persistFailed(S().accounts) && S().conversations.some(c => c.gid === gid && c.agent_in_group && c.status === 'active'),
  menu: (x, y, actions, container) => messageContextMenu.open(x, y, actions, () => !!container?.isConnected, () => toast('表情操作失败，请重试'), container),
  preview: (account, id) => void invokeSafe(UiCommands.MEDIA_VIEWER_OPEN_EMOJI, { account, id }),
};
const forwardDialog = createForwardDialog(messageToolOptions);
const savedEmojiPanel = createSavedEmojiPanel(messageToolOptions);
store.subscribe((s, previous) => {
  if (s.ctxMenu !== previous.ctxMenu) {
    conversationContextMenu.close();
    if (s.ctxMenu) openConversationContextMenu(s);
  }
  const revision = (value: MainState) => value.conversations.find(c => c.gid === value.activeGid)?.assistant_context_revision;
  if (s.activeGid !== previous.activeGid || s.view !== previous.view || s.accounts !== previous.accounts || revision(s) !== revision(previous)) {
    forwardDialog.close(); savedEmojiPanel.close(); conversationContextMenu.close();
  }
});
// The host suppresses system notifications only for what main actually shows.
let reportedViewing: string | null | undefined = null;
store.subscribe((s) => {
  const gid = viewingGid(s);
  if (gid === reportedViewing) return;
  reportedViewing = gid;
  void ipc.invoke(NotifyCommands.SET_VIEWING, { gid }).catch(() => { reportedViewing = undefined; });
});
window.addEventListener('pagehide', () => { forwardDialog.close(); savedEmojiPanel.close(); conversationContextMenu.close(); });

const accountNavigation = createAccountNavigation({
  switch: (account) => invokeSafe(AccountCommands.SWITCH, { account }),
  snapshot: () => invokeQuiet(AccountCommands.SNAPSHOT),
  valid: isUiAccountSnapshot,
});
const root = document.getElementById('app');
if (!root) throw new Error('#app missing');

const memberPreload = createMemberPreload({
  invoke: (command, payload) => ipc.invoke(command, payload),
  now: Date.now,
  isVisible: () => document.visibilityState === 'visible',
  // Rendering is frame-batched and only peeks, and this field is not a sync trigger below, so there is no loop.
  publish: () => store.patch({ memberCacheRevision: S().memberCacheRevision + 1 }),
});
function syncMemberPreload() {
  const s = S(), acc = activeAccount(s);
  // Other views only pause: no requests go out, and a null context would wipe the cache and its pills.
  memberPreload.sync(acc?.state === 'online' ? {
    account: acc.context,
    gids: memberScanGids(s.conversations, s.activeGid),
    activeGid: s.activeGid,
    paused: !!s.peripheral || s.view !== 'messages',
  } : null);
}
store.subscribe((s, previous) => {
  if (s.accounts !== previous.accounts || s.conversations !== previous.conversations || s.activeGid !== previous.activeGid || s.view !== previous.view || !!s.peripheral !== !!previous.peripheral) syncMemberPreload();
});
document.addEventListener('visibilitychange', syncMemberPreload);
window.addEventListener('pagehide', () => memberPreload.stop());
const inboundTranslation = createInboundTranslation({
  invoke: (command, payload) => ipc.invoke(command, payload),
  now: Date.now,
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  describeError: errorMessage,
  apply: (scope, messageId, translation) => {
    if (!stillActive(scope.account)) return;
    const list = S().messages[scope.gid];
    if (list) store.patch({ messages: { ...S().messages, [scope.gid]: list.map(row => row.message_id === messageId ? { ...row, translation } : row) } });
  },
  changed: () => store.patch({ inboundTrRevision: S().inboundTrRevision + 1 }),
});
function syncInboundTranslation(s: MainState = S()): void {
  const acc = activeAccount(s), gid = s.activeGid;
  // Only the open thread is translated; hidden translations and other views cost nothing.
  if (acc?.state !== 'online' || s.view !== 'messages' || !gid || s.hideInboundTr) { inboundTranslation.sync(null, null); return; }
  inboundTranslation.sync({ key: historyScopeKey(acc.context, gid), account: acc.context, gid }, s.messages[gid] ?? null);
}
store.subscribe((s, previous) => {
  if (s.accounts !== previous.accounts || s.messages !== previous.messages || s.activeGid !== previous.activeGid || s.view !== previous.view || s.hideInboundTr !== previous.hideInboundTr) syncInboundTranslation(s);
});
window.addEventListener('pagehide', () => inboundTranslation.stop());

const peripheral = createPeripheralPanel({
  preload: scope => {
    const members = memberPreload.getMembers(scope), directory = memberPreload.getDirectory(scope);
    if (!members && !directory) return null;
    return {
      ...(members ? { members: { ...members, selection_token: '', expires_at_ms: 0 } } : {}),
      ...(directory ? { candidates: { agents: directory.agents, skill_groups: [], selection_token: '', expires_at_ms: 0 } } : {}),
      updatedAt: directory?.fetched_at_ms ?? members?.fetched_at_ms ?? 0,
    };
  },
  rememberMembers: (scope, members) => memberPreload.observeMembers(scope, members),
  rememberDirectory: (scope, agents) => memberPreload.observeDirectory(scope, agents),
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
  const conv = activeConv();
  if (activeAccount() && conv) {
    if (kind !== 'scripts' && isDone(conv)) {
      peripheral.close();
      toast('会话已结束，无法管理成员');
      return;
    }
    if (kind === 'scripts') { peripheral.close(); recommendations.close(); void quickReplies.open(); return; }
    quickReplies.close(); recommendations.close();
    if (kind === 'invite') store.patch({ inviteQuery: '' });
    void peripheral.open(kind);
  }
}

function replyContext(): ReplyContext | null {
  const s = S(), account = activeAccount(s), conv = activeConv(s);
  if (s.view !== 'messages' || account?.state !== 'online' || !conv || composerLocked(conv) || !sameAccount(account.context, conv.account) || account.context.session_generation !== conv.account.session_generation) return null;
  return { account: { ...account.context }, gid: conv.gid, revision: `${conv.assistant_context_revision ?? ''}:${conv.status}`, draft: s.draft, version: s.draftVersion };
}
function productCanSend(): boolean {
  const s = S(), conv = activeConv(s);
  return !!replyContext() && !!conv && conv.status === 'active' && !persistFailed(s.accounts);
}
function focusComposer(): void { requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('textarea[data-fid="draft"]')?.focus()); }
const quickReplies = createQuickReplies({
  current: replyContext, invoke: (command, payload) => ipc.invoke(command, payload),
  publish: (quickReplies) => { const opening = quickReplies?.mode === 'categories' && S().quickReplies?.mode !== 'categories'; store.patch({ quickReplies }); if (opening) requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-commerce-dialog="replies"]')?.focus()); },
  insert: (text, replace) => { if (!replyContext() || composerInput.active()) return; const draft = S().draft; setDraft(replace ? text : draft + (draft && !draft.endsWith('\n') ? '\n' : '') + text); focusComposer(); },
  setTimer: (callback, ms) => setTimeout(callback, ms), clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
});
const recommendations = createRecommendPanel({
  current: replyContext, canSend: productCanSend, invoke: (command, payload) => ipc.invoke(command, payload), now: Date.now,
  publish: (recommendations) => { const opening = recommendations !== null && S().recommendations === null; store.patch({ recommendations }); if (opening) requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-commerce-dialog="recommend"]')?.focus()); },
  refresh: async (scope) => {
    const page = await readHistoryPage(ipc.invoke<UiMessagePage>(UiCommands.IM_MESSAGE_PAGE, { account: scope.account, gid: scope.gid }));
    if (!page || !stillActive(scope.account) || S().activeGid !== scope.gid || replyContext()?.revision !== scope.revision) return;
    store.patch({ messages: { ...S().messages, [scope.gid]: mergeHistory(page.items.filter(isUiMessage), S().messages[scope.gid] ?? []) } });
  },
});
function closeCommerce(): void { quickReplies.close(); recommendations.close(); }
function openRecommendations(): void { peripheral.close(); quickReplies.close(); void recommendations.open(); }

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
  ...EMPTY_NOTICE_QUERY,
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
  void noticeQuery.categories();
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
    const [convs, agent, net] = await Promise.all([
      invokeQuiet<UiConversation[]>(UiCommands.IM_CONVERSATIONS, { account }),
      invokeQuiet<unknown>(UiCommands.ACCOUNT_AGENT_STATUS, { account }),
      invokeQuiet<unknown>(UiCommands.NET_STATUS, {}),
    ]);
    if (ticket !== accountLoadTicket || !stillActive(account)) return;
    const s = S();
    const snapshot = Array.isArray(convs) ? convs.filter(isUiConversation).filter(belongs) : [];
    const conversations = snapshot.filter(c => !changes.has(c.gid));
    for (const c of changes.values()) if (c) conversations.push(c);
    const lostConversation = !!s.activeGid && !conversations.some(c => c.gid === s.activeGid);
    if (lostConversation && s.attachment) void releaseAttachment(s.attachment);
    store.patch({
      conversations,
      agent: s.agent === agentAtRead && isUiAgentStatus(agent) ? mergeAgentStatus(s.agent, agent) : s.agent,
      net: isUiNetStatus(net) ? noteNet(net) : s.net,
      activeGid: lostConversation ? null : s.activeGid,
      ...(lostConversation ? { attachment: null, attachmentSelection: null, mediaOperation: null } : {}),
    });
    // Opening a conversation can acknowledge unread messages. Background account
    // refresh must wait for an explicit user selection instead of opening row one.
  } finally {
    stop();
    if (ticket === accountLoadTicket) stopAccountLoadObservation = null;
  }
}

async function loadPrefs(): Promise<void> {
  const p = await invokeQuiet<unknown>(PrefsCommands.SNAPSHOT);
  if (isPrefsSnapshot(p)) store.patch({ prefs: p });
}

/** 本进程是否曾观测到已连接；之前的 disconnected/reconnecting 视为冷启动过渡态，不提示断连。 */
let netEverConnected = false;
function noteNet(n: UiNetStatus): UiNetStatus {
  if (n.online && n.transport === 'connected') netEverConnected = true;
  return n;
}

async function loadNet(): Promise<void> {
  const n = await invokeQuiet<unknown>(UiCommands.NET_STATUS, {});
  if (isUiNetStatus(n)) store.patch({ net: noteNet(n) });
}

// --------------------------------------------------------------- accounts

function applyAccountSnapshot(snap: UiAccountSnapshot): void {
  snap = accountNavigation.project(snap);
  const prev = S().accounts?.active_account_id ?? null;
  const nextAccount = snap.accounts.find((a) => a.context.account_id === snap.active_account_id);
  if (nextAccount?.state !== 'online') { closeCommerce(); peripheral.close(); receiveDiagnostics.close(); unknownOutbound.close(); }
  const attempt = S().loginAttempt;
  // The login attempt is over once no account is logging in any more.
  const loginAttempt = attempt && snap.accounts.some((a) => a.state === 'logging_in') ? attempt : null;
  if (snap.active_account_id !== prev || activeAccount()?.context.environment !== nextAccount?.context.environment || activeAccount()?.context.session_generation !== nextAccount?.context.session_generation) {
    if (S().attachment) void releaseAttachment(S().attachment);
    closeCommerce();
    peripheral.close();
    receiveDiagnostics.close();
    unknownOutbound.close();
    noticeQuery.reset();
    store.patch({ accounts: snap, accountsError: null, loginAttempt, ...ACCOUNT_SCOPED_RESET });
    void loadForActiveAccount();
  } else {
    store.patch({ accounts: snap, accountsError: null, loginAttempt });
  }
}

async function switchAccount(a: UiAccount): Promise<void> {
  if (a.state === 'logging_in') return;
  const navigationOperation = {};
  store.patch({ navigationOperation });
  // Staying on this tab also cancels older pending navigation without dropping its conversation or draft.
  if (a.context.account_id === S().accounts?.active_account_id && !accountNavigation.pending()) return;
  const snap = await accountNavigation.select(a.context);
  if (S().navigationOperation === navigationOperation && isUiAccountSnapshot(snap)) applyAccountSnapshot(snap);
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
      if (S().agent === agentAtWrite) store.patch({ agent: mergeAgentStatus(S().agent, r) });
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
async function openConversation(gid: string, reveal = true, refreshContext = true): Promise<void> {
  if (reveal) store.patch({ navigationOperation: {} });
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
    closeCommerce();
    peripheral.close();
    if (s.attachment) void releaseAttachment(s.attachment);
    store.patch({ activeGid: gid, view, banners, draft: s.drafts[gid] ?? s.conversations.find((c) => c.gid === gid)?.draft ?? '', draftVersion: s.draftVersion + 1, quote: null, attachment: null, attachmentSelection: null, mediaOperation: null, translation: TRANSLATION_IDLE, pkg: PKG_IDLE, pkgHot: false, hotOrder: false, ctxMenu: null, emoOpen: false });
  }
  if (S().history[gid]?.firstPage === 'loading' || S().history[gid]?.firstPage === 'loaded') return;
  const request = { hasMore: false, beforeMs: null, busy: true, firstPage: 'loading' as const, readContextRevision };
  store.patch({ history: { ...S().history, [gid]: request } });
  const read = () => readHistoryPage(invokeQuiet<UiMessagePage>(UiCommands.IM_MESSAGE_PAGE, { account: acc.context, gid, ...(readContextRevision ? { expected_context_revision: readContextRevision } : {}) }));
  let page = await read();
  // A first-open RPC can race adapter readiness. Recover once before asking the user.
  if (!page && stillActive(acc.context) && S().history[gid] === request && S().activeGid === gid
    && S().conversations.find(c => c.gid === gid)?.assistant_context_revision === readContextRevision) {
    page = await read();
  }
  if (!stillActive(acc.context) || S().history[gid] !== request) return;
  if (S().conversations.find(c => c.gid === gid)?.assistant_context_revision !== readContextRevision) {
    // Startup can learn the room/service identity while the first page is in flight.
    // Discard that page and read against the new identity once, without another click.
    if (refreshContext && S().activeGid === gid && S().conversations.some(c => c.gid === gid)) {
      await openConversation(gid, false, false);
      return;
    }
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
  const currentNavigation = await navigateToAccount(account);
  if (!currentNavigation) return;
  // A user can leave this account while its list loads, including A → B → A.
  // Never let the old navigation open an identically named room in that visit.
  const currentVisit = noticeQuery.accountGuard();
  const room = () => S().conversations.find((c) => c.gid === gid && sameAccount(c.account, account) && c.account.session_generation === account.session_generation);
  for (let i = 0; i < 50 && currentNavigation() && currentVisit() && !room(); i += 1) await new Promise((r) => setTimeout(r, 40));
  if (!currentNavigation() || !currentVisit() || !room()) return;
  store.patch({ tab: isDone(room()!) ? 'done' : 'doing' });
  if (!currentNavigation() || !currentVisit()) return;
  await openConversation(gid);
}

/** Switches to the target's account; returns the guard of this navigation, or null if it no longer applies. */
async function navigateToAccount(account: AccountContext): Promise<(() => boolean) | null> {
  browserTabs.activate(null);
  const snap = S().accounts;
  const target = snap?.accounts.find((a) => a.context.account_id === account.account_id && a.context.environment === account.environment);
  if (!target || target.context.session_generation !== account.session_generation) return null; // stale generation or unknown account
  const navigationOperation = {};
  store.patch({ navigationOperation });
  const currentNavigation = () => S().navigationOperation === navigationOperation;
  if (snap?.active_account_id !== target.context.account_id || accountNavigation.pending()) {
    const next = await accountNavigation.select(target.context);
    if (!currentNavigation() || !isUiAccountSnapshot(next)) return null;
    applyAccountSnapshot(next);
  }
  return currentNavigation() && stillActive(account) ? currentNavigation : null;
}

/** A click on a notice-center banner: opens that category in the 通知 view. */
async function locateNoticeCategory(account: AccountContext, categoryId: string): Promise<void> {
  const currentNavigation = await navigateToAccount(account);
  if (!currentNavigation) return;
  const currentVisit = noticeQuery.accountGuard();
  store.patch({ view: 'notifications', ctxMenu: null, meMenu: false });
  await noticeQuery.categories(false);
  if (currentNavigation() && currentVisit()) await pickNoticeCat(categoryId);
}

/** A removal invalidates the list; never apply a delayed gid deletion to a newer cache. */
function receiveConversationInvalidation(payload: unknown): void {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return;
  const account = payload as Partial<AccountContext>;
  if (typeof account.account_id !== 'string' || !account.account_id.trim() || typeof account.environment !== 'string' || !account.environment.trim() || !Number.isSafeInteger(account.session_generation) || (account.session_generation ?? -1) < 0) return;
  if (stillActive(account as AccountContext)) void loadForActiveAccount();
}

function receiveMessageReadStatuses(payload: unknown): void {
  const event = readMessageReadStatusEvent(payload, activeAccount()?.context ?? null);
  if (!event) return;
  const previous = S().messages[event.gid];
  if (!previous) return;
  const next = applyMessageReadStatuses(previous, event);
  if (next !== previous) store.patch({ messages: { ...S().messages, [event.gid]: next } });
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
  // 已结束的会话照常发送：适配器在提交前重新开启会话（evidence 49）；只有转出的会话锁定。
  if (!acc || !conv || composerLocked(conv)) return;
  const s = S();
  const localId = nextLocalId(Date.now());
  const quote = selectedQuoteReference(s.quote, s.messages[conv.gid] ?? [], conv.gid);
  const local: QuotedUiMessage = { gid: conv.gid, message_id: null, local_id: localId, create_time_ms: Date.now(), sender_role: 'merchant_self', kind: 'text', text, translation: null, original, quote: quote?.target_id ?? null, quote_target_id: quote?.target_id ?? null, order_id: null, disposition: null };
  store.patch({ messages: { ...s.messages, [conv.gid]: [...(s.messages[conv.gid] ?? []), local] }, drafts: { ...s.drafts, [conv.gid]: '' }, draft: '', draftVersion: s.draftVersion + 1, quote: null, attachment: null, translation: { ...TRANSLATION_IDLE, gid: s.translation.gid, target: s.translation.target } });
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
    // An IPC failure is not a server rejection: unless the code proves nothing was
    // submitted (permission denied, send barrier), the result is unknown and must not be auto-resent.
    upsertMessage({ ...local, disposition: sendFailureDisposition(e) });
  }
}

/** 有效客户语言（customerLanguage）：行上的 languageInfo/locale 常为 zh_HK 或缺失，按客户消息书写脚本补识别。 */
function translationOn(s: MainState, conv: UiConversation): boolean {
  return !s.trBarOff && shouldShowTranslationBar(conv, !!s.prefs?.assistant.enabled, !!s.prefs?.assistant.outbound_translation, customerLanguage(conv, s.messages[conv.gid] ?? []));
}

async function handleSend(): Promise<void> {
  const s = S();
  const conv = activeConv(s);
  if (!conv || composerLocked(conv)) return;
  // Send barrier (I-04a): keyboard path too (the button is already disabled); the draft is kept.
  if (persistFailed(s.accounts)) { toast(t('bar.persistFailed')); return; }
  const result = await sendComposer({ draft: s.draft, attachment: s.attachment }, async (text) => {
    // 直接发送模式发送输入框原文；替换草稿模式复用当前译文，或等待翻译后发送。
    // 已手动替换成外文的草稿按输入框内容发送。
    if (translationOn(s, conv)) {
      if (s.prefs?.assistant.send_mode === 'send_direct') { await sendText(text, null); return; }
      if (needsOutboundTranslation(text)) {
        const now = S(), tr = now.translation;
        if (tr.status === 'done' && tr.gid === conv.gid && tr.draftVersion === now.draftVersion && tr.text.trim()) await sendText(tr.text, text);
        else if (tr.status === 'busy' && tr.gid === conv.gid && tr.draftVersion === now.draftVersion) {
          // 预览翻译请求还在途：预定发送，译文返回后自动发出，不另起请求；改动草稿即取消。
          const owner = activeAccount(now)?.context;
          if (owner && !queuedSend) { queuedSend = { account: owner, gid: conv.gid, draftVersion: now.draftVersion }; toast('译文返回后自动发送，修改草稿可取消'); }
        } else {
          if (trTimer) { clearTimeout(trTimer); trTimer = null; }
          await translateAndSend(text);
        }
        return;
      }
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
  if (conv && isDone(conv)) { toast('会话已结束：请先发送文字消息重新激活会话，再发送附件。'); return; }
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

/** 本会话手选/已用的目标语言优先；否则按有效客户语言，且只取 TSim 支持的目标。 */
function translationTarget(s: MainState, conv: UiConversation): string {
  return s.translation.gid === conv.gid ? s.translation.target : outboundTarget(customerLanguage(conv, s.messages[conv.gid] ?? []));
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
    if (typeof r.text !== 'string' || !r.text.trim()) throw new Error('empty translation');
    await sendText(r.text, text);
  } catch (e) {
    if (!stillActive(acc.context) || S().activeGid !== conv.gid || S().draftVersion !== version || S().translation !== request) return;
    const msg = isAppError(e) && e.code === 'assistant.tsim_unauthenticated' ? t('tr.needLogin') : errorMessage(e);
    store.patch({ translation: { status: 'error', gid: conv.gid, draftVersion: version, target, text: '', error: msg } });
  }
}

let trTimer: ReturnType<typeof setTimeout> | null = null;
/** 替换草稿模式下，按 Enter 时预览翻译仍在请求中：预定在译文返回后发送。 */
let queuedSend: { account: AccountContext; gid: string; draftVersion: number } | null = null;
const composerInput = createComposerInput({
  context: () => composerInputContext(S()),
  invalidateTranslation: () => {
    quickReplies.close();
    if (trTimer) clearTimeout(trTimer);
    trTimer = null;
    queuedSend = null;
    const s = S();
    store.patch({ draftVersion: s.draftVersion + 1, translation: { ...TRANSLATION_IDLE, gid: s.translation.gid, target: s.translation.target } });
  },
  commit: (value) => {
    setDraft(value);
    const state = S(), conv = activeConv(state);
    if (conv && translationOn(state, conv)) quickReplies.close();
    else quickReplies.suggest();
  },
  refresh: () => store.patch({}),
});
function composerInputContext(s: MainState): { scope: string; version: number } | null {
  const account = activeAccount(s), conv = activeConv(s);
  if (s.view !== 'messages' || account?.state !== 'online' || !conv || composerLocked(conv) || !sameAccount(account.context, conv.account) || account.context.session_generation !== conv.account.session_generation) return null;
  // 会话结束/重开会改变 scope：状态切换前开始的输入法组合不得改写新状态下的草稿。
  return { scope: `${historyScopeKey(account.context, conv.gid)}${isDone(conv) ? '#done' : ''}`, version: s.draftVersion };
}
function scheduleTranslation(): void {
  if (trTimer) clearTimeout(trTimer);
  const s = S();
  const conv = activeConv(s);
  if (!conv || !s.prefs || !translationOn(s, conv)) return;
  if (s.prefs.assistant.send_mode !== 'replace_draft') return;
  const text = s.draft.trim();
  if (!text || !needsOutboundTranslation(text)) {
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
    const q = queuedSend;
    queuedSend = null;
    if (q && q.gid === conv.gid && q.draftVersion === version && sameAccount(q.account, acc.context) && q.account.session_generation === acc.context.session_generation && r.text.trim()) await sendText(r.text, text);
  } catch (e) {
    queuedSend = null;
    if (!stillActive(acc.context) || S().activeGid !== conv.gid || S().draftVersion !== version || S().translation !== request) return;
    const msg = isAppError(e) && e.code === 'assistant.tsim_unauthenticated' ? t('tr.needLogin') : errorMessage(e);
    store.patch({ translation: { status: 'error', gid: conv.gid, draftVersion: version, target, text: '', error: msg } });
  }
}

function setDraft(value: string): void {
  quickReplies.close();
  queuedSend = null;
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

async function acceptAttachment(request: (args: { account: AccountContext; gid: string }) => Promise<unknown>, accepts: (kind: string) => boolean): Promise<UiAttachment | null> {
  const s = S(), account = activeAccount(s)?.context, conv = activeConv(s);
  if (!account || !conv || isDone(conv) || (s.mediaOperation && s.mediaOperation.status !== 'not_submitted')) return null;
  const selection: AttachmentSelection = { account: { ...account }, gid: conv.gid, draftVersion: s.draftVersion };
  store.patch({ attachmentSelection: selection });
  const attachment = await request({ account: selection.account, gid: selection.gid });
  if (S().attachmentSelection !== selection || !stillActive(selection.account) || S().activeGid !== selection.gid || S().draftVersion !== selection.draftVersion) {
    if (S().attachmentSelection === selection) store.patch({ attachmentSelection: null });
    if (isRegisteredMediaAttachment(attachment)) await releaseAttachment(attachment);
    return null;
  }
  store.patch({ attachmentSelection: null });
  if (!attachment) return null;
  if (!ownedAttachment(attachment, selection.account, selection.gid) || !accepts(attachment.kind)) {
    if (isRegisteredMediaAttachment(attachment)) await releaseAttachment(attachment);
    toast('附件不可用或不属于当前会话，请重新选择。'); return null;
  }
  const previous = S().attachment;
  store.patch({ attachment, mediaOperation: null, translation: { ...TRANSLATION_IDLE, gid: conv.gid, target: translationTarget(S(), conv) } });
  await releaseAttachment(previous);
  return attachment;
}

async function attach(kind: 'image' | 'file'): Promise<void> {
  await acceptAttachment((args) => invokeSafe<unknown>(UiCommands.MEDIA_PICK, { ...args, kind }), (got) => got === kind);
}

function receiveFileDrag(value: unknown): void {
  const active = !!value && typeof value === 'object' && (value as { active?: unknown }).active === true;
  if (S().fileDrag !== active) store.patch({ fileDrag: active });
}

/** The host keeps the dropped path; the UI only redeems the id for its current conversation. */
async function receiveFileDrop(value: unknown): Promise<void> {
  if (S().fileDrag) store.patch({ fileDrag: false });
  const drop = value as { drop_id?: unknown; count?: unknown } | null;
  if (!drop || !Number.isSafeInteger(drop.drop_id) || !Number.isSafeInteger(drop.count)) return;
  const s = S(), conv = activeConv(s);
  if (s.activeWeb) { toast('请切回消息页，再拖入文件。'); return; }
  if (!composerInputContext(s) || !conv) { toast('请先打开一个会话，再拖入文件。'); return; }
  if (isDone(conv) || composerLocked(conv)) { toast('当前会话不能发送附件。'); return; }
  if (s.mediaOperation && s.mediaOperation.status !== 'not_submitted') { toast('上一个附件尚未处理完，请先核对或移除后再拖入。'); return; }
  const attachment = await acceptAttachment((args) => invokeSafe<unknown>(UiCommands.MEDIA_ACCEPT_DROP, { ...args, drop_id: drop.drop_id }), () => true);
  if (attachment && (drop.count as number) > 1) toast(`一次发送一个附件，已添加：${attachment.name}`);
  if (attachment) focusComposer();
}

async function setSendMode(mode: 'replace_draft' | 'send_direct'): Promise<void> {
  store.patch({ composerMore: false });
  const next = await invokeSafe<unknown>(UiCommands.PREFS_SET, { section: 'assistant', key: 'send_mode', value: mode });
  if (isPrefsSnapshot(next)) store.patch({ prefs: next });
  const conv = activeConv();
  if (conv) store.patch({ translation: { ...TRANSLATION_IDLE, gid: conv.gid, target: translationTarget(S(), conv) } });
  scheduleTranslation();
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

// Native pages sit above all HTML, so they step aside while a menu or dialog overlaps them.
function webCovered(s: MainState): boolean {
  return !!(s.meMenu || s.ctxMenu || s.logoutDialog || s.peripheral || s.receiveDiagnostics || s.unknownOutbound || s.quickReplies?.mode === 'categories' || s.recommendations);
}
const browserTabs = createBrowserTabs({
  invoke: (command, payload) => ipc.invoke(command, payload),
  get: () => { const s = S(); return { tabs: s.webTabs, active: s.activeWeb, covered: webCovered(s) }; },
  patch: (next) => store.patch(next),
  notify: toast,
  stage: () => document.querySelector<HTMLElement>('.web-view'),
});
let webStageNode: HTMLElement | null = null, detachWebStage: (() => void) | null = null;
function attachWebStage(el: HTMLElement): void {
  if (el === webStageNode) return;
  detachWebStage?.();
  webStageNode = el;
  detachWebStage = browserTabs.attachStage(el);
}
/** Banners cannot show over a native page, so the latest one moves into the browser bar. */
function webNotice(s: MainState): HTMLElement | null {
  const banner = s.banners[0];
  if (!banner) return null;
  const conv = s.conversations.find((c) => c.gid === banner.gid && sameAccount(c.account, banner.account));
  const owner = s.accounts?.accounts.find((a) => sameAccount(a.context, banner.account));
  const name = conv?.title ?? (owner ? accountLabel(owner) : '');
  return h('button', { type: 'button', class: 'web-notice', dataset: { webNotice: String(banner.id) }, onclick: () => { dismissBanner(banner.id); void locateConversation(banner.account, banner.gid); } }, icon(IC.bell, 13), `${name} · ${banner.count} 条新消息`);
}
function webStage(s: MainState): HTMLElement | null {
  const tab = s.webTabs.find((x) => x.tab_id === s.activeWeb);
  if (!tab) return null;
  return browserStage(tab, {
    onBack: () => void browserTabs.nav(tab.tab_id, 'back'),
    onForward: () => void browserTabs.nav(tab.tab_id, 'forward'),
    onReload: () => void browserTabs.nav(tab.tab_id, 'reload'),
    onExternal: () => void invokeSafe(UiCommands.SHELL_OPEN_EXTERNAL, { url: tab.url }),
  }, h, icon, attachWebStage, webNotice(s));
}
window.addEventListener('pagehide', () => browserTabs.dispose());

const operatorOverlay = createOperatorOverlay(document);
const tsimOrder = createTsimOrderOpener({
  current: () => { const s = S(), account = activeAccount(s)?.context, conversation = activeConv(s); return s.view === 'messages' && account && conversation && sameAccount(account, conversation.account) && account.session_generation === conversation.account.session_generation ? { account, conversation, identity: s.tsimStatus } : null; },
  invoke: (command, payload) => ipc.invoke(command, payload), notify: toast, login: () => openTsimSettings(),
  show: (grant, current) => { if (operatorGrant(grant)) operatorOverlay.open(grant, current); else toast('TSIM 查询页授权无效，请核对登录状态后重试。'); },
});
// This listener runs synchronously before the batched UI paint. A reply or a
// message from an old account/order cannot keep a remote page mounted.
store.subscribe((s, prev) => {
  // 滚动窗口等无关 patch 走引用比较即可；只有相关字段变了才序列化比对。
  if (s.accounts === prev.accounts && s.conversations === prev.conversations && s.activeGid === prev.activeGid && s.tsimStatus === prev.tsimStatus && s.view === prev.view) return;
  const key = (value: MainState) => { const conversation = activeConv(value), account = activeAccount(value)?.context; return JSON.stringify([account, conversation?.gid, conversation?.order?.order_id, conversation?.assistant_context_revision, value.tsimStatus, value.view]); };
  if (key(s) !== key(prev)) operatorOverlay.close();
});
window.addEventListener('pagehide', () => operatorOverlay.dispose());

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

const noticeQuery = createNoticeQuery({
  account: () => activeAccount()?.context ?? null,
  current: S,
  publish: patch => store.patch(patch),
  invoke: (command, payload) => ipc.invoke(command, payload),
  error: errorMessage,
  failed: error => toast(t('misc.failed', { msg: errorMessage(error) })),
  ignored: () => ignoredNoticeCats(S()),
});

const noticeCatMenu = createContextMenu('ncat-menu', '通知分类操作');

function ignoredNoticeCats(s: MainState): readonly string[] {
  const ctx = activeAccount(s)?.context;
  if (!ctx) return [];
  return s.noticeIgnored[`${ctx.environment}:${ctx.account_id}`] ?? loadIgnored(ctx);
}

/** 忽略只改本机显示：隐藏分类并不再计入未读角标，服务端已读状态不变。 */
function setNoticeCatIgnored(id: string, ignored: boolean): void {
  const ctx = activeAccount()?.context;
  if (!ctx) return;
  const next = toggleIgnored(ignoredNoticeCats(S()), id, ignored);
  saveIgnored(ctx, next);
  store.patch({ noticeIgnored: { ...S().noticeIgnored, [`${ctx.environment}:${ctx.account_id}`]: next }, noticeIgnoredOpen: next.length ? S().noticeIgnoredOpen : false });
  // 重新对账选中项：被忽略的当前分类会回落到第一个可见分类。
  if (ignored && S().noticeCat === id) void noticeQuery.categories();
  // 忽略的分类不再打扰，它的横幅提醒一并关闭。
  if (ignored && noticeBannerCats(S()).includes(id)) void setNoticeCatBanner(id, false);
}

function noticeBannerCats(s: MainState): readonly string[] {
  const ctx = activeAccount(s)?.context;
  return (ctx && s.prefs?.notice_banner.accounts[bannerKey(ctx)]) || [];
}

/** 设置由宿主保存：主窗隐藏时也要靠它判断哪些分类需要弹横幅。 */
async function setNoticeCatBanner(id: string, on: boolean): Promise<void> {
  const ctx = activeAccount()?.context, prefs = S().prefs;
  if (!ctx || !prefs) return;
  const next = await invokeSafe<unknown>(UiCommands.PREFS_SET, { section: 'notice_banner', key: 'accounts', value: withBannerCategory(prefs.notice_banner.accounts, ctx, id, on) });
  if (isPrefsSnapshot(next)) store.patch({ prefs: next });
}

function openNoticeCatMenu(e: MouseEvent, c: { readonly id: string; readonly name: string }, ignored: boolean): void {
  e.preventDefault();
  e.stopPropagation();
  const account = activeAccount()?.context;
  if (!account) return;
  const banner = noticeBannerCats(S()).includes(c.id);
  noticeCatMenu.open(e.clientX, e.clientY, ignored
    ? [{ id: 'unignore', label: `取消忽略「${c.name}」`, icon: IC.bell, dataset: { ncatMenu: 'unignore', fid: 'ncat-menu:unignore' }, run: () => setNoticeCatIgnored(c.id, false) }]
    : [{ id: 'banner', label: banner ? '取消横幅提醒' : '使用横幅提醒', icon: IC.bell, dataset: { ncatMenu: 'banner', fid: 'ncat-menu:banner' }, run: () => setNoticeCatBanner(c.id, !banner) },
      { id: 'ignore', label: `忽略「${c.name}」`, icon: IC.close, dataset: { ncatMenu: 'ignore', fid: 'ncat-menu:ignore' }, run: () => setNoticeCatIgnored(c.id, true) }],
    () => stillActive(account), () => toast('通知分类操作失败，请重试'));
}

async function pickNoticeCat(id: string): Promise<void> { await noticeQuery.pick(id); }

async function openNotice(n: UiNotice): Promise<void> {
  const acc = activeAccount();
  if (!acc || S().noticeCat !== n.category_id || !S().notices.includes(n)) return;
  const stillSelected = noticeQuery.selectionGuard();
  if (n.unread && !await noticeQuery.markRead(n.category_id, n.id)) return;
  if (!stillSelected()) return;
  await browserTabs.open(acc.context, n.url);
}

async function markAllNotices(): Promise<void> {
  const category = S().noticeCat;
  if (category) await noticeQuery.markRead(category, null);
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
  const current = noticeQuery.accountGuard();
  if (!current()) return;
  store.patch({ orderBusyId: o.order_id });
  try {
    if (!current()) return;
    // Both calls carry the account that was active when the user clicked, even if they switch tabs meanwhile.
    const r = await ipc.invoke<{ gid: string; reused: boolean }>(UiCommands.ORDER_CREATE_IM_CHAT, { account: acc.context, order_id: o.order_id });
    if (!current()) return;
    const convs = await ipc.invoke<UiConversation[]>(UiCommands.IM_CONVERSATIONS, { account: acc.context });
    if (!current()) return; // An A → B → A visit cannot reuse the first A's result.
    store.patch({ conversations: convs.filter(isUiConversation), orderBusyId: null, tab: 'doing' });
    if (!current()) return;
    await openConversation(r.gid);
    if (!current()) return;
  } catch (e) {
    if (!current()) return;
    store.patch({ orderBusyId: null });
    if (!current()) return;
    toast(t('order.imFailed', { msg: errorMessage(e) }));
  }
}

async function openWebAdvanced(o: UiOrderSummary | string): Promise<void> {
  const acc = activeAccount();
  if (!acc) return;
  await browserTabs.open(acc.context, orderDetailUrl(typeof o === 'string' ? o : o.order_id));
}

// --------------------------------------------------------------- banners & sounds

let bannerSeq = 0;
function onBanner(p: { account: AccountContext; gid: string; count: number; stay_ms: number; system?: boolean }): void {
  const s = S();
  const acc = activeAccount(s);
  // No banner for the conversation the user is looking at.
  if (acc && sameAccount(acc.context, p.account) && s.activeGid === p.gid && s.view === 'messages' && !s.activeWeb && document.visibilityState === 'visible') return;
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
    const on = a.context.account_id === snap?.active_account_id && !s.activeWeb;
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
        onclick: () => { browserTabs.activate(null); void switchAccount(a); },
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
      s.webTabs.map((tab) => webTabView(tab, tab.tab_id === s.activeWeb, snap?.accounts.find((a) => a.context.account_id === tab.account_id)?.remark ?? snap?.accounts.find((a) => a.context.account_id === tab.account_id)?.nick ?? '', { onSelect: () => browserTabs.activate(tab.tab_id), onClose: () => void browserTabs.close(tab.tab_id) }, h, icon)),
      canAdd ? h('button', { class: 'tab-add', 'aria-label': t('tab.add'), title: t('tab.addTitle', { max: snap?.max_accounts ?? 16 }), dataset: { action: 'add-account' }, onclick: () => void startLogin() }, icon(IC.plus, 16)) : null,
    ),
    s.alarmCount > 0
      ? h('button', { class: 'tb-alarm', title: t('tb.alarmTitle', { n: s.alarmCount }), dataset: { tbAlarm: String(s.alarmCount) }, onclick: () => { if (s.alarmTarget) void locateConversation(s.alarmTarget.account, s.alarmTarget.gid); else void invokeSafe(UiCommands.SHELL_OPEN_WINDOW, { label: WindowLabels.ALARM }); } }, icon(IC.clock, 13), t('tb.alarm', { n: s.alarmCount }))
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
  const unreadMsgs = unreadTotal(s.conversations);
  const unreadNotice = splitCategories(s.noticeCats, ignoredNoticeCats(s)).visible.reduce((n, c) => n + c.unread, 0);
  const item = (view: View, label: string, d: string, badge: number, extra: HTMLElement | null = null) =>
    h(
      'button',
      { class: cx('nav-i', { on: s.view === view }), 'aria-label': label, 'aria-current': s.view === view ? 'page' : undefined, dataset: { nav: view, fid: `nav:${view}` }, onclick: () => { store.patch({ view, ctxMenu: null, meMenu: false }); if (view === 'notifications') void noticeQuery.categories(); } },
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

function waitPillClass(c: UiConversation, waited: number): string {
  return cx('wait', `wait-${waitTier(waited)}`, { pending: !c.waiting_confirmed });
}

function waitPillTitle(c: UiConversation, waited: number): string {
  const label = t('list.waiting', { t: formatDuration(waited) });
  return c.waiting_confirmed ? label : `${label} · ${t('list.waitingPending')} · ${t('alarm.pendingTitle')}`;
}

/** Writes only what changed, so the 1 Hz tick does not invalidate untouched pills. */
function syncWaitPill(el: HTMLElement, c: UiConversation, waited: number): void {
  const cls = waitPillClass(c, waited), text = formatStopwatch(waited), title = waitPillTitle(c, waited);
  if (el.className !== cls) el.className = cls;
  if (el.textContent !== text) el.textContent = text;
  if (el.title !== title) el.title = title;
}

/** Peek only: safe per rendered row, and scoped to this account so a switch cannot show another account's pills. */
function memberPillsFor(acc: UiAccount | null, conv: UiConversation) {
  return memberPills(isDone(conv), acc ? memberPreload.peekMembers({ account: acc.context, gid: conv.gid }) : null);
}

function masterPill(): HTMLElement {
  return h('span', { class: 'chip chip-master', title: t('chat.masterPillLabel'), 'aria-label': t('chat.masterPillLabel') }, t('chat.masterPill'));
}

function conversationList(s: MainState): HTMLElement {
  const counts = tabCounts(s.conversations, 'customer');
  const list = filterConversations(s.conversations, s.tab, s.query, 'customer');
  const scope = JSON.stringify([activeAccount(s)?.context, s.tab, s.query]);
  const window = s.listWindow?.scope === scope ? s.listWindow : undefined;
  const range = virtualConversationRange(list.length, window?.top ?? 0, window?.height ?? 900);
  const acc = activeAccount(s);
  const av = agentView(s.agent);
  const nv = netView(s.net, netEverConnected);
  const nextRows = new Map<string, { deps: readonly unknown[]; node: HTMLElement }>();
  const rows = list.slice(range.start, range.end).map((c) => {
    const on = c.gid === s.activeGid;
    const msgs = s.messages[c.gid] ?? EMPTY_MESSAGES;
    const language = customerLanguage(c, msgs);
    const waiting = c.waiting_since_ms !== null && !isDone(c);
    const waited = waiting ? waitedSeconds(c, s.now) : 0;
    const mark = MARK_COLORS.find((m) => m.action === c.mark);
    const draft = s.drafts[c.gid] ?? c.draft;
    const hasDraft = !!draft && !on;
    const preview = c.preview || latestPreview(msgs);
    const master = memberPillsFor(acc, c).isMaster;
    // 行只依赖这些输入：未变就交回上次的节点，增量渲染原地保留，不再逐帧重建/比对整行（滚动与计时刷新时的主要脚本开销）。
    // 等待秒数不进依赖：命中缓存时只就地改写计时文本，不因每秒变化重建整行。
    const deps = [c, language, preview, on, hasDraft ? draft : null, c.last_message_time_ms ? formatRelativeTime(c.last_message_time_ms, s.now) : '', waiting ? waitTier(waited) : null, s.prefs, master];
    const cached = conversationRows.get(c.gid);
    if (cached && cached.deps.length === deps.length && cached.deps.every((value, i) => value === deps[i])) {
      nextRows.set(c.gid, cached);
      if (waiting && typeof cached.node.querySelector === 'function') {
        const pill = cached.node.querySelector<HTMLElement>('[data-waiting-gid]');
        if (pill) syncWaitPill(pill, c, waited);
      }
      return cached.node;
    }
    const node = h(
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
      h(
        'div',
        { class: 'conv-lead' },
        h('div', { class: 'ava', style: { background: c.color } }, renderMessageAvatar(document, c.title, c.customer_avatar)),
        waiting ? h('span', { class: waitPillClass(c, waited), dataset: { waitingGid: c.gid }, title: waitPillTitle(c, waited) }, formatStopwatch(waited)) : null,
      ),
      h(
        'div',
        { class: 'conv-main' },
        h('div', { class: 'crow' }, h('span', { class: 'cname' }, c.title), master ? masterPill() : null, language !== 'zh' ? h('span', { class: 'chip chip-lang' }, langName(language)) : null, h('span', { class: 'ctime', dataset: { relativeTime: String(c.last_message_time_ms ?? 0) } }, c.last_message_time_ms ? formatRelativeTime(c.last_message_time_ms, s.now) : '')),
        h('div', { class: 'crow' }, hasDraft ? h('span', { class: 'cdraft' }, t('list.draft')) : null, h('span', { class: 'cprev' }, hasDraft ? draft : preview), accBadge(c.unread_count)),
        h(
          'div',
          { class: 'crow', style: { 'margin-top': '2px' } },
          isDone(c) ? h('span', { class: 'chip chip-muted' }, t('list.finished')) : null,
          c.order?.product?.trim() ? h('span', { class: 'conv-product', title: c.order.product }, c.order.product) : null,
          c.is_top ? icon(IC.pin, 12, { style: 'color: var(--c-text-faint)', 'aria-label': t('list.pinned') }) : null,
        ),
      ),
      h('button', { class: 'ibtn cmore', 'aria-label': t('list.more'), onclick: (e: MouseEvent) => { e.stopPropagation(); store.patch({ ctxMenu: { gid: c.gid, x: e.clientX, y: e.clientY } }); } }, icon(IC.more, 14)),
    );
    nextRows.set(c.gid, { deps, node });
    return node;
  });
  // 只留本次窗口内的行，滑出窗口的随之释放。
  conversationRows = nextRows;
  return h(
    'div',
    { class: 'clist' },
    part('listHeader', () => h(
      'div',
      { class: 'clist-h' },
      h(
        'div',
        { class: 'stat-row' },
        h('div', { class: 'agent-status-control', onmousedown: (e: Event) => e.stopPropagation() },
          h(
            'button',
            { class: 'stat-pill', title: t('me.statusHead'), 'aria-haspopup': 'menu', 'aria-expanded': String(s.meMenu === 'status'), 'aria-controls': 'agent-status-menu', dataset: { agent: av.known ? (s.agent.confirmed ? s.agent.status : s.agent.lastConfirmedStatus) : 'unknown', fid: 'agent-status-toggle' }, onclick: (e: Event) => { e.stopPropagation(); store.patch({ meMenu: S().meMenu === 'status' ? false : 'status', ctxMenu: null }); } },
            h('span', { class: 'dot', style: { background: `var(${av.colorVar})` } }),
            av.label,
            s.agentBusy ? h('span', { class: 'spin' }) : null,
            icon(IC.chevDown, 12),
          ),
          s.meMenu === 'status' ? h('div', { class: 'menu agent-status-menu', id: 'agent-status-menu', role: 'menu', 'aria-label': t('me.statusHead') },
            AGENT_STATUS_ORDER.map((st) => h('button',
              { class: 'mi', role: 'menuitem', dataset: { agentStatus: st, fid: `agent-status:${st}` }, disabled: s.agentBusy, onclick: () => void setAgentStatus(st) },
              h('span', { class: 'dot', style: { background: `var(${agentStatusColorVar(st)})` } }),
              h('span', { style: { flex: '1' } }, agentStatusLabel(st)),
              h('span', { class: 'muted', style: { 'font-size': '11.5px' } }, agentStatusDesc(st)),
              s.agent.confirmed && st === s.agent.status ? icon(IC.check, 14, { style: 'color: var(--c-primary)' }) : null,
            )),
          ) : null,
        ),
      ),
      h('label', { class: 'search', title: '仅筛选当前账号已加载的会话名称、最新消息摘要和订单号；主动联系客人请用「订单联系」' }, icon(IC.search, 15), h('input', { class: 'inp', placeholder: '搜索本地会话', 'aria-label': '搜索本地会话', value: s.query, dataset: { fid: 'search' }, oninput: (e: Event) => store.patch({ query: (e.target as HTMLInputElement).value }) })),
      h(
        'div',
        { class: 'ftabs', role: 'tablist' },
        h('button', { class: cx('ftab', { on: s.tab === 'doing' }), role: 'tab', 'aria-selected': String(s.tab === 'doing'), dataset: { tab: 'doing', fid: 'list-tab:doing' } , onclick: () => store.patch({ tab: 'doing' }) }, `${t('list.doing')} ${counts.doing}`),
        h('button', { class: cx('ftab', { on: s.tab === 'done' }), role: 'tab', 'aria-selected': String(s.tab === 'done'), dataset: { tab: 'done', fid: 'list-tab:done' } , onclick: () => store.patch({ tab: 'done' }) }, `${t('list.done')} ${counts.done}`),
      ),
    )),
    nv.offline ? h('div', { class: 'netbar' }, h('span', { class: 'spin', style: { 'border-top-color': '#87500A' } }), h('span', { style: { flex: '1' } }, t('list.offline')), h('button', { class: 'link', onclick: () => void loadForActiveAccount() }, t('list.retryNow'))) : null,
    acc?.state === 'expired' ? h('div', { class: 'netbar err', dataset: { expired: '1' } }, icon(IC.alert, 15), h('span', { style: { flex: '1' } }, t('list.expired')), h('button', { class: 'link', onclick: () => void startLogin(acc.context) }, t('list.relogin'))) : null,
    h('div', { class: 'cscroll', dataset: { keepScroll: `clist:${scope}`, listScope: scope }, onscroll: (event: Event) => {
      const el = event.currentTarget as HTMLElement;
      // 已挂载窗口前后仍有缓冲行时不换窗：滚动本身不触发渲染，只有逼近窗口边缘才重算。
      if (conversationWindowStale(range, list.length, el.scrollTop, el.clientHeight)) store.patch({ listWindow: { scope, top: el.scrollTop, height: el.clientHeight } });
    } }, h('div', { style: { height: `${range.start * 80}px` }, 'aria-hidden': 'true' }), rows, h('div', { style: { height: `${(list.length - range.end) * 80}px` }, 'aria-hidden': 'true' }), rows.length === 0 ? h('div', { class: 'empty', style: { margin: '16px' } }, s.query ? t('list.emptySearch') : t('list.empty')) : null),
  );
}
/** 会话列表行节点缓存（gid → 依赖 + 节点），只保存当前窗口内的行。 */
let conversationRows = new Map<string, { deps: readonly unknown[]; node: HTMLElement }>();

function contextMenu(_s: MainState): HTMLElement | null { return null; }

function openConversationContextMenu(s: MainState): void {
  const position = s.ctxMenu;
  const c = s.conversations.find(row => row.gid === position?.gid);
  const account = activeAccount(s)?.context;
  if (!position || !c || !account) return;
  const items = contextMenuItems(c);
  const valid = () => stillActive(account) && S().ctxMenu === position && S().conversations.some(row => row.gid === c.gid && row.assistant_context_revision === c.assistant_context_revision);
  const actions: MessageMenuAction[] = [
    { id: 'top', label: items.topLabel, dataset: { ctx: 'top', fid: 'ctx-menu:top' }, run: () => toggleTop(c) },
    { id: 'marks', label: t('ctx.markColor'), divider: true, run: () => {}, content: () => h('div', { class: 'context-menu-colors' },
      h('div', { class: 'mhead' }, t('ctx.markColor')),
      h('div', { class: 'mk-row', role: 'group', 'aria-label': t('ctx.markColor') }, MARK_COLORS.map(mc => h('button', {
        type: 'button', role: 'menuitemradio', 'aria-checked': String(c.mark === mc.action), class: cx('mk', { on: c.mark === mc.action }),
        style: { background: `var(${mc.cssVar})` }, title: t(mc.nameKey), 'aria-label': t('ctx.markAs', { color: t(mc.nameKey) }), dataset: { mark: String(mc.action), fid: `mark:${mc.action}` },
        onclick: () => { if (valid()) void setMark(c, mc.action); },
      }, c.mark === mc.action ? icon(IC.check, 12) : null))),
    ) },
  ];
  if (items.showClear) actions.push({ id:'clear',label:t('ctx.clearMark'),dataset:{ctx:'clear',fid:'ctx-menu:clear'},run:()=>setMark(c,0) });
  conversationContextMenu.open(position.x,position.y,actions,valid,()=>toast('会话操作失败，请重试'));
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

function openMessageAttachment(message: UiMessage, conversation: UiConversation, account: UiAccount | null): void {
  if (!account || !stillActive(account.context) || S().view !== 'messages' || S().activeGid !== conversation.gid || !mediaNodeKey(account.context, conversation, message)) return;
  if (message.kind !== 'image' && message.kind !== 'video' && message.kind !== 'file') return;
  if (!message.message_id) { toast('消息确认发送后才能预览'); return; }
  void invokeSafe(UiCommands.MEDIA_VIEWER_OPEN_MESSAGE, { account: account.context, gid: conversation.gid, message_id: message.message_id });
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
  if (!m.order_id) {
    toast('当前未提供此订单的可用详情，请在订单查询中核对。');
    return;
  }
  void openWebAdvanced(m.order_id);
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
/** 行的下外边距由样式表按类名决定：每种类名只 getComputedStyle 一次，不再逐行读。 */
const rowMargins = new Map<string | undefined, number>();
function rowMarginBottom(row: HTMLElement): number {
  const key = row.className;
  const cached = rowMargins.get(key);
  if (cached !== undefined) return cached;
  const value = Number.parseFloat(getComputedStyle(row).marginBottom) || 0;
  rowMargins.set(key, value);
  return value;
}
function measureMessagePane(scroll: HTMLElement): MeasuredPane {
  const rows = [...scroll.querySelectorAll<HTMLElement>('[data-row-id]')];
  const spacer = scroll.querySelector<HTMLElement>('[data-msg-spacer="top"]')?.getBoundingClientRect();
  // `header` is the fixed content above the first row: everything in front of it except the spacer's own height.
  const origin = rows[0]?.getBoundingClientRect().top ?? (spacer ? spacer.top + spacer.height : null);
  const header = origin === null ? 0 : origin - (spacer?.height ?? 0) - scroll.getBoundingClientRect().top + scroll.scrollTop;
  return { header, rows: rows.filter(row => row.dataset['rowId']).map(row => ({ id: row.dataset['rowId']!, height: row.getBoundingClientRect().height + rowMarginBottom(row) })) };
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
  // A stored anchor can be seconds old: it positions a new pane, but must never pull a retained one back.
  const target = pinned ? null : anchor ?? (messagePaneModel.retained() ? null : view?.anchor ?? null);
  const result = messagePaneModel.sync(scope, paneGeometry(scroll), measureMessagePane(scroll), target, pinned, performance.now() - lastMessageScrollAt > MESSAGE_SCROLL_IDLE_MS);
  if (!result) { historyDiagnostics.record('restore_skip', {}, 'wrong_scope'); return; }
  // The spacer goes first: the rows must already be in place when (rarely) the offset is rewritten.
  const spacer = scroll.querySelector<HTMLElement>('[data-msg-spacer="top"]');
  if (spacer && messagePaneCache && messagePaneCache.win.topSpacer !== result.topSpacer) {
    spacer.style.height = `${result.topSpacer}px`;
    messagePaneCache.win = { ...messagePaneCache.win, topSpacer: result.topSpacer };
  }
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
  const top = Math.max(0, messagePaneModel.distanceToHead(scroll.scrollTop));
  store.patch({ messageView: { scope, top, height: scroll.clientHeight, anchor: captured && 'anchor' in captured ? captured.anchor : null, rev: (S().messageView?.rev ?? 0) + 1 } });
}
/** Scrolling needs a new window, or (debounced) a fresh stored anchor. */
let messageViewTimer: ReturnType<typeof setTimeout> | undefined;
const MESSAGE_SCROLL_IDLE_MS = 250;
let lastMessageScrollAt = 0;
function onMessageScroll(scroll: HTMLElement): void {
  messageViewPatches = 0;
  lastMessageScrollAt = performance.now();
  const conv = activeConv(S()), scope = conv ? historyScopeKey(activeAccount(S())?.context ?? null, conv.gid) : '';
  if (!scope || scroll.dataset['historyScope'] !== scope) return;
  if (messagePaneModel.outOfBand(paneGeometry(scroll))) restoreMessageAnchor(captureMessageAnchor(S()));
  const need = messagePaneModel.rangeFor(paneGeometry(scroll));
  const pinned = scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop < PIN_THRESHOLD;
  if (need?.changed) { persistMessageView(scroll, scope, pinned); return; }
  // 窗内滚动但阅读行换了：同步持久化锚点，面板随后被卸载/重建时才不会退回到最多 250ms 前的位置；
  // 同一行内的偏移漂移才走防抖（窗口未变，这类 patch 不重建任何行）。
  const stored = S().messageView?.scope === scope ? S().messageView?.anchor?.key ?? null : null;
  const captured = pinned ? null : messagePaneModel.capture(scope, paneGeometry(scroll));
  const row = captured && 'anchor' in captured ? captured.anchor.key : null;
  const sameRow = row === stored || (!!row && !!stored && row.mid === stored.mid && row.lid === stored.lid && row.role === stored.role && row.sender === stored.sender);
  if (!sameRow) { persistMessageView(scroll, scope, pinned); return; }
  clearTimeout(messageViewTimer);
  messageViewTimer = setTimeout(() => {
    if (!scroll.isConnected || scroll.dataset['historyScope'] !== scope) return;
    // The gesture is over: this is when a pending slack reset can rewrite the offset unnoticed.
    restoreMessageAnchor(captureMessageAnchor(S()));
    persistMessageView(scroll, scope, scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop < PIN_THRESHOLD);
  }, MESSAGE_SCROLL_IDLE_MS);
}
const historyLayoutFrames = createHistoryLayoutFrames();
function withMessageAnchor(s: MainState, redraw: () => void): void {
  const anchor = captureMessageAnchor(s);
  liveAnchor = anchor;
  try { redraw(); } finally { liveAnchor = null; }
  const scroll = document.querySelector<HTMLElement>('[data-keep-scroll="msgs"]');
  const scope = scroll?.dataset['historyScope'];
  // A retained pane needs no row measurements on draft/sidebar-only frames. Width, height,
  // total height and the rendered-window revision still invalidate synchronous geometry.
  const changed = historyLayoutFrames.sync(scroll, scope ?? '', messagePaneCache, () => restoreMessageAnchor(anchor));
  startHistoryLayout(scroll, () => captureMessageAnchor(S()), restoreMessageAnchor, () => {
    const current = S(), conv = activeConv(current);
    return !!scroll?.isConnected && !!scope && !!conv && historyScopeKey(activeAccount(current)?.context ?? null, conv.gid) === scope;
  }, scope, changed);
}


async function refreshMessageTranslation(message: UiMessage, conv: UiConversation, acc: UiAccount): Promise<void> {
  if (!stillActive(acc.context) || S().activeGid !== conv.gid) return;
  syncInboundTranslation();
  const outcome = await inboundTranslation.retry(message);
  if (!stillActive(acc.context) || S().activeGid !== conv.gid) return;
  if (outcome === 'not_needed') toast('该消息无需翻译');
  else if (outcome === 'unsupported') toast('当前会话暂不支持翻译');
}

function openMessageMenu(event: MouseEvent | KeyboardEvent, message: UiMessage, conv: UiConversation, acc: UiAccount | null, x?: number, y?: number): void {
  if (!acc) return;
  const valid = () => stillActive(acc.context) && S().view === 'messages' && S().activeGid === conv.gid
    && S().conversations.find(c => c.gid === conv.gid)?.assistant_context_revision === conv.assistant_context_revision
    && (S().messages[conv.gid] ?? []).some(row => row === message);
  if (!valid()) return;
  const actions: MessageMenuAction[] = [];
  if (message.kind === 'image' && message.message_id && safeMediaUrl(message.media_url)) actions.push({ id: 'copy', label: '复制图片', run: async () => { await ipc.invoke(UiCommands.IM_COPY_MESSAGE_IMAGE, {account:acc.context,gid:conv.gid,message_id:message.message_id}); if (stillActive(acc.context)) toast('图片已复制'); } });
  if (message.kind === 'text' && message.text) actions.push({ id: 'copy', label: '复制', run: () => copyText(message.text) });
  if (selectedQuoteReference(message, S().messages[conv.gid] ?? [], conv.gid)) actions.push({ id: 'quote', label: '引用', run: () => store.patch({ quote: message }) });
  if (message.message_id && (message.platform_type == null ? ['text','image','video','file','order_card'].includes(message.kind) : [0,1,2,3,5,8,9].includes(message.platform_type)) && (!message.disposition || message.disposition.kind === 'confirmed')) actions.push({ id:'forward',label:'转发',run:()=>forwardDialog.open(message,acc.context) });
  for (const action of featureRuntime.messageActions(message)) actions.push({ id: action.id, label: action.label(message), run: () => action.run(message, { account: acc.context, gid: conv.gid }) });
  if (message.kind === 'text' && message.message_id) actions.push({ id: 'translate', label: '翻译', run: () => {
    store.patch({ hideInboundTr: false });
    if (!message.translation) return refreshMessageTranslation(message, conv, acc);
  } });
  if (message.kind === 'image' && message.message_id && safeMediaUrl(message.media_url)) {
    actions.push({ id:'save',label:'保存图片',divider:true,run:async()=>{ const result=await ipc.invoke<{status:string}>(UiCommands.IM_SAVE_MESSAGE_IMAGE,{account:acc.context,gid:conv.gid,message_id:message.message_id}); if(stillActive(acc.context) && result.status==='saved') toast('图片已保存'); } });
    actions.push({ id:'emoji',label:'添加表情',run:()=>savedEmojiPanel.add(message,acc.context) });
  }
  if (!actions.length) return;
  event.preventDefault(); event.stopPropagation();
  store.patch({ ctxMenu: null, meMenu: false });
  messageContextMenu.open(x ?? (event as MouseEvent).clientX, y ?? (event as MouseEvent).clientY, actions, valid, () => toast('消息操作失败，请重试'));
}

function messageRow(s: MainState, m: UiMessage, conv: UiConversation, acc: UiAccount | null): HTMLElement {
  const trView = m.kind === 'text' && !s.hideInboundTr ? inboundTranslation.view(m) : null;
  const supplierTip = (row: UiMessage): string => { const supplier = inboundTranslation.supplier(row); return supplier ? `来自${supplier}翻译` : ''; };
  const alignment = messageAlignment(m);
  if (alignment.side === 'system') {
    const account = acc?.context ?? null;
    const key = messageHistoryKey(account, conv, m);
    return h('div', { class: 'msg-sys', dataset: { historyKey: key, rowId: rowId(m) } }, h('span', null, `${formatDate(m.create_time_ms)} ${formatClock(m.create_time_ms, true)} ${m.translation || m.text}`));
  }
  const alignRight = alignment.side === 'right';
  const isSelf = alignment.self;
  const quotePreview = messageQuotePreview(m, s.messages[conv.gid] ?? []);
  const showTime = s.prefs?.general.show_msg_time ?? true;
  const readStatus = m.read_status === 'read' || m.read_status === 'unread' ? m.read_status : null;
  const hasServerId = typeof m.message_id === 'string' && m.message_id.trim() !== '';
  const delivered = isSelf ? m.disposition?.kind === 'confirmed' || readStatus !== null : hasServerId && (m.sender_role === 'customer' || m.sender_role === 'merchant_other');
  const receipt = delivered ? (readStatus === 'read' ? 'read' : 'delivered') : null;
  let body: HTMLElement;
  if (m.kind === 'order_card') {
    // 订单咨询通知卡片：字段只取与卡片订单号一致的摘要，缺失则省略整行。
    const card = orderCardView(m, conv.order);
    body = h(
      'div',
      { class: 'ocard' },
      h('div', { class: 'ocard-t' }, card.title),
      card.subtitle ? h('div', { class: 'ocard-s' }, card.subtitle) : null,
      h('dl', { class: 'ocard-b' }, card.rows.map((row) => h('div', { class: 'ocard-r' }, h('dt', null, `${row.label}：`), h('dd', null, row.value)))),
      h('button', { type: 'button', class: 'ocard-link', dataset: { orderAction: 'open' }, onclick: () => openMessageOrder(m, conv, acc) }, t('side.pcDetail'), icon(IC.external, 12)),
    );
  } else if (m.kind === 'voice' && voicePlayer) {
    body = voiceBubble(m, voicePlayer, h, icon, { onOpenExternal: (url: string) => void invokeSafe(UiCommands.SHELL_OPEN_EXTERNAL, { url }) });
  } else if (m.kind === 'image' || m.kind === 'video' || m.kind === 'file') {
    const url = safeMediaUrl(m.media_url ?? (m.kind !== 'file' ? m.text : null));
    const thumbnail = safeMediaUrl(m.media_thumbnail);
    const name = m.media_filename || (m.kind === 'file' ? m.text : previewOf(m));
    if (url && m.kind === 'image') {
      body = h('a', { class: 'media-image', href: url, onclick: (e: Event) => { e.preventDefault(); openMessageAttachment(m, conv, acc); }, title: '预览图片' }, h('img', { src: thumbnail ?? url, alt: name, loading: 'lazy', referrerpolicy: 'no-referrer', onerror: (e: Event) => (e.target as HTMLImageElement).replaceWith(h('span', { class: 'bubble' }, '图片加载失败，点击查看原图')) }));
    } else if (url && m.kind === 'video') {
      body = h('div', { class: 'media-video-wrap' }, h('video', { dataset: { mediaKey: mediaNodeKey(acc?.context ?? null, conv, m) }, class: 'media-video', src: url, poster: thumbnail, controls: true, preload: 'metadata', 'aria-label': name }), h('button', { type: 'button', class: 'media-preview-open', onclick: (e: Event) => { (e.currentTarget as HTMLElement).parentElement?.querySelector('video')?.pause(); openMessageAttachment(m, conv, acc); } }, '放大预览'));
    } else if (url) {
      body = h('a', { class: 'bubble media-file', href: url, onclick: (e: Event) => { e.preventDefault(); openMessageAttachment(m, conv, acc); } }, icon(IC.file, 22), name);
    } else body = h('div', { class: 'bubble' }, name || previewOf(m));
  } else {
    body = h(
      'div',
      { class: 'bubble' },
      richText(m.text),
      m.kind === 'text' && !s.hideInboundTr && m.translation
        ? h('div', { class: 'btr', title: supplierTip(m) }, h('span', null, m.translation))
        : null,
      trView ? h('div', { class: 'btr', dataset: { trState: trView.status } },
        trView.status === 'pending' ? h('span', { class: 'inbound-translate-state' }, '正在翻译…') : h('span', { class: 'inbound-translate-state', title: trView.status === 'failed' ? trView.error : '' }, trView.status === 'failed' ? '翻译失败' : '未找到翻译结果'),
        trView.status === 'pending' ? null : h('button', { type: 'button', class: 'inbound-translate', onclick: () => { if (acc) void refreshMessageTranslation(m, conv, acc); } }, '点击重试'),
      ) : null,
    );
  }
  // 成功确认态不显示文字，只在行上保留 data-send-outcome 供核对；其余状态照常显示。
  const outcome = isSelf ? sendStateView(m.disposition).cls : null;
  const st = isSelf ? visibleSendState(m.disposition) : null;
  const who = personDisplayName(m.sender_name?.trim() || null, '') || m.sender_id?.trim() || (isSelf ? (acc ? accountLabel(acc) : roleLabel('merchant_self')) : m.sender_role === 'customer' ? conv.title : roleLabel(m.sender_role));
  return h(
    'div',
    { class: cx('msg', { mine: alignRight }), dataset: { mid: m.local_id ?? m.message_id ?? '', rowId: rowId(m), historyKey: messageHistoryKey(acc?.context ?? null, conv, m), ...(outcome ? { sendOutcome: outcome } : {}) } },
    h('div', { class: 'ava sm', style: { background: isSelf ? (acc?.color ?? '#5B6676') : conv.color } }, renderMessageAvatar(document, who, m.sender_avatar)),
    h(
      'div',
      { class: 'mcol' },
      h('div', { class: 'mmeta' }, who),
      quotePreview ? h('div', { class: 'quote-in' }, t('chat.quotePrefix'), quotePreview) : null,
      // 操作条贴着气泡：.bline 宽度随气泡收缩，操作条绝对定位在气泡外侧。
      h(
        'div',
        { class: cx('bline', { 'has-receipt': !!receipt }), oncontextmenu: (event: MouseEvent) => openMessageMenu(event, m, conv, acc), onkeydown: (event: KeyboardEvent) => { if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); const rect = (event.currentTarget as HTMLElement).getBoundingClientRect(); openMessageMenu(event, m, conv, acc, rect.left, rect.bottom); } }, tabindex: '0', 'aria-haspopup': 'menu' },
        body,
        receipt ? h('span', {
          class: cx('message-receipt', { 'receipt-read': receipt === 'read' }),
          dataset: { receipt, receiptSide: alignRight ? 'left' : 'right' },
          role: 'img', title: receipt === 'read' ? '已读' : '已送达', 'aria-label': receipt === 'read' ? '已读' : '已送达',
        }, icon(IC.check, 13), receipt === 'read' ? icon(IC.check, 13) : null) : null,
        h(
          'div',
          { class: 'macts' },
          h('button', { type: 'button', dataset: { msgAction: 'quote' }, 'aria-label': t('chat.quote'), title: t('chat.quote'), onclick: () => store.patch({ quote: m }) }, icon(IC.quote, 14)),
          m.kind === 'voice' && !m.text ? null : h('button', { type: 'button', dataset: { msgAction: 'copy' }, 'aria-label': t('chat.copy'), title: t('chat.copy'), onclick: () => copyText(m.text) }, icon(IC.copy, 14)),
        ),
      ),
      showTime ? h('div', { class: 'message-time' }, `${formatDate(m.create_time_ms)} ${formatClock(m.create_time_ms, true)}`) : null,
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
  );
}

function translationBar(s: MainState, conv: UiConversation): HTMLElement | null {
  const p = s.prefs;
  if (!p || !shouldShowTranslationBar(conv, !!p.assistant.enabled, !!p.assistant.outbound_translation, customerLanguage(conv, s.messages[conv.gid] ?? []))) return null;
  const direct = p.assistant.send_mode === 'send_direct';
  const sendKey = (p.keys?.send_key ?? 'enter') === 'enter' ? 'Enter' : 'Ctrl/⌘+Enter';
  const modeHint = s.attachment ? `${sendKey} 仅发送附件，文字保留` : direct ? `直接发送模式，此时按${sendKey}将直接发送输入框原文` : `替换草稿模式，此时按${sendKey}将直接${s.draft.trim() && !needsOutboundTranslation(s.draft) ? '发送输入框内容' : '发送译文'}`;
  const tr = s.translation;
  const account = activeAccount(s)?.context;
  const owner = account ? { ...account } : null;
  const draftVersion = s.draftVersion;
  const attachment = s.attachment;
  const applies = (): boolean => {
    const current = S();
    return !current.trBarOff && !!owner && stillActive(owner) && current.activeGid === conv.gid && current.draftVersion === draftVersion && current.translation === tr && current.attachment === attachment;
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
      h('button', { class: 'btn sm pri', dataset: { tr: 'retry', fid: 'tr:retry' } , onclick: () => { if (applies()) { void runPreviewTranslation(); } } }, t('tr.retry')),
    );
  } else if (direct) {
    bodyEl = h('div', { class: 'trprev wait', dataset: { trState: tr.status } }, tr.status === 'busy' ? h('span', { class: 'spin' }) : null, tr.status === 'busy' ? t('tr.busy') : '输入内容后，按发送键直接发送输入框原文。');
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
    { class: cx('trbar', { 'trbar-off': s.trBarOff }) },
    h(
      'div',
      { class: 'trrow trhead' },
      h('button', {
        type: 'button', class: 'tr-switch', role: 'switch', 'aria-label': '出站翻译', 'aria-checked': String(!s.trBarOff),
        onclick: () => {
          if (!owner || !stillActive(owner) || S().activeGid !== conv.gid) return;
          if (trTimer) clearTimeout(trTimer);
          trTimer = null;
          store.patch({ trBarOff: !S().trBarOff, translation: { ...TRANSLATION_IDLE, gid: conv.gid, target: translationTarget(S(), conv) } });
          scheduleTranslation();
        },
      }, h('span', { class: 'tr-switch-knob' })),
      h('span', { class: 'trlabel', style: { 'font-weight': '600' } }, t('tr.title')),
      h('span', { class: 'muted trlabel' }, t('tr.target')),
      h(
        'select',
        {
          class: 'sel',
          disabled: s.trBarOff,
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
      h('span', { class: 'muted trmode', style: { 'margin-left': 'auto' } }, s.trBarOff ? '翻译已关闭，发送输入框原文' : modeHint),
    ),
    s.trBarOff ? null : bodyEl,
  );
}

function ctool(id: string, label: string, glyph: string, options: { disabled?: boolean; on?: boolean; onclick: (e: Event) => void }): HTMLElement {
  return h('button', { type: 'button', class: cx('ctool', { on: !!options.on }), disabled: !!options.disabled, dataset: { tool: id, fid: `tool:${id}` }, onclick: options.onclick }, icon(glyph, 15), h('span', null, label));
}

function formatFileSize(size: number): string {
  return size < 1024 * 1024 ? `${Math.max(1, Math.round(size / 1024))} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function composerMoreMenu(s: MainState): HTMLElement | null {
  if (!s.composerMore) return null;
  const current = s.prefs?.assistant.send_mode ?? 'replace_draft';
  const option = (mode: 'replace_draft' | 'send_direct', label: string, desc: string) => h(
    'button',
    { type: 'button', class: 'mi mi-mode', role: 'menuitemradio', 'aria-checked': String(current === mode), dataset: { sendMode: mode }, onclick: () => void setSendMode(mode) },
    h('span', { class: 'mi-mode-t' }, h('b', null, label), h('span', { class: 'muted' }, desc)),
    current === mode ? icon(IC.check, 14, { style: 'color: var(--c-primary)' }) : null,
  );
  return h('div', { class: 'menu more-menu', role: 'menu', onmousedown: (e: Event) => e.stopPropagation() },
    h('div', { class: 'mhead' }, t('composer.trMode')),
    option('replace_draft', t('composer.modeReplace'), t('composer.modeReplaceDesc')),
    option('send_direct', t('composer.modeDirect'), t('composer.modeDirectDesc')));
}

function composer(s: MainState, conv: UiConversation): HTMLElement {
  const quote = selectedQuoteReference(s.quote, s.messages[conv.gid] ?? [], conv.gid);
  const finished = isDone(conv);
  // 已结束仍可输入、发送文字（发送会重新开启会话）；附件等待会话恢复后再发。转出锁定全部输入。
  const locked = composerLocked(conv);
  const media = s.attachment && isRegisteredMediaAttachment(s.attachment) ? s.attachment : null;
  const operation = s.mediaOperation?.attachment === s.attachment ? s.mediaOperation : null;
  const mediaLocked = !!operation && operation.status !== 'not_submitted';
  // Send barrier (I-04a): the host refuses sends while persistence is failed; the composer mirrors it.
  const saveBlocked = persistFailed(s.accounts);
  const mediaLabel = operation?.status === 'busy' ? ({ prepare: '正在准备附件…', upload: '正在上传附件…', send: '正在提交附件消息…' } as const)[operation.stage]
    : operation?.error ?? (media ? '仅发送附件，文字/引用保留。' : s.attachment ? ATTACHMENT_SEND_UNAVAILABLE : '');
  const trOn = translationOn(s, conv);
  const direct = s.prefs?.assistant.send_mode === 'send_direct' && trOn;
  const sendKey = s.prefs?.keys.send_key ?? 'enter';
  return h(
    'div',
    { class: 'composer' },
    translationBar(s, conv),
    !trOn && s.quickReplies?.mode === 'suggestions' ? quickRepliesView(s.quickReplies, replyContext(), quickReplies) : null,
    h(
      'div',
      { class: 'ctools', role: 'toolbar', 'aria-label': '消息工具' },
      ctool('emoji', t('composer.emoji'), IC.smile, { disabled: locked, on: s.emoOpen, onclick: (e: Event) => { e.stopPropagation(); store.patch({ emoOpen: !S().emoOpen, composerMore: false }); } }),
      ctool('image', t('composer.image'), IC.image, { disabled: finished || mediaLocked, onclick: () => void attach('image') }),
      ctool('file', t('composer.file'), IC.file, { disabled: finished || mediaLocked, onclick: () => void attach('file') }),
      ctool('phrases', t('composer.phrases'), IC.chat, { onclick: () => openPeripheral('scripts') }),
      ctool('recommend', t('composer.recommend'), IC.box, { disabled: locked, onclick: () => openRecommendations() }),
      ctool('hide-tr', s.hideInboundTr ? t('composer.showTr') : t('composer.hideTr'), IC.translate, { on: s.hideInboundTr, onclick: () => store.patch({ hideInboundTr: !S().hideInboundTr }) }),
      h('span', { class: 'sp' }),
      h('button', { type: 'button', class: cx('ibtn', { on: s.composerMore }), 'aria-label': t('composer.more'), title: t('composer.more'), 'aria-haspopup': 'menu', 'aria-expanded': String(s.composerMore), dataset: { tool: 'more', fid: 'tool:more' }, onmousedown: (e: Event) => e.stopPropagation(), onclick: () => store.patch({ composerMore: !S().composerMore, emoOpen: false }) }, icon(IC.more, 18)),
      composerMoreMenu(s),
    ),
    quote ? h('div', { class: 'quote-bar' }, h('span', { style: { flex: '1', overflow: 'hidden', 'white-space': 'nowrap', 'text-overflow': 'ellipsis' } }, t('chat.quotePrefix'), quote.text), h('button', { class: 'ibtn', style: { width: '22px', height: '22px' }, 'aria-label': t('chat.cancelQuote'), onclick: () => store.patch({ quote: null }) }, icon(IC.close, 12))) : null,
    s.attachment ? h('div', { class: 'attach', title: mediaLabel, dataset: { mediaStatus: operation?.status ?? (media ? 'ready' : 'unsupported') } }, operation?.status === 'busy' ? h('span', { class: 'spin' }) : media?.preview_data_url ? h('img', { class: 'attach-thumb', src: media.preview_data_url, alt: '' }) : h('span', { class: 'attach-icon' }, icon(IC.file, 20)), h('span', { class: 'attach-t', role: 'status', 'aria-live': 'polite' }, h('span', { class: 'attach-name' }, s.attachment.name), h('span', { class: 'attach-meta' }, [media ? formatFileSize(media.size) : '', mediaLabel].filter(Boolean).join(' · '))), h('button', { class: 'ibtn', style: { width: '22px', height: '22px' }, 'aria-label': t('composer.removeAttach'), title: operation && operation.status !== 'not_submitted' ? '仅移除本地选择，不会撤回已上传或提交的消息。' : '移除本地附件', disabled: operation?.status === 'busy', onclick: () => void removeAttachment(s.attachment!) }, icon(IC.close, 12))) : null,
    h('textarea', {
      class: 'ta',
      placeholder: locked ? t('composer.placeholderLocked') : finished ? t('composer.placeholderFinished') : t('composer.placeholder'),
      'aria-label': '输入消息',
      value: s.draft,
      disabled: locked,
      // key 随作废次数变化：被作废（失焦/过期的输入法会话）的节点不会被增量渲染复用。
      dataset: { fid: 'draft', key: `draft:${composerInput.revision()}` },
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
    h('div', { class: 'cfoot' }, h('span', { class: cx('hint', { 'hint-bad': saveBlocked }), ...(saveBlocked ? { role: 'status', dataset: { persistFailed: '1' } } : {}) }, saveBlocked ? t('composer.persistFailed') : media ? `${sendKey === 'enter' ? 'Enter' : 'Ctrl/⌘+Enter'} 仅发送附件，文字/引用保留` : trOn ? `${sendKey === 'enter' ? 'Enter' : 'Ctrl/⌘+Enter'} ${direct ? '发送输入框原文' : needsOutboundTranslation(s.draft) ? '发送译文' : '发送输入框内容'} · ${sendKey === 'enter' ? 'Shift+Enter' : 'Enter'} 换行` : sendKey === 'enter' ? t('composer.hintEnter') : t('composer.hintCtrlEnter')), h('button', { class: 'btn pri', dataset: { action: 'send' }, disabled: locked || (finished && !!s.attachment) || mediaLocked || saveBlocked, onclick: () => { if (!composerInput.active()) void handleSend(); } }, icon(IC.send, 14), media ? '发送附件' : t('composer.send'))),
  );
}

function emojiPicker(s: MainState): HTMLElement | null {
  if (!s.emoOpen) return null;
  return h(
    'div',
    { class: 'emo', onmousedown: (e: Event) => e.stopPropagation() },
    h('div', { class: 'emo-grid' }, EMOJI.map((ch) => h('button', { 'aria-label': t('composer.insertEmoji'), onclick: () => { setDraft(S().draft + ch); store.patch({ emoOpen: false }); } }, ch))),
    h('button', { type: 'button', class: 'emo-library', onclick: () => { const account=activeAccount()?.context, gid=S().activeGid; store.patch({emoOpen:false}); if(account && gid) void savedEmojiPanel.open(account,gid); } }, icon(IC.image,16), '我的表情'),
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
    cacheKey: [view, s.pkgOpen, s.pkgHot, s.tsimStatus, conv, s.messages[conv.gid]],
    refresh: () => { if (applies()) void refreshPackages(); },
    toggle: () => store.patch({ pkgOpen: !S().pkgOpen }),
    copy: (value) => { if (applies()) void copyText(value, '已复制'); },
  }, h, icon);
}

function sidePanel(s: MainState, conv: UiConversation): HTMLElement {
  const o = conv.order;
  return h(
    'aside',
    { class: 'side' },
    h(
      'div',
      { class: 'sbody', dataset: { keepScroll: 'side' } },
      o
        ? orderInfoSection({ order: o, hot: s.hotOrder, labels: { copy: t('side.copyOrder'), pcDetail: t('side.pcDetail') },
            copy: () => void copyText(o.order_id, t('side.orderCopied')), pcDetail: () => void openWebAdvanced(o),
            queryTsim: () => void tsimOrder.open(conv.gid) }, h, icon, IC.copy)
        : h('div', { class: 'muted', style: { 'font-size': '12px' } }, t('side.noOrder')),
    ),
    h('div', { class: 'package-dock' }, packageCard(s, conv)),
  );
}

// Retain the expensive message subtree across draft, sidebar and unrelated updates.
// Only one active pane is retained, so old accounts/rooms do not accumulate DOM caches.
interface MountedRow { readonly node: HTMLElement; readonly message: UiMessage; readonly quote: unknown; readonly source: unknown }
let messagePaneCache: { deps: readonly unknown[]; rowDeps: readonly unknown[]; msgs: readonly UiMessage[]; win: PaneWindow; node: HTMLElement; rows: Map<string, MountedRow> } | undefined;
function messagePane(s: MainState, conv: UiConversation, acc: UiAccount | null, pinned: boolean): HTMLElement {
  const history = s.history[conv.gid];
  const thread = s.messages[conv.gid] ?? [];
  const deps = [s.messages[conv.gid], history, conv, acc, s.prefs, s.hideInboundTr, s.inboundTrRevision, s.tsimStatus];
  const sameInputs = !!messagePaneCache && deps.every((value, i) => value === messagePaneCache!.deps[i]);
  const scope = historyScopeKey(acc?.context ?? null, conv.gid);
  const mountedPane = document.querySelector<HTMLElement>('[data-keep-scroll="msgs"]');
  const msgs = sameInputs ? messagePaneCache!.msgs : visibleMessages(s.messages[conv.gid] ?? []);
  const view = s.messageView?.scope === scope ? s.messageView : undefined;
  // The window is planned on every render (cheap: the layout is cached) so the model always describes the
  // mounted pane; the rows are rebuilt only when the inputs or the window itself changed, not on every
  // persisted `{top, anchor}` of the same window.
  const win = messagePaneModel.plan({ scope, list: msgs, view, pinned, anchor: liveAnchor ?? view?.anchor ?? null, retained: mountedPane?.dataset['historyScope'] === scope, runway: history?.hasMore && !history.pageError ? HISTORY_RUNWAY : 0 });
  if (sameInputs && sameWindow(win, messagePaneCache!.win)) {
    messagePaneCache!.node.dataset['scrollBottom'] = pinned ? '1' : '0';
    return messagePaneCache!.node;
  }
  // Rows depend on these and on their own message; paging state and the rest of the thread only touch the rows that say so.
  const rowDeps = [scope, conv, acc, s.prefs, s.hideInboundTr, s.inboundTrRevision, s.tsimStatus];
  const previousRows = messagePaneCache && rowDeps.every((value, i) => value === messagePaneCache!.rowDeps[i]) ? messagePaneCache.rows : null;
  const rows = new Map<string, MountedRow>();
  const spacer = (kind: 'top' | 'bottom', height: number): HTMLElement => h('div', { class: 'msgs-spacer', 'aria-hidden': 'true', dataset: { msgSpacer: kind }, style: { height: `${height}px`, flex: 'none' } });
  const node = h('div', { class: 'msgs', dataset: { keepScroll: 'msgs', scrollBottom: pinned ? '1' : '0', thread: conv.gid, historyScope: scope, readContextRevision: s.history[conv.gid]?.readContextRevision ?? '' } },
      history?.firstPage === 'loading' ? h('div', { class: 'history-more', role: 'status' }, '正在读取聊天记录…') : null,
      history?.firstPage === 'error' ? h('button', { class: 'history-more', dataset: { history: 'retry', fid: 'history:retry' }, onclick: () => void openConversation(conv.gid) }, '聊天记录读取失败或超时，点击重试') : null,
      spacer('top', win.topSpacer),
      // Sits directly above the first row, below the runway; away from the head there is nothing to show.
      history?.hasMore && win.range.start === 0 ? h('button', { class: 'history-more', disabled: history.busy, dataset: { history: 'earlier', fid: 'history:earlier' }, onclick: () => void loadEarlier(conv) }, history.busy ? '加载中…' : history.pageError ? '历史记录读取失败或超时，点击重试' : '加载更早消息') : null,
      msgs.slice(win.range.start, win.range.end).map((m) => {
        // 换窗或翻页：窗口内仍在且输入未变的行直接沿用上次的节点（增量渲染原地保留），只构建新进入窗口的行。
        const id = rowId(m);
        const quote = messageQuotePreview(m, thread);
        // ICCID 高亮按钮绑定读取时的消息快照，快照一换就必须重建，其余行不依赖它。
        const source = highlightParts(m.text).some(part => part.kind !== 'plain') ? s.messages[conv.gid] : null;
        const kept = previousRows?.get(id);
        const row = kept && kept.message === m && kept.quote === quote && kept.source === source ? kept : { node: messageRow(s, m, conv, acc), message: m, quote, source };
        rows.set(id, row);
        return row.node;
      }),
      win.range.end < msgs.length ? spacer('bottom', win.bottomSpacer) : null);
  messagePaneCache = { deps, rowDeps, msgs, win, node, rows };
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
  const sub = [isDone(conv) ? '会话已结束，无法管理成员' : waiting ? t('chat.waiting', { t: formatDuration(waitedSeconds(conv, s.now)) }) : ''].filter(Boolean).join(' · ');
  const pills = memberPillsFor(acc, conv);
  return h(
    'div',
    { class: 'chat' },
    part('chatHeader', () => h(
      'div',
      { class: 'chat-h' },
      h('div', { class: 'ava sm', style: { background: conv.color } }, renderMessageAvatar(document, conv.title, conv.customer_avatar)),
      h('div', { class: 'chat-title' }, h('div', { class: 'chat-name' }, h('span', { class: 'chat-name-text', title: conv.title }, conv.title), pills.count !== null ? h('span', { class: 'chip chip-members', title: t('chat.memberCountLabel', { n: pills.count }), 'aria-label': t('chat.memberCountLabel', { n: pills.count }) }, t('chat.memberCount', { n: pills.count })) : null, pills.isMaster ? masterPill() : null, customerLanguage(conv, s.messages[conv.gid] ?? EMPTY_MESSAGES) !== 'zh' ? h('span', { class: 'chip chip-lang' }, t('chat.lang', { lang: langName(customerLanguage(conv, s.messages[conv.gid] ?? EMPTY_MESSAGES)) })) : null), sub ? h('div', { class: 'chat-sub', dataset: { chatWaitingGid: conv.gid } }, sub) : null),
      h('button', { class: 'btn sm', disabled: isDone(conv), dataset: { chatAct: 'end', fid: 'chat-act:end' } , onclick: () => openPeripheral('finish') }, icon(IC.exit, 14), t('chat.end')),
      h('button', { class: 'btn sm', 'aria-label': '成员管理', disabled: isDone(conv), title: isDone(conv) ? '会话已结束，无法管理成员' : '成员管理', dataset: { chatAct: 'members', fid: 'chat-act:members' } , onclick: () => openPeripheral('members') }, icon(IC.users, 17), '成员管理'),
      h('button', { class: cx('ibtn', { on: s.sideOpen }), title: t('chat.side'), 'aria-label': t('chat.toggleSide'), dataset: { chatAct: 'side', fid: 'chat-act:side' } , onclick: () => store.patch({ sideOpen: !S().sideOpen }) }, icon(IC.sidebar, 17)),
    )),
    netView(s.net, netEverConnected).offline ? h('div', { class: 'netbar', style: { margin: '8px 16px 0' } }, t('chat.offlineNotice')) : null,
    // 插槽内容直接参与同一次渲染：morph 不再先清空再由另一帧填回（每帧多一次布局失效，且测量时横幅缺席）。
    h('div', { dataset: { featureSlot: 'conversation-banner' } }, featureRuntime.renderSlot('conversation-banner')),
    messagePane(s, conv, acc, pinned),
    h('div', { dataset: { featureSlot: 'composer-hint' } }, featureRuntime.renderSlot('composer-hint')),
    part('composer', () => composer(s, conv)),
    part('emojiPicker', () => emojiPicker(s)),
  );
}

function messagesView(s: MainState): HTMLElement {
  const conv = activeConv(s);
  // 列宽变量作为 props 输出，与控制器写进活节点的一致；否则 morph 每帧先删 style 再由 ref 写回，强制一次同步布局。
  return h('div', { class: 'content message-columns', dataset: { sideOpen: String(!!conv && s.sideOpen) }, style: workspaceColumns.rootStyle(), ref: workspaceColumns.attach },
    conversationList(s), workspaceColumns.separator('left'), chatPane(s),
    conv && s.sideOpen ? [workspaceColumns.separator('right'), part('sidePanel', () => sidePanel(s, conv))] : null);
}

// ---- notifications view

function notificationsView(s: MainState): HTMLElement {
  const cat = s.noticeCats.find((c) => c.id === s.noticeCat) ?? null;
  const { visible, hidden } = splitCategories(s.noticeCats, ignoredNoticeCats(s));
  const catIcons: Record<string, string> = { order: IC.order, product: IC.box, finance: IC.coin, system: IC.megaphone };
  return h(
    'div',
    { class: 'content' },
    h(
      'div',
      { class: 'ncat' },
      h('div', { class: 'ncat-title' }, t('notice.title')),
      visible.map((c) => h('button', { class: cx('ncat-i', { on: c.id === s.noticeCat }), dataset: { cat: c.id }, title: '右键可设置横幅提醒或忽略此分类', onclick: () => void pickNoticeCat(c.id), oncontextmenu: (e: MouseEvent) => openNoticeCatMenu(e, c, false) }, icon(catIcons[c.id] ?? IC.bell, 16), h('span', { style: { flex: '1' } }, c.name), noticeBannerCats(s).includes(c.id) ? h('span', { class: 'ncat-banner', title: '已开启横幅提醒', dataset: { catBanner: c.id } }, icon(IC.bell, 12)) : null, accBadge(c.unread))),
      hidden.length ? h('div', { class: 'ncat-ignored', dataset: { ncatIgnored: String(hidden.length) } },
        h('button', { type: 'button', class: 'ncat-ignored-head', 'aria-expanded': String(s.noticeIgnoredOpen), onclick: () => store.patch({ noticeIgnoredOpen: !S().noticeIgnoredOpen }) }, icon(s.noticeIgnoredOpen ? IC.chevDown : IC.chevRight, 12), `已忽略的分类（${hidden.length}）`),
        s.noticeIgnoredOpen ? hidden.map((c) => h('div', { class: 'ncat-i ignored', dataset: { catIgnored: c.id }, oncontextmenu: (e: MouseEvent) => openNoticeCatMenu(e, c, true) },
          icon(catIcons[c.id] ?? IC.bell, 16), h('span', { style: { flex: '1' } }, c.name), h('button', { type: 'button', class: 'link', dataset: { action: 'unignore-cat' }, onclick: () => setNoticeCatIgnored(c.id, false) }, '恢复'))) : null,
      ) : null,
      s.noticeCatsStatus === 'loading' ? h('div', { class: 'empty', role: 'status' }, '正在加载通知分类…') : null,
      s.noticeCatsStatus === 'error' || s.noticeCatsStatus === 'expired' ? h('div', { class: 'notice-box err', role: 'alert' }, s.noticeCatsStatus === 'expired' ? '登录已过期，请重新登录。' : '通知分类加载失败：', s.noticeCatsError, ' ', h('button', { class: 'link', onclick: () => { const account = activeAccount(); if (s.noticeCatsStatus === 'expired' && account) void startLogin(account.context); else void noticeQuery.categories(); } }, s.noticeCatsStatus === 'expired' ? '重新登录' : '重试')) : null,
      s.noticeCatsStatus === 'loaded' && s.noticeCats.length === 0 ? h('div', { class: 'empty' }, '暂无通知分类') : null,
      s.noticeCatsStatus === 'loaded' && s.noticeCats.length > 0 && visible.length === 0 ? h('div', { class: 'empty' }, '所有分类均已忽略') : null,
    ),
    h(
      'div',
      { class: 'nlist' },
      h('div', { class: 'ph' }, h('span', null, cat ? cat.name : t('notice.title'), cat && cat.unread > 0 ? h('span', { class: 'muted', style: { 'font-size': '12px', 'font-weight': '400', 'margin-left': '8px' } }, t('notice.unread', { n: cat.unread })) : null), h('button', { class: 'btn sm', dataset: { action: 'mark-all' }, disabled: !cat || s.noticeListStatus !== 'loaded' || !s.notices.some(n => n.unread), onclick: () => void markAllNotices() }, t('notice.markAll')), h('button', { class: 'btn sm', dataset: { action: 'refresh-notices' }, onclick: () => void noticeQuery.categories() }, '刷新')),
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
        s.noticeMoreStatus === 'error' || s.noticeMoreStatus === 'expired' ? h('div', { class: 'notice-box err', role: 'alert' }, s.noticeMoreStatus === 'expired' ? '登录已过期，请重新登录。' : '更多通知加载失败：', s.noticeMoreError, ' ', h('button', { class: 'link', onclick: () => { const account = activeAccount(); if (s.noticeMoreStatus === 'expired' && account) void startLogin(account.context); else void noticeQuery.more(); } }, s.noticeMoreStatus === 'expired' ? '重新登录' : '重试')) : null,
        s.noticeHasMore && s.noticeMoreStatus !== 'error' && s.noticeMoreStatus !== 'expired' ? h('button', { class: 'btn sm', dataset: { action: 'more-notices' }, disabled: s.noticeMoreStatus === 'loading', onclick: () => void noticeQuery.more() }, s.noticeMoreStatus === 'loading' ? '正在加载…' : '加载更多') : null,
        s.noticeListStatus === 'loading' ? h('div', { class: 'empty', role: 'status' }, '正在加载通知…') : null,
        s.noticeListStatus === 'error' || s.noticeListStatus === 'expired' ? h('div', { class: 'notice-box err', role: 'alert' }, s.noticeListStatus === 'expired' ? '登录已过期，请重新登录。' : '通知加载失败：', s.noticeListError, ' ', h('button', { class: 'link', onclick: () => { const account = activeAccount(); if (s.noticeListStatus === 'expired' && account) void startLogin(account.context); else void noticeQuery.list(); } }, s.noticeListStatus === 'expired' ? '重新登录' : '重试')) : null,
        s.noticeCat && s.noticeListStatus === 'loaded' && s.notices.length === 0 ? h('div', { class: 'empty', style: { margin: '16px' } }, t('notice.empty')) : null,
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
  else if (st.kind === 'failed') result = h('div', { class: 'notice-box err', dataset: { orderState: 'failed' } }, t('order.failed'), st.message ? ` （${st.message}）` : '');
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
  if (s.banners.length === 0 || s.activeWeb) return null;
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
  const nv = netView(s.net, netEverConnected);
  const pf = persistFailedView(s.accounts);
  const hasAccount = !!activeAccount(s);
  // morph 下新建的 span 可能被折叠进页面上的旧 span：经 ref 拿到真正留在页面上的那个给时钟定时器用。
  const clock = h('span', { class: 'sb-clock', ref: (el: Element) => { clockEl = el as HTMLElement; } }, `${formatDate(s.now)} ${formatClock(s.now, true)}`);
  return h(
    'div',
    { class: 'statusbar', role: 'status' },
    hasAccount ? h('span', { class: 'sb-item', dataset: { sb: 'agent', known: String(av.known) } }, h('span', { class: 'dot', style: { background: `var(${av.colorVar})` } }), av.label, av.known ? h('span', { class: 'muted' }, ` · ${t('status.readback')}`) : null) : null,
    h('span', { class: cx('sb-item', { 'sb-bad': nv.offline, 'sb-muted': !nv.ok && !nv.offline }), dataset: { sb: 'net' } }, icon(nv.ok ? IC.wifi : IC.wifiOff, 13), nv.label),
    s.alarmCount > 0 ? h('span', { class: 'sb-item sb-alarm', dataset: { sb: 'alarm' } }, icon(IC.clock, 13), t('bar.alarmCount', { n: s.alarmCount })) : null,
    // Send barrier (I-04a): host-reported, cleared by the host when a retry lands.
    pf ? h('span', { class: 'sb-item sb-bad', role: 'alert', title: pf.title, dataset: { sb: 'persist-failed' } }, icon(IC.alert, 13), pf.label) : null,
    h('button', { class: 'link sb-diagnostics', disabled: !hasAccount, dataset: { action: 'unknown-outbound' }, onclick: openUnknownOutbound }, '未知发送核验'),
    h('button', { class: 'link sb-diagnostics', dataset: { action: 'receive-diagnostics' }, onclick: () => void receiveDiagnostics.open() }, '接收诊断'),
    h('span', { class: 'sp' }),
    sel.mock ? h('span', { class: 'sb-item muted' }, t('app.mockMode')) : null,
    s.clockTrusted ? null : h('span', { class: 'sb-item sb-warn', title: t('bar.clockUntrustedTitle'), dataset: { sb: 'clock-untrusted' } }, icon(IC.alert, 13), t('bar.clockUntrusted')),
    clock,
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
  const titles: Record<PeripheralKind, string> = { members: '成员管理', scripts: '快捷话术', invite: '成员管理', transfer: '成员管理', finish: '结束会话' };
  const title = titles[d.kind];
  const managing = d.kind === 'members' || d.kind === 'invite' || d.kind === 'transfer';
  const target = activeConv(s)?.title || d.scope.gid;
  const writable = d.kind === 'invite' || d.kind === 'transfer' || d.kind === 'finish';
  const selection = d.kind === 'invite' ? d.candidates : d.members;
  const selectedExpired = selection?.expires_at_ms ?? 0;
  const expired = selectedExpired > 0 && selectedExpired <= s.now;
  const tokenReady = !!selection?.selection_token?.trim() && Number.isFinite(selectedExpired) && selectedExpired > s.now;
  const result = d.write?.kind === 'not_submitted'
    ? { title: '尚未提交', message: managing ? '本次操作尚未提交，成员状态更新后可再次选择。' : '未进入上游写入。请只读刷新成员和会话后，再次确认。', confirmed: false }
    : d.write ? peripheralWriteView(d.write) : null;
  const memberRows = d.members?.members ?? [];
  const transferRows = d.kind === 'transfer' ? memberRows.filter((member) => member.can_transfer === true) : memberRows;
  const submitDisabled = d.busy || d.refreshing || d.submitted || !tokenReady || (d.kind !== 'finish' && d.selected.length === 0);
  const locked = d.busy || d.refreshing || d.submitted || !tokenReady;
  let body: Node;
  let actions: Node[] = [];
  if (d.kind === 'scripts') {
    body = h('div', { class: 'peripheral-body' },
      h('form', { class: 'peripheral-search', onsubmit: (e: Event) => { e.preventDefault(); void peripheral.refresh(undefined, S().scriptsQuery); } },
        h('input', { class: 'inp', 'aria-label': '搜索话术', placeholder: '搜索话术', value: s.scriptsQuery, dataset: { fid: 'scripts-search' }, oninput: (e: Event) => store.patch({ scriptsQuery: (e.target as HTMLInputElement).value }) }),
        h('button', { class: 'btn', type: 'submit', disabled: d.busy }, '搜索')),
      d.scripts?.kind === 'empty' ? h('p', { class: 'peripheral-empty' }, '暂无可用话术') : null,
      d.scripts?.kind === 'unsupported' ? h('div', { class: 'notice-box' }, '返回了话术条目，但内容格式尚未验证，暂不支持插入或发送。') : null);
  } else if (d.kind === 'invite') {
    const agents = filteredInviteAgents(d);
    const picked: UiInviteAgent[] = d.selected.map((uid) => d.known?.[uid] ?? d.candidates?.agents.find((agent) => agent.uid === uid) ?? { uid, nickname: null });
    body = h('div', { class: 'peripheral-body invite-body' },
      h('form', { class: 'peripheral-search', onsubmit: (e: Event) => { e.preventDefault(); void peripheral.refresh(undefined, S().inviteQuery); } },
        h('input', { class: 'inp', type: 'search', 'aria-label': '搜索成员或部门', placeholder: '搜索成员或部门', maxlength: '50', value: s.inviteQuery, dataset: { fid: 'invite-search' }, oninput: (e: Event) => { const v = (e.target as HTMLInputElement).value; store.patch({ inviteQuery: v }); if (!v && S().peripheral?.query) void peripheral.refresh(undefined, ''); } }),
        h('button', { class: 'btn', type: 'submit', disabled: d.busy }, '搜索')),
      h('div', { class: 'invite-filters' },
        h('label', { class: 'invite-online-filter' },
          h('input', { type: 'checkbox', checked: d.onlineOnly, disabled: d.submitted, onchange: (e: Event) => peripheral.setOnlineOnly((e.target as HTMLInputElement).checked) }),
          h('span', null, '仅看在线/挂起/离开')),
        h('label', { class: 'invite-role-filter' }, h('span', null, '角色'),
          h('select', { class: 'inp', 'aria-label': '筛选成员角色', value: d.roleFilter, disabled: d.submitted, onchange: (e: Event) => peripheral.setRoleFilter((e.target as HTMLSelectElement).value) },
            [['all', '全部角色'], ['4', '客服'], ['1', '管理员'], ['3', '运营'], ['2', '财务'], ['unknown', '其他角色']].map(([value, label]) => h('option', { value, selected: d.roleFilter === value }, label)))),
        h('span', { class: 'invite-department-scope' }, '全部部门')),
      h('div', { class: 'invite-columns' },
        h('div', { class: 'peripheral-list invite-tree', role: 'group', 'aria-label': '可邀请成员' },
          h('div', { class: 'invite-tree-h' }, h('span', null, '可邀请成员'), h('span', null, `${agents.length} 人`)),
          agents.map((agent) => inviteAgentRow(d, agent, expired)),
          !d.busy && (d.tree || d.candidates) && agents.length === 0 ? h('p', { class: 'peripheral-empty' }, d.onlineOnly ? '暂无符合条件的在线、挂起或离开成员' : '没有符合条件的成员') : null),
        h('div', { class: 'peripheral-list invite-picked', 'aria-label': '已选成员' },
          h('div', { class: 'invite-tree-h' }, h('span', null, '已选成员'), h('span', null, `${picked.length} 人`)),
          picked.length === 0 ? h('p', { class: 'peripheral-empty' }, '请从左侧选择成员') : null,
          picked.map((agent) => h('div', { class: 'peripheral-member invite-picked-agent' },
            h('span', { class: 'ava sm', 'aria-hidden': 'true' }, renderMessageAvatar(document, personDisplayName(agent.nickname, agent.uid), agent.avatar)),
            h('span', { class: 'invite-agent-main' }, h('b', null, personDisplayName(agent.nickname, agent.uid)), invitePresence(agent)),
            h('button', { class: 'ibtn', type: 'button', 'aria-label': `取消选择${personDisplayName(agent.nickname, agent.uid)}`, disabled: d.busy || d.submitted, onclick: () => peripheral.select(agent.uid) }, icon(IC.close, 12)))))));
  } else if (d.kind === 'finish') {
    body = h('div', { class: 'peripheral-body' },
      h('p', null, '确认结束当前服务会话？'),
      h('p', { class: 'muted' }, '请先确认客户已得到回复，并完成必要的主客服交接。结束后以服务器读回的会话状态为准。'));
  } else {
    const manage = d.kind === 'members';
    const selfMaster = d.members?.self_is_master === true;
    const canTransfer = memberRows.some((m) => m.can_transfer);
    const canRemove = memberRows.some((m) => m.can_remove === true);
    const selectedRows = memberRows.filter((m) => d.selected.includes(m.uid));
    body = h('div', { class: 'peripheral-body' },
      manage ? h('div', { class: 'members-bar' },
        h('span', { class: 'member-num' }, `当前成员 · ${memberRows.length}`),
        d.selected.length ? h('span', { class: 'muted' }, `已选 ${d.selected.length} 人`) : null) : null,
      d.kind === 'transfer' ? h('p', { class: 'muted' }, '选择一位当前可接任的成员。可转交范围由服务器核验。') : null,
      manage && d.selected.length > 1 && selectedRows.every((m) => m.can_transfer) && canTransfer ? h('p', { class: 'muted' }, '转移主客服目标仅可为一人') : null,
      h('div', { class: 'peripheral-list', role: d.kind === 'transfer' ? 'radiogroup' : 'list', 'aria-label': title }, transferRows.map((member) => {
        const role = member.role ?? (member.roles?.[1] === 4 ? 'master' : 'other');
        const checkable = manage && (member.can_transfer || member.can_remove === true);
        return h(d.kind === 'transfer' || checkable ? 'label' : 'div', { class: cx('peripheral-member', { 'is-master': role === 'master' }), ...(manage ? { role: 'listitem' } : {}) },
          d.kind === 'transfer' ? h('input', { type: 'radio', name: 'transfer-member', checked: d.selected.includes(member.uid), disabled: d.busy || d.submitted || expired, onchange: () => peripheral.select(member.uid) }) : null,
          checkable ? h('input', { type: 'checkbox', 'aria-label': `选择${personDisplayName(member.nickname, member.uid)}`, checked: d.selected.includes(member.uid), disabled: d.busy || d.submitted || expired, onchange: () => peripheral.select(member.uid) }) : manage ? h('span', { class: 'member-check-space', 'aria-hidden': 'true' }) : null,
          h('span', { class: cx('ava sm', { lord: role === 'master' }), 'aria-hidden': 'true' }, renderMessageAvatar(document, personDisplayName(member.nickname, member.uid), member.avatar)),
          h('span', { class: 'member-name' }, h('b', null, personDisplayName(member.nickname, member.uid), member.is_self ? '（我）' : '')),
          h('span', { class: cx('peripheral-member-status', `role-${role}`) }, MEMBER_ROLE[role]));
      })),
      !d.busy && d.members && transferRows.length === 0 ? h('p', { class: 'peripheral-empty' }, d.kind === 'transfer' ? '当前没有可转交的成员' : '未返回会话成员') : null,
      manage && d.members && !selfMaster ? h('p', { class: 'muted' }, '仅主客服可以转移主客服或移除成员。') : null,
      manage && d.confirming === 'remove' ? h('div', { class: 'notice-box peripheral-note', role: 'alertdialog', 'aria-label': '确认移除' },
        h('b', null, '确定要移除会话成员？'),
        h('p', null, selectedRows.map((m) => personDisplayName(m.nickname, m.uid)).join('、')),
        h('div', { class: 'dlg-f' },
          h('button', { class: 'btn', onclick: () => peripheral.confirmRemove(false) }, '取消'),
          h('button', { class: 'btn danger', disabled: locked, dataset: { action: 'peripheral-remove-confirm' }, onclick: () => void peripheral.submit('remove') }, '确认移除'))) : null);
    if (manage && !d.submitted) actions = [
      canTransfer ? h('button', { class: 'btn', disabled: locked || d.selected.length !== 1 || !selectedRows.every((m) => m.can_transfer), dataset: { action: 'peripheral-members-transfer' }, onclick: () => void peripheral.submit('transfer') }, '设为主客服') : null,
      canRemove ? h('button', { class: 'btn danger', disabled: locked || d.selected.length === 0 || !selectedRows.every((m) => m.can_remove === true) || d.confirming === 'remove', dataset: { action: 'peripheral-members-remove' }, onclick: () => peripheral.confirmRemove(true) }, '移除成员') : null,
    ].filter((n): n is HTMLButtonElement => n !== null);
  }
  return h('div', { class: 'shade peripheral-shade', onclick: () => peripheral.close() },
    h('div', { class: cx('dlg peripheral-dialog', { 'peripheral-wide': managing, 'member-management': managing }), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'peripheral-title', tabindex: '-1', dataset: { peripheralDialog: d.kind }, onclick: (e: Event) => e.stopPropagation() },
      h('div', { class: 'dlg-h' }, h('span', { id: 'peripheral-title' }, title), h('button', { class: 'ibtn', 'aria-label': '关闭对话框', onclick: () => peripheral.close() }, icon(IC.close, 16))),
      h('div', { class: 'peripheral-context' }, h('span', null, target), managing ? h('span', { class: 'member-auto-update' }, d.busy || d.refreshing ? '更新中…' : '自动更新') : null),
      managing ? h('nav', { class: 'member-tabs', 'aria-label': '成员管理功能' },
        h('button', { class: cx('member-tab', { on: d.kind !== 'invite' }), 'aria-current': d.kind !== 'invite' ? 'page' : undefined, disabled: d.busy, onclick: () => openPeripheral('members') }, icon(IC.users, 16), '当前成员'),
        h('button', { class: cx('member-tab', { on: d.kind === 'invite' }), 'aria-current': d.kind === 'invite' ? 'page' : undefined, disabled: d.busy || !!activeConv(s) && isDone(activeConv(s)!), onclick: () => openPeripheral('invite') }, icon(IC.userPlus, 16), '邀请成员')) : null,
      body,
      d.busy ? h('div', { class: 'peripheral-note', role: 'status' }, h('span', { class: 'spin' }), d.submitted ? '正在提交，请勿重复操作…' : '正在只读加载…') : null,
      d.error ? h('div', { class: 'notice-box err peripheral-note', role: 'alert' }, d.error) : null,
      d.notice || expired ? h('div', { class: 'notice-box peripheral-note', role: 'status' }, d.notice || (managing ? '成员状态已过期，正在自动更新…' : '候选已过期。请只读刷新后重新选择。')) : null,
      result ? h('div', { class: cx('notice-box', 'peripheral-note', { 'peripheral-confirmed': result.confirmed }), role: 'status' }, h('b', null, result.title), h('p', null, result.message)) : null,
      h('div', { class: 'dlg-f' },
        !managing ? h('button', { class: 'btn', disabled: d.busy, onclick: () => void peripheral.refresh(undefined, d.kind === 'scripts' ? S().scriptsQuery : '') }, d.kind === 'scripts' ? '刷新话术' : '刷新') : null,
        ...actions,
        h('button', { class: 'btn', onclick: () => peripheral.close() }, '关闭'),
        writable && !d.submitted ? h('button', { class: 'btn pri', disabled: submitDisabled, dataset: { action: `peripheral-${d.kind}-confirm` }, onclick: () => void peripheral.submit() }, d.kind === 'finish' ? '确认结束' : d.kind === 'transfer' ? '确认转交' : `确认邀请${d.selected.length ? `（${d.selected.length}）` : ''}`) : null)));
}

/** Official imWindow DE/Fh chat status: 0 在线 ico_free, 1 挂起, 2 离开, 3 下班. */
const AGENT_CHAT_STATUS: Record<number, { readonly name: string; readonly cls: string }> = {
  0: { name: '在线', cls: 'free' }, 1: { name: '挂起', cls: 'busy' }, 2: { name: '离开', cls: 'leave' }, 3: { name: '下班', cls: 'exit' },
};
const JOB_POSITION: Record<number, string> = { 1: '管理员', 2: '财务', 3: '运营', 4: '客服' };
const MEMBER_ROLE: Record<UiMemberRole, string> = { master: '主客服', agent: '客服', customer: '客人', robot: '机器人', company: '携程客服', other: '成员' };

function invitePresence(agent: UiInviteAgent): HTMLElement {
  const chat = agent.status != null ? AGENT_CHAT_STATUS[agent.status] : undefined;
  return h('span', { class: cx('invite-presence', chat?.cls ?? 'unknown') },
    h('i', { 'aria-hidden': 'true' }), chat?.name ?? '状态未知');
}

function inviteAgentRow(d: PeripheralPanelState, agent: UiInviteAgent, expired: boolean): HTMLElement {
  const name = personDisplayName(agent.nickname, agent.uid);
  const job = (agent.job_position_type != null ? JOB_POSITION[agent.job_position_type] : undefined) ?? agent.job_position ?? '其他角色';
  const duty = agent.duty_status == null ? null : agent.duty_status === 1 ? '上班' : '下班';
  return h('label', { class: cx('peripheral-member', 'invite-agent', { 'is-disabled': agent.in_group === true }), title: agent.skill_group_full_name ?? '' },
    h('input', { type: 'checkbox', 'aria-label': `选择${name}`, checked: agent.in_group === true || d.selected.includes(agent.uid), disabled: agent.in_group === true || d.busy || d.submitted || expired, onchange: () => peripheral.select(agent.uid) }),
    h('span', { class: 'ava sm invite-ava', 'aria-hidden': 'true' }, renderMessageAvatar(document, name, agent.avatar)),
    h('span', { class: 'invite-agent-main' }, h('b', null, name),
      h('span', { class: 'peripheral-id' }, [job, agent.skill_group_full_name].filter(Boolean).join(' · '))),
    h('span', { class: 'invite-agent-state' }, invitePresence(agent),
      agent.in_group ? h('span', { class: 'invite-duty' }, '已在群中') : duty ? h('span', { class: 'invite-duty' }, duty) : null));
}

/**
 * 滚动帧：与上一次渲染相比只有滚动窗口（listWindow / messageView）和 now 变化。
 * 这类帧只有列表窗口或消息窗口需要重算，其余区块（标题栏、导航、编辑器、右栏、对话框）输入完全相同，
 * 直接交回上次的活节点，增量渲染原地保留，不再每帧重建几百个节点再逐个比对。
 */
const SCROLL_FRAME_KEYS: ReadonlySet<string> = new Set(['now', 'listWindow', 'messageView']);
let lastRenderInput: MainState | null = null;
let scrollFrame = false;
const renderParts = new Map<string, Node | null>();
function markRenderFrame(s: MainState): void {
  const prev = lastRenderInput;
  lastRenderInput = s;
  scrollFrame = false;
  if (!prev) return;
  const next = s as unknown as Record<string, unknown>, before = prev as unknown as Record<string, unknown>;
  for (const key in next) if (next[key] !== before[key] && !SCROLL_FRAME_KEYS.has(key)) return;
  for (const key in before) if (!(key in next)) return;
  scrollFrame = true;
}
/** 与滚动无关的区块：滚动帧沿用上次节点，其余帧照常构建。 */
function part<T extends Node | null>(name: string, build: () => T): T {
  if (scrollFrame && renderParts.has(name)) return renderParts.get(name) as T;
  const node = build();
  renderParts.set(name, node);
  return node;
}

function render(s: MainState): Node {
  markRenderFrame(s);
  const hasAccount = !!activeAccount(s);
  const view = !hasAccount ? welcomeView(s) : s.view === 'messages' ? messagesView(s) : s.view === 'notifications' ? notificationsView(s) : orderView(s);
  return h(
    'div',
    { class: 'app', dataset: { view: hasAccount ? s.view : 'welcome', ...(s.activeWeb ? { web: '1' } : {}) } },
    part('titleBar', () => titleBar(s)),
    h('div', { class: 'body' }, part('navBar', () => navBar(s)), view, part('webStage', () => webStage(s))),
    part('statusBar', () => statusBar(s)),
    contextMenu(s),
    part('logoutDialog', () => logoutDialog(s)),
    part('peripheralDialog', () => peripheralDialog(s)),
    part('quickReplies', () => s.quickReplies?.mode === 'categories' ? quickRepliesView(s.quickReplies, replyContext(), quickReplies) : null),
    part('recommend', () => recommendView(s.recommendations, replyContext(), productCanSend(), recommendations)),
    part('receiveDiagnostics', () => receiveDiagnosticsDialog(s)),
    part('unknownOutbound', () => unknownOutboundDialog(s)),
    s.fileDrag && !s.activeWeb && composerInputContext(s) ? h('div', { class: 'drop-overlay', 'aria-hidden': 'true' }, h('div', null, icon(IC.file, 28), t('composer.dropHint'))) : null,
    part('banners', () => bannerStack(s)),
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
      view: s.view, blocked: !!(s.activeWeb || s.logoutDialog || s.peripheral || s.receiveDiagnostics || s.unknownOutbound || s.quickReplies?.mode === 'categories' || s.recommendations) };
  },
  pane: () => root.querySelector<HTMLElement>('[data-keep-scroll="msgs"]'),
  visible: () => document.visibilityState === 'visible' && document.hasFocus(),
  invoke: args => ipc.invoke(UiCommands.IM_MARK_READ, args),
});

// ---- drafts per (account, conversation) (I-09)
// The state map is per account generation and is reset on every account switch; the book remembers each
// persistent account's drafts and stores them through the host's `im_draft_load/save` (core-store DraftBook).
const draftBook = createDraftBook(createIpcDraftPort(
  (command, payload) => ipc.invoke(command, payload),
  { load: ImCommands.DRAFT_LOAD, save: ImCommands.DRAFT_SAVE },
  owner => S().accounts?.accounts.find(a => a.context.account_id === owner.account_id && a.context.environment === owner.environment)?.context ?? null,
));
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
  const history = conv ? S().history[conv.gid] : undefined;
  if (!pane || !conv || !history?.hasMore || history.busy || history.pageError || pane.clientHeight <= 0) return;
  // Chain pages ahead of an active gesture; a pane nobody is scrolling only reads what it needs to fill the viewport.
  const ahead = performance.now() - lastMessageScrollAt < 2000 ? historyPrefetchDistance(pane.clientHeight) : 0;
  if (pane.dataset['historyScope'] === historyScopeKey(activeAccount(S())?.context ?? null, conv.gid) && messagePaneModel.distanceToHead(pane.scrollTop) < ahead) void loadEarlier(conv);
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
/** Slots are rendered inline by `chatPane` (`featureRuntime.renderSlot`); `requestRender` patches the store, so a fact never misses a frame. */
const voicePlayer = voicePlayerOf(FEATURES);

subscribeFrame(store, (s) => {
  if (composerInput.deferRender()) return;
  // 增量 morph：已挂载的节点（滚动容器、行、头像、按 data-media-key 配对的 video）原地保留，
  // 计时刷新和实时更新既不重启播放，也不把正在滚动的列表/对话串从文档里拔下来（否则触控板惯性丢失、整树重排）。
  withMessageAnchor(s, () => rerender(root, () => render({ ...s, now: Date.now() }), { morph: true }));
  visibleReads.afterRender();
  fillHistoryViewport();
  syncConversationViewport();
});
rerender(root, () => render(S()));
subscribeFrame(store, () => void browserTabs.sync());
// Scrolling into view and returning focus must re-check the live scope and mounted rows.
root.addEventListener('scroll', (event) => {
  const pane = event.target as HTMLElement;
  // 只有消息面板的滚动关系到已读上报与窗口；会话列表等其他容器的滚动不在这里做任何 DOM 读取。
  if (!pane.isConnected || pane.dataset?.['keepScroll'] !== 'msgs') return;
  visibleReads.afterRender();
  onMessageScroll(pane);
  // Read ahead: the page should land long before the first row reaches the viewport.
  if (messagePaneModel.distanceToHead(pane.scrollTop) > historyPrefetchDistance(pane.clientHeight)) return;
  const s = S(), conv = activeConv(s);
  if (conv && pane.dataset['historyScope'] === historyScopeKey(activeAccount(s)?.context ?? null, conv.gid) && !s.history[conv.gid]?.pageError) void loadEarlier(conv);
}, true);
window.addEventListener('resize', syncConversationViewport);
if (typeof ResizeObserver !== 'undefined') new ResizeObserver(syncConversationViewport).observe(root);
window.addEventListener('focus', () => visibleReads.afterRender());
document.addEventListener('visibilitychange', () => visibleReads.afterRender());

document.addEventListener('mousedown', () => {
  const s = S();
  if (s.ctxMenu || s.meMenu || s.emoOpen || s.composerMore) store.patch({ ctxMenu: null, meMenu: false, emoOpen: false, composerMore: false });
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Tab' && (S().peripheral || S().receiveDiagnostics || S().unknownOutbound || S().quickReplies?.mode === 'categories' || S().recommendations)) {
    const dialog = document.querySelector<HTMLElement>((S().quickReplies?.mode === 'categories' || S().recommendations) ? '[data-commerce-dialog]' : S().unknownOutbound ? '[data-unknown-outbound]' : S().receiveDiagnostics ? '[data-receive-diagnostics]' : '[data-peripheral-dialog]');
    const controls = dialog ? [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)')] : [];
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (first && last && (e.shiftKey ? document.activeElement === first || document.activeElement === dialog : document.activeElement === last || document.activeElement === dialog)) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    }
  }
  if (e.key === 'Escape') {
    closeCommerce();
    if (S().peripheral) peripheral.close();
    if (S().receiveDiagnostics) receiveDiagnostics.close();
    if (S().unknownOutbound) unknownOutbound.close();
    const s = S();
    if (s.ctxMenu || s.meMenu || s.logoutDialog || s.emoOpen || s.composerMore) store.patch({ ctxMenu: null, meMenu: false, logoutDialog: null, emoOpen: false, composerMore: false });
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
ipc.listen<unknown>(Events.IM_MESSAGE_READ_STATUSES, receiveMessageReadStatuses);
ipc.listen<unknown>(Events.IM_CONVERSATIONS_INVALIDATED, receiveConversationInvalidation);
ipc.listen<unknown>(UiEvents.MEDIA_SEND_PROGRESS, receiveMediaProgress);
ipc.listen<unknown>(UiEvents.BROWSER_TAB_OPENED, browserTabs.receiveOpened);
ipc.listen<unknown>(UiEvents.BROWSER_TAB_CHANGED, browserTabs.receiveChanged);
ipc.listen<unknown>(UiEvents.BROWSER_TAB_CLOSED, browserTabs.receiveClosed);
ipc.listen<unknown>(UiEvents.MEDIA_DRAG, receiveFileDrag);
ipc.listen<unknown>(UiEvents.MEDIA_DROPPED, (value) => void receiveFileDrop(value));
ipc.listen<unknown>(UiEvents.TSIM_STATUS, receivePackageIdentity);
subscribeBatched(store, () => autoQueryPackage());
ipc.listen<unknown>(HostEvents.LOCATE, guarded(HostEvents.LOCATE, isLocatePayload, (p) => void locateConversation(p.account, p.gid)));
ipc.listen<unknown>(HostEvents.NOTICE_LOCATE_CATEGORY, guarded(HostEvents.NOTICE_LOCATE_CATEGORY, isNoticeCategoryPayload, (p) => void locateNoticeCategory(p.account, p.category_id)));
ipc.listen<unknown>(HostEvents.NOTICE_NEW, guarded(HostEvents.NOTICE_NEW, isNoticeCategoryPayload, (p) => {
  if (!stillActive(p.account)) return;
  const s = S();
  void noticeQuery.categories(s.view === 'notifications' && s.noticeCat === p.category_id);
}));
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
    const top = longestWaitingAlarm(snap.entries, snap.generated_at_ms);
    const target = top ? { account: top.account, gid: top.gid } : null;
    if (count !== s.alarmCount || snap.clock_trusted !== s.clockTrusted || target?.gid !== s.alarmTarget?.gid || target?.account.account_id !== s.alarmTarget?.account.account_id || target?.account.session_generation !== s.alarmTarget?.account.session_generation) store.patch({ alarmCount: count, alarmTarget: target, clockTrusted: snap.clock_trusted });
  }),
);
ipc.listen<unknown>(UiEvents.NET_STATUS, guarded(UiEvents.NET_STATUS, isUiNetStatus, (n) => store.patch({ net: noteNet(n) })));
function receiveAgentStatus(payload: unknown): void {
  // Background accounts publish to the same main window. Validate the complete
  // owner (including login generation) before allowing any display mutation.
  if (!isUiAgentStatusEvent(payload) || !stillActive(payload.account)) return;
  store.patch({ agent: mergeAgentStatus(S().agent, payload) });
}
ipc.listen<unknown>(UiEvents.AGENT_STATUS, receiveAgentStatus);
ipc.listen<unknown>(UiEvents.TOAST, guarded(UiEvents.TOAST, isToastPayload, (p) => toast(p.text)));
ipc.listen<unknown>(HostEvents.BANNER, guarded(HostEvents.BANNER, isBannerPayload, onBanner));
ipc.listen<unknown>(HostEvents.PLAY_SOUND, guarded(HostEvents.PLAY_SOUND, isSoundName, onPlaySound));
ipc.listen<unknown>(HostEvents.STOP_SOUND, () => stopSound());

setInterval(() => {
  const now = Date.now();
  if (clockEl) { const text = `${formatDate(now)} ${formatClock(now, true)}`; if (clockEl.textContent !== text) clockEl.textContent = text; }
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
  // 先比较再写：未变的文本不碰 DOM，避免定时器本身引起样式失效与布局。
  for (const el of root.querySelectorAll<HTMLElement>('[data-relative-time]')) {
    const time = Number(el.dataset['relativeTime']);
    const text = time ? formatRelativeTime(time, now) : '';
    if (el.textContent !== text) el.textContent = text;
  }
}, 5000);
// 读秒：半秒取样，定时抖动时也不跳号；实际每秒只写一次变化的文本。
setInterval(() => {
  if (document.visibilityState !== 'visible') return;
  const pills = root.querySelectorAll<HTMLElement>('[data-waiting-gid]');
  const headers = root.querySelectorAll<HTMLElement>('[data-chat-waiting-gid]');
  if (pills.length === 0 && headers.length === 0) return;
  const now = Date.now();
  const byGid = new Map(S().conversations.map(c => [c.gid, c]));
  for (const el of pills) {
    const c = byGid.get(el.dataset['waitingGid'] ?? '');
    if (!c) continue;
    syncWaitPill(el, c, waitedSeconds(c, now));
  }
  for (const el of headers) {
    const c = byGid.get(el.dataset['chatWaitingGid'] ?? '');
    if (!c) continue;
    const text = [isDone(c) ? '会话已结束，无法管理成员' : c.waiting_since_ms !== null ? t('chat.waiting', { t: formatDuration(waitedSeconds(c, now)) }) : ''].filter(Boolean).join(' · ');
    if (el.textContent !== text) el.textContent = text;
  }
}, 500);

void (async () => {
  await Promise.all([loadAccounts(), loadPrefs(), loadNet()]);
  await refreshPackageIdentity();
  // Alarm counts arrive only through `Events.ALARM_SNAPSHOT`: notify commands are reserved for the alarm window (strong-alert §6).
  await loadForActiveAccount();
})();

exposeForTests(sel, { __vbkStore: store, __vbkOpenConversation: openConversation, __vbkSoundLog: soundLog });
