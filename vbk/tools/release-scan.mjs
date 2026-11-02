#!/usr/bin/env node
// Release artifact string scan (plan I-24 / I-18 / I-29).
//
// Fails (exit 1) when a built artifact contains
//   * a test/pre-production host name (fat*/uat/fws/qa.nt ... ctripcorp/tripqate),
//   * the demo data shipped by the UI mock, or a mock bundle file,
// and records the artifact size (optionally compared with a previous report).
//
// Usage:
//   node vbk/tools/release-scan.mjs [--report out.json] [--baseline prev.json]
//        [--allow-match <substring>]... <file-or-dir>...
//
// std-only (node:fs, node:path, node:url). Binary-safe: each file is scanned
// as raw bytes, as Latin-1 text, and as Latin-1 text with NUL bytes removed
// (which exposes UTF-16LE strings in Windows executables).
// Exit codes: 0 clean, 1 violations, 2 usage / IO error.

import { readFileSync, readdirSync, lstatSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** @type {{id:string, re:RegExp}[]} */
export const TEXT_RULES = [
  { id: 'test-host-qa-nt', re: /[a-z0-9.-]*\bqa\.nt\.[a-z0-9.-]+/gi },
  { id: 'test-host-env', re: /[a-z0-9.-]*\.(?:fat\d*|uat|fws)\.[a-z0-9.-]*(?:ctrip|tripqate)[a-z0-9.-]*/gi },
  { id: 'test-host-nt', re: /[a-z0-9.-]*\.nt\.(?:ctripcorp|tripqate)\.com/gi },
];

/** UTF-8 demo strings from ui/packages/ipc/src/mock.ts. */
export const MOCK_MARKERS = ['云游·小王', 'Emma Wilson', '3051228766'];

const MOCK_FILE = /^mock(\.[a-z0-9]+)*\.(?:js|mjs|map|ts)$/i;
const MAX_FILE_BYTES = 400 * 1024 * 1024;

/**
 * @param {Buffer} buf
 * @param {string} name   used in findings only
 * @param {{allowMatch?: string[]}} [opts]
 * @returns {{file:string, rule:string, evidence:string}[]}
 */
export function scanBuffer(buf, name, opts = {}) {
  const allow = opts.allowMatch ?? [];
  const out = [];
  const views = [buf.toString('latin1'), Buffer.from(buf.filter((b) => b !== 0)).toString('latin1')];
  for (const { id, re } of TEXT_RULES) {
    const seen = new Set();
    for (const text of views) {
      for (const m of text.matchAll(re)) {
        const ev = m[0].slice(0, 120);
        if (allow.some((a) => ev.includes(a)) || seen.has(ev)) continue;
        seen.add(ev);
        if (seen.size <= 5) out.push({ file: name, rule: id, evidence: ev });
      }
    }
  }
  for (const marker of MOCK_MARKERS) {
    if (buf.includes(Buffer.from(marker, 'utf8')) && !allow.some((a) => marker.includes(a))) {
      out.push({ file: name, rule: 'mock-data', evidence: marker });
    }
  }
  return out;
}

/** @param {string} p */
export function* walk(p) {
  const st = lstatSync(p);
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    for (const e of readdirSync(p).sort()) yield* walk(join(p, e));
  } else if (st.isFile()) {
    yield { path: p, size: st.size };
  }
}

/**
 * @param {string[]} roots
 * @param {{allowMatch?: string[]}} [opts]
 */
export function scanPaths(roots, opts = {}) {
  const findings = [];
  const sizes = {};
  const skipped = [];
  for (const root of roots) {
    let total = 0;
    for (const f of walk(root)) {
      total += f.size;
      if (MOCK_FILE.test(basename(f.path))) {
        findings.push({ file: f.path, rule: 'mock-file', evidence: basename(f.path) });
      }
      if (f.size > MAX_FILE_BYTES) {
        skipped.push(f.path);
        continue;
      }
      findings.push(...scanBuffer(readFileSync(f.path), f.path, opts));
    }
    sizes[root] = total;
  }
  return { findings, sizes, skipped };
}

function parseArgs(argv) {
  const a = { roots: [], report: null, baseline: null, allowMatch: [] };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--report') a.report = argv[++i];
    else if (v === '--baseline') a.baseline = argv[++i];
    else if (v === '--allow-match') a.allowMatch.push(argv[++i]);
    else if (v.startsWith('--')) throw new Error(`unknown option ${v}`);
    else a.roots.push(v);
  }
  if (a.roots.length === 0) throw new Error('no input paths');
  if ([a.report, a.baseline, ...a.allowMatch].some((x) => x === undefined)) throw new Error('missing option value');
  return a;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`release-scan: ${e.message}`);
    console.error('usage: release-scan.mjs [--report f] [--baseline f] [--allow-match s]... <path>...');
    return 2;
  }
  let res;
  try {
    res = scanPaths(args.roots, { allowMatch: args.allowMatch });
  } catch (e) {
    console.error(`release-scan: ${e.message}`);
    return 2;
  }
  let baseline = null;
  if (args.baseline) {
    try {
      baseline = JSON.parse(readFileSync(args.baseline, 'utf8')).sizes ?? null;
    } catch {
      console.error(`release-scan: baseline ${args.baseline} unreadable, size comparison skipped`);
    }
  }
  for (const [p, n] of Object.entries(res.sizes)) {
    const prev = baseline?.[p];
    const delta = typeof prev === 'number' ? ` (${n - prev >= 0 ? '+' : ''}${n - prev} vs baseline)` : '';
    console.log(`size ${p}: ${n} bytes${delta}`);
  }
  for (const s of res.skipped) console.error(`skipped (too large): ${s}`);
  for (const f of res.findings) console.error(`FOUND [${f.rule}] ${f.file}: ${f.evidence}`);
  if (args.report) writeFileSync(args.report, JSON.stringify({ sizes: res.sizes, findings: res.findings, skipped: res.skipped }, null, 2) + '\n');
  if (res.findings.length > 0) {
    console.error(`release-scan: ${res.findings.length} finding(s)`);
    return 1;
  }
  console.log('release-scan: clean');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
