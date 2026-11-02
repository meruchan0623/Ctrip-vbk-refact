import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRpc, type RpcContext } from './rpc.ts';
import { ConversationStore, RoleBook } from './stores.ts';
import { SoaClient } from './soa.ts';
import { FakePageSdk, OK_STATUS, flush, jsonResponse, makeDeps, sampleRow, type FetchScript } from './testing.ts';
import { MEDIA_CHUNK_CAP, MEDIA_LOCAL_CAP } from './media.ts';
const gid = 'synthetic-room', bytes = new TextEncoder().encode('%PDF- synthetic content'), url = 'https://static.tripcdn.com/synthetic.pdf';
const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
function fixture(script: FetchScript = () => jsonResponse({ file_name: 'server-file', url })) {
  const base = makeDeps(script), sdk = new FakePageSdk(), store = new ConversationStore(), roles = new RoleBook('synthetic-self');
  sdk.rememberPartnerJid(gid, `${gid}@muc.synthetic`); store.update([sampleRow(gid)]);
  let current = true;
  const deps = { ...base, sdk, sha256: async (b: Uint8Array) => hash(b), mediaProbe: async () => ({ width: 98, height: 34, duration: 0.8 as number | null }) };
  const facts: unknown[] = [], displays: unknown[] = [];
  const ctx: RpcContext = { deps, sdk, store, roles, soa: new SoaClient(deps), pushFact: x => { facts.push(x); }, pushDisplay: x => { displays.push(x); }, agent: { current: () => null, set() {} }, captureWriteGuard: () => () => current, sendAckTimeoutMs: 1000 };
  const rpc = createRpc(ctx);
  let req = 0;
  const call = async (op: string, args: object) => rpc.handle({ req_id: `r${++req}`, op, args });
  async function ok(op: string, args: object): Promise<any> { const r = await call(op, args); assert.ok(r?.ok, JSON.stringify(r)); return r.data; }
  async function stage(id = 'transfer-1', token = 'target-1', kind = 'file', mime = 'application/pdf', content = bytes) {
    await ok('media.target', { gid, target_token: token });
    const common = { gid, target_token: token, transfer_id: id };
    await ok('media.stage_begin', { ...common, kind, mime, name: 'synthetic.pdf', size: content.length, sha256: hash(content) });
    await ok('media.stage_chunk', { ...common, offset: 0, data: Buffer.from(content).toString('base64') });
    return common;
  }
  return { base, sdk, store, roles, deps, facts, displays, ctx, rpc, call, ok, stage, stop: () => { current = false; } };
}
test('actual media RPC stages exact bytes, uploads once, sends file JSON once and confirms exact long server identity', async () => {
  const f = fixture(), common = await f.stage();
  const upload = await f.ok('media.upload', common);
  assert.equal(upload.kind, 'uploaded'); assert.equal(f.base.fakeFetch.calls.length, 1);
  assert.deepEqual(f.base.fakeFetch.calls[0]?.init.body, bytes);
  assert.equal(JSON.parse(upload.body_json).file.filename, 'synthetic.pdf');
  const args = { ...common, local_id: 'synthetic-local', body_json: upload.body_json };
  const pending = f.ok('im.send_media', args); await flush();
  assert.equal(f.sdk.sent.length, 1); assert.equal(f.sdk.sent[0]?.body.msgtype, '5');
  assert.equal(f.sdk.sent[0]?.body.localid, args.local_id);
  f.sdk.emit('send_result', { localid: args.local_id, error: 0, tid: '900719925474099312345', create_time: '1700000000999' });
  const result = await pending;
  assert.equal(result.disposition.kind, 'confirmed'); assert.equal(result.message.message_id, '900719925474099312345');
  assert.equal(result.message.kind, 'file'); assert.equal(result.message.text, ''); assert.equal(result.message.sender_id, 'synthetic-self');
  await f.ok('media.upload', common); await f.ok('im.send_media', args);
  assert.equal(f.base.fakeFetch.calls.length, 1); assert.equal(f.sdk.sent.length, 1);
  assert.equal(f.facts.length, 1); assert.equal(f.displays.length, 1);
});
test('unknown upload memo remains single even after late repeated requests; SDK send remains unavailable', async () => {
  const f = fixture(() => 'hang'), common = await f.stage();
  const first = f.ok('media.upload', common); await f.base.clock.advance(120000);
  assert.equal((await first).kind, 'unknown'); assert.equal((await f.ok('media.upload', common)).kind, 'unknown');
  assert.equal(f.base.fakeFetch.calls.length, 1); assert.equal(f.sdk.sent.length, 0);
  assert.equal((await f.call('im.send_media', { ...common, local_id: 'synthetic', body_json: '{}' }))?.ok, false);
});
test('chunk caps, offset, scope, hash and complete-length checks reject before any upload', async () => {
  for (const bad of ['offset', 'base64', 'too_large', 'incomplete', 'digest']) {
    const f = fixture(); const common = { gid, target_token: 'target', transfer_id: 'transfer' };
    await f.ok('media.target', common);
    const size = bad === 'too_large' ? MEDIA_LOCAL_CAP + 1 : bytes.length;
    const begin = await f.call('media.stage_begin', { ...common, kind: 'file', mime: 'application/octet-stream', name: 'synthetic.bin', size, sha256: bad === 'digest' ? '0'.repeat(64) : hash(bytes) });
    if (bad === 'too_large') { assert.equal(begin?.ok, false); continue; }
    assert.equal(begin?.ok, true);
    const result = await f.call('media.stage_chunk', { ...common, offset: bad === 'offset' ? 1 : 0, data: bad === 'base64' ? '%' : Buffer.from(bad === 'incomplete' ? bytes.slice(0, 2) : bytes).toString('base64') });
    if (bad === 'offset' || bad === 'base64') assert.equal(result?.ok, false);
    assert.notEqual((await f.ok('media.upload', common)).kind, 'uploaded');
    assert.equal(f.base.fakeFetch.calls.length, 0);
  }
  assert.equal(MEDIA_CHUNK_CAP, 256 * 1024);
});
test('full service/order identity and lifecycle are rechecked after file picker token before staging', async () => {
  for (const change of [{ sessionId: 'new' }, { uid: 'other-customer' }, { threadId: 'other-thread' }, { relationOrderId: 'other-order', ext: { orderId: 'other-order' } }, { serviceType: 'other-service' }, { id: 999 }]) {
    const f = fixture(); await f.ok('media.target', { gid, target_token: 'old' });
    f.store.update([sampleRow(gid, change)]);
    assert.equal((await f.call('media.validate', { gid, target_token: 'old' }))?.ok, false);
    assert.equal(f.base.fakeFetch.calls.length, 0); assert.equal(f.sdk.sent.length, 0);
  }
  const f = fixture(); await f.ok('media.target', { gid, target_token: 'old' }); f.stop();
  assert.equal((await f.call('media.validate', { gid, target_token: 'old' }))?.ok, false);
});
test('late token response cannot upload bytes after target changes; token failure differs from file upload uncertainty', async () => {
  const f = fixture(() => { f.stop(); return jsonResponse({ ResponseStatus: OK_STATUS, token: 'synthetic-token' }); });
  const common = await f.stage('transfer', 'target', 'image', 'image/png', new Uint8Array([137, 80, 78, 71]));
  assert.equal((await f.ok('media.upload', common)).kind, 'unknown');
  assert.equal(f.base.fakeFetch.calls.length, 1, 'only token request, never image bytes'); assert.equal(f.sdk.sent.length, 0);
  const token = fixture(() => new Error('synthetic network failure'));
  const t = await token.stage('transfer', 'target', 'image', 'image/png', bytes);
  assert.match((await token.ok('media.upload', t)).error, /token acquisition.*no file upload/);
});
test('video duration and decode failure are actual pre-upload gates; three minutes is accepted at boundary', async () => {
  for (const duration of [NaN, Infinity, 0, 180.01]) {
    const f = fixture(); f.deps.mediaProbe = async () => ({ width: 20, height: 10, duration });
    const common = await f.stage('t', 'target', 'video', 'video/mp4', bytes);
    assert.equal((await f.ok('media.upload', common)).kind, 'not_submitted'); assert.equal(f.base.fakeFetch.calls.length, 0);
  }
  const f = fixture(); f.deps.mediaProbe = async () => { throw new Error('synthetic decoder failure'); };
  const common = await f.stage('t', 'target', 'video', 'video/mp4', bytes);
  assert.equal((await f.ok('media.upload', common)).kind, 'not_submitted'); assert.equal(f.base.fakeFetch.calls.length, 0);
});
test('image RPC preserves real dimensions/scene and video RPC preserves duration/proc contract before typed SDK send', async () => {
  for (const kind of ['image', 'video'] as const) {
    const f = fixture((_, index) => index === 0 ? jsonResponse({ ResponseStatus: OK_STATUS, token: 'synthetic-token' })
      : index === 1 ? jsonResponse({ Code: 2000, Content: kind === 'image' ? { url: 'https://dimg04.c-ctrip.com/synthetic.png', file_name: 'synthetic.png' } : { file_name: 'synthetic-server-video', preview_url: 'https://media.ctrip.com/synthetic.mp4', size: bytes.length, video: { duration: 180, width: 98, height: 34 } } })
        : jsonResponse({ image: { conver: 'https://dimg04.c-ctrip.com/synthetic-cover.jpg', samples: [] } }));
    f.deps.mediaProbe = async () => ({ width: 98, height: 34, duration: kind === 'video' ? 180 : null });
    const common = await f.stage('transfer', 'target', kind, kind === 'image' ? 'image/png' : 'video/mp4', bytes);
    const uploaded = await f.ok('media.upload', common); assert.equal(uploaded.kind, 'uploaded');
    const body = JSON.parse(uploaded.body_json);
    if (kind === 'image') { assert.equal(body.width, 98); assert.equal(body.height, 34); assert.equal(body.ext.scene, 'cqDA0M7F6aAGHF06jzBe'); assert.equal(f.base.fakeFetch.calls.length, 2); }
    else { assert.equal(body.video.duration, 180); assert.equal(body.video.cover, 'https://dimg04.c-ctrip.com/synthetic-cover.jpg'); assert.equal(f.base.fakeFetch.calls.length, 3); }
    const pending = f.ok('im.send_media', { ...common, local_id: 'synthetic-local', body_json: uploaded.body_json }); await flush();
    assert.equal(f.sdk.sent[0]?.body.msgtype, kind === 'image' ? '1' : '3');
    f.sdk.emit('send_result', { localid: 'synthetic-local', error: 0, tid: 'synthetic-server', create_time: '1700000000999' });
    assert.equal((await pending).message.kind, kind);
  }
});
test('a changed room JID cannot redirect the already selected attachment before upload or send', async () => {
  const f = fixture(), common = await f.stage();
  f.sdk.rememberPartnerJid(gid, `${gid}@muc.replacement`);
  assert.equal((await f.call('media.upload', common))?.ok, false);
  assert.equal(f.base.fakeFetch.calls.length, 0); assert.equal(f.sdk.sent.length, 0);
});
test('SDK timeout never resubmits and changing transfer local_id cannot bypass its tombstone', async () => {
  const f = fixture(), common = await f.stage(), upload = await f.ok('media.upload', common);
  const args = { ...common, local_id: 'synthetic-local', body_json: upload.body_json };
  const p = f.ok('im.send_media', args); await f.base.clock.advance(1000);
  assert.equal((await p).disposition.kind, 'unknown'); await f.ok('im.send_media', args);
  assert.equal((await f.call('im.send_media', { ...args, local_id: 'another-local' }))?.ok, false);
  assert.equal(f.sdk.sent.length, 1);
});
test('awaited SDK receipt retains captured self profile and never projects into a replacement identity', async () => {
  const f = fixture(), common = await f.stage(), upload = await f.ok('media.upload', common);
  const p = f.ok('im.send_media', { ...common, local_id: 'old-local', body_json: upload.body_json }); await flush();
  Object.defineProperty(f.roles, 'selfUid', { get: () => 'replacement-self' });
  f.sdk.emit('send_result', { localid: 'old-local', error: 0, tid: 'synthetic-server', create_time: '1700000000999' });
  const reply = await p;
  assert.equal(reply.message.sender_id, 'synthetic-self'); assert.equal(f.facts.length, 0); assert.equal(f.displays.length, 0);
});
test('third and later completed attachment works while earlier transfer no-replay metadata remains', async () => {
  const f = fixture();
  for (let index = 0; index < 20; index++) {
    const common = await f.stage(`transfer-${index}`, `target-${index}`), upload = await f.ok('media.upload', common);
    const args = { ...common, local_id: `local-${index}`, body_json: upload.body_json };
    const p = f.ok('im.send_media', args); await flush(); f.sdk.emit('send_result', { localid: args.local_id, error: 0, tid: `server-${index}` }); await p;
    await f.ok('im.send_media', args);
  }
  assert.equal(f.sdk.sent.length, 20); assert.equal(f.base.fakeFetch.calls.length, 20);
});
test('twenty cancelled/released selections do not exhaust active target capacity and started upload tombstones stay non-replaying', async () => {
  const f = fixture();
  for (let index = 0; index < 20; index++) {
    const a = { gid, target_token: `cancel-${index}` };
    await f.ok('media.target', a); await f.ok('media.release', a);
    assert.equal((await f.call('media.validate', a))?.ok, false);
  }
  const common = await f.stage(); const uploaded = await f.ok('media.upload', common);
  await f.ok('media.release', common);
  assert.deepEqual(await f.ok('media.upload', common), uploaded, 'release keeps the original upload memo');
  assert.equal((await f.call('im.send_media', { ...common, local_id: 'new-local', body_json: uploaded.body_json }))?.ok, false, 'release cannot authorize a new SDK send');
  assert.equal(f.base.fakeFetch.calls.length, 1); assert.equal(f.sdk.sent.length, 0);
});
test('discarding a concurrent unsubmitted staging buffer leaves the first selected target valid', async () => {
  const f = fixture(), first = await f.stage();
  const duplicate = { ...first, transfer_id: 'duplicate-staging' };
  await f.ok('media.stage_begin', { ...duplicate, kind: 'file', mime: 'application/octet-stream', name: 'synthetic.pdf', size: bytes.length, sha256: hash(bytes) });
  await f.ok('media.discard', duplicate);
  assert.equal((await f.ok('media.upload', first)).kind, 'uploaded'); assert.equal(f.base.fakeFetch.calls.length, 1);
  assert.equal((await f.call('media.upload', duplicate))?.ok, false);
});

test('attachment v1 stages 30 MiB file boundary, rejects image/video above their supported caps and admits only ten active files', async () => {
  const f = fixture(), common = { gid, target_token: 'limits' };
  await f.ok('media.target', common);
  const begin = (id: string, kind: string, size: number) => f.call('media.stage_begin', { ...common, transfer_id: id, kind, size, name: 'synthetic', mime: kind === 'image' ? 'image/png' : kind === 'video' ? 'video/mp4' : 'application/octet-stream', sha256: 'a'.repeat(64) });
  assert.equal((await begin('file-cap', 'file', 30 * 1024 * 1024))?.ok, true);
  await f.ok('media.discard', { ...common, transfer_id: 'file-cap' });
  assert.equal((await begin('file-large', 'file', 30 * 1024 * 1024 + 1))?.ok, false);
  assert.equal((await begin('image-large', 'image', 10 * 1024 * 1024 + 1))?.ok, false);
  assert.equal((await begin('video-large', 'video', 30 * 1024 * 1024 + 1))?.ok, false);
  for (let n = 0; n < 10; n++) assert.equal((await begin(`pending-${n}`, 'file', 1))?.ok, true);
  assert.equal((await begin('eleventh', 'file', 1))?.ok, false);
  await f.ok('media.discard', { ...common, transfer_id: 'pending-0' });
  assert.equal((await begin('replacement', 'file', 1))?.ok, true);
  assert.equal(f.base.fakeFetch.calls.length, 0); assert.equal(f.sdk.sent.length, 0);
});
