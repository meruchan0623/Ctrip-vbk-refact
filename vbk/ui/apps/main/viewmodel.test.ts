import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { UiConversation, UiMessage } from '../../packages/ipc/src/client.ts';
import { UiCommands } from '../../packages/ipc/src/client.ts';
import { ErrorCodes } from '../../packages/ipc/src/contracts.ts';
import { AccountCommands } from '../../packages/ipc/src/commands.ts';
import { createMockIpc } from '../../packages/ipc/src/mock.ts';
import {
  MARK_COLORS,
  contextMenuCommand,
  contextMenuItems,
  filterConversations,
  findIccids,
  isValidOrderId,
  orderContactReduce,
  sendStateView,
  shouldShowTranslationBar,
  sortConversations,
  tabCounts,
  translationApplies,
  unreadTotal,
} from './viewmodel.ts';
import type { OrderContactState } from './viewmodel.ts';

const ctx = { account_id: 'a', environment: 'production', session_generation: 1 };

function conv(gid: string, extra: Partial<UiConversation> = {}): UiConversation {
  return {
    account: ctx,
    gid,
    status: 'active',
    agent_in_group: true,
    is_owner: true,
    service_type: 'ticket',
    last_message_time_ms: 1000,
    last_update_time_ms: 1000,
    unread_count: 0,
    is_full_snapshot: true,
    title: gid,
    color: '#000',
    lang: 'zh',
    biz: 'x',
    preview: '',
    draft: '',
    is_top: false,
    mark: 0,
    waiting_since_ms: null,
    waiting_confirmed: true,
    customer_tags: [],
    order: null,
    ...extra,
  };
}

test('sortConversations: pinned first, then last message time desc, stable', () => {
  const list = [
    conv('old', { last_message_time_ms: 100 }),
    conv('new', { last_message_time_ms: 900 }),
    conv('pinOld', { is_top: true, last_message_time_ms: 50 }),
    conv('mid', { last_message_time_ms: 500 }),
    conv('pinNew', { is_top: true, last_message_time_ms: 700 }),
    conv('nullTime', { last_message_time_ms: null }),
    conv('tieA', { last_message_time_ms: 500 }),
  ];
  assert.deepEqual(
    sortConversations(list).map((c) => c.gid),
    ['pinNew', 'pinOld', 'new', 'mid', 'tieA', 'old', 'nullTime'],
  );
});

test('tabCounts and filterConversations by tab/query', () => {
  const list = [conv('a'), conv('b', { status: 'finished', unread_count: 5 }), conv('c', { status: 'transferred_out' }), conv('d', { unread_count: 2, order: { order_id: '0000000001', product: 'p', use_date: '', quantity: '', status: '', contact: '' } })];
  assert.deepEqual(tabCounts(list), { doing: 2, done: 2 });
  assert.deepEqual(filterConversations(list, 'doing', '').map((c) => c.gid), ['a', 'd']);
  assert.deepEqual(filterConversations(list, 'done', '').map((c) => c.gid), ['b', 'c']);
  assert.deepEqual(filterConversations(list, 'doing', '0000000001').map((c) => c.gid), ['d']);
  assert.deepEqual(filterConversations(list, 'doing', 'zzz'), []);
  assert.equal(unreadTotal(list), 2, 'finished conversations do not count toward unread');
});

test('context menu produces official command payloads (top toggle, mark 0–5)', () => {
  const c = conv('g1', { is_top: false, mark: 2 });
  assert.deepEqual(contextMenuCommand(c, { kind: 'toggle_top' }), { cmd: UiCommands.IM_SET_TOP, payload: { account: ctx, gid: 'g1', top: true } });
  assert.deepEqual(contextMenuCommand(conv('g2', { is_top: true }), { kind: 'toggle_top' }).payload, { account: ctx, gid: 'g2', top: false });
  for (const m of MARK_COLORS) {
    assert.deepEqual(contextMenuCommand(c, { kind: 'mark', action: m.action }), { cmd: UiCommands.IM_SET_MARK, payload: { account: ctx, gid: 'g1', action: m.action } });
  }
  assert.deepEqual(contextMenuCommand(c, { kind: 'mark', action: 0 }).payload, { account: ctx, gid: 'g1', action: 0 });
  assert.equal(MARK_COLORS.length, 5);
  assert.deepEqual(MARK_COLORS.map((m) => m.action), [1, 2, 3, 4, 5]);
  assert.throws(() => contextMenuCommand(c, { kind: 'mark', action: 6 as never }), RangeError);
  assert.deepEqual(contextMenuItems(c), { topLabel: '置顶', showClear: true });
  assert.deepEqual(contextMenuItems(conv('g3', { is_top: true })), { topLabel: '取消置顶', showClear: false });
});

test('outbound send state rendering', () => {
  assert.deepEqual(sendStateView(null), { cls: 'sending', label: '发送中', canRetry: false, spin: true });
  assert.deepEqual(sendStateView({ kind: 'confirmed', server_message_id: 'm', server_time_ms: 1 }), { cls: 'ok', label: '已确认', canRetry: false, spin: false });
  const rej = sendStateView({ kind: 'rejected', code: 'x', reason: '原因' });
  assert.equal(rej.cls, 'rej');
  assert.equal(rej.canRetry, true);
  assert.match(rej.label, /^发送失败/);
  const unk = sendStateView({ kind: 'unknown' });
  assert.equal(unk.cls, 'unk');
  assert.equal(unk.canRetry, false, 'unknown results never offer automatic resend');
  assert.equal(unk.label, '结果未知（请核对，不自动重发）');
});

test('order-contact state machine: none/one/multiple/forbidden/unknown, late results ignored', () => {
  let s: OrderContactState = { kind: 'idle' };
  s = orderContactReduce(s, { type: 'query', orderId: '0000000001' });
  assert.equal(s.kind, 'loading');
  const order = { order_id: '0000000001', product: 'p', use_date: 'd', quantity: 'q', status: 's', contact: '客户A' };
  assert.deepEqual(orderContactReduce(s, { type: 'result', orderId: '0000000001', result: { kind: 'one', order } }), { kind: 'one', orderId: '0000000001', order });
  assert.equal(orderContactReduce(s, { type: 'result', orderId: '0000000001', result: { kind: 'none' } }).kind, 'none');
  assert.equal(orderContactReduce(s, { type: 'result', orderId: '0000000001', result: { kind: 'forbidden' } }).kind, 'forbidden');
  assert.equal(orderContactReduce(s, { type: 'result', orderId: '0000000001', result: { kind: 'multiple', orders: [order, { ...order, order_id: '0000000005' }] } }).kind, 'multiple');
  assert.equal(orderContactReduce(s, { type: 'result', orderId: '0000000001', result: { kind: 'multiple', orders: [order] } }).kind, 'one', 'a single-element multiple collapses to one');
  const timeout = orderContactReduce(s, { type: 'error', orderId: '0000000001', error: { code: ErrorCodes.NET_TIMEOUT, message: '超时', retryable: false } });
  assert.equal(timeout.kind, 'unknown');
  assert.equal(orderContactReduce(s, { type: 'error', orderId: '0000000001', error: { code: ErrorCodes.IM_PERMISSION_DENIED, message: 'x', retryable: false } }).kind, 'forbidden');
  assert.equal(orderContactReduce(s, { type: 'error', orderId: '0000000001', error: new Error('boom') }).kind, 'unknown');
  // a late result for a different query id does not overwrite the current one
  assert.equal(orderContactReduce(s, { type: 'result', orderId: '0000000002', result: { kind: 'none' } }), s);
  // results arriving after a timeout do not revive the query (no silent replay)
  assert.equal(orderContactReduce(timeout, { type: 'result', orderId: '0000000001', result: { kind: 'one', order } }), timeout);
  assert.equal(orderContactReduce(timeout, { type: 'reset' }).kind, 'idle');
  assert.equal(isValidOrderId('0000000001'), true);
  assert.equal(isValidOrderId('1234'), false);
  assert.equal(isValidOrderId(' 0000000001 '), true);
});

test('translation gating and draft-version binding', () => {
  const en = conv('g', { lang: 'en' });
  assert.equal(shouldShowTranslationBar(en, true, true), true);
  assert.equal(shouldShowTranslationBar(conv('g', { lang: 'zh' }), true, true), false);
  assert.equal(shouldShowTranslationBar(en, false, true), false);
  assert.equal(shouldShowTranslationBar(conv('g', { lang: 'en', status: 'finished' }), true, true), false);
  assert.equal(shouldShowTranslationBar(null, true, true), false);
  const st = { status: 'done' as const, gid: 'g', draftVersion: 3, target: 'en', text: 'x', error: null };
  assert.equal(translationApplies(st, 'g', 3), true);
  assert.equal(translationApplies(st, 'g', 4), false, 'draft changed → translation must be redone');
  assert.equal(translationApplies(st, 'h', 3), false);
});

test('ICCID detection for package quick view', () => {
  const m = (text: string): UiMessage => ({ gid: 'g', message_id: '1', local_id: null, create_time_ms: 0, sender_role: 'customer', kind: 'text', text, translation: null, original: null, quote: null, order_id: null, disposition: null });
  assert.deepEqual(findIccids([m('ICCID 8986012345678901234 示例'), m('无'), m('8986012345678901234 again')]), ['8986012345678901234']);
  assert.deepEqual(findIccids([m('0000000001')]), []);
});

test('mock enforces contracts used by the main window', async () => {
  const ipc = createMockIpc('default', { tick: false, latency: 0 });
  const snap = await ipc.invoke<{ accounts: { context: { account_id: string } }[] }>(AccountCommands.SNAPSHOT);
  const acc = snap.accounts[0]?.context;
  assert.ok(acc);
  await assert.rejects(ipc.invoke(UiCommands.IM_SET_MARK, { account: acc, gid: 'g-demo-1', action: 6 }), (e: { code: string }) => e.code === 'im.bad_mark');
  await assert.rejects(ipc.invoke(UiCommands.IM_CONVERSATIONS, { account: { ...acc, session_generation: 0 } }), (e: { code: string }) => e.code === ErrorCodes.ACCOUNT_STALE_GENERATION);
  const r = await ipc.invoke<{ kind: string }>(UiCommands.ORDER_SEARCH, { account: acc, order_id: '0000000003' });
  assert.equal(r.kind, 'forbidden');
  await assert.rejects(ipc.invoke(UiCommands.ORDER_SEARCH, { account: acc, order_id: '0000000009' }), (e: { code: string }) => e.code === ErrorCodes.NET_TIMEOUT);
  const d = await ipc.invoke<{ kind: string }>(UiCommands.IM_SEND_TEXT, { account: acc, gid: 'g-demo-3', local_id: 'l1', text: '结果未知' });
  assert.equal(d.kind, 'unknown');
  ipc.dispose();
});
