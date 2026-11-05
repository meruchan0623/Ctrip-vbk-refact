#!/usr/bin/env node
// Source-level security gates (I-02). `node tools/gates/run.mjs` runs the fixture self-test and then
// every gate against the real tree; exit code 1 on any problem. `--self-test` / `--tree` run one half.
// cjk-literals is enforced by default; `--with-deferred` is accepted as a no-op for backward compatibility.
import { pathToFileURL } from 'node:url';
import { formatViolation } from './lib/common.mjs';
import { selfTest } from './lib/selftest.mjs';
import * as tls from './tls-debug.mjs';
import * as dom from './dom-sinks.mjs';
import * as csp from './csp.mjs';
import * as cap from './capability-matrix.mjs';
import * as dev from './devtools-launch.mjs';
import * as pw from './no-password-fields.mjs';
import * as cjk from './cjk-literals.mjs';

export const gates = [tls, dom, csp, cap, dev, pw, cjk];

export function runTree() {
  return gates.flatMap((g) => g.run());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const only = process.argv.includes('--self-test') ? 'self' : process.argv.includes('--tree') ? 'tree' : 'all';
  let failed = false;
  if (only !== 'tree') {
    const { results, problems } = selfTest();
    console.log(`[gates] fixtures: ${results.filter((r) => r.ok).length}/${results.length} behave as required`);
    for (const p of problems) console.error(`  FIXTURE FAIL: ${p}`);
    failed ||= problems.length > 0;
  }
  if (only !== 'self') {
    const violations = runTree();
    console.log(`[gates] tree: ${violations.length} violation(s) across ${gates.length} gates`);
    for (const v of violations) console.error(`  ${formatViolation(v)}`);
    failed ||= violations.length > 0;
  }
  process.exit(failed ? 1 : 0);
}
