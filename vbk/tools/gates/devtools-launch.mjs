// Gate 5 (I-02): DevTools is a non-default feature and never part of a release build;
// no browser launch switches except the reviewed ones (G-SEC-6).
// The release-build attempt (F12 / context menu) is real-machine evidence (R02), not here.
import { existsSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { listFiles, readText, repoRoot, violation, vbkRoot, gatesDir } from './lib/common.mjs';
import { isDebugOnlyAttr, isFeatureAttr, rustTokens, stripCfgItems, lexRust, stripCfgTest, withConcatStrings } from './lib/rust-lex.mjs';

export const GATE = 'devtools-launch';

// ----------------------------------------------------------------- TOML (subset)

/**
 * Minimal TOML reader for Cargo manifests: sections (`[a.b]`, quoted keys),
 * `key = value` with multi-line arrays and inline tables. Returns
 * [{section, key, value(raw text, one line), line}].
 */
export function tomlEntries(text) {
  const out = [];
  const lines = text.split('\n');
  let section = '';
  const stripComment = (s) => {
    let q = null;
    for (let i = 0; i < s.length; i += 1) {
      const c = s[i];
      if (q) {
        if (c === '\\' && q === '"') i += 1;
        else if (c === q) q = null;
      } else if (c === '"' || c === "'") q = c;
      else if (c === '#') return s.slice(0, i);
    }
    return s;
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = stripComment(lines[i]).trim();
    if (!line) continue;
    const sec = /^\[\[?(.+?)\]\]?$/.exec(line);
    if (sec) {
      section = sec[1].replace(/["']/g, '').trim();
      continue;
    }
    const kv = /^([A-Za-z0-9_."'-]+)\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    const start = i + 1;
    let value = kv[2];
    const balance = (s) => (s.match(/[[{]/g) ?? []).length - (s.match(/[\]}]/g) ?? []).length;
    while (balance(value) > 0 && i + 1 < lines.length) {
      i += 1;
      value += ` ${stripComment(lines[i]).trim()}`;
    }
    out.push({ section, key: kv[1].replace(/["']/g, ''), value: value.trim(), line: start });
  }
  return out;
}

const listOf = (raw) => [...raw.matchAll(/"([^"]*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2]);
const featuresOfInline = (raw) => {
  const m = /features\s*=\s*\[([^\]]*)\]/.exec(raw);
  return m ? listOf(m[1]) : [];
};

/**
 * Feature names of the host manifest that (transitively) turn on
 * `tauri/devtools`. `devtools` itself is always included so the build-command
 * check stays meaningful without a manifest.
 */
export function devtoolsFeatures(text) {
  const features = {};
  for (const e of tomlEntries(text)) if (e.section === 'features') features[e.key] = listOf(e.value);
  const enables = (name, seen = new Set()) => {
    if (seen.has(name)) return false;
    seen.add(name);
    return (features[name] ?? []).some((dep) => /(?:^|\/)devtools$/.test(dep) || (dep in features && enables(dep, seen)));
  };
  return [...new Set(['devtools', ...Object.keys(features).filter((n) => enables(n))])];
}

/** Cargo.toml: `devtools` must not be default and must not be enabled on the tauri dependency. */
export function scanCargo(file, text) {
  const out = [];
  const entries = tomlEntries(text);
  const aliases = devtoolsFeatures(text);
  for (const e of entries) {
    const isDepTable = /(?:^|\.)dependencies$/.test(e.section);
    const isTauriTable = /(?:^|\.)dependencies\.tauri$/.test(e.section);
    if (e.section === 'features' && e.key === 'default' && listOf(e.value).some((f) => aliases.includes(f) || /(?:^|\/)devtools$/.test(f))) {
      out.push(violation(GATE, file, e.line, '`devtools` must not be in default features (directly or through another feature)'));
    }
    if (isDepTable && e.key === 'tauri' && featuresOfInline(e.value).includes('devtools')) out.push(violation(GATE, file, e.line, 'the tauri dependency must not enable `devtools`'));
    if (isTauriTable && e.key === 'features' && listOf(e.value).includes('devtools')) out.push(violation(GATE, file, e.line, 'the tauri dependency must not enable `devtools`'));
    if (/^profile\.release/.test(e.section) && /devtools/.test(e.value)) out.push(violation(GATE, file, e.line, 'release profile mentions devtools'));
  }
  return out;
}

// ---------------------------------------------------------- build commands

const BUILD_LINE = /(?:tauri\s+build|cargo\s+build|cargo\s+tauri|cargo\s+install|release|cargo\s+auditable)/;

/**
 * Workflow / script lines: a build or release command must not request the
 * devtools feature (by any alias, `-F`, `--features=`, `--all-features`) and
 * no step may export `CARGO_FEATURE_<ALIAS>`.
 */
export function scanBuildCommands(file, text, aliases = ['devtools']) {
  const out = [];
  const names = aliases.map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const featureList = new RegExp(`(?:^|\\s)(?:-F|--features)(?:=|\\s+)["']?([^"'\\s]+(?:\\s*,\\s*[^"'\\s]+)*)`, 'g');
  const envFlag = new RegExp(`\\bCARGO_FEATURE_(?:${names.replace(/-/g, '_').toUpperCase()})\\b`);
  text.split('\n').forEach((raw, idx) => {
    const line = raw.replace(/^\s*#.*$/, '');
    if (envFlag.test(line)) out.push(violation(GATE, file, idx + 1, 'CARGO_FEATURE_* turns the devtools feature on for the build'));
    if (!BUILD_LINE.test(line)) return;
    if (/(?:^|\s)--all-features(?:\s|$)/.test(line)) out.push(violation(GATE, file, idx + 1, 'build/release command uses --all-features (includes devtools)'));
    for (const m of line.matchAll(featureList)) {
      const feats = m[1].split(/[\s,]+/).filter(Boolean);
      if (feats.some((f) => aliases.includes(f) || /(?:^|\/)devtools$/.test(f))) out.push(violation(GATE, file, idx + 1, `build/release command enables the devtools feature (${feats.join(',')})`));
    }
  });
  return out;
}

/** tauri*.conf.json: no window may request `devtools: true`. */
export function scanTauriConf(file, text) {
  let conf;
  try {
    conf = JSON.parse(text);
  } catch {
    return [violation(GATE, file, 0, 'not valid JSON')];
  }
  const out = [];
  for (const w of conf?.app?.windows ?? []) if (w?.devtools === true) out.push(violation(GATE, file, 0, `window ${JSON.stringify(w.label ?? '?')} sets devtools: true`));
  return out;
}

// ------------------------------------------------------------------- Rust

/**
 * Rust: every `--switch` string token in production code must be reviewed, and
 * `open_devtools` may only be called under `#[cfg(debug_assertions)]` or
 * `#[cfg(feature = "<devtools alias>")]`.
 */
export function scanLaunchArgs(file, text, allowed, aliases = ['devtools']) {
  const out = [];
  for (const t of rustTokens(text)) {
    if (t.t === 'str' && /^--[a-z][a-z0-9-]*(?:=.*)?$/.test(t.v.trim())) {
      const name = t.v.trim().split('=')[0];
      if (!allowed.includes(name)) out.push(violation(GATE, file, t.line, `launch switch "${name}" is not in tools/gates/launch-args.allowlist.json`));
    }
  }
  const release = withConcatStrings(stripCfgItems(stripCfgTest(lexRust(text)), (attr) => isDebugOnlyAttr(attr) || isFeatureAttr(attr, aliases)));
  for (const t of release) {
    if (t.t === 'id' && t.v === 'open_devtools') out.push(violation(GATE, file, t.line, '`open_devtools` reachable in a release build (guard it with cfg(debug_assertions) or the devtools feature)'));
  }
  return out;
}

export function scanFile(file, text, allowed = [], aliases = ['devtools']) {
  const ext = extname(file);
  if (ext === '.toml') return scanCargo(file, text);
  if (ext === '.yml' || ext === '.yaml') return scanBuildCommands(file, text, aliases);
  if (ext === '.json') return [...scanBuildCommands(file, text, aliases), ...scanTauriConf(file, text)];
  if (ext === '.rs') return scanLaunchArgs(file, text, allowed, aliases);
  return [];
}

export function run(root = vbkRoot) {
  const out = [];
  const allowed = JSON.parse(readText(join(gatesDir, 'launch-args.allowlist.json'))).map((a) => a.name);
  const cargo = readText(join(root, 'src-tauri/Cargo.toml'));
  const aliases = devtoolsFeatures(cargo);
  out.push(...scanCargo('src-tauri/Cargo.toml', cargo));
  out.push(...scanBuildCommands('package.json', readText(join(root, 'package.json')), aliases));
  for (const n of readdirSync(join(root, 'src-tauri')).filter((n) => /^tauri(?:\.[a-z0-9-]+)?\.conf\.json$/.test(n)).sort()) {
    out.push(...scanFile(`src-tauri/${n}`, readText(join(root, 'src-tauri', n)), allowed, aliases));
  }
  const wf = join(repoRoot, '.github/workflows');
  if (existsSync(wf)) for (const f of readdirSync(wf).filter((n) => /\.ya?ml$/.test(n))) out.push(...scanBuildCommands(`.github/workflows/${f}`, readText(join(wf, f)), aliases));
  for (const rel of listFiles(root, 'src-tauri/src').filter((f) => f.endsWith('.rs') && !/(?:_tests|(?:^|\/)tests)\.rs$/.test(f))) {
    out.push(...scanLaunchArgs(rel, readText(join(root, rel)), allowed, aliases));
  }
  return out;
}
