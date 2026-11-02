import { checkSecurity } from './source-security.mjs';
import { checkDom } from './dom-sinks.mjs';
import { buildMatrix } from './capability-matrix.mjs';
import { checkConfiguration } from './configuration.mjs';
import { formatHits } from './source.mjs';

let failed = false;
for (const [name, check] of [['source security', checkSecurity], ['DOM sinks', checkDom], ['CSP, release and store schema', checkConfiguration], ['capability matrix', buildMatrix]]) {
  try {
    const result = check();
    if (Array.isArray(result) && result.length) throw new Error(formatHits(result));
    console.log(`${name}: passed`);
  } catch (error) { failed = true; console.error(`${name}: FAILED\n${error.message}`); }
}
if (failed) process.exitCode = 1;
