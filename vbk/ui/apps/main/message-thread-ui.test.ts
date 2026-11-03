// 消息串 UI：成功确认态不显示「已确认」、hover 操作条只有引用/复制两个图标按钮、订单咨询通知卡片字段。
// 用合成数据驱动 main.ts 中真实的 messageRow 与 viewmodel 纯函数。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import * as vm from './viewmodel.ts';
import { messageAlignment } from './message-alignment.ts';
import { cx } from '../../packages/ui-kit/src/h.ts';
import { IC } from '../_shared/icons.ts';
import type { UiMessage, UiOrderSummary } from '../../packages/ipc/src/client.ts';

const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
const owner = { account_id: 'synthetic-account', environment: 'synthetic-env', session_generation: 1 };
const baseConv = { gid: 'synthetic-room', account: owner, title: 'Synthetic Customer', color: '#aaa', order: null as UiOrderSummary | null };
const msg = (extra: Partial<UiMessage>): UiMessage => ({ gid: 'synthetic-room', message_id: 'm1', local_id: null, text: 'SYNTHETIC', kind: 'text', create_time_ms: 1, sender_role: 'customer', sender_id: 'synthetic-customer', sender_name: null, sender_avatar: null, translation: null, original: null, quote: null, order_id: null, disposition: null, ...extra });
interface Node { tag: string; props: Record<string, any>; children: unknown[] }
const nodes = (tree: unknown): Node[] => (Array.isArray(tree) ? tree.flatMap(nodes) : !tree || typeof tree !== 'object' ? [] : [tree as Node, ...nodes((tree as Node).children ?? [])]);
const strings = (tree: unknown): string[] => (typeof tree === 'string' ? [tree] : Array.isArray(tree) ? tree.flatMap(strings) : tree && typeof tree === 'object' ? strings((tree as Node).children ?? []) : []);
const hasClass = (n: Node, cls: string): boolean => String(n.props['class'] ?? '').split(/\s+/).includes(cls);

function renderRow(message: UiMessage, conv = baseConv) {
  const calls = { patches: [] as object[], copied: [] as string[], toasts: [] as string[], opened: 0 };
  const env: Record<string, unknown> = {
    ...vm, messageAlignment, cx, h: (tag: string, props: unknown, ...children: unknown[]) => ({ tag, props: props ?? {}, children }),
    document: {}, renderMessageAvatar: () => 'avatar', t: (k: string) => k, icon: (d: string, size: number) => ({ tag: 'svg', props: { d, size }, children: [] }), IC,
    richText: (s: string) => [s], formatDate: () => 'd', formatClock: () => 'c',
    store: { patch: (p: object) => calls.patches.push(p) }, copyText: (s: string) => calls.copied.push(s), toast: (s: string) => calls.toasts.push(s), openMessageOrder: () => { calls.opened++; }, resend() {},
  };
  const a = source.indexOf('function messageRow('), b = source.indexOf('\nfunction translationBar(', a);
  const row = new Function(...Object.keys(env), stripTypeScriptTypes(source.slice(a, b)) + '\nreturn messageRow;')(...Object.values(env));
  return { tree: row({ messages: {}, prefs: { general: { show_msg_time: false } } }, message, conv, { context: owner, color: '#bbb' }), calls };
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
  for (const expected of ['订单咨询通知', '我来自玩乐订单详情页', '来源渠道：', 'Trip-App', '订单ID：', '产品名称：', '使用日期：', '2026/10/28', '订单总额：', '15.48', 'chat.orderLink']) assert.ok(flat.includes(expected), expected);
  const link = all.find((n) => n.tag === 'button' && n.props['dataset']?.orderAction === 'open');
  assert.ok(link && hasClass(link, 'ocard-link'));
  assert.equal(link.props['aria-label'], 'chat.viewOrder');
  (link.props['onclick'] as () => void)();
  assert.equal(calls.opened, 1);
});
