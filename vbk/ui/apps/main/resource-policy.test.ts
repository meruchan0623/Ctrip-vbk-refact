import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// This evaluator covers the source forms used by these two actual policies.
// Browser enforcement remains a separate acceptance check.
type Policy = Map<string, string[]>;
const origin = 'http://tauri.localhost';
function parse(value: string): Policy {
  return new Map(value.split(';').map((part) => part.trim().split(/\s+/)).filter(([name]) => name).map(([name, ...sources]) => [name!, sources]));
}
const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const meta = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i)?.[1];
assert.ok(meta, 'actual main HTML must declare its resource policy');
const host = JSON.parse(readFileSync(new URL('../../../src-tauri/tauri.conf.json', import.meta.url), 'utf8')) as { app: { security: { csp: string } } };
const actual = [parse(meta), parse(host.app.security.csp)];
// Explicit fault injection changes only the in-memory test input, never source/config files.
if (process.env['VBK_RESOURCE_POLICY_FAULT'] === 'meta') {
  actual[0]!.set('img-src', ["'self'", 'data:']);
  actual[0]!.delete('media-src');
}
function permits(policy: Policy, directive: string, resource: string): boolean {
  const target = new URL(resource, origin);
  const sources = policy.get(directive) ?? policy.get('default-src') ?? [];
  return sources.some((source) => {
    if (source === "'self'") return target.origin === origin;
    if (source === 'data:') return target.protocol === 'data:';
    const wildcard = /^https:\/\/\*\.([-a-z0-9.]+)$/.exec(source);
    return !!wildcard && target.protocol === 'https:' && (target.port === '' || target.port === '443') && target.hostname.endsWith(`.${wildcard[1]}`) && !target.username && !target.password;
  });
}
function allowed(policies: readonly Policy[], directive: string, url: string): boolean {
  return policies.every((policy) => permits(policy, directive, url));
}
const resources = ['https://dimg04.c-ctrip.com/synthetic-avatar.png', 'https://static.tripcdn.com/synthetic-image.png', 'https://media.ctrip.com/synthetic-video.mp4'];
for (const directive of ['img-src', 'media-src']) {
  test(`actual HTML and host CSP intersection permits the official HTTPS ${directive} resources`, () => {
    for (const resource of resources) assert.equal(allowed(actual, directive, resource), true, `${directive} blocked by one of the actual policies: ${new URL(resource).hostname}`);
  });
}
test('neither policy admits arbitrary hosts, insecure remote resources or remote scripts/connect', () => {
  for (const resource of ['https://example.invalid/synthetic.png', 'https://dimg04.c-ctrip.com.evil.invalid/synthetic.png', 'http://dimg04.c-ctrip.com/synthetic.png', 'javascript:synthetic']) {
    for (const directive of ['img-src', 'media-src']) assert.equal(allowed(actual, directive, resource), false);
  }
  assert.equal(allowed(actual, 'script-src', resources[0]!), false);
  assert.equal(allowed(actual, 'connect-src', resources[0]!), false);
  assert.equal(allowed(actual, 'img-src', 'data:image/png;base64,AAAA'), true);
  assert.equal(allowed(actual, 'media-src', 'data:video/mp4;base64,AAAA'), false);
  assert.equal(actual[0]?.get('base-uri')?.join(' '), "'none'");
  for (const policy of actual) assert.deepEqual(policy.get('object-src'), ["'none'"]);
});
test('a restrictive meta OR host overrides an otherwise permissive resource layer', () => {
  for (const restrictedLayer of [0, 1]) {
    const policies = actual.map((policy) => new Map(policy));
    policies[restrictedLayer]!.set('img-src', ["'self'", 'data:']);
    policies[restrictedLayer]!.delete('media-src');
    assert.equal(allowed(policies, 'img-src', resources[0]!), false);
    assert.equal(allowed(policies, 'media-src', resources[0]!), false);
  }
});
