/** Message-panel peripheral APIs. Bodies follow docs/api/endpoints, evidence
 * 24/26/29/47/51. No request runs at module load. The host owns identity guards
 * and read-back; writes are submitted once and never replayed here. */
import type { AdapterDeps } from './deps.ts';
import { previewOf, type ConversationRowView } from './display.ts';
import type { HttpMessageObject } from './facts.ts';
import { Endpoints, M } from './endpoints.ts';
import { businessHead } from './heads.ts';
import { endpoint, isBizSuccess, bizResultCode, recordOrNull, type EndpointSpec, type SoaClient, type SoaOutcome } from './soa.ts';

export const PeripheralEndpoints = {
  INVITE_MEMBERS: endpoint('getInviteMemberListBySkillGroup', M, '16037/getInviteMemberListBySkillGroup', 'read'),
  INVITE_AGENT: endpoint('inviteVenAgent', M, '16037/inviteVenAgent', 'write'),
  TRANSFER_MASTER: endpoint('transferVenMaster', M, '16037/transferVenMaster', 'write'),
} as const;

/** conversationKey is distinct from gid. It must be copied from the actual row,
 * never reconstructed; older caches without it cannot finish a conversation. */
export type PeripheralConversation = ConversationRowView & { readonly conversationKey?: string | null };
export type PeripheralFailure =
  | { readonly kind: 'unsupported'; readonly missing: readonly string[] }
  | { readonly kind: 'invalid'; readonly field: string }
  | { readonly kind: 'failed'; readonly outcome: SoaOutcome<unknown> }
  | { readonly kind: 'biz_failure'; readonly outcome: SoaOutcome<unknown> }
  | { readonly kind: 'unknown'; readonly outcome: SoaOutcome<unknown> };
export type PeripheralReadResult<T> = { readonly kind: 'success'; readonly value: T } | PeripheralFailure;
/** Server acceptance is not proof that a later list/membership read has converged. */
export type PeripheralWriteResult = { readonly kind: 'accepted'; readonly requiresReadBack: true } | PeripheralFailure;
export interface CustomerScriptsRequest { readonly content: string }
/** Only an empty customerScripts sample is documented. Preserve entries without
 * guessing id/content fields; callers must not manufacture usable reply text. */
export interface CustomerScriptsResult { readonly items: readonly unknown[] }
export interface InviteMembersRequest { readonly parentSkillGroupIds?: readonly number[] }
export interface InviteSkillGroup { readonly skillGroupId: number; readonly skillGroupName: string }
export interface InviteAgent { readonly agentUid: string; readonly nickname: string | null; readonly avatar?: string }
export interface InviteMembersResult { readonly skillGroups: readonly InviteSkillGroup[]; readonly agents: readonly InviteAgent[] }
export interface InviteVenAgentRequest { readonly venAgentUidList: readonly string[] }
export interface TransferVenMasterRequest { readonly targetVenAgentUid: string }

const nonempty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const worksheet = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
function absent(view: PeripheralConversation | null, fields: readonly string[]): PeripheralFailure | null {
  if (!view) return { kind: 'unsupported', missing: ['conversation'] };
  const r = view as unknown as Record<string, unknown>;
  const missing = fields.filter(k => k === 'worksheetId' ? !worksheet(r[k]) : !nonempty(r[k]));
  return missing.length ? { kind: 'unsupported', missing } : null;
}
function failed(outcome: SoaOutcome<unknown>): PeripheralFailure {
  return { kind: outcome.kind === 'unknown' ? 'unknown' : 'failed', outcome };
}
function malformed(detail: string): PeripheralFailure { return { kind: 'failed', outcome: { kind: 'malformed', detail } }; }

export async function getCustomerScripts(deps: AdapterDeps, soa: SoaClient, req: CustomerScriptsRequest): Promise<PeripheralReadResult<CustomerScriptsResult>> {
  if (typeof req.content !== 'string') return { kind: 'invalid', field: 'content' };
  const outcome = await soa.post<unknown>(Endpoints.CUSTOMER_SCRIPTS, { head: businessHead(deps.context), content: req.content });
  if (outcome.kind !== 'success') return failed(outcome);
  const body = recordOrNull(outcome.body);
  if (body && 'bizResponseStatus' in body && !isBizSuccess(body)) return { kind: 'biz_failure', outcome };
  const scripts = body?.['customerScripts'];
  return Array.isArray(scripts) ? { kind: 'success', value: { items: scripts } } : malformed('missing customerScripts array');
}

export async function getInviteMemberListBySkillGroup(deps: AdapterDeps, soa: SoaClient, view: PeripheralConversation | null, req: InviteMembersRequest = {}): Promise<PeripheralReadResult<InviteMembersResult>> {
  const unsupported = absent(view, ['gid', 'worksheetId']);
  if (unsupported || !view) return unsupported!;
  const parents = req.parentSkillGroupIds;
  if (parents !== undefined && (!Array.isArray(parents) || !parents.every(worksheet))) return { kind: 'invalid', field: 'parentSkillGroupIds' };
  const outcome = await soa.post<unknown>(PeripheralEndpoints.INVITE_MEMBERS, {
    head: businessHead(deps.context), groupId: view.gid, worksheetId: view.worksheetId,
    ...(parents === undefined ? {} : { parentSkillGroupIds: parents }),
  });
  if (outcome.kind !== 'success') return failed(outcome);
  if (!isBizSuccess(outcome.body)) return { kind: 'biz_failure', outcome };
  const results = recordOrNull(outcome.body)?.['results'];
  if (!Array.isArray(results)) return malformed('missing invite results array');
  const skillGroups: InviteSkillGroup[] = [], agents: InviteAgent[] = [];
  for (const item of results) {
    const r = recordOrNull(item);
    if (!r) return malformed('invalid invite result');
    if (!('skillGroupList' in r) && !('agentInfoList' in r)) return malformed('missing invite candidate lists');
    for (const field of ['skillGroupList', 'agentInfoList']) if (r[field] !== undefined && !Array.isArray(r[field])) return malformed(`invalid ${field}`);
    for (const entry of (r['skillGroupList'] ?? []) as unknown[]) {
      const row = recordOrNull(entry);
      if (!row || !worksheet(row['skillGroupId']) || !nonempty(row['skillGroupName'])) return malformed('invalid skill group');
      skillGroups.push({ skillGroupId: row['skillGroupId'], skillGroupName: row['skillGroupName'] });
    }
    for (const entry of (r['agentInfoList'] ?? []) as unknown[]) {
      const row = recordOrNull(entry);
      if (!row || !nonempty(row['agentUid'])) return malformed('invalid agent uid');
      agents.push({ agentUid: row['agentUid'], nickname: nonempty(row['nickname']) ? row['nickname'] : null, ...(nonempty(row['avatar']) ? { avatar: row['avatar'] } : {}) });
    }
  }
  return { kind: 'success', value: { skillGroups, agents } };
}

async function submit(deps: AdapterDeps, soa: SoaClient, spec: EndpointSpec, body: Record<string, unknown>, accepted: (body: unknown) => boolean = isBizSuccess): Promise<PeripheralWriteResult> {
  const outcome = await soa.post<unknown>(spec, { head: businessHead(deps.context), ...body });
  if (outcome.kind !== 'success') {
    // A response/HTTP decoding failure after a write is not evidence of rejection.
    if (outcome.kind === 'unknown' || outcome.kind === 'malformed' || outcome.kind === 'http_error' || (outcome.kind === 'business_failure' && outcome.ack !== 'Failure')) return { kind: 'unknown', outcome };
    return failed(outcome);
  }
  const code = bizResultCode(outcome.body);
  if (code !== null && code !== '' && code !== 'SUCCESS') return { kind: 'biz_failure', outcome };
  return accepted(outcome.body) ? { kind: 'accepted', requiresReadBack: true } : { kind: 'unknown', outcome };
}

/** Ends the entire conversation (no venAgentUids). Removing members is a distinct
 * action and must not be smuggled into this API. */
export async function finishConversation(deps: AdapterDeps, soa: SoaClient, view: PeripheralConversation | null): Promise<PeripheralWriteResult> {
  const unsupported = absent(view, ['conversationKey', 'conversationType', 'sessionId', 'worksheetId']);
  if (unsupported || !view) return unsupported!;
  return submit(deps, soa, Endpoints.FINISH_CONVERSATION, {
    conversationKey: view.conversationKey, conversationType: view.conversationType,
    sessionId: view.sessionId, workSheetId: view.worksheetId,
  });
}

/** Targets must be explicitly chosen from fresh candidates, excluding self and
 * current members. That authorization/context check belongs to the host. */
export async function inviteVenAgent(deps: AdapterDeps, soa: SoaClient, view: PeripheralConversation | null, req: InviteVenAgentRequest): Promise<PeripheralWriteResult> {
  const unsupported = absent(view, ['serviceType', 'worksheetId', 'sessionId']);
  if (unsupported || !view) return unsupported!;
  if (!Array.isArray(req.venAgentUidList) || req.venAgentUidList.length === 0 || !req.venAgentUidList.every(nonempty) || new Set(req.venAgentUidList).size !== req.venAgentUidList.length) return { kind: 'invalid', field: 'venAgentUidList' };
  return submit(deps, soa, PeripheralEndpoints.INVITE_AGENT, {
    venAgentUidList: req.venAgentUidList, serviceType: view.serviceType, workSheetId: String(view.worksheetId),
  }, body => {
    const r = recordOrNull(body);
    // This endpoint has no bizResponseStatus in the captured success. Require
    // its documented identifiers, and reject an explicit business failure.
    return !!r && (!('bizResponseStatus' in r) || isBizSuccess(r)) && r['sessionId'] === view.sessionId && r['workSheetId'] === String(view.worksheetId);
  });
}

export async function transferVenMaster(deps: AdapterDeps, soa: SoaClient, view: PeripheralConversation | null, req: TransferVenMasterRequest): Promise<PeripheralWriteResult> {
  const unsupported = absent(view, ['gid', 'sessionId']);
  if (unsupported || !view) return unsupported!;
  if (!nonempty(req.targetVenAgentUid)) return { kind: 'invalid', field: 'targetVenAgentUid' };
  return submit(deps, soa, PeripheralEndpoints.TRANSFER_MASTER, {
    sessionId: view.sessionId, groupId: view.gid, targetVenAgentUid: req.targetVenAgentUid,
  });
}

/** Current membership is read independently of RoleBook's historic identity cache.
 * checkMemberStatus evidence 55: status.code=0, status='1' marks present members. */
export interface CurrentMember { readonly uid: string; readonly nickname: string | null; readonly status: string; readonly roles: readonly number[]; readonly avatar?: string; readonly rolesv2?: readonly number[] }
export async function getCurrentMembers(deps: AdapterDeps, soa: SoaClient, gid: string): Promise<PeripheralReadResult<readonly CurrentMember[]>> {
  if (!nonempty(gid)) return { kind: 'invalid', field: 'gid' };
  const outcome = await soa.post<unknown>(Endpoints.CHECK_MEMBER_STATUS, { head: businessHead(deps.context), groupId: gid });
  if (outcome.kind !== 'success') return failed(outcome);
  const r = recordOrNull(outcome.body);
  if (recordOrNull(r?.['status'])?.['code'] !== 0) return { kind: 'biz_failure', outcome };
  const rows = r?.['members'];
  if (!Array.isArray(rows)) return malformed('missing members array');
  const members: CurrentMember[] = [];
  const seen = new Set<string>();
  for (const entry of rows) {
    const m = recordOrNull(entry);
    if (!m || !nonempty(m['uid']) || !nonempty(m['status']) || !Array.isArray(m['roles']) || !m['roles'].every(v => typeof v === 'number' && Number.isSafeInteger(v)) || seen.has(m['uid'])) return malformed('invalid or duplicate member');
    seen.add(m['uid']);
    members.push({ uid: m['uid'], nickname: nonempty(m['nick']) ? m['nick'] : null, status: m['status'], roles: m['roles'] as number[], ...(nonempty(m['avatar']) ? { avatar: m['avatar'] } : {}), ...(Array.isArray(m['rolesv2']) && m['rolesv2'].every(v => typeof v === 'number' && Number.isSafeInteger(v)) ? { rolesv2: m['rolesv2'] as number[] } : {}) });
  }
  return { kind: 'success', value: members };
}

// ------------------------------------------------------------- server-side search

/**
 * `16037/searchConversation {head, searchType, searchValue, pageNo, startTime?, endTime?}`.
 * Samples (49/19/27) all use `searchType: 3` and `pageNo: 1`; the full
 * `searchType` enum is NOT known (plan I-23: "待实机取样"), so any non-negative
 * integer is forwarded and the caller picks one it has seen. `startTime` /
 * `endTime` (ms) come from the official search UI per the plan; they are
 * optional and only sent when given. Response: bizResponseStatus SUCCESS and
 * `customerSearchList[{conversation, message}]`. Only identity and a short
 * preview survive the mapping; the raw message body is dropped.
 */
export const SEARCH_CONVERSATION = endpoint('searchConversation', M, '16037/searchConversation', 'read');
export const SEARCH_VALUE_MAX_CHARS = 100;
export const SEARCH_MAX_PAGE = 1000;

export interface SearchConversationRequest {
  readonly searchType: number;
  readonly searchValue: string;
  readonly pageNo: number;
  readonly startTime?: number;
  readonly endTime?: number;
}

export interface ConversationSearchHit {
  readonly gid: string;
  readonly sessionId: string | null;
  readonly conversationKey: string | null;
  readonly conversationType: string | null;
  /** `conversation.id`, the worksheet id `setWorkSheetStar` / `finishConversation` need. */
  readonly worksheetId: number | null;
  readonly serviceType: string | null;
  readonly status: number | null;
  readonly title: string;
  readonly lastMessageTime: number | null;
  readonly messageId: string | null;
  readonly preview: string;
}

export function searchConversationBody(deps: AdapterDeps, req: SearchConversationRequest): Record<string, unknown> {
  return {
    head: businessHead(deps.context),
    searchType: req.searchType,
    searchValue: req.searchValue,
    pageNo: req.pageNo,
    ...(req.startTime === undefined ? {} : { startTime: req.startTime }),
    ...(req.endTime === undefined ? {} : { endTime: req.endTime }),
  };
}

function searchHit(entry: unknown): ConversationSearchHit | null {
  const r = recordOrNull(entry);
  const c = recordOrNull(r?.['conversation']);
  if (!r || !c || !nonempty(c['gid'])) return null;
  const m = recordOrNull(r['message']);
  const text = (k: string): string | null => (nonempty(c[k]) ? (c[k] as string) : null);
  const time = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    gid: c['gid'],
    sessionId: text('sessionId'),
    conversationKey: text('conversationKey'),
    conversationType: text('conversationType'),
    worksheetId: worksheet(c['id']) ? c['id'] : null,
    serviceType: text('serviceType'),
    status: typeof c['status'] === 'number' ? c['status'] : null,
    title: text('groupTitle') ?? '',
    lastMessageTime: time(c['lastMessageTime']),
    messageId: m && nonempty(m['msgId']) ? m['msgId'] : null,
    preview: m ? previewOf({ msgId: m['msgId'], messageBody: m['messageBody'], msgtype: m['msgtype'], createTime: m['createTime'] } as HttpMessageObject) : '',
  };
}

export async function searchConversations(deps: AdapterDeps, soa: SoaClient, req: SearchConversationRequest): Promise<PeripheralReadResult<readonly ConversationSearchHit[]>> {
  const intOk = (v: unknown, min: number, max: number): boolean => typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
  if (!intOk(req.searchType, 0, 99)) return { kind: 'invalid', field: 'searchType' };
  if (typeof req.searchValue !== 'string' || req.searchValue.trim() === '' || req.searchValue.length > SEARCH_VALUE_MAX_CHARS) return { kind: 'invalid', field: 'searchValue' };
  if (!intOk(req.pageNo, 1, SEARCH_MAX_PAGE)) return { kind: 'invalid', field: 'pageNo' };
  if (req.startTime !== undefined && !intOk(req.startTime, 0, Number.MAX_SAFE_INTEGER)) return { kind: 'invalid', field: 'startTime' };
  if (req.endTime !== undefined && !intOk(req.endTime, 0, Number.MAX_SAFE_INTEGER)) return { kind: 'invalid', field: 'endTime' };
  if (req.startTime !== undefined && req.endTime !== undefined && req.startTime > req.endTime) return { kind: 'invalid', field: 'endTime' };
  const outcome = await soa.post<unknown>(SEARCH_CONVERSATION, searchConversationBody(deps, req));
  if (outcome.kind !== 'success') return failed(outcome);
  if (!isBizSuccess(outcome.body)) return { kind: 'biz_failure', outcome };
  const list = recordOrNull(outcome.body)?.['customerSearchList'];
  if (!Array.isArray(list)) return malformed('missing customerSearchList array');
  const hits: ConversationSearchHit[] = [];
  for (const entry of list) {
    const hit = searchHit(entry);
    if (hit) hits.push(hit);
  }
  return { kind: 'success', value: hits };
}

export const LATEST_CONVERSATION: EndpointSpec = endpoint('getLatestConversationByGid', M, '16037/getLatestConversationByGid', 'read');
/** 服务端当前会话行（只读）。gid 不符即视为畸形，不拿别的会话行做后续决定。 */
async function readLatestConversation(deps: AdapterDeps, soa: SoaClient, gid: string): Promise<PeripheralReadResult<Record<string, unknown>>> {
  const outcome = await soa.post<unknown>(LATEST_CONVERSATION, { head: businessHead(deps.context), gid });
  if (outcome.kind !== 'success') return failed(outcome);
  if (!isBizSuccess(outcome.body)) return { kind: 'biz_failure', outcome };
  const row = recordOrNull(recordOrNull(outcome.body)?.['conversation']);
  if (!row || row['gid'] !== gid) return malformed('missing matching conversation read-back');
  return { kind: 'success', value: row };
}

export interface LatestConversationState { readonly gid: string; readonly sessionId: string; readonly status: number; readonly inGroup: number }
export async function getLatestConversationState(deps: AdapterDeps, soa: SoaClient, gid: string): Promise<PeripheralReadResult<LatestConversationState>> {
  const read = await readLatestConversation(deps, soa, gid);
  if (read.kind !== 'success') return read;
  const row = read.value;
  if (!nonempty(row['sessionId']) || typeof row['status'] !== 'number' || typeof row['inGroup'] !== 'number') return malformed('missing matching conversation read-back');
  return { kind: 'success', value: { gid, sessionId: row['sessionId'], status: row['status'], inGroup: row['inGroup'] } };
}

// ------------------------------------------------------------- reopen by send

/** 官方 FINISH 状态值（CONVERSATION_STATUS_TABLE 中唯一映射 finished 的数字）。 */
export const FINISHED_STATUS = 4;

/**
 * `startChatB2C` 重开体。字段名来自官方网页 builder（web-message-notice-static：
 * `{serviceType, vendorRefId, role, threadId, orderNo, extParams, customerUid, sessionId, groupId,
 * languageInfo:{lang, customerSource, terminalChannel}}`）与「结束后发送」实测体（evidence 49：
 * 无 orderNo、无 sessionId，role="VBK"，extParams 与会话行 `ext` 同键）。取值映射
 * refId→vendorRefId、vendorRole→role、ext→extParams、uid→customerUid 由同名结构推定，
 * 证据已脱敏，未做逐值核对；缺任何一项即拒绝构造，不猜默认值。
 */
export function reopenChatBody(gid: string, row: Record<string, unknown>): Record<string, unknown> | PeripheralFailure {
  const st = row['serviceType'];
  const serviceType = typeof st === 'string' ? st : typeof st === 'number' && Number.isSafeInteger(st) ? String(st) : '';
  const ext = recordOrNull(row['ext']);
  const lang = recordOrNull(row['languageInfo']);
  const missing = [
    ...(serviceType === '' ? ['serviceType'] : []),
    ...(nonempty(row['uid']) ? [] : ['uid']),
    ...(nonempty(row['refId']) ? [] : ['refId']),
    ...(nonempty(row['vendorRole']) ? [] : ['vendorRole']),
    ...(typeof row['threadId'] === 'string' ? [] : ['threadId']),
    ...(ext ? [] : ['ext']),
  ];
  if (missing.length) return { kind: 'unsupported', missing };
  const text = (v: unknown): string => (typeof v === 'string' ? v : '');
  return {
    serviceType, vendorRefId: row['refId'], role: row['vendorRole'], threadId: row['threadId'],
    extParams: ext, customerUid: row['uid'], groupId: gid,
    languageInfo: { lang: text(lang?.['lang']), customerSource: text(lang?.['customerSource']), terminalChannel: text(lang?.['terminalChannel']) },
  };
}

export type ReopenResult = { readonly kind: 'already_open' } | PeripheralWriteResult;

/**
 * 已结束会话发送前的重开（官方网页：结束后发送消息触发 `startChatB2C` 并重新开启，
 * docs/research/2026-10-30-browser-api-validation.md「会话搜索与重新开启」、evidence 49）。
 * 先独立读回服务端当前状态：不是 FINISH 就不写（他人已重开 / 本机上一次结果未知但已生效），
 * 因此一次「结果未知」后的再次发送不会盲目重复 startChatB2C。写入只提交一次，不重试；
 * 只有 SUCCESS 且回读同一 groupId 与数字 workSheetId 才算已重开。
 */
export async function reopenConversationForSend(deps: AdapterDeps, soa: SoaClient, gid: string): Promise<ReopenResult> {
  if (!nonempty(gid)) return { kind: 'invalid', field: 'gid' };
  const read = await readLatestConversation(deps, soa, gid);
  if (read.kind !== 'success') return read.kind === 'unknown' ? { kind: 'failed', outcome: read.outcome } : read;
  if (typeof read.value['status'] !== 'number') return malformed('missing conversation status');
  if (read.value['status'] !== FINISHED_STATUS) return { kind: 'already_open' };
  const body = reopenChatBody(gid, read.value);
  if ('kind' in body) return body as PeripheralFailure;
  return submit(deps, soa, Endpoints.START_CHAT_B2C, body, (b) => {
    const r = recordOrNull(b);
    return !!r && isBizSuccess(r) && r['groupId'] === gid && worksheet(r['workSheetId']);
  });
}
