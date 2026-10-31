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
import type { AgentStatus, MarkAction, UiMessage, UiNoticeCategory, UiPeripheralWrite } from '../../ipc/src/client.ts';
import type { AdapterDisplayPayload, AdapterOp, AdapterReplyPayload, AdapterResultMap } from '../../ipc/src/adapterProtocol.ts';
import type { AdapterDeps } from './deps.ts';
import { getCustomerScripts, getCurrentMembers, getInviteMemberListBySkillGroup, getLatestConversationState, finishConversation, inviteVenAgent, transferVenMaster, type PeripheralFailure, type PeripheralReadResult, type CurrentMember, type PeripheralConversation } from './peripheral.ts';
import { Endpoints } from './endpoints.ts';
import { businessHead } from './heads.ts';
import type { SoaClient, SoaOutcome } from './soa.ts';
import { recordOrNull } from './soa.ts';
import { conversationListBody, type ConversationListResponse } from './conversationList.ts';
import { fetchHistoryPage } from './history.ts';
import { createSendIntent, submitIntent, type SendIntent } from './send.ts';
import { markRead } from './markRead.ts';
import { numericGid, setWorkSheetStar } from './worksheetStar.ts';
import { createImChat, isValidOrderId, validateImUrl } from './order.ts';
import { AGENT_STATUS_CODES, agentStatusOf, byCreateTime, httpMessageToUi, orderSummaryFromMessage, toDisplayConversation } from './display.ts';
import type { PageSdk } from './sdkGlue.ts';
import { roomJidFromMessage, type ConversationStore, RoleBook } from './stores.ts';
import { fetchNoticeCategories, fetchNoticeList, markNoticeRead, parseNoticeCategoryId, type NoticeCategoryInfo } from './notice.ts';

export const OP_EVIDENCE: Readonly<Record<AdapterOp, string>> = {
  'adapter.diagnostics': 'read-only local receive counters; no upstream operation',
  'im.customer_scripts': 'getCustomerScripts (evidence 51); nonempty entry schema unsupported',
  'im.members': 'checkMemberStatus (evidence 55), current status and roles',
  'im.invite_candidates': 'getInviteMemberListBySkillGroup (evidence 24)',
  'im.invite': 'inviteVenAgent (evidence 29), independent membership read-back',
  'im.transfer': 'transferVenMaster (evidence 26), targetRoles=[3,4,4] read-back',
  'im.finish': 'finishConversation (47), status=4/inGroup=-1 read-back (48)',
  'im.outbound_lookup': 'getMessageList latest page, identity metadata only; no facts, display or mark-read',
  'im.messages': 'getMessageList (endpoint doc, evidence 70); checkMemberStatus roles (13500 doc, evidence 55)',
  'im.send_text': 'WS body/send_result (transports.md, evidence 35/40); SDK facade name unverified',
  'im.mark_read': 'PutAdviceOfReadByMsgId.json body (11679 doc, evidence 71)',
  'im.set_mark': 'setWorkSheetStar (16037 doc, evidence 72-75)',
  'notice.categories': 'getIQConversations (11679 doc, sample 60, order-page head)',
  'notice.list': 'getIQMessages static call site only (web-message-notice-static iq-list-and-read)',
  'notice.mark_read': 'putAdviceofreadIQMessage static call site only (same excerpt)',
  'order.search': 'UNSUPPORTED: searchorderlist page / aggSortType.property redacted (14361 doc "待追溯")',
  'order.create_im_chat': 'createimchat (14361 doc, evidence 61); gid only via targetGid or cached row',
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
  readonly sendAckTimeoutMs?: number;
  readonly orderGidWaitMs?: number;
  /** Captures the current lifecycle generation; old awaited work must never write. */
  readonly captureWriteGuard?: () => (() => boolean);
  readonly receiveDiagnostics?: () => import('../../ipc/src/client.ts').UiPageReceiveDiagnostics;
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
      return { code: ErrorCodes.ACCOUNT_TICKET_EXPIRED, message: `${what}: login expired`, retryable: false };
    case 'timeout':
      return { code: ErrorCodes.NET_TIMEOUT, message: `${what}: timeout`, retryable: true };
    case 'network_error':
      return { code: ErrorCodes.NET_OFFLINE, message: `${what}: network error`, retryable: true };
    case 'unknown':
      return { code: ErrorCodes.ADAPTER_TIMEOUT, message: `${what}: outcome unknown (not retried)`, retryable: false, detail: 'unknown' };
    case 'business_failure': {
      const code = outcome.errors[0]?.ErrorCode;
      return code ? { code: ErrorCodes.ADAPTER_FAILED, message: `${what}: rejected`, retryable: false, detail: code } : { code: ErrorCodes.ADAPTER_FAILED, message: `${what}: rejected`, retryable: false };
    }
    case 'http_error':
      return { code: ErrorCodes.ADAPTER_FAILED, message: `${what}: http ${outcome.httpStatus}`, retryable: true };
    case 'malformed':
      return { code: ErrorCodes.ADAPTER_FAILED, message: `${what}: malformed response`, retryable: false };
    case 'success':
      return { code: ErrorCodes.ADAPTER_FAILED, message: `${what}: unexpected`, retryable: false };
  }
}

function requireString(args: unknown, key: string): string {
  const v = recordOrNull(args)?.[key];
  if (typeof v !== 'string' || v === '') fail(ErrorCodes.ADAPTER_FAILED, `invalid argument: ${key}`);
  return v;
}

function requireConversation(ctx: RpcContext, gid: string) {
  const view = ctx.store.view(gid);
  if (!view) fail(ErrorCodes.ADAPTER_NOT_READY, 'conversation not in the page cache yet', true);
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

export async function readCurrentStatus(ctx: RpcContext): Promise<AgentStatus | null> {
  const outcome = await ctx.soa.post<ConversationListResponse>(Endpoints.CONVERSATION_LIST, conversationListBody(ctx.deps, null, false));
  if (outcome.kind !== 'success') fail(outcomeError(outcome, 'agent status').code, outcomeError(outcome, 'agent status').message, true);
  const status = agentStatusOf(outcome.body.currentStatus);
  if (status !== null) ctx.agent.set(status, true);
  return status;
}

// ------------------------------------------------------------- handlers

type Handler<K extends AdapterOp> = (ctx: RpcContext, args: unknown, state: RpcState) => Promise<AdapterResultMap[K]>;

interface RpcState {
  readonly sends: Map<string, Promise<SendDisposition>>;
  readonly categories: Map<string, NoticeCategoryInfo>;
  selections?: Map<string, PeripheralSelection>;
  peripheralWrites?: Map<string, Promise<UiPeripheralWrite>>;
  selectionSequence?: number;
  readonly selectionNamespace: string;
}

/** Isolated latest-page evidence read. No shared role/store mutation or UI/fact publication. */
const imOutboundLookup: Handler<'im.outbound_lookup'> = async (ctx, args) => {
  const current = ctx.captureWriteGuard?.() ?? (() => true);
  ensureCurrent(current);
  const gid = requireString(args, 'gid');
  const view = requireConversation(ctx, gid);
  if (!view.conversationType) fail(ErrorCodes.ADAPTER_FAILED, 'conversationType unknown for this conversation');
  const owner = JSON.stringify([sendIdentity(ctx, view), view.orderId]);
  const roles = new RoleBook(ctx.roles.selfUid);
  const res = await fetchHistoryPage(ctx.deps, ctx.soa, { gid, conversationType: view.conversationType, pageSize: 30 }, roles);
  ensureCurrent(current);
  if (JSON.stringify([sendIdentity(ctx, requireConversation(ctx, gid)), requireConversation(ctx, gid).orderId]) !== owner) fail(ErrorCodes.ADAPTER_NOT_READY, 'conversation changed during outbound lookup');
  if (res.kind === 'invalid_cursor') fail(ErrorCodes.ADAPTER_FAILED, 'invalid history cursor');
  if (res.kind === 'failed') throw new RpcError(outcomeError(res.outcome, 'outbound lookup'));
  const items = res.page.rows.map(row => httpMessageToUi(row, roles, gid)).filter((row): row is UiMessage => row !== null)
    .map(({ gid, message_id, local_id, sender_role }) => ({ gid, message_id, local_id, sender_role }));
  return { items };
};

const imMessages: Handler<'im.messages'> = async (ctx, args) => {
  const current = ctx.captureWriteGuard?.() ?? (() => true);
  const gid = requireString(args, 'gid');
  const view = requireConversation(ctx, gid);
  if (!view.conversationType) fail(ErrorCodes.ADAPTER_FAILED, 'conversationType unknown for this conversation');
  const historyOwner = JSON.stringify([sendIdentity(ctx, view), view.orderId]);
  const checkHistoryContext = (): void => {
    ensureCurrent(current);
    const live = requireConversation(ctx, gid);
    if (JSON.stringify([sendIdentity(ctx, live), live.orderId]) !== historyOwner) fail(ErrorCodes.ADAPTER_NOT_READY, 'conversation changed during history read');
  };
  checkHistoryContext();
  await ctx.roles.ensure(ctx.deps, ctx.soa, gid);
  checkHistoryContext();
  const res = await fetchHistoryPage(ctx.deps, ctx.soa, { gid, conversationType: view.conversationType, pageSize: HISTORY_PAGE_SIZE }, ctx.roles);
  checkHistoryContext();
  if (res.kind === 'invalid_cursor') fail(ErrorCodes.ADAPTER_FAILED, 'invalid history cursor');
  if (res.kind === 'failed') throw new RpcError(outcomeError(res.outcome, 'history'));
  for (const fact of res.page.facts) ctx.pushFact({ kind: 'message', fact });
  const items: UiMessage[] = [];
  for (const row of res.page.rows) {
    const ui = httpMessageToUi(row, ctx.roles, gid);
    if (ui) items.push(ui);
    if (typeof row === 'object' && row !== null) {
      const order = ui ? orderSummaryFromMessage(row) : null;
      if (order && ui) ctx.store.noteOrder(gid, order, ui.create_time_ms);
      ctx.store.noteMessage(gid, row.msgId, row.createTime);
      const jid = roomJidFromMessage(gid, row);
      if (jid) ctx.sdk.rememberPartnerJid(gid, jid);
    }
  }
  items.sort(byCreateTime);
  const row = ctx.store.row(gid);
  const display = row ? toDisplayConversation(row, false) : null;
  if (display) {
    const profile = view.customerUid ? ctx.roles.profileOf(view.customerUid) : null;
    ctx.pushDisplay({ kind: 'conversations', full: false, items: [{ ...display, customer_avatar: profile?.avatar ?? null, title: profile?.name ?? display.title, order: ctx.store.order(gid) ?? display.order }], removed_gids: [] });
  }
  ctx.pushDisplay({ kind: 'messages', gid, replace: true, items });
  return items;
};

async function sendOnce(ctx: RpcContext, gid: string, localId: string, text: string, original: string | null, quoteId: string | null, attempt: { started: boolean }): Promise<SendDisposition> {
  const current = ctx.captureWriteGuard?.() ?? (() => true);
  ensureCurrent(current);
  const view = requireConversation(ctx, gid);
  const identity = sendIdentity(ctx, view);
  let targetJid = partnerJidOf(ctx, gid);
  const checkTarget = (): string | null => {
    ensureCurrent(current);
    if (sendIdentity(ctx, requireConversation(ctx, gid)) !== identity) fail(ErrorCodes.ADAPTER_NOT_READY, 'conversation identity changed before submission (nothing sent)');
    const liveTarget = partnerJidOf(ctx, gid);
    if (targetJid !== null && liveTarget !== targetJid) fail(ErrorCodes.ADAPTER_NOT_READY, 'conversation target changed before submission (nothing sent)');
    return liveTarget;
  };
  if (view.serviceType === '') fail(ErrorCodes.ADAPTER_FAILED, 'serviceType unknown for this conversation');
  if (!ctx.sdk.canSend) fail(ErrorCodes.HOST_UNSUPPORTED, 'official SDK send entry not found on the page (nothing sent)');
  checkTarget();
  if (!partnerJidOf(ctx, gid)) await imMessages(ctx, { gid }, { sends: new Map(), categories: new Map(), selectionNamespace: '' });
  // A history read may learn the original room. It cannot authorize replacing
  // the service/customer/thread captured before awaiting that read.
  targetJid = checkTarget();
  if (!targetJid) fail(ErrorCodes.ADAPTER_NOT_READY, 'target jid not known yet (nothing sent)', true);
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
  if (text.length > MAX_TEXT_CHARS) fail(ErrorCodes.ADAPTER_FAILED, 'text too long (nothing sent)');
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
  const gid = requireString(args, 'gid');
  requireConversation(ctx, gid);
  const partnerJid = partnerJidOf(ctx, gid);
  const latest = ctx.store.latestMessage(gid);
  if (!partnerJid || !latest) fail(ErrorCodes.ADAPTER_NOT_READY, 'no message / target jid known for this conversation yet', true);
  const r = await markRead(ctx.sdk, { partnerJid, msgId: latest.msgId });
  if (r.kind === 'acked') return null;
  if (r.kind === 'unknown') fail(ErrorCodes.ADAPTER_TIMEOUT, 'read receipt outcome unknown (not retried)', false, 'unknown');
  return fail(ErrorCodes.ADAPTER_FAILED, 'read receipt rejected');
};

const MARKS: ReadonlySet<number> = new Set([0, 1, 2, 3, 4, 5]);

const imSetMark: Handler<'im.set_mark'> = async (ctx, args) => {
  const gid = requireString(args, 'gid');
  const action = recordOrNull(args)?.['action'];
  if (typeof action !== 'number' || !MARKS.has(action)) fail(ErrorCodes.ADAPTER_FAILED, 'invalid argument: action');
  const view = requireConversation(ctx, gid);
  const groupId = numericGid(gid);
  if (view.sessionId === null || view.worksheetId === null || groupId === null) fail(ErrorCodes.ADAPTER_FAILED, 'sessionId / worksheetId / numeric gid unknown for this conversation');
  const r = await setWorkSheetStar(ctx.deps, ctx.soa, { sessionId: view.sessionId, groupId, worksheetId: view.worksheetId, action: action as MarkAction });
  if (r.applied) return null;
  if (r.reason === 'biz_failure') fail(ErrorCodes.ADAPTER_FAILED, 'mark rejected by the server');
  throw new RpcError(outcomeError(r.outcome, 'set mark'));
};

const noticeCategories: Handler<'notice.categories'> = async (ctx, _args, state) => {
  const r = await fetchNoticeCategories(ctx.deps, ctx.soa);
  if (!r.ok) throw new RpcError(outcomeError(r.outcome, 'notice categories'));
  state.categories.clear();
  for (const c of r.items) state.categories.set(c.id, c);
  const items: UiNoticeCategory[] = r.items.map((c) => ({ id: c.id, name: c.name, unread: c.unread }));
  ctx.pushDisplay({ kind: 'notice_categories', items });
  return items;
};

const noticeList: Handler<'notice.list'> = async (ctx, args, state) => {
  const id = requireString(args, 'category_id');
  const ref = parseNoticeCategoryId(id);
  if (!ref) fail(ErrorCodes.ADAPTER_FAILED, 'invalid argument: category_id');
  const cat = state.categories.get(id);
  const r = await fetchNoticeList(ctx.deps, ctx.soa, ref, cat?.lastMsgTime ?? 0);
  if (!r.ok) throw new RpcError(outcomeError(r.outcome, 'notice list'));
  return r.items;
};

const noticeMarkRead: Handler<'notice.mark_read'> = async (ctx, args, state) => {
  const id = requireString(args, 'category_id');
  const ref = parseNoticeCategoryId(id);
  if (!ref) fail(ErrorCodes.ADAPTER_FAILED, 'invalid argument: category_id');
  const explicit = recordOrNull(args)?.['id'];
  const msgId = typeof explicit === 'string' && explicit !== '' ? explicit : (state.categories.get(id)?.lastMsgId ?? null);
  if (msgId === null) fail(ErrorCodes.ADAPTER_NOT_READY, 'no notice id known for this category (load categories first)', true);
  const outcome = await markNoticeRead(ctx.deps, ctx.soa, ref, msgId);
  if (outcome.kind === 'success') return null;
  throw new RpcError(outcomeError(outcome, 'notice mark read'));
};

const orderSearch: Handler<'order.search'> = async () =>
  fail(ErrorCodes.HOST_UNSUPPORTED, 'order search is not available: searchorderlist page / aggSortType.property are not documented', false);

function waitForOrderRow(ctx: RpcContext, orderId: string, timeoutMs: number): Promise<string | null> {
  const hit = ctx.store.findByOrderId(orderId);
  if (hit) return Promise.resolve(hit.gid);
  return new Promise((resolve) => {
    let done = false;
    const finish = (gid: string | null): void => {
      if (done) return;
      done = true;
      unwatch();
      resolve(gid);
    };
    const unwatch = ctx.store.watch(() => {
      const v = ctx.store.findByOrderId(orderId);
      if (v) finish(v.gid);
    });
    ctx.deps.setTimeout(() => finish(null), timeoutMs);
  });
}

const orderCreateImChat: Handler<'order.create_im_chat'> = async (ctx, args) => {
  const orderId = requireString(args, 'order_id');
  if (!isValidOrderId(orderId)) fail(ErrorCodes.ADAPTER_FAILED, 'invalid argument: order_id');
  const before = ctx.store.findByOrderId(orderId)?.gid ?? null;
  const r = await createImChat(ctx.deps, ctx.soa, orderId);
  if (r.kind === 'unknown_may_have_created') fail(ErrorCodes.ADAPTER_TIMEOUT, 'createimchat outcome unknown; the conversation may have been created (not retried)', false, 'unknown_may_have_created');
  if (r.kind === 'rejected') fail(ErrorCodes.ADAPTER_FAILED, 'createimchat rejected', false, r.errorCode === null ? undefined : String(r.errorCode));
  const v = validateImUrl(r.url);
  if (!v.ok) fail(ErrorCodes.HOST_URL_REJECTED, `createimchat returned an unexpected url (${v.reason})`);
  const target = v.params.targetGid;
  const gid = target !== null && target !== '' ? target : await waitForOrderRow(ctx, orderId, ctx.orderGidWaitMs ?? ORDER_GID_WAIT_MS);
  if (gid === null) fail(ErrorCodes.ADAPTER_FAILED, 'conversation for this order not visible in the list yet (createimchat succeeded)', true, 'gid_unresolved');
  return { gid, reused: before !== null && before === gid };
};

const agentStatus: Handler<'agent.status'> = async (ctx) => {
  const cur = ctx.agent.current();
  if (cur && cur.confirmed) return cur;
  const status = await readCurrentStatus(ctx);
  if (status === null) fail(ErrorCodes.ADAPTER_FAILED, 'currentStatus missing in the read-back');
  return { status, confirmed: true };
};

const STATUSES: ReadonlySet<string> = new Set(Object.keys(AGENT_STATUS_CODES));

const agentSetStatus: Handler<'agent.set_status'> = async (ctx, args) => {
  const target = recordOrNull(args)?.['status'];
  if (typeof target !== 'string' || !STATUSES.has(target)) fail(ErrorCodes.ADAPTER_FAILED, 'invalid argument: status');
  const code = AGENT_STATUS_CODES[target as AgentStatus];
  const outcome = await ctx.soa.post<unknown>(Endpoints.SET_VEN_AGENT_STATUS, { head: businessHead(ctx.deps.context), agentStatus: code });
  if (outcome.kind !== 'success' && outcome.kind !== 'unknown') throw new RpcError(outcomeError(outcome, 'set agent status'));
  // success or unknown: the server read-back decides; the write is never repeated
  let status: AgentStatus | null = null;
  try {
    status = await readCurrentStatus(ctx);
  } catch {
    status = null;
  }
  if (status !== null) return { status, confirmed: true };
  if (outcome.kind === 'unknown') fail(ErrorCodes.ADAPTER_TIMEOUT, 'agent status write outcome unknown and read-back failed (not retried)', false, 'unknown');
  return { status: target as AgentStatus, confirmed: false };
};

function peripheralError(r: PeripheralFailure): never {
  if (r.kind === 'unsupported') fail(ErrorCodes.HOST_UNSUPPORTED, `unsupported: missing ${r.missing.join(', ')}`);
  if (r.kind === 'invalid') fail(ErrorCodes.ADAPTER_FAILED, `invalid argument: ${r.field}`);
  if (r.kind === 'biz_failure') fail(ErrorCodes.ADAPTER_FAILED, 'peripheral operation rejected');
  throw new RpcError(outcomeError(r.outcome, 'peripheral operation'));
}
function readValue<T>(r: PeripheralReadResult<T>): T { return r.kind === 'success' ? r.value : peripheralError(r); }
function ensureCurrent(current: () => boolean): void {
  if (!current()) fail(ErrorCodes.ADAPTER_NOT_READY, 'adapter session changed (nothing sent)');
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
function memberPresent(m: CurrentMember): boolean { return m.status === '1'; }
function merchant(m: CurrentMember): boolean { return m.roles[1] === 4 || m.roles[2] === 4; }
function master(m: CurrentMember): boolean { return m.roles[0] === 3 && m.roles[1] === 4 && m.roles[2] === 4; }
function memberAvatar(ctx: RpcContext, uid: string, raw: string | undefined): string | null {
  const cached = ctx.roles.profileOf(uid).avatar;
  return sameUid(uid, ctx.roles.selfUid) ? cached ?? raw ?? null : raw ?? cached ?? null;
}
function companyServiceMember(m: CurrentMember): boolean { return m.rolesv2?.length === 3 && m.rolesv2[0] === 0 && m.rolesv2[1] === 3 && m.rolesv2[2] === 5; }
function rememberSelection(ctx: RpcContext, state: RpcState, view: PeripheralConversation, mode: 'invite' | 'members', targets: readonly string[], current: () => boolean) {
  const selections = state.selections ??= new Map();
  for (const [key, old] of selections) if (old.expires <= ctx.deps.now()) selections.delete(key);
  if (selections.size >= 256) selections.delete(selections.keys().next().value!);
  state.selectionSequence = (state.selectionSequence ?? 0) + 1;
  const token = `selection-${state.selectionNamespace}-${state.selectionSequence}`;
  const expires = ctx.deps.now() + PERIPHERAL_SELECTION_TTL_MS;
  selections.set(token, { mode, identity: peripheralIdentity(view), context: contextFingerprint(ctx), expires, targets: new Set(targets), current });
  return { selection_token: token, expires_at_ms: expires };
}
function validateSelection(ctx: RpcContext, state: RpcState, args: unknown, view: PeripheralConversation, mode: 'invite' | 'transfer' | 'finish', targets: readonly string[]): void {
  const token = requireString(args, 'selection_token');
  const selected = state.selections?.get(token);
  if (!selected || !selected.current() || selected.mode !== (mode === 'invite' ? 'invite' : 'members') || selected.context !== contextFingerprint(ctx) || selected.identity !== peripheralIdentity(view) || selected.expires <= ctx.deps.now()) fail(ErrorCodes.ADAPTER_FAILED, 'selection expired or conversation changed; reload candidates');
  if (mode !== 'finish' && (targets.length === 0 || new Set(targets).size !== targets.length || targets.some(uid => sameUid(uid, ctx.roles.selfUid) || !selected.targets.has(uid)))) fail(ErrorCodes.ADAPTER_FAILED, 'target was not explicitly selected from current candidates');
}

const imCustomerScripts: Handler<'im.customer_scripts'> = async (ctx, args) => {
  const current = ctx.captureWriteGuard?.() ?? (() => true);
  const content = recordOrNull(args)?.['content'];
  if (typeof content !== 'string') fail(ErrorCodes.ADAPTER_FAILED, 'invalid argument: content');
  const r = readValue(await getCustomerScripts(ctx.deps, ctx.soa, { content }));
  ensureCurrent(current);
  return r.items.length === 0 ? { kind: 'empty', raw_count: 0 } : { kind: 'unsupported', raw_count: r.items.length, reason: 'nonempty customerScripts fields have no captured schema' };
};
const imMembers: Handler<'im.members'> = async (ctx, args, state) => {
  const current = ctx.captureWriteGuard?.() ?? (() => true);
  const gid = requireString(args, 'gid');
  const view = requireConversation(ctx, gid);
  const members = readValue(await getCurrentMembers(ctx.deps, ctx.soa, gid));
  ensureCurrent(current);
  if (peripheralIdentity(requireConversation(ctx, gid)) !== peripheralIdentity(view)) fail(ErrorCodes.ADAPTER_FAILED, 'conversation changed during member read');
  const selectable = members.filter(m => memberPresent(m) && merchant(m) && !master(m) && !sameUid(m.uid, ctx.roles.selfUid)).map(m => m.uid);
  // Official member dialog excludes exactly the company service tuple. This
  // changes presentation only; raw read-back and write eligibility stay intact.
  return { members: members.filter(m => sameUid(m.uid, ctx.roles.selfUid) || (!companyServiceMember(m) && Number(m.status) > 0)).map(m => ({ uid: m.uid, nickname: m.nickname, status: m.status, roles: m.roles, avatar: memberAvatar(ctx, m.uid, m.avatar), can_transfer: selectable.includes(m.uid) })), fetched_at_ms: ctx.deps.now(), ...rememberSelection(ctx, state, view, 'members', selectable, current) };
};
const imInviteCandidates: Handler<'im.invite_candidates'> = async (ctx, args, state) => {
  const current = ctx.captureWriteGuard?.() ?? (() => true);
  const gid = requireString(args, 'gid');
  const view = requireConversation(ctx, gid);
  const parents = recordOrNull(args)?.['parent_skill_group_ids'];
  if (parents !== undefined && (!Array.isArray(parents) || !parents.every(v => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0))) fail(ErrorCodes.ADAPTER_FAILED, 'invalid argument: parent_skill_group_ids');
  const r = readValue(await getInviteMemberListBySkillGroup(ctx.deps, ctx.soa, view, parents === undefined ? {} : { parentSkillGroupIds: parents as number[] }));
  ensureCurrent(current);
  const members = readValue(await getCurrentMembers(ctx.deps, ctx.soa, gid));
  ensureCurrent(current);
  if (peripheralIdentity(requireConversation(ctx, gid)) !== peripheralIdentity(view)) fail(ErrorCodes.ADAPTER_FAILED, 'conversation changed during candidate read');
  const present = new Set(members.filter(memberPresent).map(m => uidKey(m.uid)));
  const agents = r.agents.filter(a => !sameUid(a.agentUid, ctx.roles.selfUid) && !present.has(uidKey(a.agentUid))).map(a => ({ uid: a.agentUid, nickname: a.nickname, avatar: memberAvatar(ctx, a.agentUid, a.avatar) }));
  return { ...rememberSelection(ctx, state, view, 'invite', agents.map(a => a.uid), current), skill_groups: r.skillGroups.map(g => ({ skill_group_id: g.skillGroupId, name: g.skillGroupName })), agents };
};

async function peripheralWrite(ctx: RpcContext, args: unknown, state: RpcState, action: 'invite' | 'transfer' | 'finish'): Promise<UiPeripheralWrite> {
  const attempt = { started: false };
  try { return await peripheralWriteInner(ctx, args, state, action, attempt); }
  catch (e) {
    if (!attempt.started && e instanceof RpcError) return { kind: 'not_submitted', confirmed: false, reason: e.appError.message };
    throw e;
  }
}

async function peripheralWriteInner(ctx: RpcContext, args: unknown, state: RpcState, action: 'invite' | 'transfer' | 'finish', attempt: { started: boolean }): Promise<UiPeripheralWrite> {
  const current = ctx.captureWriteGuard?.() ?? (() => true);
  ensureCurrent(current);
  const gid = requireString(args, 'gid');
  const view = requireConversation(ctx, gid);
  if (!view.sessionId) fail(ErrorCodes.HOST_UNSUPPORTED, 'unsupported: missing sessionId');
  const raw = recordOrNull(args)?.['target_uids'];
  const targets = action === 'transfer' ? [requireString(args, 'target_uid')] : action === 'invite' && Array.isArray(raw) && raw.every(v => typeof v === 'string' && v !== '') ? raw as string[] : [];
  // Enrichment can change metadata without changing the service session. It
  // must never turn an unresolved write into a new customer-visible attempt.
  const key = JSON.stringify([action, view.gid, view.sessionId, [...targets].map(uidKey).sort()]);
  const writes = state.peripheralWrites ??= new Map();
  const previous = writes.get(key);
  if (previous) { attempt.started = true; return previous; }
  if (writes.size >= 1000) fail(ErrorCodes.ADAPTER_NOT_READY, 'peripheral action safety journal is full; restart the session before further actions');
  validateSelection(ctx, state, args, view, action, targets);
  const p = (async (): Promise<UiPeripheralWrite> => {
    if (action !== 'finish') {
      const before = readValue(await getCurrentMembers(ctx.deps, ctx.soa, gid));
      ensureCurrent(current);
      if (action === 'invite' && targets.some(uid => before.some(m => sameUid(m.uid, uid) && memberPresent(m)))) fail(ErrorCodes.ADAPTER_FAILED, 'target is already a current member; reload candidates');
      if (action === 'transfer' && !before.some(m => sameUid(m.uid, targets[0]!) && memberPresent(m) && merchant(m) && !master(m))) fail(ErrorCodes.ADAPTER_FAILED, 'transfer target is no longer an eligible current member');
      validateSelection(ctx, state, args, view, action, targets);
    }
    ensureCurrent(current);
    if (peripheralIdentity(requireConversation(ctx, gid)) !== peripheralIdentity(view)) fail(ErrorCodes.ADAPTER_FAILED, 'conversation changed (nothing sent)');
    validateSelection(ctx, state, args, view, action, targets);
    attempt.started = true;
    const result = action === 'invite' ? await inviteVenAgent(ctx.deps, ctx.soa, view, { venAgentUidList: targets }) : action === 'transfer' ? await transferVenMaster(ctx.deps, ctx.soa, view, { targetVenAgentUid: targets[0]! }) : await finishConversation(ctx.deps, ctx.soa, view);
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
        confirmed = action === 'invite' ? targets.every(uid => after.some(m => sameUid(m.uid, uid) && memberPresent(m))) : after.some(m => sameUid(m.uid, targets[0]!) && memberPresent(m) && master(m));
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

const HANDLERS: { readonly [K in AdapterOp]: Handler<K> } = {
  'adapter.diagnostics': async (ctx) => {
    if (!ctx.receiveDiagnostics) fail(ErrorCodes.HOST_UNSUPPORTED, 'receive diagnostics unavailable');
    return ctx.receiveDiagnostics();
  },
  'im.customer_scripts': imCustomerScripts,
  'im.members': imMembers,
  'im.invite_candidates': imInviteCandidates,
  'im.invite': imInvite,
  'im.transfer': imTransfer,
  'im.finish': imFinish,
  'im.outbound_lookup': imOutboundLookup,
  'im.messages': imMessages,
  'im.send_text': imSendText,
  'im.mark_read': imMarkRead,
  'im.set_mark': imSetMark,
  'notice.categories': noticeCategories,
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
  return {
    async handle(request) {
      const r = recordOrNull(request);
      const reqId = r?.['req_id'];
      if (typeof reqId !== 'string' || reqId === '') return null;
      const op = r?.['op'];
      if (typeof op !== 'string' || !Object.prototype.hasOwnProperty.call(HANDLERS, op)) {
        return { req_id: reqId, ok: false, error: { code: ErrorCodes.HOST_UNSUPPORTED, message: `unknown op`, retryable: false } };
      }
      const handler = HANDLERS[op as AdapterOp] as Handler<AdapterOp>;
      try {
        const data = await handler(ctx, r?.['args'] ?? {}, state);
        return { req_id: reqId, ok: true, data };
      } catch (e: unknown) {
        if (e instanceof RpcError) return { req_id: reqId, ok: false, error: e.appError };
        return { req_id: reqId, ok: false, error: { code: ErrorCodes.ADAPTER_FAILED, message: 'adapter error', retryable: false } };
      }
    },
  };
}

export function notReadyReply(request: unknown): AdapterReplyPayload | null {
  const reqId = recordOrNull(request)?.['req_id'];
  if (typeof reqId !== 'string' || reqId === '') return null;
  return { req_id: reqId, ok: false, error: { code: ErrorCodes.ADAPTER_NOT_READY, message: 'page adapter is still starting', retryable: true } };
}
