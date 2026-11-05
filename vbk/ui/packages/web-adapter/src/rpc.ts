import { createMessageActionsRpc, MessageActionRpcError } from './message-actions.ts';
import { adapterStrings } from './strings.ts';
/**
 * `adapter://request` dispatcher (D5): one handler per `AdapterRequest.op`,
 * answering with the `AdapterResultMap` shape for `adapter_reply`.
 *
 * Fields the protocol args do not carry (sessionId, worksheetId, numeric
 * groupId, serviceType, threadId, conversationType, partner jid, latest
 * message id) come from the in-page conversation cache, keyed by gid.
 * A missing field is an error reply — never a guess.
 *
 * Write rules: `im.send_text` submits exactly once and resolves to
 * confirmed / rejected / unknown (timeout → unknown, never resent; a
 * duplicate request with the same `local_id` returns the first result).
 * Other writes report an unknown outcome as `adapter.timeout` without
 * replaying the request.
 *
 * Evidence per op is listed in `OP_EVIDENCE` (also used by the report).
 */

import type { AdapterFact, AppError, SendDisposition } from '../../ipc/src/contracts.ts';
import { ErrorCodes } from '../../ipc/src/contracts.ts';
import type { AgentStatus, MarkAction, UiMessage, UiMessagePage, UiNoticeCategory, UiPeripheralWrite } from '../../ipc/src/client.ts';
import type { AdapterDisplayPayload, AdapterOp, AdapterReplyPayload, AdapterResultMap } from '../../ipc/src/adapterProtocol.ts';
import type { AdapterDeps } from './deps.ts';
import { getCustomerScripts, getCurrentMembers, getInviteMemberListBySkillGroup, searchInviteMemberListBySkillGroup, getLatestConversationState, finishConversation, inviteVenAgent, removeVenAgents, transferVenMaster, reopenConversationForSend, FINISHED_STATUS, type ReopenResult, type PeripheralFailure, type PeripheralReadResult, type CurrentMember, type PeripheralConversation } from './peripheral.ts';
import { Endpoints } from './endpoints.ts';
import { businessHead, sdkHead } from './heads.ts';
import type { SoaClient, SoaOutcome } from './soa.ts';
import { recordOrNull, parseSoaTimestamp } from './soa.ts';
import { conversationListBody, type ConversationListResponse } from './conversationList.ts';
import { md5HexOfString } from './md5.ts';
import { translateForDisplay } from './translation.ts';
import { fetchHistoryPage } from './history.ts';
import { is13DigitMs, normalizeTimeMs, jidLocal } from './facts.ts';
import { createSendIntent, submitIntent, type SendIntent } from './send.ts';
import { markRead } from './markRead.ts';
import { getQuickReplyCategories, parseScriptSuggestion, type QuickReplyScript, type QuickReplyCategory } from './settings.ts';
import { editQuickReplies, parseEdit, quickReplyManageInfo, type ManageDeps, type QuickReplyEditOutcome } from './quick-reply-manage.ts';
import { createRecommendRpc, RecommendRpcError } from './recommend.ts';
import { createMediaRpc } from './media.ts';
import { workSheetStarRequest, setWorkSheetStar } from './worksheetStar.ts';
import { createImChat, orderImPlan, startOrderB2c, searchOrderExact, searchedOrderSummary } from './order.ts';
import { fetchOrderSource } from './order-source.ts';
import { AGENT_STATUS_CODES, agentStatusOf, byCreateTime, httpMessageToUi, orderSummaryFromMessage, toDisplayConversation } from './display.ts';
import type { PageSdk } from './sdkGlue.ts';
import { roomJidFromMessage, type ConversationStore, RoleBook } from './stores.ts';
import { fetchNoticeCategories, fetchNoticeList, markNoticeRead, parseNoticeCategoryId, translateNoticeMessage, type NoticeCategoryInfo } from './notice.ts';
import type { StatusRead } from './presence.ts';
import { createFeatureDispatcher, FeatureOpError, type FeatureDispatcher, type FeatureOpContext } from './features.ts';
import { createAdapterFeatures } from './adapterFeatures.ts';

export const OP_EVIDENCE: Readonly<Record<AdapterOp, string>> = {
  'clock.sample': 'host-requested fixed GetMyInfo.json authenticated SOA Timestamp; no display, facts or read receipts',
  'assistant.scope': 'read-only local complete conversation identity revision; no upstream call',
  'media.target': 'read-only local full conversation identity capability',
  'media.validate': 'read-only local capability validation',
  'media.release': 'local attachment capability revocation; never clears durable/no-replay evidence',
  'media.discard': 'local unsubmitted byte staging disposal; never clears started upload/send tombstones',
  'media.stage_begin': 'bounded host-selected immutable bytes; no upstream write',
  'media.stage_chunk': 'bounded ordered local byte staging; no upstream write',
  'media.upload': 'image 44 / file 33 / video 68 upload contracts; once per transfer',
  'im.forward_message': 'official desktop eje/Kyt reconstructs target conversation and forwards supported raw message body',
  'im.send_saved_image': 'official desktop local custom emoji sent as image through SDK',
  'im.send_media': 'media JSON 44/33/68 and matching SDK send_result; host durable admission',
  'adapter.diagnostics': 'read-only local receive counters; no upstream operation',
  'im.customer_scripts': 'official desktop Lht content/type suggestions; read-only draft insertion',
  'im.recommend_products': 'official desktop recommendProduct query and selection-scoped results',
  'im.recommend_cities': 'official desktop city search read',
  'im.send_product_card': 'official desktop type-46 card through SDK with explicit selection token',
  'im.quick_reply_categories': 'getCategories personal/team categories; official desktop Aht/K4e draft insertion',
  'im.quick_reply_manage_info': 'getVenAgentByUid jobPosition LEADER gate + getSkillGroupInfoByVenAgent {agentUid: buid}; official personal-settings dialog (static)',
  'im.quick_reply_edit': 'official personal-settings dialog category/script writes (static call sites); pre-read, one write, getCategories read-back, never replayed',
  'im.members': 'checkMemberStatus (evidence 55), current status and roles',
  'im.invite_candidates': 'getInviteMemberListBySkillGroup (evidence 24)',
  'im.invite': 'inviteVenAgent (evidence 29), independent membership read-back',
  'im.transfer': 'transferVenMaster (evidence 26), targetRoles=[3,4,4] read-back',
  'im.finish': 'finishConversation (47), status=4/inGroup=-1 read-back (48)',
  'im.remove': 'finishConversation + venAgentUids (30), targets absent read-back',
  'im.outbound_lookup': 'getMessageList latest page, identity metadata only; no facts, display or mark-read',
  'im.messages': 'getMessageList (endpoint doc, evidence 70); checkMemberStatus roles (13500 doc, evidence 55)',
  'im.message_page': 'getMessageList direction prev/endTime; rangeMessage.isDone (evidence 70)',
  'im.translate_messages': 'batchTranslateByMsgIds (11679 doc, evidence 02/08/51/55), official translateMessage',
  'im.send_text': 'WS body/send_result (transports.md, evidence 35/40); SDK facade name unverified',
  'im.mark_read': 'PutAdviceOfReadByMsgId.json body (11679 doc, evidence 71)',
  'im.set_mark': 'setWorkSheetStar (16037 doc, evidence 72-75)',
  'notice.categories': 'getIQConversations head1001; official desktop source (2026-11-03 notification query)',
  'notice.watch': 'getIQConversations head1001 lastMsgTime/lastMsgId; same read as notice.categories, driven by the host for opted-in banners',
  'notice.list': 'getIQMessages first cursor0/pageSize100/messageBody; official desktop source (2026-11-03 notification query)',
  'notice.mark_read': 'putAdviceofreadIQMessage static call site only (same excerpt)',
  'order.search': 'searchorderlist all-orders exact request verified 2026-11-03; matching string ID and bounded summary',
  'order.create_im_chat': 'createimchat strict success + verified legacy web initChat2/startChatB2C; exact order read-back before UI open',
  'agent.set_status': 'setVenAgentStatus static chain (agent-status research §1) + currentStatus read-back',
  'agent.status': 'getConversationList.currentStatus (live, web-im-final-verification)',
};

export const HISTORY_PAGE_SIZE = 30;
export const SEND_ACK_TIMEOUT_MS = 15_000;
export const ORDER_GID_WAIT_MS = 12_000;
export const MAX_TEXT_CHARS = 5000;

export interface AgentStatusBox {
  current(): { readonly status: AgentStatus; readonly confirmed: boolean } | null;
  set(status: AgentStatus, confirmed: boolean): void;
  captureRead?(writeback?: boolean): StatusRead;
  invalidate?(): void;
  beginWrite?(): boolean;
  endWrite?(): void;
}

export interface RpcContext {
  readonly deps: AdapterDeps;
  readonly soa: SoaClient;
  readonly sdk: PageSdk;
  readonly store: ConversationStore;
  readonly roles: RoleBook;
  readonly pushFact: (fact: AdapterFact) => void;
  readonly pushDisplay: (payload: AdapterDisplayPayload) => void;
  readonly agent: AgentStatusBox;
  readonly captureReadAcknowledgment?: (gid: string) => (() => boolean);
  readonly onReadAcknowledged?: (gid: string, id: string, through: { readonly msgId: string; readonly createTime: number }) => Promise<void>;
  /** A confirmed receipt whose local consumption was not admitted (frontier moved / newer evidence); the server count stays the authority. */
  readonly onReadReceiptConfirmed?: (gid: string) => void;
  readonly sendAckTimeoutMs?: number;
  readonly orderGidWaitMs?: number;
  /** Read back and publish the exact order conversation before returning it to the UI. */
  readonly ensureOrderConversation?: (gid: string, orderId: string, current: () => boolean) => Promise<boolean>;
  /** Captures the current lifecycle generation; old awaited work must never write. */
  readonly captureWriteGuard?: () => (() => boolean);
  readonly receiveDiagnostics?: () => import('../../ipc/src/client.ts').UiPageReceiveDiagnostics;
  /** Platform buid (`getCurrentUserInfo`), used only as the official `agentUid` of the skill-group read; not the IM uid. */
  readonly buid?: string | null;
  /**
   * Feature ops (`typing.*`, `recall.*`, `queue.*`; plan I-30). Defaults to
   * `createAdapterFeatures()` built fresh for this rpc instance. Tests inject
   * their own.
   */
  readonly features?: FeatureDispatcher;
}

/**
 * Builds the narrow context a feature op sees for ONE request. The host is the
 * only caller of `adapter://request`, so a `server_now_ms` argument is the
 * host's anchored server clock (the host's `im_recall_message` adds it after
 * its own gate); the page has no anchor of its own and treats anything else
 * as "clock unknown", which every feature maps to a refusal, never a pass.
 * `emit` wraps the fact as `AdapterFact {kind: 'feature'}` and hands it to the
 * same `pushFact` every other fact uses (bridge envelope, stream `im.feature`,
 * ordered queue, push-error accounting); the host validates and rate-limits it
 * before forwarding it to the main window as `feature://fact`.
 */
function featureOpContext(ctx: RpcContext, args: unknown): FeatureOpContext {
  const serverNow = recordOrNull(args)?.['server_now_ms'];
  const anchored = typeof serverNow === 'number' && Number.isSafeInteger(serverNow) && serverNow > 0 ? serverNow : null;
  const current = ctx.captureWriteGuard?.() ?? (() => true);
  const typing = ctx.sdk.sendInputState;
  return {
    deps: ctx.deps,
    soa: ctx.soa,
    sdk: typeof typing === 'function' ? { sendInputState: async request => {
      if (!current()) return false;
      const row = ctx.store.row(request.gid);
      if (!row) return false;
      const handedOff = await typing.call(ctx.sdk, request);
      return current() && ctx.store.row(request.gid) === row && handedOff;
    } } : {},
    serverNowMs: () => anchored,
    conversation: (gid) => ctx.store.view(gid),
    selfUid: () => (ctx.roles.selfUid === '' ? null : ctx.roles.selfUid),
    emit: (fact) => ctx.pushFact({ kind: 'feature', fact }),
  };
}

export class RpcError extends Error {
  readonly appError: AppError;
  constructor(appError: AppError) {
    super(appError.message);
    this.appError = appError;
  }
}

function fail(code: string, message: string, retryable = false, detail?: string): never {
  throw new RpcError(detail === undefined ? { code, message, retryable } : { code, message, retryable, detail });
}

/** Maps a non-success SOA outcome onto an `AppError` (no body, no cookies). */
export function outcomeError(outcome: SoaOutcome<unknown>, what: string): AppError {
  switch (outcome.kind) {
    case 'auth_invalid':
      return { code: ErrorCodes.ACCOUNT_TICKET_EXPIRED, message: adapterStrings['rpc.loginExpired'](what), retryable: false };
    case 'timeout':
      return { code: ErrorCodes.NET_TIMEOUT, message: adapterStrings['rpc.timeout'](what), retryable: true };
    case 'network_error':
      return { code: ErrorCodes.NET_OFFLINE, message: adapterStrings['rpc.networkError'](what), retryable: true };
    case 'unknown':
      return { code: ErrorCodes.ADAPTER_TIMEOUT, message: adapterStrings['rpc.outcomeUnknownNotRetried'](what), retryable: false, detail: 'unknown' };
    case 'business_failure': {
      const code = outcome.errors[0]?.ErrorCode;
      return code ? { code: ErrorCodes.ADAPTER_FAILED, message: adapterStrings['rpc.rejected'](what), retryable: false, detail: code } : { code: ErrorCodes.ADAPTER_FAILED, message: adapterStrings['rpc.rejected'](what), retryable: false };
    }
    case 'http_error':
      return { code: ErrorCodes.ADAPTER_FAILED, message: adapterStrings['rpc.http'](what, outcome.httpStatus), retryable: true };
    case 'malformed':
      return { code: ErrorCodes.ADAPTER_FAILED, message: adapterStrings['rpc.malformedResponse'](what), retryable: false };
    case 'success':
      return { code: ErrorCodes.ADAPTER_FAILED, message: adapterStrings['rpc.unexpected'](what), retryable: false };
  }
}

function requireString(args: unknown, key: string): string {
  const v = recordOrNull(args)?.[key];
  if (typeof v !== 'string' || v === '') fail(ErrorCodes.ADAPTER_FAILED, adapterStrings['rpc.invalidArgument'](key));
  return v;
}

function requireConversation(ctx: RpcContext, gid: string) {
  const view = ctx.store.view(gid);
  if (!view) fail(ErrorCodes.ADAPTER_NOT_READY, adapterStrings['rpc.conversationNotInThePageCacheYet'], true);
  return view;
}

function partnerJidOf(ctx: RpcContext, gid: string): string | null {
  return ctx.sdk.partnerJidOf(gid) ?? roomJidFromMessage(gid, ctx.store.view(gid)?.lastMessage ?? null);
}

/** Bind a send to the captured service and sender context, never a later row
 * with the same gid. Volatile message/order enrichment is not a target field. */
function sendIdentity(ctx: RpcContext, view: ReturnType<typeof requireConversation>): string {
  return JSON.stringify([view.gid, view.sessionId, view.customerUid, view.conversationType, view.serviceType, view.threadId, view.conversationKey ?? null, view.worksheetId, contextFingerprint(ctx)]);
}

// ------------------------------------------------------------- agent status read-back

export async function readCurrentStatus(ctx: RpcContext, writeback = false): Promise<AgentStatus | null> {
  const current = ctx.captureWriteGuard?.() ?? (() => true);
  ensureCurrent(current);
  const ticket = ctx.agent.captureRead?.(writeback);
  const outcome = await ctx.soa.post<ConversationListResponse>(Endpoints.CONVERSATION_LIST, conversationListBody(ctx.deps, null, false));
  ensureCurrent(current);
  if (outcome.kind !== 'success') {
    ticket?.fail();
    if (outcome.kind === 'auth_invalid') ctx.pushFact({ kind: 'auth_invalid' });
    throw new RpcError(outcomeError(outcome, adapterStrings['rpc.agentStatus']));
  }
  const status = agentStatusOf(outcome.body.currentStatus);
  if (status === null) ticket?.fail();
  else if (ticket) {
    if (!ticket.commit(status)) fail(ErrorCodes.ADAPTER_NOT_READY, adapterStrings['rpc.agentStatusObservationSupersededRefreshStatus'], true);
  } else ctx.agent.set(status, true);
  return status;
}

// ------------------------------------------------------------- handlers

type Handler<K extends AdapterOp> = (ctx: RpcContext, args: unknown, state: RpcState) => Promise<AdapterResultMap[K]>;

interface RpcState {
  messageActions?: ReturnType<typeof createMessageActionsRpc>;
  media?: ReturnType<typeof createMediaRpc>;
  recommend?: ReturnType<typeof createRecommendRpc>;
  readonly sends: Map<string, Promise<SendDisposition>>;
  readonly categories: Map<string, NoticeCategoryInfo>;
  noticeCategoryRequest?: number;
  selections?: Map<string, PeripheralSelection>;
  peripheralWrites?: Map<string, Promise<UiPeripheralWrite>>;
  selectionSequence?: number;
  readonly selectionNamespace: string;
  agentWritePending?: boolean;
  orderCreates?: Map<string, { readonly current: () => boolean; readonly result: Promise<string> }>;
  /** One quick-reply write per account page at a time; a second one is refused as `busy`. */
  quickReplyWriting?: boolean;
}

/** Isolated latest-page evidence read. No shared role/store mutation or UI/fact publication. */
const imOutboundLookup: Handler<'im.outbound_lookup'> = async (ctx, args) => {
  const current = ctx.captureWriteGuard?.() ?? (() => true);
  ensureCurrent(current);
  const gid = requireString(args, 'gid');
  const view = requireConversation(ctx, gid);
  if (!view.conversationType) fail(ErrorCodes.ADAPTER_FAILED, adapterStrings['rpc.conversationTypeUnknownForThisConversation']);
  const owner = JSON.stringify([sendIdentity(ctx, view), view.orderId]);
  const roles = new RoleBook(ctx.roles.selfUid);
  const res = await fetchHistoryPage(ctx.deps, ctx.soa, { gid, conversationType: view.conversationType, pageSize: 30 }, roles);
  ensureCurrent(current);
  if (JSON.stringify([sendIdentity(ctx, requireConversation(ctx, gid)), requireConversation(ctx, gid).orderId]) !== owner) fail(ErrorCodes.ADAPTER_NOT_READY, adapterStrings['rpc.conversationChangedDuringOutboundLookup']);
  if (res.kind === 'invalid_cursor') fail(ErrorCodes.ADAPTER_FAILED, adapterStrings['rpc.invalidHistoryCursor']);
  if (res.kind === 'failed') throw new RpcError(outcomeError(res.outcome, adapterStrings['rpc.outboundLookup']));
  const items = res.page.rows.map(row => httpMessageToUi(row, roles, gid)).filter((row): row is UiMessage => row !== null)
    .map(({ gid, message_id, local_id, sender_role }) => ({ gid, message_id, local_id, sender_role }));
  return { items };
};

const imMessagePage: Handler<'im.message_page'> = async (ctx, args): Promise<UiMessagePage> => {
  const current = ctx.captureWriteGuard?.() ?? (() => true);
  ensureCurrent(current);
  const gid = requireString(args, 'gid');
  const before = recordOrNull(args)?.['before_ms'];
  if (before !== undefined && !is13DigitMs(before)) fail(ErrorCodes.ADAPTER_FAILED, adapterStrings['rpc.invalidHistoryCursor']);
  const view = requireConversation(ctx, gid);
  const expectedRevision = recordOrNull(args)?.['expected_context_revision'];
  if (expectedRevision !== undefined && (typeof expectedRevision !== 'string' || !expectedRevision)) fail(ErrorCodes.ADAPTER_FAILED, 'invalid history context revision');
  let acceptedRevision = expectedRevision;
  const messageContext = ctx.store.messageContext(gid);
  const historyOwner = JSON.stringify([sendIdentity(ctx, view), view.orderId]);
  const checkHistoryContext = (): void => {
    ensureCurrent(current);
    const live = requireConversation(ctx, gid);
    if (acceptedRevision !== undefined && ctx.store.assistantContextRevision(gid, ctx.roles.selfUid, partnerJidOf(ctx, gid)) !== acceptedRevision) fail(ErrorCodes.ADAPTER_NOT_READY, 'history source context changed');
    if (ctx.store.messageContext(gid) !== messageContext || JSON.stringify([sendIdentity(ctx, live), live.orderId]) !== historyOwner) fail(ErrorCodes.ADAPTER_NOT_READY, 'conversation changed during history read');
  };
  checkHistoryContext();
  if (!view.conversationType) fail(ErrorCodes.ADAPTER_FAILED, 'conversationType unknown for this conversation');
  // Read the same source as the official sidebar independently of chat pages.
  // A failed source read must not prevent history from opening or clear cards.
  if (before === undefined) {
    const startedAt = ctx.deps.now(), sourceRead = ctx.store.beginSourceRead(gid);
    void fetchOrderSource(ctx.deps, ctx.soa, gid, view.orderId).then(result => {
      checkHistoryContext();
      if (result.kind === 'unavailable') return;
      if (result.kind === 'denied' || result.kind === 'empty') {
        if (!ctx.store.denySourceOrder(gid, messageContext, sourceRead)) return;
      } else ctx.store.noteSourceOrder(gid, result.order, messageContext, startedAt, sourceRead);
      // This read can establish a previously absent order identity. Continue
      // its own history under that new token; unrelated scope changes still fail.
      if (acceptedRevision !== undefined) acceptedRevision = ctx.store.assistantContextRevision(gid, ctx.roles.selfUid, partnerJidOf(ctx, gid)) ?? undefined;
      const row = ctx.store.row(gid), display = row ? toDisplayConversation(row, false, undefined, ctx.roles.selfUid) : null;
      if (!display) return;
      const profile = view.customerUid ? ctx.roles.profileOf(view.customerUid) : null;
      ctx.pushDisplay({ kind: 'conversations', full: false, items: [{ ...display, customer_avatar: profile?.avatar ?? null, title: profile?.name ?? display.title, order: ctx.store.order(gid) ?? display.order }], removed_gids: [] });
    }).catch(() => undefined);
  }
  await ctx.roles.ensure(ctx.deps, ctx.soa, gid);
  checkHistoryContext();
  const res = await fetchHistoryPage(ctx.deps, ctx.soa, { gid, conversationType: view.conversationType, pageSize: HISTORY_PAGE_SIZE, ...(typeof before === 'number' ? { cursor: { direction: 'prev' as const, endTime: before } } : {}) }, ctx.roles);
  checkHistoryContext();
  if (res.kind === 'invalid_cursor') fail(ErrorCodes.ADAPTER_FAILED, adapterStrings['rpc.invalidHistoryCursor']);
  if (res.kind === 'failed') throw new RpcError(outcomeError(res.outcome, adapterStrings['rpc.history']));
  // Only server completion proves the end of a thread. An empty/repeated page
  // without completion must remain retryable instead of hiding older history.
  const times = res.page.rows.map((row) => normalizeTimeMs(row.createTime)).filter(is13DigitMs);
  const oldest = times.length > 0 ? Math.min(...times) : null;
  const hasMore = !res.page.isDone;
  if (hasMore && (oldest === null || (typeof before === 'number' && oldest >= before))) {
    fail(ErrorCodes.ADAPTER_FAILED, adapterStrings['rpc.historyPageDidNotProvideAnEarlierBoundaryRetry'], true);
  }
  for (const fact of res.page.facts) ctx.pushFact({ kind: 'message', fact });
  const items: UiMessage[] = [];
  const authoritativeRoom = roomJidFromMessage(gid, ctx.store.view(gid)?.lastMessage ?? null);
  for (const row of res.page.rows) {
    const ui = httpMessageToUi(row, ctx.roles, gid);
    if (ui) items.push(ui);
    if (typeof row === 'object' && row !== null) {
      const order = ui ? orderSummaryFromMessage(row) : null;
      if (order && ui) ctx.store.noteOrder(gid, order, ui.create_time_ms);
      const jid = roomJidFromMessage(gid, row);
      if (jid && (!authoritativeRoom || authoritativeRoom === jid)) ctx.sdk.rememberPartnerJid(gid, jid);
    }
  }
  items.sort(byCreateTime);
  checkHistoryContext();
  const presentedIds = new Set(items.filter(item => item.kind !== 'system').map(item => item.message_id));
  ctx.store.noteReadHistory(gid, res.page.rows.filter(row => typeof row.msgId === 'string' && presentedIds.has(row.msgId)));
  const row = ctx.store.row(gid);
  const display = row ? toDisplayConversation(row, false, undefined, ctx.roles.selfUid) : null;
  if (display) {
    const profile = view.customerUid ? ctx.roles.profileOf(view.customerUid) : null;
    ctx.pushDisplay({ kind: 'conversations', full: false, items: [{ ...display, customer_avatar: profile?.avatar ?? null, title: profile?.name ?? display.title, order: ctx.store.order(gid) ?? display.order }], removed_gids: [] });
  }
  // A page is only part of a thread: preserve realtime arrivals and previously loaded pages.
  ctx.pushDisplay({ kind: 'messages', gid, replace: false, items });
  return { items, has_more: hasMore, before_ms: hasMore ? oldest : null };
};

const imMessages: Handler<'im.messages'> = async (ctx, args, state) => (await imMessagePage(ctx, args, state)).items;

const MAX_TRANSLATE_IDS = 20;

/** Official translateMessage: one batch of the current conversation; every ID gets an explicit answer. */
const imTranslateMessages: Handler<'im.translate_messages'> = async (ctx, args) => {
  const current = ctx.captureWriteGuard?.() ?? (() => true);
  ensureCurrent(current);
  const gid = requireString(args, 'gid');
  const raw = recordOrNull(args)?.['message_ids'];
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_TRANSLATE_IDS || raw.some(id => typeof id !== 'string' || !id)) fail(ErrorCodes.ADAPTER_FAILED, 'invalid argument: message_ids');
  const view = requireConversation(ctx, gid);
  const bizType = Number(view.serviceType);
  if (!Number.isSafeInteger(bizType) || bizType <= 0) fail(ErrorCodes.ADAPTER_NOT_READY, 'conversation has no translation business type yet', true);
  const chatType = recordOrNull(ctx.store.row(gid))?.['chatType'];
  const result = await translateForDisplay(ctx.deps, ctx.soa, {
    gid, sessionId: view.sessionId ?? '', serviceType: view.serviceType,
    ...(typeof chatType === 'string' && chatType ? { chatType } : {}),
  }, [...new Set(raw as string[])]);
  ensureCurrent(current);
  const live = requireConversation(ctx, gid);
  if (live.sessionId !== view.sessionId || live.serviceType !== view.serviceType) fail(ErrorCodes.ADAPTER_NOT_READY, 'conversation changed during translation', true);
  if ('failed' in result) throw outcomeError(result.failed, 'translation');
  return { ...result, session_tag: md5HexOfString(view.sessionId ?? '').slice(0, 8) };
};

/** 同一页面、同一会话并发发送只共用一次重开（键为会话缓存实例，换会话缓存即失效）。 */
const reopening = new WeakMap<ConversationStore, Map<string, Promise<ReopenResult>>>();

/**
 * 已结束（status=4）会话的发送前重开。官方网页在结束后发送时先 `startChatB2C` 重新开启
 * （evidence 49），本函数照做；重开失败、被拒或结果未知时消息一律不提交，以
 * ADAPTER_NOT_READY 回报，宿主记为「未发送」(rejected)，而不是 unknown。
 * 再次发送会先读回服务端状态，已重开的会话不会再写一次。
 */
async function reopenBeforeSend(ctx: RpcContext, gid: string, current: () => boolean): Promise<void> {
  if (ctx.store.row(gid)?.status !== FINISHED_STATUS) return;
  let inflight = reopening.get(ctx.store);
  if (!inflight) reopening.set(ctx.store, inflight = new Map());
  let pending = inflight.get(gid);
  if (!pending) {
    const memo = inflight;
    pending = reopenConversationForSend(ctx.deps, ctx.soa, gid).finally(() => memo.delete(gid));
    inflight.set(gid, pending);
  }
  const r = await pending;
  ensureCurrent(current);
  if (r.kind === 'already_open' || r.kind === 'accepted') return;
  const why = r.kind === 'biz_failure' ? 'rejected by the server'
    : r.kind === 'unknown' ? 'outcome unknown, check the conversation before sending again'
    : r.kind === 'unsupported' ? `conversation fields missing: ${r.missing.join(',')}`
    : r.kind === 'invalid' ? `invalid ${r.field}` : 'request failed';
  fail(ErrorCodes.ADAPTER_NOT_READY, adapterStrings['rpc.finishedConversationCouldNotBeReopenedMessageNotSent'](why), r.kind === 'failed');
}

async function sendOnce(ctx: RpcContext, gid: string, localId: string, text: string, original: string | null, quoteId: string | null, attempt: { started: boolean }): Promise<SendDisposition> {
  const current = ctx.captureWriteGuard?.() ?? (() => true);
  ensureCurrent(current);
  requireConversation(ctx, gid);
  await reopenBeforeSend(ctx, gid, current);
  const view = requireConversation(ctx, gid);
  const identity = sendIdentity(ctx, view);
  let targetJid = partnerJidOf(ctx, gid);
  const checkTarget = (): string | null => {
    ensureCurrent(current);
    if (sendIdentity(ctx, requireConversation(ctx, gid)) !== identity) fail(ErrorCodes.ADAPTER_NOT_READY, adapterStrings['rpc.conversationIdentityChangedBeforeSubmissionNothingSent']);
    const liveTarget = partnerJidOf(ctx, gid);
    if (targetJid !== null && liveTarget !== targetJid) fail(ErrorCodes.ADAPTER_NOT_READY, adapterStrings['rpc.conversationTargetChangedBeforeSubmissionNothingSent']);
    return liveTarget;
  };
  if (view.serviceType === '') fail(ErrorCodes.ADAPTER_FAILED, adapterStrings['rpc.serviceTypeUnknownForThisConversation']);
  if (!ctx.sdk.canSend) fail(ErrorCodes.HOST_UNSUPPORTED, adapterStrings['rpc.officialSDKSendEntryNotFoundOnThePage']);
  checkTarget();
  if (!partnerJidOf(ctx, gid)) await imMessages(ctx, { gid }, { sends: new Map(), categories: new Map(), selectionNamespace: '' });
  // A history read may learn the original room. It cannot authorize replacing
  // the service/customer/thread captured before awaiting that read.
  targetJid = checkTarget();
  if (!targetJid) fail(ErrorCodes.ADAPTER_NOT_READY, adapterStrings['rpc.targetJidNotKnownYetNothingSent'], true);
  const base = createSendIntent(ctx.deps, gid, text, { serviceType: view.serviceType, threadId: view.threadId }, quoteId ? { citemsgid: quoteId } : undefined);
  // the host's local_id is the correlation key end to end
  const intent: SendIntent = { ...base, localId, body: { ...base.body, localid: localId } };
  checkTarget();
  attempt.started = true;
  return submitIntent(ctx.deps, ctx.sdk, intent, ctx.sendAckTimeoutMs ?? SEND_ACK_TIMEOUT_MS).then((result) => {
    ctx.pushFact({ kind: 'message', fact: result.fact });
    const d = result.disposition;
    const echo: UiMessage = {
      gid,
      message_id: d.kind === 'confirmed' ? d.server_message_id : null,
      local_id: localId,
      create_time_ms: d.kind === 'confirmed' ? d.server_time_ms : intent.createdAtMs,
      sender_role: 'merchant_self',
      sender_id: ctx.roles.selfUid,
      sender_name: ctx.roles.profileOf(ctx.roles.selfUid).name,
      sender_avatar: ctx.roles.profileOf(ctx.roles.selfUid).avatar,
      kind: 'text',
      text,
      translation: null,
      original,
      quote: quoteId,
      order_id: null,
      disposition: d,
    };
    ctx.pushDisplay({ kind: 'messages', gid, replace: false, items: [echo] });
    return d;
  });
}

const imSendText: Handler<'im.send_text'> = async (ctx, args, state) => {
  const gid = requireString(args, 'gid');
  const localId = requireString(args, 'local_id');
  const text = requireString(args, 'text');
  if (text.length > MAX_TEXT_CHARS) fail(ErrorCodes.ADAPTER_FAILED, adapterStrings['rpc.textTooLongNothingSent']);
  const a = recordOrNull(args) ?? {};
  const original = typeof a['original'] === 'string' ? a['original'] : null;
  const quoteId = typeof a['quote_id'] === 'string' && a['quote_id'] !== '' ? a['quote_id'] : null;
  const existing = state.sends.get(localId);
  if (existing) return existing; // same local_id: never a second submission
  const attempt = { started: false };
  const p = sendOnce(ctx, gid, localId, text, original, quoteId, attempt).catch((error: unknown): SendDisposition => {
    if (attempt.started) return { kind: 'unknown' };
    throw error;
  });
  state.sends.set(localId, p);
  p.catch(() => { if (!attempt.started) state.sends.delete(localId); }); // Only proven pre-submit failures can release this page-local memo.
  return p;
};

const imMarkRead: Handler<'im.mark_read'> = async (ctx, args) => {
  const current = ctx.captureWriteGuard?.() ?? (() => true);
  ensureCurrent(current);
  const gid = requireString(args, 'gid');
  const expectedMessageId = requireString(args, 'expected_message_id');
  if (!expectedMessageId.trim() || expectedMessageId.length > 512) fail(ErrorCodes.ADAPTER_FAILED, adapterStrings['rpc.invalidReadTargetMessageId']);
  const expectedRevision = requireString(args, 'expected_context_revision');
  requireConversation(ctx, gid);
  const partnerJid = partnerJidOf(ctx, gid);
  const latest = ctx.store.readTarget(gid);
  if (!partnerJid || !latest) fail(ErrorCodes.ADAPTER_NOT_READY, adapterStrings['rpc.noMessageTargetJidKnownForThisConversationYet'], true);
  const authoritativeRoom = roomJidFromMessage(gid, ctx.store.view(gid)?.lastMessage ?? null);
  if (!authoritativeRoom || authoritativeRoom !== partnerJid) fail(ErrorCodes.ADAPTER_NOT_READY, adapterStrings['rpc.conversationReadTargetHasNotBeenVerified']);
  const revision = ctx.store.assistantContextRevision(gid, ctx.roles.selfUid, partnerJid);
  if (!revision || revision !== expectedRevision) fail(ErrorCodes.ADAPTER_FAILED, 'read conversation context changed since visibility was observed');
  if (latest.msgId !== expectedMessageId) fail(ErrorCodes.ADAPTER_FAILED, 'read target changed since visibility was observed');
  const readAcknowledgmentCurrent = ctx.captureReadAcknowledgment?.(gid) ?? (() => true);
  const readThrough = ctx.store.latestMessage(gid) ?? latest;
  const r = await markRead(ctx.sdk, { partnerJid, msgId: expectedMessageId });
  ensureCurrent(current);
  if (ctx.store.assistantContextRevision(gid, ctx.roles.selfUid, partnerJidOf(ctx, gid)) !== revision) fail(ErrorCodes.ADAPTER_FAILED, 'conversation changed while read receipt was in flight');
  if (r.kind === 'acked') {
    if (readAcknowledgmentCurrent() && ctx.store.readTarget(gid)?.msgId === expectedMessageId) await ctx.onReadAcknowledged?.(gid, expectedMessageId, readThrough);
    else ctx.onReadReceiptConfirmed?.(gid);
    return null;
  }
  if (r.kind === 'unknown') fail(ErrorCodes.ADAPTER_TIMEOUT, 'read receipt outcome unknown (not retried)', false, 'unknown');
  return fail(ErrorCodes.ADAPTER_FAILED, 'read receipt rejected');
};

const MARKS: ReadonlySet<number> = new Set([0, 1, 2, 3, 4, 5]);

const imSetMark: Handler<'im.set_mark'> = async (ctx, args) => {
  const current = ctx.captureWriteGuard?.() ?? (() => true);
  ensureCurrent(current);
  const gid = requireString(args, 'gid');
  const action = recordOrNull(args)?.['action'];
  if (typeof action !== 'number' || !MARKS.has(action)) fail(ErrorCodes.ADAPTER_FAILED, adapterStrings['rpc.invalidArgumentAction']);
  const view = requireConversation(ctx, gid);
  const row = ctx.store.row(gid)!;
  const req = workSheetStarRequest(row, action as MarkAction);
  if (!req) fail(ErrorCodes.ADAPTER_FAILED, adapterStrings['rpc.colorUnavailable']);
  const identity = JSON.stringify([sendIdentity(ctx, view), req.sessionId, req.worksheetId]);
  const r = await setWorkSheetStar(ctx.deps, ctx.soa, req);
  ensureCurrent(current);
  const live = requireConversation(ctx, gid);
  const liveReq = workSheetStarRequest(ctx.store.row(gid)!, action as MarkAction);
  if (!liveReq || JSON.stringify([sendIdentity(ctx, live), liveReq.sessionId, liveReq.worksheetId]) !== identity) {
    fail(ErrorCodes.ADAPTER_NOT_READY, adapterStrings['rpc.colorContextChanged'], true);
  }
  if (r.applied) {
    // Mirror UPDATE_CONVERSATION_STAR only after the server confirms success.
    ctx.store.update([{ ...ctx.store.row(gid)!, star: action }]);
    return null;
  }
  if (r.reason === 'biz_failure') fail(ErrorCodes.ADAPTER_FAILED, adapterStrings['rpc.colorRejected']);
  throw new RpcError(outcomeError(r.outcome, adapterStrings['rpc.colorOperation']));
};

const noticeCategories: Handler<'notice.categories'> = async (ctx, _args, state) => {
  const current = ctx.captureWriteGuard?.() ?? (() => true);
  ensureCurrent(current);
  const request = state.noticeCategoryRequest = (state.noticeCategoryRequest ?? 0) + 1;
  const r = await fetchNoticeCategories(ctx.deps, ctx.soa);
  ensureCurrent(current);
  if (state.noticeCategoryRequest !== request) fail(ErrorCodes.ADAPTER_NOT_READY, adapterStrings['rpc.noticeCategoriesRequestSupersededRefreshCategories'], true);
  if (!r.ok) throw new RpcError(outcomeError(r.outcome, adapterStrings['rpc.noticeCategories']));
  state.categories.clear();
  for (const c of r.items) state.categories.set(c.id, c);
  const items: UiNoticeCategory[] = r.items.map((c) => ({ id: c.id, name: c.name, unread: c.unread }));
  ctx.pushDisplay({ kind: 'notice_categories', items });
  return items;
};

/** Background overview read for banners: leaves the category cache and the UI's request ordering alone. */
const noticeWatch: Handler<'notice.watch'> = async (ctx) => {
  const current = ctx.captureWriteGuard?.() ?? (() => true);
  ensureCurrent(current);
  const r = await fetchNoticeCategories(ctx.deps, ctx.soa);
  ensureCurrent(current);
  if (!r.ok) throw new RpcError(outcomeError(r.outcome, 'notice watch'));
  return r.items.map((c) => ({ id: c.id, name: c.name, last_msg_time: c.lastMsgTime, last_msg_id: c.lastMsgId }));
};

const noticeList: Handler<'notice.list'> = async (ctx, args, state) => {
  const current = ctx.captureWriteGuard?.() ?? (() => true);
  ensureCurrent(current);
  const id = requireString(args, 'category_id');
  const ref = parseNoticeCategoryId(id);
  if (!ref) fail(ErrorCodes.ADAPTER_FAILED, adapterStrings['rpc.invalidArgumentCategoryId']);
  const cat = state.categories.get(id);
  const before = recordOrNull(args)?.['before_ms'];
  if (before !== undefined && before !== null && (typeof before !== 'number' || !Number.isSafeInteger(before) || before < 0)) fail(ErrorCodes.ADAPTER_FAILED, adapterStrings['rpc.invalidArgumentBeforeMs']);
  const r = await fetchNoticeList(ctx.deps, ctx.soa, ref, typeof before === 'number' ? before : 0, cat?.unreadTimeline ?? null);
  ensureCurrent(current);
  if (!r.ok) throw new RpcError(outcomeError(r.outcome, adapterStrings['rpc.noticeList']));
  const translated = await translateNoticeMessage(ctx.deps, ctx.soa, r.items);
  ensureCurrent(current);
  return translated.items;
};

const noticeMarkRead: Handler<'notice.mark_read'> = async (ctx, args, state) => {
  const id = requireString(args, 'category_id');
  const ref = parseNoticeCategoryId(id);
  if (!ref) fail(ErrorCodes.ADAPTER_FAILED, adapterStrings['rpc.invalidArgumentCategoryId']);
  const explicit = recordOrNull(args)?.['id'];
  const msgId = typeof explicit === 'string' && explicit !== '' ? explicit : (state.categories.get(id)?.lastMsgId ?? null);
  if (msgId === null) fail(ErrorCodes.ADAPTER_NOT_READY, adapterStrings['rpc.noNoticeIdKnownForThisCategoryLoadCategories'], true);
  const outcome = await markNoticeRead(ctx.deps, ctx.soa, ref, msgId);
  if (outcome.kind === 'success') return null;
  throw new RpcError(outcomeError(outcome, adapterStrings['rpc.noticeMarkRead']));
};

const orderSearch: Handler<'order.search'> = async (ctx, args) => {
  const id = requireString(args, 'order_id');
  if (!/^(?:\d{10}|\d{16})$/.test(id)) fail(ErrorCodes.ADAPTER_FAILED, adapterStrings['rpc.orderIdInvalid']);
  const result = await searchOrderExact(ctx.deps, ctx.soa, id);
  if (result.kind === 'none' || result.kind === 'forbidden') return { kind: result.kind };
  if (result.kind === 'error') {
    if (result.outcome && result.outcome.kind !== 'success') throw new RpcError(outcomeError(result.outcome, adapterStrings['rpc.orderSearch']));
    fail(ErrorCodes.ADAPTER_FAILED, adapterStrings['rpc.orderResponseInvalid']);
  }
  if (result.kind === 'multiple') fail(ErrorCodes.ADAPTER_FAILED, adapterStrings['rpc.orderNotUnique']);
  const order = searchedOrderSummary(result.order);
  if (!order) fail(ErrorCodes.ADAPTER_FAILED, adapterStrings['rpc.orderIncomplete']);
  return { kind: 'one', order };
};

/** One upstream initialization attempt per account/order in this RPC lifecycle. */
async function initializeOrderGid(ctx: RpcContext, orderId: string, current: () => boolean): Promise<string> {
  ensureCurrent(current);
  const r = await createImChat(ctx.deps, ctx.soa, orderId);
  ensureCurrent(current);
  if (r.kind === 'unknown_may_have_created') fail(ErrorCodes.ADAPTER_TIMEOUT, adapterStrings['rpc.orderCreationUnknown'], false, 'unknown_may_have_created');
  if (r.kind === 'rejected') fail(ErrorCodes.ADAPTER_FAILED, adapterStrings['rpc.createimchatRejected'], false, r.errorCode === null ? undefined : String(r.errorCode));
  const plan = orderImPlan(r.url, orderId);
  if (plan.kind === 'invalid') fail(ErrorCodes.HOST_URL_REJECTED, adapterStrings['rpc.createimchatReturnedAnUnexpectedUrl'](plan.reason));
  if (plan.kind === 'target') return plan.gid;
  // Only the verified B2C2 createChat step is executed. No card, robot or send action.
  ensureCurrent(current);
  const initialized = await startOrderB2c(ctx.deps, ctx.soa, plan);
  ensureCurrent(current);
  if (initialized.kind === 'unknown_may_have_created') fail(ErrorCodes.ADAPTER_TIMEOUT, adapterStrings['rpc.orderInitializationUnknown'], false, 'unknown_may_have_created');
  if (initialized.kind === 'rejected') throw new RpcError(outcomeError(initialized.outcome, adapterStrings['rpc.orderConversationInitialization']));
  return initialized.gid;
}

const orderCreateImChat: Handler<'order.create_im_chat'> = async (ctx, args, state) => {
  const orderId = requireString(args, 'order_id');
  if (!/^(?:\d{10}|\d{16})$/.test(orderId)) fail(ErrorCodes.ADAPTER_FAILED, adapterStrings['rpc.invalidArgumentOrderId']);
  const guard = ctx.captureWriteGuard?.() ?? (() => true);
  const identity = contextFingerprint(ctx);
  const current = () => guard() && identity === contextFingerprint(ctx);
  ensureCurrent(current);
  const before = ctx.store.findByOrderId(orderId)?.gid ?? null;
  const key = JSON.stringify([identity, orderId]);
  const attempts = state.orderCreates ??= new Map();
  let attempt = attempts.get(key);
  // A new page-session lifecycle owns a new explicit operation. Tombstones are
  // intentionally session-local; unknown writes are never retried within it.
  if (attempt && !attempt.current()) { attempts.delete(key); attempt = undefined; }
  if (!attempt) {
    attempt = { current, result: initializeOrderGid(ctx, orderId, current) };
    attempts.set(key, attempt);
  }
  // An unknown write remains unknown. An older cached row cannot prove that
  // this particular initialization completed, and must not clear its tombstone.
  const gid = attempt ? await attempt.result : null;
  ensureCurrent(current);
  if (gid === null) fail(ErrorCodes.ADAPTER_NOT_READY, adapterStrings['rpc.orderConversationIdentityUnavailable'], true);
  const ready = ctx.ensureOrderConversation
    ? await ctx.ensureOrderConversation(gid, orderId, current)
    : false;
  ensureCurrent(current);
  if (!ready) fail(ErrorCodes.ADAPTER_NOT_READY, adapterStrings['rpc.orderListPending'], true, 'gid_unresolved');
  return { gid, reused: before !== null && before === gid };
};

const agentStatus: Handler<'agent.status'> = async (ctx) => {
  // Always read the authority: another device may have changed the status.
  const status = await readCurrentStatus(ctx);
  if (status === null) fail(ErrorCodes.ADAPTER_FAILED, adapterStrings['rpc.currentStatusMissingInTheReadBack']);
  return { status, confirmed: true };
};

const STATUSES: ReadonlySet<string> = new Set(Object.keys(AGENT_STATUS_CODES));

const agentSetStatus: Handler<'agent.set_status'> = async (ctx, args, state) => {
  const target = recordOrNull(args)?.['status'];
  if (typeof target !== 'string' || !STATUSES.has(target)) fail(ErrorCodes.ADAPTER_FAILED, adapterStrings['rpc.invalidArgumentStatus']);
  const current = ctx.captureWriteGuard?.() ?? (() => true);
  ensureCurrent(current);
  if (state.agentWritePending || (ctx.agent.beginWrite && !ctx.agent.beginWrite())) fail(ErrorCodes.ADAPTER_NOT_READY, adapterStrings['rpc.agentStatusChangeAlreadyPending'], true);
  state.agentWritePending = true;
  try {
    const code = AGENT_STATUS_CODES[target as AgentStatus];
    const outcome = await ctx.soa.post<unknown>(Endpoints.SET_VEN_AGENT_STATUS, { head: businessHead(ctx.deps.context), agentStatus: code });
    ensureCurrent(current);
    if (outcome.kind === 'auth_invalid') ctx.pushFact({ kind: 'auth_invalid' });
    if (outcome.kind !== 'success' && outcome.kind !== 'unknown') throw new RpcError(outcomeError(outcome, adapterStrings['rpc.setAgentStatus']));
    // success or unknown: the server read-back decides; the write is never repeated
    let status: AgentStatus | null = null;
    try {
      status = await readCurrentStatus(ctx, true);
    } catch {
      status = null;
    }
    ensureCurrent(current);
    if (status !== null) return { status, confirmed: true };
    if (outcome.kind === 'unknown') fail(ErrorCodes.ADAPTER_TIMEOUT, adapterStrings['rpc.agentStatusWriteOutcomeUnknownAndReadBackFailed'], false, 'unknown');
    // Never present an unverified requested value as observed server state.
    return { status: ctx.agent.current()?.status ?? 'getoff', confirmed: false };
  } finally {
    state.agentWritePending = false;
    ctx.agent.endWrite?.();
  }
};

function peripheralError(r: PeripheralFailure): never {
  if (r.kind === 'unsupported') fail(ErrorCodes.HOST_UNSUPPORTED, adapterStrings['rpc.unsupportedMissing'](r.missing.join(', ')));
  if (r.kind === 'invalid') fail(ErrorCodes.ADAPTER_FAILED, adapterStrings['rpc.invalidArgument'](r.field));
  if (r.kind === 'biz_failure') fail(ErrorCodes.ADAPTER_FAILED, adapterStrings['rpc.peripheralOperationRejected']);
  throw new RpcError(outcomeError(r.outcome, adapterStrings['rpc.peripheralOperation']));
}
function readValue<T>(r: PeripheralReadResult<T>): T { return r.kind === 'success' ? r.value : peripheralError(r); }
function ensureCurrent(current: () => boolean): void {
  if (!current()) fail(ErrorCodes.ADAPTER_NOT_READY, adapterStrings['rpc.adapterSessionChangedNothingSent']);
}

export const PERIPHERAL_SELECTION_TTL_MS = 30_000;
interface PeripheralSelection {
  readonly mode: 'invite' | 'members'; readonly identity: string; readonly context: string; readonly expires: number; readonly targets: ReadonlySet<string>; readonly current: () => boolean;
}
function peripheralIdentity(view: PeripheralConversation): string {
  return JSON.stringify([view.gid, view.sessionId, view.conversationKey, view.worksheetId, view.serviceType, view.conversationType, view.customerUid]);
}
function contextFingerprint(ctx: RpcContext): string { return JSON.stringify([ctx.roles.selfUid, ctx.deps.context]); }
function uidKey(uid: string): string { return uid.trim().toLowerCase(); }
function sameUid(a: string, b: string): boolean { return uidKey(a) === uidKey(b); }
/** Official desktop treats status 1 and 4 as "already in the group" (invite
 * de-dup `ve == 4 || ve == 1`); live samples show active masters as "4". */
function memberPresent(m: CurrentMember): boolean { return m.status === '1' || m.status === '4'; }
/** Official member checkbox / W0e: a merchant (vendor) agent is roles[2] == 4.
 * Fk classifies rolesV2[2] 4/5 as vendor, 1 as customer, 2/3 as Ctrip.
 * Only the exact company-service tuple is separately excluded by the panel. */
function merchant(m: CurrentMember): boolean { return m.roles[2] === 4 && !companyServiceMember(m) && ![1, 2, 3].includes(m.rolesv2?.[2] ?? 4); }
/** Official q0e: the primary agent is roles[1] == 4; transfer read-back is [3,4,4]. */
function master(m: CurrentMember): boolean { return m.roles[1] === 4; }
function memberRole(m: CurrentMember, customerUid: string | null | undefined): 'master' | 'agent' | 'customer' | 'robot' | 'company' | 'other' {
  if (m.roles[1] === 2) return 'robot';
  if (m.roles[1] === 1 || m.rolesv2?.[2] === 1 || (!!customerUid && sameUid(m.uid, customerUid))) return 'customer';
  if (master(m)) return 'master';
  if (companyServiceMember(m) || m.rolesv2?.[2] === 2 || m.rolesv2?.[2] === 3) return 'company';
  if (merchant(m)) return 'agent';
  return 'other';
}
function memberAvatar(ctx: RpcContext, uid: string, raw: string | undefined): string | null {
  const cached = ctx.roles.profileOf(uid).avatar;
  return sameUid(uid, ctx.roles.selfUid) ? cached ?? raw ?? null : raw ?? cached ?? null;
}
function companyServiceMember(m: CurrentMember): boolean { return m.rolesv2?.length === 3 && m.rolesv2[0] === 0 && m.rolesv2[1] === 3 && m.rolesv2[2] === 5; }
function rememberSelection(ctx: RpcContext, state: RpcState, view: PeripheralConversation, mode: 'invite' | 'members', targets: readonly string[], current: () => boolean, extend?: unknown) {
  // Tree expansion / search keep earlier explicitly loaded candidates selectable,
  // but only from a live token of the same conversation, context and mode.
  const prior = typeof extend === 'string' ? state.selections?.get(extend) : undefined;
  if (prior && prior.mode === mode && prior.current() && prior.context === contextFingerprint(ctx) && prior.identity === peripheralIdentity(view) && prior.expires > ctx.deps.now()) targets = [...new Set([...prior.targets, ...targets])];
  const selections = state.selections ??= new Map();
  for (const [key, old] of selections) if (old.expires <= ctx.deps.now()) selections.delete(key);
  if (selections.size >= 256) selections.delete(selections.keys().next().value!);
  state.selectionSequence = (state.selectionSequence ?? 0) + 1;
  const token = `selection-${state.selectionNamespace}-${state.selectionSequence}`;
  const expires = ctx.deps.now() + PERIPHERAL_SELECTION_TTL_MS;
  selections.set(token, { mode, identity: peripheralIdentity(view), context: contextFingerprint(ctx), expires, targets: new Set(targets), current });
  return { selection_token: token, expires_at_ms: expires };
}
function validateSelection(ctx: RpcContext, state: RpcState, args: unknown, view: PeripheralConversation, mode: PeripheralAction, targets: readonly string[]): void {
  const token = requireString(args, 'selection_token');
  const selected = state.selections?.get(token);
  if (!selected || !selected.current() || selected.mode !== (mode === 'invite' ? 'invite' : 'members') || selected.context !== contextFingerprint(ctx) || selected.identity !== peripheralIdentity(view) || selected.expires <= ctx.deps.now()) fail(ErrorCodes.ADAPTER_FAILED, adapterStrings['rpc.selectionExpiredOrConversationChangedReloadCandidates']);
  if (mode !== 'finish' && (targets.length === 0 || new Set(targets).size !== targets.length || targets.some(uid => sameUid(uid, ctx.roles.selfUid) || !selected.targets.has(uid)))) fail(ErrorCodes.ADAPTER_FAILED, adapterStrings['rpc.targetWasNotExplicitlySelectedFromCurrentCandidates']);
}

const imCustomerScripts: Handler<'im.customer_scripts'> = async (ctx, args) => {
  const current = ctx.captureWriteGuard?.() ?? (() => true);
  const content = recordOrNull(args)?.['content'];
  if (typeof content !== 'string') fail(ErrorCodes.ADAPTER_FAILED, adapterStrings['rpc.invalidArgumentContent']);
  const r = readValue(await getCustomerScripts(ctx.deps, ctx.soa, { content: content.trim() }));
  ensureCurrent(current);
  const items = r.items.map(parseScriptSuggestion).filter((s): s is QuickReplyScript => s !== null).map(scriptToUi);
  return { kind: items.length ? 'ready' : r.items.length ? 'unsupported' : 'empty', raw_count: r.items.length, items };
};
const scriptToUi = (s: QuickReplyScript) => ({ id: s.id, content: s.content, short_cut: s.shortCut, type: s.type, sort_no: s.sortNo });
const categoryToUi = (c: QuickReplyCategory): import('../../ipc/src/client.ts').UiQuickReplyCategory => ({
  id: c.id, name: c.name, code: c.code, owner_type: c.ownerType,
  skill_groups: c.skillGroups.map((g) => ({ id: g.id, name: g.name })),
  scripts: c.scripts.map(scriptToUi), sub_categories: c.subCategories.map(categoryToUi),
  script_total: c.scriptTotal,
});
function quickReplyType(args: unknown): 'VAGENT' | 'VSKILLGROUP' {
  const type = recordOrNull(args)?.['type'];
  if (type !== 'VAGENT' && type !== 'VSKILLGROUP') fail(ErrorCodes.ADAPTER_FAILED, adapterStrings['rpc.invalidArgumentType']);
  return type;
}
function manageDeps(ctx: RpcContext, current: () => boolean): ManageDeps {
  return { deps: ctx.deps, soa: ctx.soa, buid: ctx.buid ?? null, current };
}
function editToUi(out: QuickReplyEditOutcome): import('../../ipc/src/client.ts').UiQuickReplyEditResult {
  return {
    kind: out.kind,
    ...(out.reason ? { reason: out.reason } : {}),
    ...(out.detail ? { detail: out.detail } : {}),
    ...(out.categories ? { categories: out.categories.map(categoryToUi) } : {}),
  };
}
const imQuickReplyManageInfo: Handler<'im.quick_reply_manage_info'> = async (ctx, args) => {
  const current = ctx.captureWriteGuard?.() ?? (() => true);
  const type = quickReplyType(args);
  const info = await quickReplyManageInfo(manageDeps(ctx, current), type);
  ensureCurrent(current);
  if ('kind' in info) throw new RpcError(outcomeError(info.outcome, adapterStrings['rpc.quickReplies']));
  return { can_edit: info.can_edit, skill_groups: info.skill_groups.map((g) => ({ id: g.id, name: g.name })) };
};
/** Longest a timed-out quick-reply write keeps the page's write lock while its request is still out. */
export const QUICK_REPLY_WRITE_HOLD_MAX_MS = 60_000;
/** Frees the write lock once the write's exchange has settled (bounded), never while it may still land. */
function releaseQuickReplyLock(ctx: RpcContext, state: RpcState, exchange: Promise<void> | null): void {
  if (!exchange) {
    state.quickReplyWriting = false;
    return;
  }
  let done = false;
  const release = (): void => {
    if (done) return;
    done = true;
    ctx.deps.clearTimeout(timer);
    state.quickReplyWriting = false;
  };
  const timer = ctx.deps.setTimeout(release, QUICK_REPLY_WRITE_HOLD_MAX_MS);
  void exchange.then(release);
}
/**
 * Never throws: every path returns applied / rejected / unknown, and a failure
 * once the write may have been sent is `unknown` (the host would otherwise read
 * a page error as "not submitted").
 */
const imQuickReplyEdit: Handler<'im.quick_reply_edit'> = async (ctx, args, state) => {
  const current = ctx.captureWriteGuard?.() ?? (() => true);
  const type = recordOrNull(args)?.['type'];
  const edit = parseEdit(recordOrNull(args)?.['edit']);
  if ((type !== 'VAGENT' && type !== 'VSKILLGROUP') || !edit) return { kind: 'rejected', reason: 'invalid' };
  if (!current()) return { kind: 'rejected', reason: 'not_submitted' };
  if (state.quickReplyWriting) return { kind: 'rejected', reason: 'busy' };
  state.quickReplyWriting = true;
  let exchange: Promise<void> | null = null;
  try {
    const deps: ManageDeps = { ...manageDeps(ctx, current), onWriteInFlight: (p) => { exchange = p; } };
    return editToUi(await editQuickReplies(deps, type, edit));
  } catch {
    return { kind: 'unknown', reason: 'write_unknown' };
  } finally {
    releaseQuickReplyLock(ctx, state, exchange);
  }
};
const imQuickReplyCategories: Handler<'im.quick_reply_categories'> = async (ctx, args) => {
  const current = ctx.captureWriteGuard?.() ?? (() => true);
  const type = quickReplyType(args);
  const result = await getQuickReplyCategories(ctx.deps, ctx.soa, [type]);
  ensureCurrent(current);
  if (result.kind === 'failed') throw new RpcError(outcomeError(result.outcome, adapterStrings['rpc.quickReplies']));
  if (result.kind !== 'ok') fail(ErrorCodes.ADAPTER_FAILED, adapterStrings['rpc.quickRepliesRejected']);
  return { categories: result.value.map(categoryToUi) };
};
const imMembers: Handler<'im.members'> = async (ctx, args, state) => {
  const current = ctx.captureWriteGuard?.() ?? (() => true);
  const gid = requireString(args, 'gid');
  const view = requireConversation(ctx, gid);
  const members = readValue(await getCurrentMembers(ctx.deps, ctx.soa, gid));
  ensureCurrent(current);
  if (peripheralIdentity(requireConversation(ctx, gid)) !== peripheralIdentity(view)) fail(ErrorCodes.ADAPTER_FAILED, adapterStrings['rpc.conversationChangedDuringMemberRead']);
  // Official KEGe: only a present primary agent manages members; the checkbox
  // targets other present vendor agents (roles[2] == 4), never self.
  const self = members.find(m => sameUid(m.uid, ctx.roles.selfUid));
  const selfIsMaster = !!self && memberPresent(self) && master(self);
  const selectable = members.filter(m => memberPresent(m) && merchant(m) && !master(m) && !sameUid(m.uid, ctx.roles.selfUid)).map(m => m.uid);
  const order = { master: 0, agent: 1, company: 2, other: 3, customer: 4, robot: 5 } as const;
  // Official member dialog excludes exactly the company service tuple. This
  // changes presentation only; raw read-back and write eligibility stay intact.
  const shown = members.filter(m => sameUid(m.uid, ctx.roles.selfUid) || (!companyServiceMember(m) && Number(m.status) > 0))
    .map(m => ({ m, role: memberRole(m, view.customerUid) }))
    .sort((a, b) => order[a.role] - order[b.role]);
  return {
    members: shown.map(({ m, role }) => ({ uid: m.uid, nickname: m.nickname, status: m.status, roles: m.roles, avatar: memberAvatar(ctx, m.uid, m.avatar), role, present: memberPresent(m), is_self: sameUid(m.uid, ctx.roles.selfUid), can_transfer: selfIsMaster && view.conversationType !== 'B2MC' && selectable.includes(m.uid), can_remove: selfIsMaster && selectable.includes(m.uid) })),
    self_is_master: selfIsMaster, fetched_at_ms: ctx.deps.now(), ...rememberSelection(ctx, state, view, 'members', selectable, current),
  };
};
const imInviteCandidates: Handler<'im.invite_candidates'> = async (ctx, args, state) => {
  const current = ctx.captureWriteGuard?.() ?? (() => true);
  const gid = requireString(args, 'gid');
  const view = requireConversation(ctx, gid);
  const raw = recordOrNull(args) ?? {};
  const parents = raw['parent_skill_group_ids'];
  const keywords = raw['keywords'];
  if (parents !== undefined && (!Array.isArray(parents) || !parents.every(v => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0))) fail(ErrorCodes.ADAPTER_FAILED, adapterStrings['rpc.invalidArgumentParentSkillGroupIds']);
  if (keywords !== undefined && (typeof keywords !== 'string' || keywords.trim() === '' || parents !== undefined)) fail(ErrorCodes.ADAPTER_FAILED, adapterStrings['rpc.invalidArgumentKeywords']);
  const r = readValue(typeof keywords === 'string'
    ? await searchInviteMemberListBySkillGroup(ctx.deps, ctx.soa, view, keywords)
    : await getInviteMemberListBySkillGroup(ctx.deps, ctx.soa, view, parents === undefined ? {} : { parentSkillGroupIds: parents as number[] }));
  ensureCurrent(current);
  const members = readValue(await getCurrentMembers(ctx.deps, ctx.soa, gid));
  ensureCurrent(current);
  if (peripheralIdentity(requireConversation(ctx, gid)) !== peripheralIdentity(view)) fail(ErrorCodes.ADAPTER_FAILED, adapterStrings['rpc.conversationChangedDuringCandidateRead']);
  const present = new Set(members.filter(memberPresent).map(m => uidKey(m.uid)));
  // Like the official tree, self is never listed; current members stay visible
  // but disabled ("已在群中") and are not selectable targets.
  const agents = r.agents.filter(a => !sameUid(a.agentUid, ctx.roles.selfUid)).map(a => ({
    uid: a.agentUid, nickname: a.nickname, avatar: memberAvatar(ctx, a.agentUid, a.avatar), in_group: present.has(uidKey(a.agentUid)),
    status: a.status ?? null, duty_status: a.dutyStatus ?? null, job_position: a.jobPosition ?? null, job_position_type: a.jobPositionType ?? null, skill_group_full_name: a.skillGroupFullName ?? null,
  }));
  const selectable = agents.filter(a => !a.in_group).map(a => a.uid);
  return { ...rememberSelection(ctx, state, view, 'invite', selectable, current, raw['extend_token']), skill_groups: r.skillGroups.map(g => ({ skill_group_id: g.skillGroupId, name: g.skillGroupName })), agents };
};
type PeripheralAction = 'invite' | 'transfer' | 'finish' | 'remove';

async function peripheralWrite(ctx: RpcContext, args: unknown, state: RpcState, action: PeripheralAction): Promise<UiPeripheralWrite> {
  const attempt = { started: false };
  try { return await peripheralWriteInner(ctx, args, state, action, attempt); }
  catch (e) {
    if (!attempt.started && e instanceof RpcError) return { kind: 'not_submitted', confirmed: false, reason: e.appError.message };
    throw e;
  }
}

async function peripheralWriteInner(ctx: RpcContext, args: unknown, state: RpcState, action: PeripheralAction, attempt: { started: boolean }): Promise<UiPeripheralWrite> {
  const current = ctx.captureWriteGuard?.() ?? (() => true);
  ensureCurrent(current);
  const gid = requireString(args, 'gid');
  const view = requireConversation(ctx, gid);
  if (!view.sessionId) fail(ErrorCodes.HOST_UNSUPPORTED, adapterStrings['rpc.unsupportedMissingSessionId']);
  const raw = recordOrNull(args)?.['target_uids'];
  const targets = action === 'transfer' ? [requireString(args, 'target_uid')] : (action === 'invite' || action === 'remove') && Array.isArray(raw) && raw.every(v => typeof v === 'string' && v !== '') ? raw as string[] : [];
  // Enrichment can change metadata without changing the service session. It
  // must never turn an unresolved write into a new customer-visible attempt.
  const key = JSON.stringify([action, view.gid, view.sessionId, [...targets].map(uidKey).sort()]);
  const writes = state.peripheralWrites ??= new Map();
  const previous = writes.get(key);
  if (previous) { attempt.started = true; return previous; }
  if (writes.size >= 1000) fail(ErrorCodes.ADAPTER_NOT_READY, adapterStrings['rpc.peripheralActionSafetyJournalIsFullRestartTheSession']);
  validateSelection(ctx, state, args, view, action, targets);
  const p = (async (): Promise<UiPeripheralWrite> => {
    if (action !== 'finish') {
      const before = readValue(await getCurrentMembers(ctx.deps, ctx.soa, gid));
      ensureCurrent(current);
      if (action === 'invite' && targets.some(uid => before.some(m => sameUid(m.uid, uid) && memberPresent(m)))) fail(ErrorCodes.ADAPTER_FAILED, adapterStrings['rpc.targetIsAlreadyACurrentMemberReloadCandidates']);
      if (action === 'transfer') {
        // Desktop KEe allows transferVenMaster only to the current primary
        // agent and excludes B2MC. Tourism group-owner transfer is a separate,
        // unimplemented API and must not authorize this write path.
        if (view.conversationType === 'B2MC') fail(ErrorCodes.ADAPTER_FAILED, adapterStrings['rpc.primaryAgentTransferIsUnavailableForB2MC']);
        if (!before.some(m => sameUid(m.uid, ctx.roles.selfUid) && memberPresent(m) && master(m))) fail(ErrorCodes.ADAPTER_FAILED, adapterStrings['rpc.onlyTheCurrentPrimaryAgentCanTransferMembers']);
        if (!before.some(m => sameUid(m.uid, targets[0]!) && memberPresent(m) && merchant(m) && !master(m))) fail(ErrorCodes.ADAPTER_FAILED, adapterStrings['rpc.transferTargetIsNoLongerAnEligibleCurrentMember']);
      }
      if (action === 'remove') {
        if (!before.some(m => sameUid(m.uid, ctx.roles.selfUid) && memberPresent(m) && master(m))) fail(ErrorCodes.ADAPTER_FAILED, adapterStrings['rpc.onlyTheCurrentPrimaryAgentCanRemoveMembers']);
        if (!targets.every(uid => before.some(m => sameUid(m.uid, uid) && memberPresent(m) && merchant(m) && !master(m)))) fail(ErrorCodes.ADAPTER_FAILED, adapterStrings['rpc.removeTargetIsNoLongerACurrentVendorAgent']);
      }
      validateSelection(ctx, state, args, view, action, targets);
    }
    ensureCurrent(current);
    if (peripheralIdentity(requireConversation(ctx, gid)) !== peripheralIdentity(view)) fail(ErrorCodes.ADAPTER_FAILED, adapterStrings['rpc.conversationChangedNothingSent']);
    validateSelection(ctx, state, args, view, action, targets);
    attempt.started = true;
    const result = action === 'invite' ? await inviteVenAgent(ctx.deps, ctx.soa, view, { venAgentUidList: targets })
      : action === 'transfer' ? await transferVenMaster(ctx.deps, ctx.soa, view, { targetVenAgentUid: targets[0]! })
      : action === 'remove' ? await removeVenAgents(ctx.deps, ctx.soa, view, targets)
      : await finishConversation(ctx.deps, ctx.soa, view);
    if (result.kind === 'unsupported' || result.kind === 'invalid') attempt.started = false;
    if (result.kind !== 'accepted' && result.kind !== 'unknown') peripheralError(result);
    if (!current()) return { kind: 'unknown', confirmed: false, reason: 'session changed after submission; do not resubmit' };
    let confirmed = false;
    try {
      if (action === 'finish') {
        const read = readValue(await getLatestConversationState(ctx.deps, ctx.soa, gid));
        confirmed = read.sessionId === view.sessionId && read.status === 4 && read.inGroup === -1;
      } else {
        const after = readValue(await getCurrentMembers(ctx.deps, ctx.soa, gid));
        confirmed = action === 'invite' ? targets.every(uid => after.some(m => sameUid(m.uid, uid) && memberPresent(m)))
          : action === 'remove' ? targets.every(uid => !after.some(m => sameUid(m.uid, uid) && memberPresent(m)))
          : after.some(m => sameUid(m.uid, targets[0]!) && memberPresent(m) && master(m));
      }
    } catch { /* Read-back failure never replays a write or promotes acceptance. */ }
    if (!current() || peripheralIdentity(requireConversation(ctx, gid)) !== peripheralIdentity(view)) return { kind: 'unknown', confirmed: false, reason: 'session changed after submission; do not resubmit' };
    return confirmed ? { kind: 'confirmed', confirmed: true } : { kind: result.kind, confirmed: false, reason: 'independent read-back did not confirm; do not resubmit' };
  })();
  // Retain successes and errors: duplicate calls never replay an upstream write.
  writes.set(key, p);
  p.catch(() => { if (!attempt.started) writes.delete(key); }); // Proven pre-submit failure only.
  return p;
}
const imInvite: Handler<'im.invite'> = (ctx, args, state) => peripheralWrite(ctx, args, state, 'invite');
const imTransfer: Handler<'im.transfer'> = (ctx, args, state) => peripheralWrite(ctx, args, state, 'transfer');
const imFinish: Handler<'im.finish'> = (ctx, args, state) => peripheralWrite(ctx, args, state, 'finish');
const imRemove: Handler<'im.remove'> = (ctx, args, state) => peripheralWrite(ctx, args, state, 'remove');

const HANDLERS: { readonly [K in AdapterOp]: Handler<K> } = {
  'clock.sample': async (ctx) => {
    const current = ctx.captureWriteGuard?.() ?? (() => true);
    ensureCurrent(current);
    const self = ctx.roles.selfUid;
    // No endpoint, URL, timestamp or identity is accepted from the requester.
    const outcome = await ctx.soa.post<{ jid?: unknown; ResponseStatus?: unknown }>(Endpoints.MY_INFO, { head: sdkHead(ctx.deps.context) }, { rejectRedirects: true });
    ensureCurrent(current);
    if (ctx.roles.selfUid !== self || outcome.kind !== 'success') fail(ErrorCodes.ADAPTER_NOT_READY, adapterStrings['rpc.serverClockSampleUnavailable'], true);
    const jid = outcome.body.jid;
    const stamp = parseSoaTimestamp(recordOrNull(outcome.body.ResponseStatus)?.['Timestamp']);
    if (!self || typeof jid !== 'string' || jidLocal(jid).toLowerCase() !== self.toLowerCase() || stamp === null || !Number.isSafeInteger(stamp) || stamp < 946684800000 || stamp >= 4102444800000) fail(ErrorCodes.ADAPTER_FAILED, adapterStrings['rpc.invalidServerClockSample']);
    return { server_ms: stamp };
  },
  'assistant.scope': async (ctx, args) => {
    const gid = requireString(args, 'gid'), expected = requireString(args, 'context_revision');
    const current = ctx.captureWriteGuard?.() ?? (() => true);
    const view = requireConversation(ctx, gid);
    const revision = ctx.store.assistantContextRevision(gid, ctx.roles.selfUid, partnerJidOf(ctx, gid));
    if (!current() || !revision || revision !== expected) fail(ErrorCodes.ACCOUNT_STALE_GENERATION, 'assistant conversation identity changed');
    return { context_revision: revision, order_id: ctx.store.orderId(gid) };
  },
  'media.target': (ctx, args, state) => (state.media ??= createMediaRpc(ctx)).target(args),
  'media.validate': (ctx, args, state) => (state.media ??= createMediaRpc(ctx)).validate(args),
  'media.release': (ctx, args, state) => (state.media ??= createMediaRpc(ctx)).release(args),
  'media.discard': (ctx, args, state) => (state.media ??= createMediaRpc(ctx)).discard(args),
  'media.stage_begin': (ctx, args, state) => (state.media ??= createMediaRpc(ctx)).begin(args),
  'media.stage_chunk': (ctx, args, state) => (state.media ??= createMediaRpc(ctx)).chunk(args),
  'media.upload': (ctx, args, state) => (state.media ??= createMediaRpc(ctx)).upload(args),
  'im.send_media': (ctx, args, state) => (state.media ??= createMediaRpc(ctx)).send(args),
  'adapter.diagnostics': async (ctx) => {
    if (!ctx.receiveDiagnostics) fail(ErrorCodes.HOST_UNSUPPORTED, adapterStrings['rpc.receiveDiagnosticsUnavailable']);
    return ctx.receiveDiagnostics();
  },
  'im.customer_scripts': imCustomerScripts,
  'im.quick_reply_categories': imQuickReplyCategories,
  'im.quick_reply_manage_info': imQuickReplyManageInfo,
  'im.quick_reply_edit': imQuickReplyEdit,
  'im.recommend_products': (ctx, args, state) => (state.recommend ??= createRecommendRpc(ctx)).query(args),
  'im.recommend_cities': (ctx, args, state) => (state.recommend ??= createRecommendRpc(ctx)).cities(args),
  'im.send_product_card': (ctx, args, state) => (state.recommend ??= createRecommendRpc(ctx)).send(args),
  'im.members': imMembers,
  'im.invite_candidates': imInviteCandidates,
  'im.invite': imInvite,
  'im.transfer': imTransfer,
  'im.finish': imFinish,
  'im.remove': imRemove,
  'im.outbound_lookup': imOutboundLookup,
  'im.messages': imMessages,
  'im.message_page': imMessagePage,
  'im.translate_messages': imTranslateMessages,
  'im.forward_message': (ctx, args, state) => (state.messageActions ??= createMessageActionsRpc(ctx)).forward(args),
  'im.send_saved_image': (ctx, args, state) => (state.messageActions ??= createMessageActionsRpc(ctx)).sendImage(args),
  'im.send_text': imSendText,
  'im.mark_read': imMarkRead,
  'im.set_mark': imSetMark,
  'notice.categories': noticeCategories,
  'notice.watch': noticeWatch,
  'notice.list': noticeList,
  'notice.mark_read': noticeMarkRead,
  'order.search': orderSearch,
  'order.create_im_chat': orderCreateImChat,
  'agent.set_status': agentSetStatus,
  'agent.status': agentStatus,
};

export interface Rpc {
  /** Never throws; malformed requests without a usable `req_id` resolve to `null` (nothing to answer). */
  handle(request: unknown): Promise<AdapterReplyPayload | null>;
}

let rpcSequence = 0;
export function createRpc(ctx: RpcContext): Rpc {
  const state: RpcState = { sends: new Map(), categories: new Map(), selectionNamespace: `${ctx.deps.now()}-${ctx.deps.random()}-${++rpcSequence}` };
  const features = ctx.features ?? createFeatureDispatcher(createAdapterFeatures());
  return {
    async handle(request) {
      const r = recordOrNull(request);
      const reqId = r?.['req_id'];
      if (typeof reqId !== 'string' || reqId === '') return null;
      const op = r?.['op'];
      if (typeof op === 'string' && !Object.prototype.hasOwnProperty.call(HANDLERS, op) && features.has(op)) {
        const args = r?.['args'] ?? {};
        try {
          return { req_id: reqId, ok: true, data: await features.call(op, args, featureOpContext(ctx, args)) };
        } catch (e: unknown) {
          // FeatureOpError = argument/dispatch refusal before any request; anything else is an adapter bug.
          const code = e instanceof FeatureOpError ? e.code : ErrorCodes.ADAPTER_FAILED;
          const message = e instanceof FeatureOpError ? e.message : 'adapter error';
          return { req_id: reqId, ok: false, error: { code, message, retryable: e instanceof FeatureOpError ? e.retryable : false } };
        }
      }
      if (typeof op !== 'string' || !Object.prototype.hasOwnProperty.call(HANDLERS, op)) {
        return { req_id: reqId, ok: false, error: { code: ErrorCodes.HOST_UNSUPPORTED, message: adapterStrings['rpc.unknownOp'], retryable: false } };
      }
      const handler = HANDLERS[op as AdapterOp] as Handler<AdapterOp>;
      try {
        const data = await handler(ctx, r?.['args'] ?? {}, state);
        return { req_id: reqId, ok: true, data };
      } catch (e: unknown) {
        if (e instanceof RpcError || e instanceof MessageActionRpcError || e instanceof RecommendRpcError) return { req_id: reqId, ok: false, error: e.appError };
        return { req_id: reqId, ok: false, error: { code: ErrorCodes.ADAPTER_FAILED, message: 'adapter error', retryable: false } };
      }
    },
  };
}

export function notReadyReply(request: unknown): AdapterReplyPayload | null {
  const reqId = recordOrNull(request)?.['req_id'];
  if (typeof reqId !== 'string' || reqId === '') return null;
  return { req_id: reqId, ok: false, error: { code: ErrorCodes.ADAPTER_NOT_READY, message: adapterStrings['rpc.pageAdapterIsStillStarting'], retryable: true } };
}
