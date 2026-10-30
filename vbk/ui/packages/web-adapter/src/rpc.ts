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
import type { AgentStatus, MarkAction, UiMessage, UiNoticeCategory } from '../../ipc/src/client.ts';
import type { AdapterDisplayPayload, AdapterOp, AdapterReplyPayload, AdapterResultMap } from '../../ipc/src/adapterProtocol.ts';
import type { AdapterDeps } from './deps.ts';
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
import { AGENT_STATUS_CODES, agentStatusOf, byCreateTime, httpMessageToUi } from './display.ts';
import type { PageSdk } from './sdkGlue.ts';
import { roomJidFromMessage, type ConversationStore, type RoleBook } from './stores.ts';
import { fetchNoticeCategories, fetchNoticeList, markNoticeRead, parseNoticeCategoryId, type NoticeCategoryInfo } from './notice.ts';

export const OP_EVIDENCE: Readonly<Record<AdapterOp, string>> = {
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
}

const imMessages: Handler<'im.messages'> = async (ctx, args) => {
  const gid = requireString(args, 'gid');
  const view = requireConversation(ctx, gid);
  if (!view.conversationType) fail(ErrorCodes.ADAPTER_FAILED, 'conversationType unknown for this conversation');
  await ctx.roles.ensure(ctx.deps, ctx.soa, gid);
  const res = await fetchHistoryPage(ctx.deps, ctx.soa, { gid, conversationType: view.conversationType, pageSize: HISTORY_PAGE_SIZE }, ctx.roles);
  if (res.kind === 'invalid_cursor') fail(ErrorCodes.ADAPTER_FAILED, 'invalid history cursor');
  if (res.kind === 'failed') throw new RpcError(outcomeError(res.outcome, 'history'));
  for (const fact of res.page.facts) ctx.pushFact({ kind: 'message', fact });
  const items: UiMessage[] = [];
  for (const row of res.page.rows) {
    const ui = httpMessageToUi(row, ctx.roles, gid);
    if (ui) items.push(ui);
    if (typeof row === 'object' && row !== null) {
      ctx.store.noteMessage(gid, row.msgId, row.createTime);
      const jid = roomJidFromMessage(gid, row);
      if (jid) ctx.sdk.rememberPartnerJid(gid, jid);
    }
  }
  items.sort(byCreateTime);
  ctx.pushDisplay({ kind: 'messages', gid, replace: true, items });
  return items;
};

function sendOnce(ctx: RpcContext, gid: string, localId: string, text: string, original: string | null, quoteId: string | null): Promise<SendDisposition> {
  const view = requireConversation(ctx, gid);
  if (view.serviceType === '') fail(ErrorCodes.ADAPTER_FAILED, 'serviceType unknown for this conversation');
  if (!ctx.sdk.canSend) fail(ErrorCodes.HOST_UNSUPPORTED, 'official SDK send entry not found on the page (nothing sent)');
  if (!partnerJidOf(ctx, gid)) fail(ErrorCodes.ADAPTER_NOT_READY, 'target jid not known yet (nothing sent)', true);
  const base = createSendIntent(ctx.deps, gid, text, { serviceType: view.serviceType, threadId: view.threadId }, quoteId ? { citemsgid: quoteId } : undefined);
  // the host's local_id is the correlation key end to end
  const intent: SendIntent = { ...base, localId, body: { ...base.body, localid: localId } };
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
  const p = sendOnce(ctx, gid, localId, text, original, quoteId);
  state.sends.set(localId, p);
  p.catch(() => state.sends.delete(localId)); // a pre-send validation error sent nothing; a retry may submit
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

const HANDLERS: { readonly [K in AdapterOp]: Handler<K> } = {
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

export function createRpc(ctx: RpcContext): Rpc {
  const state: RpcState = { sends: new Map(), categories: new Map() };
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
