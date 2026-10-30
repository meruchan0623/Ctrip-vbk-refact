import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SoaClient } from './soa.ts';
import { NEPHELE_ALPHABET, base64Latin1, formatNepheleDate, nepheleAuthorization, nepheleRandomString, uploadFile, uploadImage, uploadVideo } from './upload.ts';
import { md5Hex } from './md5.ts';
import { OK_STATUS, jsonResponse, makeDeps } from './testing.ts';

test('Nephele authorization string for fixed inputs', () => {
  assert.equal(base64Latin1('token:abc'), 'dG9rZW46YWJj');
  assert.equal(base64Latin1(''), '');
  assert.equal(base64Latin1('a'), 'YQ==');
  assert.equal(base64Latin1('ab'), 'YWI=');
  const auth = nepheleAuthorization({ rand32: 'R'.repeat(32), dateStamp: '202610301830', channel: 'im_business', token: '{{token}}' });
  assert.equal(auth, `Nephele ${'R'.repeat(32)}/202610301830/im_business/${base64Latin1('token:{{token}}')}`);
  const stamp = formatNepheleDate(Date.UTC(2026, 9, 30, 10, 30));
  assert.match(stamp, /^\d{12}$/);
  const d = new Date(Date.UTC(2026, 9, 30, 10, 30));
  assert.equal(stamp, `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`);
});

test('random string uses the observed alphabet, 32 chars, driven by injected random', () => {
  assert.equal(NEPHELE_ALPHABET, 'ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678');
  assert.equal(NEPHELE_ALPHABET.length, 48);
  const s = nepheleRandomString(() => 0);
  assert.equal(s, 'A'.repeat(32));
  assert.equal(nepheleRandomString(() => 0.999999), '8'.repeat(32));
  let i = 0;
  const seq = nepheleRandomString(() => (i++ / 48) % 1);
  assert.equal(seq, NEPHELE_ALPHABET.slice(0, 32));
  for (const ch of nepheleRandomString(Math.random)) assert.ok(NEPHELE_ALPHABET.includes(ch));
});

test('uploadImage: token → raw bytes with auth + MD5 + mime; gated on Code 2000', async () => {
  const bytes = new TextEncoder().encode('fake-png-bytes');
  const deps = makeDeps((call, i) => {
    if (i === 0) return jsonResponse({ ResponseStatus: OK_STATUS, token: '{{token}}' });
    assert.equal(call.url.startsWith('https://nephele.ctrip.com/image/v2/api/upload?channel=im_business&scene=%7B%7Bscene%7D%7D&rand='), true);
    return jsonResponse({ Code: 2000, Message: 'ok', Content: { url: 'https://x/img.png', file_name: 'img.png' } });
  });
  const soa = new SoaClient(deps);
  const r = await uploadImage(deps, soa, { bytes, mime: 'image/png', scene: '{{scene}}', width: 98, height: 34 });
  assert.equal(r.kind, 'uploaded');
  if (r.kind !== 'uploaded') return;
  assert.deepEqual(r.media, { kind: 'image', url: 'https://x/img.png', thumbUrl: 'https://x/img.png', width: 98, height: 34, scene: '{{scene}}', channel: 'im_business' });
  const tokenBody = deps.fakeFetch.calls[0]?.bodyJson as Record<string, unknown>;
  assert.equal(tokenBody['channel'], 'im_business');
  assert.equal(tokenBody['type'], 'img');
  const up = deps.fakeFetch.calls[1];
  assert.ok(up);
  assert.equal(up.init.body, bytes); // raw bytes, not multipart/JSON
  assert.equal(up.init.headers['Content-Type'], 'image/png');
  assert.equal(up.init.headers['Content-MD5'], md5Hex(bytes));
  assert.match(up.init.headers['Authorization'] ?? '', /^Nephele [ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678]{32}\/\d{12}\/im_business\/dG9rZW46e3t0b2tlbn19$/);
});

test('uploadImage failure gates: non-2000 code, missing url, token failure', async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const deps = makeDeps((_, i) => (i === 0 ? jsonResponse({ ResponseStatus: OK_STATUS, token: 't' }) : jsonResponse({ Code: 4001, Message: 'bad', Content: null })));
  const soa = new SoaClient(deps);
  const r = await uploadImage(deps, soa, { bytes, mime: 'image/png', scene: 's', width: 1, height: 1 });
  assert.deepEqual(r, { kind: 'failed', failure: { kind: 'rejected', code: 4001, message: 'bad' } });
  deps.fakeFetch.set((_, i) => (i === 2 ? jsonResponse({ ResponseStatus: OK_STATUS, token: 't' }) : jsonResponse({ Code: 2000, Content: { file_name: 'x' } })));
  assert.deepEqual(await uploadImage(deps, soa, { bytes, mime: 'image/png', scene: 's', width: 1, height: 1 }), { kind: 'failed', failure: { kind: 'malformed' } });
  deps.fakeFetch.set(() => jsonResponse({ ResponseStatus: OK_STATUS }));
  const t = await uploadImage(deps, soa, { bytes, mime: 'image/png', scene: 's', width: 1, height: 1 });
  assert.equal(t.kind, 'failed');
  if (t.kind === 'failed') assert.equal(t.failure.kind, 'token_failed');
});

test('uploadFile: no token, no auth, no MD5, public=1', async () => {
  const bytes = new TextEncoder().encode('%PDF-fake');
  const deps = makeDeps(() => jsonResponse({ file_name: 'a.pdf', url: 'https://x/a.pdf' }));
  const r = await uploadFile(deps, { bytes, mime: 'application/pdf', filename: 'a.pdf' });
  assert.deepEqual(r, { kind: 'uploaded', media: { kind: 'file', filename: 'a.pdf', url: 'https://x/a.pdf', size: bytes.length } });
  assert.equal(deps.fakeFetch.calls.length, 1);
  const c = deps.fakeFetch.calls[0];
  assert.ok(c);
  assert.equal(c.url, 'https://nephele.ctrip.com/file/v1/api/upload?channel=im&public=1');
  assert.equal(c.init.body, bytes);
  assert.equal('Authorization' in c.init.headers, false);
  assert.equal('Content-MD5' in c.init.headers, false);
  assert.equal(c.init.headers['Content-Type'], 'application/pdf');
});

test('uploadVideo chain: token(im/video) → v3 upload with auth+MD5 → v1 proc JSON', async () => {
  const bytes = new TextEncoder().encode('fake-mp4');
  const deps = makeDeps((call, i) => {
    if (i === 0) return jsonResponse({ ResponseStatus: OK_STATUS, token: 'vt' });
    if (i === 1) {
      assert.equal(call.url.startsWith('https://nephele.ctrip.com/video/v3/api/upload?channel=im&rand='), true);
      return jsonResponse({ Code: 2000, Message: 'ok', Content: { file_name: 'vid-1', preview_url: 'https://x/v.mp4', size: 1696, video: { duration: 0.8, codec: 'h264', height: 72, width: 128, bitrate: 7820, fps: 5, start_time: 0 } } });
    }
    assert.equal(call.url, 'https://nephele.ctrip.com/video/v1/api/proc?video=vid-1');
    assert.deepEqual(call.bodyJson, { extract: { interval: 20, end_second: 3 } });
    return jsonResponse({ image: { conver: 'https://x/cover.jpg', first_frame: '', samples: ['https://x/s1.jpg'] }, video: { video_formats: null }, audio: null });
  });
  const r = await uploadVideo(deps, new SoaClient(deps), { bytes, mime: 'video/mp4', filename: 'f.mp4' });
  assert.equal(r.kind, 'uploaded');
  if (r.kind !== 'uploaded') return;
  assert.deepEqual(r.media, { kind: 'video', filename: 'vid-1', cover: 'https://x/cover.jpg', url: 'https://x/v.mp4', duration: 0.8, size: 1696, width: 128, height: 72 });
  assert.deepEqual(r.proc, { cover: 'https://x/cover.jpg', samples: ['https://x/s1.jpg'] });
  const tokenBody = deps.fakeFetch.calls[0]?.bodyJson as Record<string, unknown>;
  assert.equal(tokenBody['channel'], 'im');
  assert.equal(tokenBody['type'], 'video');
  const up = deps.fakeFetch.calls[1];
  assert.ok(up);
  assert.equal(up.init.headers['Content-MD5'], md5Hex(bytes));
  assert.match(up.init.headers['Authorization'] ?? '', /^Nephele [A-Za-z2-8]{32}\/\d{12}\/im\//);
  assert.equal(up.init.headers['Content-Type'], 'video/mp4');
  const proc = deps.fakeFetch.calls[2];
  assert.equal(proc?.init.headers['Content-Type'], 'application/json');
  assert.equal('Authorization' in (proc?.init.headers ?? {}), false);
});
