// Gate 4 (I-02): DOM / code-injection sinks, staged.
// B0: zero hits outside `dom-sinks.allowlist.json`, and every allowlist entry must still
// match a real hit (a stale entry fails, so the list cannot rot).
// B1 (I-29 empties the list): strict zero hits, and the list must be an empty array.
import { join } from 'node:path';
import { tsFacts } from './lib/ts-facts.mjs';
import { gatesDir, productionFiles, readText, violation, vbkRoot } from './lib/common.mjs';

export const GATE = 'dom-sinks';

const HTML_SINKS = new Set(['innerHTML', 'outerHTML', 'srcdoc']);
const HTML_CALLS = new Set(['insertAdjacentHTML', 'document.write', 'document.writeln']);
const URL_PROPS = new Set(['href', 'src', 'action', 'formaction', 'formAction', 'data', 'location', 'xlink:href']);
const JS_URL = /^\s*javascript:/i;

/** Hits in one TS/JS file: [{file, line, sink, message}] (the allowlist is applied by the caller). */
export function scanFile(file, text) {
  const hits = [];
  const add = (line, sink, message) => hits.push({ file, line, sink, message });
  for (const f of tsFacts(text, file)) {
    if (f.type === 'assign' && HTML_SINKS.has(f.name)) add(f.line, f.name, `assignment to \`${f.name}\``);
    if (f.type === 'prop' && f.value !== undefined && HTML_SINKS.has(f.name) && f.value !== null) add(f.line, f.name, `object property \`${f.name}\``);
    if (f.type === 'call') {
      const callee = f.callee ?? '';
      const last = callee.split('.').pop() ?? '';
      if (HTML_CALLS.has(callee) || last === 'insertAdjacentHTML') add(f.line, last === 'insertAdjacentHTML' ? 'insertAdjacentHTML' : callee, `call \`${callee}\``);
      if (callee === 'eval' || callee === 'window.eval' || callee === 'globalThis.eval') add(f.line, 'eval', 'call `eval`');
      if (callee === 'Function' || callee === 'window.Function' || callee === 'globalThis.Function') add(f.line, 'Function', 'call `Function(…)` builds code from a string');
      if ((callee === 'setTimeout' || callee === 'setInterval') && f.args[0] !== null && f.args[0] !== undefined) add(f.line, callee, `\`${callee}\` with a string body`);
      if (/(?:^|\.)setAttribute$/.test(callee) && HTML_SINKS.has(f.args[0] ?? '')) add(f.line, f.args[0], `setAttribute("${f.args[0]}")`);
    }
    if (f.type === 'new' && (f.callee === 'Function' || f.callee === 'window.Function' || f.callee === 'globalThis.Function')) add(f.line, 'new Function', '`new Function(…)` builds code from a string');
    if (f.type === 'string' && JS_URL.test(f.value) && f.feeds) {
      const fd = f.feeds;
      const viaProp = (fd.kind === 'prop' || fd.kind === 'assign') && URL_PROPS.has(fd.name ?? '');
      const viaAttr = fd.kind === 'arg' && /(?:^|\.)setAttribute$/.test(fd.callee ?? '') && fd.index === 1 && URL_PROPS.has(fd.first ?? '');
      const viaNav = fd.kind === 'arg' && /(?:^|\.)location\.(?:assign|replace)$/.test(fd.callee ?? '');
      if (viaProp || viaAttr || viaNav) add(f.line, 'javascript:', '`javascript:` URL used as a navigation / resource target');
    }
  }
  return hits;
}

export function loadAllowlist(path = join(gatesDir, 'dom-sinks.allowlist.json')) {
  return JSON.parse(readText(path));
}

/** Pure staging logic over `hits` and an allowlist; used by the real run and the fixtures. */
export function judge(hits, allowlist) {
  const out = [];
  if (!Array.isArray(allowlist)) return [violation(GATE, 'tools/gates/dom-sinks.allowlist.json', 0, 'allowlist must be an array')];
  const used = new Set();
  for (const h of hits) {
    const idx = allowlist.findIndex((a) => a.file === h.file && a.line === h.line && a.sink === h.sink);
    if (idx >= 0) used.add(idx);
    else out.push(violation(GATE, h.file, h.line, `${h.message} is not on the allowlist`));
  }
  allowlist.forEach((a, idx) => {
    if (typeof a.expires !== 'string' || a.expires === '') out.push(violation(GATE, 'tools/gates/dom-sinks.allowlist.json', 0, `entry ${a.file}:${a.line} has no \`expires\``));
    if (!used.has(idx)) out.push(violation(GATE, a.file, a.line, `stale allowlist entry (${a.sink} no longer present): remove it`));
  });
  return out;
}

export function run(root = vbkRoot, allowlist = loadAllowlist()) {
  const hits = productionFiles(root).filter((f) => /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/.test(f)).flatMap((rel) => scanFile(rel, readText(join(root, rel))));
  return judge(hits, allowlist);
}
