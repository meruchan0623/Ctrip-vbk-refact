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
