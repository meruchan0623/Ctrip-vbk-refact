import { test } from 'node:test';
import assert from 'node:assert/strict';
import { translateForDisplay } from './translation.ts';
import { SoaClient } from './soa.ts';
import { makeDeps, jsonResponse, OK_STATUS } from './testing.ts';

const view = { gid: 'g', sessionId: 'session', serviceType: '1513', chatType: 'groupchat' };
const agent = (value: string | null) => jsonResponse({ ResponseStatus: OK_STATUS, venAgentOption: value === null ? {} : {
  serviceTypeOptionList: [{ ownerCode: '1513', venOptionList: [{ optionCode: 'translate_message', optionValue: value }] }],
} });
const isAgent = (url: string) => url.includes('getVenAgentByUid');

test('official request shape and one explicit answer per requested ID', async () => {
  const deps = makeDeps(call => {
    if (isAgent(call.url)) return agent('Y');
    const body = call.bodyJson as Record<string, unknown>;
    assert.deepEqual(Object.keys(body), ['head', 'source', 'target', 'chatType', 'sessionId', 'groupId', 'bizType', 'appId', 'messageIdList']);
    assert.equal(body.source, 'AUTO'); assert.equal(body.target, 'zh-CN'); assert.equal(body.chatType, 'groupchat');
    assert.equal(body.sessionId, 'session'); assert.equal(body.groupId, 'g'); assert.equal(body.bizType, 1513); assert.equal(body.appId, '100017720');
    assert.deepEqual(body.messageIdList, ['a', 'same-lang', 'notice', 'card', 'blank', 'absent']);
    return jsonResponse({ ResponseStatus: OK_STATUS, status: { code: '0', msg: '' }, supplier: '携程', translateMessageList: [
      { msgId: 'a', msgtype: 0, messageBody: '您好' },
      { msgId: 'same-lang', msgtype: 0, messageBody: '原文' },
      { msgId: 'notice', msgtype: 1007, messageBody: JSON.stringify({ title: '请在平台内交易', action: 'NBZ42', ext: { vendorUid: 'private' } }) },
      { msgId: 'card', msgtype: 46, messageBody: '{"product":"card"}' },
      { msgId: 'blank', msgtype: 0, messageBody: '  ' },
      { msgId: 'foreign-row', msgtype: 0, messageBody: '不属于本批' },
    ], idWithTranslatedMap: { a: false, 'same-lang': true, notice: false } });
  });
  const result = await translateForDisplay(deps, new SoaClient(deps), view, ['a', 'same-lang', 'notice', 'card', 'blank', 'absent']);
  assert.ok(!('failed' in result));
  assert.equal(result.supplier, '携程');
  assert.deepEqual(result.items.map(i => [i.message_id, i.status, i.translation, i.source_kind]), [
    ['a', 'translated', '您好', 'text'],
    ['same-lang', 'translated', '原文', 'text'],
    ['notice', 'translated', '请在平台内交易', 'system'],
    ['card', 'not_needed', null, null],
    ['blank', 'missing', null, null],
    ['absent', 'missing', null, null],
  ]);
  assert.deepEqual(result.items.map(i => i.reason ?? null), [null, 'flagged', null, 'card', 'blank', 'no_row']);
});

test('a service type the agent options exclude is unsupported and sends no translation request', async () => {
  for (const options of ['N', 'other-owner'] as const) {
    const deps = makeDeps(call => {
      assert.ok(isAgent(call.url), 'no translation request');
      return options === 'N' ? agent('N') : jsonResponse({ ResponseStatus: OK_STATUS, venAgentOption: { serviceTypeOptionList: [{ ownerCode: '999', venOptionList: [] }] } });
    });
    const result = await translateForDisplay(deps, new SoaClient(deps), view, ['a']);
    assert.ok(!('failed' in result));
    assert.deepEqual(result.items, [{ message_id: 'a', status: 'unsupported', translation: null, source_kind: null, reason: 'option_off' }]);
  }
});

test('absent or unreadable agent options do not disable translation, and a good read is cached', async () => {
  for (const unreadable of [true, false]) {
    let reads = 0;
    const deps = makeDeps(call => {
      if (isAgent(call.url)) { reads++; return unreadable ? new Error('offline') : agent(null); }
      return jsonResponse({ ResponseStatus: OK_STATUS, translateMessageList: [{ msgId: 'a', msgtype: 0, messageBody: '您好' }] });
    });
    const soa = new SoaClient(deps);
    for (let i = 0; i < 2; i++) {
      const result = await translateForDisplay(deps, soa, view, ['a']);
      assert.ok(!('failed' in result));
      assert.equal(result.items[0]?.status, 'translated');
    }
    if (!unreadable) assert.equal(reads, 1);
  }
});

test('transport and business failures are reported, never presented as "no translation"', async () => {
  const offline = makeDeps(call => isAgent(call.url) ? agent('Y') : new Error('offline'));
  const failed = await translateForDisplay(offline, new SoaClient(offline), view, ['a']);
  assert.ok('failed' in failed && failed.failed.kind === 'network_error');
  const rejected = makeDeps(call => isAgent(call.url) ? agent('Y') : jsonResponse({ ResponseStatus: { Ack: 'Failure', Errors: [] } }));
  const business = await translateForDisplay(rejected, new SoaClient(rejected), view, ['a']);
  assert.ok('failed' in business && business.failed.kind === 'business_failure');
});
