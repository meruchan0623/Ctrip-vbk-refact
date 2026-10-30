#!/usr/bin/env node
/**
 * Assembles `ui/bundle/` — the directory Tauri embeds as `frontendDist`.
 *
 * The HTML entries reference their assets relative to the `ui/` tree
 * (`../../packages/ui-kit/src/*.css`, `../../dist/apps/<app>/main.js`), the
 * same layout the Playwright smoke test serves. This script compiles the
 * TypeScript (`tsc -p tsconfig.build.json` → `ui/dist`) and copies exactly
 * the runtime files into `ui/bundle/` with that layout preserved:
 *
 *   bundle/apps/<app>/index.html, *.css
 *   bundle/packages/ui-kit/src/*.css
 *   bundle/dist/**.js            (no tests, no source maps)
 *
 * It then checks that every local `href`/`src` in every HTML file resolves
 * inside the bundle, and exits non-zero otherwise, so a broken layout fails
 * the build instead of shipping a window that 404s.
 *
 * Usage (from `vbk/`): `node ui/tools/bundle.mjs`
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const uiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vbkRoot = resolve(uiRoot, '..');
const out = join(uiRoot, 'bundle');

function walk(dir) {
  const files = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files.push(...walk(p));
    else files.push(p);
  }
  return files;
}

function copyInto(src, rel) {
  const dest = join(out, rel);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest);
}

// 1. Compile. Prefer a project-local TypeScript run through this Node binary
// (works the same on Windows, where `tsc` on PATH is a `.cmd` shim that
// `execFileSync` cannot launch without a shell); fall back to `tsc` on PATH.
const tscArgs = ['-p', 'tsconfig.build.json'];
const opts = { cwd: vbkRoot, stdio: 'inherit' };
let localTsc = null;
try {
  localTsc = createRequire(join(vbkRoot, 'package.json')).resolve('typescript/bin/tsc');
} catch {
  localTsc = null;
}
if (process.env.TSC) execFileSync(process.env.TSC, tscArgs, opts);
else if (localTsc) execFileSync(process.execPath, [localTsc, ...tscArgs], opts);
else execFileSync('tsc', tscArgs, { ...opts, shell: process.platform === 'win32' });

// 2. Assemble.
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

for (const f of walk(join(uiRoot, 'apps'))) {
  if (/\.(html|css)$/.test(f)) copyInto(f, relative(uiRoot, f));
}
for (const f of walk(join(uiRoot, 'packages'))) {
  if (f.endsWith('.css')) copyInto(f, relative(uiRoot, f));
}
for (const f of walk(join(uiRoot, 'dist'))) {
  if (f.endsWith('.js') && !/\.test\.js$/.test(f)) copyInto(f, relative(uiRoot, f));
}

// 3. Verify every local reference resolves inside the bundle.
const refRe = /\b(?:href|src)\s*=\s*"([^"]+)"/g;
const missing = [];
const htmlFiles = walk(out).filter((f) => f.endsWith('.html'));
for (const html of htmlFiles) {
  const text = readFileSync(html, 'utf8');
  for (const m of text.matchAll(refRe)) {
    const ref = m[1];
    if (/^(?:[a-z]+:|#|\/\/)/i.test(ref)) continue;
    const target = resolve(dirname(html), ref.split(/[?#]/)[0]);
    if (!target.startsWith(out + sep) || !existsSync(target)) {
      missing.push(`${relative(out, html)} -> ${ref}`);
    }
  }
}
// ES module imports inside the compiled JS must resolve too.
const importRe = /\bfrom\s*['"](\.{1,2}\/[^'"]+)['"]|\bimport\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;
for (const js of walk(join(out, 'dist'))) {
  const text = readFileSync(js, 'utf8');
  for (const m of text.matchAll(importRe)) {
    const ref = m[1] ?? m[2];
    const target = resolve(dirname(js), ref);
    if (!target.startsWith(out + sep) || !existsSync(target)) {
      missing.push(`${relative(out, js)} -> ${ref}`);
    }
  }
}

if (htmlFiles.length === 0) missing.push('(no html entries found)');
if (missing.length > 0) {
  console.error(`[bundle] ${missing.length} unresolved reference(s):`);
  for (const m of missing) console.error(`  ${m}`);
  process.exit(1);
}
console.log(`[bundle] ${htmlFiles.length} html entries, ${walk(out).length} files → ${relative(vbkRoot, out)}`);
