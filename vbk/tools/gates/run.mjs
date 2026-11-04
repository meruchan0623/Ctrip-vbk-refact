#!/usr/bin/env node
// Source-level security gates (I-02). `node tools/gates/run.mjs` runs the fixture self-test and then
// every gate against the real tree; exit code 1 on any problem. `--self-test` / `--tree` run one half.
// `--with-deferred` additionally enforces the deferred gates (cjk-literals, see below).
import { formatViolation } from './lib/common.mjs';
import { selfTest } from './lib/selftest.mjs';
import * as tls from './tls-debug.mjs';
import * as dom from './dom-sinks.mjs';
import * as csp from './csp.mjs';
import * as cap from './capability-matrix.mjs';
import * as dev from './devtools-launch.mjs';
import * as pw from './no-password-fields.mjs';
import * as cjk from './cjk-literals.mjs';

export const gates = [tls, dom, csp, cap, dev, pw];

// Deferred gate: cjk-literals is complete and self-tested (fixtures run in `selfTest`), but the
// main-window UI still carries untranslated literals that are being migrated separately. Its
// real-tree result is reported but does not fail the run. Enable enforcement (and add `cjk` to
// `gates`) once the migration lands; until then run it alone with `npm run gates:cjk`
// (`node tools/gates/run.mjs --tree --with-deferred`), which does fail on violations.
export const deferredGates = [cjk];

export function runTree() {
  return gates.flatMap((g) => g.run());
}

if (import.meta.url === `file://${process.argv[1]}`) {
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
    const enforceDeferred = process.argv.includes('--with-deferred');
    for (const g of deferredGates) {
      const found = g.run();
      const files = new Set(found.map((v) => v.file));
      console.log(`[gates] deferred ${g.GATE}: ${found.length} violation(s) in ${files.size} file(s) (${enforceDeferred ? 'enforced' : 'not enforced yet'})`);
      if (enforceDeferred) for (const v of found) console.error(`  ${formatViolation(v)}`);
      failed ||= enforceDeferred && found.length > 0;
    }
  }
  process.exit(failed ? 1 : 0);
}
