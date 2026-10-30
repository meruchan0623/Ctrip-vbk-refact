import { test } from 'node:test';
import assert from 'node:assert/strict';
import { businessHead, sdkHead } from './heads.ts';
import { FAKE_CONTEXT } from './testing.ts';

test('business head matches the documented JSON exactly (incl. protocal misspelling)', () => {
  const ctx = { ...FAKE_CONTEXT, cid: '{{当前上下文cid}}', sid: '{{当前上下文sid}}' };
  assert.deepEqual(businessHead(ctx), {
    cid: '{{当前上下文cid}}',
    ctok: '',
    cver: '2',
    lang: '01',
    sid: '{{当前上下文sid}}',
    syscode: '09',
    auth: '',
    xsid: '',
    extension: [
      { name: 'cpc', value: 'pc' },
      { name: 'protocal', value: 'https' },
      { name: 'amp-product-type', value: 'IM' },
      { name: 'amp-account-source', value: 'VBK' },
      { name: 'client-source', value: 'pc-900004' },
      { name: 'locale', value: 'zh-CN' },
    ],
    appId: '900004',
  });
  // key order is part of the observed shape
  assert.deepEqual(Object.keys(businessHead(ctx)), ['cid', 'ctok', 'cver', 'lang', 'sid', 'syscode', 'auth', 'xsid', 'extension', 'appId']);
});

test('sdk head matches the documented JSON exactly', () => {
  assert.deepEqual(sdkHead(FAKE_CONTEXT), {
    cver: '1.0.7',
    extension: [
      { name: 'protocol', value: 'https:' },
      { name: 'cpc', value: 'pc' },
      { name: 'appid', value: '100067816' },
      { name: 'language', value: 'zh-CN' },
      { name: 'amp-product-type', value: 'IM' },
      { name: 'amp-account-source', value: 'vbk' },
      { name: 'client-source', value: '' },
    ],
  });
});

test('cid/sid are never hardcoded', () => {
  const h = businessHead({ ...FAKE_CONTEXT, cid: 'c-1', sid: 's-1', locale: 'en-US' });
  assert.equal(h.cid, 'c-1');
  assert.equal(h.sid, 's-1');
  assert.equal(h.extension[5]?.value, 'en-US');
});
