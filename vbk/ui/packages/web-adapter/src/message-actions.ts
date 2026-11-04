/** Official desktop eje/Kyt forward existing content with freshly rebuilt target fields.
 * Sources are read from getMessageList, never supplied as editable bodies by the UI. */
import type { AppError, SendDisposition } from '../../ipc/src/contracts.ts';
import { ErrorCodes } from '../../ipc/src/contracts.ts';
import type { UiMessage } from '../../ipc/src/client.ts';
import type { RpcContext } from './rpc.ts';
import type { SdkSendBody } from './deps.ts';
import { fetchHistoryPage } from './history.ts';
import { httpMessageToUi } from './display.ts';
import { is13DigitMs, normalizeTimeMs } from './facts.ts';
import { recordOrNull } from './soa.ts';
import { roomJidFromMessage } from './stores.ts';
import { mediaMessageJson, submitIntent, type SendIntent } from './send.ts';
import { facadeMessage } from './sdkGlue.ts';
import { webAdapterStrings as copy } from './web-adapter-copy/strings.ts';

export interface MessageActionReply { readonly disposition: SendDisposition; readonly message: UiMessage }
export class MessageActionRpcError extends Error {
  readonly appError: AppError;
  constructor(message: string, code: string = ErrorCodes.ADAPTER_FAILED) {
    super(message); this.appError = { code, message, retryable: false };
  }
}
const fail = (message: string, code?: string): never => { throw new MessageActionRpcError(message, code); };
const text = (args: Record<string, unknown>, key: string): string => {
  const value = args[key];
  return typeof value === 'string' && value.trim() && value.length <= 512 ? value : fail(`invalid ${key}`);
};
const id = (value: unknown): string | null => typeof value === 'string' && value !== '' ? value : typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
const typeOf = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : null;
const TYPES = new Set([0, 1, 2, 3, 5, 8, 9]);
const MAX_PENDING_METADATA = 5000;

/** Same HTTPS media domains as the local display allowlist; no credentials or custom ports. */
export function messageImageUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 8192) return fail('invalid image URL');
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443')
      && ['ctrip.com', 'tripcdn.com', 'c-ctrip.com'].some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) return url.href;
  } catch { /* Reject invalid URLs without echoing them. */ }
  return fail('image URL is outside official media domains');
}
interface Scope {
  readonly gid: string;
  readonly signature: string;
  readonly jid: string | null;
  readonly revision: string | null;
  readonly serviceType: string;
  readonly threadId: string;
  readonly conversationType: string;
}
interface Attempt { started: boolean }

export function createMessageActionsRpc(ctx: RpcContext) {
  const writes = new Map<string, { fingerprint: string; promise: Promise<MessageActionReply> }>();
  const partner = (gid: string) => ctx.sdk.partnerJidOf(gid) ?? roomJidFromMessage(gid, ctx.store.view(gid)?.lastMessage ?? null);
  function capture(gid: string, target: boolean): Scope {
    const row = recordOrNull(ctx.store.row(gid)), view = ctx.store.view(gid);
    if (!row || !view || !ctx.roles.selfUid || !view.sessionId || !view.customerUid || !view.serviceType || !view.conversationType || view.worksheetId === null) return fail('conversation identity incomplete');
    if (target && (![1, 2].includes(row['status'] as number) || ![1, 4].includes(row['inGroup'] as number))) return fail('forward target is not an active joined conversation');
    const jid = partner(gid);
    return {
      gid, jid,
      signature: JSON.stringify([view.gid, view.sessionId, view.customerUid, view.conversationType, view.serviceType, view.threadId, view.conversationKey, view.worksheetId, row['status'], row['inGroup'], ctx.store.messageContext(gid), ctx.roles.selfUid, ctx.deps.context]),
      revision: ctx.store.assistantContextRevision(gid, ctx.roles.selfUid, jid),
      serviceType: view.serviceType, threadId: view.threadId, conversationType: view.conversationType,
    };
  }
  function check(scope: Scope, current: () => boolean, target: boolean): void {
    if (!current()) return fail('account lifecycle changed', ErrorCodes.ACCOUNT_STALE_GENERATION);
    const live = capture(scope.gid, target);
    if (live.signature !== scope.signature || live.jid !== scope.jid || live.revision !== scope.revision) return fail('conversation changed before submission', ErrorCodes.ACCOUNT_STALE_GENERATION);
  }
  function expected(scope: Scope, value: unknown): void {
    if (value !== undefined && value !== null && (typeof value !== 'string' || !value || value !== scope.revision)) fail('conversation revision changed', ErrorCodes.ACCOUNT_STALE_GENERATION);
  }
  async function readyTarget(scope: Scope, current: () => boolean): Promise<Scope> {
    check(scope, current, true);
    if (scope.jid) { ctx.sdk.rememberPartnerJid(scope.gid, scope.jid); return scope; }
    const result = await fetchHistoryPage(ctx.deps, ctx.soa, { gid: scope.gid, conversationType: scope.conversationType, pageSize: 30 }, ctx.roles);
    check(scope, current, true);
    if (result.kind !== 'page') return fail('target room lookup failed');
    const jids = new Set(result.page.rows.map(row => roomJidFromMessage(scope.gid, row)).filter((jid): jid is string => jid !== null));
    if (jids.size !== 1) return fail('target room is not verified');
    ctx.sdk.rememberPartnerJid(scope.gid, [...jids][0]!);
    return capture(scope.gid, true);
  }
  function once(localId: string, fingerprint: string, operation: (attempt: Attempt) => Promise<MessageActionReply>): Promise<MessageActionReply> {
    fingerprint = JSON.stringify([ctx.roles.selfUid, ctx.deps.context, fingerprint]);
    const prior = writes.get(localId);
    if (prior) return prior.fingerprint === fingerprint ? prior.promise : Promise.reject(new MessageActionRpcError('local_id belongs to a different operation'));
    if (writes.size >= MAX_PENDING_METADATA) return Promise.reject(new MessageActionRpcError('message action metadata limit reached; reconnect before sending'));
    const attempt = { started: false };
    const promise = Promise.resolve().then(() => operation(attempt));
    writes.set(localId, { fingerprint, promise });
    void promise.catch(() => { if (!attempt.started) writes.delete(localId); });
    return promise;
  }
  async function submit(scope: Scope, localId: string, msgtype: SdkSendBody['msgtype'], body: string, preview: UiMessage | null, current: () => boolean, attempt: Attempt, validateSource?: () => void): Promise<MessageActionReply> {
    if (!ctx.sdk.canSend) return fail('official SDK send entry unavailable', ErrorCodes.HOST_UNSUPPORTED);
    check(scope, current, true); validateSource?.();
    const self = ctx.roles.selfUid, profile = ctx.roles.profileOf(self);
    const createdAtMs = ctx.deps.now();
    const intent: SendIntent = { gid: scope.gid, localId, createdAtMs, body: { chattype: 'groupchat', biztype: scope.serviceType, localid: localId, msg: body, msgtype, autoextend: 0, threadid: scope.threadId } };
    // Validate the public facade model before marking the operation as possibly submitted.
    try { facadeMessage({ gid: scope.gid, body: intent.body }); } catch { return fail('source cannot form a valid SDK public message model'); }
    attempt.started = true;
    const result = await submitIntent(ctx.deps, ctx.sdk, intent, ctx.sendAckTimeoutMs ?? 15000);
    const disposition = result.disposition;
    const message: UiMessage = {
      gid: scope.gid, message_id: disposition.kind === 'confirmed' ? disposition.server_message_id : null,
      local_id: localId, create_time_ms: disposition.kind === 'confirmed' ? disposition.server_time_ms : createdAtMs,
      sender_role: 'merchant_self', sender_id: self, sender_name: profile.name, sender_avatar: profile.avatar,
      platform_type: Number(msgtype),
      kind: preview?.kind ?? 'text', text: preview?.text ?? (msgtype === '8' ? copy['web-adapter.display.sticker'] : copy['web-adapter.display.mentionMessage']),
      ...(preview?.media_url ? { media_url: preview.media_url } : {}),
      ...(preview?.media_thumbnail ? { media_thumbnail: preview.media_thumbnail } : {}),
      ...(preview?.media_filename ? { media_filename: preview.media_filename } : {}),
      translation: null, original: null, quote: null, order_id: preview?.order_id ?? null, disposition,
    };
    // A receipt is still returned to its original caller, but never projected into a new scope.
    try {
      check(scope, current, true);
      ctx.pushFact({ kind: 'message', fact: { ...result.fact, sender_id: self } });
      ctx.pushDisplay({ kind: 'messages', gid: scope.gid, replace: false, items: [message] });
    } catch { /* Original host request owns the outcome; stale windows get no display mutation. */ }
    return { disposition, message };
  }
  function forward(raw: unknown): Promise<MessageActionReply> {
    const args = recordOrNull(raw) ?? {};
    const gid = text(args, 'gid'), localId = text(args, 'local_id'), sourceGid = text(args, 'source_gid'), sourceId = text(args, 'source_message_id');
    const time = args['source_create_time_ms'];
    if (typeof time !== 'number' || !is13DigitMs(time) || !is13DigitMs(time + 1)) return Promise.reject(new MessageActionRpcError('invalid source timestamp'));
    return once(localId, JSON.stringify(['forward', gid, sourceGid, sourceId, time, args['source_context_revision'], args['target_context_revision']]), async attempt => {
      const current = ctx.captureWriteGuard?.() ?? (() => true);
      const source = capture(sourceGid, false), initialTarget = capture(gid, true);
      check(source, current, false); expected(source, args['source_context_revision']); expected(initialTarget, args['target_context_revision']);
      // Resolve the destination first so the source is the last awaited read before submission.
      const target = await readyTarget(initialTarget, current);
      check(source, current, false);
      const result = await fetchHistoryPage(ctx.deps, ctx.soa, { gid: sourceGid, conversationType: source.conversationType, pageSize: 100, cursor: { direction: 'prev', endTime: time + 1 } }, ctx.roles);
      check(source, current, false); check(target, current, true);
      if (result.kind !== 'page') return fail('source history lookup failed');
      const matches = result.page.rows.filter(row => id(row.msgId) === sourceId);
      if (matches.length !== 1) return fail('source message missing or ambiguous');
      const row = matches[0]!;
      const msgtype = typeOf(row.msgtype), status = typeOf(row.status);
      if (msgtype === null || !TYPES.has(msgtype) || (row.status !== undefined && status !== 0 && status !== 4) || normalizeTimeMs(row.createTime) !== time) return fail('source message cannot be forwarded');
      const sourceRoom = roomJidFromMessage(sourceGid, row);
      if (!sourceRoom || (source.jid && source.jid !== sourceRoom)) return fail('source message room mismatch');
      if ((row.threadId !== undefined && row.threadId !== source.threadId) || (row.bizType !== undefined && String(row.bizType) !== source.serviceType)) return fail('source message service/thread mismatch');
      if (typeof row.messageBody !== 'string' || !row.messageBody.trim() || row.messageBody.length > 2 * 1024 * 1024) return fail('source message content missing');
      if (result.page.rows.some(r => httpMessageToUi(r, ctx.roles, sourceGid)?.recalled_message_id === sourceId)) return fail('source message was recalled');
      check(source, current, false);
      return submit(target, localId, String(msgtype) as SdkSendBody['msgtype'], row.messageBody, httpMessageToUi(row, ctx.roles, sourceGid), current, attempt, () => check(source, current, false));
    });
  }
  function sendImage(raw: unknown): Promise<MessageActionReply> {
    const args = recordOrNull(raw) ?? {};
    const gid = text(args, 'gid'), localId = text(args, 'local_id');
    const url = messageImageUrl(args['url']), thumbnail = args['thumbnail'] == null || args['thumbnail'] === '' ? url : messageImageUrl(args['thumbnail']);
    const dimension = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 32768 ? value : 0;
    const width = dimension(args['width']), height = dimension(args['height']);
    const body = mediaMessageJson({ kind: 'image', url, thumbUrl: thumbnail, width, height, scene: '', channel: 'im_business' });
    return once(localId, JSON.stringify(['image', gid, url, thumbnail, width, height, args['target_context_revision']]), async attempt => {
      const current = ctx.captureWriteGuard?.() ?? (() => true), initial = capture(gid, true);
      expected(initial, args['target_context_revision']);
      const target = await readyTarget(initial, current);
      const preview: UiMessage = { gid, message_id: null, local_id: localId, create_time_ms: ctx.deps.now(), sender_role: 'merchant_self', kind: 'image', text: url, media_url: url, media_thumbnail: thumbnail, translation: null, original: null, quote: null, order_id: null, disposition: null };
      return submit(target, localId, '1', body, preview, current, attempt);
    });
  }
  return { forward, sendImage };
}
