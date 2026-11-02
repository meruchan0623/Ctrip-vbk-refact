// Gate 1 (I-02): TLS verification, debug switches and anti-automation tampering.
// TS/JS: AST facts (comments and string contents cannot hit identifier rules).
// Rust: lexical scan (comments stripped, `#[cfg(test)]` items skipped).
import { extname } from 'node:path';
import { objectKeys, tsFacts } from './lib/ts-facts.mjs';
import { rustTokens } from './lib/rust-lex.mjs';
import { productionFiles, readText, violation, vbkRoot } from './lib/common.mjs';
import { join } from 'node:path';

export const GATE = 'tls-debug';

/**
 * Identifier-position names that switch TLS verification off (Node, reqwest /
 * native-tls, rustls `dangerous()`, openssl, the Tauri http plugin's
 * `danger.acceptInvalidCerts`, wry). Also matched as an exact string value:
 * `o['reject' + 'Unauthorized']` folds, and `const k = 'rejectUnauthorized'` is
 * the same switch one hop away.
 */
const TLS_IDENTS = new Set([
  'rejectUnauthorized',
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'checkServerIdentity',
  'acceptInvalidCerts',
  'acceptInvalidHostnames',
  'danger_accept_invalid_certs',
  'danger_accept_invalid_hostnames',
  'accept_invalid_certs',
  'accept_invalid_hostnames',
  'with_accept_invalid_certs',
  'with_custom_certificate_verifier',
  'set_certificate_verifier',
  'SslVerifyMode',
]);
/** rustls: `ClientConfig::builder().dangerous()` is the only entry to a custom verifier. */
const RUST_ONLY_IDENTS = new Set(['dangerous']);

/** Browser switches that disable verification or open a debugging endpoint (string tokens in code). */
const SWITCH = /^--?(?:ignore-certificate-errors(?:-spki-list)?|ignore-ssl-errors|allow-insecure-localhost|unsafely-treat-insecure-origin-as-secure|remote-debugging-port|remote-debugging-pipe|remote-allow-origins|disable-web-security|auto-open-devtools-for-tabs)(?:=.*)?$/;

/** Properties whose assignment/definition fakes human input or hides automation (R11). */
const TAMPER_PROPS = new Set(['isTrusted', 'webdriver']);

function scanTs(file, text) {
  const out = [];
  const facts = tsFacts(text, file);
  const push = (line, msg) => out.push(violation(GATE, file, line, msg));
  for (const f of facts) {
    if (f.type === 'ident' && TLS_IDENTS.has(f.name)) push(f.line, `TLS switch \`${f.name}\``);
    if (f.type === 'prop' && TLS_IDENTS.has(f.name)) push(f.line, `TLS switch \`${f.name}\``);
    if (f.type === 'string') {
      if (TLS_IDENTS.has(f.value ?? '')) push(f.line, `TLS switch "${f.value}" named as a string (indirect access)`);
      // a constant prefix is enough: `--remote-debugging-port=${port}` is the switch with a hole
      if (SWITCH.test((f.prefix ?? '').trim())) push(f.line, `browser switch "${f.prefix.trim()}"`);
    }
    if (f.type === 'assign' && TAMPER_PROPS.has(f.name)) push(f.line, `assignment to \`${f.name}\` (R11: no tampering with input trust / automation flags)`);
    if (f.type === 'delete' && TAMPER_PROPS.has(f.name)) push(f.line, `delete of \`${f.name}\` (R11: hiding automation flags)`);
    if (f.type === 'call' && /^(?:Object|Reflect)\.defineProperty$/.test(f.callee ?? '') && TAMPER_PROPS.has(f.args[1] ?? '')) {
      push(f.line, `${f.callee}(…, "${f.args[1]}", …) (R11)`);
    }
    if (f.type === 'call' && /(?:^|\.)__define(?:Getter|Setter)__$/.test(f.callee ?? '') && TAMPER_PROPS.has(f.args[0] ?? '')) {
      push(f.line, `${f.callee}("${f.args[0]}", …) (R11)`);
    }
    if (f.type === 'call' && f.callee === 'Object.defineProperties') {
      for (const key of objectKeys(f.argNodes[1])) if (TAMPER_PROPS.has(key)) push(f.line, `Object.defineProperties with \`${key}\` (R11)`);
    }
    if (f.type === 'call' && f.callee === 'Object.assign') {
      // Object.assign(event, { isTrusted: true }) is the same tampering
      for (const key of objectKeys(f.argNodes[1])) if (TAMPER_PROPS.has(key)) push(f.line, `Object.assign with \`${key}\` (R11)`);
    }
  }
  // an identifier key is reported both as `ident` and as `prop`; keep one record per line and message
  return out.filter((x, i) => out.findIndex((y) => y.line === x.line && y.message === x.message) === i);
}

function scanRust(file, text) {
  const out = [];
  for (const t of rustTokens(text)) {
    if (t.t === 'id' && (TLS_IDENTS.has(t.v) || RUST_ONLY_IDENTS.has(t.v))) out.push(violation(GATE, file, t.line, `TLS switch \`${t.v}\``));
    if (t.t === 'str' && TLS_IDENTS.has(t.v)) out.push(violation(GATE, file, t.line, `TLS switch "${t.v}" named as a string`));
    if (t.t === 'str' && SWITCH.test(t.v.trim())) out.push(violation(GATE, file, t.line, `browser switch "${t.v}"`));
  }
  return out;
}

/** Scan one file's text; the extension picks the scanner. */
export function scanFile(file, text) {
  const ext = extname(file);
  if (ext === '.rs') return scanRust(file, text);
  if (/^\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/.test(ext)) return scanTs(file, text);
  return [];
}

export function run(root = vbkRoot) {
  return productionFiles(root).flatMap((rel) => scanFile(rel, readText(join(root, rel))));
}
