import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { SourceMap, createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { bundleAdapter } from './bundle-adapter.mjs';
import { buildBundle, externalSourceMap } from './bundle.mjs';
import { scanBuffer, scanPaths } from '../../tools/release-scan.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const tsc = createRequire(join(root, 'package.json')).resolve('typescript/bin/tsc');
function files(dir) { return readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]); }

function fixture(run) {
  const dir = mkdtempSync(join(tmpdir(), 'vbk-source-map-'));
  try { return run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('composed classic adapter throw resolves to the original TS through wrappers, multiline imports, export columns, CRLF and UTF-16', () => fixture(dir => {
  const src = join(dir, 'ui'), dist = join(dir, 'dist'); mkdirSync(src);
  writeFileSync(join(src, 'dep.ts'), "export const marker = '🧭';\r\nexport const offset = 1;\r\n");
  const source = ['import {', '  marker,', '  offset as count', "} from './dep.js';", '', 'export function boom() {', '  const text = "😀"; throw new Error("SYMBOL_TARGET" + marker + count + text);', '}', 'boom();', ''].join('\r\n');
  writeFileSync(join(src, 'boot.ts'), source);
  execFileSync(process.execPath, [tsc, '--target', 'ES2022', '--module', 'ESNext', '--sourceMap', '--inlineSources', '--rootDir', src, '--outDir', dist, join(src, 'boot.ts')], { stdio: 'pipe', cwd: dir });
  const out = join(dir, 'release', 'boot.js');
  bundleAdapter({ distRoot: dist, entry: join(dist, 'boot.js'), outFile: out, sourceMaps: true, sourceRoot: src });
  const code = readFileSync(out, 'utf8'), raw = JSON.parse(readFileSync(`${out}.map`, 'utf8'));
  assert.ok(code.endsWith('//# sourceMappingURL=boot.js.map\n'));
  assert.equal(raw.file, 'boot.js'); assert.equal(raw.sourcesContent, undefined);
  assert.ok(raw.sources.every(s => s.startsWith('vbk:///ui/')));
  assert.equal(JSON.stringify(raw).includes(dir), false);
  let error; try { new Script(code, { filename: 'boot.js' }).runInNewContext(); } catch (e) { error = e; }
  assert.match(error?.message ?? '', /SYMBOL_TARGET/);
  const match = /at boom \(boot\.js:(\d+):(\d+)\)/.exec(error.stack);
  assert.ok(match, error.stack);
  const map = new SourceMap(raw), entry = map.findEntry(Number(match[1]) - 1, Number(match[2]) - 1);
  assert.equal(entry.originalSource, 'vbk:///ui/boot.ts');
  assert.equal(entry.originalLine, 6);
  assert.equal(entry.originalColumn, source.split('\r\n')[6].indexOf('new Error'));
  assert.equal(map.findEntry(0, 0).originalSource, undefined, 'generated banner and wrapper have no invented source');
  const generatedReturn = code.indexOf('return __vbk_exports({');
  const returnPrefix = code.slice(0, generatedReturn);
  assert.equal(map.findEntry(returnPrefix.split('\n').length - 1, 0).originalSource, undefined, 'generated module export wrappers do not inherit adjacent source mappings');
  const depAt = code.indexOf('const marker');
  const before = code.slice(0, depAt), depEntry = map.findEntry(before.split('\n').length - 1, before.length - before.lastIndexOf('\n') - 1);
  assert.equal(depEntry.originalSource, 'vbk:///ui/dep.ts', 'modules keep distinct source identities');
}));

for (const [name, terminator] of [['LF', '\n'], ['CR', '\r'], ['CRLF', '\r\n'], ['LS', '\u2028'], ['PS', '\u2029']]) {
  test(`composed adapter maps a real V8 throw after a retained ${name} template line terminator`, () => fixture(dir => {
    const src = join(dir, 'ui'), dist = join(dir, 'dist'); mkdirSync(src);
    const source = `export function boom() {\n  const text = \`😀${terminator}second\`; throw new Error('MAP_TERMINATOR' + text);\n}\nboom();\n`;
    writeFileSync(join(src, 'boot.ts'), source);
    execFileSync(process.execPath, [tsc, '--target', 'ES2022', '--module', 'ESNext', '--sourceMap', '--rootDir', src, '--outDir', dist, join(src, 'boot.ts')], { stdio: 'pipe', cwd: dir });
    const out = join(dir, 'release', 'boot.js');
    bundleAdapter({ distRoot: dist, entry: join(dist, 'boot.js'), outFile: out, sourceMaps: true, sourceRoot: src });
    const code = readFileSync(out, 'utf8');
    if (name === 'LS' || name === 'PS') assert.ok(code.includes(terminator), 'exercise a retained separator rather than an escaped JS string');
    let error; try { new Script(code, { filename: 'boot.js' }).runInNewContext(); } catch (e) { error = e; }
    assert.match(error?.message ?? '', /MAP_TERMINATOR/);
    const match = /at boom \(boot\.js:(\d+):(\d+)\)/.exec(error.stack);
    assert.ok(match, error.stack);
    const map = new SourceMap(JSON.parse(readFileSync(`${out}.map`, 'utf8')));
    const entry = map.findEntry(Number(match[1]) - 1, Number(match[2]) - 1);
    assert.equal(entry.originalSource, 'vbk:///ui/boot.ts');
    assert.equal(entry.originalLine, 2);
    assert.equal(entry.originalColumn, 'second`; throw '.length);
  }));
}

test('external maps reject machine paths and strip private source content and extensions', () => fixture(dir => {
  const mapFile = join(dir, 'main.js.map'), js = join(dir, 'main.js');
  const base = { version: 3, file: 'main.js', sourceRoot: '', sources: ['main.ts'], names: [], mappings: 'AAAA', sourcesContent: ['PRIVATE'], private_path: dir };
  writeFileSync(mapFile, JSON.stringify(base));
  const clean = externalSourceMap(mapFile, js, dir);
  assert.deepEqual(clean.sources, ['vbk:///ui/main.ts']);
  assert.equal(JSON.stringify(clean).includes('PRIVATE'), false); assert.equal(JSON.stringify(clean).includes(dir), false);
  for (const sources of [['/Users/private/main.ts'], ['C:\\Users\\private\\main.ts'], ['file:///private/main.ts'], ['../escape.ts']]) {
    writeFileSync(mapFile, JSON.stringify({ ...base, sources }));
    assert.throws(() => externalSourceMap(mapFile, js, dir));
  }
}));

test('real release keeps exact ESM maps and composed adapter map, excludes mock maps, and passes the release scanner', () => fixture(dir => {
  const out = join(dir, 'release'); mkdirSync(out);
  const result = buildBundle({ out }), release = files(result.out);
  assert.equal(result.out, out);
  const maps = release.filter(f => f.endsWith('.map'));
  assert.ok(maps.length > 50);
  for (const mapFile of maps) {
    const raw = JSON.parse(readFileSync(mapFile, 'utf8'));
    assert.equal(raw.sourcesContent, undefined);
    assert.equal(raw.file, basename(mapFile).slice(0, -4));
    assert.ok(raw.sources.every(s => s.startsWith('vbk:///ui/') && !s.includes('..')));
    assert.equal(JSON.stringify(raw).includes(root), false);
  }
  assert.equal(release.some(f => /[\\/]mock\.js(?:\.map)?$/.test(f)), false);
  assert.equal(release.some(f => /mock-loader\.js\.map$/.test(f)), false);
  const mapFile = join(result.out, 'dist/apps/main/main.js.map');
  const raw = JSON.parse(readFileSync(mapFile, 'utf8'));
  assert.equal(raw.mappings, JSON.parse(readFileSync(join(root, 'ui/dist/apps/main/main.js.map'), 'utf8')).mappings, 'unmodified ESM retains exact tsc positions');
  assert.deepEqual(scanPaths([result.out]).findings, []);
  assert.deepEqual(scanBuffer(Buffer.from('{"sourcesContent":["Emma Wilson"]}'), 'leak.js.map').map(f => f.rule), ['mock-data'], 'scanner continues to inspect map bytes');
}));


test('custom bundle output refuses nonempty directories and symlinks without deleting caller files', () => fixture(dir => {
  const out = join(dir, 'occupied'); mkdirSync(out);
  const marker = join(out, 'keep.txt'); writeFileSync(marker, 'caller-owned');
  assert.throws(() => buildBundle({ out }), /existing empty directory/);
  assert.equal(readFileSync(marker, 'utf8'), 'caller-owned');
  const empty = join(dir, 'empty'); mkdirSync(empty);
  const link = join(dir, 'link'); symlinkSync(empty, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => buildBundle({ out: link }), /not a symlink/);
  assert.deepEqual(readdirSync(empty), []);
}));
