/**
 * Review: Nephele uploads and MD5 (hunt item 10). The MD5 reference here is
 * written in a different style (word array, hardcoded K table, packed adds)
 * so the two implementations fail independently.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SoaClient } from './soa.ts';
import { UPLOAD_TIMEOUT_MS, base64Latin1, uploadFile, uploadImage, uploadVideo } from './upload.ts';
import { md5Hex, md5HexOfString } from './md5.ts';
import { OK_STATUS, jsonResponse, makeDeps } from './testing.ts';

const K = [
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
  0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
  0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
  0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
  0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
  0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
];
const R = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];

/** Independent MD5 (reference for the test only). */
function refMd5(bytes: Uint8Array): string {
  const add = (x: number, y: number): number => {
    const lo = (x & 0xffff) + (y & 0xffff);
    return (((x >> 16) + (y >> 16) + (lo >> 16)) << 16) | (lo & 0xffff);
  };
  const rol = (v: number, c: number): number => (v << c) | (v >>> (32 - c));
  const n = bytes.length;
  const words: number[] = new Array<number>((((n + 8) >> 6) + 1) * 16).fill(0);
  for (let i = 0; i < n; i++) words[i >> 2] = (words[i >> 2] ?? 0) | ((bytes[i] ?? 0) << ((i & 3) << 3));
  words[n >> 2] = (words[n >> 2] ?? 0) | (0x80 << ((n & 3) << 3));
  words[words.length - 2] = (n * 8) | 0;
  words[words.length - 1] = Math.floor((n * 8) / 4294967296) | 0;
  let a = 1732584193;
  let b = -271733879;
  let c = -1732584194;
  let d = 271733878;
  for (let off = 0; off < words.length; off += 16) {
    const [a0, b0, c0, d0] = [a, b, c, d];
    for (let j = 0; j < 64; j++) {
      const round = j >> 4;
      let f: number;
      let g: number;
      if (round === 0) {
        f = (b & c) | (~b & d);
        g = j;
      } else if (round === 1) {
        f = (b & d) | (c & ~d);
        g = (5 * j + 1) & 15;
      } else if (round === 2) {
        f = b ^ c ^ d;
        g = (3 * j + 5) & 15;
      } else {
        f = c ^ (b | ~d);
        g = (7 * j) & 15;
      }
      const s = R[(round << 2) + (j & 3)] ?? 0;
      const t = add(add(a, f), add(words[off + g] ?? 0, K[j] ?? 0));
      [a, d, c, b] = [d, c, b, add(b, rol(t, s))];
    }
    a = add(a, a0);
    b = add(b, b0);
    c = add(c, c0);
    d = add(d, d0);
  }
  let out = '';
  for (const w of [a, b, c, d]) for (let i = 0; i < 4; i++) out += ((w >>> (i * 8)) & 0xff).toString(16).padStart(2, '0');
  return out;
}

test('review/upload: MD5 vectors, 55/56/63/64 padding boundaries and a ~1 MiB buffer agree with an independent implementation', () => {
  const known: [string, string][] = [
    ['', 'd41d8cd98f00b204e9800998ecf8427e'],
    ['abc', '900150983cd24fb0d6963f7d28e17f72'],
    ['The quick brown fox jumps over the lazy dog', '9e107d9d372bb6826bd81d3542a419d6'],
    ['a'.repeat(55), 'ef1772b6dff9a122358552954ad0df65'],
    ['a'.repeat(56), '3b0c8ac703f828b04c6c197006d17218'],
    ['a'.repeat(63), 'b06521f39153d618550606be297466d5'],
    ['a'.repeat(64), '014842d480b571495a4a0363793f7367'],
  ];
  for (const [s, hex] of known) {
    assert.equal(md5HexOfString(s), hex, `ours: ${s.length}`);
    assert.equal(refMd5(new TextEncoder().encode(s)), hex, `ref: ${s.length}`);
  }
  for (const n of [119, 120, 121, 127, 128, 129, 4095, 4096, 4097]) {
    const buf = new Uint8Array(n);
    for (let i = 0; i < n; i++) buf[i] = (i * 13 + n) & 0xff;
    assert.equal(md5Hex(buf), refMd5(buf), `length ${n}`);
  }
  const big = new Uint8Array(1_048_576 + 37);
  for (let i = 0; i < big.length; i++) big[i] = (i * 31 + (i >> 7)) & 0xff;
  const ours = md5Hex(big);
  assert.equal(ours, refMd5(big));
  assert.equal(ours, '4f575fe72c8ab8522113aebaf00f61c6');
  assert.match(ours, /^[0-9a-f]{32}$/);
});

test('review/upload: image request is exactly {Accept, Authorization, Content-MD5, Content-Type} with raw bytes; Authorization is exact for fixed random/now', async () => {
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
  const deps = makeDeps((_, i) => (i === 0 ? jsonResponse({ ResponseStatus: OK_STATUS, token: 'tok-123' }) : jsonResponse({ Code: 2000, Content: { url: 'https://x/u.png', file_name: 'u.png' } })));
  deps.randomQueue.push(...new Array<number>(65).fill(0)); // 1 SOA trace id + query rand + auth rand32 → 'A' * 32 each
  const d = new Date(deps.clock.now());
  const p2 = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}${p2(d.getHours())}${p2(d.getMinutes())}`;
  const r = await uploadImage(deps, new SoaClient(deps), { bytes, mime: 'image/png', scene: 'sc/1', width: 9, height: 8 });
  assert.equal(r.kind, 'uploaded');
  const up = deps.fakeFetch.calls[1];
  assert.ok(up);
  assert.equal(up.url, 'https://nephele.ctrip.com/image/v2/api/upload?channel=im_business&scene=sc%2F1&rand=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  assert.deepEqual(up.init.headers, {
    Accept: 'application/json, text/plain, */*',
    Authorization: `Nephele ${'A'.repeat(32)}/${stamp}/im_business/${base64Latin1('token:tok-123')}`,
    'Content-MD5': '2d0ca80d4f6e8a4ae7f8aa0c7f7b6b7e'.length === 32 ? md5Hex(bytes) : '',
    'Content-Type': 'image/png',
  });
  assert.equal(up.init.headers['Content-MD5'], refMd5(bytes));
  assert.equal(Buffer.from(up.init.headers['Authorization']?.split('/').pop() ?? '', 'base64').toString('latin1'), 'token:tok-123');
  assert.equal(up.init.body, bytes, 'raw bytes, same buffer');
  assert.equal(up.init.method, 'POST');
  assert.equal(deps.fakeFetch.calls.length, 2);
  assert.equal(deps.clock.pendingCount(), 0, 'no stray timers after success');
});

test('review/upload: HTTP 200 with Code !== 2000 (or a string 2000, or no Content) is a failure; never a second upload', async () => {
  const bytes = new Uint8Array([1]);
  const responses: unknown[] = [{ Code: 4001, Message: 'bad' }, { Code: '2000', Content: { url: 'https://x' } }, { Code: 2000, Content: null }, { Code: 2000, Content: { url: '' } }, { Code: 2000 }, null, 'str'];
  for (const resp of responses) {
    const deps = makeDeps((_, i) => (i === 0 ? jsonResponse({ ResponseStatus: OK_STATUS, token: 't' }) : jsonResponse(resp === 'str' ? '"str"' : resp)));
    const r = await uploadImage(deps, new SoaClient(deps), { bytes, mime: 'image/png', scene: 's', width: 1, height: 1 });
    assert.equal(r.kind, 'failed', JSON.stringify(resp));
    assert.equal(deps.fakeFetch.calls.length, 2, JSON.stringify(resp));
  }
  const d500 = makeDeps((_, i) => (i === 0 ? jsonResponse({ ResponseStatus: OK_STATUS, token: 't' }) : jsonResponse({ Code: 2000, Content: { url: 'https://x' } }, 500)));
  assert.deepEqual(await uploadImage(d500, new SoaClient(d500), { bytes, mime: 'image/png', scene: 's', width: 1, height: 1 }), { kind: 'failed', failure: { kind: 'http_error', httpStatus: 500 } });
  const dnet = makeDeps((_, i) => (i === 0 ? jsonResponse({ ResponseStatus: OK_STATUS, token: 't' }) : new Error('net')));
  assert.deepEqual(await uploadImage(dnet, new SoaClient(dnet), { bytes, mime: 'image/png', scene: 's', width: 1, height: 1 }), { kind: 'failed', failure: { kind: 'network_error' } });
  assert.equal(dnet.fakeFetch.calls.length, 2);
  const dtok = makeDeps(() => new Error('net'));
  const t = await uploadImage(dtok, new SoaClient(dtok), { bytes, mime: 'image/png', scene: 's', width: 1, height: 1 });
  assert.equal(t.kind, 'failed');
  if (t.kind === 'failed' && t.failure.kind === 'token_failed') assert.equal(t.failure.outcome.kind, 'unknown');
  assert.equal(dtok.fakeFetch.calls.length, 1, 'uploadTokenCreate is a write: never retried');
});

test('review/upload: a hanging upload surfaces as a timeout failure (never success, never a silent retry, never hangs forever)', async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const deps = makeDeps((_, i) => (i === 0 ? jsonResponse({ ResponseStatus: OK_STATUS, token: 't' }) : 'hang'));
  const p = uploadImage(deps, new SoaClient(deps), { bytes, mime: 'image/png', scene: 's', width: 1, height: 1 });
  await deps.clock.advance(UPLOAD_TIMEOUT_MS - 1);
  assert.equal(deps.fakeFetch.calls.length, 2);
  await deps.clock.advance(1);
  assert.deepEqual(await p, { kind: 'failed', failure: { kind: 'timeout' } });
  await deps.clock.advance(600000);
  assert.equal(deps.fakeFetch.calls.length, 2);
  assert.equal(deps.clock.pendingCount(), 0);

  const fdeps = makeDeps(() => 'hang');
  const fp = uploadFile(fdeps, { bytes, mime: 'application/pdf', filename: 'a.pdf', timeoutMs: 1000 });
  await fdeps.clock.advance(1000);
  assert.deepEqual(await fp, { kind: 'failed', failure: { kind: 'timeout' } });
  assert.equal(fdeps.fakeFetch.calls.length, 1);
});

test('review/upload: file upload carries no Authorization/Content-MD5 and only the documented headers; video proc failure keeps the upload and is not retried', async () => {
  const bytes = new TextEncoder().encode('%PDF');
  const deps = makeDeps(() => jsonResponse({ file_name: 'a.pdf', url: 'https://x/a.pdf' }));
  await uploadFile(deps, { bytes, mime: 'application/pdf', filename: 'a.pdf' });
  assert.deepEqual(deps.fakeFetch.calls[0]?.init.headers, { Accept: 'application/json, text/plain, */*', 'Content-Type': 'application/pdf' });
  assert.equal(deps.fakeFetch.calls[0]?.init.body, bytes);

  const vdeps = makeDeps((_, i) => {
    if (i === 0) return jsonResponse({ ResponseStatus: OK_STATUS, token: 'vt' });
    if (i === 1) return jsonResponse({ Code: 2000, Content: { file_name: 'vid-1', preview_url: 'https://x/v.mp4', size: 10, video: { duration: 1 } } });
    return jsonResponse('', 500);
  });
  const v = await uploadVideo(vdeps, new SoaClient(vdeps), { bytes, mime: 'video/mp4', filename: 'f.mp4' });
  assert.equal(v.kind, 'uploaded');
  if (v.kind === 'uploaded') {
    assert.equal(v.proc, null);
    assert.equal(v.media.cover, 'https://x/v.mp4');
  }
  assert.equal(vdeps.fakeFetch.calls.length, 3);
});
