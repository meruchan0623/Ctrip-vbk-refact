// node:test wrapper (run by `npm test` and CI): fixtures self-test + real tree must be clean.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { formatViolation } from './lib/common.mjs';
import { selfTest } from './lib/selftest.mjs';
import { gates } from './run.mjs';
import * as dom from './dom-sinks.mjs';
import * as dev from './devtools-launch.mjs';
import * as csp from './csp.mjs';
import { tauriCommands, rustTokens } from './lib/rust-lex.mjs';

test('gate fixtures: must-fail are flagged, must-pass stay clean, at least 3 of each per gate', () => {
  const { problems } = selfTest();
  assert.deepEqual(problems, []);
});

for (const g of gates) {
  test(`gate ${g.GATE}: zero violations on the real tree`, () => {
    assert.deepEqual(g.run().map(formatViolation), []);
  });
}

test('dom-sinks B1 state (I-29 merged): allowlist is empty, strict zero hits', () => {
  assert.deepEqual(dom.loadAllowlist(), []);
});

test('devtools-launch: a renamed feature that enables tauri/devtools is an alias for the build-command check', () => {
  const toml = '[features]\ndefault = []\ninspect = ["tauri/devtools"]\nbundle = ["inspect"]\n';
  assert.deepEqual(dev.devtoolsFeatures(toml).sort(), ['bundle', 'devtools', 'inspect']);
  const wf = 'jobs:\n  r:\n    steps:\n      - run: cargo tauri build --features bundle\n';
  assert.equal(dev.scanBuildCommands('w.yml', wf, dev.devtoolsFeatures(toml)).length, 1, 'alias flagged');
  assert.equal(dev.scanBuildCommands('w.yml', wf, ['devtools']).length, 0, 'unknown without the manifest');
  // the real manifest: only `devtools` itself enables tauri/devtools
  assert.deepEqual(dev.devtoolsFeatures(readVbk('src-tauri/Cargo.toml')), ['devtools']);
});

test('rust lexer: bare #[command] is a command; cfg(test) never swallows a neighbouring field or arm; cfg_attr/any/not keep the item', () => {
  const bare = tauriCommands('use tauri::command;\n#[command]\npub fn x(window: Window, path: String) {}');
  assert.deepEqual(bare.map((c) => c.name), ['x']);
  const ids = (src) => rustTokens(src).filter((t) => t.t === 'id').map((t) => t.v);
  assert.ok(ids('struct S {\n #[cfg(test)]\n a: u8,\n danger: u8,\n}').includes('danger'));
  assert.ok(!ids('#[cfg(test)]\nmod t { fn a() { if x { y } } }\nfn keep() {}').includes('y'));
  assert.ok(ids('#[cfg_attr(test, allow(dead_code))]\nfn keep() {}').includes('keep'));
  assert.ok(ids('#[cfg(any(test, feature = "x"))]\nfn keep() {}').includes('keep'));
  assert.ok(ids('#[cfg(not(test))]\nfn keep() {}').includes('keep'));
  assert.ok(!ids('#[test]\nfn gone() {}\nfn keep() {}').includes('gone'));
  assert.deepEqual(rustTokens('const A: &str = concat!("--ignore-", "certificate-errors");').filter((t) => t.synthetic).map((t) => t.v), ['--ignore-certificate-errors']);
  assert.deepEqual(rustTokens('const A: &str = "--ignore-\\\n    certificate-errors";').filter((t) => t.t === 'str').map((t) => t.v), ['--ignore-certificate-errors']);
});

test('csp: every tauri*.conf.json overlay is in the snapshot set and directive names are case-insensitive', () => {
  assert.ok(csp.confFiles().includes('src-tauri/tauri.conf.json'));
  assert.ok(csp.confFiles().every((f) => /^src-tauri\/tauri(?:\.[a-z0-9-]+)?\.conf\.json$/.test(f)));
  const d = csp.parseCsp("Default-Src 'self'; SCRIPT-SRC 'self'; script-src 'none'");
  assert.deepEqual(d['default-src'], ["'self'"]);
  assert.deepEqual(d['script-src'], ["'self'"], 'first occurrence wins, as in browsers');
  assert.deepEqual(d.duplicates, ['script-src']);
});

function readVbk(rel) {
  return readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
}
