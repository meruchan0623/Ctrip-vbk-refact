import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { filesBelow, read, root, rustProduction } from './source.mjs';

export const officialRemoteUrls = ['https://imvendor.ctrip.com/*', 'https://vbooking.ctrip.com/*'];
export const remotePermissions = ['allow-adapter-identity', 'allow-adapter-push-display', 'allow-adapter-push-fact', 'allow-adapter-ready', 'allow-adapter-reply', 'core:event:allow-listen', 'core:event:allow-unlisten'];
export const sorted = (xs) => [...xs].sort();
export function validateCapabilities(capabilities, labels, commands) {
  const seen = new Set(), matrix = [];
  for (const cap of capabilities) {
    assert.equal(typeof cap.identifier, 'string');
    assert.ok(!seen.has(cap.identifier), `duplicate capability ${cap.identifier}`); seen.add(cap.identifier);
    assert.ok(Array.isArray(cap.permissions), `permissions missing: ${cap.identifier}`);
    assert.equal(new Set(cap.permissions).size, cap.permissions.length, `duplicate permission: ${cap.identifier}`);
    // Structured/scoped and plugin permissions need a deliberate review rather
    // than being silently ignored by the app command conversion.
    assert.ok(cap.permissions.every((p) => typeof p === 'string'), `scoped permissions require gate review: ${cap.identifier}`);
    const windows = cap.windows ?? [], webviews = cap.webviews ?? [];
    const selectors = [...windows, ...webviews];
    assert.ok(selectors.length > 0, `missing selectors: ${cap.identifier}`);
    assert.equal(new Set(selectors).size, selectors.length, `duplicate selectors: ${cap.identifier}`);
    for (const label of selectors) assert.ok(labels.includes(label), `capability selector is not registered: ${label}`);
    const remote = cap.remote?.urls ?? [];
    if (cap.identifier === 'adapter') {
      assert.deepEqual(sorted(remote), officialRemoteUrls, 'adapter must use only the two official HTTPS origins');
      assert.deepEqual(sorted(cap.permissions), remotePermissions, 'remote surface must remain exactly five adapter commands and two event permissions');
      assert.deepEqual(windows, [], 'remote adapter cannot grant containing windows');
      assert.deepEqual(webviews, ['acct-*']);
      assert.notEqual(cap.local, true, 'adapter capability cannot explicitly enable local content');
    } else {
      assert.equal(cap.remote, undefined, `${cap.identifier} must not grant remote URLs`);
      assert.ok(!webviews.includes('acct-*'), `${cap.identifier} must not grant remote account webviews`);
    }
    for (const permission of cap.permissions) {
      const command = permission.startsWith('allow-') ? permission.slice(6).replaceAll('-', '_') : permission;
      if (permission.startsWith('allow-')) assert.ok(commands.includes(command), `unknown app command ${permission}`);
      else assert.ok(permission.startsWith('core:'), `unreviewed plugin permission ${permission}`);
      matrix.push({ capability: cap.identifier, command, permission, windows, webviews, remote_urls: remote });
    }
  }
  assert.ok(seen.has('adapter'), 'adapter capability missing');
  for (const label of labels) assert.ok(matrix.some((r) => [...r.windows, ...r.webviews].includes(label)), `registered label has no capability: ${label}`);
  return matrix;
}
export function registeredLabels(views) {
  const code = rustProduction(views, true);
  return [...code.matchAll(/pub\s+const\s+(\w+)\s*:\s*&str\s*=\s*"([^"]+)"\s*;/g)]
    .map((m) => m[2] + (m[1].endsWith('_PREFIX') ? '*' : ''));
}
export function buildMatrix(base = root) {
  const commands = read(join(base, 'src-tauri/commands.txt')).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  assert.equal(new Set(commands).size, commands.length, 'duplicate commands.txt entry');
  const caps = filesBelow(join(base, 'src-tauri/capabilities')).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(read(f)));
  const labels = registeredLabels(read(join(base, 'src-tauri/src/views.rs')));
  assert.ok(labels.length >= 7, 'view registry parser found too few labels');
  return { schema_version: 1, labels: sorted(labels), rows: validateCapabilities(caps, labels, commands) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const matrix = buildMatrix();
  if (!process.argv.includes('--check')) {
    mkdirSync(join(root, 'src-tauri/gen'), { recursive: true });
    writeFileSync(join(root, 'src-tauri/gen/capability-matrix.json'), JSON.stringify(matrix, null, 2) + '\n');
  }
  console.log(process.argv.includes('--json') ? JSON.stringify(matrix) : `Capabilities: passed (${matrix.labels.length} selectors, ${matrix.rows.length} permission grants)`);
}
