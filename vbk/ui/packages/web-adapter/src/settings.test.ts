import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SoaClient } from './soa.ts';
import { getAgentWorkingSchedule, getVenAgentByUid, listNoticeReceiveConfig, syncVenAgentInfo, venOptionValue } from './settings.ts';
import { translateMessages } from './translation.ts';
import { OK_STATUS, jsonResponse, makeDeps } from './testing.ts';

test('listNoticeReceiveConfig reads configList loosely', async () => {
  const deps = makeDeps(() => jsonResponse({ ResponseStatus: OK_STATUS, configList: [{ noticeCategoryCode: 'c1', noticeCategoryName: '{{n}}', imgUrl: 'u', noticeValueList: ['a', 1] }, 'junk'] }));
  const r = await listNoticeReceiveConfig(deps, new SoaClient(deps));
  assert.equal(r.kind, 'ok');
  if (r.kind === 'ok') assert.deepEqual(r.value, [{ noticeCategoryCode: 'c1', noticeCategoryName: '{{n}}', noticeValueList: ['a'] }]);
  assert.deepEqual(deps.fakeFetch.calls[0]?.bodyJson && Object.keys(deps.fakeFetch.calls[0].bodyJson as object), ['scene', 'head']);
  assert.equal((deps.fakeFetch.calls[0]?.bodyJson as { scene: string }).scene, 'vbk_notice_h5');
});

test('getAgentWorkingSchedule requires biz SUCCESS and sends locale + venAgentUid', async () => {
  const deps = makeDeps((_, i) =>
    i === 0
      ? jsonResponse({ ResponseStatus: OK_STATUS, bizResponseStatus: { resultCode: 'SUCCESS' }, workingSchedule: { venAgentUid: '{{uid}}', timeZone: 'Asia/Singapore', fri: ['09:00-18:00'], offdays: [] } })
      : jsonResponse({ ResponseStatus: OK_STATUS, bizResponseStatus: { resultCode: 'UNKNOWN' } }),
  );
  const soa = new SoaClient(deps);
  const r = await getAgentWorkingSchedule(deps, soa, '{{uid}}');
  assert.equal(r.kind, 'ok');
  if (r.kind === 'ok') {
    assert.equal(r.value.timeZone, 'Asia/Singapore');
    assert.deepEqual(r.value.days.fri, ['09:00-18:00']);
    assert.deepEqual(r.value.days.mon, []);
  }
  assert.deepEqual(deps.fakeFetch.calls[0]?.bodyJson && Object.keys(deps.fakeFetch.calls[0].bodyJson as object), ['head', 'locale', 'venAgentUid']);
  assert.equal((await getAgentWorkingSchedule(deps, soa, 'u')).kind, 'biz_failure');
});

test('getVenAgentByUid + option accessor; syncVenAgentInfo reads back', async () => {
  const deps = makeDeps((call) => {
    if (call.url.includes('syncVenAgentInfo')) return jsonResponse({ ResponseStatus: OK_STATUS });
    return jsonResponse({ ResponseStatus: OK_STATUS, venAgent: { uid: '{{uid}}' }, venAgentOption: { agentOption: { venOptionList: [{ optionCode: 'automatic_translation', optionValue: 'Y' }] } } });
  });
  const soa = new SoaClient(deps);
  const r = await getVenAgentByUid(deps, soa);
  assert.equal(r.kind, 'ok');
  if (r.kind === 'ok') {
    assert.equal(venOptionValue(r.value, 'automatic_translation'), 'Y');
    assert.equal(venOptionValue(r.value, 'nope'), null);
  }
  const s = await syncVenAgentInfo(deps, soa);
  assert.equal(s.kind, 'synced');
  if (s.kind === 'synced') assert.equal(s.readback.kind, 'ok');
  assert.equal(deps.fakeFetch.calls.length, 3);
  assert.deepEqual(deps.fakeFetch.calls[1]?.bodyJson && Object.keys(deps.fakeFetch.calls[1].bodyJson as object), ['head']);
});

test('translateMessages keeps originals for ids missing from the response', async () => {
  const deps = makeDeps(() => jsonResponse({ ResponseStatus: OK_STATUS, status: { code: '0', msg: '' }, supplier: '{{supplier}}', translateMessageList: [{ msgId: 'm1', messageBody: '{{translated}}', msgtype: 0 }] }));
  const r = await translateMessages(deps, new SoaClient(deps), { sessionId: 's', groupId: 'g', bizType: 1513, messageIdList: ['m1', 'm2'], target: 'zh-CN' });
  assert.equal(r.kind, 'translated');
  if (r.kind !== 'translated') return;
  assert.deepEqual(r.missing, ['m2']);
  assert.equal(r.byMsgId.get('m1')?.messageBody, '{{translated}}');
  const body = deps.fakeFetch.calls[0]?.bodyJson as Record<string, unknown>;
  assert.deepEqual(Object.keys(body), ['head', 'source', 'target', 'sessionId', 'groupId', 'bizType', 'messageIdList']);
  assert.equal(body['source'], 'AUTO');
  assert.equal(body['bizType'], 1513);
  const empty = await translateMessages(deps, new SoaClient(deps), { sessionId: 's', groupId: 'g', bizType: 1513, messageIdList: [], target: 'zh-CN' });
  assert.equal(empty.kind, 'translated');
  assert.equal(deps.fakeFetch.calls.length, 1);
});
