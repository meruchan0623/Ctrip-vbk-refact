import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AdapterFact } from '../../ipc/src/contracts.ts';
import type { AdapterDisplayPayload, AdapterReplyPayload } from '../../ipc/src/adapterProtocol.ts';
import { createRpc, type AgentStatusBox, type RpcContext } from './rpc.ts';
import { ConversationStore, RoleBook, roomJidFromMessage } from './stores.ts';
import { SoaClient } from './soa.ts';
import { FakePageSdk, OK_STATUS, flush, jsonResponse, makeDeps, sampleRow, type FetchScript } from './testing.ts';

const GID = '123456';

function readRevision(ctx: RpcContext): string {
  const revision = ctx.store.assistantContextRevision(GID, ctx.roles.selfUid, ctx.sdk.partnerJidOf(GID) ?? roomJidFromMessage(GID, ctx.store.view(GID)?.lastMessage ?? null));
  assert.ok(revision);
  return revision;
}

function notSubmitted(r: AdapterReplyPayload | null): string {
  const data = ok(r) as { kind: string; confirmed: boolean; reason?: string };
  assert.equal(data.kind, 'not_submitted');
  assert.equal(data.confirmed, false);
  return data.reason ?? '';
}
async function memberSelection(rpc: ReturnType<typeof createRpc>): Promise<string> {
  return (ok(await rpc.handle({ req_id: 'selection', op: 'im.members', args: { gid: GID } })) as { selection_token: string }).selection_token;
}

function setup(script: FetchScript = () => jsonResponse({ ResponseStatus: OK_STATUS })) {
  const base = makeDeps(script);
  const sdk = new FakePageSdk();
  const deps = { ...base, sdk };
  const store = new ConversationStore();
  store.update([sampleRow(GID)]);
  const facts: AdapterFact[] = [];
  const displays: AdapterDisplayPayload[] = [];
  let agent: { status: 'online' | 'hangup' | 'leaving' | 'getoff'; confirmed: boolean } | null = null;
  const box: AgentStatusBox = { current: () => agent, set: (status, confirmed) => void (agent = { status, confirmed }) };
  const ctx: RpcContext = {
    deps,
    soa: new SoaClient(deps),
    sdk,
    store,
    roles: new RoleBook('me'),
    pushFact: (f) => facts.push(f),
    pushDisplay: (d) => displays.push(d),
    agent: box,
    sendAckTimeoutMs: 1000,
    orderGidWaitMs: 500,
  };
  return { base, sdk, ctx, rpc: createRpc(ctx), facts, displays, store };
}

function ok(r: AdapterReplyPayload | null): unknown {
  assert.ok(r);
  assert.equal(r.ok, true, JSON.stringify(r));
  return (r as { data: unknown }).data;
}

function err(r: AdapterReplyPayload | null): string {
  assert.ok(r);
  assert.equal(r.ok, false);
  return (r as { error: { code: string } }).error.code;
}

const send = (req_id: string, local_id = 'L-1') => ({ req_id, op: 'im.send_text', args: { gid: GID, local_id, text: 'hi there', original: '你好', quote_id: null } });

test('rpc: im.send_text → confirmed on matching send_result; host local_id is the localid; fact + display pushed', async () => {
  const { sdk, rpc, facts, displays } = setup();
  const p = rpc.handle(send('r1'));
  await flush();
  assert.equal(sdk.sent.length, 1);
  const body = sdk.sent[0]?.body;
  assert.equal(body?.localid, 'L-1');
  assert.equal(body?.biztype, '1513');
  assert.equal(body?.threadid, '');
  sdk.emit('send_result', { error: 0, localid: 'L-1', tid: 'srv-9', create_time: '1700000000999' });
  const d = ok(await p) as { kind: string; server_message_id: string };
  assert.equal(d.kind, 'confirmed');
  assert.equal(d.server_message_id, 'srv-9');
  assert.equal(facts.length, 1);
  assert.equal(JSON.stringify(facts).includes('hi there'), false, 'no body in facts');
  const msg = displays.find((x) => x.kind === 'messages');
  assert.ok(msg && msg.kind === 'messages' && msg.items[0]?.text === 'hi there' && msg.items[0]?.original === '你好');
});

test('rpc: im.send_text timeout → unknown, exactly one submission, duplicate local_id never resends', async () => {
  const { base, sdk, rpc } = setup();
  const p1 = rpc.handle(send('r1'));
  const p2 = rpc.handle(send('r2'));
  await base.clock.advance(1000);
  assert.deepEqual(ok(await p1), { kind: 'unknown' });
  assert.deepEqual(ok(await p2), { kind: 'unknown' });
  // a later ack does not resend, a third request with the same id returns the memoised result
  sdk.emit('send_result', { error: 0, localid: 'L-1', tid: 'late' });
  assert.deepEqual(ok(await rpc.handle(send('r3'))), { kind: 'unknown' });
  assert.equal(sdk.sent.length, 1);
});

test('rpc: im.send_text rejected; no SDK send entry → host.unsupported and nothing sent', async () => {
  const a = setup();
  const p = a.rpc.handle(send('r1'));
  await flush();
  a.sdk.emit('send_result', { error: 5, localid: 'L-1', reason: 'blocked' });
  assert.deepEqual(ok(await p), { kind: 'rejected', code: '5', reason: 'blocked' });
  const b = setup();
  b.sdk.canSend = false;
  assert.equal(err(await b.rpc.handle(send('r1'))), 'host.unsupported');
  assert.equal(b.sdk.sent.length, 0);
  assert.equal(err(await b.rpc.handle({ req_id: 'x', op: 'im.send_text', args: { gid: 'nope', local_id: 'L', text: 't' } })), 'adapter.not_ready');
});

test('rpc: im.set_mark sends sessionId / numeric groupId / worksheetId from the cache', async () => {
  const { base, rpc } = setup(() => jsonResponse({ ResponseStatus: OK_STATUS, bizResponseStatus: { resultCode: 'SUCCESS' } }));
  assert.equal(ok(await rpc.handle({ req_id: 'r', op: 'im.set_mark', args: { gid: GID, action: 3 } })), null);
  const b = base.fakeFetch.calls[0]?.bodyJson as Record<string, unknown>;
  assert.ok(base.fakeFetch.calls[0]?.url.includes('16037/setWorkSheetStar'));
  assert.equal(b['sessionId'], `sess-${GID}`);
  assert.equal(b['groupId'], 123456);
  assert.equal(b['worksheetId'], 9001);
  assert.equal(b['action'], 3);
  assert.equal(err(await rpc.handle({ req_id: 'r', op: 'im.set_mark', args: { gid: GID, action: 9 } })), 'adapter.failed');
});

test('rpc: im.mark_read submits only the explicitly observed current message id', async () => {
  const { sdk, rpc, ctx } = setup();
  assert.equal(ok(await rpc.handle({ req_id: 'r', op: 'im.mark_read', args: { gid: GID, expected_context_revision: readRevision(ctx), expected_message_id: `m-${GID}` } })), null);
  assert.deepEqual(sdk.readReceipts[0], { partnerJid: `${GID}@conf.x`, msgId: `m-${GID}`, conversationType: 'groupchat' });
});

test('rpc: im.mark_read rejects missing or stale visibility evidence before SDK submission', async () => {
  const { sdk, rpc, store, facts, displays, ctx } = setup();
  for (const expected_message_id of [undefined, null, '', 123, 'not-observed']) {
    assert.equal(err(await rpc.handle({ req_id: 'invalid', op: 'im.mark_read', args: { gid: GID, expected_context_revision: readRevision(ctx), expected_message_id } })), 'adapter.failed');
    assert.equal(sdk.readReceipts.length, 0);
  }
  for (const expected_context_revision of [undefined, null, '', 123, 'wrong-revision']) {
    assert.equal(err(await rpc.handle({ req_id: 'invalid-context', op: 'im.mark_read', args: { gid: GID, expected_context_revision, expected_message_id: `m-${GID}` } })), 'adapter.failed');
    assert.equal(sdk.readReceipts.length, 0);
  }
  // A fresh list update arrives after the UI saw the old last message.
  store.update([sampleRow(GID, { lastMessageJsonString: JSON.stringify({ msgId: 'new-unseen', fromJid: `cust-${GID}@im.x`, toJid: `${GID}@conf.x`, createTime: 1700000000700, msgtype: 0 }) })]);
  assert.equal(err(await rpc.handle({ req_id: 'stale', op: 'im.mark_read', args: { gid: GID, expected_context_revision: readRevision(ctx), expected_message_id: `m-${GID}` } })), 'adapter.failed');
  assert.equal(sdk.readReceipts.length, 0, 'never fall back to the newer unseen message');
  assert.deepEqual(facts, []);
  assert.deepEqual(displays, [], 'rejection must not clear local unread');
  assert.equal(ok(await rpc.handle({ req_id: 'observed', op: 'im.mark_read', args: { gid: GID, expected_context_revision: readRevision(ctx), expected_message_id: 'new-unseen' } })), null);
  assert.deepEqual(sdk.readReceipts.map(r => r.msgId), ['new-unseen']);
  assert.deepEqual(displays, [], 'ack is not an authoritative unread count');
});

test('rpc: im.messages fetches history, pushes body-free facts and merges partial display', async () => {
  const { base, rpc, facts, displays } = setup((call) =>
    call.url.includes('getMessageList')
      ? jsonResponse({
          ResponseStatus: OK_STATUS,
          rangeMessage: {
            isDone: true,
            messages: [
              { msgId: 'b', messageBody: 'second', fromJid: `me@x`, createTime: 1700000000200, msgtype: 0 },
              { msgId: 'a', messageBody: 'first', fromJid: `cust-${GID}@x`, createTime: 1700000000100, msgtype: 0 },
            ],
          },
        })
      : jsonResponse({ ResponseStatus: OK_STATUS, members: [] }),
  );
  const items = ok(await rpc.handle({ req_id: 'r', op: 'im.messages', args: { gid: GID } })) as { text: string; sender_role: string }[];
  assert.deepEqual(items.map((i) => i.text), ['first', 'second']);
  assert.equal(items[1]?.sender_role, 'merchant_self');
  assert.ok(base.fakeFetch.calls.some((c) => c.url.includes('13500/checkMemberStatus')));
  assert.equal(facts.length, 2);
  assert.equal(JSON.stringify(facts).includes('first'), false);
  assert.ok(displays.some((d) => d.kind === 'messages' && !d.replace));
});

test('rpc: im.message_page uses an exclusive earlier boundary and stops at server completion', async () => {
  const { rpc, base } = setup((call) => {
    if (!call.url.includes('getMessageList')) return jsonResponse({ ResponseStatus: OK_STATUS, members: [] });
    const b = call.bodyJson as { endTime?: number };
    return jsonResponse({ ResponseStatus: OK_STATUS, rangeMessage: {
      isDone: b.endTime !== undefined,
      messages: [{ msgId: b.endTime ? 'old' : 'new', messageBody: 'history', fromJid: 'me@x', createTime: b.endTime ? 1700000000000 : 1700000000100, msgtype: 0 }],
    } });
  });
  const page = ok(await rpc.handle({ req_id: 'p1', op: 'im.message_page', args: { gid: GID } })) as { has_more: boolean; before_ms: number; items: { disposition: { kind: string } }[] };
  assert.equal(page.has_more, true);
  assert.equal(page.before_ms, 1700000000100);
  assert.equal(page.items[0]?.disposition.kind, 'confirmed');
  const older = ok(await rpc.handle({ req_id: 'p2', op: 'im.message_page', args: { gid: GID, before_ms: page.before_ms } })) as { has_more: boolean; before_ms: number | null };
  assert.deepEqual([older.has_more, older.before_ms], [false, null]);
  const requests = base.fakeFetch.calls.filter((call) => call.url.includes('getMessageList'));
  assert.equal((requests[1]?.bodyJson as { endTime: number }).endTime, page.before_ms);
  assert.equal(err(await rpc.handle({ req_id: 'p3', op: 'im.message_page', args: { gid: GID, before_ms: 123 } })), 'adapter.failed');
});

test('rpc: history cursor follows raw rows even when the oldest row is not displayed', async () => {
  const { rpc, base } = setup(call => !call.url.includes('getMessageList')
    ? jsonResponse({ ResponseStatus: OK_STATUS, members: [] })
    : jsonResponse({ ResponseStatus: OK_STATUS, rangeMessage: {
      isDone: false, lastMessageTime: 1700000000200,
      messages: [
        { msgId: 'visible', messageBody: 'visible', fromJid: 'me@x', createTime: 1700000000200, msgtype: 0 },
        { msgId: 'hidden', messageBody: '{"isPresent":false}', createTime: 1700000000100, msgtype: 1007 },
      ],
    } }));
  const result = ok(await rpc.handle({ req_id: 'short-page', op: 'im.message_page', args: { gid: GID } })) as {
    items: { message_id: string }[]; has_more: boolean; before_ms: number;
  };
  assert.deepEqual(result.items.map(item => item.message_id), ['visible']);
  assert.equal(result.has_more, true, 'short pages are not completion evidence');
  assert.equal(result.before_ms, 1700000000100, 'use oldest raw row, not newest lastMessageTime or displayed row');
  await rpc.handle({ req_id: 'older', op: 'im.message_page', args: { gid: GID, before_ms: result.before_ms } });
  const calls = base.fakeFetch.calls.filter(call => call.url.includes('getMessageList'));
  assert.equal((calls[1]?.bodyJson as { endTime: number }).endTime, result.before_ms);
});

test('rpc: incomplete history without cursor progress fails retryably before publication', async () => {
  for (const messages of [
    [],
    [{ msgId: 'invalid-time', createTime: 'invalid', msgtype: 0, messageBody: 'body' }],
    [{ msgId: 'same-boundary', createTime: 1700000000100, msgtype: 0, messageBody: 'body' }],
    [{ msgId: 'newer-boundary', createTime: 1700000000200, msgtype: 0, messageBody: 'body' }],
  ]) {
    const { rpc, facts, displays, sdk } = setup(call => !call.url.includes('getMessageList')
      ? jsonResponse({ ResponseStatus: OK_STATUS, members: [] })
      : jsonResponse({ ResponseStatus: OK_STATUS, rangeMessage: { isDone: false, messages } }));
    const reply = await rpc.handle({ req_id: 'stalled-page', op: 'im.message_page', args: { gid: GID, before_ms: 1700000000100 } });
    assert.equal(err(reply), 'adapter.failed');
    assert.ok(reply && !reply.ok && reply.error.retryable);
    assert.deepEqual(facts, []);
    assert.deepEqual(displays, []);
    assert.equal(sdk.sent.length, 0);
  }
});

test('rpc: a server-confirmed empty terminal page is successful completion', async () => {
  const { rpc } = setup(call => !call.url.includes('getMessageList')
    ? jsonResponse({ ResponseStatus: OK_STATUS, members: [] })
    : jsonResponse({ ResponseStatus: OK_STATUS, rangeMessage: { isDone: true, messages: [] } }));
  assert.deepEqual(ok(await rpc.handle({ req_id: 'terminal', op: 'im.message_page', args: { gid: GID } })), {
    items: [], has_more: false, before_ms: null,
  });
});

test('rpc: notice.categories flattens sub-categories; notice.mark_read uses lastMsgId', async () => {
  const { base, rpc } = setup((call) =>
    call.url.includes('getIQConversations')
      ? jsonResponse({ ResponseStatus: OK_STATUS, categoryList: [{ categoryId: 3, categoryName: 'P', categorySubList: [{ categoryId: 112, categoryName: '订单', unreadCount: 7, lastMsgTime: 1700000000000, lastMsgId: 'iq-1' }] }] })
      : jsonResponse({ ResponseStatus: OK_STATUS }),
  );
  assert.deepEqual(ok(await rpc.handle({ req_id: 'r', op: 'notice.categories', args: {} })), [{ id: '3:112', name: '订单', unread: 7 }]);
  assert.equal(ok(await rpc.handle({ req_id: 'r', op: 'notice.mark_read', args: { category_id: '3:112', id: null } })), null);
  const last = base.fakeFetch.calls.at(-1);
  assert.ok(last?.url.includes('putAdviceofreadIQMessage'));
  const b = last?.bodyJson as Record<string, unknown>;
  assert.deepEqual([b['categoryId'], b['categorySubId'], b['msgId']], [3, 112, 'iq-1']);
});

test('rpc: notice.list uses cursor zero for the latest page, category unread boundary, then explicit before_ms', async () => {
  const latest = 1700000000123;
  const boundary = latest - 1;
  const message = { msgId: '9007199254740993', createTime: latest, messageBody: JSON.stringify({ ext: { title: '最新通知', desc: '正文' } }) };
  const { base, rpc } = setup(call => call.url.includes('getIQConversations')
    ? jsonResponse({ ResponseStatus: OK_STATUS, categoryList: [{ categoryId: 3, categorySubList: [{ categoryId: 112, categoryName: '订单', unreadCount: 1, unreadTimeline: boundary, lastMsgTime: latest, lastMsgId: message.msgId }] }] })
    : jsonResponse({ ResponseStatus: OK_STATUS, iqMessages: [message] }));
  await rpc.handle({ req_id: 'categories', op: 'notice.categories', args: {} });
  const first = ok(await rpc.handle({ req_id: 'first', op: 'notice.list', args: { category_id: '3:112' } }));
  assert.deepEqual(first, [{ id: message.msgId, category_id: '3:112', title: '最新通知', body: '正文', time_ms: latest, unread: true, url: '' }]);
  assert.equal((base.fakeFetch.calls.at(-1)?.bodyJson as { lastMsgTime: number }).lastMsgTime, 0);
  await rpc.handle({ req_id: 'null', op: 'notice.list', args: { category_id: '3:112', before_ms: null } });
  assert.equal((base.fakeFetch.calls.at(-1)?.bodyJson as { lastMsgTime: number }).lastMsgTime, 0);
  await rpc.handle({ req_id: 'older', op: 'notice.list', args: { category_id: '3:112', before_ms: boundary } });
  assert.equal((base.fakeFetch.calls.at(-1)?.bodyJson as { lastMsgTime: number }).lastMsgTime, boundary);
  const calls = base.fakeFetch.calls.length;
  for (const before_ms of [-1, 1.5, Infinity, '0', Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(err(await rpc.handle({ req_id: 'invalid', op: 'notice.list', args: { category_id: '3:112', before_ms } })), 'adapter.failed');
  }
  assert.equal(base.fakeFetch.calls.length, calls, 'invalid cursors do not request upstream');
});

test('rpc: notice page with 100 raw rows and one duplicate keeps array length for pagination', async () => {
  const rows = Array.from({ length: 99 }, (_, i) => ({ msgId: String(1000 + i), createTime: 1700000000000 - i, messageBody: JSON.stringify({ ext: { title: String(i) } }) }));
  rows.push(rows[98]!);
  const { base, rpc } = setup(() => jsonResponse({ ResponseStatus: OK_STATUS, iqMessages: rows }));
  const page = ok(await rpc.handle({ req_id: 'page', op: 'notice.list', args: { category_id: '3:112' } })) as { id: string; time_ms: number }[];
  assert.equal(page.length, 100, 'the UI must see a full raw page even when it deduplicates to 99 displayed rows');
  assert.equal(new Set(page.map(row => row.id)).size, 99);
  await rpc.handle({ req_id: 'older', op: 'notice.list', args: { category_id: '3:112', before_ms: page[0]?.time_ms } });
  assert.equal((base.fakeFetch.calls[1]?.bodyJson as { lastMsgTime: number }).lastMsgTime, 1699999999902);
});

test('rpc: notice malformed and business failures are errors, not successful empty arrays', async () => {
  for (const body of [{ ResponseStatus: OK_STATUS }, { ResponseStatus: OK_STATUS, iqMessages: [] , success: false }, { ResponseStatus: { Ack: 'Failure', Errors: [{ ErrorCode: 'Denied' }] } }]) {
    const { rpc } = setup(() => jsonResponse(body));
    assert.equal(err(await rpc.handle({ req_id: 'bad', op: 'notice.list', args: { category_id: '3:112' } })), 'adapter.failed');
  }
});

test('rpc: latest category request owns cached unread boundary and mark-all message ID', async () => {
  const releases: ((body: unknown) => void)[] = [];
  const { base, rpc, displays } = setup(call => {
    if (call.url.includes('getIQConversations')) return new Promise(resolve => releases.push(body => resolve(jsonResponse(body))));
    if (call.url.includes('getIQMessages')) return jsonResponse({ ResponseStatus: OK_STATUS, iqMessages: [{ msgId: 'middle', createTime: 150, messageBody: JSON.stringify({ ext: { title: 'middle notice' } }) }] });
    return jsonResponse({ ResponseStatus: OK_STATUS });
  });
  const categoryBody = (unreadTimeline: number, lastMsgId: string) => ({ ResponseStatus: OK_STATUS, categoryList: [{ categoryId: 3, categorySubList: [{ categoryId: 112, categoryName: lastMsgId, unreadCount: 1, unreadTimeline, lastMsgId }] }] });
  const old = rpc.handle({ req_id: 'old', op: 'notice.categories', args: {} });
  const latest = rpc.handle({ req_id: 'latest', op: 'notice.categories', args: {} });
  releases[1]?.(categoryBody(200, 'new-id'));
  assert.deepEqual(ok(await latest), [{ id: '3:112', name: 'new-id', unread: 1 }]);
  releases[0]?.(categoryBody(100, 'old-id'));
  assert.equal(err(await old), 'adapter.not_ready');
  assert.deepEqual(displays, [{ kind: 'notice_categories', items: [{ id: '3:112', name: 'new-id', unread: 1 }] }]);
  const items = ok(await rpc.handle({ req_id: 'list', op: 'notice.list', args: { category_id: '3:112' } })) as { unread: boolean }[];
  assert.equal(items[0]?.unread, false, '150 must use the latest unread boundary 200');
  assert.equal(ok(await rpc.handle({ req_id: 'mark', op: 'notice.mark_read', args: { category_id: '3:112', id: null } })), null);
  assert.equal((base.fakeFetch.calls.at(-1)?.bodyJson as { msgId: string }).msgId, 'new-id');
});

test('rpc: a newer failed category request still prevents older success from publishing or filling the cache', async () => {
  const releases: ((body: unknown) => void)[] = [];
  const { base, rpc, displays } = setup(() => new Promise(resolve => releases.push(body => resolve(jsonResponse(body)))));
  const old = rpc.handle({ req_id: 'old', op: 'notice.categories', args: {} });
  const latest = rpc.handle({ req_id: 'latest', op: 'notice.categories', args: {} });
  releases[1]?.({ ResponseStatus: { Ack: 'Failure', Errors: [{ ErrorCode: 'Denied' }] } });
  assert.equal(err(await latest), 'adapter.failed');
  releases[0]?.({ ResponseStatus: OK_STATUS, categoryList: [{ categoryId: 3, categorySubList: [{ categoryId: 112, lastMsgId: 'stale-id' }] }] });
  assert.equal(err(await old), 'adapter.not_ready');
  assert.deepEqual(displays, []);
  const calls = base.fakeFetch.calls.length;
  assert.equal(err(await rpc.handle({ req_id: 'mark', op: 'notice.mark_read', args: { category_id: '3:112', id: null } })), 'adapter.not_ready');
  assert.equal(base.fakeFetch.calls.length, calls, 'stale category success must not seed a later write');
});

test('rpc: stale notice requests cannot publish categories or return another lifecycle list', async () => {
  for (const op of ['notice.categories', 'notice.list'] as const) {
    let release: () => void = () => {};
    let active = true;
    const body = op === 'notice.categories' ? { categoryList: [{ categoryId: 3, categorySubList: [{ categoryId: 112 }] }] } : { iqMessages: [] };
    const { ctx, displays } = setup(() => new Promise(resolve => { release = () => resolve(jsonResponse({ ResponseStatus: OK_STATUS, ...body })); }));
    const rpc = createRpc({ ...ctx, captureWriteGuard: () => () => active });
    const pending = rpc.handle({ req_id: op, op, args: { category_id: '3:112' } });
    await flush();
    active = false;
    release();
    assert.equal(err(await pending), 'adapter.not_ready');
    assert.deepEqual(displays, []);
  }
});

test('rpc: agent.status reads currentStatus; set_status writes once then reads back', async () => {
  const { base, rpc } = setup((call) => (call.url.includes('getConversationList') ? jsonResponse({ ResponseStatus: OK_STATUS, currentStatus: 1, conversationList: [] }) : jsonResponse({ ResponseStatus: OK_STATUS })));
  assert.deepEqual(ok(await rpc.handle({ req_id: 'r', op: 'agent.status', args: {} })), { status: 'hangup', confirmed: true });
  assert.deepEqual(ok(await rpc.handle({ req_id: 'r', op: 'agent.set_status', args: { status: 'hangup' } })), { status: 'hangup', confirmed: true });
  const writes = base.fakeFetch.calls.filter((c) => c.url.includes('setVenAgentStatus'));
  assert.equal(writes.length, 1);
  assert.equal((writes[0]?.bodyJson as { agentStatus: number }).agentStatus, 1);
});

test('rpc: invalid order.search, create_im_chat resolves gid via the cached order row; unknown op / malformed', async () => {
  const { ctx } = setup(() => jsonResponse({ ResponseStatus: OK_STATUS, response: { errorCode: 0 }, url: 'https://imvendor.ctrip.com/main?initChat=2&serviceType=1513&orderNo=1234567890&accountsource=VBK&targetGid=123456' }));
  const rpc = createRpc({ ...ctx, ensureOrderConversation: async (gid, orderId) => ctx.store.view(gid)?.orderId === orderId });
  assert.equal(err(await rpc.handle({ req_id: 'r', op: 'order.search', args: { order_id: '1' } })), 'adapter.failed');
  assert.deepEqual(ok(await rpc.handle({ req_id: 'r', op: 'order.create_im_chat', args: { order_id: '1234567890' } })), { gid: GID, reused: true });
  assert.equal(err(await rpc.handle({ req_id: 'r', op: 'nope', args: {} })), 'host.unsupported');
  assert.equal(await rpc.handle({ op: 'im.messages' }), null);
  assert.equal(await rpc.handle(null), null);
});

const member = (uid: string, roles = [0, 3, 4], status = '1') => ({ uid, nick: uid, status, roles });
const membersBody = (members: unknown[]) => ({ ResponseStatus: OK_STATUS, status: { code: 0, msg: '' }, members });
const peripheralOk = { ResponseStatus: OK_STATUS, bizResponseStatus: { resultCode: 'SUCCESS' } };
const perRequest = (op: string, args: unknown, req_id = op) => ({ req_id, op, args });

const INIT_ORDER = '1234567890123456';
const INIT_GID = '9007199254740993';
function orderInitUrl(overrides: Record<string, string> = {}): string {
  return 'https://imvendor.ctrip.com/main?' + new URLSearchParams({ initChat: '2', serviceType: '1513', vendorRole: 'VBK', vendorRefId: 'ref1', threadId: 'thread1', orderNo: INIT_ORDER, targetGid: '', accountsource: 'VBK', 'client-source': 'pc-1001', ...overrides });
}
const orderCreateRequest = (req_id: string) => ({ req_id, op: 'order.create_im_chat', args: { order_id: INIT_ORDER } });

test('rpc order init: empty target executes B2C once, shares duplicate clicks, and ensures the exact order before return', async () => {
  const { base, ctx } = setup(call => call.url.includes('createimchat')
    ? jsonResponse({ ResponseStatus: OK_STATUS, response: { errorCode: 0 }, url: orderInitUrl() })
    : jsonResponse({ ResponseStatus: OK_STATUS, workSheetId: 'ws1', groupId: INIT_GID }));
  const ensured: [string, string][] = [];
  const rpc = createRpc({ ...ctx, ensureOrderConversation: async (gid, order, current) => { assert.equal(current(), true); ensured.push([gid, order]); return true; } });
  const [one, duplicate] = await Promise.all([rpc.handle(orderCreateRequest('one')), rpc.handle(orderCreateRequest('duplicate'))]);
  assert.deepEqual(ok(one), { gid: INIT_GID, reused: false });
  assert.deepEqual(ok(duplicate), { gid: INIT_GID, reused: false });
  assert.equal(base.fakeFetch.calls.length, 2);
  assert.ok(base.fakeFetch.calls[0]?.url.includes('createimchat'));
  assert.ok(base.fakeFetch.calls[1]?.url.includes('startChatB2C'));
  assert.deepEqual(ensured, [[INIT_GID, INIT_ORDER], [INIT_GID, INIT_ORDER]]);
  await rpc.handle(orderCreateRequest('later'));
  assert.equal(base.fakeFetch.calls.length, 2, 'confirmed result is retained instead of creating again');
});

test('rpc order init: failed read-back retains confirmed gid and a repeated click retries only read-back', async () => {
  const { base, ctx } = setup(call => call.url.includes('createimchat')
    ? jsonResponse({ ResponseStatus: OK_STATUS, response: { errorCode: 0 }, url: orderInitUrl() })
    : jsonResponse({ ResponseStatus: OK_STATUS, sWorkSheetId: 'ws1', groupId: INIT_GID }));
  let reads = 0;
  const rpc = createRpc({ ...ctx, ensureOrderConversation: async () => ++reads > 1 });
  assert.equal(err(await rpc.handle(orderCreateRequest('first'))), 'adapter.not_ready');
  assert.deepEqual(ok(await rpc.handle(orderCreateRequest('retry'))), { gid: INIT_GID, reused: false });
  assert.equal(reads, 2);
  assert.equal(base.fakeFetch.calls.length, 2);
});

test('rpc order init: an existing target is read back without a second initialization write', async () => {
  const { base, ctx } = setup(() => jsonResponse({ ResponseStatus: OK_STATUS, response: { errorCode: 0 }, url: orderInitUrl({ targetGid: INIT_GID }) }));
  const rpc = createRpc({ ...ctx, ensureOrderConversation: async () => true });
  assert.deepEqual(ok(await rpc.handle(orderCreateRequest('target'))), { gid: INIT_GID, reused: false });
  assert.equal(base.fakeFetch.calls.length, 1);
});

test('rpc order init: mismatched orders, unsupported branches and missing business status never cause initialization', async () => {
  for (const response of [
    { ResponseStatus: OK_STATUS, response: { errorCode: 0 }, url: orderInitUrl({ orderNo: '9999999999999999' }) },
    { ResponseStatus: OK_STATUS, response: { errorCode: 0 }, url: orderInitUrl({ initChat: '1' }) },
    { ResponseStatus: OK_STATUS, response: { errorCode: 0 }, url: orderInitUrl({ accountsource: 'other' }) },
    { ResponseStatus: OK_STATUS, url: orderInitUrl() },
  ]) {
    const { base, ctx } = setup(() => jsonResponse(response));
    const rpc = createRpc({ ...ctx, ensureOrderConversation: async () => true });
    const result = await rpc.handle(orderCreateRequest('bad'));
    assert.ok(result && !result.ok);
    await rpc.handle(orderCreateRequest('repeat'));
    assert.equal(base.fakeFetch.calls.length, 1, 'a rejected attempt is retained, never blindly replayed');
  }
});

test('rpc order init: an absent authoritative read-back hook cannot return a cached row as fresh proof', async () => {
  const { rpc } = setup(() => jsonResponse({ ResponseStatus: OK_STATUS, response: { errorCode: 0 }, url: orderInitUrl({ targetGid: INIT_GID }) }));
  assert.equal(err(await rpc.handle(orderCreateRequest('missing-proof'))), 'adapter.not_ready');
});

test('rpc order init: explicit creation rejection cannot be hidden by an existing cached order', async () => {
  const { base, ctx } = setup(() => jsonResponse({ ResponseStatus: OK_STATUS, response: { errorCode: 1 }, url: orderInitUrl({ orderNo: '1234567890' }) }));
  let reads = 0;
  const rpc = createRpc({ ...ctx, ensureOrderConversation: async () => { ++reads; return true; } });
  assert.equal(err(await rpc.handle({ req_id: 'cached', op: 'order.create_im_chat', args: { order_id: '1234567890' } })), 'adapter.failed');
  assert.equal(reads, 0);
  assert.equal(base.fakeFetch.calls.length, 1);
});

test('rpc order init: lifecycle change after createimchat prevents the B2C write', async () => {
  let active = true;
  const { base, ctx } = setup(() => { active = false; return jsonResponse({ ResponseStatus: OK_STATUS, response: { errorCode: 0 }, url: orderInitUrl() }); });
  const rpc = createRpc({ ...ctx, captureWriteGuard: () => () => active, ensureOrderConversation: async () => true });
  assert.equal(err(await rpc.handle(orderCreateRequest('stale'))), 'adapter.not_ready');
  assert.equal(base.fakeFetch.calls.length, 1);
});

test('rpc order init: an unknown write cannot be reconciled from an older cached order row', async () => {
  const { base, ctx } = setup(() => 'hang');
  let reads = 0;
  const rpc = createRpc({ ...ctx, ensureOrderConversation: async () => { ++reads; return true; } });
  const request = { req_id: 'cached-unknown', op: 'order.create_im_chat', args: { order_id: '1234567890' } };
  const pending = rpc.handle(request);
  await base.clock.advance(15000);
  assert.equal(err(await pending), 'adapter.timeout');
  assert.equal(err(await rpc.handle({ ...request, req_id: 'repeat-cached' })), 'adapter.timeout');
  assert.equal(reads, 0);
  assert.equal(base.fakeFetch.calls.length, 1);
});

test('rpc order init: unknown create or initialize outcomes are retained and duplicate clicks cannot repeat writes', async () => {
  for (const unknownStep of ['createimchat', 'startChatB2C']) {
    const { base, ctx } = setup(call => call.url.includes(unknownStep) ? 'hang' : jsonResponse({ ResponseStatus: OK_STATUS, response: { errorCode: 0 }, url: orderInitUrl() }));
    const rpc = createRpc({ ...ctx, ensureOrderConversation: async () => true });
    const pending = rpc.handle(orderCreateRequest('unknown'));
    await base.clock.advance(15000);
    assert.equal(err(await pending), 'adapter.timeout');
    assert.equal(err(await rpc.handle(orderCreateRequest('repeat'))), 'adapter.timeout');
    assert.equal(base.fakeFetch.calls.length, unknownStep === 'createimchat' ? 1 : 2);
  }
});

test('rpc peripheral: scripts expose empty or unsupported raw count without guessing malformed text fields', async () => {
  const { rpc } = setup((_, i) => jsonResponse({ ResponseStatus: OK_STATUS, customerScripts: i === 0 ? [] : [{ mystery: 'not approved reply text' }] }));
  assert.deepEqual(ok(await rpc.handle(perRequest('im.customer_scripts', { content: '' }))), { kind: 'empty', raw_count: 0, items: [] });
  const result = ok(await rpc.handle(perRequest('im.customer_scripts', { content: 'search' }))) as { kind: string; raw_count: number };
  assert.equal(result.kind, 'unsupported'); assert.equal(result.raw_count, 1);
  assert.equal(JSON.stringify(result).includes('not approved reply text'), false);
});

test('rpc peripheral: candidates exclude self/current members, reject unselected uid and expire tokens without a write', async () => {
  const { rpc, base } = setup((call) => jsonResponse(call.url.includes('getInviteMemberList') ? {
    ...peripheralOk, results: [{ skillGroupList: [{ skillGroupId: 7, skillGroupName: 'Team' }], agentInfoList: ['ME', 'present', '900719925474099312345'].map(agentUid => ({ agentUid, nickname: agentUid })) }],
  } : membersBody([member('me', [3, 4, 4]), member('present')])));
  const data = ok(await rpc.handle(perRequest('im.invite_candidates', { gid: GID }))) as { agents: { uid: string; in_group?: boolean }[]; selection_token: string };
  // Like the official tree: current members stay visible but disabled, self is hidden.
  assert.deepEqual(data.agents.map(a => [a.uid, a.in_group]), [['present', true], ['900719925474099312345', false]]);
  const invalid = await rpc.handle(perRequest('im.invite', { gid: GID, selection_token: data.selection_token, target_uids: ['not-selected'] }));
  assert.match(notSubmitted(invalid), /explicitly selected/);
  assert.match(notSubmitted(await rpc.handle(perRequest('im.invite', { gid: GID, selection_token: data.selection_token, target_uids: ['present'] }, 'present'))), /explicitly selected/);
  await base.clock.advance(30_000);
  assert.match(notSubmitted(await rpc.handle(perRequest('im.invite', { gid: GID, selection_token: data.selection_token, target_uids: ['900719925474099312345'] }))), /expired/);
  assert.equal(base.fakeFetch.calls.some(c => c.url.includes('/inviteVenAgent')), false);
});

test('rpc peripheral: invite accepted needs independent membership readback and duplicate click never writes twice', async () => {
  let reads = 0;
  const { rpc, base } = setup((call) => {
    if (call.url.includes('getInviteMemberList')) return jsonResponse({ ...peripheralOk, results: [{ agentInfoList: [{ agentUid: 'chosen', nickname: 'Chosen' }] }] });
    if (call.url.includes('/inviteVenAgent')) return jsonResponse({ ResponseStatus: OK_STATUS, sessionId: `sess-${GID}`, workSheetId: '9001' });
    reads++;
    return jsonResponse(membersBody(reads >= 3 ? [member('chosen')] : []));
  });
  const candidates = ok(await rpc.handle(perRequest('im.invite_candidates', { gid: GID }))) as { selection_token: string };
  const req = perRequest('im.invite', { gid: GID, selection_token: candidates.selection_token, target_uids: ['chosen'] });
  const result = ok(await rpc.handle(req));
  assert.deepEqual(result, { kind: 'confirmed', confirmed: true });
  assert.deepEqual(ok(await rpc.handle({ ...req, req_id: 'duplicate' })), result);
  assert.equal(base.fakeFetch.calls.filter(c => c.url.includes('/inviteVenAgent')).length, 1);
});

test('rpc peripheral: member change between selection and invite prevents submission', async () => {
  let reads = 0;
  const { rpc, base } = setup((call) => {
    if (call.url.includes('getInviteMemberList')) return jsonResponse({ ...peripheralOk, results: [{ agentInfoList: [{ agentUid: 'chosen' }] }] });
    return jsonResponse(membersBody(++reads > 1 ? [member('chosen')] : []));
  });
  const candidates = ok(await rpc.handle(perRequest('im.invite_candidates', { gid: GID }))) as { selection_token: string };
  assert.match(notSubmitted(await rpc.handle(perRequest('im.invite', { gid: GID, selection_token: candidates.selection_token, target_uids: ['chosen'] }))), /already a current member/);
  assert.equal(base.fakeFetch.calls.some(c => c.url.includes('/inviteVenAgent')), false);
});

test('rpc peripheral: transfer uses actual present merchant selection and exact master readback', async () => {
  let transferred = false;
  const { rpc, base } = setup((call) => {
    if (call.url.includes('/transferVenMaster')) { transferred = true; return jsonResponse(peripheralOk); }
    return jsonResponse(membersBody([member('me', [3, 4, 4]), member('chosen', transferred ? [3, 4, 4] : [0, 3, 4]), member('former', [0, 3, 4], '2'), member('customer', [0, 1, 1])]));
  });
  const data = ok(await rpc.handle(perRequest('im.members', { gid: GID }))) as { selection_token: string };
  assert.match(notSubmitted(await rpc.handle(perRequest('im.transfer', { gid: GID, selection_token: data.selection_token, target_uid: 'former' }))), /explicitly selected/);
  assert.match(notSubmitted(await rpc.handle(perRequest('im.transfer', { gid: GID, selection_token: data.selection_token, target_uid: 'customer' }))), /explicitly selected/);
  const req = perRequest('im.transfer', { gid: GID, selection_token: data.selection_token, target_uid: 'chosen' });
  assert.deepEqual(ok(await rpc.handle(req)), { kind: 'confirmed', confirmed: true });
  assert.deepEqual(ok(await rpc.handle(req)), { kind: 'confirmed', confirmed: true });
  assert.equal(base.fakeFetch.calls.filter(c => c.url.includes('/transferVenMaster')).length, 1);
});

test('rpc peripheral: finish missing real key is unsupported, matching session is required for confirmation', async () => {
  const { rpc, store, base } = setup((call) => jsonResponse(call.url.includes('checkMemberStatus') ? membersBody([]) : call.url.includes('/finishConversation') ? peripheralOk : { ...peripheralOk, conversation: { gid: GID, sessionId: 'different-session', status: 4, inGroup: -1 } }));
  store.update([sampleRow(GID, { conversationKey: null })]);
  assert.match(notSubmitted(await rpc.handle(perRequest('im.finish', { gid: GID, selection_token: await memberSelection(rpc) }))), /missing conversationKey/);
  assert.equal(base.fakeFetch.calls.filter(c => c.url.includes('/finishConversation')).length, 0);
  store.update([sampleRow(GID, { conversationKey: 'actual-key' })]);
  const req = perRequest('im.finish', { gid: GID, selection_token: await memberSelection(rpc) });
  const result = ok(await rpc.handle(req)) as { kind: string; confirmed: boolean };
  assert.equal(result.kind, 'accepted'); assert.equal(result.confirmed, false);
  await rpc.handle(req);
  assert.equal(base.fakeFetch.calls.filter(c => c.url.includes('/finishConversation')).length, 1);
});

test('rpc peripheral: unknown write reads back but does not retry or invent confirmation', async () => {
  const { rpc, store, base } = setup((call) => call.url.includes('/finishConversation') ? new Error('transport lost') : call.url.includes('checkMemberStatus') ? jsonResponse(membersBody([])) : jsonResponse({ ...peripheralOk, conversation: { gid: GID, sessionId: 'sid-1', status: 2, inGroup: 1 } }));
  store.update([sampleRow(GID, { conversationKey: 'actual-key' })]);
  const req = perRequest('im.finish', { gid: GID, selection_token: await memberSelection(rpc) });
  const result = ok(await rpc.handle(req)) as { kind: string; confirmed: boolean };
  assert.equal(result.kind, 'unknown'); assert.equal(result.confirmed, false);
  assert.deepEqual(ok(await rpc.handle(req)), result);
  assert.equal(base.fakeFetch.calls.filter(c => c.url.includes('/finishConversation')).length, 1);
  assert.equal(base.fakeFetch.calls.filter(c => c.url.includes('/getLatestConversationByGid')).length, 1);
});

test('rpc peripheral: metadata enrichment cannot replay an unknown action in the same service session', async () => {
  const { rpc, store, base } = setup((call) => call.url.includes('/finishConversation') ? new Error('transport lost') : call.url.includes('checkMemberStatus') ? jsonResponse(membersBody([])) : jsonResponse({ ...peripheralOk, conversation: { gid: GID, sessionId: `sess-${GID}`, status: 2, inGroup: 1 } }));
  const req = perRequest('im.finish', { gid: GID, selection_token: await memberSelection(rpc) });
  const first = ok(await rpc.handle(req));
  store.update([sampleRow(GID, { conversationKey: 'newly-enriched-key', serviceType: '2384' })]);
  assert.deepEqual(ok(await rpc.handle(req)), first);
  assert.equal(base.fakeFetch.calls.filter(c => c.url.includes('/finishConversation')).length, 1);
});

test('rpc lifecycle guard: send held behind history cannot submit after generation changes', async () => {
  let release!: (v: ReturnType<typeof jsonResponse>) => void;
  const { ctx, store, sdk, base } = setup((call) => call.url.includes('/getMessageList') ? new Promise(resolve => { release = resolve; }) : jsonResponse({ ResponseStatus: OK_STATUS, members: [] }));
  store.update([sampleRow(GID, { lastMessageJsonString: '' })]);
  let generation = 1;
  const guarded = createRpc({ ...ctx, captureWriteGuard: () => { const captured = generation; return () => generation === captured; } });
  const result = guarded.handle(send('guarded'));
  await flush();
  generation += 2; // stop followed by restart still invalidates old work
  release(jsonResponse({ ResponseStatus: OK_STATUS, rangeMessage: { isDone: true, messages: [{ msgId: 'history', messageBody: 'old', fromJid: `${GID}@conf.x/customer`, toJid: 'me@im.x', createTime: 1700000000500, msgtype: 0 }] } }));
  assert.equal(err(await result), 'adapter.not_ready');
  assert.equal(sdk.sent.length, 0);
  assert.ok(base.fakeFetch.calls.some(c => c.url.includes('/getMessageList')));
});

test('rpc peripheral lifecycle: stale run selection and preflight completion cannot submit a write', async () => {
  let preflight = false;
  let release!: (v: ReturnType<typeof jsonResponse>) => void;
  const { ctx, base } = setup((call) => {
    if (call.url.includes('getInviteMemberList')) return jsonResponse({ ...peripheralOk, results: [{ agentInfoList: [{ agentUid: 'chosen' }] }] });
    if (preflight) return new Promise(resolve => { release = resolve; });
    return jsonResponse(membersBody([]));
  });
  let generation = 1;
  const rpc = createRpc({ ...ctx, captureWriteGuard: () => { const captured = generation; return () => generation === captured; } });
  const old = ok(await rpc.handle(perRequest('im.invite_candidates', { gid: GID }))) as { selection_token: string };
  generation += 2;
  assert.match(notSubmitted(await rpc.handle(perRequest('im.invite', { gid: GID, selection_token: old.selection_token, target_uids: ['chosen'] }))), /expired/);
  const fresh = ok(await rpc.handle(perRequest('im.invite_candidates', { gid: GID }))) as { selection_token: string };
  preflight = true;
  const pending = rpc.handle(perRequest('im.invite', { gid: GID, selection_token: fresh.selection_token, target_uids: ['chosen'] }));
  await flush();
  generation += 2;
  release(jsonResponse(membersBody([])));
  assert.match(notSubmitted(await pending), /session changed/);
  assert.equal(base.fakeFetch.calls.some(c => c.url.includes('/inviteVenAgent')), false);
});

test('rpc peripheral: invite missing ack identifiers is unknown and read-back alone may confirm, never a second write', async () => {
  let written = false;
  const { rpc, base } = setup((call) => {
    if (call.url.includes('getInviteMemberList')) return jsonResponse({ ...peripheralOk, results: [{ agentInfoList: [{ agentUid: 'chosen' }] }] });
    if (call.url.includes('/inviteVenAgent')) { written = true; return jsonResponse({ ResponseStatus: OK_STATUS }); }
    return jsonResponse(membersBody(written ? [member('chosen')] : []));
  });
  const choices = ok(await rpc.handle(perRequest('im.invite_candidates', { gid: GID }))) as { selection_token: string };
  const req = perRequest('im.invite', { gid: GID, selection_token: choices.selection_token, target_uids: ['chosen'] });
  assert.deepEqual(ok(await rpc.handle(req)), { kind: 'confirmed', confirmed: true });
  assert.deepEqual(ok(await rpc.handle(req)), { kind: 'confirmed', confirmed: true });
  assert.equal(base.fakeFetch.calls.filter(c => c.url.includes('/inviteVenAgent')).length, 1);
});

test('rpc: same gid replacement cannot acknowledge the former customer latest message', async () => {
  const { sdk, rpc, store, ctx } = setup();
  const oldRevision = readRevision(ctx);
  store.update([sampleRow(GID, { uid: 'new-customer', sessionId: 'new-session', lastMessageTime: 1700000000400,
    lastMessageJsonString: JSON.stringify({ msgId: 'new-customer-message', fromJid: 'new-customer@im.x', toJid: `${GID}@conf.x`, createTime: 1700000000400, msgtype: 0 }) })]);
  assert.equal(store.view(GID)?.customerUid, 'new-customer');
  const r = await rpc.handle({ req_id: 'stale-customer-read', op: 'im.mark_read', args: { gid: GID, expected_context_revision: oldRevision, expected_message_id: `m-${GID}` } });
  assert.equal(r?.ok, false);
  assert.equal(sdk.readReceipts.length, 0);
  const currentRevision = readRevision(ctx);
  assert.notEqual(currentRevision, oldRevision);
  assert.equal(store.latestMessage(GID)?.msgId, 'new-customer-message');
  // Only a current authoritative server row may advance the receipt boundary.
  store.update([sampleRow(GID, { uid: 'new-customer', sessionId: 'new-session', lastMessageTime: 1700000000800,
    lastMessageJsonString: JSON.stringify({ msgId: 'current-customer-message', fromJid: 'new-customer@im.x', toJid: `${GID}@conf.x`, createTime: 1700000000800, msgtype: 0 }) })]);
  assert.equal(ok(await rpc.handle({ req_id: 'current-customer-read', op: 'im.mark_read', args: { gid: GID, expected_context_revision: currentRevision, expected_message_id: 'current-customer-message' } })), null);
  assert.deepEqual(sdk.readReceipts.map(r => r.msgId), ['current-customer-message']);
});

test('rpc: a receipt completion from a replaced service cannot acknowledge the new context', async () => {
  const { sdk, rpc, store } = setup();
  const expected_context_revision = store.assistantContextRevision(GID, 'me', `${GID}@conf.x`);
  let release!: () => void;
  sdk.putAdviceOfReadByMsgId = async () => { await new Promise<void>(resolve => { release = resolve; }); return { kind: 'success', raw: null }; };
  const pending = rpc.handle({ req_id: 'held-read', op: 'im.mark_read', args: { gid: GID, expected_message_id: `m-${GID}`, expected_context_revision } });
  await flush(); store.update([sampleRow(GID, { uid: 'new-customer', sessionId: 'new-session' })]);
  release(); assert.equal((await pending)?.ok, false);
});
test('rpc: reused gid cannot use an SDK room cached from the former service', async () => {
  const { sdk, rpc, store } = setup();
  sdk.rememberPartnerJid(GID, `${GID}@old-domain`);
  store.update([sampleRow(GID, { uid: 'new-customer', sessionId: 'new-session' })]);
  const expected_context_revision = store.assistantContextRevision(GID, 'me', `${GID}@old-domain`);
  const result = await rpc.handle({ req_id: 'old-room', op: 'im.mark_read', args: { gid: GID, expected_message_id: `m-${GID}`, expected_context_revision } });
  assert.equal(result?.ok, false); assert.equal(sdk.readReceipts.length, 0);
});

test('rpc: history request from a stale UI revision fails before any history transport', async () => {
  const { base, rpc, store } = setup();
  const expected_context_revision = store.assistantContextRevision(GID, 'me', `${GID}@conf.x`);
  store.update([sampleRow(GID, { uid: 'B', sessionId: 'session-B' })]);
  const result = await rpc.handle({ req_id: 'stale-ui-history', op: 'im.message_page', args: { gid: GID, expected_context_revision } });
  assert.equal(result?.ok, false);
  assert.equal(base.fakeFetch.calls.some(c => c.url.includes('getMessageList')), false);
});

test('rpc: even the first service cannot acknowledge through an unrelated cached SDK room', async () => {
  const { sdk, rpc, store } = setup();
  sdk.rememberPartnerJid(GID, `${GID}@old-domain`);
  const expected_context_revision = store.assistantContextRevision(GID, 'me', `${GID}@old-domain`);
  const result = await rpc.handle({ req_id: 'first-service-old-room', op: 'im.mark_read', args: { gid: GID, expected_message_id: `m-${GID}`, expected_context_revision } });
  assert.equal(result?.ok, false); assert.equal(sdk.readReceipts.length, 0);
});

// ------------------------------------------------------------- I-30 feature ops via adapter://request

const GID19 = '1234567890123456789';
const MSG19 = '9876543210987654321';

test('rpc: feature ops (typing/recall/queue) are reachable through the dispatcher; voice has none; unknown ops stay unsupported', async () => {
  const { base, rpc, store } = setup((c) => {
    if (c.url.includes('11679/recallMessage')) return jsonResponse({ ResponseStatus: OK_STATUS, status: { code: 0, msg: 'ok' } });
    return jsonResponse({ ResponseStatus: OK_STATUS, bizResponseStatus: { resultCode: 'UNKNOWN', resultMessage: 'waiting' } });
  });
  store.update([sampleRow(GID19)]);
  // typing: no verified page facade => unsupported, nothing sent, no throttle slot consumed
  assert.deepEqual(ok(await rpc.handle({ req_id: 't', op: 'typing.send', args: { gid: GID19 } })), { sent: false, reason: 'unsupported' });
  assert.equal(base.fakeFetch.calls.length, 0);
  // queue.status: one checkSessionStatus with the cached customer uid
  assert.deepEqual(ok(await rpc.handle({ req_id: 'q', op: 'queue.status', args: { gid: GID19 } })), { kind: 'ok', resultCode: 'UNKNOWN', resultMessage: 'waiting' });
  assert.ok(base.fakeFetch.calls[0]!.url.includes('16037/checkSessionStatus'));
  assert.equal((base.fakeFetch.calls[0]!.bodyJson as Record<string, unknown>)['customerUid'], `cust-${GID19}`);
  // queue.drop_out: endpoint never captured => unsupported, nothing sent
  assert.deepEqual(ok(await rpc.handle({ req_id: 'd', op: 'queue.drop_out', args: { gid: GID19 } })), { kind: 'unsupported', reason: 'endpoint_not_captured' });
  assert.equal(base.fakeFetch.calls.length, 1);
  // recall: the page has no clock anchor of its own; without the host's server_now_ms it refuses, nothing sent
  const now = base.now();
  assert.deepEqual(ok(await rpc.handle({ req_id: 'r0', op: 'recall.message', args: { gid: GID19, message_id: MSG19, created_ms: now - 1000 } })), { outcome: 'refused', reason: 'clock_unknown' });
  assert.equal(base.fakeFetch.calls.length, 1);
  // with the host's anchored clock the single HTTP recall goes out with both 19-digit ids as strings
  assert.deepEqual(ok(await rpc.handle({ req_id: 'r1', op: 'recall.message', args: { gid: GID19, message_id: MSG19, created_ms: now - 1000, server_now_ms: now } })), { outcome: 'recalled' });
  const recall = base.fakeFetch.calls[1]!;
  assert.ok(recall.url.includes('11679/recallMessage'));
  assert.deepEqual(Object.keys(recall.bodyJson as Record<string, unknown>), ['head', 'messageId', 'partnerId']);
  assert.ok((recall.init.body as string).includes(`"messageId":"${MSG19}"`));
  // argument refusals carry the feature code, not a generic adapter error, and send nothing
  assert.equal(err(await rpc.handle({ req_id: 'r2', op: 'recall.message', args: { gid: GID19, message_id: MSG19 } })), 'adapter.failed');
  assert.equal(err(await rpc.handle({ req_id: 'v', op: 'voice.play', args: {} })), 'host.unsupported');
  assert.equal(err(await rpc.handle({ req_id: 'x', op: 'nope.nope', args: {} })), 'host.unsupported');
  assert.equal(base.fakeFetch.calls.length, 2);
});

test('rpc: server_now_ms is only honoured as a positive safe integer; anything else refuses before any request', async () => {
  const { base, rpc, store } = setup(() => jsonResponse({ ResponseStatus: OK_STATUS, status: { code: 0 } }));
  store.update([sampleRow(GID19)]);
  for (const bad of ['1700000000000', -1, 0, 1.5, NaN, null]) {
    const r = ok(await rpc.handle({ req_id: 'r', op: 'recall.message', args: { gid: GID19, message_id: MSG19, created_ms: base.now() - 1000, server_now_ms: bad } })) as { outcome: string };
    assert.equal(r.outcome, 'refused', String(bad));
  }
  assert.equal(base.fakeFetch.calls.length, 0);
});

test('rpc: im.mark_read targets only the newest peer-sent message, never the agent\'s own row message', async () => {
  const { sdk, rpc, store, ctx } = setup();
  const own = (id: string, from: string, t: number) => sampleRow(GID, { lastMessageJsonString: JSON.stringify({ msgId: id, fromJid: from, toJid: `${GID}@conf.x`, createTime: t, msgtype: 0 }) });
  store.update([own('agent-reply', 'me@im.x', 1700000000800)]);
  assert.equal(store.latestMessage(GID)?.msgId, 'agent-reply', 'preview frontier still follows any sender');
  assert.equal(store.readTarget(GID)?.msgId, `m-${GID}`, 'own message never becomes the read target');
  assert.equal(err(await rpc.handle({ req_id: 'own', op: 'im.mark_read', args: { gid: GID, expected_context_revision: readRevision(ctx), expected_message_id: 'agent-reply' } })), 'adapter.failed');
  store.update([own('other-merchant', `${GID}@conf.x/merchant-2`, 1700000000900)]);
  assert.equal(store.readTarget(GID)?.msgId, `m-${GID}`, 'another merchant is not the peer');
  assert.equal(sdk.readReceipts.length, 0);
  assert.equal(ok(await rpc.handle({ req_id: 'peer', op: 'im.mark_read', args: { gid: GID, expected_context_revision: readRevision(ctx), expected_message_id: `m-${GID}` } })), null);
  store.update([own('peer-new', `${GID}@conf.x/CUST-${GID}`, 1700000001000)]);
  assert.equal(store.readTarget(GID)?.msgId, 'peer-new', 'room-resource jid and case are normalized');
  store.update([own('peer-older', `cust-${GID}@im.x`, 1700000000950)]);
  assert.equal(store.readTarget(GID)?.msgId, 'peer-new', 'cursor never moves backwards');
  assert.deepEqual(sdk.readReceipts.map(r => r.msgId), [`m-${GID}`]);
});

test('store: read target resets with the service context and needs a known customer', () => {
  const store = new ConversationStore();
  const r = (uid: string | null, id: string, from: string) => sampleRow(GID, { uid, sessionId: `s-${uid}`, lastMessageJsonString: JSON.stringify({ msgId: id, fromJid: from, toJid: `${GID}@conf.x`, createTime: 1700000000500, msgtype: 0 }) });
  store.update([r('A', 'a1', 'A@im.x')]);
  assert.equal(store.readTarget(GID)?.msgId, 'a1');
  store.update([r('B', 'b-own', 'me@im.x')]);
  assert.equal(store.readTarget(GID), null, 'new customer context drops the old target');
  store.update([r(null, 'x', '@im.x')]);
  assert.equal(store.readTarget(GID), null);
});

test('rpc peripheral: status "4" is a current member, like the official in-group check', async () => {
  const { rpc } = setup(() => jsonResponse(membersBody([member('me', [3, 4, 4], '4'), member('agent-4', [0, 3, 4], '4'), member('agent-2', [0, 3, 4], '2')])));
  const data = ok(await rpc.handle(perRequest('im.members', { gid: GID }))) as { self_is_master: boolean; members: { uid: string; role: string; present: boolean; can_transfer: boolean; can_remove: boolean }[] };
  assert.equal(data.self_is_master, true);
  assert.deepEqual(data.members.map(m => [m.uid, m.role, m.present, m.can_transfer, m.can_remove]), [
    ['me', 'master', true, false, false], ['agent-4', 'agent', true, true, true], ['agent-2', 'agent', false, false, false],
  ]);
});

test('rpc peripheral: remove is finishConversation with non-empty venAgentUids, primary agent only, absent read-back confirms', async () => {
  let removed = false;
  const { rpc, base } = setup((call) => {
    if (call.url.includes('/finishConversation')) { removed = true; return jsonResponse({ ...peripheralOk, workSheetId: [9001] }); }
    return jsonResponse(membersBody([member('me', [3, 4, 4], '4'), ...(removed ? [] : [member('jim', [0, 3, 4])]), member('customer', [0, 1, 0])]));
  });
  const token = await memberSelection(rpc);
  assert.match(notSubmitted(await rpc.handle(perRequest('im.remove', { gid: GID, selection_token: token, target_uids: [] }, 'empty'))), /explicitly selected/);
  assert.match(notSubmitted(await rpc.handle(perRequest('im.remove', { gid: GID, selection_token: token, target_uids: ['customer'] }, 'customer'))), /explicitly selected/);
  assert.equal(base.fakeFetch.calls.some(c => c.url.includes('/finishConversation')), false, 'an empty or ineligible removal never ends the conversation');
  const req = perRequest('im.remove', { gid: GID, selection_token: token, target_uids: ['jim'] });
  assert.deepEqual(ok(await rpc.handle(req)), { kind: 'confirmed', confirmed: true });
  assert.deepEqual(ok(await rpc.handle({ ...req, req_id: 'again' })), { kind: 'confirmed', confirmed: true });
  const writes = base.fakeFetch.calls.filter(c => c.url.includes('/finishConversation'));
  assert.equal(writes.length, 1);
  const body = writes[0]!.bodyJson as Record<string, unknown>;
  assert.deepEqual(body['venAgentUids'], ['jim']);
  assert.equal(body['workSheetId'], 9001);
  assert.equal(body['conversationType'], 'B2C');
});

test('rpc peripheral: a non-primary agent cannot remove members', async () => {
  const { rpc, base } = setup(() => jsonResponse(membersBody([member('boss', [3, 4, 4]), member('me', [0, 3, 4]), member('peer', [0, 3, 4])])));
  const token = await memberSelection(rpc);
  assert.match(notSubmitted(await rpc.handle(perRequest('im.remove', { gid: GID, selection_token: token, target_uids: ['peer'] }))), /primary agent/);
  assert.equal(base.fakeFetch.calls.some(c => c.url.includes('/finishConversation')), false);
});

test('rpc peripheral: tree expansion extends the selection token and carries agent status fields', async () => {
  const { rpc, base } = setup((call) => {
    if (call.url.includes('getInviteMemberList')) {
      const parents = (call.bodyJson as { parentSkillGroupIds?: number[] }).parentSkillGroupIds;
      return jsonResponse({ ...peripheralOk, results: [parents ? { skillGroupList: [], agentInfoList: [{ agentUid: `agent-${parents[0]}`, nickname: '', status: 0, dutyStatus: 1, jobPosition: '客服', jobPositionType: 4, skillGroupFullName: '总部组/客服' }] } : { skillGroupList: [{ skillGroupId: 7, skillGroupName: 'A' }, { skillGroupId: 8, skillGroupName: 'B' }] }] });
    }
    if (call.url.includes('/inviteVenAgent')) return jsonResponse({ ResponseStatus: OK_STATUS, sessionId: `sess-${GID}`, workSheetId: '9001' });
    return jsonResponse(membersBody([member('me', [3, 4, 4])]));
  });
  const root = ok(await rpc.handle(perRequest('im.invite_candidates', { gid: GID }))) as { selection_token: string; agents: unknown[] };
  assert.equal(root.agents.length, 0);
  const a = ok(await rpc.handle(perRequest('im.invite_candidates', { gid: GID, parent_skill_group_ids: [7], extend_token: root.selection_token }))) as { selection_token: string; agents: Record<string, unknown>[] };
  assert.deepEqual(a.agents[0], { uid: 'agent-7', nickname: null, avatar: null, in_group: false, status: 0, duty_status: 1, job_position: '客服', job_position_type: 4, skill_group_full_name: '总部组/客服' });
  const b = ok(await rpc.handle(perRequest('im.invite_candidates', { gid: GID, parent_skill_group_ids: [8], extend_token: a.selection_token }))) as { selection_token: string };
  const req = perRequest('im.invite', { gid: GID, selection_token: b.selection_token, target_uids: ['agent-7', 'agent-8'] });
  assert.notEqual((ok(await rpc.handle(req)) as { kind: string }).kind, 'not_submitted', 'both expanded groups stay selectable under the latest token');
  assert.deepEqual(base.fakeFetch.calls.filter(c => c.url.includes('/inviteVenAgent')).map(c => (c.bodyJson as { venAgentUidList: string[] }).venAgentUidList), [['agent-7', 'agent-8']]);
});

test('rpc peripheral: keyword search uses the official search endpoint with object results', async () => {
  const { rpc, base } = setup((call) => call.url.includes('searchInviteMemberList')
    ? jsonResponse({ ...peripheralOk, results: { skillGroupList: [{ skillGroupId: 3, skillGroupName: '客服组' }], agentInfoList: [{ agentUid: 'found', nickname: 'Found', status: 3, dutyStatus: 0 }] } })
    : jsonResponse(membersBody([member('me', [3, 4, 4])])));
  const data = ok(await rpc.handle(perRequest('im.invite_candidates', { gid: GID, keywords: ' 客服 ' }))) as { skill_groups: unknown[]; agents: { uid: string; status: number }[] };
  assert.deepEqual(data.skill_groups, [{ skill_group_id: 3, name: '客服组' }]);
  assert.deepEqual(data.agents.map(a => [a.uid, a.status]), [['found', 3]]);
  const body = base.fakeFetch.calls.find(c => c.url.includes('searchInviteMemberList'))!.bodyJson as Record<string, unknown>;
  assert.equal(body['keywords'], '客服'); assert.equal(body['groupId'], GID); assert.equal(body['worksheetId'], 9001);
});

test('rpc: exact order lookup uses verified constants and returns suborders without private fields or chat creation', async () => {
  const id = '1234567890123456';
  const { rpc, base } = setup(() => jsonResponse({ ResponseStatus: OK_STATUS, response: { errorCode: 0 }, totalCount: 1, orderList: [{ ttdOrderId: Number(id), orderInfoList: [
    { ttdOrderId: Number(id), resourceName: 'Plan A', quantity: 1, orderStatus: '已确认', useDateShow: '2026-11-03', customerName: '测试客人', customerMobile: 'PRIVATE PHONE', uId: 'PRIVATE UID' },
    { ttdOrderId: id, resourceName: 'Plan B', quantity: 2, orderStatus: '已确认' },
  ] }] }));
  const r = ok(await rpc.handle({ req_id: 'lookup', op: 'order.search', args: { order_id: id } })) as { kind: string; order: { order_id: string; product: string; quantity: string; contact: string } };
  assert.equal(r.kind, 'one');
  assert.equal(r.order.order_id, id);
  assert.equal(r.order.product, 'Plan A / Plan B');
  assert.equal(r.order.quantity, '1 / 2');
  assert.equal(r.order.contact, '测***');
  assert.equal(JSON.stringify(r).includes('PRIVATE'), false);
  assert.equal(base.fakeFetch.calls.length, 1);
  const call = base.fakeFetch.calls[0]!;
  assert.match(call.url, /14361\/searchorderlist/);
  assert.equal((call.bodyJson as Record<string, unknown>).page, '0');
  assert.equal((call.bodyJson as Record<string, unknown>).ttdOrderId, id);
  assert.deepEqual((call.bodyJson as Record<string, unknown>).aggSortType, { property: 'orderDate', direction: 'desc' });
});

test('rpc: order lookup refuses wrong IDs, rounded IDs, missing suborders and business failures', async () => {
  const id = '1234567890123456';
  for (const order of [
    { ttdOrderId: '1234567890123457', orderInfoList: [{ ttdOrderId: id }] },
    { ttdOrderId: Number('9999999999999999'), orderInfoList: [{ ttdOrderId: id }] },
    { ttdOrderId: id, orderInfoList: [] },
    { ttdOrderId: id, orderInfoList: [{ ttdOrderId: id }] },
    { ttdOrderId: id, orderInfoList: [{ ttdOrderId: '1234567890123457' }] },
  ]) {
    const { rpc } = setup(() => jsonResponse({ ResponseStatus: OK_STATUS, response: { errorCode: 0 }, orderList: [order], totalCount: 1 }));
    assert.equal(err(await rpc.handle({ req_id: 'q', op: 'order.search', args: { order_id: id } })), 'adapter.failed');
  }
  const { rpc } = setup(() => jsonResponse({ ResponseStatus: OK_STATUS, response: { errorCode: 9 }, orderList: [] }));
  assert.equal(err(await rpc.handle({ req_id: 'q', op: 'order.search', args: { order_id: id } })), 'adapter.failed');
});

test('history and confirmed sends request no translation; im.translate_messages answers by ID and rejects bad input', async () => {
  const f = setup(call => call.url.includes('getMessageList')
    ? jsonResponse({ ResponseStatus: OK_STATUS, rangeMessage: { isDone: true, messages: [{ msgId: 'foreign', fromJid: `cust-${GID}@x`, msgtype: 0, messageBody: 'Hello there', createTime: 1700000000100 }] } })
    : call.url.includes('batchTranslateByMsgIds')
      ? jsonResponse({ ResponseStatus: OK_STATUS, supplier: '携程', translateMessageList: [{ msgId: 'foreign', msgtype: 0, messageBody: '您好' }], idWithTranslatedMap: { foreign: false } })
      : jsonResponse({ ResponseStatus: OK_STATUS, members: [] }));
  f.ctx.roles.addCustomer(`cust-${GID}`);
  const page = ok(await f.rpc.handle({ req_id: 'page', op: 'im.message_page', args: { gid: GID } })) as { items: { text: string; translation: string }[] };
  assert.equal(page.items[0]?.translation, null);
  await flush();
  assert.equal(f.base.fakeFetch.calls.filter(c => c.url.includes('batchTranslateByMsgIds')).length, 0, 'a history read has no translation side request');
  const result = ok(await f.rpc.handle({ req_id: 'tr', op: 'im.translate_messages', args: { gid: GID, message_ids: ['foreign', 'foreign'] } })) as { items: unknown[]; supplier: string };
  const { session_tag, ...answers } = result as typeof result & { session_tag: string };
  assert.deepEqual(answers, { items: [{ message_id: 'foreign', status: 'translated', translation: '您好', source_kind: 'text' }], supplier: '携程' });
  assert.match(session_tag, /^[0-9a-f]{8}$/);
  for (const message_ids of [[], [''], [1], Array.from({ length: 21 }, (_, i) => `m${i}`), undefined]) {
    assert.equal(err(await f.rpc.handle({ req_id: 'bad', op: 'im.translate_messages', args: { gid: GID, message_ids } })), 'adapter.failed');
  }
});

test('im.translate_messages reports request failures and rejects a conversation that changed meanwhile', async () => {
  let finish!: (value: ReturnType<typeof jsonResponse>) => void;
  const hang = new Promise<ReturnType<typeof jsonResponse>>(resolve => { finish = resolve; });
  const f = setup(call => call.url.includes('batchTranslateByMsgIds') ? hang : jsonResponse({ ResponseStatus: OK_STATUS }));
  const pending = f.rpc.handle({ req_id: 'tr', op: 'im.translate_messages', args: { gid: GID, message_ids: ['m'] } });
  await flush();
  f.store.update([{ ...sampleRow(GID), sessionId: 'replacement-service' }]);
  finish(jsonResponse({ ResponseStatus: OK_STATUS, translateMessageList: [{ msgId: 'm', msgtype: 0, messageBody: '您好' }] }));
  assert.equal(err(await pending), 'adapter.not_ready');
  const failing = setup(call => call.url.includes('batchTranslateByMsgIds') ? jsonResponse({ ResponseStatus: { Ack: 'Failure', Errors: [] } }) : jsonResponse({ ResponseStatus: OK_STATUS }));
  assert.equal(err(await failing.rpc.handle({ req_id: 'tr', op: 'im.translate_messages', args: { gid: GID, message_ids: ['m'] } })), 'adapter.failed');
});

test('mark follows official raw fields for active and finished conversations, without reopening', async () => {
  for (const status of [1, 2, 4]) for (const id of [9001, '9001', '9007199254740993123', 9007199254740992, undefined]) {
    const f = setup(() => jsonResponse({ ResponseStatus: OK_STATUS, bizResponseStatus: { resultCode: 'SUCCESS' } }));
    f.store.update([{ ...sampleRow(GID), status, id, sessionId: undefined }]);
    assert.equal(ok(await f.rpc.handle({ req_id: 'mark', op: 'im.set_mark', args: { gid: GID, action: 2 } })), null);
    assert.equal(f.base.fakeFetch.calls.length, 1);
    const call = f.base.fakeFetch.calls[0]!;
    assert.ok(call.url.includes('setWorkSheetStar'));
    const body = call.bodyJson as Record<string, unknown>;
    assert.equal(body.worksheetId, id); assert.equal('sessionId' in body, false);
    assert.equal(f.store.row(GID)?.star, 2); assert.equal(f.store.row(GID)?.status, status);
  }
});

test('mark rejection leaves old color, and a changed identity cannot receive an old success', async () => {
  const rejected = setup(() => jsonResponse({ ResponseStatus: OK_STATUS, bizResponseStatus: { resultCode: 'FAIL' } }));
  rejected.store.update([{ ...sampleRow(GID), star: 4 }]);
  assert.equal(err(await rejected.rpc.handle({ req_id: 'reject', op: 'im.set_mark', args: { gid: GID, action: 1 } })), 'adapter.failed');
  assert.equal(rejected.store.row(GID)?.star, 4);
  const f = setup(() => {
    f.store.update([{ ...sampleRow(GID), id: 'new-worksheet', star: 5 }]);
    return jsonResponse({ ResponseStatus: OK_STATUS, bizResponseStatus: { resultCode: 'SUCCESS' } });
  });
  assert.equal(err(await f.rpc.handle({ req_id: 'changed', op: 'im.set_mark', args: { gid: GID, action: 1 } })), 'adapter.not_ready');
  assert.equal(f.store.row(GID)?.star, 5);
});

test('finished conversation mark matches official numeric wire IDs while retaining string cache identity', async () => {
  for (const gid of ['1234567890123456', '9007199254740993', '1234567890123456789']) {
    const f = setup(() => jsonResponse({ ResponseStatus: OK_STATUS, bizResponseStatus: { resultCode: 'SUCCESS' } }));
    const rounded = String(Number(gid));
    f.store.update([{ ...sampleRow(gid), status: 4, star: 3 }]);
    if (rounded !== gid) f.store.update([{ ...sampleRow(rounded), status: 4, star: 5 }]);
    const reply = await f.rpc.handle({ req_id: 'long', op: 'im.set_mark', args: { gid, action: 0 } });
    assert.equal(ok(reply), null);
    assert.equal(f.base.fakeFetch.calls.length, 1);
    const call = f.base.fakeFetch.calls[0]!;
    assert.ok(call.url.includes('setWorkSheetStar'));
    assert.equal((call.bodyJson as Record<string, unknown>).groupId, +gid);
    assert.equal(f.store.row(gid)?.star, 0);
    assert.equal(f.store.row(gid)?.status, 4);
    if (rounded !== gid) assert.equal(f.store.row(rounded)?.star, 5);
  }
});
