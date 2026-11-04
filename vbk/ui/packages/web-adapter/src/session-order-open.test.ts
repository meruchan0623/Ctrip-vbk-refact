import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AdapterDisplayPayload } from '../../ipc/src/adapterProtocol.ts';
import type { AdapterFactEnvelope } from '../../ipc/src/contracts.ts';
import { createPageSession } from './session.ts';
import { FakePageSdk, OK_STATUS, flush, jsonResponse, makeDeps, sampleRow } from './testing.ts';

const orderId = '1234567890', gid = '900719925474099312345';
const account = { account_id: 'synthetic-order-owner', environment: 'production', session_generation: 1 };
const success = (conversation: unknown) => jsonResponse({ ResponseStatus: OK_STATUS, bizResponseStatus: { resultCode: 'SUCCESS' }, conversation });
function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(r => { resolve = r; }), resolve }; }
function fixture(options: { target?: boolean; row?: unknown; holdRead?: boolean; holdDisplay?: boolean; rejectDisplay?: boolean } = {}) {
  const read = deferred<ReturnType<typeof jsonResponse>>(), displayed = deferred<unknown>();
  let latest: unknown = options.row ?? sampleRow(gid);
  const displays: AdapterDisplayPayload[] = [];
  const base = makeDeps(call => {
    if (call.url.includes('getLatestConversationByGid')) return options.holdRead ? read.promise : success(latest);
    if (call.url.includes('createimchat')) return jsonResponse({ ResponseStatus: OK_STATUS, response: { errorCode: 0 }, url: `https://imvendor.ctrip.com/main?initChat=2&serviceType=1513&orderNo=${orderId}&accountsource=VBK&vendorRole=VBK&vendorRefId=synthetic${options.target ? `&targetGid=${gid}` : ''}` });
    if (call.url.includes('startChatB2C')) return jsonResponse({ ResponseStatus: OK_STATUS, bizResponseStatus: { resultCode: 'SUCCESS' }, groupId: gid, workSheetId: '9001' });
    if (call.url.includes('getConversationList')) return jsonResponse({ ResponseStatus: OK_STATUS, conversationList: [], haveRest: false, lastUpdateTime: 1700000000600 });
    if (call.url.includes('getRecentMessages')) return jsonResponse({ ResponseStatus: OK_STATUS, messages: [], lastMessageTimestamp: 1700000000000 });
    return jsonResponse({ ResponseStatus: OK_STATUS, bizResponseStatus: { resultCode: 'SUCCESS' }, members: [], conversationInfoList: [] });
  });
  const sdk = new FakePageSdk();
  const session = createPageSession({ ...base, sdk }, { sdk, account, selfUid: 'me', beginMsgTime: 1700000000000, initialEpoch: 1,
    async pushDisplay(payload) {
      displays.push(payload);
      if (payload.kind === 'conversations' && payload.items.some(row => row.gid === gid)) {
        if (options.rejectDisplay) throw new Error('synthetic host display unavailable');
        if (options.holdDisplay) await displayed.promise;
      }
    },
  });
  let sequence = 0;
  return { session, base, sdk, displays, read, displayed, setRow(row: unknown) { latest = row; },
    open: () => session.rpc.handle({ req_id: `synthetic-open-${++sequence}`, op: 'order.create_im_chat', args: { order_id: orderId } }),
    targetDisplays: () => displays.flatMap(payload => payload.kind === 'conversations' ? payload.items.filter(row => row.gid === gid) : []),
  };
}
async function ready(f: ReturnType<typeof fixture>) { f.session.start(); await f.base.clock.advance(50); }
async function reach(f: ReturnType<typeof fixture>, endpoint: string) {
  for (let i = 0; i < 30 && !f.base.fakeFetch.calls.some(call => call.url.includes(endpoint)); ++i) await flush();
  assert.ok(f.base.fakeFetch.calls.some(call => call.url.includes(endpoint)), endpoint);
}

test('order session: empty target initializes B2C then imports only the verified latest row, without sending messages', async () => {
  for (const target of [false, true]) {
    const f = fixture({ target }); await ready(f);
    try {
      const result = await f.open();
      assert.ok(result?.ok); assert.deepEqual(result.data, { gid, reused: false });
      assert.equal(f.session.store.view(gid)?.orderId, orderId);
      assert.equal(f.targetDisplays().at(-1)?.gid, gid); assert.equal(f.targetDisplays().at(-1)?.order?.order_id, orderId);
      const names = f.base.fakeFetch.calls.map(call => new URL(call.url).pathname.split('/').at(-1));
      assert.equal(names.filter(name => name === 'createimchat').length, 1);
      assert.equal(names.filter(name => name === 'startChatB2C').length, target ? 0 : 1);
      assert.equal(names.filter(name => name === 'getLatestConversationByGid').length, 1);
      const latest = f.base.fakeFetch.calls.find(call => call.url.includes('getLatestConversationByGid'));
      assert.equal((latest?.bodyJson as { gid: string }).gid, gid);
      const fact = f.base.invoked.map(call => call.payload as AdapterFactEnvelope).find(e => e.fact.kind === 'conversation' && e.fact.fact.gid === gid);
      assert.ok(fact); assert.deepEqual(fact.account, account); assert.equal(JSON.stringify(fact).includes(`Title ${gid}`), false);
      assert.equal(f.sdk.sent.length, 0); assert.equal(f.sdk.readReceipts.length, 0);
      assert.equal(names.some(name => /send|robot|card/i.test(name ?? '')), false);
    } finally { f.session.stop(); }
  }
});

test('order session: mismatched, incomplete and unsafe numeric row identities cannot create a local conversation', async () => {
  const variants = [
    { gid: '123456' }, { gid: Number(gid) }, { relationOrderId: '9999999999', ext: { orderId: '9999999999' } },
    { relationOrderId: orderId, ext: { orderId: '9999999999' } }, { relationOrderId: Number.MAX_SAFE_INTEGER + 1 },
    { relationOrderId: null, ext: {} }, { sessionId: null }, { sessionId: Number.MAX_SAFE_INTEGER + 1 },
    { uid: null }, { serviceType: '' }, { conversationType: null }, { status: 99 }, { id: Number.MAX_SAFE_INTEGER + 1 },
  ];
  for (const variant of variants) {
    const f = fixture({ row: sampleRow(gid, variant) }); await ready(f);
    try {
      const result = await f.open(); assert.ok(result && !result.ok, JSON.stringify(variant));
      assert.equal(f.session.store.has(gid), false); assert.deepEqual(f.targetDisplays(), []); assert.equal(f.sdk.sent.length, 0);
    } finally { f.session.stop(); }
  }
});

test('order session: stop/restart or an intervening service identity prevents a late read from being imported', async () => {
  for (const change of ['stop', 'restart', 'replace']) {
    const f = fixture({ holdRead: true }); await ready(f);
    try {
      const pending = f.open(); await reach(f, 'getLatestConversationByGid');
      if (change === 'stop') f.session.stop();
      else if (change === 'restart') { f.session.stop(); f.session.start(); await f.base.clock.advance(50); }
      else f.session.store.update([sampleRow(gid, { sessionId: 'newer-service', uid: 'newer-customer' })]);
      f.read.resolve(success(sampleRow(gid))); const result = await pending;
      assert.ok(result && !result.ok); assert.deepEqual(f.targetDisplays(), []);
      assert.equal(f.session.store.has(gid), change === 'replace');
      if (change === 'replace') assert.equal(f.session.store.view(gid)?.sessionId, 'newer-service');
    } finally { f.session.stop(); }
  }
});

test('order session: response waits for host display acknowledgement and rejects host publication failure', async () => {
  const f = fixture({ holdDisplay: true }); await ready(f);
  try {
    let settled = false; const pending = f.open().then(result => { settled = true; return result; });
    await reach(f, 'getLatestConversationByGid'); for (let i = 0; i < 20; ++i) await flush();
    assert.equal(f.targetDisplays().length, 1); assert.equal(settled, false);
    f.displayed.resolve(null); assert.ok((await pending)?.ok);
  } finally { f.session.stop(); }
  const failed = fixture({ rejectDisplay: true }); await ready(failed);
  try { const result = await failed.open(); assert.ok(result && !result.ok); } finally { failed.session.stop(); }
});

test('order session: retry after rejected readback repeats only the read and retains initialized gid', async () => {
  const f = fixture({ row: sampleRow(gid, { relationOrderId: '9999999999', ext: { orderId: '9999999999' } }) }); await ready(f);
  try {
    assert.equal((await f.open())?.ok, false);
    f.setRow(sampleRow(gid)); assert.equal((await f.open())?.ok, true);
    const urls = f.base.fakeFetch.calls.map(call => call.url);
    assert.equal(urls.filter(url => url.includes('createimchat')).length, 1);
    assert.equal(urls.filter(url => url.includes('startChatB2C')).length, 1);
    assert.equal(urls.filter(url => url.includes('getLatestConversationByGid')).length, 2);
    assert.equal(f.sdk.sent.length, 0);
  } finally { f.session.stop(); }
});
