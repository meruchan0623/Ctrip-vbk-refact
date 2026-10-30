import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AdapterFact } from '../../ipc/src/contracts.ts';
import type { AdapterDisplayPayload, AdapterReplyPayload } from '../../ipc/src/adapterProtocol.ts';
import { createRpc, type AgentStatusBox, type RpcContext } from './rpc.ts';
import { ConversationStore, RoleBook } from './stores.ts';
import { SoaClient } from './soa.ts';
import { FakePageSdk, OK_STATUS, flush, jsonResponse, makeDeps, sampleRow, type FetchScript } from './testing.ts';

const GID = '123456';

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

test('rpc: im.mark_read uses the room jid + latest message id', async () => {
  const { sdk, rpc } = setup();
  assert.equal(ok(await rpc.handle({ req_id: 'r', op: 'im.mark_read', args: { gid: GID } })), null);
  assert.deepEqual(sdk.readReceipts[0], { partnerJid: `${GID}@conf.x`, msgId: `m-${GID}`, conversationType: 'groupchat' });
});

test('rpc: im.messages pages history, pushes body-free facts and a replace display', async () => {
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
  assert.ok(displays.some((d) => d.kind === 'messages' && d.replace));
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

test('rpc: agent.status reads currentStatus; set_status writes once then reads back', async () => {
  const { base, rpc } = setup((call) => (call.url.includes('getConversationList') ? jsonResponse({ ResponseStatus: OK_STATUS, currentStatus: 1, conversationList: [] }) : jsonResponse({ ResponseStatus: OK_STATUS })));
  assert.deepEqual(ok(await rpc.handle({ req_id: 'r', op: 'agent.status', args: {} })), { status: 'hangup', confirmed: true });
  assert.deepEqual(ok(await rpc.handle({ req_id: 'r', op: 'agent.set_status', args: { status: 'hangup' } })), { status: 'hangup', confirmed: true });
  const writes = base.fakeFetch.calls.filter((c) => c.url.includes('setVenAgentStatus'));
  assert.equal(writes.length, 1);
  assert.equal((writes[0]?.bodyJson as { agentStatus: number }).agentStatus, 1);
});

test('rpc: order.search unsupported, create_im_chat resolves gid via the cached order row; unknown op / malformed', async () => {
  const { rpc } = setup(() => jsonResponse({ ResponseStatus: OK_STATUS, response: { errorCode: 0 }, url: 'https://imvendor.ctrip.com/main?initChat=2&serviceType=1513&targetGid=' }));
  assert.equal(err(await rpc.handle({ req_id: 'r', op: 'order.search', args: { order_id: '1' } })), 'host.unsupported');
  assert.deepEqual(ok(await rpc.handle({ req_id: 'r', op: 'order.create_im_chat', args: { order_id: '1234567890' } })), { gid: GID, reused: true });
  assert.equal(err(await rpc.handle({ req_id: 'r', op: 'nope', args: {} })), 'host.unsupported');
  assert.equal(await rpc.handle({ op: 'im.messages' }), null);
  assert.equal(await rpc.handle(null), null);
});
