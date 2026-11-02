import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SoaClient } from './soa.ts';
import { OK_STATUS, flush, jsonResponse, makeDeps } from './testing.ts';
import * as mod from './outboundTranslate.ts';
import { OUTBOUND_TRANSLATE_DEBOUNCE_MS, OUTBOUND_TRANSLATE_DEFAULT_MODE, createDraftTranslator, outboundTranslateBody, translateDraft } from './outboundTranslate.ts';

const req = { sessionId: 'sess-1', groupId: '1234567890123456789', messageTxt: '你好', target: 'en', bizType: 1513 };
const ok = { ResponseStatus: OK_STATUS, translate: { translateText: 'Hello' } };

test('request body matches the official builder field-for-field', () => {
  const deps = makeDeps();
  const body = outboundTranslateBody(deps, req);
  assert.deepEqual(Object.keys(body), ['head', 'sessionId', 'groupId', 'messageTxt', 'source', 'target', 'appId', 'bizType', 'timeoutInSeconds']);
  assert.equal(body['source'], 'AUTO');
  assert.equal(body['appId'], '900004');
  assert.equal(body['timeoutInSeconds'], 10);
  assert.equal(body['bizType'], 1513, 'bizType is passed through, not coerced');
  assert.equal(body['groupId'], '1234567890123456789');
});

test('translateDraft hits 11679/getMessageTranslate and reads translate.translateText', async () => {
  const deps = makeDeps(() => jsonResponse(ok));
  const soa = new SoaClient(deps);
  assert.deepEqual(await translateDraft(deps, soa, req), { kind: 'translated', text: 'Hello' });
  assert.match(deps.fakeFetch.calls[0]!.url, /\/11679\/getMessageTranslate\?/);
});

test('empty, oversized or odd-target drafts never reach the network; malformed answers fail closed', async () => {
  const deps = makeDeps(() => jsonResponse({ ResponseStatus: OK_STATUS }));
  const soa = new SoaClient(deps);
  assert.deepEqual(await translateDraft(deps, soa, { ...req, messageTxt: '  ' }), { kind: 'refused', reason: 'empty' });
  assert.deepEqual(await translateDraft(deps, soa, { ...req, messageTxt: 'x'.repeat(2001) }), { kind: 'refused', reason: 'too_long' });
  assert.deepEqual(await translateDraft(deps, soa, { ...req, target: 'en; drop' }), { kind: 'refused', reason: 'invalid_target' });
  assert.equal(deps.fakeFetch.calls.length, 0);
  assert.equal((await translateDraft(deps, soa, req)).kind, 'failed');
});

test('debounce: 500 ms after the last keystroke, one request, only the newest draft is delivered', async () => {
  const deps = makeDeps(() => jsonResponse(ok));
  const soa = new SoaClient(deps);
  const got: number[] = [];
  const tr = createDraftTranslator(deps, soa, (t) => got.push(t.draftVersion));
  tr.schedule(1, req);
  await deps.clock.advance(300);
  tr.schedule(2, { ...req, messageTxt: '你好吗' });
  await deps.clock.advance(300);
  assert.equal(deps.fakeFetch.calls.length, 0, 'second keystroke restarted the timer');
  await deps.clock.advance(OUTBOUND_TRANSLATE_DEBOUNCE_MS - 300);
  await flush();
  assert.equal(deps.fakeFetch.calls.length, 1);
  assert.deepEqual(got, [2]);
});

test('debounce: an in-flight answer is dropped when the draft changed or was cancelled', async () => {
  const deps = makeDeps((_c, i) => (i === 0 ? 'hang' : jsonResponse(ok)));
  const soa = new SoaClient(deps, { defaultTimeoutMs: 5000 });
  const got: number[] = [];
  const tr = createDraftTranslator(deps, soa, (t) => got.push(t.draftVersion));
  tr.schedule(1, req);
  await deps.clock.advance(OUTBOUND_TRANSLATE_DEBOUNCE_MS);
  tr.schedule(2, req); // supersedes the hung request
  await deps.clock.advance(OUTBOUND_TRANSLATE_DEBOUNCE_MS);
  await flush();
  assert.deepEqual(got, [2]);
  tr.schedule(3, req);
  tr.cancel();
  await deps.clock.advance(OUTBOUND_TRANSLATE_DEBOUNCE_MS * 2);
  await flush();
  assert.deepEqual(got, [2], 'cancel before the timer fires sends nothing');
});

test('the module can only fill the draft: replace_draft is the default and nothing here sends', () => {
  assert.equal(OUTBOUND_TRANSLATE_DEFAULT_MODE, 'replace_draft');
  for (const name of Object.keys(mod)) assert.doesNotMatch(name, /send|submit/i, name);
});
