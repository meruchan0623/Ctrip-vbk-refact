// 已结束会话发送：先读回、再 startChatB2C 重开、最后经 SDK 提交（evidence 49 / validation.md
// 「受控结束/重新进入」）。全部用假 fetch / 假 SDK，不访问携程。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRpc, type RpcContext } from './rpc.ts';
import { ConversationStore, RoleBook } from './stores.ts';
import { SoaClient } from './soa.ts';
import { reopenChatBody } from './peripheral.ts';
import { FakePageSdk, OK_STATUS, flush, jsonResponse, makeDeps, sampleRow, type RecordedCall } from './testing.ts';

const gid = '123456', localId = 'synthetic-local';
const EXT = { parentsid: 'p', clientid: 'c', channel: 'VAC', locale: 'zh_HK', orderid: '1234567890', vendorUid: 'v' };
const latest = (status: number, extra: Record<string, unknown> = {}) => ({ ResponseStatus: OK_STATUS, bizResponseStatus: { resultCode: 'SUCCESS' }, conversation: { uid: `cust-${gid}`, serviceType: '1513', id: 9001, gid, threadId: 'thread-A', conversationKey: 'key', refId: 'ref-1', vendorRole: 'VBK', ext: EXT, status, conversationType: 'B2C', sessionId: `sess-${gid}`, inGroup: status === 4 ? -1 : 1, languageInfo: { lang: 'ru_RU', terminalChannel: '', terminalChannelUid: '', timeZone: '', customerSource: '' }, ...extra } });
const started = { ResponseStatus: OK_STATUS, bizResponseStatus: { resultCode: 'SUCCESS' }, groupId: gid, sessionId: 'sess-new', workSheetId: 9002, conversationKey: 'key-new', taskKey: 't', customerUid: `cust-${gid}` };

function fixture(script: { latest?: () => unknown; start?: () => unknown } = {}, rowStatus = 4) {
  const base = makeDeps((call: RecordedCall) => {
    if (call.url.includes('getLatestConversationByGid')) { const v = (script.latest ?? (() => latest(4)))(); return v instanceof Error ? v : jsonResponse(v); }
    if (call.url.includes('startChatB2C')) { const v = (script.start ?? (() => started))(); return v instanceof Error ? v : jsonResponse(v); }
    return jsonResponse({ ResponseStatus: OK_STATUS, members: [] });
  });
  const sdk = new FakePageSdk(), deps = { ...base, sdk }, store = new ConversationStore();
  store.update([sampleRow(gid, { status: rowStatus, inGroup: rowStatus === 4 ? -1 : 1, threadId: 'thread-A' })]);
  sdk.rememberPartnerJid(gid, `${gid}@conf.x`);
  const ctx: RpcContext = { deps, sdk, store, soa: new SoaClient(deps), roles: new RoleBook('me'), pushFact() {}, pushDisplay() {}, agent: { current: () => null, set() {} }, captureWriteGuard: () => () => true, sendAckTimeoutMs: 1000 };
  const rpc = createRpc(ctx);
  const send = (id = localId) => rpc.handle({ req_id: id, op: 'im.send_text', args: { gid, local_id: id, text: 'Здравствуйте', original: '您好', quote_id: null } });
  const wait = async () => { for (let i = 0; i < 8; i++) await flush(); };
  const ack = (id = localId) => sdk.emit('send_result', { error: 0, localid: id, tid: `srv-${id}`, create_time: '1700000000999' });
  const calls = () => base.fakeFetch.calls.map(c => c.url.includes('startChatB2C') ? 'start' : c.url.includes('getLatestConversationByGid') ? 'latest' : 'other');
  const startBody = () => base.fakeFetch.calls.find(c => c.url.includes('startChatB2C'))?.bodyJson as Record<string, unknown> | undefined;
  return { sdk, store, rpc, send, wait, ack, calls, startBody };
}

test('已结束会话：读回 FINISH → startChatB2C 重开 → 提交一次，重开体按官方字段映射', async () => {
  const f = fixture(); const pending = f.send(); await f.wait();
  assert.deepEqual(f.calls(), ['latest', 'start']);
  assert.equal(f.sdk.sent.length, 1, '重开成功后才提交消息');
  f.ack(); const reply = await pending;
  assert.ok(reply?.ok); assert.equal((reply.data as { kind: string }).kind, 'confirmed');
  const body = f.startBody()!;
  assert.deepEqual({ ...body, head: undefined }, { head: undefined, serviceType: '1513', vendorRefId: 'ref-1', role: 'VBK', threadId: 'thread-A', extParams: EXT, customerUid: `cust-${gid}`, groupId: gid, languageInfo: { lang: 'ru_RU', customerSource: '', terminalChannel: '' } });
  assert.ok(body['head'], '带业务 head');
  assert.ok(!('sessionId' in body) && !('orderNo' in body), 'evidence 49 的结束后重开体不带 sessionId / orderNo');
});

test('处理中的会话不读回也不重开；服务端已非 FINISH（他人已重开 / 上次已生效）时只读不写', async () => {
  const active = fixture({}, 2); const p1 = active.send(); await active.wait(); active.ack(); assert.ok((await p1)?.ok);
  assert.deepEqual(active.calls(), [], '无额外请求');
  const reopened = fixture({ latest: () => latest(2) }); const p2 = reopened.send(); await reopened.wait(); reopened.ack(); assert.ok((await p2)?.ok);
  assert.deepEqual(reopened.calls(), ['latest']); assert.equal(reopened.sdk.sent.length, 1);
});

test('重开被拒、结果未知或字段缺失：消息不提交，回报 not_ready（宿主记为未发送），不自动重试', async () => {
  const cases: [string, { latest?: () => unknown; start?: () => unknown }][] = [
    ['biz_failure', { start: () => ({ ResponseStatus: OK_STATUS, bizResponseStatus: { resultCode: 'FAIL' } }) }],
    ['unknown', { start: () => new Error('synthetic network drop') }],
    ['other group', { start: () => ({ ...started, groupId: '999' }) }],
    ['missing ext', { latest: () => latest(4, { ext: null }) }],
  ];
  for (const [name, script] of cases) {
    const f = fixture(script); const reply = await (async () => { const p = f.send(); await f.wait(); return p; })();
    assert.equal(f.sdk.sent.length, 0, name);
    assert.ok(reply && !reply.ok, name); assert.equal(reply.error.code, 'adapter.not_ready', name);
    assert.ok(f.calls().filter(c => c === 'start').length <= 1, `${name}: startChatB2C 至多一次`);
  }
});

test('结果未知后再次发送：先读回，已重开则不再写 startChatB2C', async () => {
  let state = 4, startCalls = 0;
  const f = fixture({ latest: () => latest(state), start: () => { startCalls++; state = 2; return new Error('synthetic timeout after server applied'); } });
  const first = f.send('l1'); await f.wait(); const r1 = await first;
  assert.ok(r1 && !r1.ok); assert.equal(f.sdk.sent.length, 0);
  const second = f.send('l2'); await f.wait(); f.ack('l2'); const r2 = await second;
  assert.ok(r2?.ok); assert.equal(startCalls, 1, '不盲目重放重开写入'); assert.equal(f.sdk.sent.length, 1);
});

test('同一会话并发发送共用一次重开', async () => {
  const f = fixture(); const a = f.send('l1'), b = f.send('l2'); await f.wait();
  assert.equal(f.calls().filter(c => c === 'start').length, 1);
  assert.equal(f.sdk.sent.length, 2); f.ack('l1'); f.ack('l2');
  assert.ok((await a)?.ok && (await b)?.ok);
});

test('reopenChatBody 拒绝缺字段，不编造默认值', () => {
  const r = reopenChatBody(gid, { serviceType: 1513, uid: 'u', refId: '', vendorRole: 'VBK', threadId: '', ext: {} });
  assert.deepEqual(r, { kind: 'unsupported', missing: ['refId'] });
  const ok = reopenChatBody(gid, { serviceType: 1513, uid: 'u', refId: 'r', vendorRole: 'VBK', threadId: '', ext: {} }) as Record<string, unknown>;
  assert.equal(ok['serviceType'], '1513'); assert.deepEqual(ok['languageInfo'], { lang: '', customerSource: '', terminalChannel: '' });
});
