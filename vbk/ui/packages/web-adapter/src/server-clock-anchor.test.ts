import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPageSession } from './session.ts';
import { createPageSdk } from './sdkGlue.ts';
import { makeDeps, jsonResponse, OK_STATUS, flush } from './testing.ts';

function fixture(body: unknown = { ResponseStatus: OK_STATUS, jid: 'self@synthetic', secret: 'SYNTHETIC_PRIVATE' }) {
  const deps = makeDeps(() => jsonResponse(body));
  const sdk = createPageSdk({}, deps);
  const session = createPageSession({ ...deps, sdk }, { sdk, account: { account_id: 'synthetic', environment: 'production', session_generation: 1 }, selfUid: 'self', initialEpoch: 1, beginMsgTime: 1700000000000, pushDisplay: async () => {} });
  let started = false;
  const sample = async () => { if (!started) { session.start(); await flush(); deps.fakeFetch.calls.length = 0; started = true; } return session.rpc.handle({ req_id: 'host-clock-probe', op: 'clock.sample', args: {} }); };
  return { deps, sdk, session, sample };
}

test('host clock probe reads fixed authenticated MyInfo timestamp without message/read-receipt operations', async () => {
  const f = fixture();
  const reply = await f.sample();
  assert.equal(reply?.ok, true);
  if (!reply?.ok) return;
  assert.deepEqual(reply.data, { server_ms: 1700000000000 });
  assert.equal(f.deps.fakeFetch.calls.length, 1);
  assert.equal(f.deps.fakeFetch.calls[0]!.init.redirect, 'error');
  assert.match(f.deps.fakeFetch.calls[0]!.url, /^https:\/\/m\.ctrip\.com\/restapi\/soa2\/11679\/GetMyInfo\.json/);
  assert.equal(JSON.stringify(reply).includes('SYNTHETIC_PRIVATE'), false);
  assert.equal(f.sdk.canSend, false);
  f.session.stop(); f.sdk.dispose();
});

for (const [label, body] of [
  ['auth failure', { ResponseStatus: { ...OK_STATUS, Ack: 'Failure', Errors: [{ ErrorCode: 'AccountsMobileRequestFilterException' }] }, jid: 'self@synthetic' }],
  ['other IM identity', { ResponseStatus: OK_STATUS, jid: 'other@synthetic' }],
  ['missing JID', { ResponseStatus: OK_STATUS }],
  ['bad timestamp', { ResponseStatus: { ...OK_STATUS, Timestamp: '/Date(99999999999999999)/' }, jid: 'self@synthetic' }],
  ['client-style timestamp', { ResponseStatus: { ...OK_STATUS, Timestamp: 1700000000000 }, jid: 'self@synthetic' }],
] as const) test(`clock probe rejects ${label}`, async () => { const f = fixture(body); const reply = await f.sample(); assert.equal(reply?.ok, false); f.session.stop(); f.sdk.dispose(); });

test('stopped adapter rejects clock probe without any upstream request', async () => {
  const f = fixture();
  const reply = await f.session.rpc.handle({ req_id: 'probe', op: 'clock.sample', args: {} });
  assert.equal(reply?.ok, false); assert.equal(f.deps.fakeFetch.calls.length, 0); f.sdk.dispose();
});

test('late clock response from stopped session cannot be returned as a valid sample', async () => {
  let release!: (v: ReturnType<typeof jsonResponse>) => void;
  const deps = makeDeps(call => call.url.includes('GetMyInfo') ? new Promise(resolve => { release = resolve; }) : jsonResponse({ ResponseStatus: OK_STATUS }));
  const sdk = createPageSdk({}, deps);
  const session = createPageSession({ ...deps, sdk }, { sdk, account: { account_id: 'synthetic', environment: 'production', session_generation: 1 }, selfUid: 'self', initialEpoch: 1, beginMsgTime: 1700000000000, pushDisplay: async () => {} });
  session.start(); await flush();
  const pending = session.rpc.handle({ req_id: 'probe', op: 'clock.sample', args: {} }); await flush();
  session.stop(); release(jsonResponse({ ResponseStatus: OK_STATUS, jid: 'self@synthetic' }));
  assert.equal((await pending)?.ok, false); sdk.dispose();
});

test('caller-supplied URL or timestamp cannot select the source or substitute local time', async () => {
  const f = fixture(); await f.sample(); f.deps.fakeFetch.calls.length = 0;
  const reply = await f.session.rpc.handle({ req_id: 'probe-2', op: 'clock.sample', args: { url: 'https://untrusted.invalid', server_ms: 1800000000000 } });
  assert.equal(reply?.ok, true); if (reply?.ok) assert.deepEqual(reply.data, { server_ms: 1700000000000 });
  assert.match(f.deps.fakeFetch.calls[0]!.url, /11679\/GetMyInfo\.json/);
  f.session.stop(); f.sdk.dispose();
});
