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
 *   bundle/dist/**.js[.map]      (no tests, external maps without embedded source)
 *   bundle/adapter/boot.js       (single-file page adapter, see bundle-adapter.mjs)
 *
 * It then checks that every local `href`/`src` in every HTML file resolves
 * inside the bundle, and exits non-zero otherwise, so a broken layout fails
 * the build instead of shipping a window that 404s.
 *
 * Usage (from `vbk/`): `node ui/tools/bundle.mjs`
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bundleAdapter } from './bundle-adapter.mjs';
import { portableSourceMap } from './sourcemaps.mjs';

const uiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vbkRoot = resolve(uiRoot, '..');
const productionOut = join(uiRoot, 'bundle');

function walk(dir) {
  const files = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) files.push(...walk(p));
    else files.push(p);
  }
  return files;
}

export function externalSourceMap(mapFile, jsFile, sourceRoot = uiRoot) {
  return portableSourceMap(JSON.parse(readFileSync(mapFile, 'utf8')), mapFile, jsFile, sourceRoot);
}

/** Optional output must be a caller-owned, existing empty directory. It is never deleted here. */
export function buildBundle({ out: requestedOut } = {}) {
const out = requestedOut === undefined ? productionOut : resolve(requestedOut);
if (requestedOut !== undefined) {
  const info = lstatSync(out);
  if (!info.isDirectory() || info.isSymbolicLink() || readdirSync(out).length !== 0) {
    throw new Error('[bundle] custom output must be an existing empty directory, not a symlink');
  }
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
const MOCK_LOADER = join('dist', 'apps', '_shared', 'mock-loader.js');
const MOCK_ONLY = new Set([MOCK_LOADER, join('dist', 'packages', 'ipc', 'src', 'mock.js')]);
const MOCK_LOADER_STUB = `// Release stub written by ui/tools/bundle.mjs: the mock IPC is not shipped.
export function createMockIpc() { throw new Error('mock IPC is not part of the release bundle'); }
export function scenarioFromLocation() { return 'default'; }
export const MOCK_ORDER_SAMPLES = [];
`;
if (requestedOut === undefined) rmSync(productionOut, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

for (const f of walk(join(uiRoot, 'apps'))) {
  if (/\.(html|css)$/.test(f)) copyInto(f, relative(uiRoot, f));
}
for (const f of walk(join(uiRoot, 'packages'))) {
  if (f.endsWith('.css')) copyInto(f, relative(uiRoot, f));
}
for (const f of walk(join(uiRoot, 'dist'))) {
  if (!f.endsWith('.js') || /\.test\.js$/.test(f) || MOCK_ONLY.has(relative(uiRoot, f))) continue;
  const text = readFileSync(f, 'utf8');
  const mapName = `${basename(f)}.map`;
  const mapRefs = [...text.matchAll(/^\/\/# sourceMappingURL=(.*)$/gm)];
  if (mapRefs.length !== 1 || mapRefs[0][1].trim() !== mapName || !existsSync(`${f}.map`)) throw new Error(`[bundle] missing or nonlocal source map: ${relative(uiRoot, f)}`);
  const map = externalSourceMap(`${f}.map`, f);
  copyInto(f, relative(uiRoot, f));
  writeFileSync(join(out, relative(uiRoot, `${f}.map`)), JSON.stringify(map) + '\n');
}
// The windows select the mock through `apps/_shared/mock-loader`; the release
// bundle gets a data-free stub there and no `mock.js` at all, so neither the
// fake accounts nor the demo order samples ship (release-scan enforces it).
mkdirSync(dirname(join(out, MOCK_LOADER)), { recursive: true });
writeFileSync(join(out, MOCK_LOADER), MOCK_LOADER_STUB);

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

// 4. Single-file page adapter for the per-account webviews' initialization_script.
const adapter = bundleAdapter({ distRoot: join(uiRoot, 'dist'), outFile: join(out, 'adapter', 'boot.js'), sourceMaps: true, sourceRoot: uiRoot });
console.log(`[bundle] adapter: ${adapter.modules} modules, ${adapter.bytes} bytes → ${relative(vbkRoot, adapter.outFile)}`);

// 5. Tone silencer for the built-in browser tabs, which get no adapter.
const silencer = bundleAdapter({
  distRoot: join(uiRoot, 'dist'),
  entry: join(uiRoot, 'dist', 'packages', 'web-adapter', 'src', 'silence-tones-entry.js'),
  outFile: join(out, 'adapter', 'silence-tones.js'),
});
console.log(`[bundle] silencer: ${silencer.modules} modules, ${silencer.bytes} bytes → ${relative(vbkRoot, silencer.outFile)}`);
writeFileSync(join(out, 'source-map-manifest.json'), JSON.stringify({ version: 1, esm: 'external', sources: 'vbk:///ui/', sources_content: false, adapter: { file: 'adapter/boot.js', map: 'adapter/boot.js.map', composed: true } }, null, 2) + '\n');
console.log('[bundle] external ESM and composed adapter source maps retained (no embedded sources)');
return { out, adapter };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) buildBundle();
