import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mediaLimitNotice } from './composer-input.ts';

const doc = readFileSync(new URL('../../../../docs/api/media-attachment-contract.md', import.meta.url), 'utf8');
// Every local-rejection code in the contract's §3 table has user-facing text.
const contractCodes = [...doc.matchAll(/^\| `(media\.[a-z_]+)` \|/gm)].map(m => m[1]!).filter(c => c !== 'media.invalid_attachment');

test('every local media rejection code of contract v1 maps to a "nothing sent" notice', () => {
  assert.equal(contractCodes.length, 7);
  for (const code of contractCodes) {
    const notice = mediaLimitNotice(`${code}: attachment exceeds an upload limit (nothing submitted)`);
    assert.ok(notice && notice.includes('未发送'), code);
    assert.equal(mediaLimitNotice(code), notice);
  }
});

test('other texts are left to the caller', () => {
  for (const other of [null, undefined, '', 'media.upload_rejected: x', 'prefix media.too_large', 'media.too_largeX', '结果未知']) assert.equal(mediaLimitNotice(other), null, String(other));
});

test('localized rejection notices preserve limits and never reflect dynamic error details', () => {
  const expected: Record<string, string> = {
    'media.empty': '附件是空的，未发送。',
    'media.too_large': '附件超过大小上限（图片 10 MB、文件 30 MB、视频 300 MB），未发送。',
    'media.video_too_long': '视频超过 3 分钟，未发送。',
    'media.video_duration_unknown': '无法读取视频时长，未发送。',
    'media.too_many_files': '一次最多发送 10 个文件，未发送。',
    'media.chunked_upload_unsupported': '该视频超过 30 MB，当前版本暂不支持大视频分片上传，未发送。',
    'media.unknown_kind': '不支持的附件类型，未发送。',
  };
  for (const [code, notice] of Object.entries(expected)) assert.equal(mediaLimitNotice(`${code}: secret /private/upload.png <img>`), notice);
});
