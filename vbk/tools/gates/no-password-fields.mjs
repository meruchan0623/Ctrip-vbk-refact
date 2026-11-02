// Gate 7 (I-02): no password-like field in anything that is persisted or crosses the IPC contract.
// The official client's PRI-01 root cause was `rememberPassword` defaulting to on; this client keeps
// credentials only in the OS keychain/WebView store and never writes a password into its own
// stores, preferences or contract types. Scope = persistence modules and the TS contract types.
// `ipc/src/mock.ts` is excluded: the in-memory demo handler reads the transient TSim login payload
// and keeps nothing; the real login command takes the password in transit only.
import { extname, join } from 'node:path';
import { rustTokens } from './lib/rust-lex.mjs';
import { tsFacts } from './lib/ts-facts.mjs';
import { readText, violation, vbkRoot, listFiles } from './lib/common.mjs';

export const GATE = 'no-password-fields';

/** Directories / files whose fields are persisted or exchanged (relative to `vbk/`). */
export const SCOPE_DIRS = ['crates/core-store/src', 'crates/core-account/src', 'crates/contracts/src', 'ui/packages/ipc/src'];
export const SCOPE_FILES = ['src-tauri/src/prefs.rs', 'src-tauri/src/state.rs', 'src-tauri/src/outbound_journal.rs', 'src-tauri/src/peripheral_journal.rs', 'src-tauri/src/clock_anchor.rs', 'src-tauri/src/dto.rs'];

const SECRET_FIELD = /^(?:password|passwd|pwd|passphrase|remember_?password|save_?password|auto_?login_?password)$/i;

export function scanFile(file, text) {
  const out = [];
  const add = (line, name) => out.push(violation(GATE, file, line, `password-like field/key \`${name}\` in a persisted or contract type`));
  if (extname(file) === '.rs') {
    for (const t of rustTokens(text)) {
      if ((t.t === 'id' || t.t === 'str') && SECRET_FIELD.test(t.v)) add(t.line, t.v);
    }
  } else {
    for (const f of tsFacts(text, file)) {
      if ((f.type === 'ident' || f.type === 'prop') && SECRET_FIELD.test(f.name)) add(f.line, f.name);
      if (f.type === 'string' && f.feeds?.kind === 'prop' && SECRET_FIELD.test(f.value)) add(f.line, f.value);
    }
  }
  return out.filter((x, i) => out.findIndex((y) => y.line === x.line && y.message === x.message) === i);
}

export function run(root = vbkRoot) {
  const files = [
    ...SCOPE_DIRS.flatMap((d) => listFiles(root, d)).filter((f) => /\.(?:rs|ts)$/.test(f) && !/\.test\.ts$/.test(f) && !f.endsWith('/mock.ts') && !/(?:^|\/)tests?\//.test(f) && !/(?:_tests)\.rs$/.test(f)),
    ...SCOPE_FILES,
  ];
  return files.flatMap((rel) => scanFile(rel, readText(join(root, rel))));
}
