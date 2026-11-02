import assert from 'node:assert/strict';
import { join } from 'node:path';
import { filesBelow, read, root, rustProduction } from './source.mjs';

// Exact bounded CDN exceptions, confined to non-executable image/media
// resources. A new wildcard or widening one requires an explicit review.
export const cspSnapshot = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://*.c-ctrip.com https://*.tripcdn.com https://*.ctrip.com; media-src 'self' https://*.c-ctrip.com https://*.tripcdn.com https://*.ctrip.com; connect-src 'self' ipc: http://ipc.localhost; frame-src 'none'; object-src 'none'";
export function validateCsp(csp, snapshot = false) {
  assert.equal(typeof csp, 'string', 'CSP must be a string');
  const directives = new Map();
  for (const text of csp.split(';')) {
    const [name, ...values] = text.trim().split(/\s+/);
    if (!name) continue;
    assert.ok(!directives.has(name), `duplicate CSP directive ${name}`);
    directives.set(name, values);
    for (const value of values) {
      assert.notEqual(value, "'unsafe-eval'", 'CSP must prohibit eval');
      assert.notEqual(value, '*', 'CSP must prohibit unrestricted wildcards');
      if (value.includes('*')) assert.ok(['img-src', 'media-src'].includes(name)
        && ['https://*.c-ctrip.com', 'https://*.tripcdn.com', 'https://*.ctrip.com'].includes(value), `unreviewed CSP wildcard: ${name} ${value}`);
    }
  }
  assert.deepEqual(directives.get('frame-src'), ["'none'"]);
  assert.deepEqual(directives.get('object-src'), ["'none'"]);
  assert.deepEqual(directives.get('script-src'), ["'self'"]);
  if (snapshot) assert.equal(csp, cspSnapshot, 'CSP snapshot changed; review security implications before updating');
}
export function validateRelease(manifest, buildCommands) {
  const featureText = /(?:^|\n)\[features\]([\s\S]*?)(?=\n\[|$)/.exec(manifest)?.[1] ?? '';
  const features = new Map([...featureText.matchAll(/^(\w[\w-]*)\s*=\s*\[([^\]]*)\]/gm)].map((m) => [m[1], [...m[2].matchAll(/"([^"]+)"/g)].map((v) => v[1])]));
  const visit = (feature, seen = new Set()) => {
    assert.ok(!/(?:^|\/)devtools$/.test(feature), 'DevTools cannot be a release/default feature');
    if (seen.has(feature)) return;
    seen.add(feature); for (const next of features.get(feature) ?? []) visit(next, seen);
  };
  for (const feature of features.get('default') ?? []) visit(feature);
  const dependencies = manifest.split(/\n\[features\]/)[0].replace(/#.*$/gm, '');
  assert.ok(!/features\s*=\s*\[[^\]]*"(?:tauri\/)?devtools"/s.test(dependencies), 'dependency directly enables devtools');
  for (const command of buildCommands) {
    if (!/(?:tauri|cargo)\s+build/.test(command)) continue;
    assert.ok(!/--all-features/.test(command), 'release build cannot enable all features');
    for (const match of command.matchAll(/--features(?:=|\s+)(?:"([^"]*)"|'([^']*)'|([^\s]+))/g))
      for (const feature of (match[1] ?? match[2] ?? match[3]).split(/[\s,]+/).filter(Boolean)) visit(feature);
    assert.ok(!/CARGO_FEATURE_DEVTOOLS\s*=/.test(command), 'release must not inject DevTools');
  }
}
export function validateStoreSchema(source) {
  const code = rustProduction(source, true);
  const secret = /^(?:password|passwd|pwd|remember_?password|bticket|vbkticket|cookie|cookies)$/i;
  for (const match of code.matchAll(/\b(?:pub(?:\([^)]*\))?\s+)?([a-zA-Z_]\w*)\s*:\s*(?:String|Option\s*<|Vec\s*<|bool|&\s*str)/g))
    assert.ok(!secret.test(match[1]), `credential field in store schema: ${match[1]}`);
  for (const match of code.matchAll(/(?:\.insert|\.get|rename\s*=)\s*\(?\s*"([^"]+)"/g))
    assert.ok(!secret.test(match[1]), `credential key in store schema: ${match[1]}`);
}
export function checkConfiguration(base = root) {
  const conf = JSON.parse(read(join(base, 'src-tauri/tauri.conf.json')));
  validateCsp(conf.app.security.csp, true);
  assert.equal(conf.app.security.dangerousDisableAssetCspModification, false);
  const repo = join(base, '..');
  const workflows = filesBelow(join(repo, '.github/workflows')).filter((f) => /\.ya?ml$/.test(f)).map(read);
  validateRelease(read(join(base, 'src-tauri/Cargo.toml')), [...workflows, ...Object.values(JSON.parse(read(join(base, 'package.json'))).scripts ?? {})]);
  for (const file of filesBelow(join(base, 'crates/core-store/src')).filter((f) => f.endsWith('.rs'))) validateStoreSchema(read(file));
  // Preference and account metadata documents must stay password-free too.
  for (const name of ['prefs.rs', 'login.rs']) validateStoreSchema(read(join(base, 'src-tauri/src', name)));
}
