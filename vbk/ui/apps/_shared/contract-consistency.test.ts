/**
 * M1-2: the command list must be identical in every place that names it.
 * commands.txt (ACL generation) = lib.rs generate_handler! = union of views.rs
 * role lists = TS command maps; every capability permission names a real
 * command and grants exactly its role's list.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { AccountCommands, ImCommands, NoticeCommands, NotifyCommands, OrderCommands, PrefsCommands, ShellCommands } from '../../packages/ipc/src/commands.ts';
import { UiCommands } from '../../packages/ipc/src/client.ts';
import { AdapterCommands } from '../../packages/ipc/src/adapterProtocol.ts';

const vbk = join(import.meta.dirname, '..', '..', '..');
const read = (p: string) => readFileSync(join(vbk, p), 'utf8');
const sorted = (xs: Iterable<string>) => [...new Set(xs)].sort();

const txt = sorted(read('src-tauri/commands.txt').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')));
const lib = read('src-tauri/src/lib.rs');
const handler = lib.slice(lib.indexOf('generate_handler!['), lib.indexOf('])', lib.indexOf('generate_handler![')));
const libCmds = sorted([...handler.matchAll(/\w+::(\w+),/g)].map((m) => m[1]!));
const views = read('src-tauri/src/views.rs');
const roleLists: Record<string, string[]> = {};
for (const m of views.matchAll(/const (\w+)_CMDS: &\[&str\] = &\[([\s\S]*?)\];/g)) roleLists[m[1]!] = sorted([...m[2]!.matchAll(/"(\w+)"/g)].map((x) => x[1]!));
const tsCmds = sorted(
  [AccountCommands, ImCommands, NoticeCommands, NotifyCommands, OrderCommands, PrefsCommands, ShellCommands, UiCommands, AdapterCommands].flatMap((o) => Object.values(o) as string[]),
);

test('commands.txt == generate_handler!', () => assert.deepEqual(libCmds, txt));
test('commands.txt == TS command maps', () => assert.deepEqual(tsCmds, txt));
test('every command is allowed for at least one role and roles name only real commands', () => {
  const union = sorted(Object.values(roleLists).flat());
  const notify = txt.filter((c) => !union.includes(c));
  // im_push_fact stays registered for the local adapter path but no window role grants it.
  assert.deepEqual(notify, ['im_push_fact']);
  for (const c of union) assert.ok(txt.includes(c), `${c} in views.rs but not in commands.txt`);
});
test('capability files grant exactly their role list', () => {
  const capToRole: Record<string, string> = { 'main.json': 'MAIN', 'popups.json': 'ALARM', 'notice.json': 'NOTICE', 'setting.json': 'SETTING', 'update.json': 'UPDATE', 'login.json': 'LOGIN', 'adapter.json': 'ADAPTER', 'package-detail.json': 'DETAIL', 'media-viewer.json': 'MEDIA_VIEWER' };
  const files = readdirSync(join(vbk, 'src-tauri/capabilities')).filter((f) => f.endsWith('.json'));
  assert.deepEqual(sorted(files), sorted(Object.keys(capToRole)));
  for (const f of files) {
    const cap = JSON.parse(read(`src-tauri/capabilities/${f}`)) as { permissions: string[] };
    const granted = sorted(cap.permissions.filter((p) => p.startsWith('allow-')).map((p) => p.slice(6).replaceAll('-', '_')));
    assert.deepEqual(granted, roleLists[capToRole[f]!], f);
  }
});

// `sorted` above merges repeats, so a duplicated registration would otherwise pass every equality check.
test('command registrations and role lists cannot hide duplicate entries', () => {
  const dups = (xs: string[]) => sorted(xs.filter((x, i) => xs.indexOf(x) !== i));
  const declared = read('src-tauri/commands.txt').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  assert.deepEqual(dups(declared), [], 'duplicate commands.txt entry');
  assert.deepEqual(dups([...handler.matchAll(/\w+::(\w+),/g)].map((m) => m[1]!)), [], 'duplicate generate_handler! entry');
  for (const m of views.matchAll(/const (\w+)_CMDS: &\[&str\] = &\[([\s\S]*?)\];/g)) {
    assert.deepEqual(dups([...m[2]!.matchAll(/"(\w+)"/g)].map((x) => x[1]!)), [], `duplicate command in ${m[1]}_CMDS`);
  }
});

// I-03: the contract handshake must cover EVERY module's commands, not only commands.rs.
// `HostState::authorize` is the single gated path; a direct `views.authorize` elsewhere would
// let a window skip `contract_hello` for that command.
test('contract handshake is enforced in HostState::authorize and no module bypasses it', () => {
  const state = read('src-tauri/src/state.rs');
  const body = state.slice(state.indexOf('pub fn authorize('));
  assert.ok(/contract_check\(label\)/.test(body.slice(0, body.indexOf('\n    }\n'))), 'HostState::authorize calls commands::contract_check');
  const walk = (dir: string): string[] => readdirSync(join(vbk, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]));
  // Test-only helper methods may precede production methods; only the test
  // module boundary ends this scan, not the first cfg(test) attribute.
  const direct = walk('src-tauri/src')
    .filter((f) => f.endsWith('.rs') && !/(?:_tests|tests)\.rs$/.test(f))
    .filter((f) => /\.views\s*\.authorize\(/.test(read(f).split(/#\[cfg\(test\)\]\s*mod\s+\w+\s*\{/)[0]!));
  assert.deepEqual(direct.sort(), ['src-tauri/src/assistant/order_commands.rs', 'src-tauri/src/state.rs']);
  // order_commands captures the ViewContext only after the gated check
  const cap = read('src-tauri/src/assistant/order_commands.rs');
  const fnCapture = cap.slice(cap.indexOf('fn capture('), cap.indexOf('fn current('));
  assert.ok(fnCapture.indexOf('state.authorize(') < fnCapture.indexOf('.views.authorize('), 'capture() runs HostState::authorize first');
});
