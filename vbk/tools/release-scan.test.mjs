import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanBuffer, scanPaths } from './release-scan.mjs';

const rules = (b) => scanBuffer(b, 'x').map((f) => f.rule);

test('production hosts are clean', () => {
  const b = Buffer.from('https://vbooking.ctrip.com/x https://imvendor.ctrip.com/ gateway.m.ctrip.com');
  assert.deepEqual(rules(b), []);
});

test('flags test hosts in ASCII', () => {
  for (const h of [
    'imvendor.fat44.qa.nt.ctripcorp.com',
    'gateway.m.uat.qa.nt.ctripcorp.com',
    'static.fws.qa.nt.ctripcorp.com',
    'www.fws.qa.nt.tripqate.com',
    'vbooking.ctrip.uat.nt.ctripcorp.com',
  ]) {
    assert.ok(rules(Buffer.from(`\0\0${h}\0`)).length > 0, h);
  }
});

test('flags test hosts in UTF-16LE (Windows binaries)', () => {
  assert.ok(rules(Buffer.from('imvendor.uat.qa.nt.ctripcorp.com', 'utf16le')).length > 0);
  // UTF-16BE and a host split across an odd offset (one leading byte)
  assert.ok(rules(Buffer.from('imvendor.uat.qa.nt.ctripcorp.com', 'utf16le').swap16()).length > 0);
  assert.ok(rules(Buffer.concat([Buffer.from([0x41]), Buffer.from('a.fws.qa.nt.ctripcorp.com', 'utf16le')])).length > 0);
});

test('flags mock demo data stored as UTF-16 (ASCII and CJK markers)', () => {
  for (const marker of ['Emma Wilson', '3051228766', '云游·小王']) {
    assert.deepEqual(rules(Buffer.from(marker, 'utf16le')), ['mock-data'], `${marker} LE`);
    assert.deepEqual(rules(Buffer.from(marker, 'utf16le').swap16()), ['mock-data'], `${marker} BE`);
  }
});

test('flags mock demo data and mock files; allow-match works', () => {
  assert.deepEqual(rules(Buffer.from('名称 云游·小王 ...')), ['mock-data']);
  const dir = mkdtempSync(join(tmpdir(), 'rscan-'));
  mkdirSync(join(dir, 'dist'));
  writeFileSync(join(dir, 'dist', 'mock.js'), 'x');
  writeFileSync(join(dir, 'dist', 'main.js'), 'ok');
  const r = scanPaths([dir]);
  assert.deepEqual(r.findings.map((f) => f.rule), ['mock-file']);
  assert.equal(r.sizes[dir], 3);
  const allowed = scanBuffer(Buffer.from('a.uat.qa.nt.ctripcorp.com'), 'x', { allowMatch: ['a.uat'] });
  assert.deepEqual(allowed, []);
});
