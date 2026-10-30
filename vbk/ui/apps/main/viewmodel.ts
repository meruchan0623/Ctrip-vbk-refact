/**
 * Pure view-model logic for the main window (no DOM): conversation list
 * sorting/filtering, context-menu command payloads, outbound send state,
 * order-contact state machine, status-bar derivations.
 */

import type { AccountContext, AppError, SendDisposition } from '../../packages/ipc/src/contracts.ts';
import { ErrorCodes, isAppError } from '../../packages/ipc/src/contracts.ts';
import type { AgentStatus, MarkAction, OrderSearchResult, UiAccount, UiAgentStatus, UiConversation, UiMessage, UiNetStatus, UiOrderSummary } from '../../packages/ipc/src/client.ts';
import { UiCommands } from '../../packages/ipc/src/client.ts';
import { AccountCommands } from '../../packages/ipc/src/commands.ts';
import { t } from '../../packages/ui-kit/src/i18n.ts';
import type { I18nKey } from '../../packages/ui-kit/src/i18n.ts';

// ------------------------------------------------------------ conversations

export type ListTab = 'doing' | 'done';

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

export function tabCounts(list: readonly UiConversation[]): { doing: number; done: number } {
  let doing = 0;
  let done = 0;
  for (const c of list) {
    if (isDone(c)) done += 1;
    else doing += 1;
  }
  return { doing, done };
}

export function matchesQuery(c: UiConversation, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (c.title.toLowerCase().includes(q)) return true;
  if (c.preview.toLowerCase().includes(q)) return true;
  if (c.order && c.order.order_id.includes(q)) return true;
  return false;
}

export function filterConversations(list: readonly UiConversation[], tab: ListTab, query: string): UiConversation[] {
  return sortConversations(list.filter((c) => (tab === 'done' ? isDone(c) : !isDone(c)) && matchesQuery(c, query)));
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

export function shouldShowTranslationBar(conv: UiConversation | null, assistantEnabled: boolean, outboundEnabled: boolean): boolean {
  return !!conv && !isDone(conv) && conv.lang !== 'zh' && assistantEnabled && outboundEnabled;
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

export function safeMediaUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}
