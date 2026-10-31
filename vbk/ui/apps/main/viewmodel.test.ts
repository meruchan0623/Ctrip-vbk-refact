import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { UiConversation, UiMessage } from '../../packages/ipc/src/client.ts';
import { UiCommands } from '../../packages/ipc/src/client.ts';
import { ErrorCodes } from '../../packages/ipc/src/contracts.ts';
import { AccountCommands } from '../../packages/ipc/src/commands.ts';
import { createMockIpc } from '../../packages/ipc/src/mock.ts';
import {
  MARK_COLORS,
  safeMediaUrl,
  mergeHistory,
  visibleMessages,
  accountInitial,
  agentView,
  alarmActiveCount,
  canContactOrder,
  expireBanners,
  highlightParts,
  netView,
  pushBanner,
  resumeBanners,
  contextMenuCommand,
  contextMenuItems,
  filterConversations,
  findIccids,
  isValidOrderId,
  logoutCommand,
  orderContactReduce,
  orderDetailUrl,
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

test('colour marks never change ordering, tab counts or unread; pinned/colour mixes count correctly', () => {
  const list = [
    conv('a', { last_message_time_ms: 100, mark: 5, unread_count: 3 }),
    conv('b', { last_message_time_ms: 900, mark: 0 }),
    conv('c', { last_message_time_ms: 500, mark: 1, is_top: true, unread_count: 1 }),
    conv('d', { last_message_time_ms: 950, mark: 3, status: 'finished', unread_count: 7 }),
    conv('e', { last_message_time_ms: 50, mark: 2, is_top: true, status: 'transferred_out' }),
  ];
  const plain = list.map((c) => ({ ...c, mark: 0 as const }));
  assert.deepEqual(sortConversations(list).map((c) => c.gid), sortConversations(plain).map((c) => c.gid), 'sort order is independent of colour');
  assert.deepEqual(sortConversations(list).map((c) => c.gid), ['c', 'e', 'd', 'b', 'a']);
  assert.deepEqual(tabCounts(list), tabCounts(plain));
  assert.deepEqual(tabCounts(list), { doing: 3, done: 2 });
  assert.equal(unreadTotal(list), unreadTotal(plain));
  assert.equal(unreadTotal(list), 4);
  assert.deepEqual(filterConversations(list, 'doing', '').map((c) => c.gid), ['c', 'b', 'a']);
  assert.deepEqual(filterConversations(list, 'done', '').map((c) => c.gid), ['e', 'd'], 'pinned finished conversation still sorts first inside 已完成');
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

test('order contact: IM 联系 only for exactly one verified order; a multiple result must be picked first', () => {
  const order = { order_id: '0000000002', product: 'p', use_date: 'd', quantity: 'q', status: 's', contact: '客户B' };
  const other = { ...order, order_id: '0000000005' };
  const loading = orderContactReduce({ kind: 'idle' }, { type: 'query', orderId: '0000000002' });
  const multiple = orderContactReduce(loading, { type: 'result', orderId: '0000000002', result: { kind: 'multiple', orders: [order, other] } });
  assert.equal(multiple.kind, 'multiple');
  assert.equal(canContactOrder(multiple), false, 'no IM button while several orders match');
  for (const s of [{ kind: 'idle' } as const, loading, orderContactReduce(loading, { type: 'result', orderId: '0000000002', result: { kind: 'none' } }), orderContactReduce(loading, { type: 'result', orderId: '0000000002', result: { kind: 'forbidden' } }), orderContactReduce(loading, { type: 'error', orderId: '0000000002', error: { code: ErrorCodes.NET_TIMEOUT, message: 't', retryable: false } })]) {
    assert.equal(canContactOrder(s), false, `no contact in state ${s.kind}`);
  }
  // picking a row of the result narrows it to one verified order
  const picked = orderContactReduce(multiple, { type: 'select', orderId: '0000000005' });
  assert.deepEqual(picked, { kind: 'one', orderId: '0000000002', order: other });
  assert.equal(canContactOrder(picked), true);
  // only rows of the current result can be picked; `select` is ignored elsewhere
  assert.equal(orderContactReduce(multiple, { type: 'select', orderId: '0000000009' }), multiple);
  assert.equal(orderContactReduce(loading, { type: 'select', orderId: '0000000002' }), loading);
  assert.equal(orderContactReduce(picked, { type: 'select', orderId: '0000000002' }), picked);
  // 网页高级操作 always targets the official detail page with the order id encoded
  assert.equal(orderDetailUrl('0000000001'), 'https://vbooking.ctrip.com/ticket_order/order/detail?orderId=0000000001');
  assert.equal(orderDetailUrl('a b&c'), 'https://vbooking.ctrip.com/ticket_order/order/detail?orderId=a%20b%26c');
});

test('mock: marking read never touches the waiting round; conversations and createimchat are per account', async () => {
  const ipc = createMockIpc('default', { tick: false, latency: 0 });
  const snap = await ipc.invoke<{ accounts: { context: { account_id: string; environment: string; session_generation: number } }[] }>(AccountCommands.SNAPSHOT);
  const a = snap.accounts[0]?.context;
  const b = snap.accounts[1]?.context;
  assert.ok(a && b);
  const before = (await ipc.invoke<UiConversation[]>(UiCommands.IM_CONVERSATIONS, { account: a })).find((c) => c.gid === 'g-demo-2');
  assert.ok(before && before.unread_count > 0 && before.waiting_since_ms !== null);
  const alarmBefore = await ipc.invoke<{ entries: unknown[] }>('notify_snapshot');
  await ipc.invoke(UiCommands.IM_MARK_READ, { account: a, gid: 'g-demo-2' });
  const after = (await ipc.invoke<UiConversation[]>(UiCommands.IM_CONVERSATIONS, { account: a })).find((c) => c.gid === 'g-demo-2');
  assert.ok(after);
  assert.equal(after.unread_count, 0);
  assert.equal(after.waiting_since_ms, before.waiting_since_ms, 'waiting indicator comes only from host data; read state does not clear it');
  assert.equal(after.waiting_confirmed, before.waiting_confirmed);
  assert.deepEqual(await ipc.invoke('notify_snapshot').then((s) => (s as { entries: unknown[] }).entries), alarmBefore.entries, 'alarm rounds untouched by mark-read');
  // account isolation
  const convB = await ipc.invoke<UiConversation[]>(UiCommands.IM_CONVERSATIONS, { account: b });
  assert.ok(convB.length > 0 && convB.every((c) => c.account.account_id === b.account_id), 'account B sees only its own conversations');
  await assert.rejects(ipc.invoke(UiCommands.IM_MESSAGES, { account: b, gid: 'g-demo-1' }), (e: { code: string }) => e.code === ErrorCodes.IM_PERMISSION_DENIED);
  await assert.rejects(ipc.invoke(UiCommands.IM_SET_MARK, { account: b, gid: 'g-demo-1', action: 1 }), (e: { code: string }) => e.code === ErrorCodes.IM_PERMISSION_DENIED);
  // an in-flight createimchat carries the account from its payload, not the account active in the host
  await ipc.invoke(AccountCommands.SWITCH, { account: b });
  const r = await ipc.invoke<{ gid: string; reused: boolean }>(UiCommands.ORDER_CREATE_IM_CHAT, { account: a, order_id: '3051228766' });
  assert.equal(r.reused, true, 'existing conversation of A is reused');
  const empty = createMockIpc('empty', { tick: false, latency: 0 });
  await empty.invoke(AccountCommands.SWITCH, { account: b });
  const created = await empty.invoke<{ gid: string; reused: boolean }>(UiCommands.ORDER_CREATE_IM_CHAT, { account: a, order_id: '3051228766' });
  assert.equal(created.reused, false);
  const convA = await empty.invoke<UiConversation[]>(UiCommands.IM_CONVERSATIONS, { account: a });
  assert.equal(convA.find((c) => c.gid === created.gid)?.account.account_id, a.account_id, 'new conversation belongs to the payload account');
  assert.deepEqual(await empty.invoke(UiCommands.IM_CONVERSATIONS, { account: b }), [], 'not to the host-active account');
  empty.dispose();
  ipc.dispose();
});

test('three logout modes map to three distinct account commands', () => {
  const cmds = (['suspend', 'logout', 'forget'] as const).map(logoutCommand);
  assert.deepEqual(cmds, [AccountCommands.SUSPEND, AccountCommands.LOGOUT, AccountCommands.FORGET]);
  assert.equal(new Set(cmds).size, 3);
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
  const r = await ipc.invoke<{ kind: string }>(UiCommands.ORDER_SEARCH, { account: acc, order_id: '3050000403' });
  assert.equal(r.kind, 'forbidden');
  await assert.rejects(ipc.invoke(UiCommands.ORDER_SEARCH, { account: acc, order_id: '3051000408' }), (e: { code: string }) => e.code === ErrorCodes.NET_TIMEOUT);
  assert.equal((await ipc.invoke<{ kind: string }>(UiCommands.ORDER_SEARCH, { account: acc, order_id: '2287450193' })).kind, 'multiple');
  const d = await ipc.invoke<{ kind: string }>(UiCommands.IM_SEND_TEXT, { account: acc, gid: 'g-demo-3', local_id: 'l1', text: '结果未知' });
  assert.equal(d.kind, 'unknown');
  ipc.dispose();
});

test('no fake status: unconfirmed agent → 状态未知, no net read-back → 未连接', () => {
  assert.equal(agentView({ status: 'online', confirmed: false }).label, '状态未知');
  assert.equal(agentView({ status: 'online', confirmed: false }).known, false);
  assert.equal(agentView({ status: 'hangup', confirmed: true }).label, '挂起');
  assert.equal(netView(null).label, '未连接');
  assert.equal(netView(null).ok, false);
  assert.equal(netView({ online: true, transport: 'connected' }).label, '已连接');
  assert.equal(netView({ online: true, transport: 'disconnected' }).label, '未连接');
  assert.equal(netView({ online: true, transport: 'reconnecting' }).label, '正在重连');
  assert.equal(netView({ online: false, transport: 'connected' }).offline, true);
});

test('message text highlights: ICCID and 10-digit order numbers only', () => {
  const parts = highlightParts('ICCIDは 8981100022334455667 です。订单 3051228766。电话 13800138000x');
  assert.deepEqual(parts.filter((p) => p.kind !== 'plain').map((p) => [p.kind, p.text]), [['iccid', '8981100022334455667'], ['order', '3051228766']]);
  assert.equal(parts.map((p) => p.text).join(''), 'ICCIDは 8981100022334455667 です。订单 3051228766。电话 13800138000x', 'parts reassemble the original text');
  assert.deepEqual(highlightParts('123456789012'), [{ kind: 'plain', text: '123456789012' }], 'a longer digit run is not an order number');
});

test('banner stack: same conversation replaces, newest first, hover pauses expiry', () => {
  const acc = { account_id: 'a', environment: 'production', session_generation: 1 };
  let list = pushBanner([], { id: 1, account: acc, gid: 'g1', count: 1, system: false, at: 0, stayMs: 6000 });
  list = pushBanner(list, { id: 2, account: acc, gid: 'g2', count: 1, system: false, at: 100, stayMs: 0 });
  list = pushBanner(list, { id: 3, account: acc, gid: 'g1', count: 2, system: false, at: 200, stayMs: 6000 });
  assert.deepEqual(list.map((b) => [b.gid, b.count]), [['g1', 2], ['g2', 1]]);
  assert.equal(list[1]?.until, 6100, 'stay_ms 0 falls back to 6 s');
  assert.equal(expireBanners(list, 7000, true), list, 'paused: nothing expires');
  assert.deepEqual(expireBanners(list, 6150, false).map((b) => b.gid), ['g1']);
  const resumed = resumeBanners(list, 1000, 5000);
  assert.equal(resumed[0]?.until, 6200 + 4000, 'hover time is given back');
  assert.ok(resumeBanners(list, 0, 9000).every((b) => b.until >= 10500), 'at least 1.5 s after leaving');
});

test('alarm count ignores snoozed entries; account avatar letter', () => {
  assert.equal(alarmActiveCount([{ snoozed_until_ms: null }, { snoozed_until_ms: 5000 }, { snoozed_until_ms: 100 }], 1000), 2);
  const acc = (nick: string, remark: string | null = null) => ({ context: ctx, nick, remark, party: 'p', color: '#000', state: 'online' as const, unread: 0 });
  assert.equal(accountInitial(acc('云游·夜班组')), '夜');
  assert.equal(accountInitial(acc('畅行租车·lily')), 'L');
  assert.equal(accountInitial(acc('示例商家')), '示');
  assert.equal(accountInitial(acc('x', '备注名')), '备');
});

test('mock login contract: start_login → {attempt_id}, cancel removes the placeholder, agent status read-back', async () => {
  const ipc = createMockIpc('no-accounts', { tick: false, latency: 0 });
  const snap0 = await ipc.invoke<{ accounts: unknown[]; active_account_id: string | null }>(AccountCommands.SNAPSHOT);
  assert.deepEqual([snap0.accounts.length, snap0.active_account_id], [0, null]);
  const r = await ipc.invoke<{ attempt_id: string }>(AccountCommands.START_LOGIN, {});
  assert.deepEqual(Object.keys(r), ['attempt_id']);
  const mid = await ipc.invoke<{ accounts: { state: string }[] }>(AccountCommands.SNAPSHOT);
  assert.deepEqual(mid.accounts.map((a) => a.state), ['logging_in']);
  const after = await ipc.invoke<{ accounts: unknown[] }>(UiCommands.ACCOUNT_CANCEL_LOGIN, { attempt_id: r.attempt_id });
  assert.equal(after.accounts.length, 0);
  await assert.rejects(ipc.invoke(UiCommands.ACCOUNT_CANCEL_LOGIN, { attempt_id: r.attempt_id }));
  ipc.dispose();
  const d = createMockIpc('default', { tick: false, latency: 0 });
  const acc = (await d.invoke<{ accounts: { context: typeof ctx }[] }>(AccountCommands.SNAPSHOT)).accounts[0]?.context;
  assert.ok(acc);
  assert.deepEqual(await d.invoke(UiCommands.ACCOUNT_SET_AGENT_STATUS, { account: acc, status: 'leaving' }), { status: 'leaving', confirmed: true });
  await assert.rejects(d.invoke(UiCommands.ACCOUNT_SET_AGENT_STATUS, { account: acc, status: 'busy' }));
  d.dispose();
});


test('official 16-digit orders can be queried and highlighted without matching phone numbers', () => {
  assert.equal(isValidOrderId('1359049237105048'), true);
  assert.equal(isValidOrderId(' 1359049237105048 '), true);
  assert.equal(isValidOrderId('13800138000'), false);
  assert.equal(isValidOrderId('135904923710504'), false);
  assert.deepEqual(highlightParts('订单 1359049237105048 / 电话 13800138000').filter(p => p.kind !== 'plain'), [{ kind: 'order', text: '1359049237105048' }]);
  assert.deepEqual(highlightParts('13590492371050481'), [{ kind: 'plain', text: '13590492371050481' }]);
});


test('media URLs reject executable, local and credential-bearing schemes', () => {
  assert.equal(safeMediaUrl('https://images.example/a.png'), 'https://images.example/a.png');
  for (const value of ['javascript:alert(1)', 'file:///tmp/image.png', 'data:image/svg+xml,x', 'https://user:secret@example.com/x', '/relative.png']) assert.equal(safeMediaUrl(value), null);
});

test('history overlap preserves current live message and sorts earlier messages', () => {
  const base: UiMessage = { gid: 'g', message_id: '2', local_id: null, create_time_ms: 200, sender_role: 'customer', kind: 'text', text: 'live', translation: null, original: null, quote: null, order_id: null, disposition: null };
  const first = { ...base, message_id: '1', create_time_ms: 100, text: 'earlier' };
  assert.deepEqual(mergeHistory([{ ...base, text: 'stale' }, first], [base]), [first, base]);
});


test('recall notices hide original messages even when history loads them later', () => {
  const original: UiMessage = { gid: 'g', message_id: 'original', local_id: null, create_time_ms: 100, sender_role: 'customer', kind: 'text', text: 'recalled content', translation: null, original: null, quote: null, order_id: null, disposition: null };
  const notice: UiMessage = { ...original, message_id: 'notice', kind: 'system', text: '撤回了一条消息', create_time_ms: 200, recalled_message_id: 'original' };
  assert.deepEqual(visibleMessages(mergeHistory([original], [notice])), [notice]);
});


test('peripheral acceptance and contradictory confirmation never imply verified success', async () => {
  const { peripheralWriteView } = await import('./viewmodel.ts');
  assert.equal(peripheralWriteView({ kind: 'accepted', confirmed: false }).confirmed, false);
  assert.equal(peripheralWriteView({ kind: 'unknown', confirmed: false }).confirmed, false);
  assert.equal(peripheralWriteView({ kind: 'confirmed', confirmed: false }).confirmed, false);
  assert.equal(peripheralWriteView({ kind: 'confirmed', confirmed: true }).confirmed, true);
});
