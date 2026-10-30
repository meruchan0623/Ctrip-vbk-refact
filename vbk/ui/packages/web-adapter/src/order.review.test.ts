/**
 * Review: order entry and IM URL validation (hunt item 9).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SoaClient } from './soa.ts';
import { createImChat, isValidOrderId, orderDetailUrl, searchOrderExact, validateImUrl } from './order.ts';
import { FAILURE_STATUS, OK_STATUS, jsonResponse, makeDeps } from './testing.ts';

const params = { page: '{{page}}', sortProperty: '{{property}}' };

test('review/order: ttdOrderId stays a string even when it is all digits (leading zeros kept)', async () => {
  const deps = makeDeps(() => jsonResponse({ ResponseStatus: OK_STATUS, response: { errorCode: 0, errorMsg: '' }, orderList: [{ ttdOrderId: 123 }], totalCount: 1 }));
  await searchOrderExact(deps, new SoaClient(deps), '0012345678901234567890', params);
  const body = deps.fakeFetch.calls[0]?.bodyJson as Record<string, unknown>;
  assert.equal(body['ttdOrderId'], '0012345678901234567890');
  assert.equal(typeof body['ttdOrderId'], 'string');
  assert.equal(deps.fakeFetch.calls[0]?.init.body.toString().includes('"ttdOrderId":"0012345678901234567890"'), true);
  for (const bad of ['', '12 3', '１２３', '12a', '-1', '1.0', '1'.repeat(33), ' 1', '1\n']) assert.equal(isValidOrderId(bad), false, JSON.stringify(bad));
  assert.equal(isValidOrderId('1'.repeat(32)), true);
});

test('review/order: none / one / multiple are distinct and come from totalCount or list length, hostile shapes tolerated', async () => {
  const bodies: unknown[] = [
    { ResponseStatus: OK_STATUS, response: { errorCode: 0, errorMsg: '' }, orderList: [], totalCount: 2 }, // multiple(2)
    { ResponseStatus: OK_STATUS, response: null, orderList: null, totalCount: null }, // none
    { ResponseStatus: OK_STATUS, response: 'x', orderList: 'x', totalCount: '2' }, // none (string count ignored)
    { ResponseStatus: OK_STATUS, orderList: [{ a: 1 }] }, // one
    { ResponseStatus: OK_STATUS, orderList: [], totalCount: 1 }, // error: row malformed
    { ResponseStatus: OK_STATUS, orderList: [null], totalCount: 1 }, // error: row malformed
    { ResponseStatus: OK_STATUS, orderList: [{}, {}] }, // multiple(2)
    { ResponseStatus: OK_STATUS, response: { errorCode: '3', errorMsg: 'No permission' }, orderList: [{}] }, // string errorCode ignored → one
    { ResponseStatus: FAILURE_STATUS, orderList: [{}] }, // error (ack)
  ];
  const deps = makeDeps((_, i) => jsonResponse(bodies[i]));
  const soa = new SoaClient(deps);
  const kinds: string[] = [];
  for (let i = 0; i < bodies.length; i++) {
    const r = await searchOrderExact(deps, soa, '1', params);
    kinds.push(r.kind === 'multiple' ? `multiple(${r.count})` : r.kind === 'error' ? `error:${r.detail}` : r.kind);
  }
  assert.deepEqual(kinds, ['multiple(2)', 'none', 'none', 'one', 'error:order row malformed', 'error:order row malformed', 'multiple(2)', 'one', 'error:business_failure']);
});

test('review/order: createImChat ok requires Ack Success AND a non-empty url AND errorCode 0/absent', async () => {
  const bodies: unknown[] = [
    { ResponseStatus: OK_STATUS, response: { errorCode: 0, errorMsg: '' }, url: 'https://imvendor.ctrip.com/main' },
    { ResponseStatus: OK_STATUS, response: { errorCode: 0, errorMsg: '' }, url: '' },
    { ResponseStatus: OK_STATUS, response: { errorCode: 0, errorMsg: '' }, url: 123 },
    { ResponseStatus: OK_STATUS, response: { errorCode: 0, errorMsg: '' } },
    { ResponseStatus: OK_STATUS, response: { errorCode: 1, errorMsg: 'x' }, url: 'https://imvendor.ctrip.com/main' },
    { ResponseStatus: FAILURE_STATUS, response: { errorCode: 0, errorMsg: '' }, url: 'https://imvendor.ctrip.com/main' },
    { ResponseStatus: OK_STATUS, url: 'https://imvendor.ctrip.com/main' },
    { ResponseStatus: OK_STATUS, response: null, url: 'https://imvendor.ctrip.com/main' },
  ];
  const deps = makeDeps((_, i) => jsonResponse(bodies[i]));
  const soa = new SoaClient(deps);
  const kinds: string[] = [];
  for (let i = 0; i < bodies.length; i++) kinds.push((await createImChat(deps, soa, '1')).kind);
  assert.deepEqual(kinds, ['ok', 'rejected', 'rejected', 'rejected', 'rejected', 'rejected', 'ok', 'ok']);
  assert.equal(deps.fakeFetch.calls.length, bodies.length, 'one request per call, never a retry');
});

test('review/order: createImChat timeout / network error → unknown_may_have_created and exactly one request', async () => {
  const hang = makeDeps(() => 'hang');
  const soa = new SoaClient(hang, { defaultTimeoutMs: 1000 });
  const p = createImChat(hang, soa, '1');
  await hang.clock.advance(1000);
  assert.deepEqual(await p, { kind: 'unknown_may_have_created' });
  await hang.clock.advance(600000);
  assert.equal(hang.fakeFetch.calls.length, 1);
  const net = makeDeps(() => new Error('net'));
  assert.deepEqual(await createImChat(net, new SoaClient(net), '1'), { kind: 'unknown_may_have_created' });
  assert.equal(net.fakeFetch.calls.length, 1);
});

test('review/order: validateImUrl rejects every look-alike from the review list and never throws', () => {
  const bad: [string, string][] = [
    ['https://imvendor.ctrip.com.evil.com/main', 'host'],
    ['https://evil.com/main?x=imvendor.ctrip.com', 'host'],
    ['https://user@imvendor.ctrip.com/main', 'userinfo'],
    ['https://user:pw@imvendor.ctrip.com/main', 'userinfo'],
    ['http://imvendor.ctrip.com/main', 'scheme'],
    ['HTTPS://imvendor.ctrip.com:8443/main', 'port'],
    ['https://imvendor.ctrip.com:8443/main', 'port'],
    ['https://imvendor.ctrip.com/main/../x', 'path'],
    ['https://imvendor.ctrip.com/main/..', 'path'],
    ['https://imvendor.ctrip.com\\evil.com/main', 'path'],
    ['https://imvendor.ctrip.com/main\\..\\x', 'path'],
    ['https://imvendor.ctrip.com\\@evil.com/main', 'path'],
    ['https://imvendor.ctrip.com./main', 'host'],
    ['https://imvendor.ctrip.com/main/', 'path'],
    ['https://imvendor.ctrip.com/main%2F..%2Fx', 'path'],
    ['https://imvendor.ctrip.com/MAIN', 'path'],
    ['https://imvendor.ctrip.com/main#x', 'fragment'],
    ['https://imvendor.ctrip.com/vbk/im/main', 'path'],
    ['https://vbooking.ctrip.com/main', 'path'],
    ['https://constructor/main', 'host'],
    ['https://__proto__/main', 'host'],
    ['https://hasOwnProperty/main', 'host'],
    ['https://[::1]/main', 'host'],
    ['https://imvendor.ctrip.com/main?initChat=2x', 'param:initChat'],
    ['https://imvendor.ctrip.com/main?orderNo=1;drop', 'param:orderNo'],
    ['https://imvendor.ctrip.com/main?targetGid=%3Cscript%3E', 'param:targetGid'],
    ['https://imvendor.ctrip.com/main?client-source=pc%201001', 'param:client-source'],
    ['javascript:alert(1)', 'scheme'],
    ['', 'unparsable'],
    ['//imvendor.ctrip.com/main', 'unparsable'],
    ['https://', 'unparsable'],
    ['not a url', 'unparsable'],
  ];
  for (const [u, reason] of bad) {
    const r = validateImUrl(u);
    assert.equal(r.ok, false, u);
    if (!r.ok) assert.equal(r.reason, reason, u);
  }
});

test('review/order: validateImUrl accepts the documented shape, keeps href, and preserves unknown params in order', () => {
  const href = 'https://imvendor.ctrip.com/main?initChat=2&serviceType=1513&vendorRole=VBK&currentTab=BC&accountsource=VBK&client-source=pc-1001&lang=&vendorRefId=ref-1&threadId=&orderNo=987&extParams=%7B%22a%22%3A1%7D&targetGid=&zeta=1&alpha=2&mid=x%20y';
  const r = validateImUrl(href);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.href, href, 'the official URL is kept verbatim for opening');
  assert.deepEqual(Object.keys(r.unknownParams), ['zeta', 'alpha', 'mid']);
  assert.deepEqual(r.unknownParams, { zeta: '1', alpha: '2', mid: 'x y' });
  assert.equal(r.params.initChat, 2);
  assert.equal(r.params.extParams, '{"a":1}');
  assert.equal(r.params.lang, '');
  const port443 = validateImUrl('https://imvendor.ctrip.com:443/main');
  assert.equal(port443.ok, true, 'explicit default port normalizes to no port');
  assert.equal(validateImUrl('https://vbooking.ctrip.com/vbk/im/main?currentTab=BC&lang=zh-CN').ok, true);
});

test('review/order: orderDetailUrl rejects anything but a plain alphanumeric id', () => {
  for (const bad of ['', '12 3', '../1', 'a?b=1', '１２３', '12#', '1&x=2', '1/2', 'a'.repeat(65), '12\n', 'é']) assert.equal(orderDetailUrl(bad), null, JSON.stringify(bad));
  assert.equal(orderDetailUrl('a'.repeat(64)), `https://vbooking.ctrip.com/ticket_order/order/detail?orderId=${'a'.repeat(64)}`);
});
