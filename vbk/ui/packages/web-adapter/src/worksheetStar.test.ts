import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SoaClient } from './soa.ts';
import { numericGid, setWorkSheetStar } from './worksheetStar.ts';
import { markRead } from './markRead.ts';
import { createPinnedMap } from './pinned.ts';
import { FAILURE_STATUS, OK_STATUS, jsonResponse, makeDeps } from './testing.ts';

test('setWorkSheetStar: applied only on bizResponseStatus SUCCESS', async () => {
  const deps = makeDeps((_, i) => {
    if (i === 0) return jsonResponse({ ResponseStatus: OK_STATUS, bizResponseStatus: { resultCode: 'SUCCESS' } });
    if (i === 1) return jsonResponse({ ResponseStatus: OK_STATUS, bizResponseStatus: { resultCode: 'UNKNOWN' } });
    if (i === 2) return jsonResponse({ ResponseStatus: FAILURE_STATUS });
    return 'hang';
  });
  const soa = new SoaClient(deps, { defaultTimeoutMs: 1000 });
  const req = { sessionId: '{{sessionId}}', groupId: 123456, worksheetId: 7890, action: 1 as const };
  assert.deepEqual(await setWorkSheetStar(deps, soa, req), { applied: true, action: 1 });
  const body = deps.fakeFetch.calls[0]?.bodyJson as Record<string, unknown>;
  assert.deepEqual(Object.keys(body), ['head', 'sessionId', 'groupId', 'worksheetId', 'action']);
  assert.equal(body['groupId'], 123456);
  assert.equal(body['action'], 1);
  const r2 = await setWorkSheetStar(deps, soa, { ...req, action: 0 });
  assert.equal(r2.applied, false);
  if (!r2.applied) assert.equal(r2.reason, 'biz_failure');
  const r3 = await setWorkSheetStar(deps, soa, req);
  assert.equal(r3.applied, false);
  if (!r3.applied) assert.equal(r3.reason, 'failed');
  const p4 = setWorkSheetStar(deps, soa, req);
  await deps.clock.advance(1000);
  const r4 = await p4;
  assert.equal(r4.applied, false);
  if (!r4.applied) assert.equal(r4.reason, 'unknown');
  assert.equal(deps.fakeFetch.calls.length, 4);
});

test('numericGid refuses non-digit ids', () => {
  assert.equal(numericGid('123'), 123);
  assert.equal(numericGid('12a'), null);
  assert.equal(numericGid(''), null);
});

test('markRead goes through the SDK with conversationType groupchat', async () => {
  const deps = makeDeps();
  assert.deepEqual(await markRead(deps.fakeSdk, { partnerJid: '{{jid}}', msgId: '{{msgId}}' }), { kind: 'acked' });
  assert.deepEqual(deps.fakeSdk.readReceipts, [{ partnerJid: '{{jid}}', msgId: '{{msgId}}', conversationType: 'groupchat' }]);
  deps.fakeSdk.readReceiptOutcome = { kind: 'failure', raw: { code: 1 } };
  assert.equal((await markRead(deps.fakeSdk, { partnerJid: 'j', msgId: 'm' })).kind, 'failed');
  assert.equal((await markRead(deps.fakeSdk, { partnerJid: '', msgId: 'm' })).kind, 'failed');
  assert.equal(deps.fakeSdk.readReceipts.length, 2);
});

test('pinned map is local only and sorts pinned first', () => {
  const pins = createPinnedMap();
  pins.pin('a', 10);
  pins.pin('b', 20);
  const order = ['c', 'a', 'b'].sort((x, y) => pins.compare(x, y, (p, q) => p.localeCompare(q)));
  assert.deepEqual(order, ['b', 'a', 'c']);
  pins.unpin('b');
  assert.equal(pins.isPinned('b'), false);
  assert.deepEqual(pins.snapshot(), { a: 10 });
  assert.deepEqual(createPinnedMap({ z: 1 }).snapshot(), { z: 1 });
});
