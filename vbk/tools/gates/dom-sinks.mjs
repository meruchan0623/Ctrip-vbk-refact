// Gate 4 (I-02): DOM / code-injection sinks, staged.
// B0: zero hits outside `dom-sinks.allowlist.json`, and every allowlist entry must still
// match a real hit (a stale entry fails, so the list cannot rot).
// B1 (I-29 empties the list): strict zero hits, and the list must be an empty array.
import { join } from 'node:path';
import { isStringValued, tsFacts } from './lib/ts-facts.mjs';
import { gatesDir, productionFiles, readText, violation, vbkRoot } from './lib/common.mjs';

export const GATE = 'dom-sinks';

const HTML_SINKS = new Set(['innerHTML', 'outerHTML', 'srcdoc']);
/** Attribute names are case-insensitive in HTML: compared lower-cased. */
const HTML_ATTRS = new Set(['srcdoc']);
const HTML_CALLS = new Set(['insertAdjacentHTML', 'document.write', 'document.writeln']);
/** Last call-path segment that parses HTML / builds code wherever it hangs. */
const SINK_METHODS = new Set(['insertAdjacentHTML', 'createContextualFragment']);
const URL_PROPS = new Set(['href', 'src', 'action', 'formaction', 'formAction', 'data', 'location', 'xlink:href']);
const JS_URL = /^\s*javascript:/i;
/** Global objects through which `eval` / `Function` are reached indirectly. */
const GLOBAL_BASES = /^(?:window|globalThis|self|top|parent|frames)$/;
/** String values that name a sink: `const k = 'innerHTML'; el[k] = x` is the sink one hop away. */
const SINK_NAMES = new Set(['innerHTML', 'outerHTML', 'srcdoc', 'insertAdjacentHTML', 'createContextualFragment', 'eval', 'Function', 'dangerouslySetInnerHTML']);

const isEvalCallee = (callee) => {
  const parts = callee.split('.');
  const last = parts.pop();
  const base = parts.join('.');
  return last === 'eval' && (base === '' || GLOBAL_BASES.test(base));
};
const isFunctionCallee = (callee) => {
  if (callee === 'Function.prototype.constructor') return true;
  const parts = callee.split('.');
  const last = parts.pop();
  const base = parts.join('.');
  return last === 'Function' && (base === '' || GLOBAL_BASES.test(base));
};
const isNavCallee = (callee) => /(?:^|\.)location\.(?:assign|replace)$/.test(callee) || /^(?:(?:window|globalThis|self|top|parent)\.)?open$/.test(callee);

/** Hits in one TS/JS file: [{file, line, sink, message}] (the allowlist is applied by the caller). */
export function scanFile(file, text) {
  const hits = [];
  const add = (line, sink, message) => hits.push({ file, line, sink, message });
  for (const f of tsFacts(text, file)) {
    if (f.type === 'assign' && HTML_SINKS.has(f.name)) add(f.line, f.name, `assignment to \`${f.name}\``);
    if (f.type === 'prop' && f.value !== undefined && f.value !== null && HTML_SINKS.has(f.name)) add(f.line, f.name, `object property \`${f.name}\``);
    if (f.type === 'prop' && f.value !== undefined && f.name === 'dangerouslySetInnerHTML') add(f.line, 'dangerouslySetInnerHTML', 'React `dangerouslySetInnerHTML`');
    if (f.type === 'call') {
      const callee = f.callee ?? '';
      const last = callee.split('.').pop() ?? '';
      if (HTML_CALLS.has(callee) || SINK_METHODS.has(last)) add(f.line, SINK_METHODS.has(last) ? last : callee, `call \`${callee}\``);
      if (isEvalCallee(callee)) add(f.line, 'eval', 'call `eval`');
      if (isFunctionCallee(callee)) add(f.line, 'Function', 'call `Function(…)` builds code from a string');
      if ((callee === 'setTimeout' || callee === 'setInterval' || /^(?:window|globalThis|self)\.set(?:Timeout|Interval)$/.test(callee)) && isStringValued(f.argNodes[0])) {
        add(f.line, callee.split('.').pop(), `\`${callee}\` with a string body`);
      }
      if (/(?:^|\.)setAttribute$/.test(callee)) {
        const attr = (f.args[0] ?? '').toLowerCase();
        if (HTML_ATTRS.has(attr)) add(f.line, attr, `setAttribute("${f.args[0]}")`);
        if (/^on[a-z]+$/.test(attr)) add(f.line, attr, `setAttribute("${f.args[0]}") installs an inline event handler from a string`);
      }
      if (/(?:^|\.)setAttributeNS$/.test(callee)) {
        const attr = (f.args[1] ?? '').toLowerCase();
        if (HTML_ATTRS.has(attr) || /^on[a-z]+$/.test(attr)) add(f.line, attr, `setAttributeNS(…, "${f.args[1]}")`);
      }
      if ((callee === 'Reflect.set' || /^(?:Object|Reflect)\.defineProperty$/.test(callee)) && HTML_SINKS.has(f.args[1] ?? '')) {
        add(f.line, f.args[1], `${callee}(…, "${f.args[1]}", …)`);
      }
      if (/(?:^|\.)createElement(?:NS)?$/.test(callee) && f.args.some((a) => (a ?? '').toLowerCase() === 'script')) {
        add(f.line, 'script', `\`${callee}\` creates a <script> element at runtime`);
      }
    }
    if (f.type === 'new' && isFunctionCallee(f.callee ?? '')) add(f.line, 'new Function', '`new Function(…)` builds code from a string');
    if (f.type === 'string') {
      if (SINK_NAMES.has(f.value ?? '') && !(f.feeds?.kind === 'type')) {
        // a plain prose string ("use innerHTML sparingly") never folds to exactly the name
        add(f.line, f.value, `sink name "${f.value}" as a string value (indirect property access)`);
      }
      if (JS_URL.test(f.prefix ?? '') && f.feeds) {
        const fd = f.feeds;
        const viaProp = (fd.kind === 'prop' || fd.kind === 'assign') && URL_PROPS.has(fd.name ?? '');
        const viaAttr = fd.kind === 'arg' && /(?:^|\.)setAttribute$/.test(fd.callee ?? '') && fd.index === 1 && URL_PROPS.has(fd.first ?? '');
        const viaNav = fd.kind === 'arg' && isNavCallee(fd.callee ?? '');
        if (viaProp || viaAttr || viaNav) add(f.line, 'javascript:', '`javascript:` URL used as a navigation / resource target');
      }
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
