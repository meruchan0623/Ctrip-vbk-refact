import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DIRECT_UPLOAD_MAX_BYTES, FILE_MAX_BYTES, IMAGE_MAX_BYTES, MAX_FILES_PER_SEND, MIB, VIDEO_CHUNK_BYTES, VIDEO_MAX_BYTES,
  VIDEO_MAX_DURATION_MS, checkMediaAttachment, checkMediaBatch, checkMediaSendable, checkMediaSize, planUpload,
} from './media-limits.ts';

const doc = readFileSync(new URL('../../../../../docs/api/media-attachment-contract.md', import.meta.url), 'utf8');

test('contract document pins the same numbers as the TypeScript mirror (and, via its own test, the Rust core)', () => {
  assert.match(doc, /ATTACHMENT_CONTRACT_VERSION = 1/);
  for (const [name, value] of Object.entries({ IMAGE_MAX_BYTES, FILE_MAX_BYTES, VIDEO_MAX_BYTES, VIDEO_MAX_DURATION_MS, MAX_FILES_PER_SEND, VIDEO_CHUNK_BYTES, DIRECT_UPLOAD_MAX_BYTES })) {
    assert.ok(doc.includes(`\`${name}\` = ${value}`), `contract doc lacks ${name} = ${value}`);
  }
});

test('contract document lists every local rejection code this mirror can return', () => {
  for (const code of ['media.empty', 'media.too_large', 'media.video_too_long', 'media.video_duration_unknown', 'media.too_many_files', 'media.chunked_upload_unsupported', 'media.unknown_kind']) {
    assert.ok(doc.includes(`\`${code}\``), code);
  }
});

test('per-kind size caps are inclusive and independent', () => {
  for (const [kind, max] of [['image', IMAGE_MAX_BYTES], ['file', FILE_MAX_BYTES], ['video', VIDEO_MAX_BYTES]] as const) {
    assert.deepEqual(checkMediaSize(kind, max), { ok: true });
    assert.deepEqual(checkMediaSize(kind, max + 1), { ok: false, code: 'media.too_large' });
    assert.deepEqual(checkMediaSize(kind, 0), { ok: false, code: 'media.empty' });
  }
  assert.equal(checkMediaSize('image', 10 * MIB + 1).ok, false);
  assert.equal(checkMediaSize('file', 10 * MIB + 1).ok, true);
  assert.deepEqual(checkMediaSize('audio', 1), { ok: false, code: 'media.unknown_kind' });
  for (const bad of [1.5, -1, NaN, '1', null]) assert.equal(checkMediaSize('file', bad).ok, false);
});

test('video needs a decoded duration of at most three minutes; other kinds ignore it', () => {
  assert.deepEqual(checkMediaAttachment('video', MIB, VIDEO_MAX_DURATION_MS), { ok: true });
  assert.deepEqual(checkMediaAttachment('video', MIB, VIDEO_MAX_DURATION_MS + 1), { ok: false, code: 'media.video_too_long' });
  for (const missing of [null, undefined, 0, NaN]) assert.deepEqual(checkMediaAttachment('video', MIB, missing), { ok: false, code: 'media.video_duration_unknown' });
  assert.equal(checkMediaAttachment('file', MIB, null).ok, true);
});

test('at most ten files per send', () => {
  assert.equal(checkMediaBatch(0).ok, true);
  assert.equal(checkMediaBatch(10).ok, true);
  assert.deepEqual(checkMediaBatch(11), { ok: false, code: 'media.too_many_files' });
  assert.equal(checkMediaBatch(-1).ok, false);
});

test('direct threshold is 30 MiB inclusive; larger bodies are 5 MiB parts and are not sendable in this build', () => {
  assert.deepEqual(planUpload(30 * MIB), { kind: 'direct' });
  assert.deepEqual(planUpload(30 * MIB + 1), { kind: 'chunked', chunkBytes: 5 * MIB, chunks: 7 });
  assert.deepEqual(planUpload(300 * MIB), { kind: 'chunked', chunkBytes: 5 * MIB, chunks: 60 });
  assert.equal(checkMediaSendable('video', 30 * MIB, 1000).ok, true);
  assert.deepEqual(checkMediaSendable('video', 30 * MIB + 1, 1000), { ok: false, code: 'media.chunked_upload_unsupported' });
  assert.deepEqual(checkMediaSendable('video', 300 * MIB + 1, 1000), { ok: false, code: 'media.too_large' });
});
