import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createImChat, orderImPlan, preciseGroupId, startOrderB2c } from './order.ts';
import { SoaClient } from './soa.ts';
import { jsonResponse, makeDeps, OK_STATUS } from './testing.ts';

const ORDER = '1234567890123456';
const GID = '9007199254740993';
function imUrl(overrides: Record<string, string> = {}): string {
  const q = new URLSearchParams({ initChat: '2', serviceType: '1513', vendorRefId: 'ref1', vendorRole: 'VBK', threadId: 'thread1', orderNo: ORDER, targetGid: '', accountsource: 'VBK', 'client-source': 'pc-1001', lang: '', ...overrides });
  return `https://imvendor.ctrip.com/main?${q}`;
}
function plan(overrides: Record<string, string> = {}) {
  const p = orderImPlan(imUrl(overrides), ORDER);
  assert.equal(p.kind, 'start_b2c');
  if (p.kind !== 'start_b2c') throw new Error('missing B2C plan');
  return p;
}

test('order B2C init: verified legacy web body/head, exact string order and group IDs', async () => {
  const deps = makeDeps(() => jsonResponse({ ResponseStatus: OK_STATUS, workSheetId: 'ws1', groupId: GID }));
  assert.deepEqual(await startOrderB2c(deps, new SoaClient(deps), plan()), { kind: 'ok', gid: GID });
  assert.ok(deps.fakeFetch.calls[0]?.url.includes('/16037/startChatB2C'));
  assert.deepEqual(deps.fakeFetch.calls[0]?.bodyJson, {
    source: 'h5', pageCode: '', serviceType: '1513', languageInfo: {}, vendorRefId: 'ref1', role: 'VBK', threadId: 'thread1', orderNo: ORDER, extParams: { orderId: ORDER },
    head: { cver: '2', extension: [{ name: 'cpc', value: 'pc' }, { name: 'protocal', value: 'https' }, { name: 'amp-product-type', value: 'IM' }, { name: 'amp-account-source', value: 'VBK' }, { name: 'client-source', value: 'pc-1001' }, { name: 'locale', value: 'zh-CN' }] },
  });
});

test('order B2C init: only truthy URL fields included, ext JSON fallback and language', () => {
  const body = plan({ vendorRefId: '', vendorRole: '', threadId: '', lang: 'en-US', extParams: 'invalid JSON' }).body;
  assert.deepEqual(body, { source: 'h5', pageCode: '', serviceType: '1513', languageInfo: { lang: 'en-US' }, orderNo: ORDER, extParams: { orderId: ORDER } });
  assert.deepEqual(plan({ extParams: JSON.stringify({ orderId: ORDER, custom: 'keep' }) }).body['extParams'], { orderId: ORDER, custom: 'keep' });
});

test('order URL initialization rejects wrong order, conflicting ext order, unsupported branches and ambiguous parameters', () => {
  for (const url of [imUrl({ orderNo: '9999999999999999' }), imUrl({ orderNo: '' }), imUrl({ initChat: '1' }), imUrl({ initChat: '5' }), imUrl({ initChat: '' }), imUrl({ accountsource: 'other' }), imUrl({ accountsource: '' }), imUrl({ serviceType: '' }), imUrl({ targetGid: 'abc' }), imUrl({ extParams: JSON.stringify({ orderId: '9999999999999999' }) }), imUrl() + '&orderNo=' + ORDER, imUrl().replace('imvendor.ctrip.com', 'evil.example')]) {
    assert.equal(orderImPlan(url, ORDER).kind, 'invalid', url);
  }
  assert.deepEqual(orderImPlan(imUrl({ targetGid: GID }), ORDER), { kind: 'target', gid: GID });
});

test('order IDs never accept already-rounded group numbers', () => {
  assert.equal(preciseGroupId(GID), GID);
  assert.equal(preciseGroupId(123), '123');
  for (const id of [Number.MAX_SAFE_INTEGER + 1, 1.5, 0, -1, '', 'abc', '0', '1e18']) assert.equal(preciseGroupId(id), null);
});

test('createimchat requires explicit response.errorCode zero even when URL is present', async () => {
  for (const response of [undefined, {}, { errorCode: '0' }, { errorCode: 1 }]) {
    const deps = makeDeps(() => jsonResponse({ ResponseStatus: OK_STATUS, response, url: imUrl() }));
    assert.equal((await createImChat(deps, new SoaClient(deps), ORDER)).kind, 'rejected');
  }
});

test('startChatB2C requires worksheet and exact group identity; uncertain responses stay unknown', async () => {
  for (const body of [{ groupId: GID }, { workSheetId: 'ws1' }, { workSheetId: 0, groupId: GID }, { workSheetId: 'ws1', groupId: Number.MAX_SAFE_INTEGER + 1 }, { workSheetId: 'ws1', groupId: 'abc' }]) {
    const deps = makeDeps(() => jsonResponse({ ResponseStatus: OK_STATUS, ...body }));
    assert.deepEqual(await startOrderB2c(deps, new SoaClient(deps), plan()), { kind: 'unknown_may_have_created' });
  }
  const alternate = makeDeps(() => jsonResponse({ ResponseStatus: OK_STATUS, sWorkSheetId: 123, groupId: 456 }));
  assert.deepEqual(await startOrderB2c(alternate, new SoaClient(alternate), plan()), { kind: 'ok', gid: '456' });
  const rejected = makeDeps(() => jsonResponse({ ResponseStatus: OK_STATUS, success: false }));
  assert.equal((await startOrderB2c(rejected, new SoaClient(rejected), plan())).kind, 'rejected');
});

test('startChatB2C timeout is unknown and the SOA write never automatically retries', async () => {
  const deps = makeDeps(() => 'hang');
  const result = startOrderB2c(deps, new SoaClient(deps, { defaultTimeoutMs: 1000 }), plan());
  await deps.clock.advance(1000);
  assert.deepEqual(await result, { kind: 'unknown_may_have_created' });
  assert.equal(deps.fakeFetch.calls.length, 1);
});
