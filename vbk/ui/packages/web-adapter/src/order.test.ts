import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SoaClient } from './soa.ts';
import { createImChat, orderDetailUrl, searchConversationByOrder, searchOrderExact, validateImUrl } from './order.ts';
import { OK_STATUS, jsonResponse, makeDeps } from './testing.ts';

const params = { page: '{{page}}', sortProperty: '{{property}}' };

test('searchOrderExact: string id, observed defaults, one/none/multiple/forbidden/error', async () => {
  const deps = makeDeps((_, i) => {
    if (i === 0) return jsonResponse({ ResponseStatus: OK_STATUS, response: { errorCode: 0, errorMsg: '' }, orderList: [{ orderId: '{{id}}' }], totalCount: 1 });
    if (i === 1) return jsonResponse({ ResponseStatus: OK_STATUS, response: { errorCode: 0, errorMsg: '' }, orderList: [], totalCount: 0 });
    if (i === 2) return jsonResponse({ ResponseStatus: OK_STATUS, response: { errorCode: 0, errorMsg: '' }, orderList: [{}, {}], totalCount: 2 });
    if (i === 3) return jsonResponse({ ResponseStatus: OK_STATUS, response: { errorCode: 3, errorMsg: 'No permission' }, orderList: [], totalCount: 0 });
    return jsonResponse({ ResponseStatus: OK_STATUS, response: { errorCode: 9, errorMsg: '{{msg}}' } });
  });
  const soa = new SoaClient(deps);
  const one = await searchOrderExact(deps, soa, '1234567890123', params);
  assert.equal(one.kind, 'one');
  const body = deps.fakeFetch.calls[0]?.bodyJson as Record<string, unknown>;
  assert.equal(deps.fakeFetch.calls[0]?.url.startsWith('https://sec-m.ctrip.com/restapi/soa2/14361/searchorderlist'), true);
  assert.equal(body['ttdOrderId'], '1234567890123');
  assert.equal(typeof body['ttdOrderId'], 'string');
  assert.equal(body['contentType'], 'json');
  assert.equal(body['pageIndex'], 1);
  assert.equal(body['pageSize'], 20);
  assert.deepEqual(body['aggSortType'], { property: '{{property}}', direction: 'desc' });
  assert.equal(body['vbkVer'], 3);
  assert.equal(body['datablockType'], 0);
  assert.equal(body['page'], '{{page}}');
  assert.deepEqual(await searchOrderExact(deps, soa, '1', params), { kind: 'none' });
  assert.deepEqual(await searchOrderExact(deps, soa, '1', params), { kind: 'multiple', count: 2 });
  assert.deepEqual(await searchOrderExact(deps, soa, '1', params), { kind: 'forbidden', errorCode: 3, errorMsg: 'No permission' });
  assert.equal((await searchOrderExact(deps, soa, '1', params)).kind, 'error');
  assert.equal((await searchOrderExact(deps, soa, '12ab', params)).kind, 'error');
  assert.equal(deps.fakeFetch.calls.length, 5);
});

test('createImChat: ok only with Ack Success + url; timeout → unknown_may_have_created, no replay', async () => {
  const deps = makeDeps((_, i) => {
    if (i === 0) return jsonResponse({ ResponseStatus: OK_STATUS, response: { errorCode: 0, errorMsg: '' }, url: 'https://imvendor.ctrip.com/main?initChat=2' });
    if (i === 1) return jsonResponse({ ResponseStatus: OK_STATUS, response: { errorCode: 1, errorMsg: '{{msg}}' } });
    return 'hang';
  });
  const soa = new SoaClient(deps, { defaultTimeoutMs: 1000 });
  assert.deepEqual(await createImChat(deps, soa, '123'), { kind: 'ok', url: 'https://imvendor.ctrip.com/main?initChat=2' });
  assert.deepEqual(Object.keys(deps.fakeFetch.calls[0]?.bodyJson as object), ['contentType', 'head', 'ttdOrderId']);
  assert.equal((await createImChat(deps, soa, '123')).kind, 'rejected');
  const p = createImChat(deps, soa, '123');
  await deps.clock.advance(1000);
  assert.deepEqual(await p, { kind: 'unknown_may_have_created' });
  assert.equal(deps.fakeFetch.calls.length, 3);
});

test('validateImUrl: positive matrix with typed + preserved params', () => {
  const r = validateImUrl('https://imvendor.ctrip.com/main?initChat=2&serviceType=1513&vendorRole=VBK&currentTab=BC&accountsource=VBK&client-source=pc-1001&lang=&vendorRefId=ref1&threadId=&orderNo=987&extParams=%7B%22a%22%3A1%7D&targetGid=&mystery=keep');
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.origin, 'https://imvendor.ctrip.com');
  assert.equal(r.path, '/main');
  assert.deepEqual(r.params, {
    initChat: 2,
    serviceType: '1513',
    vendorRole: 'VBK',
    currentTab: 'BC',
    accountsource: 'VBK',
    clientSource: 'pc-1001',
    lang: '',
    vendorRefId: 'ref1',
    threadId: '',
    orderNo: '987',
    extParams: '{"a":1}',
    targetGid: '',
  });
  assert.deepEqual(r.unknownParams, { mystery: 'keep' });
  assert.equal(validateImUrl('https://vbooking.ctrip.com/vbk/im/main?currentTab=BC&lang=zh-CN').ok, true);
  assert.equal(validateImUrl('https://vbooking.ctrip.com/vbk/im/main').ok, true);
});

test('validateImUrl: evil hosts, schemes, userinfo, paths, params', () => {
  const bad = [
    'http://imvendor.ctrip.com/main',
    'https://imvendor.ctrip.com.evil.com/main',
    'https://evil.com/imvendor.ctrip.com/main',
    'https://ximvendor.ctrip.com/main',
    'https://imvendor.ctrip.com@evil.com/main',
    'https://user:pw@imvendor.ctrip.com/main',
    'https://imvendor.ctrip.com:8443/main',
    'https://imvendor.ctrip.com/main/../admin',
    'https://imvendor.ctrip.com/mainx',
    'https://imvendor.ctrip.com/vbk/im/main',
    'https://vbooking.ctrip.com/main',
    'https://imvendor.ctrip.com/main#frag',
    'https://imvendor.ctrip.com/main?initChat=abc',
    'https://imvendor.ctrip.com/main?orderNo=12%3Cscript%3E',
    'https://imvendor.ctrip.com/main?vendorRole=%3Cb%3E',
    'javascript:alert(1)',
    'not a url',
    'https://IMVENDOR.ctrip.com.evil/main',
  ];
  for (const u of bad) assert.equal(validateImUrl(u).ok, false, u);
  assert.equal(validateImUrl('https://IMVENDOR.CTRIP.COM/main').ok, true); // host is case-insensitive by spec
});

test('orderDetailUrl', () => {
  assert.equal(orderDetailUrl('123456'), 'https://vbooking.ctrip.com/ticket_order/order/detail?orderId=123456');
  assert.equal(orderDetailUrl('AB12'), 'https://vbooking.ctrip.com/ticket_order/order/detail?orderId=AB12');
  assert.equal(orderDetailUrl('12&x=1'), null);
  assert.equal(orderDetailUrl(''), null);
});

test('searchConversationByOrder maps hits with injected searchType', async () => {
  const deps = makeDeps(() =>
    jsonResponse({
      ResponseStatus: OK_STATUS,
      bizResponseStatus: { resultCode: 'SUCCESS' },
      customerSearchList: [{ conversation: { gid: 'g1', sessionId: 's1', status: 4, serviceType: '1513', inGroup: 0, conversationType: 'B2C', threadId: '' }, message: {} }, { nope: true }],
    }),
  );
  const r = await searchConversationByOrder(deps, new SoaClient(deps), '{{orderNo}}', 42);
  assert.deepEqual(r, { kind: 'hits', hits: [{ gid: 'g1', sessionId: 's1', status: 'finished', serviceType: '1513', inGroup: 0, conversationType: 'B2C', threadId: '' }] });
  assert.deepEqual(deps.fakeFetch.calls[0]?.bodyJson && Object.keys(deps.fakeFetch.calls[0].bodyJson as object), ['head', 'searchType', 'searchValue', 'pageNo']);
  assert.equal((deps.fakeFetch.calls[0]?.bodyJson as { searchType: number }).searchType, 42);
});
