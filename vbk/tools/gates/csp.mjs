// Gate 2 (I-02): CSP rules plus an exact snapshot of the effective policy.
// Rules guard the invariants (G-SEC-4); the snapshot makes any policy change a
// reviewed change (`UPDATE_CSP_SNAPSHOT=1 node tools/gates/run.mjs` rewrites it).
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gatesDir, readText, violation, vbkRoot } from './lib/common.mjs';

export const GATE = 'csp';
export const SNAPSHOT_PATH = join(gatesDir, 'csp.snapshot.json');
const CONFS = ['src-tauri/tauri.conf.json', 'src-tauri/tauri.macos.conf.json', 'src-tauri/tauri.windows.conf.json'];

export function parseCsp(csp) {
  const out = {};
  for (const part of String(csp).split(';')) {
    const toks = part.trim().split(/\s+/).filter(Boolean);
    if (toks.length) out[toks[0]] = toks.slice(1);
  }
  return out;
}

/** Rule check on one policy string; returns messages. */
export function checkPolicy(csp) {
  const msgs = [];
  if (typeof csp !== 'string' || csp.trim() === '') return ['app.security.csp is missing or empty (Tauri would then inject none)'];
  const d = parseCsp(csp);
  for (const [name, sources] of Object.entries(d)) {
    if (sources.includes('*')) msgs.push(`\`${name}\` contains the bare wildcard *`);
    if (sources.some((s) => /^(?:https?|wss?|ws):?$/.test(s))) msgs.push(`\`${name}\` allows a whole scheme (${sources.join(' ')})`);
    if (sources.includes("'unsafe-eval'") || sources.includes("'wasm-unsafe-eval'")) msgs.push(`\`${name}\` allows eval`);
  }
  if (!d['default-src']) msgs.push('default-src is missing');
  const script = d['script-src'] ?? d['default-src'] ?? [];
  if (script.length !== 1 || script[0] !== "'self'") msgs.push(`script-src must be exactly 'self' (got ${script.join(' ') || 'none'})`);
  if (!(d['frame-src']?.length === 1 && d['frame-src'][0] === "'none'")) msgs.push("frame-src must be 'none'");
  if (!(d['object-src']?.length === 1 && d['object-src'][0] === "'none'")) msgs.push("object-src must be 'none'");
  return msgs;
}

export function effectivePolicies(root = vbkRoot) {
  const out = {};
  for (const rel of CONFS) {
    const p = join(root, rel);
    if (!existsSync(p)) continue;
    const csp = JSON.parse(readText(p))?.app?.security?.csp;
    if (csp !== undefined || rel.endsWith('tauri.conf.json')) out[rel] = typeof csp === 'string' ? parseCsp(csp) : csp ?? null;
  }
  return out;
}

export function run(root = vbkRoot) {
  const out = [];
  const policies = effectivePolicies(root);
  for (const rel of Object.keys(policies)) {
    const csp = JSON.parse(readText(join(root, rel)))?.app?.security?.csp;
    for (const m of checkPolicy(csp)) out.push(violation(GATE, rel, 0, m));
  }
  if (process.env.UPDATE_CSP_SNAPSHOT === '1') {
    writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(policies, null, 2)}\n`);
  } else if (!existsSync(SNAPSHOT_PATH)) {
    out.push(violation(GATE, 'tools/gates/csp.snapshot.json', 0, 'snapshot missing (run with UPDATE_CSP_SNAPSHOT=1 and review the diff)'));
  } else if (JSON.stringify(JSON.parse(readText(SNAPSHOT_PATH))) !== JSON.stringify(policies)) {
    out.push(violation(GATE, 'tools/gates/csp.snapshot.json', 0, 'effective CSP differs from the reviewed snapshot (review, then UPDATE_CSP_SNAPSHOT=1)'));
  }
  return out;
}

/** Fixture entry point: a fixture file is a tauri.conf.json variant; only the rules apply. */
export function scanFile(file, text) {
  let csp;
  try {
    csp = JSON.parse(text)?.app?.security?.csp;
  } catch {
    return [violation(GATE, file, 0, 'not valid JSON')];
  }
  return checkPolicy(csp).map((m) => violation(GATE, file, 0, m));
}
