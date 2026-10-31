import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AdapterFact } from '../../ipc/src/contracts.ts';
import type { AdapterDisplayPayload, AdapterReplyPayload } from '../../ipc/src/adapterProtocol.ts';
import { createRpc, type AgentStatusBox, type RpcContext } from './rpc.ts';
import { ConversationStore, RoleBook } from './stores.ts';
import { SoaClient } from './soa.ts';
import { FakePageSdk, OK_STATUS, flush, jsonResponse, makeDeps, sampleRow, type FetchScript } from './testing.ts';

const GID = '123456';

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

test('rpc: im.mark_read uses the room jid + latest message id', async () => {
  const { sdk, rpc } = setup();
  assert.equal(ok(await rpc.handle({ req_id: 'r', op: 'im.mark_read', args: { gid: GID } })), null);
  assert.deepEqual(sdk.readReceipts[0], { partnerJid: `${GID}@conf.x`, msgId: `m-${GID}`, conversationType: 'groupchat' });
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

const member = (uid: string, roles = [0, 3, 4], status = '1') => ({ uid, nick: uid, status, roles });
const membersBody = (members: unknown[]) => ({ ResponseStatus: OK_STATUS, status: { code: 0, msg: '' }, members });
const peripheralOk = { ResponseStatus: OK_STATUS, bizResponseStatus: { resultCode: 'SUCCESS' } };
const perRequest = (op: string, args: unknown, req_id = op) => ({ req_id, op, args });

test('rpc peripheral: scripts expose empty or unsupported raw count without guessing nonempty text fields', async () => {
  const { rpc } = setup((_, i) => jsonResponse({ ResponseStatus: OK_STATUS, customerScripts: i === 0 ? [] : [{ mystery: 'not approved reply text' }] }));
  assert.deepEqual(ok(await rpc.handle(perRequest('im.customer_scripts', { content: '' }))), { kind: 'empty', raw_count: 0 });
  const result = ok(await rpc.handle(perRequest('im.customer_scripts', { content: 'search' }))) as { kind: string; raw_count: number };
  assert.equal(result.kind, 'unsupported'); assert.equal(result.raw_count, 1);
  assert.equal(JSON.stringify(result).includes('not approved reply text'), false);
});

test('rpc peripheral: candidates exclude self/current members, reject unselected uid and expire tokens without a write', async () => {
  const { rpc, base } = setup((call) => jsonResponse(call.url.includes('getInviteMemberList') ? {
    ...peripheralOk, results: [{ skillGroupList: [{ skillGroupId: 7, skillGroupName: 'Team' }], agentInfoList: ['ME', 'present', '900719925474099312345'].map(agentUid => ({ agentUid, nickname: agentUid })) }],
  } : membersBody([member('me', [3, 4, 4]), member('present')])));
  const data = ok(await rpc.handle(perRequest('im.invite_candidates', { gid: GID }))) as { agents: { uid: string }[]; selection_token: string };
  assert.deepEqual(data.agents.map(a => a.uid), ['900719925474099312345']);
  const invalid = await rpc.handle(perRequest('im.invite', { gid: GID, selection_token: data.selection_token, target_uids: ['not-selected'] }));
  assert.match(notSubmitted(invalid), /explicitly selected/);
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
    return jsonResponse(membersBody([member('me', [3, 4, 4]), member('chosen', transferred ? [3, 4, 4] : [0, 3, 4]), member('former', [0, 3, 4], '4'), member('customer', [0, 1, 1])]));
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
