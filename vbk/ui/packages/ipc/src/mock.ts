/**
 * Deterministic in-browser mock of the host IPC. Used when `window.__TAURI__`
 * is absent (plain browser, smoke tests) and by view-model tests.
 *
 * Demo data mirrors the prototype's sample data (docs/design/prototype/02-main,
 * all fictional: 云游·小王, Emma Wilson, 订单 3051228766 …). Command handlers
 * enforce the same contracts as the Rust core: round version must match for
 * hide/snooze, stale generations are rejected, T1 must be an allowed value,
 * and a timed-out order query is reported as unknown and never replayed.
 */

import type {
  AccountContext,
  AlarmEntry,
  AlarmSnapshot,
  AppError,
  ClockReading,
  ReminderSettings,
  SendDisposition,
  SnoozeMinutes,
} from './contracts.ts';
import { ALLOWED_T1_SECONDS, DEFAULT_REMINDER_SETTINGS, ErrorCodes, isStaleGeneration } from './contracts.ts';
import { AccountCommands, Events, NotifyCommands, PrefsCommands, OrderCommands, ImCommands } from './commands.ts';
import type {
  IpcClient,
  MarkAction,
  OrderSearchResult,
  PrefsSnapshot,
  UiAccount,
  UiAccountSnapshot,
  UiAgentStatus,
  UiConversation,
  UiMessage,
  UiNetStatus,
  UiNotice,
  UiNoticeCategory,
  UiOrderSummary,
  UiPackageInfo,
  UiTsimStatus,
} from './client.ts';
import { UiCommands, UiEvents } from './client.ts';

/** `no-accounts`: first start, nothing logged in (main window shows the welcome state). */
export type MockScenario = 'default' | 'empty' | 'offline' | 'clock-untrusted' | 'reconciling' | 'no-accounts';

export interface MockOptions {
  /** Emit `Events.ALARM_SNAPSHOT` every second (default true in browsers, false in tests). */
  readonly tick?: boolean;
  /** Simulated latency in ms for commands (default 120; tests use 0). */
  readonly latency?: number;
  readonly now?: () => number;
}

export interface MockIpc extends IpcClient {
  emit(event: string, payload: unknown): void;
  dispose(): void;
  /** Test hook: advance the alarm clock and emit a snapshot. */
  tick(seconds?: number): void;
  readonly scenario: MockScenario;
}

function appError(code: string, message: string, retryable = false): AppError {
  return { code, message, retryable };
}

function delay(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((r) => setTimeout(r, ms));
}

const ACCOUNT_A: AccountContext = { account_id: 'acc-demo-a', environment: 'production', session_generation: 3 };
const ACCOUNT_B: AccountContext = { account_id: 'acc-demo-b', environment: 'production', session_generation: 1 };
const ACCOUNT_C: AccountContext = { account_id: 'acc-demo-c', environment: 'production', session_generation: 2 };

interface MockState {
  accounts: UiAccount[];
  active: string | null;
  agent: UiAgentStatus;
  net: UiNetStatus;
  clock: ClockReading;
  prefs: PrefsSnapshot;
  conversations: Map<string, UiConversation>;
  messages: Map<string, UiMessage[]>;
  noticeCats: UiNoticeCategory[];
  notices: UiNotice[];
  alarmEntries: AlarmEntry[];
  reconciling: boolean;
  clockTrusted: boolean;
  tsim: UiTsimStatus;
  pkgCache: Map<string, UiPackageInfo>;
  loginCounter: number;
  /** attempt_id → account id of the `logging_in` placeholder (host: login window per attempt). */
  attempts: Map<string, string>;
}

/**
 * Demo orders mirror the prototype (02-main `ORDERS`). Special ids drive the
 * order-contact states: 2287450193 → multiple, 3050000403 → forbidden,
 * 3051000408 → timeout (unknown, never replayed), anything else unknown → none.
 */
const ORDERS: Record<string, UiOrderSummary> = {
  '3051228766': { order_id: '3051228766', product: '东京+富士山5日4晚跟团游', use_date: '2026-11-18', quantity: '2成人1儿童', status: '已确认', contact: 'Emma Wilson' },
  '2287450193': { order_id: '2287450193', product: '上海迪士尼乐园1日票', use_date: '2026-11-02', quantity: '2人', status: '待出行', contact: '陈女士' },
  '2287450195': { order_id: '2287450195', product: '上海迪士尼乐园1日票', use_date: '2026-11-03', quantity: '1人', status: '待出行', contact: '陈女士' },
  '3051188420': { order_id: '3051188420', product: '上海外滩茂悦大酒店 · 豪华江景大床房', use_date: '2026-11-05', quantity: '1间2晚', status: '待确认', contact: '李先生' },
  '3051410025': { order_id: '3051410025', product: '张家界3日游 · 长沙出发', use_date: '2026-10-26', quantity: '2成人', status: '已出行', contact: '刘先生' },
  '3051466120': { order_id: '3051466120', product: '日本 Docomo 原生 5G eSIM | 本地IP | 1-45天 | QR Code-30天-5G网络-总量30GB', use_date: '2026/10/29', quantity: '1份', status: '待使用', contact: '佐藤 健' },
  '3051422190': { order_id: '3051422190', product: '首尔明洞酒店3晚+仁川机场接机', use_date: '2026-12-01', quantity: '2成人', status: '待确认', contact: 'Kim Minji' },
  '3050076621': { order_id: '3050076621', product: '三亚亚特兰蒂斯4晚自由行', use_date: '2026-11-21', quantity: '2成人', status: '退改中', contact: '周女士' },
  '2287611874': { order_id: '2287611874', product: '大阪环球影城1日门票（含快速通）', use_date: '2026-11-12', quantity: '3人', status: '待出行', contact: 'Tom Becker' },
  '3051301457': { order_id: '3051301457', product: '北海道6日5晚私家团 · 温泉酒店', use_date: '2026-12-06', quantity: '4成人', status: '待确认', contact: '赵女士' },
};

/** Sample order ids for the browser demo (order-contact page chips). */
export const MOCK_ORDER_SAMPLES: readonly { readonly id: string; readonly label: string }[] = [
  { id: '3051466120', label: '佐藤 健 · eSIM（已有会话）' },
  { id: '3051301457', label: '赵女士 · 北海道私家团（将新建会话）' },
  { id: '2287450193', label: '陈女士 · 多个匹配' },
  { id: '3050000403', label: '无权查看' },
  { id: '3051999999', label: '不存在的订单' },
  { id: '3051000408', label: '查询超时' },
];

function seedConversations(now: number): UiConversation[] {
  const M = 60_000;
  const base = (account: AccountContext, gid: string, title: string, color: string, extra: Partial<UiConversation>): UiConversation => ({
    account,
    gid,
    status: 'active',
    agent_in_group: true,
    is_owner: true,
    service_type: 'BC',
    last_message_time_ms: now - 5 * M,
    last_update_time_ms: now - 5 * M,
    unread_count: 0,
    is_full_snapshot: true,
    title,
    color,
    lang: 'zh',
    biz: '门票',
    preview: '',
    draft: '',
    is_top: false,
    mark: 0,
    waiting_since_ms: null,
    waiting_confirmed: true,
    customer_tags: [],
    order: null,
    ...extra,
  });
  const A = ACCOUNT_A;
  return [
    base(A, 'g-demo-1', 'Emma Wilson', '#3E6DB5', { lang: 'en', biz: '跟团游', unread_count: 1, is_top: true, preview: 'Great. My daughter is 5 — can we get a child seat on the coach? Order 3051228766.', last_message_time_ms: now - 16_000, last_update_time_ms: now - 16_000, waiting_since_ms: now - 16_000, customer_tags: ['海外 App', '海外客户', '亲子出行'], order: ORDERS['3051228766'] ?? null }),
    base(A, 'g-demo-2', '佐藤 健', '#2C7F8F', { lang: 'ja', biz: '玩乐 eSIM', unread_count: 1, preview: '注文したSIMカードがまだ使えません。ICCIDは 8981100022334455667 です。', last_message_time_ms: now - 30_000, last_update_time_ms: now - 30_000, waiting_since_ms: now - 30_000, customer_tags: ['海外 App', '海外客户'], order: ORDERS['3051466120'] ?? null }),
    base(A, 'g-demo-3', '陈女士', '#8A4FA3', { biz: '门票', mark: 1, preview: '好的，谢谢', last_message_time_ms: now - 40 * M, last_update_time_ms: now - 40 * M, customer_tags: ['App', '回头客'], order: ORDERS['2287450193'] ?? null }),
    base(A, 'g-demo-4', 'Kim Minji', '#A8743E', { lang: 'ko', biz: '酒店+接送', preview: '감사합니다. 확인 후 바로 안내해 드리겠습니다.', draft: '您好，接机服务需要提前', last_message_time_ms: now - 24 * M, last_update_time_ms: now - 24 * M, waiting_since_ms: now - 33_000, waiting_confirmed: false, customer_tags: ['海外 App', '海外客户'], order: ORDERS['3051422190'] ?? null }),
    base(A, 'g-demo-5', '刘先生', '#5A5AA8', { status: 'finished', biz: '跟团游', preview: '会话已结束 · 已向客户发送服务评价', last_message_time_ms: now - 26 * 60 * M, last_update_time_ms: now - 26 * 60 * M, order: ORDERS['3051410025'] ?? null }),
    base(A, 'g-demo-7', '李先生', '#B5543E', { biz: '酒店', mark: 3, preview: '我：已为您备注加床，酒店确认后会短信通知您。', last_message_time_ms: now - 66 * M, last_update_time_ms: now - 66 * M, customer_tags: ['网页', '商旅'], order: ORDERS['3051188420'] ?? null }),
    base(ACCOUNT_B, 'g-demo-b1', '周女士', '#2F8A7A', { biz: '自由行', unread_count: 2, preview: '着急，麻烦尽快回复', last_message_time_ms: now - 9_000, last_update_time_ms: now - 9_000, waiting_since_ms: now - 70_000, customer_tags: ['App', '亲子出行'], order: ORDERS['3050076621'] ?? null }),
    base(ACCOUNT_B, 'g-demo-b2', 'Tom Becker', '#3E6DB5', { lang: 'en', biz: '门票', unread_count: 1, preview: 'Can the Express Pass be used for any ride?', last_message_time_ms: now - 30 * M, last_update_time_ms: now - 30 * M, customer_tags: ['海外 App', '海外客户'], order: ORDERS['2287611874'] ?? null }),
  ];
}

function seedMessages(now: number): Map<string, UiMessage[]> {
  const M = 60_000;
  let n = 0;
  const msg = (gid: string, role: UiMessage['sender_role'], text: string, ago: number, extra: Partial<UiMessage> = {}): UiMessage => {
    n += 1;
    return {
      gid,
      message_id: `m-demo-${n}`,
      local_id: null,
      create_time_ms: now - ago,
      sender_role: role,
      kind: 'text',
      text,
      translation: null,
      original: null,
      quote: null,
      order_id: null,
      disposition: role === 'merchant_self' ? { kind: 'confirmed', server_message_id: `m-demo-${n}`, server_time_ms: now - ago } : null,
      ...extra,
    };
  };
  const out = new Map<string, UiMessage[]>();
  out.set('g-demo-1', [
    msg('g-demo-1', 'system', '客户从「东京+富士山5日4晚跟团游」详情页发起咨询', 9 * M, { kind: 'system' }),
    msg('g-demo-1', 'customer', 'Hi, I booked the Tokyo + Mt. Fuji 5-day tour for Nov 18. Is the hotel close to a subway station?', 8 * M, { translation: '你好，我预订了 11 月 18 日的东京+富士山 5 日游。酒店离地铁站近吗？' }),
    msg('g-demo-1', 'customer', '东京+富士山5日4晚跟团游', 8 * M - 5000, { kind: 'order_card', order_id: '3051228766' }),
    msg('g-demo-1', 'merchant_self', 'Hello Emma! The hotel in Shinjuku is a 4-minute walk from Shinjuku-sanchome Station.', 6 * M, { original: '您好 Emma！新宿的酒店步行 4 分钟即可到达新宿三丁目站。' }),
    msg('g-demo-1', 'customer', 'Great. My daughter is 5 — can we get a child seat on the coach? Order 3051228766.', 16_000, { translation: '太好了。我女儿 5 岁——大巴上能提供儿童座椅吗？订单 3051228766。' }),
  ]);
  out.set('g-demo-2', [
    msg('g-demo-2', 'customer', '注文したSIMカードがまだ使えません。ICCIDは 8981100022334455667 です。', 30_000, { translation: '我订购的 SIM 卡还不能用。ICCID 是 8981100022334455667。' }),
  ]);
  out.set('g-demo-3', [
    msg('g-demo-3', 'customer', '你好，我买了11月2日的迪士尼门票，可以改到11月3日吗？', 42 * M),
    msg('g-demo-3', 'merchant_self', '您好，门票支持在出行前一天18:00前免费改期一次，我这边帮您操作。', 41 * M),
    msg('g-demo-3', 'customer', '好的，谢谢', 40 * M),
  ]);
  out.set('g-demo-4', [
    msg('g-demo-4', 'robot', '您好，客服正在为您转接，请稍候。', 26 * M),
    msg('g-demo-4', 'customer', '12월 1일 인천공항 도착인데 픽업은 어디서 만나나요?', 25 * M, { translation: '我 12 月 1 日到仁川机场，接机在哪里碰面？' }),
    msg('g-demo-4', 'merchant_self', '감사합니다. 확인 후 바로 안내해 드리겠습니다.', 24 * M, { original: '谢谢，确认后马上告诉您。' }),
  ]);
  out.set('g-demo-5', [
    msg('g-demo-5', 'customer', '明天早上几点集合？', 26 * 60 * M),
    msg('g-demo-5', 'merchant_self', '明早7:30在长沙火车站南广场集合，导游会举蓝色旗子。', 26 * 60 * M - 60_000),
    msg('g-demo-5', 'customer', '好的知道了', 26 * 60 * M - 120_000),
    msg('g-demo-5', 'system', '会话已结束 · 已向客户发送服务评价', 26 * 60 * M - 180_000, { kind: 'system' }),
  ]);
  out.set('g-demo-7', [
    msg('g-demo-7', 'customer', '上海外滩茂悦大酒店', 75 * M, { kind: 'order_card', order_id: '3051188420' }),
    msg('g-demo-7', 'customer', '我订的外滩茂悦能不能加一张床？', 74 * M),
    msg('g-demo-7', 'customer', '预订确认单.png', 74 * M - 9000, { kind: 'image' }),
    msg('g-demo-7', 'merchant_self', '李先生您好，豪华江景房可加床，费用¥380/晚，需要的话我帮您备注。', 70 * M),
    msg('g-demo-7', 'customer', '那加一张吧', 68 * M),
    msg('g-demo-7', 'merchant_self', '已为您备注加床，酒店确认后会短信通知您。', 66 * M),
    // send outcomes that are not confirmed: unknown is never resent automatically, rejected offers a manual resend
    msg('g-demo-7', 'merchant_self', '加床费用可以一起开发票。', 65 * M, { disposition: { kind: 'unknown' } }),
    msg('g-demo-7', 'merchant_self', '发票抬头请发我一下。', 64 * M, { disposition: { kind: 'rejected', code: 'im.permission_denied', reason: '会话已转出' } }),
  ]);
  out.set('g-demo-b1', [
    msg('g-demo-b1', 'customer', '我昨天提交的退改申请有进度了吗？', 70_000),
    msg('g-demo-b1', 'customer', '着急，麻烦尽快回复', 9_000),
  ]);
  out.set('g-demo-b2', [msg('g-demo-b2', 'customer', 'Can the Express Pass be used for any ride?', 30 * M, { translation: '快速通可以用于任何项目吗？' })]);
  return out;
}

function seedNotices(now: number): { cats: UiNoticeCategory[]; items: UiNotice[] } {
  const H = 3_600_000;
  const items: UiNotice[] = [
    { id: 'nt-1', category_id: 'order', title: '新订单待确认：北海道6日5晚私家团', body: '订单 3051301457 · 4成人 · 出行 2026-12-06，请在 24 小时内确认。', time_ms: now - 1 * H, unread: true, url: 'https://vbooking.ctrip.com/ticket_order/order/detail?orderId=3051301457' },
    { id: 'nt-2', category_id: 'order', title: '订单退改申请：三亚亚特兰蒂斯4晚自由行', body: '订单 3050076621 申请退改，原因：行程变更。', time_ms: now - 3 * H, unread: true, url: 'https://vbooking.ctrip.com/ticket_order/order/detail?orderId=3050076621' },
    { id: 'nt-3', category_id: 'order', title: '订单已出行：张家界3日游', body: '订单 3051410025 已完成出行，可邀请客户点评。', time_ms: now - 26 * H, unread: true, url: 'https://vbooking.ctrip.com/ticket_order/order/detail?orderId=3051410025' },
    { id: 'nt-4', category_id: 'product', title: '产品审核通过：日本7天不限流量卡', body: '产品 P19420 已上线。', time_ms: now - 26 * H, unread: true, url: 'https://vbooking.ctrip.com/' },
    { id: 'nt-5', category_id: 'finance', title: '10 月第 4 周结算单已生成', body: '应结金额 ¥86,420.00，请在 11 月 3 日前核对。', time_ms: now - 48 * H, unread: true, url: 'https://vbooking.ctrip.com/' },
    { id: 'nt-6', category_id: 'finance', title: '保证金余额提醒', body: '当前保证金余额充足，无需操作。', time_ms: now - 96 * H, unread: true, url: 'https://vbooking.ctrip.com/' },
    { id: 'nt-7', category_id: 'system', title: '旅游商家桌面版 2.0 公测说明', body: '新版本支持多账号隔离、回复超时强提醒与本地截图 OCR。', time_ms: now - 120 * H, unread: false, url: 'https://vbooking.ctrip.com/' },
  ];
  const cats: UiNoticeCategory[] = [
    { id: 'order', name: '订单通知', unread: 0 },
    { id: 'product', name: '产品通知', unread: 0 },
    { id: 'finance', name: '财务通知', unread: 0 },
    { id: 'system', name: '系统通知', unread: 0 },
  ].map((c) => ({ ...c, unread: items.filter((i) => i.category_id === c.id && i.unread).length }));
  return { cats, items };
}

function seedAlarm(now: number): AlarmEntry[] {
  return [
    { account: ACCOUNT_A, gid: 'g-demo-2', round_id: 'r-demo-2', version: 3, label: '佐藤 健 · 玩乐 eSIM', waiting_since_ms: now - 95_000, waited_seconds: 95, level: 'L3', start_confirmed: true, snoozed_until_ms: null },
    { account: ACCOUNT_A, gid: 'g-demo-1', round_id: 'r-demo-1', version: 1, label: 'Emma Wilson · 跟团游', waiting_since_ms: now - 45_000, waited_seconds: 45, level: 'L3', start_confirmed: true, snoozed_until_ms: null },
    { account: ACCOUNT_A, gid: 'g-demo-4', round_id: 'r-demo-4', version: 2, label: 'Kim Minji · 酒店+接送', waiting_since_ms: null, waited_seconds: 33, level: 'L3', start_confirmed: false, snoozed_until_ms: null },
  ];
}

function defaultPrefs(): PrefsSnapshot {
  return {
    reminder: { ...DEFAULT_REMINDER_SETTINGS },
    general: { autostart: true, close_action: 'tray', start_hidden: false, show_msg_time: true, spell_check: true },
    display: { zoom: 100, gpu: true },
    keys: { send_key: 'enter', screenshot: 'Ctrl + Shift + X', toggle_main: 'Ctrl + Alt + V' },
    assistant: { enabled: true, outbound_translation: true, send_mode: 'replace_draft', package_quick_view: true, tsim_logged_in: true, tsim_user: 'tsim-demo' },
    dnd: { schedule_enabled: false, follow_system: true },
    network: { system_proxy: true },
    storage: { cache_days: 90, cache_mb: 236 },
    privacy: { analytics: false, crash_upload: false },
  };
}

function cloneSettings(s: ReminderSettings): ReminderSettings {
  return { ...s };
}

export function createMockIpc(scenario: MockScenario = 'default', options: MockOptions = {}): MockIpc {
  const now = options.now ?? (() => Date.now());
  const latency = options.latency ?? 120;
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const t0 = now();

  const notices = seedNotices(t0);
  const blank = scenario === 'empty' || scenario === 'no-accounts';
  const st: MockState = {
    accounts:
      scenario === 'no-accounts'
        ? []
        : [
            { context: ACCOUNT_A, nick: '云游·小王', remark: null, party: '云游国际旅行社', color: '#3D7BE0', state: 'online', unread: 2 },
            { context: ACCOUNT_B, nick: '云游·夜班组', remark: null, party: '云游国际旅行社', color: '#8A5CD6', state: scenario === 'offline' ? 'expired' : 'online', unread: 3 },
            { context: ACCOUNT_C, nick: '畅行租车·Lily', remark: null, party: '畅行汽车租赁', color: '#E07A2E', state: 'expired', unread: 0 },
          ],
    active: scenario === 'no-accounts' ? null : 'acc-demo-a',
    agent: { status: 'online', confirmed: true },
    net: scenario === 'offline' ? { online: false, transport: 'reconnecting' } : { online: true, transport: 'connected' },
    clock: { server_now_ms: t0, monotonic_ms: 0, quality: scenario === 'clock-untrusted' ? { kind: 'stale' } : { kind: 'anchored', offset_ms: 12, error_ms: 40 } },
    prefs: defaultPrefs(),
    conversations: new Map(blank ? [] : seedConversations(t0).map((c) => [c.gid, c])),
    messages: blank ? new Map() : seedMessages(t0),
    noticeCats: blank ? [] : notices.cats,
    notices: blank ? [] : notices.items,
    alarmEntries: blank ? [] : seedAlarm(t0),
    reconciling: scenario === 'reconciling' || scenario === 'offline',
    clockTrusted: scenario !== 'clock-untrusted',
    tsim: { logged_in: true, user: 'tsim-demo' },
    pkgCache: new Map(),
    loginCounter: 0,
    attempts: new Map(),
  };
  const hiddenRounds = new Set<string>();
  const timedOutQueries = new Set<string>();

  function emit(event: string, payload: unknown): void {
    const set = listeners.get(event);
    if (!set) return;
    for (const cb of Array.from(set)) cb(payload);
  }

  function checkAccount(payload: unknown): AccountContext {
    const p = payload as { account?: AccountContext } | undefined;
    const given = p?.account;
    if (!given || typeof given.account_id !== 'string') throw appError(ErrorCodes.ACCOUNT_UNKNOWN, '缺少账号上下文');
    const current = st.accounts.find((a) => a.context.account_id === given.account_id);
    if (!current) throw appError(ErrorCodes.ACCOUNT_UNKNOWN, '未知账号');
    if (isStaleGeneration(current.context, given)) throw appError(ErrorCodes.ACCOUNT_STALE_GENERATION, '账号会话代次已过期');
    return current.context;
  }

  function checkEvidenceAccount(payload: unknown): AccountContext {
    const ctx = checkAccount(payload), given = (payload as { account: AccountContext }).account;
    if (given.environment !== ctx.environment || given.session_generation !== ctx.session_generation) throw appError(ErrorCodes.ACCOUNT_STALE_GENERATION, '账号上下文不匹配');
    return ctx;
  }

  function accountSnapshot(): UiAccountSnapshot {
    return { accounts: st.accounts.map((a) => ({ ...a })), active_account_id: st.active, max_accounts: 16 };
  }

  function alarmSnapshot(): AlarmSnapshot {
    const nowMs = now();
    const entries = st.alarmEntries
      .filter((e) => !hiddenRounds.has(`${e.gid}:${e.round_id}:${e.version}`))
      .map((e) => ({ ...e }));
    return {
      generated_at_ms: nowMs,
      clock_trusted: st.clockTrusted,
      reconciling: st.reconciling,
      settings: cloneSettings(st.prefs.reminder),
      entries,
    };
  }

  function findEntry(payload: unknown): { entry: AlarmEntry; index: number } {
    checkAccount(payload);
    const p = payload as { gid?: string; round_id?: string; version?: number };
    const index = st.alarmEntries.findIndex((e) => e.gid === p.gid && e.round_id === p.round_id);
    if (index < 0) throw appError(ErrorCodes.NOTIFY_ROUND_VERSION_MISMATCH, '提醒轮次不存在或已结束');
    const entry = st.alarmEntries[index];
    if (!entry) throw appError(ErrorCodes.NOTIFY_ROUND_VERSION_MISMATCH, '提醒轮次不存在');
    if (entry.version !== p.version) throw appError(ErrorCodes.NOTIFY_ROUND_VERSION_MISMATCH, `提醒版本不匹配（当前 ${entry.version}）`);
    return { entry, index };
  }

  function pushAlarm(): void {
    emit(Events.ALARM_SNAPSHOT, alarmSnapshot());
  }

  function pushPrefs(): void {
    emit(Events.PREFS_CHANGED, structuredClone(st.prefs));
  }

  /** Conversations are isolated per account (01-shell): another account's gid is out of scope. */
  function convFor(ctx: AccountContext, gid: string): UiConversation {
    const c = st.conversations.get(gid);
    if (!c || c.account.account_id !== ctx.account_id) throw appError(ErrorCodes.IM_PERMISSION_DENIED, '会话不在当前账号范围内');
    return c;
  }

  function conversationsOf(ctx: AccountContext): UiConversation[] {
    return Array.from(st.conversations.values()).filter((c) => c.account.account_id === ctx.account_id);
  }

  function updateConv(gid: string, fn: (c: UiConversation) => UiConversation): UiConversation {
    const c = st.conversations.get(gid);
    if (!c) throw appError(ErrorCodes.IM_PERMISSION_DENIED, '会话不存在');
    const next = fn(c);
    st.conversations.set(gid, next);
    emit(Events.IM_CONVERSATION_CHANGED, next);
    return next;
  }

  const handlers: Record<string, (payload: unknown) => Promise<unknown>> = {
    // ---- account
    [AccountCommands.SNAPSHOT]: async () => accountSnapshot(),
    [AccountCommands.SWITCH]: async (p) => {
      const ctx = checkAccount(p);
      st.active = ctx.account_id;
      emit(Events.ACCOUNT_CHANGED, accountSnapshot());
      return accountSnapshot();
    },
    [AccountCommands.START_LOGIN]: async () => {
      // Host contract: returns {attempt_id}; the host opens the login window itself and publishes the
      // account through `account://changed` (a `logging_in` placeholder first, `online` after identity).
      if (st.accounts.length >= 16) throw appError('account.too_many', '最多 16 个账号');
      st.loginCounter += 1;
      const id = `acc-demo-new-${st.loginCounter}`;
      const attemptId = `attempt-demo-${st.loginCounter}`;
      const acc: UiAccount = { context: { account_id: id, environment: 'production', session_generation: 1 }, nick: `新账号·0${st.accounts.length + 1}`, remark: null, party: '云游国际旅行社', color: '#5A7FA8', state: 'logging_in', unread: 0 };
      st.accounts.push(acc);
      st.attempts.set(attemptId, id);
      emit(Events.ACCOUNT_CHANGED, accountSnapshot());
      setTimeout(() => {
        if (!st.attempts.has(attemptId)) return; // cancelled meanwhile
        st.attempts.delete(attemptId);
        st.accounts = st.accounts.map((a) => (a.context.account_id === id ? { ...a, state: 'online' } : a));
        if (st.active === null) st.active = id;
        emit(Events.ACCOUNT_CHANGED, accountSnapshot());
      }, Math.max(latency * 6, 1));
      return { attempt_id: attemptId };
    },
    [UiCommands.ACCOUNT_CANCEL_LOGIN]: async (p) => {
      const attemptId = String((p as { attempt_id?: string }).attempt_id ?? '');
      const id = st.attempts.get(attemptId);
      if (!id) throw appError('account.unknown_attempt', '登录尝试不存在或已完成');
      st.attempts.delete(attemptId);
      st.accounts = st.accounts.filter((a) => a.context.account_id !== id);
      emit(Events.ACCOUNT_CHANGED, accountSnapshot());
      return accountSnapshot();
    },
    [AccountCommands.SUSPEND]: async (p) => {
      const ctx = checkAccount(p);
      st.accounts = st.accounts.map((a) => (a.context.account_id === ctx.account_id ? { ...a, state: 'suspended', unread: 0 } : a));
      emit(Events.ACCOUNT_CHANGED, accountSnapshot());
      return accountSnapshot();
    },
    [AccountCommands.LOGOUT]: async (p) => {
      const ctx = checkAccount(p);
      st.accounts = st.accounts.map((a) => (a.context.account_id === ctx.account_id ? { ...a, state: 'expired', unread: 0, context: { ...a.context, session_generation: a.context.session_generation + 1 } } : a));
      emit(Events.ACCOUNT_CHANGED, accountSnapshot());
      return accountSnapshot();
    },
    [AccountCommands.FORGET]: async (p) => {
      const ctx = checkAccount(p);
      st.accounts = st.accounts.filter((a) => a.context.account_id !== ctx.account_id);
      if (st.active === ctx.account_id) st.active = st.accounts[0]?.context.account_id ?? null;
      emit(Events.ACCOUNT_CHANGED, accountSnapshot());
      return accountSnapshot();
    },
    [UiCommands.ACCOUNT_SET_REMARK]: async (p) => {
      const ctx = checkAccount(p);
      const remark = String((p as { remark?: string }).remark ?? '').trim();
      st.accounts = st.accounts.map((a) => (a.context.account_id === ctx.account_id ? { ...a, remark: remark || null } : a));
      emit(Events.ACCOUNT_CHANGED, accountSnapshot());
      return accountSnapshot();
    },
    [UiCommands.ACCOUNT_AGENT_STATUS]: async (p) => {
      checkAccount(p);
      return { ...st.agent };
    },
    [UiCommands.ACCOUNT_SET_AGENT_STATUS]: async (p) => {
      checkAccount(p);
      const status = (p as { status?: string }).status;
      if (status !== 'online' && status !== 'hangup' && status !== 'leaving' && status !== 'getoff') throw appError('account.bad_agent_status', '未知工作状态');
      await delay(latency * 4);
      // Only the server read-back changes the status the UI shows.
      st.agent = { status, confirmed: true };
      emit(UiEvents.AGENT_STATUS, { ...st.agent });
      return { ...st.agent };
    },
    [UiCommands.NET_STATUS]: async () => ({ ...st.net }),

    // ---- im
    [ImCommands.CONVERSATION_SNAPSHOT]: async (p) => conversationsOf(checkAccount(p)),
    [UiCommands.IM_CONVERSATIONS]: async (p) => conversationsOf(checkAccount(p)).map((c) => ({ ...c })),
    [UiCommands.IM_OUTBOUND_LOOKUP]: async (p) => {
      const ctx = checkEvidenceAccount(p), gid = String((p as { gid?: string }).gid ?? '');
      convFor(ctx, gid);
      return { items: (st.messages.get(gid) ?? []).slice(-30).map(({ gid, message_id, local_id, sender_role }) => ({ gid, message_id, local_id, sender_role })) };
    },
    [UiCommands.IM_UNKNOWN_OUTBOUND]: async (p) => { checkEvidenceAccount(p); return []; },
    [UiCommands.IM_MESSAGES]: async (p) => {
      const ctx = checkAccount(p);
      const gid = String((p as { gid?: string }).gid ?? '');
      convFor(ctx, gid);
      return (st.messages.get(gid) ?? []).map((m) => ({ ...m }));
    },
    [ImCommands.LOCATE]: async (p) => {
      const ctx = checkAccount(p);
      const gid = String((p as { gid?: string }).gid ?? '');
      convFor(ctx, gid);
      return { gid };
    },
    [UiCommands.IM_MARK_READ]: async (p) => {
      const ctx = checkAccount(p);
      const gid = String((p as { gid?: string }).gid ?? '');
      // read state only: the waiting round (waiting_since_ms) is untouched (10-im: 已读不能清掉提醒)
      convFor(ctx, gid);
      updateConv(gid, (c) => ({ ...c, unread_count: 0 }));
      return null;
    },
    [UiCommands.IM_SET_TOP]: async (p) => {
      const ctx = checkAccount(p);
      const { gid, top } = p as { gid: string; top: boolean };
      convFor(ctx, gid);
      return updateConv(gid, (c) => ({ ...c, is_top: !!top }));
    },
    [UiCommands.IM_CUSTOMER_SCRIPTS]: async (p) => {
      checkAccount(p);
      throw appError(ErrorCodes.HOST_UNSUPPORTED, '示例模式未连接官方成员与话术接口');
    },
    [UiCommands.IM_MEMBERS]: async (p) => {
      checkAccount(p);
      throw appError(ErrorCodes.HOST_UNSUPPORTED, '示例模式未连接官方成员与话术接口');
    },
    [UiCommands.IM_INVITE_CANDIDATES]: async (p) => {
      checkAccount(p);
      throw appError(ErrorCodes.HOST_UNSUPPORTED, '示例模式未连接官方成员与话术接口');
    },
    [UiCommands.IM_INVITE]: async (p) => {
      checkAccount(p);
      throw appError(ErrorCodes.HOST_UNSUPPORTED, '示例模式未连接官方成员与话术接口');
    },
    [UiCommands.IM_TRANSFER]: async (p) => {
      checkAccount(p);
      throw appError(ErrorCodes.HOST_UNSUPPORTED, '示例模式未连接官方成员与话术接口');
    },
    [UiCommands.IM_FINISH]: async (p) => {
      checkAccount(p);
      throw appError(ErrorCodes.HOST_UNSUPPORTED, '示例模式未连接官方成员与话术接口');
    },
    [UiCommands.IM_SET_MARK]: async (p) => {
      const ctx = checkAccount(p);
      const { gid, action } = p as { gid: string; action: number };
      if (!Number.isInteger(action) || action < 0 || action > 5) throw appError('im.bad_mark', 'action 必须为 0–5');
      convFor(ctx, gid);
      return updateConv(gid, (c) => ({ ...c, mark: action as MarkAction }));
    },
    [UiCommands.IM_SEND_TEXT]: async (p) => {
      const ctx = checkAccount(p);
      const { gid, local_id, text, original, quote_id } = p as { gid: string; local_id: string; text: string; original?: string; quote_id?: string };
      const conv = convFor(ctx, gid);
      if (conv.status === 'finished') throw appError(ErrorCodes.IM_PERMISSION_DENIED, '会话已结束');
      if (!st.net.online) {
        return { kind: 'unknown' } satisfies SendDisposition;
      }
      await delay(latency * 3);
      let disposition: SendDisposition;
      if (text.includes('未知')) disposition = { kind: 'unknown' };
      else if (text.includes('拒绝')) disposition = { kind: 'rejected', code: ErrorCodes.IM_PERMISSION_DENIED, reason: '示例：服务端拒绝' };
      else disposition = { kind: 'confirmed', server_message_id: `m-srv-${local_id}`, server_time_ms: now() };
      const list = st.messages.get(gid) ?? [];
      const quoted = quote_id ? list.find((m) => m.message_id === quote_id || m.local_id === quote_id) : undefined;
      const m: UiMessage = {
        gid,
        message_id: disposition.kind === 'confirmed' ? disposition.server_message_id : null,
        local_id,
        create_time_ms: now(),
        sender_role: 'merchant_self',
        kind: 'text',
        text,
        translation: null,
        original: original ?? null,
        quote: quoted ? quoted.text : null,
        order_id: null,
        disposition,
      };
      st.messages.set(gid, [...list, m]);
      if (disposition.kind === 'confirmed') {
        // a confirmed merchant reply ends the waiting round
        st.alarmEntries = st.alarmEntries.filter((e) => e.gid !== gid);
        updateConv(gid, (c) => ({ ...c, waiting_since_ms: null, preview: `我：${text}`, last_message_time_ms: m.create_time_ms }));
        pushAlarm();
      }
      emit(Events.IM_MESSAGE_NEW, m);
      return disposition;
    },

    // ---- notices
    [UiCommands.NOTICE_CATEGORIES]: async (p) => {
      checkAccount(p);
      return st.noticeCats.map((c) => ({ ...c, unread: st.notices.filter((n) => n.category_id === c.id && n.unread).length }));
    },
    [UiCommands.NOTICE_LIST]: async (p) => {
      checkAccount(p);
      const cat = String((p as { category_id?: string }).category_id ?? '');
      return st.notices.filter((n) => n.category_id === cat).map((n) => ({ ...n }));
    },
    [UiCommands.NOTICE_MARK_READ]: async (p) => {
      checkAccount(p);
      const { category_id, id } = p as { category_id: string; id: string | null };
      st.notices = st.notices.map((n) => (n.category_id === category_id && (id === null || n.id === id) ? { ...n, unread: false } : n));
      return null;
    },

    // ---- order contact
    [UiCommands.ORDER_SEARCH]: async (p) => {
      checkAccount(p);
      const id = String((p as { order_id?: string }).order_id ?? '').trim();
      await delay(latency * 2);
      if (id === '3050000403') return { kind: 'forbidden' } satisfies OrderSearchResult;
      if (id === '3051000408') {
        // timeout: the UI must report unknown and must not replay automatically
        timedOutQueries.add(id);
        throw appError(ErrorCodes.NET_TIMEOUT, '查询超时', false);
      }
      if (id === '2287450193') {
        return { kind: 'multiple', orders: [ORDERS['2287450193'], ORDERS['2287450195']].filter((o): o is UiOrderSummary => !!o) } satisfies OrderSearchResult;
      }
      const o = ORDERS[id];
      if (!o) return { kind: 'none' } satisfies OrderSearchResult;
      return { kind: 'one', order: o } satisfies OrderSearchResult;
    },
    [UiCommands.ORDER_CREATE_IM_CHAT]: async (p) => {
      // The conversation belongs to the account named in the payload, not to whichever account is active now.
      const ctx = checkAccount(p);
      const id = String((p as { order_id?: string }).order_id ?? '');
      await delay(latency * 2);
      const existing = conversationsOf(ctx).find((c) => c.order?.order_id === id);
      if (existing) return { gid: existing.gid, reused: true };
      const o = ORDERS[id];
      if (!o) throw appError(ErrorCodes.IM_PERMISSION_DENIED, '当前账号无权联系该订单客户');
      const gid = `g-demo-order-${ctx.account_id}-${id}`;
      const nowMs = now();
      const conv: UiConversation = {
        account: ctx, gid, status: 'active', agent_in_group: true, is_owner: true, service_type: 'ticket', last_message_time_ms: nowMs, last_update_time_ms: nowMs, unread_count: 0, is_full_snapshot: true,
        title: o.contact, color: '#2F6FED', lang: 'zh', biz: '订单联系', preview: '', draft: '', is_top: false, mark: 0, waiting_since_ms: null, waiting_confirmed: true, customer_tags: [], order: o,
      };
      st.conversations.set(gid, conv);
      st.messages.set(gid, [{ gid, message_id: `m-${gid}`, local_id: null, create_time_ms: nowMs, sender_role: 'system', kind: 'system', text: '通过「详情 → IM 联系」发起的会话', translation: null, original: null, quote: null, order_id: null, disposition: null }]);
      emit(Events.IM_CONVERSATION_CHANGED, conv);
      return { gid, reused: false };
    },
    [OrderCommands.VALIDATE_IM_URL]: async (p) => {
      const url = String((p as { url?: string }).url ?? '');
      return { ok: /^https:\/\/(vbooking|imvendor)\.ctrip\.com\//.test(url) };
    },

    // ---- shell / media placeholders
    [UiCommands.SHELL_OPEN_EXTERNAL]: async (p) => {
      emit(UiEvents.TOAST, { text: `（演示）已在系统浏览器打开：${String((p as { url?: string }).url ?? '')}` });
      return null;
    },
    [UiCommands.SHELL_OPEN_WEBVIEW]: async (p) => {
      checkAccount(p);
      emit(UiEvents.TOAST, { text: `（演示）已在内置网页打开：${String((p as { url?: string }).url ?? '')}` });
      return null;
    },
    [UiCommands.SHELL_OPEN_WINDOW]: async (p) => {
      emit(UiEvents.TOAST, { text: `（演示）已请求打开窗口：${String((p as { label?: string }).label ?? '')}` });
      return null;
    },
    [UiCommands.SHELL_WINDOW]: async (p) => {
      emit(UiEvents.TOAST, { text: `（演示）窗口操作：${String((p as { action?: string }).action ?? '')}` });
      return null;
    },
    [UiCommands.MEDIA_SCREENSHOT]: async () => {
      await delay(latency * 2);
      return { attachment_id: 'att-demo-shot', name: '截图 2026-10-30 23-16.png' };
    },
    [UiCommands.MEDIA_PICK]: async (p) => {
      const kind = String((p as { kind?: string }).kind ?? 'file');
      await delay(latency);
      const names: Record<string, string> = { image: '行程单.png', file: '出行须知.pdf', video: '集合点.mp4' };
      return { attachment_id: `att-demo-${kind}`, name: names[kind] ?? '附件' };
    },

    // ---- prefs
    [PrefsCommands.SNAPSHOT]: async () => structuredClone(st.prefs),
    [UiCommands.PREFS_SET]: async (p) => {
      const { section, key, value } = p as { section: string; key: string; value: unknown };
      // enabled / t1_seconds / timeout_sound are owned by the alarm core and only change through notify_set_*;
      // the remaining reminder fields (L4, position, DND, fullscreen, tray, badge) are plain prefs.
      if (section === 'reminder' && (key === 'enabled' || key === 't1_seconds' || key === 'timeout_sound')) throw appError('prefs.use_notify', '提醒设置请通过 notify_set_* 修改');
      const sec = (st.prefs as unknown as Record<string, Record<string, unknown>>)[section];
      if (!sec || !Object.prototype.hasOwnProperty.call(sec, key)) throw appError('prefs.unknown_key', `未知设置 ${section}.${key}`);
      if (typeof sec[key] !== typeof value) throw appError('prefs.bad_type', `设置 ${section}.${key} 类型错误`);
      st.prefs = { ...st.prefs, [section]: { ...sec, [key]: value } } as PrefsSnapshot;
      pushPrefs();
      if (section === 'reminder') pushAlarm(); // the alarm snapshot carries the reminder settings
      return structuredClone(st.prefs);
    },

    // ---- notify (strong alert §6)
    [NotifyCommands.SNAPSHOT]: async () => alarmSnapshot(),
    [NotifyCommands.OPEN_CONVERSATION]: async (p) => {
      const { entry } = findEntry(p);
      emit(UiEvents.TOAST, { text: `（演示）已激活主窗口并定位会话 ${entry.gid}` });
      return { gid: entry.gid };
    },
    [NotifyCommands.HIDE_ROUND]: async (p) => {
      const { entry } = findEntry(p);
      hiddenRounds.add(`${entry.gid}:${entry.round_id}:${entry.version}`);
      pushAlarm();
      return null;
    },
    [NotifyCommands.HIDE_ALL]: async (p) => {
      const seen = (p as { seen?: readonly { gid: string; round_id: string; version: number }[] }).seen ?? [];
      for (const s of seen) {
        const e = st.alarmEntries.find((x) => x.gid === s.gid && x.round_id === s.round_id && x.version === s.version);
        if (e) hiddenRounds.add(`${e.gid}:${e.round_id}:${e.version}`);
      }
      pushAlarm();
      return null;
    },
    [NotifyCommands.SNOOZE]: async (p) => {
      const { entry, index } = findEntry(p);
      const minutes = (p as { minutes?: number }).minutes;
      if (minutes !== 5 && minutes !== 10 && minutes !== 30) throw appError('notify.bad_snooze', '稍后提醒只能是 5/10/30 分钟');
      const m: SnoozeMinutes = minutes;
      st.alarmEntries[index] = { ...entry, version: entry.version + 1, snoozed_until_ms: now() + m * 60_000 };
      pushAlarm();
      return null;
    },
    [NotifyCommands.SET_ENABLED]: async (p) => {
      const enabled = !!(p as { enabled?: boolean }).enabled;
      st.prefs = { ...st.prefs, reminder: { ...st.prefs.reminder, enabled } };
      pushPrefs();
      pushAlarm();
      return null;
    },
    [NotifyCommands.SET_THRESHOLD]: async (p) => {
      const t1 = Number((p as { t1_seconds?: number }).t1_seconds);
      if (!(ALLOWED_T1_SECONDS as readonly number[]).includes(t1)) throw appError('notify.bad_threshold', `阈值只能是 ${ALLOWED_T1_SECONDS.join('/')} 秒`);
      st.prefs = { ...st.prefs, reminder: { ...st.prefs.reminder, t1_seconds: t1 } };
      pushPrefs();
      pushAlarm();
      return null;
    },
    [NotifyCommands.SET_SOUND_ENABLED]: async (p) => {
      const enabled = !!(p as { enabled?: boolean }).enabled;
      st.prefs = { ...st.prefs, reminder: { ...st.prefs.reminder, timeout_sound: enabled } };
      pushPrefs();
      return null;
    },

    // ---- assistant
    [UiCommands.ASSIST_TSIM_STATUS]: async () => ({ ...st.tsim }),
    [UiCommands.ASSIST_TSIM_LOGIN]: async (p) => {
      const { user, password } = p as { user?: string; password?: string };
      await delay(latency * 3);
      if (!user || !password) throw appError('assistant.tsim_bad_credentials', '账号或密码为空', false);
      if (password === 'wrong') throw appError('assistant.tsim_bad_credentials', '示例：账号或密码错误', false);
      st.tsim = { logged_in: true, user };
      st.prefs = { ...st.prefs, assistant: { ...st.prefs.assistant, tsim_logged_in: true, tsim_user: user } };
      pushPrefs();
      return { ...st.tsim };
    },
    [UiCommands.ASSIST_TSIM_LOGOUT]: async () => {
      st.tsim = { logged_in: false, user: null };
      st.prefs = { ...st.prefs, assistant: { ...st.prefs.assistant, tsim_logged_in: false, tsim_user: null } };
      pushPrefs();
      return { ...st.tsim };
    },
    [UiCommands.ASSIST_TRANSLATE]: async (p) => {
      checkAccount(p);
      const { text, target, draft_version } = p as { text: string; target: string; draft_version: number };
      if (!st.tsim.logged_in) throw appError('assistant.tsim_unauthenticated', '需先登录 TSim', false);
      await delay(latency * 3);
      if (text.includes('失败')) throw appError('assistant.translate_failed', '示例：TSim 翻译失败', true);
      return { draft_version, text: `[示例译文 · ${target}] ${text}` };
    },
    [UiCommands.ASSIST_PACKAGE]: async (p) => {
      const iccid = String((p as { iccid?: string }).iccid ?? '');
      const cached = st.pkgCache.get(iccid);
      if (cached && now() - cached.fetched_at_ms < 60_000) return { ...cached };
      await delay(latency * 3);
      const info: UiPackageInfo = { iccid, plan: 'Japan(Local DOCOMO) | 30 Days | 30GB | eSIM', status: '未激活', remain_pct: 100, remain: '30 GB', total: '30 GB', supplier: 'ESIM_DEMO', apn: 'apn.demo.net', fetched_at_ms: now() };
      st.pkgCache.set(iccid, info);
      return { ...info };
    },
  };

  let timer: ReturnType<typeof setInterval> | null = null;
  function tick(seconds = 1): void {
    const nowMs = now();
    st.alarmEntries = st.alarmEntries.map((e) => {
      if (e.snoozed_until_ms !== null && e.snoozed_until_ms <= nowMs) {
        return { ...e, snoozed_until_ms: null, version: e.version + 1, waited_seconds: e.waited_seconds + seconds };
      }
      const level = e.waited_seconds + seconds >= st.prefs.reminder.t1_seconds + 60 && st.prefs.reminder.continuous_l4 ? 'L4' : 'L3';
      return { ...e, waited_seconds: e.waited_seconds + seconds, level };
    });
    pushAlarm();
  }
  const wantTick = options.tick ?? typeof window !== 'undefined';
  if (wantTick) {
    timer = setInterval(() => tick(1), 1000);
    // The host pushes the current clock/alarm state to a freshly subscribed window.
    setTimeout(() => {
      emit(Events.NET_CLOCK, st.clock);
      pushAlarm();
    }, 0);
  }

  return {
    scenario,
    async invoke<T>(cmd: string, payload?: unknown): Promise<T> {
      const handler = handlers[cmd];
      if (!handler) throw appError('host.unknown_command', `未知命令 ${cmd}`);
      await delay(latency);
      return (await handler(payload ?? {})) as T;
    },
    listen<T>(event: string, cb: (payload: T) => void): () => void {
      const set = listeners.get(event) ?? new Set();
      const fn = cb as (payload: unknown) => void;
      set.add(fn);
      listeners.set(event, set);
      return () => {
        set.delete(fn);
      };
    },
    emit,
    tick,
    dispose() {
      if (timer) clearInterval(timer);
      timer = null;
      listeners.clear();
    },
  };
}

/** Shared by apps: pick the host IPC when present, otherwise the mock. */
export function scenarioFromLocation(): MockScenario {
  if (typeof location === 'undefined') return 'default';
  const s = new URLSearchParams(location.search).get('scenario');
  return s === 'empty' || s === 'offline' || s === 'clock-untrusted' || s === 'reconciling' || s === 'no-accounts' ? s : 'default';
}
