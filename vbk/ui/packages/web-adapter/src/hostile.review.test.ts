/**
 * Review: hostile inputs across the public API (hunt items 6, 12). No call
 * here may throw; it must return a `failed`/`malformed`/empty outcome.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SoaClient } from './soa.ts';
import { fetchHistoryPage, type HistoryCursor } from './history.ts';
import { UNKNOWN_ROLES } from './facts.ts';
import { toConversationFact, type ConversationListItem } from './conversationList.ts';
import { translateMessages } from './translation.ts';
import { getAgentWorkingSchedule, getCustomerScripts, getVenAgentByUid, listNoticeReceiveConfig, syncVenAgentInfo, venOptionValue } from './settings.ts';
import { numericGid, setWorkSheetStar } from './worksheetStar.ts';
import { searchConversationByOrder } from './order.ts';
import { markRead } from './markRead.ts';
import { OK_STATUS, jsonResponse, makeDeps } from './testing.ts';

const req = { gid: 'g', conversationType: 'B2C', pageSize: 2 };

test('review/hostile: history pager — rangeMessage null/str/missing, messages null/[null], isDone non-boolean, non-JSON body', async () => {
  const bodies: unknown[] = [
    { ResponseStatus: OK_STATUS, rangeMessage: null },
    { ResponseStatus: OK_STATUS, rangeMessage: 'x' },
    { ResponseStatus: OK_STATUS },
    { ResponseStatus: OK_STATUS, rangeMessage: { messages: null } },
    { ResponseStatus: OK_STATUS, rangeMessage: { messages: [null, 1, 'x', [], {}, { msgId: 'ok', createTime: 1700000000100, msgtype: 0 }], isDone: 'true', lastMessageTime: 'abc' } },
    { ResponseStatus: OK_STATUS, messages: [{ msgId: 'TOP', createTime: 1700000000100 }] },
    'not json',
    'null',
  ];
  const deps = makeDeps((_, i) => jsonResponse(bodies[i]));
  const soa = new SoaClient(deps);
  const out: string[] = [];
  for (let i = 0; i < bodies.length; i++) {
    const r = await fetchHistoryPage(deps, soa, req, UNKNOWN_ROLES);
    if (r.kind === 'page') out.push(`page:${r.page.facts.map((f) => f.message_id).join(',')}:${r.page.isDone}:${r.page.lastMessageTime}`);
    else if (r.kind === 'failed') out.push(`failed:${r.outcome.kind}`);
    else out.push(r.kind);
  }
  assert.deepEqual(out, ['page::false:null', 'page::false:null', 'page::false:null', 'page::false:null', 'page:ok:false:null', 'page::false:null', 'failed:malformed', 'failed:malformed']);
  // cursors: only 13-digit integers; direction decides the field
  for (const c of [{ direction: 'prev', endTime: '1700000000000' }, { direction: 'next', beginTime: 1e13 }, { direction: 'prev', endTime: Number.NaN }, { direction: 'next', beginTime: -1 }, { direction: 'prev', endTime: null }]) {
    const r = await fetchHistoryPage(deps, soa, { ...req, cursor: c as unknown as HistoryCursor }, UNKNOWN_ROLES);
    assert.deepEqual(r, { kind: 'invalid_cursor' }, JSON.stringify(c));
  }
  assert.equal(deps.fakeFetch.calls.length, bodies.length, 'invalid cursors never reach the network');
});

test('review/hostile: conversation row mapping never throws and defaults are the conservative ones', () => {
  for (const evil of [null, undefined, 1, 'x', [], {}, { gid: 5 }, { gid: '' }]) assert.equal(toConversationFact(evil as unknown as ConversationListItem, true), null, String(evil));
  const f = toConversationFact({ gid: 'g', status: '2', inGroup: '1', isOwner: 1, serviceType: 1513, lastMessageTime: '1700000000', lastUpdateTime: {} }, false, { unreadOf: () => Number.NaN as unknown as number });
  assert.deepEqual(f, { gid: 'g', status: 'unknown', agent_in_group: false, is_owner: false, service_type: '1513', last_message_time_ms: 1700000000000, last_update_time_ms: null, unread_count: Number.NaN, is_full_snapshot: false });
});

test('review/hostile: translation, settings, worksheet star, search, mark-read tolerate junk', async () => {
  const deps = makeDeps((_, i) => {
    const bodies: unknown[] = [
      { ResponseStatus: OK_STATUS, translateMessageList: [null, 1, { msgId: 1 }, { msgId: 'a', messageBody: null }, { msgId: 'b', messageBody: 't', msgtype: '0' }] },
      { ResponseStatus: OK_STATUS, configList: [null, 1, { noticeCategoryCode: 7, noticeValueList: [1, 'x', null] }] },
      { ResponseStatus: OK_STATUS, bizResponseStatus: { resultCode: 'SUCCESS' }, workingSchedule: null },
      { ResponseStatus: OK_STATUS, venAgent: 'x', venAgentOption: { agentOption: { venOptionList: [null, { optionCode: 'automatic_translation', optionValue: 7 }, { code: 'k', optionValue: 'Y' }] } } },
      { ResponseStatus: OK_STATUS, bizResponseStatus: null },
      { ResponseStatus: OK_STATUS, bizResponseStatus: { resultCode: 'success' } },
      { ResponseStatus: OK_STATUS, bizResponseStatus: { resultCode: 'SUCCESS' }, customerSearchList: [null, 1, { conversation: null }, { conversation: { gid: 1 } }, { conversation: { gid: 'ok', status: '4', inGroup: '1' } }] },
      { ResponseStatus: OK_STATUS, customerScripts: [null, 1, { a: 1 }] },
      { ResponseStatus: OK_STATUS },
      { ResponseStatus: OK_STATUS, venAgent: null },
    ];
    return jsonResponse(bodies[i]);
  });
  const soa = new SoaClient(deps);
  const t = await translateMessages(deps, soa, { sessionId: 's', groupId: 'g', bizType: 1513, messageIdList: ['a', 'b', 'c'], target: 'en' });
  assert.equal(t.kind, 'translated');
  if (t.kind === 'translated') {
    assert.deepEqual([...t.byMsgId.keys()], ['b']);
    assert.deepEqual(t.missing, ['a', 'c']);
    assert.equal(t.byMsgId.get('b')?.msgtype, null);
  }
  const n = await listNoticeReceiveConfig(deps, soa);
  assert.equal(n.kind, 'ok');
  if (n.kind === 'ok') assert.deepEqual(n.value, [{ noticeCategoryCode: '', noticeCategoryName: '', noticeValueList: ['x'] }]);
  const ws = await getAgentWorkingSchedule(deps, soa, 'u');
  assert.equal(ws.kind, 'ok');
  if (ws.kind === 'ok') assert.deepEqual(ws.value.days, { sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] });
  const va = await getVenAgentByUid(deps, soa);
  assert.equal(va.kind, 'ok');
  if (va.kind === 'ok') {
    assert.equal(va.value.venAgent, null);
    assert.equal(venOptionValue(va.value, 'automatic_translation'), null);
    assert.equal(venOptionValue(va.value, 'k'), 'Y');
    assert.equal(venOptionValue({ venAgent: null, venAgentOption: null }, 'k'), null);
  }
  const star1 = await setWorkSheetStar(deps, soa, { sessionId: 's', groupId: 1, worksheetId: 2, action: 1 });
  assert.equal(star1.applied, false);
  if (!star1.applied) assert.equal(star1.reason, 'biz_failure');
  const star2 = await setWorkSheetStar(deps, soa, { sessionId: 's', groupId: 1, worksheetId: 2, action: 0 });
  assert.equal(star2.applied, false, 'lowercase success is not SUCCESS');
  const sc = await searchConversationByOrder(deps, soa, '1', 3);
  assert.deepEqual(sc, { kind: 'hits', hits: [{ gid: 'ok', sessionId: null, status: 'unknown', serviceType: null, inGroup: null, conversationType: null, threadId: null }] });
  const cs = await getCustomerScripts(deps, soa, 'c');
  assert.equal(cs.kind, 'ok');
  if (cs.kind === 'ok') assert.deepEqual(cs.value, [{ a: 1 }]);
  const sync = await syncVenAgentInfo(deps, soa);
  assert.equal(sync.kind, 'synced');
  assert.equal(deps.fakeFetch.calls.length, 10, 'sync wrote once and read back once');
  for (const g of ['', 'abc', '1'.repeat(16), '-1', '1.5', ' 1']) assert.equal(numericGid(g), null, g);
  assert.equal(numericGid('123'), 123);

  deps.fakeSdk.putAdviceOfReadByMsgId = () => Promise.reject(new Error('sdk'));
  assert.deepEqual(await markRead(deps.fakeSdk, { partnerJid: 'p', msgId: 'm' }), { kind: 'unknown' });
  assert.deepEqual(await markRead(deps.fakeSdk, { partnerJid: '', msgId: 'm' }), { kind: 'failed', raw: 'empty target' });
});
