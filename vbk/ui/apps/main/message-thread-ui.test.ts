// 消息串 UI：成功确认态不显示「已确认」、hover 操作条只有引用/复制两个图标按钮、订单咨询通知卡片字段。
// 用合成数据驱动 main.ts 中真实的 messageRow 与 viewmodel 纯函数。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import * as vm from './viewmodel.ts';
import { messageAlignment } from './message-alignment.ts';
import { httpMessageToUi } from '../../packages/web-adapter/src/display.ts';
import { buildMemberRoles } from '../../packages/web-adapter/src/facts.ts';
import { cx } from '../../packages/ui-kit/src/h.ts';
import { IC } from '../_shared/icons.ts';
import type { UiMessage, UiOrderSummary } from '../../packages/ipc/src/client.ts';
import { t as translateUi } from '../../packages/ui-kit/src/i18n.ts';

const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
const owner = { account_id: 'synthetic-account', environment: 'synthetic-env', session_generation: 1 };
const baseConv = { gid: 'synthetic-room', account: owner, title: 'Synthetic Customer', color: '#aaa', order: null as UiOrderSummary | null };
const msg = (extra: Partial<UiMessage>): UiMessage => ({ gid: 'synthetic-room', message_id: 'm1', local_id: null, text: 'SYNTHETIC', kind: 'text', create_time_ms: 1, sender_role: 'customer', sender_id: 'synthetic-customer', sender_name: null, sender_avatar: null, translation: null, original: null, quote: null, order_id: null, disposition: null, ...extra });
interface Node { tag: string; props: Record<string, any>; children: unknown[] }
const nodes = (tree: unknown): Node[] => (Array.isArray(tree) ? tree.flatMap(nodes) : !tree || typeof tree !== 'object' ? [] : [tree as Node, ...nodes((tree as Node).children ?? [])]);
const strings = (tree: unknown): string[] => (typeof tree === 'string' ? [tree] : Array.isArray(tree) ? tree.flatMap(strings) : tree && typeof tree === 'object' ? strings((tree as Node).children ?? []) : []);
const hasClass = (n: Node, cls: string): boolean => String(n.props['class'] ?? '').split(/\s+/).includes(cls);

function renderRow(message: UiMessage, conv = baseConv, hideInboundTr = false, showTime = false, trView: unknown = null) {
  const calls = { patches: [] as object[], copied: [] as string[], toasts: [] as string[], opened: 0 };
  const env: Record<string, unknown> = {
    ...vm, messageAlignment, cx, h: (tag: string, props: unknown, ...children: unknown[]) => ({ tag, props: props ?? {}, children }),
    inboundTranslation: { view: () => trView, supplier: () => null }, refreshMessageTranslation() {},
    mediaNodeKey: () => 'synthetic-media', openMessageAttachment() {}, document: {}, renderMessageAvatar: () => 'avatar', t: (k: string, vars?: Readonly<Record<string, string | number>>) => (k.startsWith('mainTs.') ? translateUi(k as never, vars) : k), icon: (d: string, size: number) => ({ tag: 'svg', props: { d, size }, children: [] }), IC,
    richText: (s: string) => [s], formatDate: () => 'd', formatClock: () => 'c',
    store: { patch: (p: object) => calls.patches.push(p) }, copyText: (s: string) => calls.copied.push(s), toast: (s: string) => calls.toasts.push(s), openMessageOrder: () => { calls.opened++; }, resend() {},
  };
  const a = source.indexOf('function messageRow('), b = source.indexOf('\nfunction translationBar(', a);
  const row = new Function(...Object.keys(env), stripTypeScriptTypes(source.slice(a, b)) + '\nreturn messageRow;')(...Object.values(env));
  return { tree: row({ messages: {}, hideInboundTr, prefs: { general: { show_msg_time: showTime } } }, message, conv, { context: owner, color: '#bbb' }), calls };
}

test('confirmed outbound rows show no 已确认 text but keep a machine-readable outcome', () => {
  const { tree } = renderRow(msg({ sender_role: 'merchant_self', disposition: { kind: 'confirmed', server_message_id: 'S1', server_time_ms: 1 } }));
  const all = nodes(tree);
  assert.equal(all.filter((n) => hasClass(n, 'mst')).length, 0, 'no send-state line under a confirmed message');
  assert.ok(!strings(tree).includes('已确认'));
  assert.equal((tree as Node).props['dataset'].sendOutcome, 'ok');
});

test('sending, unknown and rejected outbound states stay visible and separate', () => {
  for (const [disposition, cls, label] of [
    [null, 'sending', '发送中'],
    [{ kind: 'unknown' }, 'unk', '结果未知（请核对，不自动重发）'],
    [{ kind: 'rejected', code: 'x', reason: 'r' }, 'rej', '发送失败（r）'],
  ] as const) {
    const { tree } = renderRow(msg({ sender_role: 'merchant_self', disposition: disposition as UiMessage['disposition'] }));
    const st = nodes(tree).find((n) => hasClass(n, 'mst'));
    assert.ok(st, `${cls} keeps its status line`);
    assert.equal(st.props['dataset'].sendState, cls);
    assert.ok(strings(st).includes(label));
    assert.equal((tree as Node).props['dataset'].sendOutcome, cls);
  }
  assert.equal(vm.visibleSendState({ kind: 'confirmed', server_message_id: 'S', server_time_ms: 1 }), null);
  assert.equal(vm.visibleSendState({ kind: 'unknown' })?.label, '结果未知（请核对，不自动重发）');
  assert.equal(vm.visibleSendState({ kind: 'rejected', code: 'x', reason: '原因' })?.canRetry, true);
  assert.equal(vm.visibleSendState(null)?.cls, 'sending');
});

test('inbound rows carry no send outcome', () => {
  const { tree } = renderRow(msg({}));
  assert.equal((tree as Node).props['dataset'].sendOutcome, undefined);
  assert.equal(nodes(tree).filter((n) => hasClass(n, 'mst')).length, 0);
});

test('official custom customer text renders a bubble while system notices keep the centered row', () => {
  const roles = buildMemberRoles({ selfUid: 'agent', customerUid: 'customer', members: [] });
  for (const msgtype of [7, 1007]) {
    const message = httpMessageToUi({ msgId: `m-${msgtype}`, msgtype, fromJid: 'synthetic-room@conf/customer', createTime: 1793689482000, messageBody: JSON.stringify({ title: 'Не работала сим карта', action: msgtype === 7 ? 'CBZ06' : 'NBZ37' }) }, roles)!;
    const { tree } = renderRow(message);
    assert.equal(nodes(tree).some((n) => hasClass(n, 'msg-sys')), msgtype === 1007);
    assert.equal(nodes(tree).some((n) => hasClass(n, 'bubble')), msgtype === 7);
    assert.equal(nodes(tree).some((n) => hasClass(n, 'mine')), false);
    assert.ok(strings(tree).some((s) => s.includes('Не работала сим карта')));
  }
});

test('hover action bar has exactly two labelled icon buttons: quote and copy', () => {
  const m = msg({ text: 'COPY ME', message_id: 'SERVER-ID' });
  const { tree, calls } = renderRow(m);
  const bar = nodes(tree).find((n) => hasClass(n, 'macts'));
  assert.ok(bar);
  const buttons = nodes(bar.children).filter((n) => n.tag === 'button');
  assert.deepEqual(buttons.map((b) => b.props['dataset'].msgAction), ['quote', 'copy']);
  assert.deepEqual(buttons.map((b) => [b.props['aria-label'], b.props['title']]), [['chat.quote', 'chat.quote'], ['chat.copy', 'chat.copy']]);
  assert.deepEqual(buttons.map((b) => (b.children[0] as Node).props['d']), [IC.quote, IC.copy], 'icons only, from the shared IC table');
  assert.ok(buttons.every((b) => strings(b).length === 0), 'no visible text labels');
  assert.ok(!JSON.stringify(bar).includes('消息ID') && !JSON.stringify(bar).includes('SERVER-ID'), 'message-id button removed');
  (buttons[0]!.props['onclick'] as () => void)();
  (buttons[1]!.props['onclick'] as () => void)();
  assert.deepEqual(calls.patches, [{ quote: m }]);
  assert.deepEqual(calls.copied, ['COPY ME']);
  assert.deepEqual(calls.toasts, []);
});

test('action bar sits beside the bubble inside .bline, not on the full-width row', () => {
  const { tree } = renderRow(msg({ text: '2' }));
  const line = nodes(tree).find((n) => hasClass(n, 'bline'));
  assert.ok(line, 'bubble wrapped in .bline');
  const kids = (line.children as unknown[]).filter((n): n is Node => !!n && typeof n === 'object');
  assert.ok(kids.some((n) => hasClass(n, 'bubble')), 'bubble is a direct child of .bline');
  assert.ok(kids.some((n) => hasClass(n, 'macts')), 'action bar is anchored to the bubble line');
  const row = (tree as Node).children as unknown[];
  assert.ok(!row.some((n) => !!n && typeof n === 'object' && hasClass(n as Node, 'macts')), 'not a direct child of the row');
});

const fullOrder: UiOrderSummary = { order_id: '1359049237198786', product: 'eSIM 中国大陆 1-30天', use_date: '2026/10/28', quantity: '', status: '', contact: '', source_channel: 'Trip-App', total_amount: '15.48', source_title: '订单咨询通知', source_description: '我来自玩乐订单详情页' };

test('orderCardView lists only the fields the matching card summary provides', () => {
  const card = vm.orderCardView({ order_id: fullOrder.order_id, text: fullOrder.product }, fullOrder);
  assert.equal(card.title, '订单咨询通知');
  assert.equal(card.subtitle, '我来自玩乐订单详情页');
  assert.deepEqual(card.rows, [
    { label: '来源渠道', value: 'Trip-App' },
    { label: '订单ID', value: '1359049237198786' },
    { label: '产品名称', value: 'eSIM 中国大陆 1-30天' },
    { label: '使用日期', value: '2026/10/28' },
    { label: '订单总额', value: '15.48' },
  ]);
  // 另一订单的摘要绝不借给本卡片；只剩卡片自带的订单号与产品名，不编造其他行。
  const other = vm.orderCardView({ order_id: '42', text: 'CARD PRODUCT' }, fullOrder);
  assert.equal(other.subtitle, null);
  assert.deepEqual(other.rows, [{ label: '订单ID', value: '42' }, { label: '产品名称', value: 'CARD PRODUCT' }]);
  assert.equal(other.title, '订单咨询通知');
  // 空字段整行省略。
  const sparse = vm.orderCardView({ order_id: '1', text: '' }, { order_id: '1', product: '', use_date: ' ', quantity: '', status: '', contact: '' });
  assert.deepEqual(sparse.rows, [{ label: '订单ID', value: '1' }]);
  assert.deepEqual(vm.orderCardView({ order_id: null, text: '' }, null).rows, []);
});

test('order card renders the reference layout and keeps the open-order action', () => {
  const conv = { ...baseConv, order: fullOrder };
  const { tree, calls } = renderRow(msg({ kind: 'order_card', order_id: fullOrder.order_id, text: fullOrder.product }), conv);
  const all = nodes(tree);
  const card = all.find((n) => hasClass(n, 'ocard'));
  assert.ok(card);
  const flat = strings(card);
  for (const expected of ['订单咨询通知', '我来自玩乐订单详情页', '来源渠道：', 'Trip-App', '订单ID：', '产品名称：', '使用日期：', '2026/10/28', '订单总额：', '15.48', 'side.pcDetail']) assert.ok(flat.includes(expected), expected);
  const link = all.find((n) => n.tag === 'button' && n.props['dataset']?.orderAction === 'open');
  assert.ok(link && hasClass(link, 'ocard-link'));
  assert.ok(strings(link).includes('side.pcDetail'), 'the card action reuses the sidebar web-detail label');
  (link.props['onclick'] as () => void)();
  assert.equal(calls.opened, 1);
});

test('outbound rows show only returned platform translations, never our pre-translation original', () => {
  for (const sender_role of ['merchant_self', 'merchant_other'] as const) {
    const message = msg({ sender_role, text: 'Hello there', translation: '您好', original: '发送前原文' });
    const { tree } = renderRow(message);
    assert.ok(strings(tree).includes('Hello there'));
    assert.ok(strings(tree).includes('您好'));
    assert.ok(!strings(tree).includes('发送前原文'));
    assert.equal(nodes(tree).filter(n => hasClass(n, 'inbound-translate')).length, 0);
    assert.ok(!strings(renderRow(message, baseConv, true).tree).includes('您好'));
    const silent = renderRow({ ...message, translation: null, original: null }).tree;
    assert.equal(nodes(silent).filter(n => hasClass(n, 'btr')).length, 0, 'no permanent placeholder while nothing is known');
  }
});


test('read and delivered SVG ticks sit at the bubble corner independently of message time', () => {
  for (const showTime of [false, true]) {
    for (const sender_role of ['merchant_self', 'merchant_other', 'customer'] as const) {
      for (const read_status of ['read', 'unread'] as const) {
        const { tree } = renderRow(msg({ sender_role, read_status }), baseConv, false, showTime);
        const receipt = nodes(tree).find(n => hasClass(n, 'message-receipt'));
        assert.ok(receipt);
        const label = read_status === 'read' ? '已读' : '已送达';
        assert.equal(receipt.props['aria-label'], label);
        assert.equal(receipt.props['title'], label);
        assert.equal(receipt.props['role'], 'img');
        assert.equal(receipt.props['dataset'].receipt, read_status === 'read' ? 'read' : 'delivered');
        assert.equal(receipt.props['dataset'].receiptSide, sender_role === 'customer' ? 'right' : 'left');
        assert.equal(nodes(receipt).filter(n => n.tag === 'svg').length, read_status === 'read' ? 2 : 1);
        assert.deepEqual(strings(receipt), [], 'marker uses icons without visible labels');
        assert.equal(strings(tree).includes('d c'), showTime);
        const line = nodes(tree).find(n => hasClass(n, 'bline'))!;
        assert.ok(hasClass(line, 'has-receipt'));
        assert.ok(line.children.includes(receipt), 'corner is anchored to the bubble, not the timestamp');
      }
    }
  }
});

test('only known delivery gets a tick; inbound arrival never fabricates a read receipt', () => {
  for (const sender_role of ['customer', 'merchant_other'] as const) {
    const { tree } = renderRow(msg({ sender_role, read_status: 'unknown' }));
    const receipt = nodes(tree).find(n => hasClass(n, 'message-receipt'))!;
    assert.equal(receipt.props['dataset'].receipt, 'delivered');
    assert.equal(nodes(receipt).filter(n => n.tag === 'svg').length, 1);
    assert.equal(nodes(renderRow(msg({ sender_role, message_id: null })).tree).some(n => hasClass(n, 'message-receipt')), false);
  }
  for (const disposition of [null, { kind: 'unknown' }, { kind: 'rejected', code: 'x', reason: 'rejected' }] as const) {
    const { tree } = renderRow(msg({ sender_role: 'merchant_self', read_status: 'unknown', disposition }));
    assert.equal(nodes(tree).some(n => hasClass(n, 'message-receipt')), false);
    assert.ok(nodes(tree).some(n => hasClass(n, 'mst')), 'existing sending/error feedback remains visible');
  }
  const { tree } = renderRow(msg({ sender_role: 'merchant_self', read_status: 'unknown', disposition: { kind: 'confirmed', server_message_id: 'm1', server_time_ms: 1 } }));
  assert.equal(nodes(tree).find(n => hasClass(n, 'message-receipt'))?.props['dataset'].receipt, 'delivered');
  assert.equal(nodes(renderRow(msg({ sender_role: 'unknown', read_status: 'read' })).tree).some(n => hasClass(n, 'message-receipt')), false);
});

test('receipt corner applies to text, image, file, video and order card bubbles', () => {
  for (const kind of ['text', 'image', 'file', 'video', 'order_card'] as const) {
    const { tree } = renderRow(msg({ kind, sender_role: 'merchant_self', read_status: 'read', media_url: 'https://example.invalid/media', order_id: fullOrder.order_id }), { ...baseConv, order: fullOrder });
    const line = nodes(tree).find(n => hasClass(n, 'bline'))!;
    assert.equal(nodes(line).find(n => hasClass(n, 'message-receipt'))?.props['dataset'].receipt, 'read', kind);
  }
  assert.equal(nodes(renderRow(msg({ kind: 'system', read_status: 'read' })).tree).some(n => hasClass(n, 'message-receipt')), false);
});

test('rows draw progress, failures and a retry only when the controller reports them', () => {
  const row = (view: unknown) => renderRow(msg({ sender_role: 'merchant_self', text: 'Hello' }), baseConv, false, false, view).tree;
  const pending = row({ status: 'pending' });
  assert.ok(strings(pending).includes('正在翻译…'));
  assert.equal(nodes(pending).filter(n => hasClass(n, 'inbound-translate')).length, 0);
  for (const [view, label] of [[{ status: 'failed', error: '网络超时' }, '翻译失败'], [{ status: 'missing' }, '未找到翻译结果']] as const) {
    const tree = row(view);
    assert.ok(strings(tree).includes(label));
    const retry = nodes(tree).filter(n => hasClass(n, 'inbound-translate'));
    assert.equal(retry.length, 1);
    assert.ok(strings(retry[0]).includes('点击重试'));
  }
  assert.equal(nodes(renderRow(msg({ text: 'Hello' }), baseConv, true, false, { status: 'missing' }).tree).filter(n => hasClass(n, 'btr')).length, 0, 'hidden translations draw nothing');
});

test('returned translation sits in the same bubble as the original', () => {
  const translated = renderRow(msg({ sender_role: 'merchant_self', text: 'Hello', translation: '你好' })).tree;
  const bubble = nodes(translated).find(n => hasClass(n, 'bubble'))!;
  assert.ok(strings(bubble).includes('Hello'));
  assert.ok(strings(bubble).includes('你好'));
  assert.ok(nodes(bubble).some(n => hasClass(n, 'btr')));
});
