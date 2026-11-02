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
import { execFileSync } from 'node:child_process';
import { AccountCommands, ImCommands, NotifyCommands, OrderCommands, PrefsCommands } from '../../packages/ipc/src/commands.ts';
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
  [AccountCommands, ImCommands, NotifyCommands, OrderCommands, PrefsCommands, UiCommands, AdapterCommands].flatMap((o) => Object.values(o) as string[]),
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
  const capToRole: Record<string, string> = { 'main.json': 'MAIN', 'popups.json': 'ALARM', 'setting.json': 'SETTING', 'update.json': 'UPDATE', 'login.json': 'LOGIN', 'adapter.json': 'ADAPTER', 'package-detail.json': 'DETAIL' };
  const files = readdirSync(join(vbk, 'src-tauri/capabilities')).filter((f) => f.endsWith('.json'));
  assert.deepEqual(sorted(files), sorted(Object.keys(capToRole)));
  for (const f of files) {
    const cap = JSON.parse(read(`src-tauri/capabilities/${f}`)) as { permissions: string[] };
    const granted = sorted(cap.permissions.filter((p) => p.startsWith('allow-')).map((p) => p.slice(6).replaceAll('-', '_')));
    assert.deepEqual(granted, roleLists[capToRole[f]!], f);
  }
});

test('capability matrix covers registered labels in both directions and restricts remote grants', () => {
  const output = execFileSync(process.execPath, [join(vbk, 'tools/gates/capability-matrix.mjs'), '--check', '--json'], { encoding: 'utf8' });
  const matrix = JSON.parse(output) as { labels: string[]; rows: { capability: string; command: string; remote_urls: string[] }[] };
  assert.equal(matrix.labels.length, 7);
  assert.equal(matrix.rows.filter((row) => row.capability === 'adapter').length, 7);
  assert.ok(matrix.rows.filter((row) => row.remote_urls.length).every((row) => row.capability === 'adapter'));
});

test('command registrations and role lists cannot hide duplicate entries', () => {
  const declared = read('src-tauri/commands.txt').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  assert.equal(declared.length, new Set(declared).size, 'duplicate command registration');
  const handlers = [...handler.matchAll(/\w+::(\w+),/g)].map((m) => m[1]!);
  assert.equal(handlers.length, new Set(handlers).size, 'duplicate generate_handler registration');
  for (const role of views.matchAll(/const (\w+)_CMDS: &\[&str\] = &\[([\s\S]*?)\];/g)) {
    const commands = [...role[2]!.matchAll(/"(\w+)"/g)].map((m) => m[1]!);
    assert.equal(commands.length, new Set(commands).size, `duplicate role command in ${role[1]}`);
  }
});
