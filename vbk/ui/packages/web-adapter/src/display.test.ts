import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentStatusOf, colorOf, httpMessageToUi, langOf, messageText, orderSummaryFromMessage, previewOf, rowView, sdkMessageToUi, toDisplayConversation, uiKindOf } from './display.ts';
import { stanzaToEvent, mapXmppStatus, readElement } from './sdkGlue.ts';
import { buildPageContext, createContextSniffer, localeFromSearch, readCookie } from './pageContext.ts';
import { UNKNOWN_ROLES } from './facts.ts';
import { ConversationStore, RoleBook, roomJidFromMessage } from './stores.ts';
import { normalizeHttpMessage } from './facts.ts';
import { sampleRow } from './testing.ts';

test('display: conversation row → DisplayConversation', () => {
  const d = toDisplayConversation(sampleRow('g1') as never, true, { unreadOf: () => 3 });
  assert.ok(d);
  assert.equal(d.gid, 'g1');
  assert.equal(d.title, 'Title g1');
  assert.equal(d.lang, 'en');
  assert.equal(d.biz, '门票活动');
  assert.equal(d.preview, 'hello there');
  assert.equal(d.mark, 2);
  assert.equal(d.unread_count, 3);
  assert.equal(d.status, 'active');
  assert.equal(d.is_full_snapshot, true);
  assert.equal(d.order?.order_id, '1234567890');
  assert.equal(d.color, colorOf('g1'));
  assert.deepEqual(d.customer_tags, []);
  for (const k of ['account', 'waiting_since_ms', 'waiting_confirmed', 'is_top', 'draft']) assert.equal(k in d, false, k);
});

test('display: row view carries the fields RPC needs; junk rows are skipped', () => {
  const v = rowView(sampleRow('g2') as never);
  assert.ok(v);
  assert.equal(v.sessionId, 'sess-g2');
  assert.equal(v.worksheetId, 9001);
  assert.equal(v.serviceType, '1513');
  assert.equal(v.threadId, '');
  assert.equal(v.conversationType, 'B2C');
  assert.equal(v.customerUid, 'cust-g2');
  assert.equal(v.lastMessage?.msgId, 'm-g2');
  assert.equal(rowView(null as never), null);
  assert.equal(rowView({ gid: '' } as never), null);
  assert.equal(toDisplayConversation({ gid: 5 } as never, false), null);
});

test('display: language, kinds, previews and media text', () => {
  assert.equal(langOf({ languageInfo: { lang: 'zh_HK' } } as never), 'zh');
  assert.equal(langOf({ languageInfo: { lang: '' }, ext: { locale: 'ja_JP' } } as never), 'ja');
  assert.equal(langOf({} as never), 'zh');
  assert.equal(uiKindOf(9901), null);
  assert.equal(uiKindOf('0'), 'text');
  assert.equal(uiKindOf(1009), 'system');
  assert.equal(previewOf({ msgtype: 1, messageBody: '{"url":"https://x/a.png"}' }), '[图片]');
  assert.equal(previewOf({ msgtype: 5, messageBody: JSON.stringify({ btype: 5, file: { filename: 'a.pdf', url: 'u', size: 1 } }) }), '[文件] a.pdf');
  assert.equal(messageText(1, '{"url":"https://x/a.png","thumbUrl":"t"}'), 'https://x/a.png');
  assert.equal(messageText(1009, JSON.stringify({ title: '撤回了一条消息', code: 2 })), '撤回了一条消息');
  assert.equal(messageText(1, 'not json'), '');
  assert.equal(previewOf(null), '');
});

test('display: HTTP and SDK messages → UiMessage with roles', () => {
  const roles = new RoleBook('me');
  roles.addCustomer('cust-1');
  const ui = httpMessageToUi({ msgId: 'm1', messageBody: 'hi', fromJid: 'cust-1@im.x', toJid: 'g1@conf.x', createTime: 1700000000123, msgtype: 0 }, roles);
  assert.equal(ui?.gid, 'g1');
  assert.equal(ui?.sender_role, 'customer');
  assert.equal(ui?.text, 'hi');
  assert.equal(ui?.disposition, null);
  assert.equal(httpMessageToUi({ msgtype: 9901, createTime: 1700000000123, toJid: 'g1@c' }, roles), null);
  const s = sdkMessageToUi({ id: 's1', type: 'groupchat', msgtype: '0', create_time: '1700000000555', from: 'g7@conf.x/cust-1', to: 'me@x', body: 'yo' }, roles);
  assert.equal(s?.gid, 'g7');
  assert.equal(s?.sender_role, 'customer');
  assert.equal(sdkMessageToUi({ type: 'input_state', msgtype: '9901', from: 'g7@c/x', create_time: '1700000000555' }, UNKNOWN_ROLES), null);
});

test('display: agent status enum IDLE=0..GETOFF=3', () => {
  assert.equal(agentStatusOf(0), 'online');
  assert.equal(agentStatusOf('1'), 'hangup');
  assert.equal(agentStatusOf(2), 'leaving');
  assert.equal(agentStatusOf(3), 'getoff');
  assert.equal(agentStatusOf(4), null);
  assert.equal(agentStatusOf(null), null);
});

test('display: uid decides identity while member nick/avatar and media data survive conversion', () => {
  const roles = new RoleBook('me');
  roles.addCustomer('customer');
  roles.addMembers([
    { uid: 'me', nick: '门票活动旅游管家Meru', avatar: 'https://example.com/me.png', roles: [3, 4, 4] },
    { uid: 'customer', nick: '门票活动旅游管家Meru', avatar: 'https://example.com/customer.png', roles: [0, 1, 0] },
    { username: 'former-agent', nickName: 'Former merchant', avatar: 'https://example.com/former.png', roles: [0, 3, 4] },
  ]);
  const row = { msgId: 'm', fromJid: 'customer@x', toJid: 'g@c', createTime: 1700000000123, msgtype: 5, messageBody: JSON.stringify({ file: { filename: 'ticket.pdf', url: 'https://example.com/ticket.pdf' } }) };
  const customer = httpMessageToUi(row, roles);
  assert.equal(customer?.sender_role, 'customer');
  assert.equal(customer?.sender_id, 'customer');
  assert.equal(customer?.sender_name, '门票活动旅游管家Meru');
  assert.equal(customer?.sender_avatar, 'https://example.com/customer.png');
  assert.equal(customer?.media_filename, 'ticket.pdf');
  assert.equal(customer?.media_url, 'https://example.com/ticket.pdf');
  const self = httpMessageToUi({ ...row, fromJid: 'me@x' }, roles);
  assert.equal(self?.sender_role, 'merchant_self');
  assert.equal(roles.roleOf('former-agent'), 'merchant_other');
  assert.equal(roles.profileOf('former-agent').name, 'Former merchant');
  assert.deepEqual(self?.disposition, { kind: 'confirmed', server_message_id: 'm', server_time_ms: 1700000000123 });
  assert.equal(sdkMessageToUi({ type: 'chat', id: 's', from: 'me@x', to: 'g@x', create_time: 1700000000123, msgtype: 0, body: 'hi' }, roles)?.sender_id, 'me');
});

test('display: captured HTTP room/sender shape routes to the room and hides non-present control frames', () => {
  const roles = new RoleBook('self');
  const message = { msgId: 'server', fromJid: 'group@muc.im.ctrip.com/self', toJid: 'self@im.ctrip.com', createTime: 1700000000000, msgtype: 0, messageBody: 'text', isTargetRead: true };
  const ui = httpMessageToUi(message, roles);
  assert.equal(ui?.gid, 'group');
  assert.equal(ui?.sender_id, 'self');
  assert.equal(ui?.read_status, 'read');
  assert.equal(roomJidFromMessage('group', message), 'group@muc.im.ctrip.com');
  assert.equal(normalizeHttpMessage(message, { roles, source: 'compensation' })?.gid, 'group');
  const hidden = { ...message, msgtype: 1007, messageBody: JSON.stringify({ title: 'session_status', isPresent: false, action: 'NBZ109' }) };
  assert.equal(httpMessageToUi(hidden, roles), null);
  assert.equal(previewOf(hidden), '');
  assert.equal(sdkMessageToUi({ type: 'groupchat', from: message.fromJid, to: message.toJid, create_time: message.createTime, msgtype: 1007, body: hidden.messageBody }, roles), null);
  const recall = httpMessageToUi({ ...message, msgtype: 1009, messageBody: JSON.stringify({ title: '消息撤回', isPresent: true, recallMessageId: 'server' }) }, roles);
  assert.equal(recall?.recalled_message_id, 'server');
});

test('display: CTL01 enriches only the matching current order and newer cards win', () => {
  const store = new ConversationStore();
  store.update([sampleRow('g')]);
  const card = { msgtype: 7, messageBody: JSON.stringify({ action: 'CTL01', ext: { title: '订单咨询通知', desc: '订单详情页', dataInfoList: [
    { Id: 'orderid', text: '1234567890' }, { Id: 'productName', text: 'eSIM' }, { Id: 'usedate', text: '2026/10/28' }, { Id: 'platformName', text: 'Trip-App' }, { Id: 'orderamout', text: '18.52' },
  ] } }) };
  const order = orderSummaryFromMessage(card);
  assert.ok(order);
  assert.equal(order.source_channel, 'Trip-App');
  assert.equal(order.total_amount, '18.52');
  assert.equal(order.source_description, '订单详情页');
  store.noteOrder('g', order, 200);
  store.noteOrder('g', { ...order, product: 'stale' }, 100);
  store.noteOrder('g', { ...order, order_id: '9999999', product: 'wrong order' }, 300);
  assert.equal(store.order('g')?.product, 'eSIM');
  const message = httpMessageToUi({ ...card, fromJid: 'g@room/customer', createTime: 1700000000000, msgId: 'c' }, UNKNOWN_ROLES);
  assert.equal(message?.kind, 'order_card');
  assert.equal(message?.order_id, order.order_id);
  assert.equal(message?.text, 'eSIM');
});

function el(name: string, attrs: Record<string, string>, body: string | null) {
  return { name, attrs, getChildText: (n: string) => (n === 'body' ? body : null) };
}

test('glue: xmpp stanzas → SDK events (room jid in from, send_result body, acks ignored)', () => {
  const m = stanzaToEvent(el('message', { type: 'groupchat', id: 'srv', localid: 'l1', msgtype: '0', create_time: '1700000000555', from: 'g9@conf.x', to: 'me@x' }, 'text'));
  assert.equal(m.kind, 'message');
  if (m.kind === 'message') {
    assert.equal(m.roomJid, 'g9@conf.x');
    assert.equal(m.event.to, 'g9@conf.x');
    assert.equal(m.event.body, 'text');
  }
  const r = stanzaToEvent(el('message', { type: 'send_result', id: 'l1' }, JSON.stringify({ error: 0, tid: 't1', create_time: '1700000000600' })));
  assert.equal(r.kind, 'send_result');
  if (r.kind === 'send_result') assert.equal(r.event.localid, 'l1');
  assert.equal(stanzaToEvent(el('message', { type: 'notify_ack', id: 'x' }, null)).kind, 'ignore');
  assert.equal(stanzaToEvent(el('iq', { type: 'result' }, null)).kind, 'ignore');
  assert.equal(stanzaToEvent(el('message', { type: 'send_result' }, 'not json')).kind, 'ignore');
  assert.equal(stanzaToEvent(null).kind, 'ignore');
  assert.equal(readElement({ name: 'message', attrs: {}, children: [{ name: 'body', children: ['a', 'b'] }] })?.body, 'ab');
  assert.equal(mapXmppStatus('online'), 'connected');
  assert.equal(mapXmppStatus('opening'), 'connecting');
  assert.equal(mapXmppStatus('weird'), 'disconnected');
});

test('page context: sniffed head cid/sid + _fxpcqlniredt; cookie fallback for cid only; locale from ?lang', () => {
  const sn = createContextSniffer();
  sn.observe('https://m.ctrip.com/restapi/soa2/16037/getConversationList?_fxpcqlniredt=CID-1&x-traceID=CID-1-1-2', JSON.stringify({ head: { cid: 'C1', sid: 'S1' } }));
  sn.observe('https://other.example/api', JSON.stringify({ head: { cid: 'EVIL', sid: 'EVIL' } }));
  sn.observe('https://m.ctrip.com/restapi/soa2/x', '{{not json');
  assert.deepEqual(sn.snapshot(), { cid: 'C1', sid: 'S1', clientId: 'CID-1' });
  const ok = buildPageContext(sn.snapshot(), 'GUID=G; other=1', '?currentTab=BC&lang=en-US');
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.context.cid, 'C1');
    assert.equal(ok.context.locale, 'en-US');
  }
  const noSid = buildPageContext({ cid: null, sid: null, clientId: null }, 'GUID=G', '');
  assert.deepEqual(noSid, { ok: false, missing: ['sid'] });
  assert.equal(readCookie('a=1; vbk_login_cid=V', 'vbk_login_cid'), 'V');
  assert.equal(localeFromSearch('?lang=<script>'), 'zh-CN');
});
