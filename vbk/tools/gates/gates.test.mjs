import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { filesBelow, read, root, rustProduction } from './source.mjs';
import { scanDom, checkDom } from './dom-sinks.mjs';
import { scanSecurity, checkSecurity } from './source-security.mjs';
import { validateCsp, validateRelease, validateStoreSchema } from './configuration.mjs';
import { registeredLabels, validateCapabilities } from './capability-matrix.mjs';

const gates = {
  'dom-sinks': (file) => assert.deepEqual(scanDom(read(file), file), []),
  'source-security': (file) => assert.deepEqual(scanSecurity(read(file), file), []),
  csp: (file) => validateCsp(JSON.parse(read(file)).csp),
  'release-features': (file) => { const f = JSON.parse(read(file)); validateRelease(f.manifest, f.commands); },
  capabilities: (file) => { const f = JSON.parse(read(file)); validateCapabilities(f.capabilities, f.labels, f.commands); },
  'store-schema': (file) => validateStoreSchema(read(file)),
};
for (const [gate, validate] of Object.entries(gates)) {
  for (const group of ['must-fail', 'must-pass']) {
    const fixtures = filesBelow(join(root, 'tools/gates/fixtures', gate, group));
    test(`${gate}: ${group} has at least three independent fixtures`, () => assert.ok(fixtures.length >= 3));
    for (const file of fixtures) test(`${gate}: ${group}/${file.split('/').at(-1)}`, () => {
      if (group === 'must-fail') assert.throws(() => validate(file), `missed forbidden fixture ${file}`);
      else validate(file);
    });
  }
}

test('production traversal rejects injected sinks and excludes test files and cfg(test) items', () => {
  const base = mkdtempSync(join(tmpdir(), 'vbk-source-gates-'));
  try {
    for (const dir of ['crates/sample', 'src-tauri/src', 'ui/packages', 'ui/apps', 'tools/gates']) mkdirSync(join(base, dir), { recursive: true });
    writeFileSync(join(base, 'tools/gates/dom-sinks.allowlist.json'), '[]');
    writeFileSync(join(base, 'ui/apps/probe.test.ts'), 'new Function(source); options.rejectUnauthorized = false;');
    writeFileSync(join(base, 'crates/sample/probe_tests.rs'), 'fn bad() { builder.danger_accept_invalid_certs(true); }');
    writeFileSync(join(base, 'crates/sample/probe.rs'), '#[cfg(test)] mod tests { fn bad() { builder.danger_accept_invalid_certs(true); } }');
    assert.deepEqual(checkDom(base), []); assert.deepEqual(checkSecurity(base), []);
    writeFileSync(join(base, 'ui/apps/probe.ts'), 'element["inner"+"HTML"] = source; Object.defineProperty(navigator,"webdriver",{});');
    writeFileSync(join(base, 'crates/sample/probe.rs'), 'fn bad() { builder.danger_accept_invalid_certs(\n true); }');
    assert.equal(checkDom(base).length, 1);
    assert.equal(checkSecurity(base).length, 2);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('DOM exceptions fail when stale, duplicated or broadened', () => {
  const base = mkdtempSync(join(tmpdir(), 'vbk-dom-allowlist-'));
  try {
    for (const dir of ['crates', 'src-tauri/src', 'ui/packages', 'ui/apps/main', 'tools/gates']) mkdirSync(join(base, dir), { recursive: true });
    const entry = { file: 'ui/apps/main/companion-card.ts', line: 1, sink: 'innerHTML', expires: 'B1/I-29' };
    writeFileSync(join(base, entry.file), 'element.innerHTML = source;');
    const allowlist = join(base, 'tools/gates/dom-sinks.allowlist.json');
    writeFileSync(allowlist, JSON.stringify([entry]));
    assert.deepEqual(checkDom(base), []);
    writeFileSync(join(base, entry.file), 'element.textContent = source;');
    assert.throws(() => checkDom(base), /Stale/);
    writeFileSync(allowlist, JSON.stringify([entry, entry]));
    assert.throws(() => checkDom(base));
    writeFileSync(allowlist, JSON.stringify([{ ...entry, file: 'ui/apps/main/other.ts' }]));
    assert.throws(() => checkDom(base), /Invalid/);
    writeFileSync(allowlist, '[]');
    assert.deepEqual(checkDom(base), []);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('Rust lexer preserves lifetimes and offsets, skips nested comments, raw strings and test blocks', () => {
  const source = `fn ordinary<'a>(s: &'a str) { let unicode = "💬"; builder.danger_accept_invalid_certs(true); }
/* outer /* danger_accept_invalid_certs */ inner */
#[cfg(test)] mod synthetic { fn test() { let text = r##"}"##; rejectUnauthorized(); } }
fn production() { rejectUnauthorized(); }`;
  const code = rustProduction(source);
  assert.equal(code.length, source.length);
  const hits = scanSecurity(source, 'fixture.rs');
  assert.deepEqual(hits.map((h) => h.line), [1, 4]);
  assert.ok(code.includes("ordinary<'a>"));
});

test('view labels are derived from production constants including dynamic prefixes', () => {
  assert.deepEqual(registeredLabels('pub const MAIN: &str = "main";\npub const ACCOUNT_WEBVIEW_PREFIX: &str = "acct-";\n// pub const EVIL: &str = "*";'), ['main', 'acct-*']);
});
