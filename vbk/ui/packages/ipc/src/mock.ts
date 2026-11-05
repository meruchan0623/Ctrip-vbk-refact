import type { UiServerSearchQuery, UiSearchHistoryRequest, ServerSearchGroup, UiServerSearchHit } from './server-search.ts';
/**
 * Deterministic in-browser mock of the host IPC. Used when `window.__TAURI__`
 * is absent (plain browser, smoke tests) and by view-model tests.
 *
 * Demo data mirrors the prototype's sample data (docs/design/prototype/02-main,
 * all fictional: 云游·小王, Emma Wilson, 订单 3051228766 …). Command handlers
 * enforce the same contracts as the Rust core: round version must match for
 * hide, stale generations are rejected, T1 must be an allowed value,
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
} from './contracts.ts';
import { ALLOWED_T1_SECONDS, DEFAULT_REMINDER_SETTINGS, ErrorCodes, isStaleGeneration, sameAccountContext } from './contracts.ts';
import { AccountCommands, Events, NoticeCommands, NotifyCommands, PrefsCommands, OrderCommands, ImCommands, ShellCommands } from './commands.ts';
import type {
  IpcClient,
  MarkAction,
  OrderSearchResult,
  PrefsSnapshot,
  UiAttachment,
  UiDraftAttachment,
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
  UiOrderPackageSummary,
  UiOrderPackagePlan,
  UiOrderReissue,
  UiPackageDetail,
  UiTsimStatus,
} from './client.ts';
import { UiCommands, UiEvents } from './client.ts';

/** `no-accounts`: first start, nothing logged in (main window shows the welcome state). */
export type MockScenario = 'default' | 'empty' | 'offline' | 'clock-untrusted' | 'reconciling' | 'no-accounts' | 'annotation';

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
  agents: Map<string, UiAgentStatus>;
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
  const base = (account: AccountContext, gid: string, title: string, color: string, extra: Partial<UiConversation>): UiConversation & { conversation_type?: string | null } => ({
    account,
    gid,
    assistant_context_revision: '00000000-0000-4000-8000-000000000001',
    status: 'active',
    agent_in_group: true,
    is_owner: true,
    conversation_type: 'B2C',
    service_type: '1513',
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
    { account: ACCOUNT_A, gid: 'g-demo-2', round_id: 'r-demo-2', version: 3, label: '佐藤 健 · 玩乐 eSIM', waiting_since_ms: now - 95_000, waited_seconds: 95, level: 'L3', start_confirmed: true, snoozed_until_ms: null, preview: '请问 eSIM 到了日本之后要怎么激活？我的手机是 iPhone 15，出发前需要先安装吗？另外流量用完以后还可以继续充值吗？麻烦尽快回复，明天一早就要出发了。' },
    { account: ACCOUNT_A, gid: 'g-demo-1', round_id: 'r-demo-1', version: 1, label: 'Emma Wilson · 跟团游', waiting_since_ms: now - 45_000, waited_seconds: 45, level: 'L3', start_confirmed: true, snoozed_until_ms: null, preview: 'Where do we meet tomorrow?' },
    { account: ACCOUNT_A, gid: 'g-demo-4', round_id: 'r-demo-4', version: 2, label: 'Kim Minji · 酒店+接送', waiting_since_ms: null, waited_seconds: 33, level: 'L3', start_confirmed: false, snoozed_until_ms: null, preview: null },
  ];
}

// Kept readable for older snapshots; no runtime consumer can apply these keys.
const UNSUPPORTED_RUNTIME_PREFS = [
  ['display', 'gpu'], ['dnd', 'follow_system'], ['storage', 'cache_days'], ['storage', 'cache_mb'],
] as const;

function defaultPrefs(): PrefsSnapshot {
  return {
    reminder: { ...DEFAULT_REMINDER_SETTINGS },
    general: { autostart: false, close_action: 'tray', start_hidden: false, show_msg_time: true, spell_check: true },
    display: { zoom: 100, gpu: true },
    keys: { send_key: 'enter', screenshot: 'Ctrl + Shift + X', toggle_main: 'Ctrl + Alt + V' },
    assistant: { enabled: true, outbound_translation: true, send_mode: 'replace_draft', package_quick_view: true, tsim_logged_in: true, tsim_user: 'tsim-demo' },
    dnd: { schedule_enabled: false, follow_system: true },
    network: { system_proxy: true },
    storage: { cache_days: 90, cache_mb: 236 },
    privacy: { analytics: false, crash_upload: false },
    notice_banner: { accounts: {} },
  };
}

function cloneSettings(s: ReminderSettings): ReminderSettings {
  return { ...s };
}

export function createMockIpc(scenario: MockScenario = 'default', options: MockOptions = {}): MockIpc {
  let mockWindowMaximized = false;
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
    agents: new Map(),
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
    tsim: { logged_in: true, user: 'tsim-demo', session_epoch: 1 },
    pkgCache: new Map(),
    loginCounter: 0,
    attempts: new Map(),
  };
  // Deliberately opt-in synthetic raster; no capture or filesystem side effect.
  const annotationPng = 'iVBORw0KGgoAAAANSUhEUgAAAIAAAABgCAYAAADVenpJAABCUElEQVR4nBTYcSjA8X/n8V+/TJLpl5wkk2SSTDInOZPMJDPJOclMMklOkpNkkkySSTLJTDInOUmSJEmSJEmSJEmSJEmSJCn38Mfjv+d/39f3j8/7D+F/+MNP+B8JIJAgggkh9A8/P38ijHAiiCSKaGI0scQRTwKJJJFMiiaVNNLJIJMsssnR5JJHPgUUUkQxJZpSyiingkqqqKZGU0sd9TTQSBPNtGhaaaOdDjrpopseTS999DPAIEMMM6IZZYxxJphkimlmNLPMMc8CiyyxzIpmlTXW2WCTLbbZ0eyyxz4HHHLEMSeaU84454JLrrjmRnPLHfc88MgTz7xoXnnjnQ8++eKbnz/8/CH8D380AAIIJIhgQgj9owEQRjgRRBJFNDGaWOKIJ4FEkkgmRZNKGulkkEkW2eRocskjnwIKKaKYEk0pZZRTQSVVVFOjqaWOehpopIlmWjSttNFOB5100U2Pppc++hlgkCGGGdGMMsY4E0wyxTQzmlnmmGeBRZZYZkWzyhrrbLDJFtvsaHbZY58DDjnimBPNKWecc8ElV1xzo7nljnseeOSJZ140r7zxzgeffPHNzx9/B/Bnvi0BBBJEMCGE/pkBEEY4EUQSRTQxmljiiCeBRJJIJkWTShrpZJBJFtnkaHLJI58CCimimBJNKWWUU0ElVVRTo6mljnoaaKSJZlo0rbTRTgeddNFNj6aXPvoZYJAhhhnRjDLGOBNMMsU0M5pZ5phngUWWWGZFs8oa62ywyRbb7Gh22WOfAw454pgTzSlnnHPBJVdcc6O55Y57HnjkiWdeNK+88c4Hn3zxzc+f/Q4gyAAIIJAgggkhNMgACCOcCCKJIpoYTSxxxJNAIkkkk6JJJY10Msgki2xyNLnkkU8BhRRRTImmlDLKqaCSKqqp0dRSRz0NNNJEMy2aVtpop4NOuuimR9NLH/0MMMgQw4xoRhljnAkmmWKaGc0sc8yzwCJLLLOiWWWNdTbYZIttdjS77LHPAYccccyJ5pQzzrngkiuuudHccsc9DzzyxDMvmlfeeOeDT7745ifodwDBBkAAgQQRTAihwQZAGOFEEEkU0cRoYokjngQSSSKZFE0qaaSTQSZZZJOjySWPfAoopIhiSjSllFFOBZVUUU2NppY66mmgkSaaadG00kY7HXTSRTc9ml766GeAQYYYZkQzyhjjTDDJFNPMaGaZY54FFllimRXNKmuss8EmW2yzo9llj30OOOSIY040p5xxzgWXXHHNjeaWO+554JEnnnnRvPLGOx988sU3P8G/A/hzAyCAQIIIJoTQPzcAwggngkiiiCZGE0sc8SSQSBLJpGhSSSOdDDLJIpscTS555FNAIUUUU6IppYxyKqikimpqNLXUUU8DjTTRTIumlTba6aCTLrrp0fTSRz8DDDLEMCOaUcYYZ4JJpphmRjPLHPMssMgSy6xoVlljnQ022WKbHc0ue+xzwCFHHHOiOeWMcy645IprbjS33HHPA4888cyL5pU33vngky+++fnz3wH8yQAIIJAgggkh9E8GQBjhRBBJFNHEaGKJI54EEkkimRRNKmmkk0EmWWSTo8klj3wKKKSIYko0pZRRTgWVVFFNjaaWOuppoJEmmmnRtNJGOx100kU3PZpe+uhngEGGGGZEM8oY40wwyRTTzGhmmWOeBRZZYpkVzSprrLPBJltss6PZZY99DjjkiGNONKeccc4Fl1xxzY3mljvueeCRJ5550bzyxjsffPLFNz9/+h1AmAEQQCBBBBNCaJiGMMKJIJIooonRxBJHPAkkkkQyKZpU0kgng0yyyCZHk0se+RRQSBHFlGhKKaOcCiqpopoaTS111NNAI00006JppY12Ouiki256NL300c8AgwwxzIhmlDHGmWCSKaaZ0cwyxzwLLLLEMiuaVdZYZ4NNtthmR7PLHvsccMgRx5xoTjnjnAsuueKaG80td9zzwCNPPPOieeWNdz745ItvfsJ+H4L/zWuAAAIJIpgQQv+bH58wwokgkiiiidHEEkc8CSSSRDIpmlTSSCeDTLLIJkeTSx75FFBIEcWUaEopo5wKKqmimhpNLXXU00AjTTTTommljXY66KSLbno0vfTRzwCDDDHMiGaUMcaZYJIpppnRzDLHPAssssQyK5pV1lhng0222GZHs8se+xxwyBHHnGhOOeOcCy654pobzS133PPAI08886J55Y13Pvjki29+/tvvACINgAACCSKYEEIjDYAwwokgkiiiidHEEkc8CSSSRDIpmlTSSCeDTLLIJkeTSx75FFBIEcWUaEopo5wKKqmimhpNLXXU00AjTTTTommljXY66KSLbno0vfTRzwCDDDHMiGaUMcaZYJIpppnRzDLHPAssssQyK5pV1lhng0222GZHs8se+xxwyBHHnGhOOeOcCy654pobzS133PPAI08886J55Y13Pvjki29+In8HEGUABBBIEMGEEBplAIQRTgSRRBFNjCaWOOJJIJEkkknRpJJGOhlkkkU2OZpc8singEKKKKZEU0oZ5VRQSRXV1GhqqaOeBhppopkWTStttNNBJ11006PppY9+BhhkiGFGNKOMMc4Ek0wxzYxmljnmWWCRJZZZ0ayyxjobbLLFNjuaXfbY54BDjjjmRHPKGedccMkV19xobrnjngceeeKZF80rb7zzwSdffPMT9TuAvzAAAggkiGBCCP0LAyCMcCKIJIpoYjSxxBFPAokkkUyKJpU00skgkyyyydHkkkc+BRRSRDElmlLKKKeCSqqopkZTSx31NNBIE820aFppo50OOumimx5NL330M8AgQwwzohlljHEmmGSKaWY0s8wxzwKLLLHMimaVNdbZYJMtttnR7LLHPgcccsQxJ5pTzjjngkuuuOZGc8sd9zzwyBPPvGheeeOdDz754pufv/gdQKwBEEAgQQQTQmisARBGOBFEEkU0MZpY4ogngUSSSCZFk0oa6WSQSRbZ5GhyySOfAgopopgSTSlllFNBJVVUU6OppY56GmikiWZaNK200U4HnXTRTY+mlz76GWCQIYYZ0YwyxjgTTDLFNDOaWeaYZ4FFllhmRbPKGutssMkW2+xodtljnwMOOeKYE80pZ5xzwSVXXHOjueWOex545IlnXjSvvPHOB5988c1P7O8A4gyAAAIJIpgQQuMMgDDCiSCSKKKJ0cQSRzwJJJJEMimaVNJIJ4NMssgmR5NLHvkUUEgRxZRoSimjnAoqqaKaGk0tddTTQCNNNNOiaaWNdjropItuejS99NHPAIMMMcyIZpQxxplgkimmmdHMMsc8CyyyxDIrmlXWWGeDTbbYZkezyx77HHDIEcecaE4545wLLrnimhvNLXfc88AjTzzzonnljXc++OSLb37ifgfwlwZAAIEEEUwIoX9pAIQRTgSRRBFNjCaWOOJJIJEkkknRpJJGOhlkkkU2OZpc8singEKKKKZEU0oZ5VRQSRXV1GhqqaOeBhppopkWTStttNNBJ11006PppY9+BhhkiGFGNKOMMc4Ek0wxzYxmljnmWWCRJZZZ0ayyxjobbLLFNjuaXfbY54BDjjjmRHPKGedccMkV19xobrnjngceeeKZF80rb7zzwSdffPPzl78DSDQAAggkiGBCCE00AMIIJ4JIoogmRhNLHPEkkEgSyaRoUkkjnQwyySKbHE0ueeRTQCFFFFOiKaWMciqopIpqajS11FFPA4000UyLppU22umgky666dH00kc/AwwyxDAjmlHGGGeCSaaYZkYzyxzzLLDIEsusaFZZY50NNtlimx3NLnvsc8AhRxxzojnljHMuuOSKa240t9xxzwOPPPHMi+aVN9754JMvvvlJ/D0EJf2E/5EAAgkimBBCk35+/kQY4UQQSRTRxGhiiSOeBBJJIpkUTSpppJNBJllkk6PJJY98CiikiGJKNKWUUU4FlVRRTY2mljrqaaCRJppp0bTSRjsddNJFNz2aXvroZ4BBhhhmRDPKGONMMMkU08xoZpljngUWWWKZFc0qa6yzwSZbbLOj2WWPfQ445IhjTjSnnHHOBZdccc2N5pY77nngkSeeedG88sY7H3zyxTc/Sb8D+CsDIIBAgggmhNC/MgDCCCeCSKKIJkYTSxzxJJBIEsmkaFJJI50MMskimxxNLnnkU0AhRRRToimljHIqqKSKamo0tdRRTwONNNFMi6aVNtrpoJMuuunR9NJHPwMMMsQwI5pRxhhngkmmmGZGM8sc8yywyBLLrGhWWWOdDTbZYpsdzS577HPAIUccc6I55YxzLrjkimtuNLfccc8DjzzxzIvmlTfe+eCTL775+avfAaQaAAEEEkQwIYSmGgBhhBNBJFFEE6OJJY54EkgkiWRSNKmkkU4GmWSRTY4mlzzyKaCQIoop0ZRSRjkVVFJFNTWaWuqop4FGmmimRdNKG+100EkX3fRoeumjnwEGGWKYEc0oY4wzwSRTTDOjmWWOeRZYZIllVjSrrLHOBptssc2OZpc99jngkCOOOdGccsY5F1xyxTU3mlvuuOeBR5545kXzyhvvfPDJF9/8pP4O4K8NgAACCSKYEEL/2gAII5wIIokimhhNLHHEk0AiSSSTokkljXQyyCSLbHI0ueSRTwGFFFFMiaaUMsqpoJIqqqnR1FJHPQ000kQzLZpW2ming0666KZH00sf/QwwyBDDjGhGGWOcCSaZYpoZzSxzzLPAIksss6JZZY11Nthki212NLvssc8BhxxxzInmlDPOueCSK6650dxyxz0PPPLE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LLHMimaVNdbZYJMtttnR7LLHPgcccsQxJ5pTzjjngkuuuOZGc8sd9zzwyBPPvGheeeOdDz754pufzt8B/IsBEEAgQQQTQui/GABhhBNBJFFEE6OJJY54EkgkiWRSNKmkkU4GmWSRTY4mlzzyKaCQIoop0ZRSRjkVVFJFNTWaWuqop4FGmmimRdNKG+100EkX3fRoeumjnwEGGWKYEc0oY4wzwSRTTDOjmWWOeRZYZIllVjSrrLHOBptssc2OZpc99jngkCOOOdGccsY5F1xyxTU3mlvuuOeBR5545kXzyhvvfPDJF9/8/MvvAHoMgAACCSKYEEJ7DIAwwokgkiiiidHEEkc8CSSSRDIpmlTSSCeDTLLIJkeTSx75FFBIEcWUaEopo5wKKqmimhpNLXXU00AjTTTTommljXY66KSLbno0vfTRzwCDDDHMiGaUMcaZYJIpppnRzDLHPAssssQyK5pV1lhng0222GZHs8se+xxwyBHHnGhOOeOcCy654pobzS133PPAI08886J55Y13Pvjki29+en4PQb0/4X8kgECCCCaE0N6fnz8RRjgRRBJFNDGaWOKIJ4FEkkgmRZNKGulkkEkW2eRocskjnwIKKaKYEk0pZZRTQSVVVFOjqaWOehpopIlmWjSttNFOB5100U2Pppc++hlgkCGGGdGMMsY4E0wyxTQzmlnmmGeBRZZYZkWzyhrrbLDJFtvsaHbZY58DDjnimBPNKWecc8ElV1xzo7nljnseeOSJZ140r7zxzgeffPHNT+/vAP7VAAggkCCCCSH0Xw2AMMKJIJIooonRxBJHPAkkkkQyKZpU0kgng0yyyCZHk0se+RRQSBHFlGhKKaOcCiqpopoaTS111NNAI00006JppY12Ouiki256NL300c8AgwwxzIhmlDHGmWCSKaaZ0cwyxzwLLLLEMiuaVdZYZ4NNtthmR7PLHvsccMgRx5xoTjnjnAsuueKaG80td9zzwCNPPPOieeWNdz745Itvfv71dwADBkAAgQQRTAihAwZAGOFEEEkU0cRoYokjngQSSSKZFE0qaaSTQSZZZJOjySWPfAoopIhiSjSllFFOBZVUUU2NppY66mmgkSaaadG00kY7HXTSRTc9ml766GeAQYYYZkQzyhjjTDDJFNPMaGaZY54FFllimRXNKmuss8EmW2yzo9llj30OOOSIY040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eeRTQCFFFFOiKaWMciqopIpqajS11FFPA4000UyLppU22umgky666dH00kc/AwwyxDAjmlHGGGeCSaaYZkYzyxzzLLDIEsusaFZZY50NNtlimx3NLnvsc8AhRxxzojnljHMuuOSKa240t9xxzwOPPPHMi+aVN9754JMvvvn5++8Arg2AAAIJIpgQQq8NgDDCiSCSKKKJ0cQSRzwJJJJEMimaVNJIJ4NMssgmR5NLHvkUUEgRxZRoSimjnAoqqaKaGk0tddTTQCNNNNOiaaWNdjropItuejS99NHPAIMMMcyIZpQxxplgkimmmdHMMsc8CyyyxDIrmlXWWGeDTbbYZkezyx77HHDIEcecaE4545wLLrnimhvNLXfc88AjTzzzonnljXc++OSLb36ufwdwYwAEEEgQwYQQemMAhBFOBJFEEU2MJpY44kkgkSSSSdGkkkY6GWSSRTY5mlzyyKeAQooopkRTShnlVFBJFdXUaGqpo54GGmmimRZNK22000EnXXTTo+mlj34GGGSIYUY0o4wxzgSTTDHNjGaWOeZZYJElllnRrLLGOhtsssU2O5pd9tjngEOOOOZEc8oZ51xwyRXX3GhuueOeBx554pkXzStvvPPBJ19883PzO4D/MwACCCSIYEII/T8DIIxwIogkimhiNLHEEU8CiSSRTIomlTTSySCTLLLJ0eSSRz4FFFJEMSWaUsoop4JKqqimRlNLHfU00EgTzbRoWmmjnQ466aKbHk0vffQzwCBDDDOiGWWMcSaYZIppZjSzzDHPAossscyKZpU11tlgky222dHsssc+BxxyxDEnmlPOOOeCS6645kZzyx33PPDIE8+8aF55450PPvnim5//+x3AvQEQQCBBBBNC6L0BEEY4EUQSRTQxmljiiCeBRJJIJkWTShrpZJBJFtnkaHLJI58CCimimBJNKWWUU0ElVVRTo6mljnoaaKSJZlo0rbTRTgeddNFNj6aXPvoZYJAhhhnRjDLGOBNMMsU0M5pZ5phngUWWWGZFs8oa62ywyRbb7Gh22WOfAw454pgTzSlnnHPBJVdcc6O55Y57HnjkiWdeNK+88c4Hn3zxzc/97wAeDIAAAgkimBBCHwyAMMKJIJIooonRxBJHPAkkkkQyKZpU0kgng0yyyCZHk0se+RRQSBHFlGhKKaOcCiqpopoaTS111NNAI00006Jp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';
  const annotationHash = '35f8acd64a74b1383cafba77f40116bea71c4d2c11f848906ea4c2438e1559e0';
  let annotationSequence = 0;
  const annotationImages = new Map<string, { attachment: UiAttachment; png: string; created: number }>();
  const durableImages = new Map<string, {attachment: UiAttachment; png: string}>();
  const draftKey = (a: AccountContext, gid: string) => JSON.stringify([a.environment,a.account_id,gid]);
  const durableDrafts = new Map<string, {gid:string;text:string;version:number;attachment_version:number;attachments:UiDraftAttachment[]}>();
  for (const c of st.conversations.values()) if(c.draft) durableDrafts.set(draftKey(c.account,c.gid),{gid:c.gid,text:c.draft,version:1,attachment_version:0,attachments:[]});
  const draftRecord = (a: AccountContext,gid:string) => durableDrafts.get(draftKey(a,gid)) ?? {gid,text:'',version:0,attachment_version:0,attachments:[]};
  function annotationImage(p: unknown) {
    const account = checkEvidenceAccount(p), args = p as {gid: string; attachment_id: string};
    const image = annotationImages.get(args.attachment_id);
    if (!image || image.attachment.owner.gid !== args.gid || !sameAccountContext(image.attachment.owner.account, account) || now() - image.created > 300000) throw appError('media.attachment_invalid', '演示图片已过期或不属于当前会话');
    return image;
  }
  function registerAnnotation(p: unknown, png: string, hash: string): UiAttachment {
    const account = checkEvidenceAccount(p), gid = (p as {gid:string}).gid; convFor(account, gid);
    const attachment: UiAttachment = { attachment_id: `annotation-${++annotationSequence}`, lease_id: `lease-${annotationSequence}`, name: '演示标注.png', kind: 'image', mime: 'image/png', size: atob(png).length, content_sha256: hash, owner: {account: {...account},gid}, supported: true };
    annotationImages.set(attachment.attachment_id, {attachment,png,created:now()});
    durableImages.set(attachment.lease_id!, {attachment,png}); return structuredClone(attachment);
  }
  let searchSequence = 0;
  const searchQueries = new Map<string, string>();
  const searchSelections = new Map<string, { account: AccountContext; queryId: string; gid: string; messageId: string | null; time: number }>();
  const productSelections = new Map<string, { account: AccountContext; gid: string; ids: readonly string[]; expires: number }>();
  const browserTabs: { tab_id: string; account_id: string; url: string; title: string; loading: boolean }[] = [];
  let browserTabSeq = 0;
  let productSequence = 0;
  const hiddenRounds = new Set<string>();
  const timedOutQueries = new Set<string>();
  const orderQueries = new Map<string, UiOrderPackageSummary>();
  let orderQueryCounter = 0;
  let openedPackage: { summary: UiOrderPackageSummary; plan: UiOrderPackagePlan } | null = null;
  function checkOrderBinding(summary: UiOrderPackageSummary): void {
    checkEvidenceAccount({ account: summary.account });
    if (st.active !== summary.account.account_id || st.accounts.find(a => a.context.account_id === summary.account.account_id)?.state !== 'online') throw appError('account.stale_generation', '当前账号范围已变化');
    const conv = convFor(summary.account, summary.gid);
    if (!st.tsim.logged_in || st.tsim.session_epoch !== summary.session_epoch || conv.order?.order_id !== summary.order_id || conv.assistant_context_revision !== summary.context_revision) throw appError('account.stale_generation', '订单或 TSim 身份已变化', false);
  }

  function emit(event: string, payload: unknown): void {
    if (event === Events.ACCOUNT_CHANGED && openedPackage) {
      try { checkOrderBinding(openedPackage.summary); } catch {
        openedPackage = null;
        emit(UiEvents.PACKAGE_DETAIL_INVALIDATED, {});
      }
    }
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
      .filter((e) => !hiddenRounds.has(JSON.stringify([e.account, e.gid, e.round_id, e.version])))
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

  const readFrontier = (gid: string) => [...(st.messages.get(gid) ?? [])].filter(m => m.sender_role === 'customer' && m.message_id).sort((a, b) => b.create_time_ms - a.create_time_ms)[0]?.message_id ?? null;

  function updateConv(gid: string, fn: (c: UiConversation) => UiConversation): UiConversation {
    const c = st.conversations.get(gid);
    if (!c) throw appError(ErrorCodes.IM_PERMISSION_DENIED, '会话不存在');
    const next = { ...fn(c), read_target_message_id: readFrontier(gid) };
    st.conversations.set(gid, next);
    emit(Events.IM_CONVERSATION_CHANGED, next);
    return next;
  }

  const savedEmojis = new Map<string, {id:string;name:string;url:string;thumbnail:string|null;created_at_ms:number;rank:number}[]>();
  const forwarded = new Map<string, SendDisposition>();
  const handlers: Record<string, (payload: unknown) => Promise<unknown>> = {
    [ImCommands.DRAFT_LOAD]: async (p) => {
      const account=checkEvidenceAccount(p);
      return {drafts:[...durableDrafts].filter(([key])=>{const [env,id]=JSON.parse(key) as string[];return env===account.environment&&id===account.account_id;}).map(([,draft])=>structuredClone(draft))};
    },
    [ImCommands.DRAFT_SAVE]: async (p) => {
      const account=checkEvidenceAccount(p),args=p as {gid:string;text:string;expected_version:number};convFor(account,args.gid);
      const row=draftRecord(account,args.gid);if(row.version!==args.expected_version)throw appError('store.cas_conflict','草稿版本已变化');
      row.text=args.text;row.version=args.text?row.version+1:0;durableDrafts.set(draftKey(account,args.gid),row);return {version:row.version};
    },
    [UiCommands.IM_DRAFT_ATTACHMENT_SAVE]: async (p) => {
      const account=checkEvidenceAccount(p),args=p as {gid:string;attachment_id:string|null;expected_version:number};convFor(account,args.gid);
      const row=draftRecord(account,args.gid);if(row.attachment_version!==args.expected_version)throw appError('store.cas_conflict','附件草稿版本已变化');
      let attachments:UiDraftAttachment[]=[];
      if(args.attachment_id!==null){const image=annotationImage(p),a=image.attachment;attachments=[{lease_id:a.lease_id!,name:a.name,kind:a.kind,mime:a.mime,size:a.size,content_sha256:a.content_sha256,state:'ready'}];}
      row.attachments=attachments;row.attachment_version++;durableDrafts.set(draftKey(account,args.gid),row);return structuredClone({attachment_version:row.attachment_version,attachments});
    },
    [UiCommands.IM_DRAFT_ATTACHMENT_RESTORE]: async (p) => {
      const account=checkEvidenceAccount(p),args=p as {gid:string;lease_id:string};convFor(account,args.gid);
      const row=draftRecord(account,args.gid),image=durableImages.get(args.lease_id);
      if(!image||!row.attachments.some(a=>a.lease_id===args.lease_id&&a.state==='ready')||image.attachment.owner.gid!==args.gid||image.attachment.owner.account.environment!==account.environment||image.attachment.owner.account.account_id!==account.account_id)throw appError('media.draft_attachment_unavailable','附件不可恢复');
      const attachment:UiAttachment={...image.attachment,attachment_id:`annotation-${++annotationSequence}`,owner:{account:{...account},gid:args.gid}};
      annotationImages.set(attachment.attachment_id,{attachment,png:image.png,created:now()});return structuredClone(attachment);
    },
    // ---- account
    [AccountCommands.SNAPSHOT]: async () => accountSnapshot(),
    [AccountCommands.BROWSER_PROFILES]: async () => [],
    [AccountCommands.BROWSER_CONNECT]: async () => { throw appError('account.browser_no_session', '演示模式没有 Chrome 登录态'); },
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
      const account = checkEvidenceAccount(p);
      return { ...(st.agents.get(JSON.stringify(account)) ?? { status: 'online', confirmed: true }) };
    },
    [UiCommands.ACCOUNT_SET_AGENT_STATUS]: async (p) => {
      const account = { ...checkEvidenceAccount(p) };
      const status = (p as { status?: string }).status;
      if (status !== 'online' && status !== 'hangup' && status !== 'leaving' && status !== 'getoff') throw appError('account.bad_agent_status', '未知工作状态');
      await delay(latency * 4);
      // Only the server read-back changes the status the UI shows.
      checkEvidenceAccount({ account });
      const agent: UiAgentStatus = { status, confirmed: true };
      st.agents.set(JSON.stringify(account), agent);
      emit(UiEvents.AGENT_STATUS, { ...agent, account });
      return { ...agent };
    },
    [UiCommands.NET_STATUS]: async () => ({ ...st.net }),

    // ---- im
    [ImCommands.CONVERSATION_SNAPSHOT]: async (p) => conversationsOf(checkAccount(p)),
    [UiCommands.IM_CONVERSATIONS]: async (p) => conversationsOf(checkAccount(p)).map((c) => ({ ...c, read_target_message_id: readFrontier(c.gid) })),
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
    // Synthetic search fixtures only. `demo` shows every group and two pages;
    // `empty`/`error` support deterministic browser empty/error acceptance.
    [UiCommands.SERVER_SEARCH]: async (p) => {
      const account = checkAccount(p), query = (p as { query: UiServerSearchQuery }).query;
      if (!query || !Number.isSafeInteger(query.search_type) || query.search_type < 0 || query.search_type > 4 || !Number.isSafeInteger(query.page_no) || query.page_no < 1) throw appError(ErrorCodes.ADAPTER_FAILED, '无效搜索条件');
      if (query.search_value === 'error') throw appError(ErrorCodes.ADAPTER_FAILED, '演示搜索失败，请重试');
      const owner = `${account.environment}/${account.account_id}/${account.session_generation}`;
      searchQueries.set(owner, query.query_id);
      const result: Record<ServerSearchGroup, UiServerSearchHit[]> = { customer: [], content: [], order: [], date: [] };
      const rows = conversationsOf(account);
      for (const [index, row] of rows.entries()) {
        const messages = st.messages.get(row.gid) ?? [], anchor = messages.at(-1);
        const matches = query.search_type === 4 ? !!anchor && anchor.create_time_ms >= (query.start_ms ?? 0) && anchor.create_time_ms <= (query.end_ms ?? 0) : query.search_value === 'demo' || `${row.title} ${row.preview} ${row.order?.order_id ?? ''}`.toLowerCase().includes((query.search_value ?? '').toLowerCase());
        if (!matches || query.search_value === 'empty') continue;
        for (const group of ['customer', 'content', 'order', 'date'] as const) {
          const token = `mock-search-${++searchSequence}`;
          searchSelections.set(token, { account, queryId: query.query_id, gid: row.gid, messageId: anchor?.message_id ?? null, time: anchor?.create_time_ms ?? row.last_message_time_ms ?? now() });
          result[group].push({ selection_token: token, gid: row.gid, title: row.title, preview: group === 'order' ? row.order?.order_id ?? '演示订单' : `${row.preview} · ${index + 1}`, message_id: anchor?.message_id ?? null, time_ms: anchor?.create_time_ms ?? now() });
        }
      }
      const total = result.customer.length, pageCount = Math.ceil(total / 2);
      if (query.search_type !== 3) for (const group of ['customer', 'content', 'order', 'date'] as const) result[group] = result[group].slice((query.page_no - 1) * 2, query.page_no * 2);
      return { query_id: query.query_id, search_type: query.search_type, page_no: query.page_no, page_count: pageCount, has_more: query.search_type !== 3 && query.page_no < pageCount, groups: result };
    },
    [UiCommands.SEARCH_HISTORY]: async (p) => {
      const account = checkAccount(p), query = (p as { query: UiSearchHistoryRequest }).query;
      const selected = searchSelections.get(query?.selection_token);
      const owner = `${account.environment}/${account.account_id}/${account.session_generation}`;
      if (!selected || !sameAccountContext(selected.account, account) || searchQueries.get(owner) !== selected.queryId || (query.direction !== 'prev' && query.direction !== 'next')) throw appError(ErrorCodes.ADAPTER_FAILED, '搜索结果已过期');
      const cursor = query.cursor_ms ?? (query.direction === 'prev' ? selected.time + 2000 : selected.time - 2000);
      const all = (st.messages.get(selected.gid) ?? []).filter(m => query.direction === 'prev' ? m.create_time_ms < cursor : m.create_time_ms > cursor);
      const items = (query.direction === 'prev' ? all.slice(-50) : all.slice(0, 50)).map(m => ({ ...m }));
      return { selection_token: query.selection_token, direction: query.direction, items, cursor_ms: items.length ? (query.direction === 'prev' ? items[0]!.create_time_ms : items.at(-1)!.create_time_ms) : null, has_more: all.length > items.length, anchor_message_id: selected.messageId };
    },
    [UiCommands.IM_MESSAGE_PAGE]: async (p) => {
      const ctx = checkAccount(p);
      const args = p as { account?: AccountContext; gid?: string; before_ms?: number };
      if (args.account?.session_generation !== ctx.session_generation || args.account?.environment !== ctx.environment) throw appError(ErrorCodes.ACCOUNT_STALE_GENERATION, 'page account scope changed');
      if (args.before_ms !== undefined && (!Number.isSafeInteger(args.before_ms) || args.before_ms < 1000000000000 || args.before_ms >= 10000000000000)) throw appError(ErrorCodes.ADAPTER_FAILED, 'invalid history cursor');
      const gid = String(args.gid ?? '');
      convFor(ctx, gid);
      const all = (st.messages.get(gid) ?? []).filter((m) => args.before_ms === undefined || m.create_time_ms < args.before_ms);
      const items = all.slice(-30).map((m) => ({ ...m }));
      const hasMore = all.length > items.length;
      return { items, has_more: hasMore, before_ms: hasMore ? items[0]?.create_time_ms ?? null : null };
    },
    [UiCommands.IM_TRANSLATE_MESSAGES]: async (p) => {
      const ctx = checkAccount(p);
      const args = p as { gid?: string; message_ids?: readonly string[] };
      const gid = String(args.gid ?? '');
      convFor(ctx, gid);
      const rows = st.messages.get(gid) ?? [];
      return { supplier: '示例', items: (args.message_ids ?? []).map((message_id) => {
        const text = rows.find((m) => m.message_id === message_id)?.text ?? '';
        // Latin/kana/hangul text gets a demo translation; Chinese already matches the target.
        return /[A-Za-z\u3040-\u30ff\uac00-\ud7af\u0400-\u04ff]/.test(text)
          ? { message_id, status: 'translated', translation: `[示例平台译文] ${text}`, source_kind: 'text' }
          : { message_id, status: 'not_needed', translation: null, source_kind: null };
      }) };
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
      const conv = convFor(ctx, gid);
      const revision = (p as { expected_context_revision?: unknown }).expected_context_revision;
      if (typeof revision !== 'string' || revision === '' || revision !== conv.assistant_context_revision) {
        throw appError(ErrorCodes.ADAPTER_FAILED, 'Read conversation context changed');
      }
      const expected = (p as { expected_message_id?: unknown }).expected_message_id;
      const latest = readFrontier(gid);
      if (typeof expected !== 'string' || expected === '' || !latest || expected !== latest) {
        throw appError(ErrorCodes.ADAPTER_FAILED, '已读目标缺失或已变化');
      }
      // Mock a confirmed receipt for the exact current customer frontier.
      updateConv(gid, c => ({ ...c, unread_count: 0 }));
      return null;
    },
    [UiCommands.IM_SET_TOP]: async (p) => {
      const ctx = checkAccount(p);
      const { gid, top } = p as { gid: string; top: boolean };
      convFor(ctx, gid);
      return updateConv(gid, (c) => ({ ...c, is_top: !!top }));
    },
    [UiCommands.IM_RECOMMEND_CITIES]: async (p) => {
      checkAccount(p);
      const query = (p as { query?: unknown }).query;
      if (typeof query !== 'string') throw appError(ErrorCodes.ADAPTER_FAILED, '无效的城市查询');
      return { items: [{ id: 2, name: '上海' }, { id: 1, name: '北京' }, { id: 17, name: '新加坡' }].filter(c => c.name.includes(query.trim())) };
    },
    [UiCommands.IM_RECOMMEND_PRODUCTS]: async (p) => {
      const account = checkAccount(p);
      const { gid, query, page_index } = p as { gid: string; query: string; page_index: number };
      convFor(account, gid);
      if (typeof query !== 'string' || !Number.isSafeInteger(page_index) || page_index < 0) throw appError(ErrorCodes.ADAPTER_FAILED, '无效的产品查询');
      const products = [
        { id: 'demo-1', name: '新加坡城市观光', image_url: '', departure_city: '上海', destination_city: '新加坡', detail_url: 'https://vacations.ctrip.com/', price_text: '¥1200', sendable: true },
        { id: 'demo-2', name: '北京周末之旅', image_url: '', departure_city: '上海', destination_city: '北京', detail_url: 'https://vacations.ctrip.com/', price_text: '¥800', sendable: true },
        { id: 'demo-3', name: '上海城市漫步', image_url: '', departure_city: '北京', destination_city: '上海', detail_url: 'https://vacations.ctrip.com/', price_text: '¥600', sendable: true },
      ].filter(item => `${item.name}${item.departure_city}${item.destination_city}${item.id}`.includes(query.trim()));
      const items = products.slice(page_index * 2, (page_index + 1) * 2);
      const token = `mock-product-${++productSequence}`;
      const expires = now() + 60000;
      productSelections.set(token, { account, gid, ids: items.map(item => item.id), expires });
      return { kind: 'ready', items, page_index, has_more: products.length > (page_index + 1) * 2, total: products.length, selection_token: token, expires_at_ms: expires };
    },
    [UiCommands.IM_SEND_PRODUCT_CARD]: async (p) => {
      const account = checkAccount(p);
      const { gid, selection_token, product_id } = p as { gid: string; selection_token: string; product_id: string };
      convFor(account, gid);
      const selected = productSelections.get(selection_token);
      if (!selected || !sameAccountContext(selected.account, account) || selected.gid !== gid || selected.expires <= now() || !selected.ids.includes(product_id)) return { kind: 'not_submitted', confirmed: false, reason: '请重新选择产品' };
      productSelections.delete(selection_token);
      return { kind: 'confirmed', confirmed: true, reason: '示例产品卡片已模拟发送' };
    },
    [UiCommands.IM_QUICK_REPLY_CATEGORIES]: async (p) => {
      checkAccount(p);
      const type = (p as { type?: unknown }).type;
      if (type !== 'VAGENT' && type !== 'VSKILLGROUP') throw appError(ErrorCodes.ADAPTER_FAILED, '无效的话术类型');
      return { categories: [{ id: type === 'VAGENT' ? '1' : '2', name: type === 'VAGENT' ? '常用回复' : '团队话术', scripts: [{ id: `${type}-1`, content: type === 'VAGENT' ? '您好，请问有什么可以帮您？' : '您的需求已收到，我们正在核实。', short_cut: 'hi', type }], sub_categories: [] }] };
    },
    [UiCommands.IM_CUSTOMER_SCRIPTS]: async (p) => {
      checkAccount(p);
      const content = (p as { content?: unknown }).content;
      if (typeof content !== 'string') throw appError(ErrorCodes.ADAPTER_FAILED, '无效的查询');
      const items = content.trim() ? [{ id: 'suggestion-0', content: '您好，请问有什么可以帮您？', short_cut: 'hi', type: 'VAGENT' }, { id: 'suggestion-1', content: '您的需求已收到，我们正在核实。', short_cut: '', type: 'VSKILLGROUP' }].filter(item => `${item.content}${item.short_cut}`.includes(content.trim())) : [];
      return { kind: items.length ? 'ready' : 'empty', raw_count: items.length, items };
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
    [UiCommands.IM_REMOVE]: async (p) => {
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
    [UiCommands.IM_COPY_MESSAGE_IMAGE]: async () => { throw appError('host.unsupported', '浏览器演示不能复制系统图片，请在桌面客户端使用'); },
    [UiCommands.IM_SAVE_MESSAGE_IMAGE]: async () => { throw appError('host.unsupported', '浏览器演示不能打开系统保存窗口，请在桌面客户端使用'); },
    [UiCommands.IM_FORWARD_MESSAGE]: async p => {
      const ctx=checkAccount(p), args=p as {source_gid:string;message_id:string;gid:string;local_id:string};
      convFor(ctx,args.source_gid); const target=convFor(ctx,args.gid);
      if(target.status!=='active') throw appError('im.invalid_send','请选择进行中的会话');
      const key=JSON.stringify([ctx.account_id,args.local_id]);
      const previous=forwarded.get(key); if(previous)return previous;
      const source=st.messages.get(args.source_gid)?.find(m=>m.message_id===args.message_id);
      if(!source)throw appError('im.invalid_send','消息不存在');
      const disposition:SendDisposition={kind:'confirmed',server_message_id:`demo-forward-${args.local_id}`,server_time_ms:now()};
      forwarded.set(key,disposition);
      const message:UiMessage={...source,gid:args.gid,message_id:disposition.server_message_id,local_id:args.local_id,create_time_ms:now(),sender_role:'merchant_self',quote:null,translation:null,original:null,disposition};
      st.messages.set(args.gid,[...(st.messages.get(args.gid)??[]),message]);emit(Events.IM_MESSAGE_NEW,{...message,account:ctx});
      return disposition;
    },
    [UiCommands.IM_SAVED_EMOJIS]:async p=>{const ctx=checkAccount(p);return savedEmojis.get(ctx.account_id)??[];},
    [UiCommands.IM_ADD_SAVED_EMOJI]:async p=>{
      const ctx=checkAccount(p),args=p as {gid:string;message_id:string};convFor(ctx,args.gid);
      const message=st.messages.get(args.gid)?.find(m=>m.message_id===args.message_id&&m.kind==='image');
      if(!message?.media_url)throw appError('im.invalid_send','图片不可用');
      const items=savedEmojis.get(ctx.account_id)??[];
      if(!items.some(e=>e.url===message.media_url))items.unshift({id:`emoji-${now()}`,name:message.media_filename||'自定义表情',url:message.media_url,thumbnail:message.media_thumbnail??null,created_at_ms:now(),rank:now()});
      savedEmojis.set(ctx.account_id,items);return [...items];
    },
    [UiCommands.IM_UPDATE_SAVED_EMOJI]:async p=>{
      const ctx=checkAccount(p),args=p as {id:string;action:string;name?:string},items=savedEmojis.get(ctx.account_id)??[],item=items.find(e=>e.id===args.id);
      if(!item)throw appError('im.invalid_send','表情不存在');
      if(args.action==='delete')items.splice(items.indexOf(item),1);
      else if(args.action==='rename')item.name=args.name||item.name;
      else if(args.action==='front'){item.rank=now();items.splice(items.indexOf(item),1);items.unshift(item);}
      return [...items];
    },
    [UiCommands.IM_SEND_SAVED_EMOJI]:async p=>{
      const ctx=checkAccount(p),args=p as {id:string;gid:string;local_id:string};convFor(ctx,args.gid);
      const item=savedEmojis.get(ctx.account_id)?.find(e=>e.id===args.id);if(!item)throw appError('im.invalid_send','表情不存在');
      const key=JSON.stringify([ctx.account_id,args.local_id]);const previous=forwarded.get(key);if(previous)return previous;
      const disposition:SendDisposition={kind:'confirmed',server_message_id:`demo-emoji-${args.local_id}`,server_time_ms:now()};forwarded.set(key,disposition);
      const message:UiMessage={gid:args.gid,message_id:disposition.server_message_id,local_id:args.local_id,create_time_ms:now(),sender_role:'merchant_self',kind:'image',text:item.url,media_url:item.url,media_thumbnail:item.thumbnail,translation:null,original:null,quote:null,order_id:null,disposition};
      st.messages.set(args.gid,[...(st.messages.get(args.gid)??[]),message]);emit(Events.IM_MESSAGE_NEW,{...message,account:ctx});return disposition;
    },
    [UiCommands.IM_SEND_TEXT]: async (p) => {
      const ctx = checkAccount(p);
      const { gid, local_id, text, original, quote_id } = p as { gid: string; local_id: string; text: string; original?: string; quote_id?: string };
      const conv = convFor(ctx, gid);
      if (conv.status === 'transferred_out') throw appError(ErrorCodes.IM_PERMISSION_DENIED, '会话已转出');
      if (!st.net.online) {
        return { kind: 'unknown' } satisfies SendDisposition;
      }
      await delay(latency * 3);
      // 已结束会话：真实适配器先 startChatB2C 重开再提交（evidence 49），演示直接置为处理中。
      if (conv.status === 'finished') updateConv(gid, (c) => ({ ...c, status: 'active' }));
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
      const before = (p as { before_ms?: number | null }).before_ms ?? 0;
      return st.notices.filter((n) => n.category_id === cat && (!before || n.time_ms < before))
        .sort((a, b) => b.time_ms - a.time_ms).slice(0, 100).map((n) => ({ ...n }));
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
      const conv: UiConversation & { conversation_type: string } = {
        account: ctx, gid, conversation_type: 'B2C', status: 'active', agent_in_group: true, is_owner: true, service_type: '1513', last_message_time_ms: nowMs, last_update_time_ms: nowMs, unread_count: 0, is_full_snapshot: true,
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
    [UiCommands.WEBVIEW_RECOVERY_STATUS]: async () => [],
    [UiCommands.WEBVIEW_RECOVERY_RETRY]: async () => { throw appError('host.unsupported', '没有待恢复的视图'); },
    [ShellCommands.EXPORT_DIAGNOSTICS]: async () => false,
    [ShellCommands.OPEN_DATA_DIRECTORY]: async () => {
      emit(UiEvents.TOAST, { text: '演示环境没有本机数据目录' });
      return null;
    },
    [UiCommands.SHELL_OPEN_EXTERNAL]: async (p) => {
      emit(UiEvents.TOAST, { text: `（演示）已在系统浏览器打开：${String((p as { url?: string }).url ?? '')}` });
      return null;
    },
    [UiCommands.MEDIA_VIEWER_OPEN_MESSAGE]: async (p) => {
      checkAccount(p);
      emit(UiEvents.TOAST, { text: '（演示）已在独立窗口打开附件' });
      return null;
    },
    [UiCommands.MEDIA_VIEWER_OPEN_EMOJI]: async (p) => {
      checkAccount(p);
      emit(UiEvents.TOAST, { text: '（演示）已在独立窗口打开表情' });
      return null;
    },
    [UiCommands.MEDIA_VIEWER_CURRENT]: async () => {
      const kind = new URLSearchParams(location.search).get('kind');
      if (kind === 'video') return { items: [{ kind, url: 'https://dimg04.tripcdn.com/demo/clip.mp4', name: '演示视频.mp4', thumbnail: null }], index: 0 };
      if (kind === 'file') return { items: [{ kind, url: 'https://dimg04.tripcdn.com/demo/report.pdf', name: '演示文档.pdf', thumbnail: null }], index: 0 };
      const items = [1, 2, 3, 4].map((n) => ({ kind: 'image', url: `https://dimg04.tripcdn.com/demo/photo-${n}.png`, name: `演示图片${n}.png`, thumbnail: null }));
      return kind === 'single-image' ? { items: items.slice(0, 1), index: 0 } : { items, index: 1 };
    },
    [UiCommands.MEDIA_VIEWER_OPEN_EXTERNAL]: async () => {
      emit(UiEvents.TOAST, { text: '（演示）已在系统浏览器打开附件' });
      return null;
    },
    [UiCommands.SHELL_OPEN_WEBVIEW]: async (p) => {
      checkAccount(p);
      const { account, url } = p as { account: { account_id: string }; url: string };
      const open = browserTabs.find((tab) => tab.account_id === account.account_id && tab.url === url);
      if (open) return open;
      const tab = { tab_id: `webview-${++browserTabSeq}`, account_id: account.account_id, url, title: '（演示）网页', loading: false };
      browserTabs.push(tab);
      return tab;
    },
    [UiCommands.BROWSER_SHOW]: async () => null,
    [UiCommands.BROWSER_NAV]: async () => null,
    [UiCommands.BROWSER_CLOSE]: async (p) => {
      const at = browserTabs.findIndex((tab) => tab.tab_id === (p as { tab_id?: string }).tab_id);
      if (at >= 0) browserTabs.splice(at, 1);
      return null;
    },
    [UiCommands.SHELL_OPEN_WINDOW]: async (p) => {
      emit(UiEvents.TOAST, { text: `（演示）已请求打开窗口：${String((p as { label?: string }).label ?? '')}` });
      return null;
    },
    [UiCommands.SHELL_WINDOW]: async (p) => {
      const action = String((p as { action?: string }).action ?? '');
      if (action === 'toggle_maximize') mockWindowMaximized = !mockWindowMaximized;
      if (action !== 'state') emit(UiEvents.TOAST, { text: `（演示）窗口操作：${action}` });
      return { maximized: mockWindowMaximized, focused: true };
    },
    [UiCommands.MEDIA_PICK]: async (p) => {
      const kind = String((p as { kind?: string }).kind ?? 'file');
      await delay(latency);
      const names: Record<string, string> = { image: '行程单.png', file: '出行须知.pdf' };
      return { attachment_id: `att-demo-${kind}`, name: names[kind] ?? '附件' };
    },
    [UiCommands.MEDIA_ACCEPT_DROP]: async () => null,
    [UiCommands.MEDIA_SCREENSHOT]: async (p) => {
      await delay(latency * 2);
      if (scenario === 'annotation') return registerAnnotation(p, annotationPng, annotationHash);
      throw appError(ErrorCodes.HOST_UNSUPPORTED, '演示模式不提供系统截图；请在客户端中使用。');
    },
    [UiCommands.MEDIA_ANNOTATION_SOURCE]: async (p) => {
      const image = annotationImage(p); await delay(latency); annotationImage(p);
      return {source_hash:image.attachment.content_sha256,mime:'image/png',width:128,height:96,data_base64:image.png};
    },
    [UiCommands.MEDIA_ANNOTATION_APPLY]: async (p) => {
      const source = annotationImage(p), args = p as {source_hash:string;png_base64:string;width:number;height:number;annotations:unknown[]};
      if (args.source_hash !== source.attachment.content_sha256 || args.width !== 128 || args.height !== 96 || !Array.isArray(args.annotations) || args.annotations.length > 512 || typeof args.png_base64 !== 'string' || args.png_base64.length > 13981016) throw appError('media.annotation_invalid','演示标注参数无效');
      const bytes = Uint8Array.from(atob(args.png_base64), c => c.charCodeAt(0));
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(c=>c.toString(16).padStart(2,'0')).join('');
      await delay(latency); annotationImage(p);
      return registerAnnotation(p, args.png_base64, hash);
    },
    [UiCommands.MEDIA_SAVE_ATTACHMENT]: async (p) => { annotationImage(p); return {saved:false}; },
    [UiCommands.MEDIA_SAVE_IMAGE]: async () => ({ saved: false }),
    [UiCommands.MEDIA_RELEASE]: async (p) => {
      const args = p as {attachment_id?:string};
      if (args.attachment_id && annotationImages.has(args.attachment_id)) { annotationImage(p); annotationImages.delete(args.attachment_id); }
      return null;
    },
    [UiCommands.IM_SEND_MEDIA]: async () => ({ stage: 'prepare', kind: 'not_submitted', write_started: false, disposition: null, message: null, error: 'Browser demo has no registered local attachment or official uploader' }),

    // ---- prefs
    [PrefsCommands.SNAPSHOT]: async () => structuredClone(st.prefs),
    [UiCommands.PREFS_SET]: async (p) => {
      const { section, key, value } = p as { section: string; key: string; value: unknown };
      if (UNSUPPORTED_RUNTIME_PREFS.some(([unsupportedSection, unsupportedKey]) => section === unsupportedSection && key === unsupportedKey)) throw appError('host.unsupported', 'unsupported preference runtime');
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
      const { entry } = findEntry((p as { round: unknown }).round);
      emit(UiEvents.TOAST, { text: `（演示）已激活主窗口并定位会话 ${entry.gid}` });
      return { gid: entry.gid };
    },
    [NotifyCommands.HIDE_ROUND]: async (p) => {
      const { entry } = findEntry((p as { round: unknown }).round);
      hiddenRounds.add(JSON.stringify([entry.account, entry.gid, entry.round_id, entry.version]));
      pushAlarm();
      return null;
    },
    [NotifyCommands.HIDE_ALL]: async (p) => {
      const seen = (p as { seen?: readonly { account: AccountContext; gid: string; round_id: string; version: number }[] }).seen ?? [];
      for (const s of seen) {
        const e = st.alarmEntries.find((x) => sameAccountContext(x.account, s.account) && x.gid === s.gid && x.round_id === s.round_id && x.version === s.version);
        if (e) hiddenRounds.add(JSON.stringify([e.account, e.gid, e.round_id, e.version]));
      }
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
    [NotifyCommands.SET_VIEWING]: async () => null,
    [NotifyCommands.ALARM_RESIZE]: async () => null,
    [NoticeCommands.OPEN]: async () => null,
    [NoticeCommands.OPEN_CATEGORY]: async () => null,
    [NoticeCommands.RESIZE]: async () => null,
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
      orderQueries.clear(); openedPackage = null;
      const epoch = st.tsim.session_epoch + 1;
      st.tsim = { logged_in: false, user: null, session_epoch: epoch };
      emit(UiEvents.TSIM_STATUS, { ...st.tsim });
      await delay(latency * 3);
      if (st.tsim.session_epoch !== epoch) throw appError('assistant.tsim_unauthenticated', 'TSim 身份已变化', false);
      if (!user || !password) throw appError('assistant.tsim_bad_credentials', '账号或密码为空', false);
      if (password === 'wrong') throw appError('assistant.tsim_bad_credentials', '示例：账号或密码错误', false);
      st.tsim = { logged_in: true, user, session_epoch: epoch };
      emit(UiEvents.TSIM_STATUS, { ...st.tsim });
      st.prefs = { ...st.prefs, assistant: { ...st.prefs.assistant, tsim_logged_in: true, tsim_user: user } };
      pushPrefs();
      return { ...st.tsim };
    },
    [UiCommands.ASSIST_TSIM_BROWSER_PROFILES]: async () => [],
    [UiCommands.ASSIST_TSIM_BROWSER_CONNECT]: async () => { throw appError('assistant.browser_storage_unavailable', '演示模式不读取浏览器会话'); },
    [UiCommands.ASSIST_TSIM_IMPORT_SESSION]: async (p) => {
      const token = (p as { access_token?: unknown }).access_token;
      if (typeof token !== 'string' || token !== 'SYNTHETIC_IMPORT_TOKEN') throw appError('assistant.invalid_input', '演示模式不验证真实访问令牌，请使用原生客户端。');
      orderQueries.clear(); openedPackage = null;
      const epoch = st.tsim.session_epoch + 1;
      st.tsim = { logged_in: false, user: null, session_epoch: epoch };
      emit(UiEvents.TSIM_STATUS, { ...st.tsim });
      await delay(latency * 3);
      if (st.tsim.session_epoch !== epoch) throw appError('assistant.tsim_unauthenticated', 'TSim 身份已变化');
      st.tsim = { logged_in: true, user: 'synthetic-imported-user', session_epoch: epoch };
      emit(UiEvents.TSIM_STATUS, { ...st.tsim });
      st.prefs = { ...st.prefs, assistant: { ...st.prefs.assistant, tsim_logged_in: true, tsim_user: st.tsim.user } };
      pushPrefs(); return { ...st.tsim };
    },
    [UiCommands.ASSIST_TSIM_LOGOUT]: async () => {
      orderQueries.clear(); openedPackage = null;
      st.tsim = { logged_in: false, user: null, session_epoch: st.tsim.session_epoch + 1 };
      emit(UiEvents.TSIM_STATUS, { ...st.tsim });
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
    [UiCommands.ASSIST_ORDER_SUMMARY]: async (p) => {
      const account = checkAccount(p);
      const { gid, order_id, context_revision, session_epoch } = p as { gid: string; order_id: string; context_revision: string; session_epoch: number };
      if (typeof order_id !== 'string' || !/^(?:\d{10}|\d{16})$/.test(order_id)) throw appError('assistant.invalid_input', '完整订单号无效');
      const conv = convFor(account, gid);
      if (conv.order?.order_id !== order_id || conv.assistant_context_revision !== context_revision || !st.tsim.logged_in || st.tsim.session_epoch !== session_epoch) throw appError('account.stale_generation', '订单范围或 TSim 身份已变化');
      const summary: UiOrderPackageSummary = { account, gid, order_id, context_revision, session_epoch, query_handle: `demo-query-${++orderQueryCounter}`, total: 2, fetched_at_ms: now(), plans: [1, 2].map(n => {
        const base = { iccid: `8986000000000000000${n}`, plan: `（演示）日本 eSIM 套餐 ${n}`, status: '演示待激活', supplier: 'DEMO', apn: '', remain_pct: null, remain: '', total: '', fetched_at_ms: now() };
        // 演示补发链：第 1 个套餐带 1 个已读取、1 个读取失败的补发（宿主按补发时间升序给出）。
        const reissues: readonly UiOrderReissue[] | undefined = n === 1 ? [
          { create_time_ms: now() - 2 * 86_400_000, state: 'ready', info: { ...base, iccid: '89860000000000000A1', plan: '（演示）日本 eSIM 套餐 1 · 补发', status: '使用中', remain_pct: 60, remain: '3 GB', total: '5 GB' } },
          { create_time_ms: now() - 86_400_000, state: 'error', info: null },
        ] : undefined;
        return { detail_handle: `demo-detail-${orderQueryCounter}-${n}`, ...base, ...(n === 1 ? { order_time: '2026-10-28 09:30:00' } : {}), ...(reissues ? { reissues } : {}) };
      }) };
      await delay(latency); checkOrderBinding(summary);
      while (orderQueries.size >= 16) orderQueries.delete(orderQueries.keys().next().value!);
      orderQueries.set(summary.query_handle, summary); return summary;
    },
    [UiCommands.ASSIST_PACKAGE_DETAIL_OPEN]: async (p) => {
      const account = checkAccount(p);
      const { gid, query_handle, detail_handle } = p as { gid: string; query_handle: string; detail_handle: string };
      const summary = orderQueries.get(query_handle), plan = summary?.plans.find(value => value.detail_handle === detail_handle);
      if (!summary || !plan || !sameAccountContext(account, summary.account) || gid !== summary.gid) throw appError('assistant.invalid_input', '无效的订单套餐句柄');
      checkOrderBinding(summary); openedPackage = { summary, plan };
      emit(UiEvents.TOAST, { text: '（演示）已选择对应套餐详情；原生客户端会打开独立详情窗口。' }); return null;
    },
    [UiCommands.ASSIST_TSIM_ORDER_OPEN]: async (p) => {
      const account = checkAccount(p);
      const { gid, order_id, context_revision, session_epoch } = p as { gid: string; order_id: string; context_revision: string; session_epoch: number };
      if (typeof order_id !== 'string' || !/^(?:\d{10}|\d{16})$/.test(order_id)) throw appError('assistant.invalid_input', '完整订单号无效');
      const conv = convFor(account, gid);
      if (conv.order?.order_id !== order_id || conv.assistant_context_revision !== context_revision) throw appError('account.stale_generation', '订单范围已变化');
      if (!st.tsim.logged_in) throw appError('assistant.tsim_unauthenticated', 'TSim 未登录', false);
      if (st.tsim.session_epoch !== session_epoch) throw appError('host.view_unauthorized', 'TSim 身份已变化');
      const request_id = '00000000-0000-4000-8000-000000000001';
      return { url: `https://csagent.tsim.tech/embed/operator?source=travel-merchant-companion&session=handoff&identifier=${order_id}&identifierType=order_number&requestId=${request_id}`, identifier: order_id, request_id, session_epoch, access_token: 'synthetic-demo-token-never-valid', session_ref: null };
    },
    [UiCommands.ASSIST_PACKAGE_DETAIL]: async () => {
      if (!openedPackage) throw appError('host.view_unauthorized', '详情窗口尚未绑定套餐');
      const { summary, plan } = openedPackage; checkOrderBinding(summary);
      const info = { iccid: plan.iccid, plan: plan.plan, status: plan.status, supplier: plan.supplier, apn: 'demo.apn', remain_pct: 75, remain: '1.5 GB', total: '2 GB', fetched_at_ms: now() };
      return { order_id: summary.order_id, session_epoch: summary.session_epoch, plan: info,
        detail_fields: [{ label: '演示套餐', value: plan.plan }, { label: 'ICCID', value: plan.iccid }],
        live_fields: [{ label: '演示累计用量（MB）', value: '512' }],
        cdrs: [[{ label: '演示地区', value: 'JP' }, { label: '演示用量（MB）', value: '512' }]], fetched_at_ms: now() } satisfies UiPackageDetail;
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
    async listenReady<T>(event: string, cb: (payload: T) => void): Promise<() => void> {
      return this.listen(event, cb);
    },
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
  return s === 'empty' || s === 'offline' || s === 'clock-untrusted' || s === 'reconciling' || s === 'no-accounts' || s === 'annotation' ? s : 'default';
}
