#!/usr/bin/env node
/**
 * Bundles the page adapter entry (`ui/dist/packages/web-adapter/src/boot.js`,
 * the tsc ES-module output) and everything it imports into ONE classic
 * script: `ui/bundle/adapter/boot.js`, injected by the host as the
 * per-account webview `initialization_script`.
 *
 * Zero dependencies. A deliberately small bundler for the shapes tsc emits
 * from this repo's sources:
 *   - `import { a, b as c } from './x.js'`, `import * as ns from './x.js'`,
 *     `import './x.js'`
 *   - `export function|async function|class|const|let|var NAME`,
 *     `export { a, b as c }`, `export { a } from './x.js'`, `export * from './x.js'`
 * Anything else (default imports/exports, bare specifiers, dynamic
 * `import()`, cycles) is a hard error rather than a silent mis-bundle.
 *
 * Each module becomes an arrow-function scope evaluated once in
 * topological order; its exports are exposed through getters (live
 * bindings), imports destructure from already-evaluated modules. The output
 * is checked to contain no `eval(`, no `new Function`, no `import(` and to
 * parse as a classic script (`vm.Script`, compiled but never run).
 *
 * Usage (from `vbk/`): `node ui/tools/bundle-adapter.mjs` (after `tsc -p tsconfig.build.json`),
 * or `import { bundleAdapter } from './bundle-adapter.mjs'`.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Script } from 'node:vm';

const uiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const IMPORT_NAMED = /^import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"];?[ \t]*$/gm;
const IMPORT_NS = /^import\s*\*\s*as\s+([A-Za-z_$][\w$]*)\s+from\s*['"]([^'"]+)['"];?[ \t]*$/gm;
const IMPORT_BARE = /^import\s*['"]([^'"]+)['"];?[ \t]*$/gm;
const EXPORT_STAR = /^export\s*\*\s*from\s*['"]([^'"]+)['"];?[ \t]*$/gm;
const EXPORT_FROM = /^export\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"];?[ \t]*$/gm;
const EXPORT_LIST = /^export\s*\{([^}]*)\};?[ \t]*$/gm;
const EXPORT_DECL = /^export\s+((?:async\s+)?function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;

function fail(msg) {
  throw new Error(`[bundle-adapter] ${msg}`);
}

/** `a, b as c` → [[local/imported, alias]]; strips inline `type` leftovers defensively. */
function specifiers(list, file) {
  return list
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map((s) => {
      const m = /^(?:type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(s);
      if (!m) fail(`unsupported specifier "${s}" in ${file}`);
      return [m[1], m[2] ?? m[1]];
    });
}

function resolveSpec(fromFile, spec) {
  if (!spec.startsWith('./') && !spec.startsWith('../')) fail(`bare import "${spec}" in ${fromFile} (the adapter bundle must be dependency-free)`);
  const target = resolve(dirname(fromFile), spec);
  if (!existsSync(target)) fail(`unresolved import "${spec}" in ${fromFile}`);
  return target;
}

function parseModule(file) {
  let src = readFileSync(file, 'utf8').replace(/^\/\/# sourceMappingURL=.*$/gm, '');
  if (/\bimport\s*\(/.test(src)) fail(`dynamic import() in ${file}`);
  if (/^export\s+default\b/m.test(src)) fail(`default export in ${file}`);
  if (/^import\s+[A-Za-z_$][\w$]*\s*(,|from)/m.test(src)) fail(`default import in ${file}`);
  const deps = [];
  const imports = []; // { kind: 'named'|'ns', target, names|ns }
  const reexports = []; // { kind: 'star'|'named', target, names }
  const exports = []; // [local, exported]

  src = src.replace(EXPORT_STAR, (_m, spec) => {
    const target = resolveSpec(file, spec);
    deps.push(target);
    reexports.push({ kind: 'star', target });
    return '';
  });
  src = src.replace(EXPORT_FROM, (_m, list, spec) => {
    const target = resolveSpec(file, spec);
    deps.push(target);
    reexports.push({ kind: 'named', target, names: specifiers(list, file) });
    return '';
  });
  src = src.replace(IMPORT_NAMED, (_m, list, spec) => {
    const target = resolveSpec(file, spec);
    deps.push(target);
    imports.push({ kind: 'named', target, names: specifiers(list, file) });
    return '';
  });
  src = src.replace(IMPORT_NS, (_m, ns, spec) => {
    const target = resolveSpec(file, spec);
    deps.push(target);
    imports.push({ kind: 'ns', target, ns });
    return '';
  });
  src = src.replace(IMPORT_BARE, (_m, spec) => {
    deps.push(resolveSpec(file, spec));
    return '';
  });
  src = src.replace(EXPORT_LIST, (_m, list) => {
    for (const [local, exported] of specifiers(list, file)) exports.push([local, exported]);
    return '';
  });
  src = src.replace(EXPORT_DECL, (_m, kw, name) => {
    exports.push([name, name]);
    return `${kw} ${name}`;
  });
  if (/^\s*(import|export)\b/m.test(src)) fail(`unsupported import/export form left in ${file}`);
  return { file, src, deps, imports, reexports, exports };
}

export function bundleAdapter(opts = {}) {
  const distRoot = opts.distRoot ?? join(uiRoot, 'dist');
  const entry = opts.entry ?? join(distRoot, 'packages', 'web-adapter', 'src', 'boot.js');
  const outFile = opts.outFile ?? join(uiRoot, 'bundle', 'adapter', 'boot.js');
  if (!existsSync(entry)) fail(`entry not found: ${entry} (run tsc -p tsconfig.build.json first)`);

  // depth-first topological order with cycle detection
  const modules = new Map();
  const order = [];
  const state = new Map(); // file -> 'visiting' | 'done'
  const visit = (file, chain) => {
    const s = state.get(file);
    if (s === 'done') return;
    if (s === 'visiting') fail(`import cycle: ${[...chain, file].map((f) => relative(distRoot, f)).join(' -> ')}`);
    state.set(file, 'visiting');
    const mod = parseModule(file);
    modules.set(file, mod);
    for (const d of mod.deps) visit(d, [...chain, file]);
    state.set(file, 'done');
    order.push(file);
  };
  visit(entry, []);

  const ids = new Map(order.map((f, i) => [f, `__vbk_m${i}`]));
  const parts = [];
  parts.push('/* vbk page adapter — generated by ui/tools/bundle-adapter.mjs; do not edit */');
  parts.push('(function () {');
  parts.push("'use strict';");
  parts.push('function __vbk_exports(getters, stars) {');
  parts.push('  var o = {};');
  parts.push('  for (var i = 0; i < stars.length; i++) { var s = stars[i]; Object.keys(s).forEach(function (k) { if (!(k in o)) Object.defineProperty(o, k, { enumerable: true, get: function () { return s[k]; } }); }); }');
  parts.push('  Object.keys(getters).forEach(function (k) { Object.defineProperty(o, k, { enumerable: true, get: getters[k] }); });');
  parts.push('  return Object.freeze(o);');
  parts.push('}');
  for (const file of order) {
    const m = modules.get(file);
    const id = ids.get(file);
    const lines = [];
    lines.push(`// ---- ${relative(distRoot, file)}`);
    lines.push(`var ${id} = (() => {`);
    for (const imp of m.imports) {
      const from = ids.get(imp.target);
      if (imp.kind === 'ns') lines.push(`const ${imp.ns} = ${from};`);
      else if (imp.names.length > 0) lines.push(`const { ${imp.names.map(([a, b]) => (a === b ? a : `${a}: ${b}`)).join(', ')} } = ${from};`);
    }
    lines.push(m.src.trim());
    const getters = [];
    for (const [local, exported] of m.exports) getters.push(`${JSON.stringify(exported)}: () => ${local}`);
    for (const re of m.reexports) {
      if (re.kind !== 'named') continue;
      const from = ids.get(re.target);
      for (const [imported, exported] of re.names) getters.push(`${JSON.stringify(exported)}: () => ${from}[${JSON.stringify(imported)}]`);
    }
    const stars = m.reexports.filter((r) => r.kind === 'star').map((r) => ids.get(r.target));
    lines.push(`return __vbk_exports({ ${getters.join(', ')} }, [${stars.join(', ')}]);`);
    lines.push('})();');
    parts.push(lines.join('\n'));
  }
  parts.push('})();');
  const code = `${parts.join('\n')}\n`;

  if (/\beval\s*\(/.test(code)) fail('output contains eval(');
  if (/\bnew\s+Function\b/.test(code)) fail('output contains new Function');
  if (/\bimport\s*\(/.test(code)) fail('output contains import()');
  try {
    new Script(code, { filename: 'boot.js' }); // compile only, never run
  } catch (e) {
    fail(`output does not parse as a classic script: ${e instanceof Error ? e.message : String(e)}`);
  }

  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, code);
  return { outFile, modules: order.length, bytes: Buffer.byteLength(code) };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const r = bundleAdapter();
  console.log(`[bundle-adapter] ${r.modules} modules, ${r.bytes} bytes → ${relative(resolve(uiRoot, '..'), r.outFile)}`);
}
