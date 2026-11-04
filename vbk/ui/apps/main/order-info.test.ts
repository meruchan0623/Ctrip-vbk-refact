import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTsimOrderOpener, orderInfoRows, orderInfoSection, tsimOrderRequest, tsimQueryableOrder, type TsimOrderContext } from './order-info.ts';
import { UiCommands, type UiAccountSnapshot, type UiConversation, type UiOrderSummary, type UiTsimStatus } from '../../packages/ipc/src/client.ts';
import { AccountCommands } from '../../packages/ipc/src/commands.ts';
import { operatorGrant } from './operator-overlay.ts';
import { createMockIpc } from '../../packages/ipc/src/mock.ts';
import type { h } from '../../packages/ui-kit/src/h.ts';

type Tree = { tag: string; props: Record<string, any>; children: unknown[] };
const fakeH = ((tag: string, props: Record<string, unknown> | null, ...children: unknown[]) => ({ tag, props: props ?? {}, children })) as unknown as typeof h;
function nodes(tree: unknown): Tree[] { if (Array.isArray(tree)) return tree.flatMap(nodes); return tree && typeof tree === 'object' && 'tag' in tree ? [tree as Tree, ...nodes((tree as Tree).children)] : []; }
const text = (tree: unknown): string => Array.isArray(tree) ? tree.map(text).join('') : typeof tree === 'string' ? tree : tree && typeof tree === 'object' && 'children' in tree ? text((tree as Tree).children) : '';

const account = { account_id: 'synthetic-order-account', environment: 'synthetic', session_generation: 3 };
const order: UiOrderSummary = { order_id: '1359049237105048', product: '中国大陆 eSIM | 1-30天 总量+每日上网方案', use_date: '2026/10/28', quantity: '', status: '  ', contact: '', source_channel: 'Trip-App', total_amount: '18.52', remark_name: '中国大陆 eSIM | QR code-3天-5G网络-每日-2GB' };
const conversation = { gid: 'synthetic-order-room', account, assistant_context_revision: '00000000-0000-4000-8000-0000000000aa', order } as unknown as UiConversation;
const identity: UiTsimStatus = { logged_in: true, user: 'synthetic-agent', session_epoch: 7 };

function render(o: UiOrderSummary = order) {
  const calls: string[] = [];
  const tree = orderInfoSection({ order: o, hot: false, labels: { copy: '复制订单号', pcDetail: '打开网页订单详情' }, copy: () => calls.push('copy'), pcDetail: () => calls.push('pc'), queryTsim: () => calls.push('tsim') }, fakeH, (() => null) as any, 'copy-glyph');
  return { tree, all: nodes(tree), calls };
}

test('user info renders the reference two-column labels in order and hides blank values', () => {
  assert.deepEqual(orderInfoRows(order).map(([label]) => label), ['来源渠道', '订单ID', '产品名称', '使用日期', '订单总额', '备注名称']);
  const view = render();
  const labels = view.all.filter(n => n.props.class === 'ik').map(n => text(n));
  assert.deepEqual(labels, ['来源渠道', '订单ID', '产品名称', '使用日期', '订单总额', '备注名称']);
  assert.ok(!labels.includes('数量') && !labels.includes('订单状态'), 'blank quantity/status rows stay hidden');
  const actions = view.all.find(n => n.props.class === 'source-actions')!;
  assert.deepEqual(nodes(actions.children).filter(n => n.tag === 'button').map(n => text(n)), ['打开网页订单详情']);
});

test('order ID is a TSim query link; web detail and copy keep their own handlers', () => {
  const view = render();
  const link = view.all.find(n => n.props.dataset?.side === 'tsim-order')!;
  assert.equal(link.tag, 'button'); assert.equal(text(link), order.order_id); assert.equal(link.props.type, 'button');
  link.props.onclick();
  assert.equal(view.all.find(n => n.props.dataset?.side === 'detail'), undefined, 'the separate detail button is gone');
  view.all.find(n => n.props.dataset?.side === 'pc')!.props.onclick();
  view.all.find(n => n.props['aria-label'] === '复制订单号')!.props.onclick();
  assert.deepEqual(view.calls, ['tsim', 'pc', 'copy']);
  const partial = render({ ...order, order_id: '12345-abc' });
  assert.equal(partial.all.find(n => n.props.dataset?.side === 'tsim-order'), undefined, 'a non-numeric order is plain text, never a link');
  assert.ok(partial.all.some(n => n.tag === 'span' && text(n) === '12345-abc'));
});

test('only complete 10/16 digit order numbers are queryable', () => {
  for (const ok of ['3051228766', '1359049237105048']) assert.equal(tsimQueryableOrder(ok), true, ok);
  for (const bad of ['', '305122876', '13590492371050481', '135904923710504a', ' 3051228766', '3051228766\n', '１３５９０４９２３７', '1359049237&x=1', null, 1359049237105048]) assert.equal(tsimQueryableOrder(bad), false, String(bad));
});

test('request carries only the conversation binding and the current TSim epoch', () => {
  const ctx: TsimOrderContext = { account, conversation, identity };
  assert.deepEqual(tsimOrderRequest(ctx), { ok: true, payload: { account, gid: conversation.gid, order_id: order.order_id, context_revision: conversation.assistant_context_revision, session_epoch: 7 } });
  assert.deepEqual(tsimOrderRequest({ ...ctx, identity: { ...identity, logged_in: false, user: null } }), { ok: false, reason: 'login' });
  assert.deepEqual(tsimOrderRequest({ ...ctx, identity: null }), { ok: false, reason: 'login' });
  assert.deepEqual(tsimOrderRequest({ ...ctx, conversation: { ...conversation, assistant_context_revision: undefined } as unknown as UiConversation }), { ok: false, reason: 'revision' });
  assert.deepEqual(tsimOrderRequest({ ...ctx, conversation: { ...conversation, order: { ...order, order_id: 'https://evil.example/' } } as unknown as UiConversation }), { ok: false, reason: 'order' });
  const payload = tsimOrderRequest(ctx);
  assert.ok(payload.ok && !JSON.stringify(payload.payload).includes('http'), 'the renderer never supplies a URL');
});

test('opener is single-flight, scoped to the active gid and maps login failures to the settings entry', async () => {
  const calls: { command: string; payload: any }[] = [], notices: string[] = [];
  let logins = 0, current: TsimOrderContext | null = { account, conversation, identity }, release!: () => void, fail: unknown = null;
  const opener = createTsimOrderOpener({ current: () => current, notify: t => notices.push(t), login: () => logins++,
    invoke: (command, payload) => { calls.push({ command, payload }); return new Promise((resolve, reject) => { release = () => fail ? reject(fail) : resolve(null); }); } });
  const first = opener.open(conversation.gid); await opener.open(conversation.gid); await opener.open('other-room');
  assert.equal(calls.length, 1); assert.equal(calls[0]!.command, UiCommands.ASSIST_TSIM_ORDER_OPEN);
  release(); await first; assert.deepEqual(notices, []);
  fail = { code: 'assistant.tsim_unauthenticated' }; const second = opener.open(conversation.gid); release(); await second;
  assert.match(notices.at(-1)!, /登录 TSim/);
  fail = { code: 'host.view_unauthorized' }; const third = opener.open(conversation.gid); release(); await third;
  assert.match(notices.at(-1)!, /未打开/);
  current = { account, conversation, identity: { logged_in: false, user: null, session_epoch: 8 } };
  await opener.open(conversation.gid); assert.equal(calls.length, 3, 'logged-out never reaches the host'); assert.equal(logins, 1);
});

test('mock host enforces the same order binding contract as assistant_tsim_order_open', async () => {
  const ipc = createMockIpc('default', { tick: false, latency: 0 });
  try {
    const accounts = await ipc.invoke<UiAccountSnapshot>(AccountCommands.SNAPSHOT), ctx = accounts.accounts[0]!.context;
    const conv = (await ipc.invoke<UiConversation[]>(UiCommands.IM_CONVERSATIONS, { account: ctx })).find(c => c.order && tsimQueryableOrder(c.order.order_id))!;
    const status = await ipc.invoke<UiTsimStatus>(UiCommands.ASSIST_TSIM_STATUS);
    const request = tsimOrderRequest({ account: ctx, conversation: conv, identity: status.logged_in ? status : { logged_in: true, user: 'synthetic', session_epoch: status.session_epoch } });
    assert.ok(request.ok);
    if (status.logged_in) assert.ok(operatorGrant(await ipc.invoke(UiCommands.ASSIST_TSIM_ORDER_OPEN, request.payload)));
    else await assert.rejects(ipc.invoke(UiCommands.ASSIST_TSIM_ORDER_OPEN, request.payload), { code: 'assistant.tsim_unauthenticated' });
    await assert.rejects(ipc.invoke(UiCommands.ASSIST_TSIM_ORDER_OPEN, { ...request.payload, order_id: '../embed?x=1' }), { code: 'assistant.invalid_input' });
    await assert.rejects(ipc.invoke(UiCommands.ASSIST_TSIM_ORDER_OPEN, { ...request.payload, context_revision: 'stale' }));
  } finally { ipc.dispose(); }
});

test('a pending iframe authorization never opens after the conversation or TSIM epoch changes', async () => {
  for (const change of ['conversation', 'identity']) {
    let current: TsimOrderContext = { account, conversation, identity }, release!: () => void;
    const shown: unknown[] = [];
    const opener = createTsimOrderOpener({ current: () => current, notify: () => {}, login: () => {}, show: value => shown.push(value), invoke: () => new Promise(resolve => { release = () => resolve({ synthetic: true }); }) });
    const pending = opener.open(conversation.gid);
    current = change === 'conversation' ? { ...current, conversation: { ...conversation, gid: 'another' } } : { ...current, identity: { ...identity, session_epoch: 8 } };
    release(); await pending;
    assert.deepEqual(shown, [], change);
  }
});

test('main.ts delegates the user info section and keeps the TSim query out of the renderer', () => {
  const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8'), module = readFileSync(new URL('./order-info.ts', import.meta.url), 'utf8');
  assert.ok(main.includes('orderInfoSection(') && main.includes('tsimOrder.open(conv.gid)'));
  assert.ok(!/csagent|tsim\.tech/.test(main + module), 'the TSim origin lives only in the host');
});

test('product-only source displays its fields without order actions', () => {
  const source = { ...order, order_id: '', product_id: '123', customer_language: 'zh-HK', product_price: 'CNY2', source_title: '产品查询通知' };
  const view = render(source);
  assert.deepEqual(orderInfoRows(source).map(([label]) => label), ['来源渠道', '客户语言', '产品ID', '产品名称', '产品价格', '使用日期', '订单总额', '备注名称']);
  assert.equal(view.all.find(n => n.props.dataset?.side === 'pc'), undefined);
  assert.equal(view.all.find(n => n.props.dataset?.side === 'tsim-order'), undefined);
});
