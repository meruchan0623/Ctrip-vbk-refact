/**
 * The two `body.head` shapes observed on 2026-10-30 (docs/api/authentication.md).
 *
 * - `businessHead`: web business requests (16037/13500/14361/15529/...).
 *   Note the misspelt extension name `protocal` and uppercase `VBK`; both
 *   are the observed wire values.
 * - `sdkHead`: official IM SDK requests (11679/getRecentMessages,
 *   GetMyInfo.json, SendMessage.json). `protocol` with a colon, lowercase
 *   `vbk`, empty `client-source`.
 *
 * Other services have their own head and must NOT reuse these templates:
 * `18088/getAppConfig.json` was observed with an independent head, and
 * `12405/getCurrentUserInfo` (online.ctrip.com) carries extra top-level
 * fields. Never merge a head into HTTP headers; it is a JSON body field.
 */

import type { PageContext } from './deps.ts';

export interface HeadExtension {
  readonly name: string;
  readonly value: string;
}

export interface BusinessHead {
  readonly cid: string;
  readonly ctok: '';
  readonly cver: '2';
  readonly lang: '01';
  readonly sid: string;
  readonly syscode: '09';
  readonly auth: '';
  readonly xsid: '';
  readonly extension: readonly HeadExtension[];
  readonly appId: '900004';
}

export interface SdkHead {
  readonly cver: '1.0.7';
  readonly extension: readonly HeadExtension[];
}

export const BUSINESS_APP_ID = '900004';
export const SDK_APP_ID = '100067816';

/** Exactly the observed web business head; `cid`/`sid`/`locale` come from the page context. */
export function businessHead(ctx: PageContext): BusinessHead {
  return {
    cid: ctx.cid,
    ctok: '',
    cver: '2',
    lang: '01',
    sid: ctx.sid,
    syscode: '09',
    auth: '',
    xsid: '',
    extension: [
      { name: 'cpc', value: 'pc' },
      { name: 'protocal', value: 'https' },
      { name: 'amp-product-type', value: 'IM' },
      { name: 'amp-account-source', value: 'VBK' },
      { name: 'client-source', value: `pc-${BUSINESS_APP_ID}` },
      { name: 'locale', value: ctx.locale },
    ],
    appId: BUSINESS_APP_ID,
  };
}

/** Exactly the observed IM SDK head (cookie branch: no `auth`). */
export function sdkHead(ctx: PageContext): SdkHead {
  return {
    cver: '1.0.7',
    extension: [
      { name: 'protocol', value: 'https:' },
      { name: 'cpc', value: 'pc' },
      { name: 'appid', value: SDK_APP_ID },
      { name: 'language', value: ctx.locale },
      { name: 'amp-product-type', value: 'IM' },
      { name: 'amp-account-source', value: 'vbk' },
      { name: 'client-source', value: '' },
    ],
  };
}
