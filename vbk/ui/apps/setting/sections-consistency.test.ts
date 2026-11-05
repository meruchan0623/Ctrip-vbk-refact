import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { SECTIONS, isSectionId } from './viewmodel.ts';

// The host decides which section a deep link (or another window) may open; the settings window
// renders and scrolls to the same ids. The two lists must not drift.
const root = join(import.meta.dirname, '..', '..', '..');
const deeplink = readFileSync(join(root, 'crates', 'core-update', 'src', 'deeplink.rs'), 'utf8');

function rustArray(name: string): string {
  const match = new RegExp(`const ${name}: \\[[^\\]]+\\] = \\[([\\s\\S]*?)\\];`).exec(deeplink);
  assert.ok(match, name);
  return match[1]!;
}

test('host deep-link SETTING_SECTIONS equals the settings window SECTIONS, in page order', () => {
  const host = [...rustArray('SETTING_SECTIONS').matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  assert.deepEqual(host, SECTIONS.map((s) => s.id));
  assert.match(deeplink, new RegExp(`SETTING_SECTIONS: \\[&str; ${SECTIONS.length}\\]`));
});

test('legacy section names the host still accepts land on a current section and are not sections themselves', () => {
  const legacy = [...rustArray('LEGACY_SETTING_SECTIONS').matchAll(/\("([a-z_]+)",\s*"([a-z_]+)"\)/g)].map((m) => [m[1]!, m[2]!] as const);
  assert.deepEqual(legacy.map(([old]) => old).sort(), ['display', 'network', 'privacy', 'storage']);
  for (const [old, current] of legacy) {
    assert.equal(isSectionId(old), false, old);
    assert.equal(isSectionId(current), true, `${old} -> ${current}`);
  }
});

test('windows that open settings on a section name a current section', () => {
  const files: string[] = [];
  (function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) files.push(path);
    }
  })(join(root, 'ui', 'apps'));
  let seen = 0;
  for (const file of files) {
    for (const m of readFileSync(file, 'utf8').matchAll(/WindowLabels\.SETTING,\s*section:\s*'([^']*)'/g)) {
      seen++;
      assert.equal(isSectionId(m[1]!), true, `${relative(root, file)}: ${m[1]}`);
    }
  }
  assert.ok(seen > 0, 'at least one window opens settings on a section');
});
