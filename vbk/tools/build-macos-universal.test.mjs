import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { buildUniversal, projectRoot } from './build-macos-universal.mjs';

function fixture(t, intercept = () => {}) {
  const root = mkdtempSync(join(tmpdir(), 'vbk-universal-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const release = join(root, 'src-tauri/target/universal-apple-darwin/release');
  mkdirSync(release, { recursive: true });
  writeFileSync(join(root, 'src-tauri/tauri.conf.json'), JSON.stringify({ productName: 'App with spaces' }));
  const app = join(release, 'bundle/macos/App with spaces.app');
  const put = (file) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, 'fixture'); };
  const calls = [];
  const run = (command, args, options) => {
    calls.push({ command, args, options });
    const result = intercept(command, args, options);
    if (result !== undefined) return result;
    if (args.includes('build') && args.includes('--no-bundle')) put(join(release, 'vbk-host'));
    if (command === '/usr/bin/lipo' && args[0] === '-create') put(args.at(-1));
    if (args.includes('bundle') && !args.includes('--no-bundle')) {
      assert.equal(existsSync(join(app, 'stale')), false);
      for (const binary of ['vbk-host', 'vbk-browser-bridge']) put(join(app, 'Contents/MacOS', binary));
    }
    return command === '/usr/bin/lipo' && args[0] === '-archs' ? 'x86_64 arm64\n' : '';
  };
  return { root, release, app, calls, run, put };
}

test('root is script-relative and every command uses fixed cwd/target; both packaged binaries verified', (t) => {
  assert.ok(isAbsolute(projectRoot));
  const f = fixture(t);
  f.put(join(f.app, 'stale'));
  assert.equal(buildUniversal({ ...f, platform: 'darwin', env: { CARGO_TARGET_DIR: '/wrong' } }), f.app);
  for (const { options } of f.calls) {
    assert.equal(options.cwd, f.root);
    assert.equal(options.env.CARGO_TARGET_DIR, join(f.root, 'src-tauri/target'));
  }
  assert.deepEqual(f.calls.filter(c => c.command === 'cargo').map(c => c.args.slice(-4)), [
    ['--target', 'aarch64-apple-darwin', '--bin', 'vbk-browser-bridge'],
    ['--target', 'x86_64-apple-darwin', '--bin', 'vbk-browser-bridge'],
  ]);
  const bundleIndex = f.calls.findIndex(c => c.args[1] === 'bundle');
  assert.ok(bundleIndex > 0);
  assert.ok(f.calls[bundleIndex].args.includes('--no-sign'));
  assert.deepEqual(f.calls.slice(-2).map(c => c.args.at(-1)),
    ['vbk-host', 'vbk-browser-bridge'].map(b => join(f.app, 'Contents/MacOS', b)));
});

test('cargo failure aborts before lipo or bundling', (t) => {
  const f = fixture(t, (command) => { if (command === 'cargo') throw new Error('cargo failed'); });
  assert.throws(() => buildUniversal({ ...f, platform: 'darwin' }), /cargo failed/);
  assert.equal(f.calls.some(c => c.command === '/usr/bin/lipo'), false);
});

test('thin bridge cannot replace output or enter bundling; temporary cleaned', (t) => {
  const f = fixture(t, (command, args) => {
    if (command === '/usr/bin/lipo' && args[0] === '-archs') return 'arm64';
  });
  assert.throws(() => buildUniversal({ ...f, platform: 'darwin' }), /Expected arm64/);
  assert.equal(existsSync(join(f.release, 'vbk-browser-bridge')), false);
  assert.equal(existsSync(join(f.release, `vbk-browser-bridge.${process.pid}.tmp`)), false);
  assert.equal(f.calls.some(c => c.args[1] === 'bundle'), false);
});

test('thin main cannot enter bundling', (t) => {
  const f = fixture(t, (command, args) => {
    if (command === '/usr/bin/lipo' && args[0] === '-archs' && args[1].endsWith('/vbk-host')) return 'x86_64';
  });
  assert.throws(() => buildUniversal({ ...f, platform: 'darwin' }), /Expected arm64/);
  assert.equal(f.calls.some(c => c.args[1] === 'bundle'), false);
});

test('failed bundler cannot leave stale app passing verification', (t) => {
  const f = fixture(t, (_command, args) => {
    if (args[1] === 'bundle') throw new Error('bundle failed');
  });
  f.put(join(f.app, 'stale'));
  assert.throws(() => buildUniversal({ ...f, platform: 'darwin' }), /bundle failed/);
  assert.equal(existsSync(f.app), false);
});

test('thin packaged binary is rejected even after successful bundler', (t) => {
  const f = fixture(t, (command, args) => {
    if (command === '/usr/bin/lipo' && args[0] === '-archs' && args[1].includes('.app/')) return 'arm64';
  });
  assert.throws(() => buildUniversal({ ...f, platform: 'darwin' }), /Expected arm64/);
});

test('non-macOS fails before invoking tools', () => {
  assert.throws(() => buildUniversal({ platform: 'linux', run: () => assert.fail('must not execute') }), /requires macOS/);
});
