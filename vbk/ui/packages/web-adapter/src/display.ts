/**
 * Display-channel conversions (D4): raw official-page rows / messages →
 * `DisplayConversation` / `UiMessage` for `adapter_push_display`.
 *
 * Titles, previews and message bodies only ever travel through the display
 * channel; the fact envelopes (`bridge.ts`) stay body-free. Nothing here
 * logs or persists.
 *
 * Evidence:
 * - conversation row fields (`groupTitle`, `lastMessageJsonString`,
 *   `languageInfo.lang`, `ext.locale`, `serviceType`, `star`, `sessionId`,
 *   `id`, `relationOrderId`, `ext.orderId`, `uid`, `threadId`,
 *   `conversationType`): docs/api/endpoints/m.ctrip.com-16037-getConversationList-post.md
 *   "响应与读回" (evidence 17/54);
 * - HTTP message object (`msgId, messageBody, fromJid, toJid, createTime, msgtype`):
 *   getMessageList / getRecentMessages / getConversationInfoByGidList samples;
 * - media inner JSON (image 44, video 68, file 33), recall body (05: `title, recallMessageId, code:2`);
 * - agent status enum IDLE=0 / HANGUP=1 / LEAVING=2 / GETOFF=3
 *   (docs/research/2026-10-30-agent-status-and-settings.md §1, read back as
 *   `getConversationList.currentStatus`).
 */

import { customerLanguage } from '../../ipc/src/customer-language.ts';
import { resolveSdkAddress } from './facts.ts';
import type { AgentStatus, MarkAction, UiMessage, UiMessageKind, UiOrderSummary } from '../../ipc/src/client.ts';
import type { DisplayConversation } from '../../ipc/src/adapterProtocol.ts';
import type { SdkMessageEvent } from './deps.ts';
import { toConversationFact, type ConversationListItem, type UnreadLookup } from './conversationList.ts';
import { jidLocal, jidSender, normalizeTimeMs, type HttpMessageObject, type MemberRoles } from './facts.ts';
import { recordOrNull } from './soa.ts';
import { effectiveMessageSender } from './message-body.ts';
import { parseVoiceMessage } from './voice.ts';
import { webAdapterStrings as copy, webAdapterUpstreamLabels as upstream } from './web-adapter-copy/strings.ts';

// ------------------------------------------------------------- small readers

function str(x: unknown): string | null {
  return typeof x === 'string' && x !== '' ? x : null;
}

function idStr(x: unknown): string | null {
  if (typeof x === 'string' && x !== '') return x;
  if (typeof x === 'number' && Number.isSafeInteger(x)) return String(x);
  return null;
}

function parseJsonObject(x: unknown): Record<string, unknown> | null {
  if (typeof x !== 'string' || x === '') return recordOrNull(x);
  try {
    return recordOrNull(JSON.parse(x));
  } catch {
    return null;
  }
}

function msgTypeNumber(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isInteger(raw)) return raw;
  if (typeof raw === 'string' && /^-?\d+$/.test(raw.trim())) return Number(raw.trim());
  return null;
}

// ------------------------------------------------------------- conversation row view

/**
 * Typed view of one `conversationList[]` row with the fields the RPC
 * handlers need but the protocol args do not carry (sessionId, worksheetId,
 * serviceType, threadId, conversationType, partnerJid, ...).
 */
export interface ConversationRowView {
  readonly gid: string;
  readonly sessionId: string | null;
  /** `row.id` — the worksheet id `setWorkSheetStar` expects (number). */
  readonly worksheetId: number | null;
  readonly serviceType: string;
  /** `''` stays `''` (send body `threadid`). */
  readonly threadId: string;
  readonly conversationType: string | null;
  readonly conversationKey: string | null;
  /** Customer uid of the conversation (`row.uid`). */
  readonly customerUid: string | null;
  readonly orderId: string | null;
  /** Last message as embedded in the row (`lastMessageJsonString`). */
  readonly lastMessage: HttpMessageObject | null;
}

export function parseLastMessage(row: ConversationListItem): HttpMessageObject | null {
  const raw = (row as { lastMessageJsonString?: unknown; lastMessage?: unknown }).lastMessageJsonString;
  const parsed = parseJsonObject(raw);
  const direct = parsed ?? recordOrNull((row as { lastMessage?: unknown }).lastMessage) ?? recordOrNull((row as { message?: unknown }).message);
  if (!direct) return null;
  if (direct['msgtype'] !== undefined) return direct as HttpMessageObject;
  // Official desktop va normalizes cached messages before exposing the list.
  const type = msgTypeNumber(direct['messageType']);
  if (type === null) return direct as HttpMessageObject;
  const body = typeof direct['messageBody'] === 'string' ? direct['messageBody'] : type === 0
    ? direct['content']
    : JSON.stringify({ title: direct['title'], action: direct['actionCode'], ext: direct['extPropertys'], isPresent: direct['isPresent'], url: direct['imageUrl'] ?? direct['url'], file: { filename: direct['filename'] } });
  return { ...direct, msgtype: type, messageBody: body, msgId: direct['messageId'] } as HttpMessageObject;
}

export function orderIdOf(row: ConversationListItem): string | null {
  const r = row as { relationOrderId?: unknown; ext?: unknown };
  const ext = recordOrNull(r.ext);
  const candidates = [r.relationOrderId, ext?.['relationOrderId'], ext?.['orderId'], ext?.['relationorderid'], ext?.['orderid']];
  for (const c of candidates) {
    const v = idStr(c);
    if (v !== null && /^\d{1,32}$/.test(v)) return v;
  }
  return null;
}

export function rowView(row: ConversationListItem): ConversationRowView | null {
  if (typeof row !== 'object' || row === null || typeof row.gid !== 'string' || row.gid === '') return null;
  const r = row as ConversationListItem & { id?: unknown };
  const st = r.serviceType;
  return {
    gid: r.gid as string,
    sessionId: idStr(r.sessionId),
    worksheetId: typeof r.id === 'number' && Number.isSafeInteger(r.id) ? r.id : typeof r.id === 'string' && /^\d{1,15}$/.test(r.id) ? Number(r.id) : null,
    serviceType: typeof st === 'string' ? st : typeof st === 'number' ? String(st) : '',
    threadId: typeof r.threadId === 'string' ? r.threadId : '',
    conversationType: str(r.conversationType),
    conversationKey: str((r as { conversationKey?: unknown }).conversationKey),
    customerUid: str(r.uid),
    orderId: orderIdOf(row),
    lastMessage: parseLastMessage(row),
  };
}

// ------------------------------------------------------------- labels

/** Two-letter-ish language code for the UI chip: `zh_HK` → `zh`, `en_PH` → `en`; unknown → `zh` (no chip). */
export function langOf(row: ConversationListItem): string {
  const r = row as { languageInfo?: unknown; ext?: unknown };
  const li = recordOrNull(r.languageInfo);
  const ext = recordOrNull(r.ext);
  const raw = str(li?.['lang']) ?? str(ext?.['locale']) ?? '';
  const m = /^([A-Za-z]{2,3})(?:[-_]|$)/.exec(raw.trim());
  const locale = m && m[1] ? m[1].toLowerCase() : 'zh';
  // The list already carries the last original message: only a verified customer
  // sender can refine its language before the conversation is opened.
  const view = rowView(row);
  const last = view?.lastMessage;
  const from = last && typeof last.fromJid === 'string' ? jidSender(last.fromJid) : '';
  if (!last || !view?.customerUid || from.toLowerCase() !== view.customerUid.toLowerCase() || msgTypeNumber(last.msgtype) !== 0 || typeof last.messageBody !== 'string') return locale;
  return customerLanguage({ lang: locale }, [{ sender_role: 'customer', kind: 'text', text: last.messageBody }]);
}

/** Deterministic avatar colour from the gid (prototype palette). */
export const AVATAR_COLORS: readonly string[] = ['#3E6DB5', '#2C7F8F', '#7A5BB5', '#A8743E', '#3F8F5A', '#B5536B', '#5B6676', '#2F6FED'];

export function colorOf(gid: string): string {
  let h = 0;
  for (let i = 0; i < gid.length; i++) h = (h * 31 + gid.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length] ?? '#5B6676';
}

/** Observed business lines only; anything else shows the raw serviceType. */
export const SERVICE_TYPE_LABELS: Readonly<Record<string, string>> = { '1513': copy['web-adapter.display.ticketsActivities'] };

export function bizLabel(serviceType: string): string {
  if (serviceType === '') return '';
  return SERVICE_TYPE_LABELS[serviceType] ?? copy['web-adapter.display.serviceType'](serviceType);
}

export function markOf(raw: unknown): MarkAction {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= 5 ? (raw as MarkAction) : 0;
}

// ------------------------------------------------------------- message bodies

/** `null` → not a displayable message (typing, acks, protocol frames). */
export function uiKindOf(msgtype: unknown, body?: unknown): UiMessageKind | null {
  const n = msgTypeNumber(msgtype);
  if (parseVoiceMessage(n, body)) return 'voice';
  switch (n) {
    case 0:
      return 'text';
    case 1:
      return 'image';
    case 3:
      return 'video';
    case 5:
      return 'file';
    case 2:
    case 7:
      // Official CardMessage / CustomContentMessage: sender-aligned content.
      // CTL01 with order fields is upgraded to order_card by the mapper.
      return 'text';
    case 1007:
    case 1009:
      return 'system';
    default:
      return null;
  }
}

/** Display text per kind; media bodies are the inner JSON string (one serialization). */
export function messageText(msgtype: unknown, body: unknown): string {
  const kind = uiKindOf(msgtype, body);
  if (kind === null) return '';
  if (kind === 'voice') return parseVoiceMessage(msgtype, body)?.text ?? '';
  if (msgTypeNumber(msgtype) === 2 || msgTypeNumber(msgtype) === 7) {
    const inner = parseJsonObject(body);
    const ext = recordOrNull(inner?.['ext']);
    if (inner?.['action'] === 'CBZ34' || inner?.['action'] === 'NBZ73') {
      return (str(ext?.['title']) ?? '') + (str(ext?.['highlight']) ?? '');
    }
    // Structured consultation cards carry their useful content in dataInfoList.
    // Render the supplied labels and values without treating a product as an order.
    if (inner?.['action'] === 'CTL01' && Array.isArray(ext?.['dataInfoList'])) {
      const rows = ext['dataInfoList'].flatMap(item => {
        const row = recordOrNull(item), label = str(row?.['title']), value = str(row?.['text']);
        return value ? [label ? copy['web-adapter.display.labelledValue'](label, value) : value] : [];
      });
      if (rows.length) return [str(ext['title']), str(ext['desc']), ...rows].filter(Boolean).join('\n');
    }
    // Official Nke fallback is title then messageBody, never a system label.
    return str(inner?.['title']) ?? str(ext?.['title']) ?? (typeof body === 'string' && !inner ? body : '');
  }
  if (kind === 'text') return typeof body === 'string' ? body : '';
  const inner = parseJsonObject(body);
  switch (kind) {
    case 'image':
      return str(inner?.['url']) ?? str(inner?.['thumbUrl']) ?? '';
    case 'video': {
      const v = recordOrNull(inner?.['video']);
      return str(v?.['url']) ?? '';
    }
    case 'file': {
      const f = recordOrNull(inner?.['file']);
      return str(f?.['filename']) ?? '';
    }
    default:
      return str(inner?.['title']) ?? str(recordOrNull(inner?.['ext'])?.['title']) ?? (typeof body === 'string' && !inner ? body : '');
  }
}

/** Official Kr summaries are independent of supported thread rendering components. */
export function previewOf(msg: HttpMessageObject | null, selfUid?: string): string {
  if (!msg) return '';
  const sender = effectiveMessageSender(typeof msg.fromJid === 'string' ? jidSender(msg.fromJid) : '', msg.messageBody, msg.msgtype);
  if (!isPresented(msg.msgtype, msg.messageBody, sender, selfUid)) return '';
  const type = msgTypeNumber(msg.msgtype), inner = parseJsonObject(msg.messageBody);
  const ext = recordOrNull(inner?.['ext']);
  const action = inner?.['action'];
  const summaries: Record<string, string> = { CBZ03: copy['web-adapter.display.summaryOrder'], CBZ09: copy['web-adapter.display.summaryVoice'], CBZ04: copy['web-adapter.display.summaryQa'], CBZ58: copy['web-adapter.display.summaryProduct'], CBZ59: copy['web-adapter.display.summaryContent'] };
  if (type === 7 && typeof action === 'string' && summaries[action]) return summaries[action]!;
  let text = '';
  switch (type) {
    case 0: text = typeof msg.messageBody === 'string' ? msg.messageBody : ''; break;
    case 1: return copy['web-adapter.display.image'];
    case 2: return copy['web-adapter.display.card'];
    case 3: return copy['web-adapter.display.video'];
    case 4: return copy['web-adapter.display.voice'];
    case 5: return copy['web-adapter.display.file'];
    case 6: return copy['web-adapter.display.location'];
    case 9: text = typeof msg.messageBody === 'string' ? msg.messageBody : ''; break;
    case 1009: text = copy['web-adapter.display.recalledMessage'](str(inner?.['operatorName']) ?? copy['web-adapter.display.systemOperator']); break;
    case 7: text = str(inner?.['title']) ?? str(ext?.['title']) ?? ''; break;
    case 1007: text = str(inner?.['title']) ?? ''; break;
    default: return '';
  }
  return text.replace(/\s+/g, ' ').slice(0, 200);
}

// ------------------------------------------------------------- conversations

export function orderSummary(orderId: string | null): UiOrderSummary | null {
  if (orderId === null) return null;
  // Only the id is in the row; the other fields come from the order page (not read here).
  return { order_id: orderId, product: '', use_date: '', quantity: '', status: '', contact: '' };
}

/** Verified CTL01 order source card. Match its order id before enriching the current conversation. */
export function orderSummaryFromMessage(msg: HttpMessageObject): UiOrderSummary | null {
  if (msgTypeNumber(msg.msgtype) !== 7) return null;
  const body = parseJsonObject(msg.messageBody);
  if (body?.['action'] !== 'CTL01') return null;
  const ext = recordOrNull(body['ext']);
  if (!Array.isArray(ext?.['dataInfoList'])) return null;
  const fields = new Map<string, string>();
  for (const item of ext['dataInfoList']) {
    const row = recordOrNull(item);
    const key = str(row?.['Id']);
    const value = str(row?.['text']);
    if (key && value) fields.set(key, value);
  }
  const id = fields.get('orderid');
  if (!id) {
    // The official desktop shows a separate product consultation source with
    // no order. Accept only the observed title and labeled product field.
    const title = str(ext['title']) ?? '';
    if (!/^(?:产品查询通知|產品查詢通知)$/.test(title)) return null;
    const byLabel = new Map<string, string>();
    for (const item of ext['dataInfoList']) {
      const row = recordOrNull(item), label = str(row?.['title']), value = str(row?.['text']);
      if (label && value) byLabel.set(label.replace(/[：:\s]/g, ''), value);
    }
    const labelValue = (pair: readonly [string, string]) => byLabel.get(pair[0]) ?? byLabel.get(pair[1]);
    const product = labelValue(upstream.productName);
    if (!product) return null;
    return { order_id: '', product, use_date: '', quantity: '', status: '', contact: '',
      source_title: title, source_description: str(ext['desc']) ?? '',
      source_channel: labelValue(upstream.sourceChannel) ?? '',
      product_id: labelValue(upstream.productId) ?? '',
      customer_language: labelValue(upstream.customerLanguage) ?? '',
      product_price: labelValue(upstream.productPrice) ?? '' };
  }
  if (!/^\d{1,32}$/.test(id)) return null;
  return {
    order_id: id, product: fields.get('productName') ?? '', use_date: fields.get('usedate') ?? '',
    quantity: '', status: '', contact: '', source_channel: fields.get('platformName') ?? '',
    total_amount: fields.get('orderamout') ?? '', source_title: str(ext?.['title']) ?? '',
    source_description: str(ext?.['desc']) ?? '',
    remark_name: str(recordOrNull(ext?.['extendInfo'])?.['providerProductName']) ?? '',
  };
}

/** Preserve unknown identifiers verbatim; invalid values cannot become known business types. */
function displayConversationType(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 64 && !/[\u0000-\u001f\u007f-\u009f]/.test(value) ? value : null;
}

export function toDisplayConversation(row: ConversationListItem, isFullSnapshot: boolean, unread?: UnreadLookup, selfUid?: string): DisplayConversation | null {
  const fact = toConversationFact(row, isFullSnapshot, unread);
  const view = rowView(row);
  if (!fact || !view) return null;
  // groupTitle describes the product/group, not the person. Member enrichment
  // replaces this identity fallback only after matching the row's customer uid.
  const title = view.customerUid ?? copy['web-adapter.display.visitor'];
  const order = orderSummary(view.orderId);
  return {
    ...fact,
    conversation_type: displayConversationType(row.conversationType),
    title,
    vendor_name: str((row as { vendorName?: unknown }).vendorName) ?? '',
    color: colorOf(view.gid),
    lang: langOf(row),
    biz: bizLabel(view.serviceType),
    last_message_time_ms: normalizeTimeMs(view.lastMessage?.createTime) ?? fact.last_message_time_ms,
    preview: previewOf(view.lastMessage, selfUid),
    mark: markOf(row.star),
    customer_tags: [],
    order: order ? { ...order, product: str((row as { groupTitle?: unknown }).groupTitle) ?? '' } : null,
  };
}

// ------------------------------------------------------------- messages

export interface UiMessageExtras {
  readonly original?: string | null;
  readonly disposition?: UiMessage['disposition'];
}

/** Identity is keyed by uid; display nicknames never decide a sender's role. */
function senderFields(sender: string, roles: MemberRoles) {
  const profile = sender ? roles.profileOf?.(sender) : null;
  return { sender_id: sender, sender_name: profile?.name ?? null, sender_avatar: profile?.avatar ?? null };
}

function mediaFields(msgtype: unknown, body: unknown) {
  const voice = parseVoiceMessage(msgtype, body);
  if (voice) return { media_url: voice.media_url, media_thumbnail: null, media_filename: null, voice_duration_s: voice.voice_duration_s };
  const kind = uiKindOf(msgtype);
  const inner = parseJsonObject(body);
  const video = recordOrNull(inner?.['video']);
  const file = recordOrNull(inner?.['file']);
  return {
    media_url: kind === 'image' ? str(inner?.['url']) ?? str(inner?.['thumbUrl']) : kind === 'video' ? str(video?.['url']) : kind === 'file' ? str(file?.['url']) : null,
    media_thumbnail: kind === 'image' ? str(inner?.['thumbUrl']) : kind === 'video' ? str(video?.['cover']) ?? str(video?.['thumbUrl']) : null,
    media_filename: kind === 'file' ? str(file?.['filename']) : null,
  };
}

/** Official status/control events explicitly opt out of presentation. */
function isPresented(msgtype: unknown, body: unknown, sender?: string, selfUid?: string): boolean {
  const type = msgTypeNumber(msgtype);
  // Text is opaque user content, including JSON that resembles metadata.
  if (type === 0) return true;
  const inner = parseJsonObject(body);
  // Only these wire models project ext/isPresent in desktop va. In
  // particular, a CardMessage (2) does not have the custom-message metadata.
  const hasExt = type === 3 || type === 5 || type === 7 || type === 1007 || type === 1009 || type === 1012;
  const ext = hasExt ? recordOrNull(inner?.['ext']) : null;
  const action = type === 7 || type === 1007 || type === 1012 ? inner?.['action'] : undefined;
  // Desktop Ph uses the effective sender, never its role label, for CTL01.
  if (action === 'CTL01' && selfUid !== undefined && sender !== undefined) {
    const field = sender.toLowerCase() === selfUid.toLowerCase() ? 'fromCardHide' : 'toCardHide';
    if (ext?.[field] === '1' || ext?.[field] === 1) return false;
  }
  // Ph gives the numeric visibility mask priority over isPresent; NBZ37 is
  // the desktop exception that remains visible without the vendor bit (4).
  if (typeof ext?.['visibleRule'] === 'number') return (ext['visibleRule'] & 4) !== 0 || action === 'NBZ37';
  return !(type === 7 || type === 1007 || type === 1009 || type === 1012) || inner?.['isPresent'] !== false;
}

function recallFields(msgtype: unknown, body: unknown) {
  const inner = parseJsonObject(body);
  return { recalled_message_id: msgTypeNumber(msgtype) === 1009 ? idStr(inner?.['recallMessageId']) : null };
}

/** HTTP message object (history / compensation / list rows) → `UiMessage`; `null` for non-display rows. */
export function httpMessageToUi(msg: HttpMessageObject, roles: MemberRoles, gid?: string, extras: UiMessageExtras = {}): UiMessage | null {
  if (typeof msg !== 'object' || msg === null) return null;
  const order = orderSummaryFromMessage(msg);
  const kind = order ? 'order_card' : uiKindOf(msg.msgtype, msg.messageBody);
  if (kind === null) return null;
  const createTime = normalizeTimeMs(msg.createTime);
  if (createTime === null) return null;
  const partner = str(msg.partner);
  const to = str(msg.toJid);
  const from = str(msg.fromJid);
  const g = gid ?? (partner ? jidLocal(partner) : from?.includes('/') ? jidLocal(from) : to ? jidLocal(to) : null);
  if (!g) return null;
  const sender = effectiveMessageSender(from ? jidSender(from) : '', msg.messageBody, msg.msgtype);
  if (!isPresented(msg.msgtype, msg.messageBody, sender, roles.selfUid)) return null;
  // Desktop va accepts both HTTP spellings; SDK frames use citemsgid.
  const cite = idStr(msg.citeMsgId) ?? idStr(msg.citemsgid);
  return {
    gid: g,
    message_id: idStr(msg.msgId),
    local_id: idStr(msg.localId),
    create_time_ms: createTime,
    sender_role: sender ? roles.roleOf(sender) : 'unknown',
    ...senderFields(sender, roles),
    kind,
    platform_type: msgTypeNumber(msg.msgtype),
    text: order?.product ?? messageText(msg.msgtype, msg.messageBody),
    ...mediaFields(msg.msgtype, msg.messageBody),
    ...recallFields(msg.msgtype, msg.messageBody),
    translation: null,
    original: extras.original ?? null,
    quote: cite,
    order_id: order?.order_id ?? null,
    read_status: (roles.roleOf(sender) === 'merchant_self' || roles.roleOf(sender) === 'merchant_other') && typeof msg.isTargetRead === 'boolean' ? (msg.isTargetRead ? 'read' : 'unread')
      : roles.roleOf(sender) === 'customer' && typeof msg.isread === 'boolean' ? (msg.isread ? 'read' : 'unread') : 'unknown',
    disposition: extras.disposition ?? (sender && roles.roleOf(sender) === 'merchant_self' && idStr(msg.msgId) ? { kind: 'confirmed', server_message_id: idStr(msg.msgId)!, server_time_ms: createTime } : null),
  };
}

/** SDK realtime frame (already normalised by the page glue) → `UiMessage`. */
export function sdkMessageToUi(evt: SdkMessageEvent, roles: MemberRoles): UiMessage | null {
  if (typeof evt !== 'object' || evt === null) return null;
  const type = str(evt.type);
  if (type !== 'groupchat' && type !== 'chat') return null;
  const order = orderSummaryFromMessage({ msgtype: evt.msgtype, messageBody: evt.body });
  const kind = order ? 'order_card' : uiKindOf(evt.msgtype, evt.body);
  if (kind === null) return null;
  const address = resolveSdkAddress(evt, roles);
  if (!address) return null;
  const { gid, senderId: sender } = address;
  if (!isPresented(evt.msgtype, evt.body, sender, roles.selfUid)) return null;
  const createTime = normalizeTimeMs(evt.create_time) ?? normalizeTimeMs(evt.ts);
  if (createTime === null) return null;
  return {
    gid,
    message_id: idStr(evt.id),
    local_id: idStr(evt.localid),
    create_time_ms: createTime,
    sender_role: sender ? roles.roleOf(sender) : 'unknown',
    ...senderFields(sender, roles),
    kind,
    platform_type: msgTypeNumber(evt.msgtype),
    text: order?.product ?? messageText(evt.msgtype, evt.body),
    ...mediaFields(evt.msgtype, evt.body),
    ...recallFields(evt.msgtype, evt.body),
    translation: null,
    original: null,
    quote: idStr(evt.citemsgid),
    order_id: order?.order_id ?? null,
    disposition: sender && roles.roleOf(sender) === 'merchant_self' && idStr(evt.id) ? { kind: 'confirmed', server_message_id: idStr(evt.id)!, server_time_ms: createTime } : null,
  };
}

/** List preview for a display message (realtime / compensation updates). */
export function previewOfUi(m: UiMessage): string {
  switch (m.kind) {
    case 'text':
      return m.text.replace(/\s+/g, ' ').slice(0, 200);
    case 'image':
      return copy['web-adapter.display.image'];
    case 'video':
      return copy['web-adapter.display.video'];
    case 'file':
      return m.text ? copy['web-adapter.display.fileNamed'](m.text) : copy['web-adapter.display.file'];
    case 'voice':
      return copy['web-adapter.display.voice'];
    default:
      return m.text ? m.text.slice(0, 200) : copy['web-adapter.display.message'];
  }
}

export function byCreateTime(a: UiMessage, b: UiMessage): number {
  return a.create_time_ms - b.create_time_ms;
}

// ------------------------------------------------------------- agent status

export const AGENT_STATUS_CODES: Readonly<Record<AgentStatus, number>> = { online: 0, hangup: 1, leaving: 2, getoff: 3 };

export function agentStatusOf(raw: unknown): AgentStatus | null {
  const n = msgTypeNumber(raw);
  switch (n) {
    case 0:
      return 'online';
    case 1:
      return 'hangup';
    case 2:
      return 'leaving';
    case 3:
      return 'getoff';
    default:
      return null;
  }
}
