// Gate 5 (I-02): DevTools is a non-default feature and never part of a release build;
// no browser launch switches except the reviewed ones (G-SEC-6).
// The release-build attempt (F12 / context menu) is real-machine evidence (R02), not here.
import { existsSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { listFiles, readText, repoRoot, violation, vbkRoot, gatesDir } from './lib/common.mjs';
import { rustTokens } from './lib/rust-lex.mjs';

export const GATE = 'devtools-launch';

const stripTomlComment = (line) => line.replace(/\s+#.*$/, '').replace(/^\s*#.*$/, '');

/** Cargo.toml: `devtools` must not be default and must not be enabled on the tauri dependency. */
export function scanCargo(file, text) {
  const out = [];
  let section = '';
  text.split('\n').forEach((raw, idx) => {
    const line = stripTomlComment(raw).trim();
    if (!line) return;
    const sec = /^\[(.+)\]$/.exec(line);
    if (sec) {
      section = sec[1];
      return;
    }
    const lineNo = idx + 1;
    if (section === 'features' && /^default\s*=/.test(line) && /devtools/.test(line)) out.push(violation(GATE, file, lineNo, '`devtools` must not be in default features'));
    if (/^tauri\s*=/.test(line) && /devtools/.test(line)) out.push(violation(GATE, file, lineNo, 'the tauri dependency must not enable `devtools`'));
    if (/^\[(?:profile\.release)/.test(`[${section}]`) && /devtools/.test(line)) out.push(violation(GATE, file, lineNo, 'release profile mentions devtools'));
  });
  return out;
}

/** Workflow / script lines: a build or release command must not request the devtools feature. */
export function scanBuildCommands(file, text) {
  const out = [];
  text.split('\n').forEach((raw, idx) => {
    const line = raw.replace(/^\s*#.*$/, '');
    if (/(?:tauri\s+build|cargo\s+build|cargo\s+tauri|release)/.test(line) && /--features?[=\s]+\S*devtools/.test(line)) out.push(violation(GATE, file, idx + 1, 'build/release command enables the devtools feature'));
  });
  return out;
}

/** Rust: every `--switch` string token in production code must be reviewed. */
export function scanLaunchArgs(file, text, allowed) {
  const out = [];
  for (const t of rustTokens(text)) {
    if (t.t === 'str' && /^--[a-z][a-z0-9-]*(?:=.*)?$/.test(t.v.trim())) {
      const name = t.v.trim().split('=')[0];
      if (!allowed.includes(name)) out.push(violation(GATE, file, t.line, `launch switch "${name}" is not in tools/gates/launch-args.allowlist.json`));
    }
  }
  return out;
}

export function scanFile(file, text, allowed = []) {
  const ext = extname(file);
  if (ext === '.toml') return scanCargo(file, text);
  if (ext === '.yml' || ext === '.yaml' || ext === '.json') return scanBuildCommands(file, text);
  if (ext === '.rs') return scanLaunchArgs(file, text, allowed);
  return [];
}

export function run(root = vbkRoot) {
  const out = [];
  const allowed = JSON.parse(readText(join(gatesDir, 'launch-args.allowlist.json'))).map((a) => a.name);
  out.push(...scanCargo('src-tauri/Cargo.toml', readText(join(root, 'src-tauri/Cargo.toml'))));
  out.push(...scanBuildCommands('package.json', readText(join(root, 'package.json'))));
  out.push(...scanBuildCommands('src-tauri/tauri.conf.json', readText(join(root, 'src-tauri/tauri.conf.json'))));
  const wf = join(repoRoot, '.github/workflows');
  if (existsSync(wf)) for (const f of readdirSync(wf).filter((n) => /\.ya?ml$/.test(n))) out.push(...scanBuildCommands(`.github/workflows/${f}`, readText(join(wf, f))));
  for (const rel of listFiles(root, 'src-tauri/src').filter((f) => f.endsWith('.rs') && !/(?:_tests|(?:^|\/)tests)\.rs$/.test(f))) {
    out.push(...scanLaunchArgs(rel, readText(join(root, rel)), allowed));
  }
  return out;
}
