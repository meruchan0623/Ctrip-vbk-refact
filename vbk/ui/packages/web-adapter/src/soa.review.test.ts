/**
 * Review: write/retry discipline and success classification (hunt items 2, 3, 12).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SoaClient, classifySoaBody, type ServerTimeSample } from './soa.ts';
import { Endpoints } from './endpoints.ts';
import { AUTH_FAILURE_STATUS, FAILURE_STATUS, OK_STATUS, jsonResponse, makeDeps } from './testing.ts';

const WRITE_SPECS = [
  Endpoints.SET_WORKSHEET_STAR,
  Endpoints.SEND_CARD_MESSAGE,
  Endpoints.UPLOAD_TOKEN_CREATE,
  Endpoints.SYNC_VEN_AGENT_INFO,
  Endpoints.FINISH_CONVERSATION,
  Endpoints.START_CHAT_B2C,
  Endpoints.CREATE_IM_CHAT,
];

test('review/soa: every write surfaces a network error as `unknown` after exactly one request', async () => {
  for (const spec of WRITE_SPECS) {
    const deps = makeDeps(() => new Error('ECONNRESET'));
    const r = await new SoaClient(deps).post(spec, {});
    assert.equal(r.kind, 'unknown', spec.name);
    assert.equal(deps.fakeFetch.calls.length, 1, spec.name);
    assert.equal(deps.clock.pendingCount(), 0, spec.name);
  }
});

test('review/soa: every write surfaces a timeout as `unknown`; no second request ever follows', async () => {
  for (const spec of WRITE_SPECS) {
    const deps = makeDeps(() => 'hang');
    const soa = new SoaClient(deps, { defaultTimeoutMs: 1000 });
    const p = soa.post(spec, {});
    await deps.clock.advance(999);
    assert.equal(deps.fakeFetch.calls.length, 1);
    await deps.clock.advance(1);
    assert.deepEqual(await p, { kind: 'unknown', detail: 'timeout' }, spec.name);
    await deps.clock.advance(120000);
    assert.equal(deps.fakeFetch.calls.length, 1, spec.name);
  }
});

test('review/soa: a body that fails to download after HTTP 200 is not success (write → unknown, read → one retry)', async () => {
  const broken = { status: 200, text: () => Promise.reject(new Error('body stream reset')) };
  const w = makeDeps(() => broken);
  assert.equal((await new SoaClient(w).post(Endpoints.SET_WORKSHEET_STAR, {})).kind, 'unknown');
  assert.equal(w.fakeFetch.calls.length, 1);
  const r = makeDeps(() => broken);
  assert.equal((await new SoaClient(r).post(Endpoints.MY_INFO, {})).kind, 'network_error');
  assert.equal(r.fakeFetch.calls.length, 2);
});

test('review/soa: HTTP 200 + Ack Failure / AccountsMobileRequestFilterException is never success, for reads and writes', async () => {
  for (const spec of [Endpoints.MY_INFO, Endpoints.SET_WORKSHEET_STAR, Endpoints.CREATE_IM_CHAT]) {
    const deps = makeDeps((_, i) => (i === 0 ? jsonResponse({ ResponseStatus: FAILURE_STATUS, url: 'https://imvendor.ctrip.com/main', token: 't' }) : jsonResponse({ ResponseStatus: AUTH_FAILURE_STATUS, members: [] })));
    const soa = new SoaClient(deps);
    const a = await soa.post(spec, {});
    assert.equal(a.kind, 'business_failure', spec.name);
    const b = await soa.post(spec, {});
    assert.equal(b.kind, 'auth_invalid', spec.name);
    assert.equal(deps.fakeFetch.calls.length, 2, `${spec.name}: business failures are never retried`);
  }
});

test('review/soa: reads retry at most once, and only on a transport error', async () => {
  const net = makeDeps(() => new Error('net'));
  assert.equal((await new SoaClient(net).post(Endpoints.CONVERSATION_LIST, {})).kind, 'network_error');
  assert.equal(net.fakeFetch.calls.length, 2);

  const http = makeDeps(() => jsonResponse('', 503));
  assert.deepEqual(await new SoaClient(http).post(Endpoints.CONVERSATION_LIST, {}), { kind: 'http_error', httpStatus: 503 });
  assert.equal(http.fakeFetch.calls.length, 1);

  const malformed = makeDeps(() => jsonResponse('<html>'));
  assert.equal((await new SoaClient(malformed).post(Endpoints.CONVERSATION_LIST, {})).kind, 'malformed');
  assert.equal(malformed.fakeFetch.calls.length, 1);

  const to = makeDeps(() => 'hang');
  const p = new SoaClient(to, { defaultTimeoutMs: 500 }).post(Endpoints.CONVERSATION_LIST, {});
  await to.clock.advance(500);
  assert.deepEqual(await p, { kind: 'timeout' });
  await to.clock.advance(60000);
  assert.equal(to.fakeFetch.calls.length, 1);
});

test('review/soa: hostile bodies classify as malformed/business_failure, never success, never throw', () => {
  const malformed = ['null', '[]', '"str"', '1', '{"ResponseStatus":null}', '{"ResponseStatus":"x"}', '{"ResponseStatus":[]}', '{}'];
  for (const text of malformed) assert.equal(classifySoaBody(JSON.parse(text), 200).kind, 'malformed', text);
  assert.equal(classifySoaBody({ ResponseStatus: { Ack: 'success' } }, 200).kind, 'business_failure'); // case matters
  assert.equal(classifySoaBody({ ResponseStatus: { Ack: 'Success ' } }, 200).kind, 'business_failure');
  assert.equal(classifySoaBody({ ResponseStatus: { Ack: true } }, 200).kind, 'business_failure');
  assert.equal(classifySoaBody({ ResponseStatus: { Ack: 'Success' } }, 200).kind, 'success');
  assert.equal(classifySoaBody({ ResponseStatus: { Ack: 'Failure', Errors: null } }, 200).kind, 'business_failure');
  assert.equal(classifySoaBody({ ResponseStatus: { Ack: 'Failure', Errors: 'x' } }, 200).kind, 'business_failure');
  const nulls = classifySoaBody({ ResponseStatus: { Ack: 'Failure', Errors: [null, 1, 'x', [], { ErrorCode: 7 }] } }, 200);
  assert.equal(nulls.kind, 'business_failure');
  if (nulls.kind === 'business_failure') assert.deepEqual(nulls.errors, [{ ErrorCode: null, Message: null, SeverityCode: null, ErrorClassification: null }]);
  // the auth code must be a top-level ErrorCode, not a nested ErrorFields entry
  const nested = classifySoaBody({ ResponseStatus: { Ack: 'Failure', Errors: [{ ErrorCode: 'Other', ErrorFields: [{ ErrorCode: 'AccountsMobileRequestFilterException' }] }] } }, 200);
  assert.equal(nested.kind, 'business_failure');
  const huge = classifySoaBody({ ResponseStatus: { Ack: 'Failure', Errors: new Array<null>(10000).fill(null) } }, 200);
  assert.equal(huge.kind, 'business_failure');
});

test('review/soa: server time is reported only for a well-formed Timestamp and only after a parsed body', async () => {
  const samples: ServerTimeSample[] = [];
  const deps = makeDeps((_, i) => {
    if (i === 0) return jsonResponse({ ResponseStatus: { ...OK_STATUS, Timestamp: 'garbage' } });
    if (i === 1) return jsonResponse('not json');
    return jsonResponse({ ResponseStatus: { ...FAILURE_STATUS, Timestamp: '/Date(1761800000999+0800)/' } });
  });
  const soa = new SoaClient(deps, { onServerTime: (s) => samples.push(s) });
  await soa.post(Endpoints.MY_INFO, {});
  await soa.post(Endpoints.MY_INFO, {});
  await soa.post(Endpoints.MY_INFO, {});
  assert.deepEqual(samples, [{ server_ms: 1761800000999, received_at_ms: deps.clock.now() }]);
});
