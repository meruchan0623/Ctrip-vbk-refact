#!/usr/bin/env node
// Local unsigned .app build. Does not install, notarize, or publish artifacts.
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdirSync, rmSync, renameSync, lstatSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const universal = 'universal-apple-darwin';
const targets = ['aarch64-apple-darwin', 'x86_64-apple-darwin'];
const binaries = ['vbk-host', 'vbk-browser-bridge'];

function execute(command, args, options) {
  console.log(`> ${JSON.stringify([command, ...args])}`);
  const result = spawnSync(command, args, options);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed (${result.signal ?? result.status})`);
  return result.stdout ?? '';
}

export function buildUniversal({ root = projectRoot, platform = process.platform, run = execute, env = process.env } = {}) {
  if (platform !== 'darwin') throw new Error('The universal macOS build requires macOS and Xcode command-line tools.');
  const targetDir = join(root, 'src-tauri', 'target');
  const releaseDir = join(targetDir, universal, 'release');
  const cli = join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
  const options = { cwd: root, env: { ...env, CARGO_TARGET_DIR: targetDir }, stdio: 'inherit' };
  const call = (command, args) => run(command, args, options);
  const verify = (file) => {
    if (!lstatSync(file).isFile()) throw new Error(`Expected a regular binary: ${file}`);
    const arches = String(run('/usr/bin/lipo', ['-archs', file], {
      ...options, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8',
    })).trim().split(/\s+/).sort();
    if (arches.join(',') !== 'arm64,x86_64') throw new Error(`Expected arm64 + x86_64: ${file}; found ${arches.join(',')}`);
    console.log(`Verified arm64 + x86_64: ${file}`);
  };

  // The installed CLI merges only the main executable for universal builds.
  // Always run Cargo (incremental reuse is fine) rather than trusting stale files.
  call(process.execPath, [cli, 'build', '--target', universal, '--no-bundle', '--no-sign', '--ci', '--', '--locked']);
  for (const target of targets) {
    call('cargo', ['build', '--manifest-path', join(root, 'src-tauri', 'Cargo.toml'),
      '--locked', '--release', '--target', target, '--bin', 'vbk-browser-bridge']);
  }
  mkdirSync(releaseDir, { recursive: true });
  const bridge = join(releaseDir, 'vbk-browser-bridge');
  const temporary = `${bridge}.${process.pid}.tmp`;
  try {
    call('/usr/bin/lipo', ['-create', ...targets.map((target) => join(targetDir, target, 'release', 'vbk-browser-bridge')),
      '-output', temporary]);
    verify(temporary);
    renameSync(temporary, bridge);
  } finally {
    rmSync(temporary, { force: true });
  }
  for (const binary of binaries) verify(join(releaseDir, binary));

  const config = JSON.parse(readFileSync(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  const product = config.productName;
  if (typeof product !== 'string' || !product || product === '.' || product === '..' || /[/\\]/.test(product)) {
    throw new Error('Expected a plain productName in tauri.conf.json');
  }
  const app = join(releaseDir, 'bundle', 'macos', `${product}.app`);
  // Only this generated app is removed: an old bundle must not satisfy checks.
  rmSync(app, { recursive: true, force: true });
  call(process.execPath, [cli, 'bundle', '--target', universal, '--bundles', 'app', '--no-sign', '--ci']);
  for (const binary of binaries) verify(join(app, 'Contents', 'MacOS', binary));
  console.log(`Unsigned universal app: ${app}`);
  return app;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw new Error('Usage: node tools/build-macos-universal.mjs (no arguments)');
    buildUniversal();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
