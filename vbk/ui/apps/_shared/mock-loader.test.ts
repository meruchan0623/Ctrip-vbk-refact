/**
 * The release bundle must not carry the mock IPC (plan I-29). `bundle.mjs`
 * only knows how to strip it through `apps/_shared/mock-loader`, so no other
 * non-test runtime module may import `packages/ipc/src/mock.ts` directly.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { test } from 'node:test';

const uiRoot = resolve(import.meta.dirname, '..', '..');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'bundle' || name === 'dist' || name === 'node_modules') continue;
      out.push(...walk(p));
    } else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

test('only apps/_shared/mock-loader.ts imports the mock IPC from runtime code', () => {
  const offenders: string[] = [];
  for (const f of walk(uiRoot)) {
    const rel = relative(uiRoot, f).split('\\').join('/');
    if (rel === 'apps/_shared/mock-loader.ts' || rel.startsWith('packages/ipc/src/mock')) continue;
    if (rel.startsWith('tests/') || rel.startsWith('tools/')) continue;
    if (/from\s+['"][^'"]*\/ipc\/src\/mock(?:\.ts)?['"]/.test(readFileSync(f, 'utf8'))) offenders.push(rel);
  }
  assert.deepEqual(offenders, []);
});

test('bundle.mjs strips mock.js and stubs mock-loader.js', () => {
  const src = readFileSync(join(uiRoot, 'tools', 'bundle.mjs'), 'utf8');
  assert.match(src, /mock-loader\.js/);
  assert.match(src, /['"]mock\.js['"]\)/);
  assert.match(src, /MOCK_ORDER_SAMPLES = \[\]/);
});
