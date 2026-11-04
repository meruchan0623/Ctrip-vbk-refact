import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMessageActionsRpc, messageImageUrl } from './message-actions.ts';
import { createRpc, type RpcContext } from './rpc.ts';
import { createPageSdk } from './sdkGlue.ts';
import { ConversationStore, RoleBook } from './stores.ts';
import { SoaClient } from './soa.ts';
import { FakePageSdk, OK_STATUS, makeDeps, sampleRow, jsonResponse, flush, type FetchScript } from './testing.ts';

const SOURCE = 'source', TARGET = 'target', TIME = 1700000000500;
const original = (extra: Record<string, unknown> = {}) => ({ msgId: '900719925474099312345', messageBody: 'Original text', msgtype: 0, status: 0, createTime: TIME, fromJid: 'customer@im.synthetic', toJid: `${SOURCE}@conf.x`, citeMsgId: 'old-quote', isTargetRead: true, ...extra });
const args = (extra: Record<string, unknown> = {}) => ({ gid: TARGET, local_id: 'local-1', source_gid: SOURCE, source_message_id: '900719925474099312345', source_create_time_ms: TIME, ...extra });
function fixture(rows = [original()], script?: FetchScript) {
  const base = makeDeps(script ?? (() => jsonResponse({ ResponseStatus: OK_STATUS, rangeMessage: { isDone: true, messages: rows } })));
  const sdk = new FakePageSdk(), store = new ConversationStore(), roles = new RoleBook('self');
  store.update([sampleRow(SOURCE), sampleRow(TARGET, { serviceType: '2384', threadId: 'target-thread' })]);
  sdk.rememberPartnerJid(SOURCE, `${SOURCE}@conf.x`); sdk.rememberPartnerJid(TARGET, `${TARGET}@conf.x`);
  let current = true;
  const facts: unknown[] = [], displays: unknown[] = [];
  const deps = { ...base, sdk };
  const ctx: RpcContext = { deps, sdk, store, roles, soa: new SoaClient(deps), pushFact: f => { facts.push(f); }, pushDisplay: d => { displays.push(d); }, agent: { current: () => null, set() {} }, captureWriteGuard: () => () => current, sendAckTimeoutMs: 1000 };
  return { base, ctx, sdk, store, roles, facts, displays, rpc: createMessageActionsRpc(ctx), stop: () => { current = false; } };
}
const ack = (f: ReturnType<typeof fixture>, localid = 'local-1', error = 0) => f.sdk.emit('send_result', { localid, error, tid: '900719925474099399999', create_time: '1700000000999' });

test('forward reads exact source id and rebuilds target SDK fields without original quote/status/read metadata', async () => {
  const f = fixture();
  const request = args({ source_context_revision: f.store.assistantContextRevision(SOURCE, 'self', `${SOURCE}@conf.x`), target_context_revision: f.store.assistantContextRevision(TARGET, 'self', `${TARGET}@conf.x`) });
  const pending = f.rpc.forward(request); await flush();
  const body = f.base.fakeFetch.calls[0]!.bodyJson as Record<string, unknown>;
  assert.equal(body.groupId, SOURCE); assert.equal(body.endTime, TIME + 1); assert.equal(body.direction, 'prev');
  assert.deepEqual(f.sdk.sent, [{ gid: TARGET, body: { chattype: 'groupchat', biztype: '2384', localid: 'local-1', msg: 'Original text', msgtype: '0', autoextend: 0, threadid: 'target-thread' } }]);
  ack(f); const result = await pending;
  assert.equal(result.disposition.kind, 'confirmed'); assert.equal(result.message.message_id, '900719925474099399999'); assert.equal(result.message.sender_id, 'self'); assert.equal(result.message.gid, TARGET); assert.equal(result.message.quote, null);
  assert.equal(f.displays.length, 1); assert.equal(f.facts.length, 1);
});

test('all official forwardable types preserve original wire body', async () => {
  for (const msgtype of [0, 1, 2, 3, 5, 8, 9]) {
    const messageBody = msgtype === 0 ? 'text' : JSON.stringify({ title: 'Card title', avatar: 'https://images.ctrip.com/avatar.png', desc: 'description', body: 'Mention text', uid: ['mentioned-user'], from: 'Original sender', emoticon: { code: 'smile', label: 'smile' }, action: 'CTL01', url: 'https://images.ctrip.com/example.png', width: 12, height: 13, file: { filename: 'example.pdf', url: 'https://images.ctrip.com/example.pdf', size: 20 }, video: { filename: 'example.mp4', url: 'https://images.ctrip.com/example.mp4', cover: 'https://images.ctrip.com/cover.jpg', size: 30, duration: 12 } });
    const f = fixture([original({ msgtype, messageBody })]); const pending = f.rpc.forward(args()); await flush();
    assert.equal(f.sdk.sent[0]?.body.msg, messageBody); assert.equal(f.sdk.sent[0]?.body.msgtype, String(msgtype)); assert.equal(f.sdk.sent[0]?.citemsgid, undefined);
    ack(f); assert.equal((await pending).disposition.kind, 'confirmed');
  }
});

test('concurrent and late retries submit once; changed payload with the same local id is refused', async () => {
  const f = fixture(); const first = f.rpc.forward(args()), second = f.rpc.forward(args()); assert.equal(first, second);
  await flush(); ack(f); await first; await f.rpc.forward(args());
  await assert.rejects(f.rpc.forward(args({ gid: SOURCE })), /different operation/); assert.equal(f.sdk.sent.length, 1); assert.equal(f.base.fakeFetch.calls.length, 1);
});

test('missing ack and SDK throw stay unknown without automatic replay', async () => {
  for (const throws of [false, true]) {
    const f = fixture(); if (throws) f.sdk.sendMessage = req => { f.sdk.sent.push(req); throw new Error('after write'); };
    const pending = f.rpc.forward(args()); await flush(); await f.base.clock.advance(1000);
    assert.equal((await pending).disposition.kind, 'unknown'); assert.equal((await f.rpc.forward(args())).disposition.kind, 'unknown'); assert.equal(f.sdk.sent.length, 1);
  }
});

test('ineligible, recalled, missing, duplicate, wrong-room and changed-time sources submit nothing', async () => {
  for (const rows of [[], [original(), original()], [original({ msgtype: 7 })], [original({ status: 2 })], [original({ status: 3 })], [original({ status: -1 })], [original({ createTime: TIME - 1 })], [original({ toJid: 'other@conf.x' })], [original({ messageBody: '' })]]) {
    const f = fixture(rows); await assert.rejects(f.rpc.forward(args())); assert.equal(f.sdk.sent.length, 0);
  }
});

test('source/target identity, lifecycle, sender, room and A→B→A changes during read fail closed', async () => {
  for (const change of ['source', 'target', 'round-trip', 'lifecycle', 'self', 'room', 'status']) {
    let release!: (response: ReturnType<typeof jsonResponse>) => void;
    const f = fixture([], () => new Promise(resolve => { release = resolve; })); const pending = f.rpc.forward(args()); await flush();
    if (change === 'source') f.store.update([sampleRow(SOURCE, { sessionId: 'replacement' })]);
    if (change === 'target') f.store.update([sampleRow(TARGET, { uid: 'replacement' })]);
    if (change === 'round-trip') f.store.update([sampleRow(SOURCE, { sessionId: 'replacement' }), sampleRow(SOURCE)]);
    if (change === 'lifecycle') f.stop();
    if (change === 'self') Object.defineProperty(f.roles, 'selfUid', { get: () => 'replacement' });
    if (change === 'room') f.sdk.rememberPartnerJid(TARGET, `${TARGET}@replacement.x`);
    if (change === 'status') f.store.update([sampleRow(TARGET, { status: 4 })]);
    release(jsonResponse({ ResponseStatus: OK_STATUS, rangeMessage: { isDone: true, messages: [original()] } }));
    await assert.rejects(pending, /changed|active/); assert.equal(f.sdk.sent.length, 0, change);
  }
});

test('stale receipt returns captured sender but never projects to a replacement account', async () => {
  const f = fixture(); const pending = f.rpc.forward(args()); await flush(); f.stop(); Object.defineProperty(f.roles, 'selfUid', { get: () => 'replacement' }); ack(f);
  const reply = await pending; assert.equal(reply.disposition.kind, 'confirmed'); assert.equal(reply.message.sender_id, 'self'); assert.equal(f.displays.length, 0); assert.equal(f.facts.length, 0);
});

test('forward target accepts official ACTIVE 1/2 statuses and rejects missing membership', async () => {
  for (const status of [1, 2, 4, 0]) {
    const f = fixture(); f.store.update([sampleRow(TARGET, { status })]); const pending = f.rpc.forward(args());
    if (status === 1 || status === 2) { await flush(); ack(f); assert.equal((await pending).disposition.kind, 'confirmed'); } else await assert.rejects(pending, /active/);
  }
  const f = fixture(); f.store.update([sampleRow(TARGET, { inGroup: -1 })]); await assert.rejects(f.rpc.forward(args()), /joined/);
});

test('saved emoji image is sent to current target as an image, once', async () => {
  const f = fixture(); const args = { gid: TARGET, local_id: 'local-1', url: 'https://dimg04.c-ctrip.com/example.png', thumbnail: 'https://images.tripcdn.com/example-thumb.png', width: 120, height: 80 };
  const pending = f.rpc.sendImage(args); await flush(); const body = JSON.parse(f.sdk.sent[0]!.body.msg);
  assert.equal(f.sdk.sent[0]?.body.msgtype, '1'); assert.equal(body.url, args.url); assert.equal(body.thumbUrl, args.thumbnail); assert.equal(body.width, 120); assert.equal(body.height, 80);
  ack(f); const result = await pending; assert.equal(result.message.kind, 'image'); assert.equal(result.message.media_url, args.url); await f.rpc.sendImage(args); assert.equal(f.sdk.sent.length, 1);
});

test('saved emoji rejects nonofficial, credential, nonhttps, custom-port and local URLs', () => {
  for (const url of ['http://images.ctrip.com/a.png', 'https://evil.test/a.png', 'https://ctrip.com.evil.test/a.png', 'https://user@images.ctrip.com/a.png', 'https://images.ctrip.com:8443/a.png', 'file:///tmp/image.png', 'data:image/png;base64,AA==']) assert.throws(() => messageImageUrl(url), /URL|domains/);
  assert.equal(messageImageUrl('https://dimg04.c-ctrip.com/a.png'), 'https://dimg04.c-ctrip.com/a.png');
});

test('stale expected source or target revision is rejected before the history read', async () => {
  for (const key of ['source_context_revision', 'target_context_revision']) {
    const f = fixture(); await assert.rejects(f.rpc.forward(args({ [key]: 'stale' })), /revision/); assert.equal(f.base.fakeFetch.calls.length, 0); assert.equal(f.sdk.sent.length, 0);
  }
});


test('source lookup follows destination lookup so a stale source body is never held across an awaited destination read', async () => {
  let f!: ReturnType<typeof fixture>;
  f = fixture([], call => {
    const gid = (call.bodyJson as { groupId: string }).groupId;
    return jsonResponse({ ResponseStatus: OK_STATUS, rangeMessage: { isDone: true, messages: gid === TARGET ? [original({ toJid: `${TARGET}@new-room` })] : [original()] } });
  });
  f.sdk.jids.delete(TARGET); f.store.update([sampleRow(TARGET, { lastMessageJsonString: null })]);
  const pending = f.rpc.forward(args()); await flush();
  assert.deepEqual(f.base.fakeFetch.calls.map(c => (c.bodyJson as {groupId: string}).groupId), [TARGET, SOURCE]);
  assert.equal(f.sdk.sent.length, 1); ack(f); assert.equal((await pending).disposition.kind, 'confirmed');
});

test('source service/thread and an independently returned recall marker prevent forwarding', async () => {
  for (const rows of [[original({ bizType: 'other' })], [original({ threadId: 'other' })], [original(), original({ msgId: 'recall', msgtype: 1009, messageBody: JSON.stringify({ title: 'Recalled', recallMessageId: original().msgId }), createTime: TIME })]]) {
    const f = fixture(rows); await assert.rejects(f.rpc.forward(args()), /mismatch|recalled/); assert.equal(f.sdk.sent.length, 0);
  }
});

test('forward RPC travels through createPageSdk and the typed public callback facade for every supported content type', async () => {
  const bodies: Record<number, unknown> = {
    0: 'text',
    1: { url: 'https://images.ctrip.com/photo.jpg', thumbUrl: 'https://images.ctrip.com/thumb.jpg', width: 12, height: 34, ext: { channel: 'im_business' } },
    2: { avatar: 'https://images.ctrip.com/avatar.jpg', title: 'Card', desc: 'Description', url: 'https://www.ctrip.com/card', type: 'card' },
    3: { video: { filename: 'clip.mp4', url: 'https://images.ctrip.com/clip.mp4', cover: 'https://images.ctrip.com/cover.jpg', duration: 10, size: 123, width: 12, height: 34 } },
    5: { file: { filename: 'file.pdf', url: 'https://images.ctrip.com/file.pdf', size: 123, secret: 'synthetic-secret' } },
    8: { emoticon: { code: 'smile', label: 'Smile' } },
    9: { body: 'Mention', uid: ['user'], names: ['Name'], from: 'Original sender' },
  };
  for (const [type, body] of Object.entries(bodies)) {
    const f = fixture([original({ msgtype: Number(type), messageBody: typeof body === 'string' ? body : JSON.stringify(body) })]);
    let calls = 0;
    const sdk = createPageSdk({ IMClient: { sendMessageInSocket: (model: Record<string, unknown>, success: (reply: unknown) => void) => {
      calls++; assert.equal(model.messageType, Number(type)); assert.equal(model.toJid, TARGET); assert.equal(model.threadId, 'target-thread');
      const key = ({ 0: 'content', 1: 'imageUrl', 2: 'linkUrl', 3: 'url', 5: 'filename', 8: 'code', 9: 'atUid' } as Record<string, string>)[type]!;
      assert.notEqual(model[key], undefined); assert.equal(model.citemsgid, undefined); assert.equal(model.messageId, undefined); assert.equal(model.isTargetRead, undefined); assert.equal(model.messageBody, undefined);
      success({ msgId: 'confirmed-facade-id', localId: model.localId, msgCreateTime: TIME });
    } } }, f.base);
    sdk.rememberPartnerJid(SOURCE, `${SOURCE}@conf.x`); sdk.rememberPartnerJid(TARGET, `${TARGET}@conf.x`);
    const rpc = createRpc({ ...f.ctx, sdk });
    const result = await rpc.handle({ req_id: 'forward', op: 'im.forward_message', args: args() });
    assert.equal(result?.ok, true); if (result?.ok) assert.equal((result.data as {disposition: {kind: string}}).disposition.kind, 'confirmed');
    assert.equal(calls, 1); sdk.dispose();
  }
});


test('host Option revisions serialized as null are absent expectations and locally-updated sources remain forwardable', async () => {
  const f = fixture([original({ status: 4 })]); const pending = f.rpc.forward(args({ source_context_revision: null, target_context_revision: null })); await flush();
  assert.equal(f.sdk.sent.length, 1); ack(f); assert.equal((await pending).disposition.kind, 'confirmed');
});
