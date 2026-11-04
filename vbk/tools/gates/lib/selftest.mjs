// Gate self-test: every gate has fixtures under fixtures/<gate>/{must-fail,must-pass}/.
// must-fail files are deliberate false negatives for a naive scanner (computed keys, multi-line
// calls, ...) and MUST be flagged; must-pass files are deliberate false positives for a naive
// grep (comments, strings, cfg(test)) and MUST stay clean. At least MIN of each per gate.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { gatesDir, mergePatch, readText } from './common.mjs';
import * as tls from '../tls-debug.mjs';
import * as dom from '../dom-sinks.mjs';
import * as csp from '../csp.mjs';
import * as cap from '../capability-matrix.mjs';
import * as dev from '../devtools-launch.mjs';
import * as pw from '../no-password-fields.mjs';
import * as cjk from '../cjk-literals.mjs';

export const MIN_FIXTURES = 3;
const fixturesDir = join(gatesDir, 'fixtures');

const runners = {
  'tls-debug': (name, text) => tls.scanFile(name, text),
  'dom-sinks': (name, text) => {
    if (name.endsWith('.allowlist-case.json')) {
      const c = JSON.parse(text);
      return dom.judge(dom.scanFile(c.file, c.text), c.allowlist);
    }
    return dom.judge(dom.scanFile(name, text), []);
  },
  csp: (name, text) => csp.scanFile(name, text),
  'capability-matrix': (name, text, ctx) => cap.check(mergePatch(ctx.base, JSON.parse(text))),
  'devtools-launch': (name, text) => dev.scanFile(name, text, ['--vbk-crash-monitor']),
  'no-password-fields': (name, text) => pw.scanFile(name, text),
  'cjk-literals': (name, text) => cjk.scanFile(name, text),
};

export function selfTest() {
  const results = [];
  const problems = [];
  for (const gate of Object.keys(runners)) {
    const ctx = gate === 'capability-matrix' ? { base: JSON.parse(readText(join(fixturesDir, gate, 'base.json'))) } : {};
    for (const kind of ['must-fail', 'must-pass']) {
      let names = [];
      try {
        names = readdirSync(join(fixturesDir, gate, kind)).sort();
      } catch {
        // reported below as "too few fixtures"
      }
      if (names.length < MIN_FIXTURES) problems.push(`${gate}/${kind}: ${names.length} fixtures, need at least ${MIN_FIXTURES}`);
      for (const name of names) {
        const violations = runners[gate](name, readText(join(fixturesDir, gate, kind, name)), ctx);
        const ok = kind === 'must-fail' ? violations.length > 0 : violations.length === 0;
        results.push({ gate, kind, name, ok, violations });
        if (!ok) problems.push(kind === 'must-fail' ? `${gate}/${kind}/${name}: not flagged (false negative)` : `${gate}/${kind}/${name}: flagged (false positive): ${violations.map((v) => v.message).join('; ')}`);
      }
    }
  }
  return { results, problems };
}
