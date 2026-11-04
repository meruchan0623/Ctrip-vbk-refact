import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchNoticeCategories, fetchNoticeList, flattenCategories, iqMessageToNotice, markNoticeRead } from './notice.ts';
import { SoaClient } from './soa.ts';
import { FAKE_CONTEXT, jsonResponse, makeDeps, OK_STATUS } from './testing.ts';

const TIME = 1_700_000_000_000;
const ref = { categoryId: 3, categorySubId: 112 };
const card = { ext: { title: '订单通知', desc: '请查看最新订单', extendInfo: { toJumpUrlOnline: 'https://vbooking.ctrip.com/order/1' } } };
const row = (msgId = '9007199254740993', createTime = TIME) => ({ msgId, createTime, messageBody: JSON.stringify(card) });
const categories = { categoryList: [{ categoryId: 3, categoryName: '业务', categorySubList: [{ categoryId: 112, categoryName: '订单', unreadCount: 2, unreadTimeline: TIME - 1, lastMsgTime: TIME, lastMsgId: '9007199254740993' }] }] };

test('IQ category request uses getHead(1001); category metadata keeps unread timeline and exact message ID', async () => {
  const deps = makeDeps(() => jsonResponse({ ResponseStatus: OK_STATUS, ...categories }));
  const result = await fetchNoticeCategories(deps, new SoaClient(deps));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.items[0], { id: '3:112', name: '订单', unread: 2, ref, unreadTimeline: TIME - 1, lastMsgTime: TIME, lastMsgId: '9007199254740993' });
  assert.deepEqual(deps.fakeFetch.calls[0]?.bodyJson, {
    lastMsgTime: 0,
    head: { cver: '2', appId: '1001', extension: [
      { name: 'cpc', value: 'pc' }, { name: 'protocal', value: 'https' },
      { name: 'amp-product-type', value: 'IM' }, { name: 'amp-account-source', value: 'VBK' },
      { name: 'client-source', value: 'pc-1001' }, { name: 'locale', value: 'zh-CN' },
    ] },
  });
});

test('IQ category list preserves ignored categories and deduplicates exact category IDs', () => {
  const child = { ...categories.categoryList[0]!.categorySubList[0]!, optStatus: 'ignore' };
  const items = flattenCategories({ categoryList: [{ categoryId: 3, categorySubList: [child, child] }] });
  assert.equal(items?.length, 1);
  assert.equal(items?.[0]?.id, '3:112');
});

test('IQ list and read requests use the wrapper getVBKHead shape', async () => {
  const deps = makeDeps(call => jsonResponse({ ResponseStatus: OK_STATUS, ...(call.url.includes('getIQMessages') ? { iqMessages: [] } : {}) }));
  const soa = new SoaClient(deps);
  await fetchNoticeList(deps, soa, ref, 0);
  await markNoticeRead(deps, soa, ref, '9007199254740993');
  const head = { cid: FAKE_CONTEXT.cid, ctok: '', cver: '1.0', lang: '01', sid: '8888', syscode: '09', auth: '', extension: [] };
  assert.deepEqual(deps.fakeFetch.calls[0]?.bodyJson, { ...ref, lastMsgTime: 0, pageSize: 100, head });
  assert.deepEqual(deps.fakeFetch.calls[1]?.bodyJson, { ...ref, msgId: '9007199254740993', head });
});

test('IQ category malformed envelopes fail instead of becoming an empty list', async () => {
  for (const body of [{}, { categoryList: null }, { categoryList: {} }, { categoryList: [null] }, { categoryList: [{ categoryId: 3, categorySubList: {} }] }]) {
    const deps = makeDeps(() => jsonResponse({ ResponseStatus: OK_STATUS, ...body }));
    const result = await fetchNoticeCategories(deps, new SoaClient(deps));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.outcome.kind, 'malformed');
  }
  assert.deepEqual(flattenCategories({ categoryList: [] }), []);
});

test('IQ messageBody maps card fields; boundary equality is read and milliseconds remain unchanged', () => {
  assert.deepEqual(iqMessageToNotice(row(), '3:112', TIME - 1), {
    id: '9007199254740993', category_id: '3:112', title: '订单通知', body: '请查看最新订单',
    time_ms: TIME, unread: true, url: 'https://vbooking.ctrip.com/order/1',
  });
  assert.equal(iqMessageToNotice(row(), '3:112', TIME)?.unread, false);
  assert.equal(iqMessageToNotice({ ...row(), status: 0, isRead: false }, '3:112', TIME)?.unread, false);
  assert.equal(iqMessageToNotice(row('old', 1_700_000_000), '3:112', null)?.time_ms, 1_700_000_000, 'IQ time is already milliseconds, never scale seconds');
  const unsafeUrl = { ext: { ...card.ext, extendInfo: { toJumpUrlOnline: 'javascript:alert(1)' } } };
  assert.equal(iqMessageToNotice({ ...row(), messageBody: JSON.stringify(unsafeUrl) }, '3:112', null)?.url, '');
});

test('IQ messageBody retries literal control characters as the official reducer does', () => {
  const messageBody = '{"ext":{"title":"a\nb","desc":"line\tbreak"}}';
  assert.equal(iqMessageToNotice({ ...row(), messageBody }, '3:112', null)?.title, 'a\nb');
});

test('IQ list preserves raw page length and sorts by createTime without losing 64-bit strings', async () => {
  const deps = makeDeps(() => jsonResponse({ ResponseStatus: OK_STATUS, iqMessages: [row('9007199254740993', TIME + 1), row('9007199254740992'), row('9007199254740993', TIME + 1)] }));
  const result = await fetchNoticeList(deps, new SoaClient(deps), ref, 0, TIME);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.items.map(x => [x.id, x.unread]), [['9007199254740992', false], ['9007199254740993', true], ['9007199254740993', true]]);
  assert.equal(result.rows.length, 3, 'raw page size remains available to the caller');
});

test('IQ malformed message envelopes and unsafe numeric IDs fail, while an explicit empty array succeeds', async () => {
  for (const body of [{}, { iqMessages: null }, { iqMessages: {} }, { iqMessages: [null] }, { iqMessages: [{ ...row(), msgId: Number.MAX_SAFE_INTEGER + 1 }] }, { iqMessages: [{ ...row(), messageBody: 'broken' }] }, { iqMessages: [{ ...row(), createTime: 'bad' }] }]) {
    const deps = makeDeps(() => jsonResponse({ ResponseStatus: OK_STATUS, ...body }));
    const result = await fetchNoticeList(deps, new SoaClient(deps), ref, 0);
    assert.equal(result.ok, false, JSON.stringify(body));
    if (!result.ok) assert.equal(result.outcome.kind, 'malformed');
  }
  const deps = makeDeps(() => jsonResponse({ ResponseStatus: OK_STATUS, iqMessages: [] }));
  assert.deepEqual(await fetchNoticeList(deps, new SoaClient(deps), ref, 0), { ok: true, items: [], rows: [] });
});

test('IQ rejected business flags and SOA failure remain typed failures for all notice operations', async () => {
  for (const failure of [{ ResponseStatus: OK_STATUS, success: false }, { ResponseStatus: OK_STATUS, isSuccess: false }, { ResponseStatus: { Ack: 'Failure', Errors: [{ ErrorCode: 'Denied' }] } }]) {
    const deps = makeDeps(() => jsonResponse(failure));
    const soa = new SoaClient(deps);
    const categories = await fetchNoticeCategories(deps, soa);
    const list = await fetchNoticeList(deps, soa, ref, 0);
    const read = await markNoticeRead(deps, soa, ref, 'one');
    assert.equal(categories.ok, false);
    assert.equal(list.ok, false);
    if (!categories.ok) assert.equal(categories.outcome.kind, 'business_failure');
    if (!list.ok) assert.equal(list.outcome.kind, 'business_failure');
    assert.equal(read.kind, 'business_failure');
  }
});

test('IQ preserves authentication, HTTP and JSON failure classifications', async () => {
  const cases = [
    { response: jsonResponse({ ResponseStatus: { Ack: 'Failure', Errors: [{ ErrorCode: 'AccountsMobileRequestFilterException' }] } }), expected: 'auth_invalid' },
    { response: jsonResponse({}, 503), expected: 'http_error' },
    { response: jsonResponse('not json'), expected: 'malformed' },
  ];
  for (const { response, expected } of cases) {
    const deps = makeDeps(() => response);
    const categories = await fetchNoticeCategories(deps, new SoaClient(deps));
    const list = await fetchNoticeList(deps, new SoaClient(deps), ref, 0);
    assert.equal(categories.ok, false);
    assert.equal(list.ok, false);
    if (!categories.ok) assert.equal(categories.outcome.kind, expected);
    if (!list.ok) assert.equal(list.outcome.kind, expected);
  }
});
