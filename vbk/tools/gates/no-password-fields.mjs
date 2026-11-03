// Gate 7 (I-02): no password-like field in anything that is persisted or crosses the IPC contract.
// The official client's PRI-01 root cause was `rememberPassword` defaulting to on; this client keeps
// credentials only in the OS keychain/WebView store and never writes a password into its own
// stores, preferences or contract types. Scope = persistence modules and the TS contract types.
// `ipc/src/mock.ts` is excluded: the in-memory demo handler reads the transient TSim login payload
// and keeps nothing; the real login command takes the password in transit only.
import { existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { rustTokens } from './lib/rust-lex.mjs';
import { tsFacts } from './lib/ts-facts.mjs';
import { readText, violation, vbkRoot, listFiles } from './lib/common.mjs';

export const GATE = 'no-password-fields';

/** Directories / files whose fields are persisted or exchanged (relative to `vbk/`). */
export const SCOPE_DIRS = ['crates/core-store/src', 'crates/core-account/src', 'crates/contracts/src', 'ui/packages/ipc/src'];
export const SCOPE_FILES = ['src-tauri/src/prefs.rs', 'src-tauri/src/state.rs', 'src-tauri/src/outbound_journal.rs', 'src-tauri/src/peripheral_journal.rs', 'src-tauri/src/clock_anchor.rs', 'src-tauri/src/dto.rs'];

/** Any identifier / key that CONTAINS a password word: `userPassword`, `remember_pwd`, `passphraseHash` all count. */
const SECRET_FIELD = /passw(?:or)?d|passphrase|(?:^|[^a-z])pwd|pwd(?:$|[^a-z])/i;
/** A string literal counts only when it is shaped like a key, never when it is prose. */
const KEY_LIKE = /^[A-Za-z0-9_.:-]+$/;
const isSecretKey = (s) => KEY_LIKE.test(s) && SECRET_FIELD.test(s);

export function scanFile(file, text) {
  const out = [];
  const add = (line, name) => out.push(violation(GATE, file, line, `password-like field/key \`${name}\` in a persisted or contract type`));
  if (extname(file) === '.rs') {
    for (const t of rustTokens(text)) {
      if ((t.t === 'id' && SECRET_FIELD.test(t.v)) || (t.t === 'str' && isSecretKey(t.v))) add(t.line, t.v);
    }
  } else {
    for (const f of tsFacts(text, file)) {
      if ((f.type === 'ident' || f.type === 'prop') && SECRET_FIELD.test(f.name)) add(f.line, f.name);
      // object keys, string-literal types (`Record<'password', _>`), enum values; prose strings are not keys
      if (f.type === 'string' && (f.feeds?.kind === 'prop' || f.feeds?.kind === 'type') && isSecretKey(f.value ?? '')) add(f.line, f.value);
    }
  }
  return out.filter((x, i) => out.findIndex((y) => y.line === x.line && y.message === x.message) === i);
}

export function run(root = vbkRoot) {
  const out = [];
  const files = [
    ...SCOPE_DIRS.flatMap((d) => listFiles(root, d)).filter((f) => /\.(?:rs|ts)$/.test(f) && !/\.test\.ts$/.test(f) && !f.endsWith('/mock.ts') && !/(?:^|\/)tests?\//.test(f) && !/(?:_tests)\.rs$/.test(f)),
  ];
  for (const f of SCOPE_FILES) {
    // a renamed / removed persistence module must be re-listed, not silently dropped from the scope
    if (existsSync(join(root, f))) files.push(f);
    else out.push(violation(GATE, f, 0, 'scope file missing: update SCOPE_FILES in tools/gates/no-password-fields.mjs'));
  }
  out.push(...files.flatMap((rel) => scanFile(rel, readText(join(root, rel)))));
  return out;
}
