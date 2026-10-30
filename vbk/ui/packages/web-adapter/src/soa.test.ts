import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SoaClient, buildSoaUrl, classifySoaBody, parseSoaTimestamp, type ServerTimeSample } from './soa.ts';
import { Endpoints } from './endpoints.ts';
import { AUTH_FAILURE_STATUS, FAILURE_STATUS, FAKE_CONTEXT, OK_STATUS, jsonResponse, makeDeps } from './testing.ts';

test('trace query only when clientId is non-empty', () => {
  const withId = buildSoaUrl(Endpoints.CONVERSATION_LIST, { ...FAKE_CONTEXT, clientId: 'abc' }, 1700000000000, 0.123456789);
  assert.equal(withId, 'https://m.ctrip.com/restapi/soa2/16037/getConversationList?_fxpcqlniredt=abc&x-traceID=abc-1700000000000-1234567');
  assert.equal(buildSoaUrl(Endpoints.CONVERSATION_LIST, { ...FAKE_CONTEXT, clientId: null }, 1, 0.5), 'https://m.ctrip.com/restapi/soa2/16037/getConversationList');
  assert.equal(buildSoaUrl(Endpoints.CONVERSATION_LIST, { ...FAKE_CONTEXT, clientId: '' }, 1, 0.5), 'https://m.ctrip.com/restapi/soa2/16037/getConversationList');
  assert.equal(buildSoaUrl(Endpoints.CONVERSATION_LIST_JSON, { ...FAKE_CONTEXT, clientId: null }, 1, 0.5), 'https://m.ctrip.com/restapi/soa2/16037/getConversationList.json');
});

test('headers and credentials as observed', async () => {
  const deps = makeDeps(() => jsonResponse({ ResponseStatus: OK_STATUS }));
  const soa = new SoaClient(deps);
  await soa.post(Endpoints.CHECK_MEMBER_STATUS, { groupId: '{{gid}}' });
  const call = deps.fakeFetch.calls[0];
  assert.ok(call);
  assert.equal(call.init.credentials, 'include');
  assert.equal(call.init.method, 'POST');
  assert.deepEqual(call.init.headers, {
    'Content-Type': 'application/json',
    'x-tour-auth-from': 'vbk_online',
    cookieOrigin: 'https://vbooking.ctrip.com',
    'x-ctx-Locale': 'zh-CN',
    'x-ctx-Currency': 'CNY',
    'x-ctx-Country': 'CN',
  });
  assert.deepEqual(call.bodyJson, { groupId: '{{gid}}' });
});

test('classification: success / business failure / auth invalid / malformed', () => {
  assert.equal(classifySoaBody({ ResponseStatus: OK_STATUS, x: 1 }, 200).kind, 'success');
  const bf = classifySoaBody({ ResponseStatus: FAILURE_STATUS }, 200);
  assert.equal(bf.kind, 'business_failure');
  if (bf.kind === 'business_failure') {
    assert.equal(bf.ack, 'Failure');
    assert.equal(bf.errors[0]?.ErrorCode, '{{code}}');
  }
  const ai = classifySoaBody({ ResponseStatus: AUTH_FAILURE_STATUS }, 200);
  assert.equal(ai.kind, 'auth_invalid');
  assert.equal(classifySoaBody('nope', 200).kind, 'malformed');
  assert.equal(classifySoaBody({ foo: 1 }, 200).kind, 'malformed');
});

test('http error and invalid json', async () => {
  const deps = makeDeps((_, i) => (i === 0 ? jsonResponse('', 500) : jsonResponse('<html>', 200)));
  const soa = new SoaClient(deps);
  assert.deepEqual(await soa.post(Endpoints.MY_INFO, {}), { kind: 'http_error', httpStatus: 500 });
  assert.equal((await soa.post(Endpoints.MY_INFO, {})).kind, 'malformed');
});

test('reads retry once on network error; writes never', async () => {
  const deps = makeDeps((_, i) => (i === 0 ? new Error('net') : jsonResponse({ ResponseStatus: OK_STATUS })));
  const soa = new SoaClient(deps);
  const r = await soa.post(Endpoints.MY_INFO, {});
  assert.equal(r.kind, 'success');
  assert.equal(deps.fakeFetch.calls.length, 2);

  const deps2 = makeDeps(() => new Error('net'));
  const w = await new SoaClient(deps2).post(Endpoints.SET_WORKSHEET_STAR, {});
  assert.equal(w.kind, 'unknown');
  assert.equal(deps2.fakeFetch.calls.length, 1);

  const deps3 = makeDeps(() => new Error('net'));
  const rr = await new SoaClient(deps3).post(Endpoints.MY_INFO, {});
  assert.equal(rr.kind, 'network_error');
  assert.equal(deps3.fakeFetch.calls.length, 2);
});

test('write timeout → unknown, read timeout → timeout, no retry', async () => {
  const deps = makeDeps(() => 'hang');
  const soa = new SoaClient(deps, { defaultTimeoutMs: 1000 });
  const p = soa.post(Endpoints.SET_WORKSHEET_STAR, {});
  await deps.clock.advance(1000);
  assert.deepEqual(await p, { kind: 'unknown', detail: 'timeout' });
  assert.equal(deps.fakeFetch.calls.length, 1);

  const p2 = soa.post(Endpoints.MY_INFO, {}, { timeoutMs: 500 });
  await deps.clock.advance(500);
  assert.deepEqual(await p2, { kind: 'timeout' });
  assert.equal(deps.fakeFetch.calls.length, 2);
});

test('server time extraction from ResponseStatus.Timestamp', async () => {
  assert.equal(parseSoaTimestamp('/Date(1761800000000+0800)/'), 1761800000000);
  assert.equal(parseSoaTimestamp('/Date(1761800000000)/'), 1761800000000);
  assert.equal(parseSoaTimestamp('2026-10-30'), null);
  assert.equal(parseSoaTimestamp(123), null);
  const samples: ServerTimeSample[] = [];
  const deps = makeDeps(() => jsonResponse({ ResponseStatus: { ...OK_STATUS, Timestamp: '/Date(1761800000123+0800)/' } }));
  const soa = new SoaClient(deps, { onServerTime: (s) => samples.push(s) });
  await soa.post(Endpoints.MY_INFO, {});
  assert.deepEqual(samples, [{ server_ms: 1761800000123, received_at_ms: deps.clock.now() }]);
});
