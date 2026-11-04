import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchOrderSource } from './order-source.ts';
import { SoaClient } from './soa.ts';
import type { UiOrderSummary } from '../../ipc/src/client.ts';
import { ConversationStore } from './stores.ts';
import { makeDeps, jsonResponse, OK_STATUS, sampleRow } from './testing.ts';

const orderId = '1234567890';
const msg = JSON.stringify({ action: 'CTL01', ext: { title: '订单咨询通知', desc: '订单详情页', extendInfo: { providerProductName: '备注产品' }, dataInfoList: [
  { Id: 'orderid', text: orderId }, { Id: 'productName', text: '完整产品名称' }, { Id: 'usedate', text: '2026/11/03' }, { Id: 'orderamout', text: '18.52' }, { Id: 'platformName', text: 'Trip-App' },
] } });
const response = (privilege: unknown = true, source: unknown = { msg }) => ({ ResponseStatus: OK_STATUS, data: { sourceTraceInfo: { hasSourceTracePrivilege: privilege, lastSourceTrace: source } } });

test('official source read maps all sidebar fields with a matching string order and privilege', async () => {
  const deps = makeDeps(() => jsonResponse(response()));
  const result = await fetchOrderSource(deps, new SoaClient(deps), 'g', orderId);
  assert.equal(result.kind, 'order');
  if (result.kind !== 'order') return;
  const order = result.order;
  assert.equal(order?.order_id, orderId);
  assert.equal(order?.product, '完整产品名称');
  assert.equal(order?.use_date, '2026/11/03');
  assert.equal(order?.total_amount, '18.52');
  assert.equal(order?.remark_name, '备注产品');
  const request = deps.fakeFetch.calls[0]!;
  assert.ok(request.url.includes('/15529/getVbkImUserinfo'));
  const body = request.bodyJson as Record<string, any>;
  assert.equal(body.gid, 'g'); assert.equal(body.locale, 'zh-CN');
  assert.equal(body.head.cver, '1.0'); assert.deepEqual(body.head.extension, []);
});

test('source read refuses denied/missing privilege, malformed cards, wrong orders and HTTP failures', async () => {
  for (const body of [response(null), response(true, { msg: 'invalid' }), response(true, []), { ResponseStatus: OK_STATUS, data: { sourceTraceInfo: { hasSourceTracePrivilege: true } } }]) {
    const deps = makeDeps(() => jsonResponse(body));
    assert.deepEqual(await fetchOrderSource(deps, new SoaClient(deps), 'g', orderId), { kind: 'unavailable' });
  }
  const deps = makeDeps(() => jsonResponse(response()));
  assert.deepEqual(await fetchOrderSource(deps, new SoaClient(deps), 'g', '9999999999'), { kind: 'unavailable' });
  const failed = makeDeps(() => jsonResponse({}, 403));
  assert.deepEqual(await fetchOrderSource(failed, new SoaClient(failed), 'g', orderId), { kind: 'unavailable' });
  const denied = makeDeps(() => jsonResponse(response(false)));
  assert.deepEqual(await fetchOrderSource(denied, new SoaClient(denied), 'g', orderId), { kind: 'denied' });
  for (const empty of [null, {}]) {
    const deps = makeDeps(() => jsonResponse(response(true, empty)));
    assert.deepEqual(await fetchOrderSource(deps, new SoaClient(deps), 'g', orderId), { kind: 'empty' });
  }
});

test('official source survives old/sparse history and is fenced by service revision and order', async () => {
  const deps = makeDeps(() => jsonResponse(response()));
  const result = await fetchOrderSource(deps, new SoaClient(deps), 'g', orderId);
  assert.equal(result.kind, 'order'); if (result.kind !== 'order') return; const order = result.order;
  const store = new ConversationStore(); store.update([sampleRow('g')]);
  const revision = store.messageContext('g');
  store.noteOrder('g', { ...order, product: '旧产品', use_date: '', total_amount: '' }, 100);
  store.noteSourceOrder('g', order, revision, 200);
  assert.equal(store.order('g')?.product, '完整产品名称'); assert.equal(store.order('g')?.total_amount, '18.52');
  store.noteOrder('g', { ...order, product: '新产品', use_date: '', total_amount: '' }, 300);
  assert.equal(store.order('g')?.product, '新产品'); assert.equal(store.order('g')?.total_amount, '18.52');
  store.noteSourceOrder('g', { ...order, product: '旧请求结果' }, revision, 150);
  assert.equal(store.order('g')?.product, '新产品');
  store.update([sampleRow('g', { sessionId: 'successor', lastMessageTime: 1700000000400 })]);
  assert.equal(store.order('g'), null);
  store.noteSourceOrder('g', order, revision, 500);
  assert.equal(store.order('g'), null, 'old service read cannot bind to the successor');
  store.noteSourceOrder('g', { ...order, order_id: '9999999999' }, store.messageContext('g'), 500);
  assert.equal(store.order('g'), null);
});

test('authorized source establishes a missing row order and rotates query revision whenever its order changes', async () => {
  const deps = makeDeps(() => jsonResponse(response()));
  const result = await fetchOrderSource(deps, new SoaClient(deps), 'g', null);
  assert.equal(result.kind, 'order'); if (result.kind !== 'order') return; const order = result.order;
  const store = new ConversationStore(); store.update([sampleRow('g', { relationOrderId: null, ext: {} })]);
  const revision = store.messageContext('g');
  const token = () => store.assistantContextRevision('g', 'self', 'g@room');
  const empty = token(); assert.equal(store.orderId('g'), null);
  store.noteSourceOrder('g', order, revision, 200);
  assert.equal(store.orderId('g'), orderId); assert.equal(store.order('g')?.total_amount, '18.52');
  const first = token(); assert.notEqual(first, empty);
  store.noteSourceOrder('g', { ...order, order_id: '9999999999' }, revision, 300);
  assert.equal(store.orderId('g'), '9999999999'); assert.notEqual(token(), first);
  store.noteSourceOrder('g', order, revision, 250);
  assert.equal(store.orderId('g'), '9999999999', 'late earlier read cannot restore the previous order');
  store.noteOrder('g', { ...order, product: 'delayed old order' }, 400);
  assert.equal(store.order('g')?.order_id, '9999999999');
  const oldRead = store.beginSourceRead('g'), newRead = store.beginSourceRead('g');
  store.noteSourceOrder('g', { ...order, order_id: '8888888888' }, revision, 500, newRead);
  store.noteSourceOrder('g', order, revision, 500, oldRead);
  assert.equal(store.order('g')?.order_id, '8888888888', 'same-millisecond older request cannot replace the latest source');
});

for (const hasRowId of [false, true]) test(`current explicit denial clears all cached source/card fields and query revision (row identity ${hasRowId})`, () => {
  const store = new ConversationStore(); store.update([sampleRow('g', hasRowId ? {} : { relationOrderId: null, ext: {} })]);
  const order: UiOrderSummary = { order_id: orderId, product: 'restricted product', total_amount: '18.52', use_date: '2026/11/03', quantity: '', status: '', contact: '' };
  const revision = store.messageContext('g'); const token = () => store.assistantContextRevision('g', 'self', 'g@room');
  const initialRead = store.beginSourceRead('g');
  store.noteSourceOrder('g', order, revision, 100, initialRead); store.noteOrder('g', order, 150); const before = token();
  const deniedRead = store.beginSourceRead('g'); assert.equal(store.denySourceOrder('g', revision, deniedRead), true);
  assert.equal(store.order('g'), null); assert.equal(store.orderId('g'), hasRowId ? orderId : null); assert.notEqual(token(), before);
  store.noteOrder('g', order, 250); assert.equal(store.order('g'), null, 'late history cannot restore restricted fields');
  const successRead = store.beginSourceRead('g'); store.noteSourceOrder('g', order, revision, 300, successRead);
  assert.equal(store.denySourceOrder('g', revision, deniedRead), false); assert.equal(store.order('g')?.product, order.product);
});

test('product consultation without an order retains the official source without creating an order identity', async () => {
  const productMsg = JSON.stringify({ action: 'CTL01', ext: { title: '產品查詢通知', desc: '客戶從門票 / 體驗資料填寫頁面查詢', dataInfoList: [
    { title: '來源渠道', text: 'H5' }, { title: '客戶語言', text: 'zh-HK' }, { title: '產品 ID', text: '116063167' },
    { title: '產品名稱', text: '示例 eSIM' }, { title: '產品價格', text: 'CNY2' },
  ] } });
  const deps = makeDeps(() => jsonResponse(response(true, { msg: productMsg })));
  const result = await fetchOrderSource(deps, new SoaClient(deps), 'g', null);
  assert.equal(result.kind, 'order'); if (result.kind !== 'order') return;
  assert.equal(result.order.product, '示例 eSIM'); assert.equal(result.order.product_id, '116063167');
  assert.equal(result.order.customer_language, 'zh-HK'); assert.equal(result.order.product_price, 'CNY2');
  const store = new ConversationStore(); store.update([sampleRow('g', { relationOrderId: null, ext: {} })]);
  store.noteSourceOrder('g', result.order, store.messageContext('g'), 100);
  assert.equal(store.order('g')?.product, '示例 eSIM'); assert.equal(store.orderId('g'), null);
  assert.deepEqual(await fetchOrderSource(deps, new SoaClient(deps), 'g', orderId), { kind: 'unavailable' });
});
