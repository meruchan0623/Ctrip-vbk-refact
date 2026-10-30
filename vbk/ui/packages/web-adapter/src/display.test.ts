import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentStatusOf, colorOf, httpMessageToUi, langOf, messageText, previewOf, rowView, sdkMessageToUi, toDisplayConversation, uiKindOf } from './display.ts';
import { stanzaToEvent, mapXmppStatus, readElement } from './sdkGlue.ts';
import { buildPageContext, createContextSniffer, localeFromSearch, readCookie } from './pageContext.ts';
import { UNKNOWN_ROLES } from './facts.ts';
import { RoleBook } from './stores.ts';
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
