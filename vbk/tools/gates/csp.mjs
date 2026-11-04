// Gate 2 (I-02): CSP rules plus an exact snapshot of the effective policy.
// Rules guard the invariants (G-SEC-4); the snapshot makes any policy change a
// reviewed change (`UPDATE_CSP_SNAPSHOT=1 node tools/gates/run.mjs` rewrites it).
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gatesDir, readText, violation, vbkRoot } from './lib/common.mjs';

export const GATE = 'csp';
export const SNAPSHOT_PATH = join(gatesDir, 'csp.snapshot.json');

/** `tauri.conf.json` plus every platform overlay Tauri merges (`tauri.<platform>.conf.json`). */
export function confFiles(root = vbkRoot) {
  const dir = join(root, 'src-tauri');
  const names = readdirSync(dir).filter((n) => /^tauri(?:\.[a-z0-9-]+)?\.conf\.json$/.test(n)).sort();
  return names.map((n) => `src-tauri/${n}`);
}

/** Tauri accepts a string or `{directive: "sources" | ["sources"]}`; normalise to the string form. */
export function policyString(csp) {
  if (typeof csp === 'string') return csp;
  if (csp && typeof csp === 'object' && !Array.isArray(csp)) {
    return Object.entries(csp)
      .map(([k, v]) => `${k} ${Array.isArray(v) ? v.join(' ') : String(v)}`)
      .join('; ');
  }
  return csp;
}

/** Directive names are case-insensitive; a repeated directive is reported through `duplicates` (browsers keep the FIRST). */
export function parseCsp(csp) {
  const out = {};
  const duplicates = [];
  for (const part of String(policyString(csp)).split(';')) {
    const toks = part.trim().split(/\s+/).filter(Boolean);
    if (!toks.length) continue;
    const name = toks[0].toLowerCase();
    if (name in out) duplicates.push(name);
    else out[name] = toks.slice(1);
  }
  Object.defineProperty(out, 'duplicates', { value: duplicates, enumerable: false });
  return out;
}

const SCRIPT_DIRECTIVES = ['script-src', 'script-src-elem', 'script-src-attr', 'worker-src', 'child-src'];
const exactly = (sources, allowed) => sources.length === 1 && allowed.includes(sources[0]);

/** Rule check on one policy string; returns messages. */
export function checkPolicy(csp) {
  const msgs = [];
  const text = policyString(csp);
  if (typeof text !== 'string' || text.trim() === '') return ['app.security.csp is missing or empty (Tauri would then inject none)'];
  const d = parseCsp(text);
  for (const name of d.duplicates) msgs.push(`\`${name}\` appears more than once (browsers keep the first occurrence)`);
  for (const [name, sources] of Object.entries(d)) {
    if (sources.includes('*')) msgs.push(`\`${name}\` contains the bare wildcard *`);
    if (sources.some((s) => /^(?:https?|wss?|ws):?$/.test(s))) msgs.push(`\`${name}\` allows a whole scheme (${sources.join(' ')})`);
    if (sources.some((s) => /^[a-z]+:\/\/\*(?:\.[a-z0-9-]+)?$/i.test(s))) msgs.push(`\`${name}\` allows any host of a scheme / TLD (${sources.join(' ')})`);
    if (sources.includes("'unsafe-eval'") || sources.includes("'wasm-unsafe-eval'")) msgs.push(`\`${name}\` allows eval`);
  }
  if (!d['default-src']) msgs.push('default-src is missing');
  const script = d['script-src'] ?? d['default-src'] ?? [];
  if (!exactly(script, ["'self'"])) msgs.push(`script-src must be exactly 'self' (got ${script.join(' ') || 'none'})`);
  // the granular directives override script-src for their element / attribute / worker scope
  for (const name of SCRIPT_DIRECTIVES.slice(1)) {
    if (d[name] !== undefined && !exactly(d[name], ["'self'", "'none'"])) msgs.push(`\`${name}\` overrides script-src and must be exactly 'self' or 'none' (got ${d[name].join(' ') || 'none'})`);
  }
  if (d['base-uri'] !== undefined && !exactly(d['base-uri'], ["'self'", "'none'"])) msgs.push(`\`base-uri\` must be 'self' or 'none' (got ${d['base-uri'].join(' ')})`);
  // The operator iframe has one fixed production origin. No wildcard, 'self',
  // data/blob source or additional frame host is permitted.
  if (!(d['frame-src']?.length === 1 && ["'none'", 'https://csagent.tsim.tech'].includes(d['frame-src'][0]))) msgs.push("frame-src must be 'none' or exactly https://csagent.tsim.tech");
  if (!(d['object-src']?.length === 1 && d['object-src'][0] === "'none'")) msgs.push("object-src must be 'none'");
  return msgs;
}

/** `app.security.dangerous*` flags weaken the CSP / isolation and must stay off. */
export function checkSecurity(security) {
  const msgs = [];
  for (const [k, v] of Object.entries(security ?? {})) {
    if (/^dangerous/i.test(k) && v !== false && v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0)) {
      msgs.push(`app.security.${k} is set (${JSON.stringify(v)}); dangerous* options must stay off`);
    }
  }
  return msgs;
}

export function effectivePolicies(root = vbkRoot) {
  const out = {};
  for (const rel of confFiles(root)) {
    const p = join(root, rel);
    if (!existsSync(p)) continue;
    const csp = JSON.parse(readText(p))?.app?.security?.csp;
    if (csp !== undefined || rel.endsWith('/tauri.conf.json')) out[rel] = typeof policyString(csp) === 'string' ? parseCsp(csp) : csp ?? null;
  }
  return out;
}

export function run(root = vbkRoot) {
  const out = [];
  const policies = effectivePolicies(root);
  for (const rel of confFiles(root)) {
    const security = JSON.parse(readText(join(root, rel)))?.app?.security;
    if (rel in policies) for (const m of checkPolicy(security?.csp)) out.push(violation(GATE, rel, 0, m));
    for (const m of checkSecurity(security)) out.push(violation(GATE, rel, 0, m));
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
  let security;
  try {
    security = JSON.parse(text)?.app?.security;
  } catch {
    return [violation(GATE, file, 0, 'not valid JSON')];
  }
  return [...checkPolicy(security?.csp), ...checkSecurity(security)].map((m) => violation(GATE, file, 0, m));
}
