/**
 * Review: head exactness (hunt item 1). Business head, SDK head and the
 * third observed "platform" head (`cver:"1.0"`, `extension:[]`, no appId)
 * documented for 14361/searchorderlist, 14361/createimchat,
 * 15529/sendCardMessageForOffline and 17092/listNoticeReceiveConfig.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SoaClient, soaHeaders } from './soa.ts';
import { businessHead, platformHead, sdkHead } from './heads.ts';
import { createImChat, searchOrderExact } from './order.ts';
import { sendProductCard } from './send.ts';
import { listNoticeReceiveConfig } from './settings.ts';
import { FAKE_CONTEXT, OK_STATUS, jsonResponse, makeDeps } from './testing.ts';

const ctx = { ...FAKE_CONTEXT, cid: 'ctx-cid-1', sid: 'ctx-sid-1', locale: 'en-US' };

/** Verbatim from docs/api/endpoints/sec-m.ctrip.com-14361-createimchat-post.md (and the other three). */
const DOC_PLATFORM_HEAD = {
  cid: 'ctx-cid-1',
  ctok: '',
  cver: '1.0',
  lang: '01',
  sid: 'ctx-sid-1',
  syscode: '09',
  auth: '',
  xsid: '',
  extension: [],
};

test('review/heads: platform head equals the documented JSON (keys, order, no appId, empty extension)', () => {
  const h = platformHead(ctx);
  assert.deepEqual(h, DOC_PLATFORM_HEAD);
  assert.deepEqual(Object.keys(h), ['cid', 'ctok', 'cver', 'lang', 'sid', 'syscode', 'auth', 'xsid', 'extension']);
  assert.equal('appId' in h, false);
});

test('review/heads: 14361 searchorderlist + createimchat send the platform head, not the IM business head', async () => {
  const deps = makeDeps((_, i) =>
    i === 0
      ? jsonResponse({ ResponseStatus: OK_STATUS, response: { errorCode: 0, errorMsg: '' }, orderList: [{ ttdOrderId: 1 }], totalCount: 1 })
      : jsonResponse({ ResponseStatus: OK_STATUS, response: { errorCode: 0, errorMsg: '' }, url: 'https://imvendor.ctrip.com/main' }),
    ctx,
  );
  const soa = new SoaClient(deps);
  await searchOrderExact(deps, soa, '123', { page: '{{page}}', sortProperty: '{{p}}' });
  await createImChat(deps, soa, '123');
  for (const call of deps.fakeFetch.calls) {
    const body = call.bodyJson as { head: unknown };
    assert.deepEqual(body.head, DOC_PLATFORM_HEAD, call.url);
  }
  assert.deepEqual(Object.keys(deps.fakeFetch.calls[0]?.bodyJson as object), ['contentType', 'head', 'page', 'ttdOrderId', 'pageIndex', 'pageSize', 'aggSortType', 'vbkVer', 'datablockType']);
  assert.deepEqual(Object.keys(deps.fakeFetch.calls[1]?.bodyJson as object), ['contentType', 'head', 'ttdOrderId']);
});

test('review/heads: 15529/sendCardMessageForOffline and 17092/listNoticeReceiveConfig send the platform head', async () => {
  const deps = makeDeps((_, i) => (i === 0 ? jsonResponse({ ResponseStatus: OK_STATUS, data: { localId: 'l', msgId: 'm' } }) : jsonResponse({ ResponseStatus: OK_STATUS, configList: [] })), ctx);
  const soa = new SoaClient(deps);
  await sendProductCard(deps, soa, { bizType: 1513, templateId: 't', groupIdentity: 'g', uid: 'u', card: { a: 'b' } });
  await listNoticeReceiveConfig(deps, soa);
  for (const call of deps.fakeFetch.calls) assert.deepEqual((call.bodyJson as { head: unknown }).head, DOC_PLATFORM_HEAD, call.url);
  assert.deepEqual(Object.keys(deps.fakeFetch.calls[1]?.bodyJson as object), ['scene', 'head']);
  assert.equal((deps.fakeFetch.calls[1]?.bodyJson as { scene: string }).scene, 'vbk_notice_h5');
});

test('review/heads: business/SDK extension order is exactly the documented order and nothing leaks into HTTP headers', () => {
  assert.deepEqual(
    businessHead(ctx).extension.map((e) => e.name),
    ['cpc', 'protocal', 'amp-product-type', 'amp-account-source', 'client-source', 'locale'],
  );
  assert.deepEqual(
    businessHead(ctx).extension.map((e) => e.value),
    ['pc', 'https', 'IM', 'VBK', 'pc-900004', 'en-US'],
  );
  assert.deepEqual(
    sdkHead(ctx).extension.map((e) => [e.name, e.value]),
    [
      ['protocol', 'https:'],
      ['cpc', 'pc'],
      ['appid', '100067816'],
      ['language', 'en-US'],
      ['amp-product-type', 'IM'],
      ['amp-account-source', 'vbk'],
      ['client-source', ''],
    ],
  );
  const headers = soaHeaders(ctx);
  for (const k of Object.keys(headers)) assert.equal(['cid', 'sid', 'appId', 'appid', 'auth', 'cookie', 'Cookie', 'Authorization'].includes(k), false, k);
  assert.equal(JSON.stringify(headers).includes('ctx-cid-1'), false);
  assert.equal(JSON.stringify(headers).includes('ctx-sid-1'), false);
});

test('review/heads: no hardcoded cid/sid/biztype literals in non-test sources', () => {
  const dir = dirname(fileURLToPath(import.meta.url));
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'testing.ts');
  assert.ok(files.length >= 15);
  for (const f of files) {
    const src = readFileSync(join(dir, f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(src, /['"]8888['"]/, f);
    assert.doesNotMatch(src, /\bcid:\s*['"][^'"]+['"]/, f);
    assert.doesNotMatch(src, /\bsid:\s*['"][^'"]+['"]/, f);
    assert.doesNotMatch(src, /biztype:\s*['"]1513['"]/i, f);
  }
});
