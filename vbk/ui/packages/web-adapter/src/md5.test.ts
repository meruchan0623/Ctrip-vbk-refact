import { test } from 'node:test';
import assert from 'node:assert/strict';
import { md5Hex, md5HexOfString } from './md5.ts';

test('md5 RFC 1321 vectors', () => {
  assert.equal(md5HexOfString(''), 'd41d8cd98f00b204e9800998ecf8427e');
  assert.equal(md5HexOfString('a'), '0cc175b9c0f1b6a831c399e269772661');
  assert.equal(md5HexOfString('abc'), '900150983cd24fb0d6963f7d28e17f72');
  assert.equal(md5HexOfString('message digest'), 'f96b697d7cb7938d525a2f31aaf161d0');
  assert.equal(md5HexOfString('abcdefghijklmnopqrstuvwxyz'), 'c3fcd3d76192e4007dfb496cca67e13b');
  assert.equal(
    md5HexOfString('12345678901234567890123456789012345678901234567890123456789012345678901234567890'),
    '57edf4a22be3c955ac49da2e2107b67a',
  );
  assert.equal(md5HexOfString('The quick brown fox jumps over the lazy dog'), '9e107d9d372bb6826bd81d3542a419d6');
});

test('md5 handles block boundaries (55/56/64/65 bytes)', () => {
  const mk = (n: number) => new Uint8Array(n).fill(0x61);
  assert.equal(md5Hex(mk(55)), md5HexOfString('a'.repeat(55)));
  assert.equal(md5HexOfString('a'.repeat(56)), '3b0c8ac703f828b04c6c197006d17218');
  assert.equal(md5HexOfString('a'.repeat(64)), '014842d480b571495a4a0363793f7367');
  assert.equal(md5HexOfString('a'.repeat(65)), 'c743a45e0d2e6a95cb859adae0248435');
});
