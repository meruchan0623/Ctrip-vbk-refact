/**
 * Pure view-model logic for the main window (no DOM): conversation list
 * sorting/filtering, context-menu command payloads, outbound send state,
 * order-contact state machine, status-bar derivations.
 */

import type { AccountContext, AppError, SendDisposition } from '../../packages/ipc/src/contracts.ts';
import { ErrorCodes, isAppError } from '../../packages/ipc/src/contracts.ts';
import type { AgentStatus, MarkAction, OrderSearchResult, UiAccount, UiAccountSnapshot, UiAgentStatus, UiConversation, UiMessage, UiNetStatus, UiOrderSummary } from '../../packages/ipc/src/client.ts';
import { UiCommands } from '../../packages/ipc/src/client.ts';
import { mergeMessageProfile } from './message-profile.ts';
export { rowId } from './message-window.ts';
export { personDisplayName } from './person-name.ts';
import { historyKeyOf, historyKeyString, historyKeysMatch, parseHistoryKey } from './history-key.ts';
import { AccountCommands } from '../../packages/ipc/src/commands.ts';
import { t } from '../../packages/ui-kit/src/i18n.ts';
import type { I18nKey } from '../../packages/ui-kit/src/i18n.ts';

// ------------------------------------------------------------ conversations

export type ListTab = 'doing' | 'done' | 'unknown';
export type BusinessTab = 'customer' | 'enterprise' | 'unknown';

/** Official BC/BOP classification; absent and future types remain inspectable. */
export function conversationBusiness(c: UiConversation): BusinessTab {
  const type = 'conversation_type' in c ? c.conversation_type : null;
  if (type === 'O2B' && c.service_type === '2573') return 'customer';
  if (type === 'B2C' || type === 'C2B' || type === 'B2MC') return 'customer';
  if (type === 'B2O' || type === 'O2B' || type === 'B2B') return 'enterprise';
  return 'unknown';
}

export function conversationListStatus(c: UiConversation): ListTab {
  if (conversationBusiness(c) === 'unknown') return 'unknown';
  if (c.status === 'unknown') return conversationBusiness(c) === 'customer' ? 'doing' : 'unknown';
  if (c.status === 'active') return 'doing';
  return isDone(c) ? 'done' : 'unknown';
}

export function isDone(c: UiConversation): boolean {
  return c.status === 'finished' || c.status === 'transferred_out';
}

/** Pinned first; inside each group newest last message first; stable for ties. */
export function sortConversations(list: readonly UiConversation[]): UiConversation[] {
  return list
    .map((c, i) => ({ c, i }))
    .sort((a, b) => {
      if (a.c.is_top !== b.c.is_top) return a.c.is_top ? -1 : 1;
      const ta = a.c.last_message_time_ms ?? 0;
      const tb = b.c.last_message_time_ms ?? 0;
      if (ta !== tb) return tb - ta;
      return a.i - b.i;
    })
    .map((x) => x.c);
}

export function tabCounts(list: readonly UiConversation[], business: BusinessTab = 'customer'): { doing: number; done: number; unknown: number } {
  const counts = { doing: 0, done: 0, unknown: 0 };
  for (const c of list) {
    if (conversationBusiness(c) === business) counts[conversationListStatus(c)] += 1;
  }
  return counts;
}

export function matchesQuery(c: UiConversation, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (c.title.toLowerCase().includes(q)) return true;
  if (c.preview.toLowerCase().includes(q)) return true;
  if (c.order && c.order.order_id.includes(q)) return true;
  return false;
}

// Immutable store snapshots let scrolling/draft updates reuse sorting. Keep only
// the latest query per snapshot, with weak ownership of retired account lists.
const conversationFilters = new WeakMap<readonly UiConversation[], { tab: ListTab; query: string; business: BusinessTab; rows: UiConversation[] }>();
export function filterConversations(list: readonly UiConversation[], tab: ListTab, query: string, business: BusinessTab = 'customer'): UiConversation[] {
  const cached = conversationFilters.get(list);
  if (cached && cached.tab === tab && cached.query === query && cached.business === business) return cached.rows;
  const rows = sortConversations(list.filter((c) => conversationBusiness(c) === business && conversationListStatus(c) === tab && matchesQuery(c, query)));
  conversationFilters.set(list, { tab, query, business, rows });
  return rows;
}

export function unreadTotal(list: readonly UiConversation[]): number {
  return list.reduce((n, c) => n + (isDone(c) ? 0 : c.unread_count), 0);
}

// ------------------------------------------------------------ context menu

export interface MarkColor {
  readonly action: Exclude<MarkAction, 0>;
  readonly nameKey: I18nKey;
  readonly cssVar: string;
}

/** Official five colours (setWorkSheetStar action 1–5). */
export const MARK_COLORS: readonly MarkColor[] = [
  { action: 1, nameKey: 'ctx.markOrange', cssVar: '--mark-1' },
  { action: 2, nameKey: 'ctx.markGreen', cssVar: '--mark-2' },
  { action: 3, nameKey: 'ctx.markBlue', cssVar: '--mark-3' },
  { action: 4, nameKey: 'ctx.markPurple', cssVar: '--mark-4' },
  { action: 5, nameKey: 'ctx.markPink', cssVar: '--mark-5' },
];

export type ContextAction = { readonly kind: 'toggle_top' } | { readonly kind: 'mark'; readonly action: MarkAction };

export interface CommandPayload {
  readonly cmd: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export function contextMenuCommand(conv: UiConversation, action: ContextAction): CommandPayload {
  if (action.kind === 'toggle_top') {
    return { cmd: UiCommands.IM_SET_TOP, payload: { account: conv.account, gid: conv.gid, top: !conv.is_top } };
  }
  if (!Number.isInteger(action.action) || action.action < 0 || action.action > 5) throw new RangeError('mark action must be 0–5');
  return { cmd: UiCommands.IM_SET_MARK, payload: { account: conv.account, gid: conv.gid, action: action.action } };
}

export function contextMenuItems(conv: UiConversation): { topLabel: string; showClear: boolean } {
  return { topLabel: conv.is_top ? t('ctx.unpin') : t('ctx.pin'), showClear: conv.mark !== 0 };
}

// ------------------------------------------------------------ outbound send

export type SendStateClass = 'sending' | 'ok' | 'rej' | 'unk';

export interface SendStateView {
  readonly cls: SendStateClass;
  readonly label: string;
  /** Only `rejected` offers a manual resend; `unknown` never auto-resends. */
  readonly canRetry: boolean;
  readonly spin: boolean;
}

export function sendStateView(disposition: SendDisposition | null): SendStateView {
  if (disposition === null) return { cls: 'sending', label: t('send.sending'), canRetry: false, spin: true };
  switch (disposition.kind) {
    case 'confirmed':
      return { cls: 'ok', label: t('send.confirmed'), canRetry: false, spin: false };
    case 'rejected':
      return { cls: 'rej', label: `${t('send.rejected')}（${disposition.reason}）`, canRetry: true, spin: false };
    case 'unknown':
      return { cls: 'unk', label: t('send.unknown'), canRetry: false, spin: false };
    default:
      return { cls: 'unk', label: t('send.unknown'), canRetry: false, spin: false };
  }
}

/** 消息下方可见的发送状态：成功确认态不再显示文字（仅保留行级 data 标记），
 * 发送中、结果未知、发送失败仍逐条显示，确认/拒绝/未知三态保持分开。 */
export function visibleSendState(disposition: SendDisposition | null): SendStateView | null {
  const view = sendStateView(disposition);
  return view.cls === 'ok' ? null : view;
}

// ------------------------------------------------------------ order card

export interface OrderCardRow {
  readonly label: string;
  readonly value: string;
}

export interface OrderCardView {
  readonly title: string;
  /** 卡片自带的来源描述；未回传则为 null，不补默认文案。 */
  readonly subtitle: string | null;
  readonly rows: readonly OrderCardRow[];
}

/** 对话串内订单咨询卡片的展示字段。仅当摘要与卡片订单号完全一致时才取其补充字段；
 * 缺失字段整行省略，不编造。 */
export function orderCardView(m: Pick<UiMessage, 'order_id' | 'text'>, order: UiOrderSummary | null): OrderCardView {
  const o = order && m.order_id && order.order_id === m.order_id ? order : null;
  const clean = (value: string | null | undefined): string => (typeof value === 'string' ? value.trim() : '');
  const rows: OrderCardRow[] = [];
  const push = (key: I18nKey, value: string | null | undefined): void => {
    const v = clean(value);
    if (v) rows.push({ label: t(key), value: v });
  };
  push('chat.order.channel', o?.source_channel);
  push('chat.order.id', m.order_id);
  push('chat.order.product', clean(o?.product) || m.text);
  push('chat.order.useDate', o?.use_date);
  push('chat.order.amount', o?.total_amount);
  return { title: clean(o?.source_title) || t('chat.orderCardTitle'), subtitle: clean(o?.source_description) || null, rows };
}

export function isOutbound(m: UiMessage): boolean {
  return m.sender_role === 'merchant_self';
}

export function roleLabel(role: UiMessage['sender_role']): string {
  const key = `chat.role.${role}` as I18nKey;
  return t(key);
}

let localSeq = 0;
export function nextLocalId(nowMs: number): string {
  localSeq += 1;
  return `local-${nowMs.toString(36)}-${localSeq}`;
}

export function previewOf(m: UiMessage): string {
  switch (m.kind) {
    case 'image':
      return t('chat.image');
    case 'file':
      return t('chat.file');
    case 'video':
      return t('chat.video');
    case 'order_card':
      return `[${t('chat.orderCard')}]`;
    default:
      return m.text;
  }
}

export const ICCID_RE = /\b(89\d{17,18})\b/g;

export function findIccids(messages: readonly UiMessage[]): string[] {
  const out = new Set<string>();
  for (const m of messages) {
    if (m.kind !== 'text') continue;
    for (const match of m.text.matchAll(ICCID_RE)) {
      const id = match[1];
      if (id) out.add(id);
    }
  }
  return Array.from(out);
}

// ------------------------------------------------------------ translation

export interface TranslationState {
  readonly status: 'idle' | 'busy' | 'done' | 'error';
  readonly gid: string | null;
  readonly draftVersion: number;
  readonly target: string;
  readonly text: string;
  readonly error: string | null;
}

export const TRANSLATION_IDLE: TranslationState = { status: 'idle', gid: null, draftVersion: 0, target: 'en', text: '', error: null };

export function translationApplies(state: TranslationState, gid: string, draftVersion: number): boolean {
  return state.gid === gid && state.draftVersion === draftVersion;
}

/**
 * 输入区是否锁定。已结束（finished）的会话仍可发送：适配器在提交前按官方网页
 * 行为先重新开启会话（docs/api/validation.md「受控结束/重新进入」，evidence 49）。
 * 转出（transferred_out）的会话责任已不在本坐席，仍然禁止发送。
 */
export function composerLocked(c: UiConversation): boolean {
  return c.status === 'transferred_out';
}

/** `lang`：会话的有效客户语言（见 `customerLanguage`），缺省取行上的 `conv.lang`。 */
export function shouldShowTranslationBar(conv: UiConversation | null, assistantEnabled: boolean, outboundEnabled: boolean, lang: string = conv?.lang ?? 'zh'): boolean {
  return !!conv && !composerLocked(conv) && lang !== 'zh' && assistantEnabled && outboundEnabled;
}

/** 出站翻译允许的目标语言（与 core-assistant `TARGET_LANGS` 去掉 zh 后一致）。 */
export const OUTBOUND_TARGETS: readonly string[] = ['en', 'ja', 'ko', 'th', 'vi', 'id', 'ms', 'es', 'fr', 'de', 'ru', 'ar', 'zh-TW', 'pt', 'it', 'tr'];

/** 客户语言 → 可提交给 TSim 的目标语言；不在白名单内（如 `fil`、`nl`）时退回英语，避免宿主以 unsupported target 拒绝。 */
export function outboundTarget(lang: string): string {
  return OUTBOUND_TARGETS.includes(lang) ? lang : 'en';
}

const HAN = /[㐀-䶿一-鿿豈-﫿]/;
const KANA_OR_HANGUL = /[ぁ-ヿㇰ-ㇿｦ-ﾟ가-힯ᄀ-ᇿ㄰-㆏]/;
/**
 * 出站翻译只处理客服输入的中文；不含汉字、或含假名/谚文（例如已「替换」成
 * 日文/韩文译文的草稿）按原样发送，不把外文再当中文翻一遍。
 */
export function needsOutboundTranslation(text: string): boolean {
  return HAN.test(text) && !KANA_OR_HANGUL.test(text);
}

/**
 * 文字脚本启发式（与 core-assistant `suggest_language` 同序）：假名→ja、谚文→ko、
 * 泰文→th、阿拉伯文→ar、西里尔文→ru、汉字→zh、拉丁字母→en。判定字母少于 4 个视为低置信，返回 null。
 */
export function suggestLanguage(text: string): string | null {
  let kana = 0, hangul = 0, thai = 0, arabic = 0, cyrillic = 0, han = 0, latin = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if ((c >= 0x3041 && c <= 0x30FF) || (c >= 0x31F0 && c <= 0x31FF) || (c >= 0xFF66 && c <= 0xFF9F)) kana++;
    else if ((c >= 0xAC00 && c <= 0xD7AF) || (c >= 0x1100 && c <= 0x11FF) || (c >= 0x3130 && c <= 0x318F) || (c >= 0xA960 && c <= 0xA97F)) hangul++;
    else if ((c >= 0x0E01 && c <= 0x0E3A) || (c >= 0x0E40 && c <= 0x0E4E)) thai++;
    else if ((c >= 0x0600 && c <= 0x06FF) || (c >= 0x0750 && c <= 0x077F) || (c >= 0xFB50 && c <= 0xFDFF) || (c >= 0xFE70 && c <= 0xFEFF)) arabic++;
    else if (c >= 0x0400 && c <= 0x052F) cyrillic++;
    else if (HAN.test(ch) || c === 0x3005 || c === 0x3007 || (c >= 0x20000 && c <= 0x2A6DF)) han++;
    else if ((c < 0x80 && /[A-Za-z]/.test(ch)) || (c >= 0x00C0 && c <= 0x024F) || (c >= 0x1E00 && c <= 0x1EFF)) latin++;
  }
  const [lang, count] = kana > 0 ? ['ja', kana + han] : hangul > 0 ? ['ko', hangul] : thai > 0 ? ['th', thai] : arabic > 0 ? ['ar', arabic] : cyrillic > 0 ? ['ru', cyrillic] : han > 0 ? ['zh', han] : latin > 0 ? ['en', latin] : [null, 0];
  return lang !== null && count >= 4 ? lang : null;
}

/** 识别时最多回看的客户文字消息条数。 */
export const LANGUAGE_SCAN_LIMIT = 5;

/**
 * 会话的有效客户语言。官方行的 `languageInfo.lang / ext.locale` 是客户端界面区域
 * （Trip-App 常见 `zh_HK`，或整个缺失而被归为 zh），不等于客户实际书写的语言；
 * 行上为外语时直接采用，否则按最近几条客户文字消息的书写脚本识别。
 */
export function customerLanguage(conv: Pick<UiConversation, 'lang'>, messages: readonly Pick<UiMessage, 'sender_role' | 'kind' | 'text'>[]): string {
  if (conv.lang !== 'zh') return conv.lang;
  let seen = 0;
  for (let i = messages.length - 1; i >= 0 && seen < LANGUAGE_SCAN_LIMIT; i--) {
    const m = messages[i]!;
    if (m.sender_role !== 'customer' || m.kind !== 'text' || !m.text) continue;
    seen++;
    const lang = suggestLanguage(m.text);
    if (lang !== null) return lang;
  }
  return 'zh';
}

export const LANG_NAMES: Readonly<Record<string, string>> = {
  ar: '阿拉伯语',
  pt: '葡萄牙语',
  it: '意大利语',
  tr: '土耳其语',
  zh: '中文',
  en: '英语',
  ja: '日语',
  ko: '韩语',
  th: '泰语',
  vi: '越南语',
  id: '印尼语',
  ms: '马来语',
  es: '西班牙语',
  fr: '法语',
  de: '德语',
  ru: '俄语',
  'zh-TW': '繁体中文',
};

export function langName(code: string): string {
  return LANG_NAMES[code] ?? code;
}

// ------------------------------------------------------------ order contact

export type OrderContactState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading'; readonly orderId: string }
  | { readonly kind: 'none'; readonly orderId: string }
  | { readonly kind: 'one'; readonly orderId: string; readonly order: UiOrderSummary }
  | { readonly kind: 'multiple'; readonly orderId: string; readonly orders: readonly UiOrderSummary[] }
  | { readonly kind: 'forbidden'; readonly orderId: string }
  | { readonly kind: 'unknown'; readonly orderId: string; readonly message: string };

export type OrderContactEvent =
  | { readonly type: 'query'; readonly orderId: string }
  | { readonly type: 'result'; readonly orderId: string; readonly result: OrderSearchResult }
  | { readonly type: 'error'; readonly orderId: string; readonly error: unknown }
  /** The user picked one row out of a `multiple` result (04 §: 多个匹配，请核对后选择). */
  | { readonly type: 'select'; readonly orderId: string }
  | { readonly type: 'reset' };

/** `IM 联系` / `网页高级操作` are offered only for exactly one verified order. */
export function canContactOrder(state: OrderContactState): state is Extract<OrderContactState, { kind: 'one' }> {
  return state.kind === 'one';
}

export const ORDER_ID_RE = /^(?:\d{10}|\d{16})$/;

export function isValidOrderId(s: string): boolean {
  return ORDER_ID_RE.test(s.trim());
}

export function orderContactReduce(state: OrderContactState, ev: OrderContactEvent): OrderContactState {
  switch (ev.type) {
    case 'reset':
      return { kind: 'idle' };
    case 'query':
      // A query that timed out must not be replayed silently: the user has to re-issue it.
      return { kind: 'loading', orderId: ev.orderId };
    case 'result': {
      if (state.kind !== 'loading' || state.orderId !== ev.orderId) return state; // late result for another query
      const r = ev.result;
      switch (r.kind) {
        case 'none':
          return { kind: 'none', orderId: ev.orderId };
        case 'one':
          return { kind: 'one', orderId: ev.orderId, order: r.order };
        case 'multiple':
          return r.orders.length === 0 ? { kind: 'none', orderId: ev.orderId } : r.orders.length === 1 && r.orders[0] ? { kind: 'one', orderId: ev.orderId, order: r.orders[0] } : { kind: 'multiple', orderId: ev.orderId, orders: r.orders };
        case 'forbidden':
          return { kind: 'forbidden', orderId: ev.orderId };
        default:
          return { kind: 'unknown', orderId: ev.orderId, message: '' };
      }
    }
    case 'error': {
      if (state.kind !== 'loading' || state.orderId !== ev.orderId) return state;
      const e = ev.error;
      if (isAppError(e)) {
        if (e.code === ErrorCodes.IM_PERMISSION_DENIED || e.code === ErrorCodes.HOST_VIEW_UNAUTHORIZED) return { kind: 'forbidden', orderId: ev.orderId };
        if (e.code === ErrorCodes.NET_TIMEOUT || e.code === ErrorCodes.NET_OFFLINE || e.code === ErrorCodes.IM_SEND_UNKNOWN) return { kind: 'unknown', orderId: ev.orderId, message: e.message };
        return { kind: 'unknown', orderId: ev.orderId, message: e.message };
      }
      return { kind: 'unknown', orderId: ev.orderId, message: errorMessage(e) };
    }
    case 'select': {
      // Only a row of the current multiple result can be selected; the pick narrows it to `one`.
      if (state.kind !== 'multiple') return state;
      const order = state.orders.find((o) => o.order_id === ev.orderId);
      return order ? { kind: 'one', orderId: state.orderId, order } : state;
    }
    default:
      return state;
  }
}

export function orderDetailUrl(orderId: string): string {
  return `https://vbooking.ctrip.com/ticket_order/order/detail?orderId=${encodeURIComponent(orderId)}`;
}

export function errorMessage(e: unknown): string {
  if (isAppError(e)) return (e as AppError).message;
  if (e instanceof Error) return e.message;
  return String(e);
}

// ------------------------------------------------------------ accounts / status

export function accountLabel(a: UiAccount): string {
  return a.remark && a.remark.trim() ? a.remark : a.nick;
}

/** Avatar letter: the part after the last 「·」 names the agent (云游·夜班组 → 夜, 畅行租车·Lily → L). */
export function accountInitial(a: UiAccount): string {
  const label = accountLabel(a).trim();
  const tail = label.split('·').pop()?.trim() ?? '';
  const first = Array.from(tail || label)[0] ?? '?';
  return /[a-z]/.test(first) ? first.toUpperCase() : first;
}

export type LogoutMode = 'suspend' | 'logout' | 'forget';

export function logoutCommand(mode: LogoutMode): string {
  switch (mode) {
    case 'suspend':
      return AccountCommands.SUSPEND;
    case 'logout':
      return AccountCommands.LOGOUT;
    case 'forget':
      return AccountCommands.FORGET;
    default:
      return AccountCommands.SUSPEND;
  }
}

export const AGENT_STATUS_ORDER: readonly AgentStatus[] = ['online', 'hangup', 'leaving', 'getoff'];

export function agentStatusLabel(s: AgentStatus): string {
  const key = `status.${s}` as I18nKey;
  return t(key);
}

export function agentStatusColorVar(s: AgentStatus): string {
  switch (s) {
    case 'online':
      return '--c-ok';
    case 'hangup':
      return '--c-warn';
    case 'leaving':
      return '--c-leaving';
    default:
      return '--c-offline';
  }
}

export function sameAccount(a: AccountContext, b: AccountContext): boolean {
  return a.account_id === b.account_id && a.environment === b.environment;
}


/** Agent status as shown: an unconfirmed (not yet read back) status is 「状态未知」, never the default value. */
export function agentView(a: UiAgentStatus): { readonly label: string; readonly colorVar: string; readonly known: boolean } {
  if (!a.confirmed) return { label: t('status.unknown'), colorVar: '--c-offline', known: false };
  return { label: agentStatusLabel(a.status), colorVar: agentStatusColorVar(a.status), known: true };
}

export function agentStatusDesc(s: AgentStatus): string {
  return t(`status.desc.${s}` as I18nKey);
}

/**
 * Send barrier mirror (I-04a): true while the host reports a failed durable
 * write. The host is the real gate (`store.persist_failed` before the journal);
 * the UI only pauses the composer and shows the status-bar notice. Absent flag
 * (older host, mock) = not failed.
 */
export function persistFailed(snap: Pick<UiAccountSnapshot, 'persist_failed'> | null | undefined): boolean {
  return snap?.persist_failed === true;
}

/**
 * Disposition for a text send whose IPC call failed. Only codes that prove
 * "nothing was submitted" become a local `rejected` (the user may resend):
 * the host's permission check and its send barrier (`store.persist_failed`,
 * refused before the outbound journal). Anything else is `unknown` and is
 * never auto-resent.
 */
export function sendFailureDisposition(e: unknown): SendDisposition {
  if (!isAppError(e)) return { kind: 'unknown' };
  if (e.code === ErrorCodes.IM_PERMISSION_DENIED) return { kind: 'rejected', code: e.code, reason: e.message };
  if (e.code === ErrorCodes.STORE_PERSIST_FAILED) return { kind: 'rejected', code: e.code, reason: t('bar.persistFailed') };
  return { kind: 'unknown' };
}

/** Status-bar / composer notice for the send barrier, or null when sending is allowed. */
export function persistFailedView(snap: Pick<UiAccountSnapshot, 'persist_failed'> | null | undefined): { readonly label: string; readonly title: string } | null {
  return persistFailed(snap) ? { label: t('bar.persistFailed'), title: t('bar.persistFailedTitle') } : null;
}

/** Network label from the host read-back only; `null` means nothing was read back yet (「未连接」). */
export function netView(n: UiNetStatus | null): { readonly label: string; readonly ok: boolean; readonly offline: boolean } {
  if (!n) return { label: t('bar.net.none'), ok: false, offline: false };
  if (!n.online) return { label: t('bar.net.offline'), ok: false, offline: true };
  switch (n.transport) {
    case 'connected':
      return { label: t('bar.net.online'), ok: true, offline: false };
    case 'connecting':
      return { label: t('bar.net.connecting'), ok: false, offline: false };
    case 'reconnecting':
      return { label: t('bar.net.reconnecting'), ok: false, offline: false };
    default:
      return { label: t('bar.net.none'), ok: false, offline: false };
  }
}

// ------------------------------------------------------------ inline highlights

export type TextPart = { readonly kind: 'plain' | 'order' | 'iccid'; readonly text: string };

const HIGHLIGHT_RE = /(89\d{17,18})|(?<!\d)(\d{16}|\d{10})(?!\d)/g;

/** Split message text into plain runs, ICCIDs and official 10- or 16-digit order numbers (prototype: 「消息里的订单号 / ICCID 可点击」). */
export function highlightParts(text: string): TextPart[] {
  const out: TextPart[] = [];
  let last = 0;
  for (const m of text.matchAll(HIGHLIGHT_RE)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ kind: 'plain', text: text.slice(last, at) });
    out.push({ kind: m[1] ? 'iccid' : 'order', text: m[0] });
    last = at + m[0].length;
  }
  if (last < text.length) out.push({ kind: 'plain', text: text.slice(last) });
  return out;
}

// ------------------------------------------------------------ banner notifier

export interface BannerItem {
  readonly id: number;
  readonly account: AccountContext;
  readonly gid: string;
  readonly count: number;
  readonly system: boolean;
  readonly at: number;
  readonly until: number;
}

export const BANNER_VISIBLE = 3;
export const BANNER_STAY_MS = 6000;

/** A new banner for the same conversation replaces the old one (count carried by the host) and moves to the top. */
export function pushBanner(list: readonly BannerItem[], b: Omit<BannerItem, 'until'> & { readonly stayMs: number }): BannerItem[] {
  const stay = b.stayMs > 0 ? b.stayMs : BANNER_STAY_MS;
  const item: BannerItem = { id: b.id, account: b.account, gid: b.gid, count: b.count, system: b.system, at: b.at, until: b.at + stay };
  return [item, ...list.filter((x) => !(x.gid === b.gid && sameAccount(x.account, b.account)))];
}

/** Expire banners; while the pointer hovers the stack nothing expires (prototype: 悬停暂停). */
export function expireBanners(list: readonly BannerItem[], now: number, paused: boolean): readonly BannerItem[] {
  if (paused) return list;
  const keep = list.filter((b) => b.until > now);
  return keep.length === list.length ? list : keep;
}

/** Hovering pauses the countdown: on leave, every banner gets its remaining time back (at least 1.5 s). */
export function resumeBanners(list: readonly BannerItem[], pausedAt: number, now: number): BannerItem[] {
  const shift = Math.max(0, now - pausedAt);
  return list.map((b) => ({ ...b, until: Math.max(b.until + shift, now + 1500) }));
}

export function alarmActiveCount(entries: readonly { readonly snoozed_until_ms: number | null }[], nowMs: number): number {
  return entries.filter((e) => e.snoozed_until_ms === null || e.snoozed_until_ms <= nowMs).length;
}

/** Media is rendered only from network URLs, never executable or local-file schemes. */
export function safeMediaUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function compatibleMessageSender(a: UiMessage, b: UiMessage): boolean {
  const left = a.sender_id?.trim().toLowerCase();
  const right = b.sender_id?.trim().toLowerCase();
  return a.sender_role === b.sender_role && (!left || !right || left === right);
}
function compatibleLocalAlias(a: UiMessage, b: UiMessage): boolean {
  return a.gid === b.gid && compatibleMessageSender(a, b) && (!a.message_id || !b.message_id || a.message_id === b.message_id);
}

/** Exact server corrections never inherit another identity's profile, aliases or receipt. */
function mergeMessageRecord(existing: UiMessage, incoming: UiMessage): UiMessage {
  if (!compatibleMessageSender(existing, incoming)) return incoming;
  const merged = mergeQuoteReference(existing, mergeMessageProfile(existing, incoming));
  const confirmed = incoming.disposition?.kind === 'confirmed' ? incoming.disposition
    : existing.disposition?.kind === 'confirmed' ? existing.disposition : null;
  return {
    ...merged,
    message_id: confirmed?.server_message_id ?? incoming.message_id ?? existing.message_id,
    local_id: incoming.local_id ?? existing.local_id,
    disposition: confirmed ?? incoming.disposition ?? existing.disposition,
  };
}

/** A local ID is only a sender-compatible alias, never authority to join known server IDs. */
export function mergeHistory(earlier: readonly UiMessage[], current: readonly UiMessage[]): UiMessage[] {
  return registerMergeOutput(mergeCore(earlier, current));
}
function mergeCore(earlier: readonly UiMessage[], current: readonly UiMessage[]): UiMessage[] {
  type Group = { message: UiMessage; locals: Set<string> };
  const groups = new Set<Group>();
  const servers = new Map<string, Group>();
  const locals = new Map<string, Set<Group>>();
  const key = (gid: string, id: string): string => JSON.stringify([gid, id]);
  function detach(group: Group): void {
    groups.delete(group);
    if (group.message.message_id) servers.delete(key(group.message.gid, group.message.message_id));
    for (const id of group.locals) {
      const idKey = key(group.message.gid, id), entries = locals.get(idKey);
      entries?.delete(group);
      if (entries?.size === 0) locals.delete(idKey);
    }
  }
  for (const message of [...earlier, ...current]) {
    const exact = message.message_id ? servers.get(key(message.gid, message.message_id)) : undefined;
    let merged = exact ? mergeMessageRecord(exact.message, message) : message;
    // An identity correction for the same server record must shed its old sender's aliases.
    const aliases = exact && compatibleMessageSender(exact.message, message) ? new Set(exact.locals) : new Set<string>();
    if (message.local_id) aliases.add(message.local_id);
    const candidates = new Set<Group>();
    for (const id of aliases) for (const group of locals.get(key(message.gid, id)) ?? []) {
      if (group !== exact && compatibleLocalAlias(group.message, merged)) candidates.add(group);
    }
    // A sparse row must not arbitrarily choose between two known identities or server IDs.
    const serverIds = new Set([merged.message_id, ...[...candidates].map(group => group.message.message_id)].filter(Boolean));
    const senderIds = new Set([merged, ...[...candidates].map(group => group.message)].map(row => row.sender_id?.trim().toLowerCase()).filter(Boolean));
    if (serverIds.size > 1 || senderIds.size > 1) candidates.clear();
    if (exact) detach(exact);
    for (const group of candidates) {
      // Re-check against the aggregate: a previous bridge may have added a known identity.
      if (!compatibleLocalAlias(group.message, merged)) continue;
      merged = mergeMessageRecord(group.message, merged);
      for (const id of group.locals) aliases.add(id);
      detach(group);
    }
    const group: Group = { message: merged, locals: aliases };
    groups.add(group);
    if (merged.message_id) servers.set(key(merged.gid, merged.message_id), group);
    for (const id of aliases) {
      const idKey = key(merged.gid, id), entries = locals.get(idKey) ?? new Set<Group>();
      entries.add(group); locals.set(idKey, entries);
    }
  }
  return [...groups].map(group => group.message).sort((a, b) => a.create_time_ms - b.create_time_ms);
}

// ---- incremental single-message path (I-28b)
// If merging a list with nothing changes it (a fixpoint), a message that touches no existing identity
// is just a stable-sort append: insert after every row with create_time_ms <= its own, and the result
// is again a fixpoint. mergeHistory output is a fixpoint for coherent data but not for every adversarial
// mix of conflicting senders/aliases, so each full-merge result is verified once (one extra merge) and
// unverified or failing lists keep the full path. Exact server matches, local aliases and odd
// timestamps always take the full path.
interface MergeIndex { list: readonly UiMessage[]; servers: Set<string>; locals: Set<string>; /** Every row has a finite time, so the binary search agrees with the full sort. */ finite: boolean }
const mergeOutputs = new WeakSet<readonly UiMessage[]>();
const fixpoints = new WeakSet<readonly UiMessage[]>();
const mergeIndexes = new WeakMap<readonly UiMessage[], MergeIndex>();
const identityKey = (gid: string, id: string): string => `${gid}\u0000${id}`;
function registerMergeOutput(list: UiMessage[]): UiMessage[] { mergeOutputs.add(list); return list; }
function mergeIndexOf(list: readonly UiMessage[]): MergeIndex {
  const cached = mergeIndexes.get(list);
  if (cached?.list === list) return cached;
  const index: MergeIndex = { list, servers: new Set(), locals: new Set(), finite: true };
  for (const row of list) {
    if (row.message_id) index.servers.add(identityKey(row.gid, row.message_id));
    if (row.local_id) index.locals.add(identityKey(row.gid, row.local_id));
    if (!Number.isFinite(row.create_time_ms)) index.finite = false;
  }
  mergeIndexes.set(list, index);
  return index;
}
/** Same result as `mergeHistory(list, [message])`, in O(log n) lookup plus one array copy when `message` is new. */
export function mergeHistoryIncremental(list: readonly UiMessage[], message: UiMessage): UiMessage[] {
  if (!mergeOutputs.has(list) || !Number.isFinite(message.create_time_ms)) return mergeHistory(list, [message]);
  if (!fixpoints.has(list)) {
    const again = mergeCore(list, []);
    if (again.length !== list.length || again.some((row, i) => row !== list[i])) { mergeOutputs.delete(list); return mergeHistory(list, [message]); }
    fixpoints.add(list);
  }
  const index = mergeIndexOf(list);
  // A NaN time in the list makes the full sort order depend on arrival order; only the full path reproduces it.
  if (!index.finite || (message.message_id && index.servers.has(identityKey(message.gid, message.message_id))) || (message.local_id && index.locals.has(identityKey(message.gid, message.local_id)))) return mergeHistory(list, [message]);
  let lo = 0, hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid]!.create_time_ms <= message.create_time_ms) lo = mid + 1; else hi = mid;
  }
  const next = registerMergeOutput([...list.slice(0, lo), message, ...list.slice(lo)]);
  fixpoints.add(next);
  // Hand the index to the new list; the old list rebuilds lazily if anyone asks again.
  if (message.message_id) index.servers.add(identityKey(message.gid, message.message_id));
  if (message.local_id) index.locals.add(identityKey(message.gid, message.local_id));
  index.list = next;
  mergeIndexes.set(next, index);
  mergeIndexes.delete(list);
  return next;
}

/** DOM anchor identities carry both IDs so server confirmation can enrich a local row. */
export function historyScopeKey(account: AccountContext | null, gid: string): string {
  return account ? JSON.stringify([account.environment, account.account_id, account.session_generation, gid]) : '';
}
export function messageHistoryKey(account: AccountContext | null, conv: Pick<UiConversation, 'gid' | 'account'>, message: UiMessage): string {
  const id = message.message_id ?? message.local_id;
  if (!account || !id || message.gid !== conv.gid || !sameAccount(account, conv.account) || account.session_generation !== conv.account.session_generation) return '';
  return historyKeyString(historyKeyOf(historyScopeKey(account, conv.gid), message));
}

/** Sparse enrichment is compatible; explicit sender or server conflicts are never aliases. */
export function messageHistoryMatches(before: string, after: string): boolean {
  return historyKeysMatch(parseHistoryKey(before), parseHistoryKey(after));
}

/** Recall notices remain visible while their original content stays hidden across pages. */
export function visibleMessages(messages: readonly UiMessage[]): UiMessage[] {
  const recalled = new Set(messages.map(m => (m as QuotedUiMessage).recalled_message_id).filter(Boolean));
  return messages.filter(m => !m.message_id || !recalled.has(m.message_id));
}


/** A transport acceptance is never presented as an independently confirmed action. */
export function peripheralWriteView(result: import('../../packages/ipc/src/client.ts').UiPeripheralWrite): { title: string; message: string; confirmed: boolean } {
  if (result.kind === 'confirmed' && result.confirmed === true) return { title: '已确认', message: '已通过独立读回确认本次操作。', confirmed: true };
  if (result.kind === 'accepted') return { title: '已受理，待核验', message: '服务端已受理操作。可刷新成员和会话核对结果，请勿重复提交。', confirmed: false };
  return { title: '结果未知，待核验', message: '操作可能已经生效。仅可只读刷新成员和会话，不会重新发送操作。', confirmed: false };
}

/** UI-only provenance: a target chosen from the current thread, never a copied body. */
export type QuotedUiMessage = UiMessage & { readonly quote_target_id?: string | null; readonly recalled_message_id?: string | null };
export const QUOTE_UNAVAILABLE = '引用内容不可用';
export const QUOTE_RECALLED = '引用消息已撤回';

function quoteWasRecalled(thread: readonly UiMessage[], gid: string, targetId: string): boolean {
  return thread.some((message) => message.gid === gid && (message as QuotedUiMessage).recalled_message_id === targetId);
}

/** A stale selected object is not authority: resolve its server ID in the current thread. */
export function selectedQuoteReference(selected: UiMessage | null, thread: readonly UiMessage[], gid: string): { readonly target_id: string; readonly text: string } | null {
  const targetId = selected?.message_id;
  if (!selected || selected.gid !== gid || !targetId || quoteWasRecalled(thread, gid, targetId)) return null;
  const target = thread.find((message) => message.gid === gid && message.message_id === targetId);
  return target && target.kind !== 'system' ? { target_id: targetId, text: target.text } : null;
}

/** Legacy quote mixes free text and IDs. Without explicit provenance, show no raw string. */
export function messageQuotePreview(message: UiMessage, thread: readonly UiMessage[]): string | null {
  const targetId = (message as QuotedUiMessage).quote_target_id;
  if (!targetId) return message.quote ? QUOTE_UNAVAILABLE : null;
  if (quoteWasRecalled(thread, message.gid, targetId)) return QUOTE_RECALLED;
  const target = thread.find((candidate) => candidate.gid === message.gid && candidate.message_id === targetId);
  return target && target.kind !== 'system' ? target.text : QUOTE_UNAVAILABLE;
}

/** Preserve a verified local target through sparse echoes, without guessing from free text. */
export function mergeQuoteReference(existing: UiMessage, incoming: UiMessage): UiMessage {
  const previous = (existing as QuotedUiMessage).quote_target_id;
  const current = (incoming as QuotedUiMessage).quote_target_id;
  const oldSender = existing.sender_id?.trim().toLowerCase();
  const newSender = incoming.sender_id?.trim().toLowerCase();
  if (existing.sender_role !== incoming.sender_role || (oldSender && newSender && oldSender !== newSender)) return incoming;
  if (current || !previous || (incoming.quote !== null && incoming.quote !== previous)) return incoming;
  const merged: QuotedUiMessage = { ...incoming, quote: previous, quote_target_id: previous };
  return merged;
}

/** Fixed-height list window: overscan keeps scrolling smooth with bounded DOM size. */
export function virtualConversationRange(total: number, top: number, height: number): { start: number; end: number } {
  const visible = Math.max(1, Math.ceil(Math.max(0, height) / 96));
  const first = Math.min(Math.max(0, Math.floor(top / 96)), Math.max(0, total - visible));
  return { start: Math.max(0, first - 6), end: Math.min(total, first + visible + 6) };
}
