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

// Every adapter op the Rust host sends must be one the page answers: a key of
// `OP_EVIDENCE` (rpc.ts, with its evidence note) or a registered feature op.
// Otherwise the page replies `adapter.unknown_request` only at run time.
const RAW_STR = /b?r(#*)"/y;
const CHAR_LIT = /'(?:\\(?:u\{[0-9a-fA-F]{1,6}\}|x[0-9a-fA-F]{2}|[nrt0\\'"])|[^\\'\n])'/y;
/** Index after the Rust comment / string / char literal starting at `i`, or `i` when none starts there. */
function skipRustToken(src: string, i: number): number {
  const c = src[i];
  if (c === '/' && src[i + 1] === '/') { const n = src.indexOf('\n', i); return n < 0 ? src.length : n; }
  if (c === '/' && src[i + 1] === '*') { const n = src.indexOf('*/', i + 2); return n < 0 ? src.length : n + 2; }
  if (c === '"') { let j = i + 1; while (j < src.length && src[j] !== '"') j += src[j] === '\\' ? 2 : 1; return j + 1; }
  if ((c === 'r' || c === 'b') && !/\w/.test(src[i - 1] ?? '')) {
    RAW_STR.lastIndex = i;
    const m = RAW_STR.exec(src);
    if (m) { const end = `"${m[1]}`; const n = src.indexOf(end, RAW_STR.lastIndex); return n < 0 ? src.length : n + end.length; }
  }
  if (c === "'") { CHAR_LIT.lastIndex = i; if (CHAR_LIT.exec(src)) return CHAR_LIT.lastIndex; }
  return i;
}
/** Top-level comma-separated pieces of the bracket group whose opening bracket is at `open - 1`. */
function rustGroup(src: string, open: number): { parts: string[]; end: number } {
  const parts: string[] = [];
  let depth = 0;
  let start = open;
  for (let i = open; i < src.length; ) {
    const skipped = skipRustToken(src, i);
    if (skipped !== i) { i = skipped; continue; }
    const c = src[i]!;
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) {
      if (depth === 0) { parts.push(src.slice(start, i)); return { parts: parts.map((p) => p.trim()).filter((p) => p !== ''), end: i + 1 }; }
      depth--;
    } else if (c === ',' && depth === 0) { parts.push(src.slice(start, i)); start = i + 1; }
    i++;
  }
  return { parts, end: src.length };
}

test('every adapter op the Rust host forwards is answered by the web adapter', async () => {
  const { OP_EVIDENCE } = await import('../../packages/web-adapter/src/rpc.ts');
  const { createFeatureDispatcher } = await import('../../packages/web-adapter/src/features.ts');
  const { createAdapterFeatures } = await import('../../packages/web-adapter/src/adapterFeatures.ts');
  const features = createFeatureDispatcher(createAdapterFeatures());
  const walk = (dir: string): string[] => readdirSync(join(vbk, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]));
  const sources = walk('src-tauri/src')
    .filter((f) => f.endsWith('.rs') && !/(?:_tests|tests)\.rs$/.test(f))
    .map((f) => read(f).split(/#\[cfg\(test\)\]\s*mod\s+\w+\s*\{/)[0]!);

  // Forwarders: functions taking `op: &str` that hand `op` on towards the page.
  const forwarders = new Map<string, number>();
  for (const src of sources) {
    for (const m of src.matchAll(/\bfn\s+(\w+)\s*(?:<[^()]*?>)?\s*\(/g)) {
      const { parts: params, end } = rustGroup(src, m.index + m[0].length);
      const at = params.findIndex((p) => /^op\s*:\s*&/.test(p));
      if (at < 0) continue;
      const body = rustGroup(src, src.indexOf('{', end) + 1).parts.join(',');
      if (/\b(?:request|request_inner|dispatch_pending)\s*\([^;]*\bop\b/.test(body)) forwarders.set(m[1]!, at);
    }
  }
  for (const name of ['request', 'request_inner', 'forward', 'read', 'send_action']) assert.ok(forwarders.has(name), `forwarder ${name} discovered`);

  const OP = /^"([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)"$/;
  const ops = new Set<string>();
  const calls = new RegExp(`\\b(${[...forwarders.keys()].join('|')})\\s*(?:::<[^()]*?>)?\\(`, 'g');
  for (const src of sources) {
    for (const m of src.matchAll(calls)) {
      const arg = rustGroup(src, m.index + m[0].length).parts[forwarders.get(m[1]!)!];
      const op = arg ? OP.exec(arg)?.[1] : undefined;
      if (op) ops.add(op);
    }
    // Journaled peripheral writes pick their op from a `(op, args)` table.
    const table = src.indexOf('fn peripheral_request(');
    if (table >= 0) {
      const body = rustGroup(src, src.indexOf('{', table) + 1).parts.join(',');
      for (const t of body.matchAll(/=>\s*\(\s*"([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)"\s*,/g)) ops.add(t[1]!);
    }
  }
  // The scan itself must see every call shape: direct, turbofish, wrapper, feature, table.
  for (const op of ['im.send_text', 'im.send_media', 'media.stage_chunk', 'notice.list', 'notice.watch', 'im.forward_message', 'queue.status', 'clock.sample', 'im.invite', 'im.quick_reply_categories', 'im.quick_reply_manage_info', 'im.quick_reply_edit']) {
    assert.ok(ops.has(op), `scan found ${op}`);
  }
  const unanswered = [...ops].filter((op) => !Object.hasOwn(OP_EVIDENCE, op) && !features.has(op)).sort();
  assert.deepEqual(unanswered, []);
});
