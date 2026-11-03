// Gate 3 (I-02): command list agreement, capability matrix and remote surface.
//   commands.ts  <->  commands.txt  <->  lib.rs generate_handler!  <->  capabilities/*.json  <->  views.rs
// The matrix {command x window/webview labels x remote.urls} is generated from the capability
// files at build time into `src-tauri/gen/capability-matrix.json` (never hand-written) and is
// cross-checked against the label constants in `views.rs` in both directions.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { commandMaps } from './lib/ts-facts.mjs';
import { tauriCommands } from './lib/rust-lex.mjs';
import { gatesDir, listFiles, readText, violation, vbkRoot } from './lib/common.mjs';

export const GATE = 'capability-matrix';

/** capability file -> role list constant in views.rs (`<ROLE>_CMDS`). */
export const CAP_ROLE = {
  'main.json': 'MAIN',
  'popups.json': 'ALARM',
  'setting.json': 'SETTING',
  'update.json': 'UPDATE',
  'login.json': 'LOGIN',
  'adapter.json': 'ADAPTER',
  'package-detail.json': 'DETAIL',
};

const ADAPTER_URLS = ['https://imvendor.ctrip.com/*', 'https://vbooking.ctrip.com/*'];
const ADAPTER_PERMISSIONS = [
  'allow-adapter-identity',
  'allow-adapter-push-display',
  'allow-adapter-push-fact',
  'allow-adapter-ready',
  'allow-adapter-reply',
  'core:event:allow-listen',
  'core:event:allow-unlisten',
];

/** Parameter names that would make a command an arbitrary path / SQL / program primitive. */
const FORBIDDEN_PARAMS = new Set(['path', 'file', 'file_path', 'filepath', 'filename', 'dir', 'directory', 'folder', 'sql', 'statement', 'stmt', 'exec', 'script', 'program', 'cmd', 'command', 'shell', 'args', 'argv']);
/** Parameter types that are a filesystem path whatever the parameter is called. */
const FORBIDDEN_TYPES = /(?:^|[^A-Za-z])(?:PathBuf|Path|OsString|OsStr)(?:$|[^A-Za-z])/;
/** URL-shaped parameters are legal only when reviewed (host-side origin policy) and listed in the allowlist. */
const URL_PARAMS = new Set(['url', 'uri', 'href', 'endpoint']);

const sorted = (xs) => [...new Set(xs)].sort();
/** Names listed more than once: the parsers merge them, so they must be reported, not absorbed. */
const duplicates = (xs) => sorted(xs.filter((x, i) => xs.indexOf(x) !== i));
/** Capability permissions are strings or `{identifier, allow, deny}` objects; both name the permission. */
const permissionIds = (cap) => (cap.permissions ?? []).map((p) => (typeof p === 'string' ? p : p?.identifier)).filter((p) => typeof p === 'string');
const permissionToCommand = (p) => p.slice('allow-'.length).replaceAll('-', '_');
const globToRegExp = (g) => new RegExp(`^${g.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);

export function parseViews(viewsRs) {
  const labels = {};
  const prefixes = {};
  for (const m of viewsRs.matchAll(/pub const (\w+): &str = "([^"]+)";/g)) {
    (m[1].endsWith('_PREFIX') ? prefixes : labels)[m[1]] = m[2];
  }
  const roleLists = {};
  const roleDuplicates = {};
  for (const m of viewsRs.matchAll(/const (\w+)_CMDS: &\[&str\] = &\[([\s\S]*?)\];/g)) {
    const raw = [...m[2].matchAll(/"(\w+)"/g)].map((x) => x[1]);
    roleLists[m[1]] = sorted(raw);
    roleDuplicates[m[1]] = duplicates(raw);
  }
  return { labels, prefixes, roleLists, roleDuplicates };
}

/** `raw: true` keeps repeated entries so the caller can report them. */
export function parseHandler(libRs, { raw = false } = {}) {
  const start = libRs.indexOf('generate_handler![');
  if (start < 0) return [];
  const body = libRs.slice(start, libRs.indexOf(']', start));
  const names = [...body.matchAll(/(?:\w+::)+(\w+)/g)].map((m) => m[1]).filter((n) => n !== 'generate_handler');
  return raw ? names : sorted(names);
}

export function parseCommandsTxt(txt, { raw = false } = {}) {
  const names = txt.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  return raw ? names : sorted(names);
}

/** Matrix rows from the capability files. */
export function buildMatrix(capabilities) {
  const rows = [];
  for (const [file, cap] of Object.entries(capabilities)) {
    const commands = permissionIds(cap).filter((p) => p.startsWith('allow-')).map(permissionToCommand);
    for (const command of sorted(commands)) {
      rows.push({
        command,
        capability: cap.identifier ?? file,
        file,
        windows: cap.windows ?? [],
        webviews: cap.webviews ?? [],
        remote_urls: cap.remote?.urls ?? [],
      });
    }
  }
  return rows.sort((a, b) => a.command.localeCompare(b.command) || a.file.localeCompare(b.file));
}

/**
 * World = { capabilities: {file: json}, viewsRs, commandsTxt, libRs, tsCommands: string[], rustCommands: [{name, params}], shapeAllowlist }.
 * Returns violations; pure, so fixtures can drive it.
 */
export function check(world) {
  const out = [];
  const v = (file, message) => out.push(violation(GATE, file, 0, message));
  const txt = parseCommandsTxt(world.commandsTxt);
  const handler = parseHandler(world.libRs);
  const ts = sorted(world.tsCommands);
  const diff = (a, b) => ({ onlyA: a.filter((x) => !b.includes(x)), onlyB: b.filter((x) => !a.includes(x)) });
  for (const [name, list] of [
    ['src-tauri/commands.txt', parseCommandsTxt(world.commandsTxt, { raw: true })],
    ['lib.rs generate_handler!', parseHandler(world.libRs, { raw: true })],
  ]) {
    const dup = duplicates(list);
    if (dup.length) v(name, `duplicate command entries: ${dup.join(', ')}`);
  }

  for (const [nameA, a, nameB, b] of [
    ['commands.txt', txt, 'lib.rs generate_handler!', handler],
    ['commands.txt', txt, 'ui/packages/ipc command maps', ts],
  ]) {
    const d = diff(a, b);
    if (d.onlyA.length) v(nameA, `in ${nameA} but not in ${nameB}: ${d.onlyA.join(', ')}`);
    if (d.onlyB.length) v(nameB, `in ${nameB} but not in ${nameA}: ${d.onlyB.join(', ')}`);
  }

  const { labels, prefixes, roleLists, roleDuplicates } = parseViews(world.viewsRs);
  for (const [role, dup] of Object.entries(roleDuplicates)) if (dup.length) v('src-tauri/src/views.rs', `${role}_CMDS lists a command more than once: ${dup.join(', ')}`);
  const roleUnion = sorted(Object.values(roleLists).flat());
  for (const c of roleUnion) if (!txt.includes(c)) v('src-tauri/src/views.rs', `role list names unknown command ${c}`);
  const orphan = txt.filter((c) => !roleUnion.includes(c));
  const knownUngranted = world.ungranted ?? ['im_push_fact'];
  for (const c of orphan) if (!knownUngranted.includes(c)) v('src-tauri/commands.txt', `${c} is granted to no window role in views.rs`);

  const viewEntries = [
    ...Object.entries(labels).map(([k, val]) => ({ key: k, test: (l) => l === val, text: val })),
    ...Object.entries(prefixes).map(([k, val]) => ({ key: k, test: (l) => l === `${val}*`, text: `${val}*` })),
  ];
  const covered = new Set();
  for (const [file, cap] of Object.entries(world.capabilities)) {
    const granted = sorted(permissionIds(cap).filter((p) => p.startsWith('allow-')).map(permissionToCommand));
    for (const c of granted) if (!txt.includes(c)) v(`capabilities/${file}`, `permission allow-${c.replaceAll('_', '-')} names no command in commands.txt`);
    const role = CAP_ROLE[file];
    if (role === undefined) v(`capabilities/${file}`, 'capability file has no role mapping in tools/gates/capability-matrix.mjs');
    else if (roleLists[role] === undefined) v(`capabilities/${file}`, `views.rs has no ${role}_CMDS role list`);
    else {
      const d = diff(granted, roleLists[role]);
      if (d.onlyA.length || d.onlyB.length) v(`capabilities/${file}`, `grants differ from views.rs ${role}_CMDS (capability only: ${d.onlyA.join(', ') || '-'}; views only: ${d.onlyB.join(', ') || '-'})`);
    }
    for (const label of [...(cap.windows ?? []), ...(cap.webviews ?? [])]) {
      const hit = viewEntries.filter((e) => e.test(label));
      if (hit.length === 0) v(`capabilities/${file}`, `label ${JSON.stringify(label)} is not registered in views.rs`);
      for (const e of hit) covered.add(e.key);
    }
    // remote exposure: only the adapter capability may carry remote.urls, and no other file may reach acct-* labels
    if (file !== 'adapter.json') {
      if (cap.remote !== undefined) v(`capabilities/${file}`, 'only adapter.json may declare `remote`');
      const probe = `${prefixes.ACCOUNT_WEBVIEW_PREFIX ?? 'acct-'}probe`;
      for (const label of [...(cap.windows ?? []), ...(cap.webviews ?? [])]) if (globToRegExp(label).test(probe)) v(`capabilities/${file}`, `label ${JSON.stringify(label)} also matches account page webviews (${probe})`);
    }
  }
  for (const e of viewEntries) if (!covered.has(e.key)) v('src-tauri/src/views.rs', `label ${e.text} (${e.key}) appears in no capability`);

  const adapter = world.capabilities['adapter.json'];
  if (adapter !== undefined) {
    if (JSON.stringify(sorted(adapter.remote?.urls ?? [])) !== JSON.stringify(ADAPTER_URLS)) v('capabilities/adapter.json', `remote.urls must be exactly ${ADAPTER_URLS.join(' , ')}`);
    if (JSON.stringify(sorted(permissionIds(adapter))) !== JSON.stringify(ADAPTER_PERMISSIONS) || permissionIds(adapter).length !== (adapter.permissions ?? []).length) v('capabilities/adapter.json', `permissions must be exactly the 5 adapter bridge commands + 2 event permissions (remote surface <= 7), got ${JSON.stringify(adapter.permissions ?? [])}`);
    if ((adapter.windows ?? []).length) v('capabilities/adapter.json', 'adapter capability must target webviews only');
    const accountGlob = `${prefixes.ACCOUNT_WEBVIEW_PREFIX ?? 'acct-'}*`;
    if (JSON.stringify(adapter.webviews ?? []) !== JSON.stringify([accountGlob])) v('capabilities/adapter.json', `webviews must be exactly [${JSON.stringify(accountGlob)}], got ${JSON.stringify(adapter.webviews ?? [])}`);
    if (adapter.local === true) v('capabilities/adapter.json', 'adapter capability must not set `local: true` (remote origins only)');
  }

  // G-SEC-5: no free-form path / SQL / program parameter; URL parameters only when reviewed.
  const allow = world.shapeAllowlist ?? [];
  const usedAllow = new Set();
  for (const cmd of world.rustCommands ?? []) {
    for (const p of cmd.params) {
      const name = p.name.toLowerCase();
      if (FORBIDDEN_PARAMS.has(name) || FORBIDDEN_TYPES.test(p.type)) v(`command ${cmd.name}`, `parameter \`${p.name}: ${p.type}\` is an arbitrary path/SQL/program primitive`);
      if (URL_PARAMS.has(name)) {
        const idx = allow.findIndex((a) => a.command === cmd.name && a.param === p.name);
        if (idx < 0) v(`command ${cmd.name}`, `URL parameter \`${p.name}\` is not in the reviewed allowlist (host origin policy must validate it)`);
        else usedAllow.add(idx);
      }
    }
  }
  if (world.rustCommands) allow.forEach((a, i) => { if (!usedAllow.has(i)) v('tools/gates/url-params.allowlist.json', `stale entry ${a.command}.${a.param}`); });
  return out;
}

export function loadWorld(root = vbkRoot) {
  const capDir = join(root, 'src-tauri/capabilities');
  const capabilities = {};
  for (const f of readdirSync(capDir).filter((n) => n.endsWith('.json')).sort()) capabilities[f] = JSON.parse(readText(join(capDir, f)));
  const tsCommands = ['ui/packages/ipc/src/commands.ts', 'ui/packages/ipc/src/client.ts', 'ui/packages/ipc/src/adapterProtocol.ts'].flatMap((f) => Object.values(commandMaps(readText(join(root, f)), f)).flat());
  const rustCommands = listFiles(root, 'src-tauri/src').filter((f) => f.endsWith('.rs') && !/(?:_tests|(?:^|\/)tests)\.rs$/.test(f)).flatMap((f) => tauriCommands(readText(join(root, f))));
  return {
    capabilities,
    viewsRs: readText(join(root, 'src-tauri/src/views.rs')),
    commandsTxt: readText(join(root, 'src-tauri/commands.txt')),
    libRs: readText(join(root, 'src-tauri/src/lib.rs')),
    tsCommands,
    rustCommands,
    shapeAllowlist: JSON.parse(readText(join(gatesDir, 'url-params.allowlist.json'))),
  };
}

export function run(root = vbkRoot) {
  const world = loadWorld(root);
  // Build-time artefact (git-ignored): derived from the capability files, never hand-written.
  const target = join(root, 'src-tauri/gen/capability-matrix.json');
  if (!existsSync(dirname(target))) mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify({ generated_by: 'tools/gates/capability-matrix.mjs', rows: buildMatrix(world.capabilities) }, null, 2)}\n`);
  return check(world);
}
