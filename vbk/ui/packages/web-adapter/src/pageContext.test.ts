import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createContextSniffer, createPageRequestObserver, installContextHooks, type ObservedRequest, type RequestTiming } from './pageContext.ts';
import { OK_STATUS, flush } from './testing.ts';

test('existing fetch hook captures three official request/response paths without consuming the original response', async () => {
  const paths = ['16037/getConversationList', '16037/getRemarkList', '16037/getConversationInfoByGidList'];
  const events: ObservedRequest[] = [];
  const timings: RequestTiming[] = [];
  const observer = createPageRequestObserver(() => 10, record => timings.push(record));
  observer.subscribe(event => events.push(event));
  const originals: Response[] = [];
  const seenThis: unknown[] = [];
  const win = { fetch: function(this: unknown) { seenThis.push(this); const res = new Response(JSON.stringify({ ResponseStatus: OK_STATUS, conversationList: [] })); originals.push(res); return Promise.resolve(res); } };
  installContextHooks(win, createContextSniffer(), observer);
  for (const path of paths) {
    const result = await win.fetch.call(win, `https://m.ctrip.com/restapi/soa2/${path}?ticket=secret`, { body: '{"head":{"cid":"c","sid":"s"}}' });
    assert.equal(result, originals.at(-1));
    assert.equal(result.bodyUsed, false);
    await result.json();
    await flush();
  }
  // Response.clone().text() uses stream tasks; allow the native streams to settle.
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events.filter(e => e.phase === 'request').map(e => e.path), paths);
  assert.deepEqual(events.filter(e => e.phase === 'response').map(e => e.path), paths);
  for (const event of events.filter(e => e.phase === 'response')) {
    assert.equal(event.outcome?.kind, 'success');
    assert.ok(events.findIndex(e => e.id === event.id && e.phase === 'request') < events.indexOf(event));
  }
  assert.equal(seenThis.every(value => value === win), true);
  assert.equal(JSON.stringify(timings).includes('secret'), false);
  assert.equal(JSON.stringify(timings).includes('ResponseStatus'), false);
});

test('observer rejects foreign origins and categorizes the actual live-capture paths', () => {
  const observer = createPageRequestObserver(() => 1);
  assert.equal(observer.begin('https://m.ctrip.com.evil/restapi/soa2/16037/getConversationList', '{}', 'official'), null);
  assert.equal(observer.begin('http://m.ctrip.com/restapi/soa2/16037/getConversationList', '{}', 'official'), null);
  assert.equal(observer.begin('https://m.ctrip.com:8443/restapi/soa2/16037/getConversationList', '{}', 'official'), null);
  for (const path of ['15529/getSessionEmpathyPhraseInfo', '11679/batchTranslateByMsgIds', '15529/queryToken', '14735/getOrderDetailsForVbk', '11679/PutAdviceOfReadByMsgId.json']) assert.equal(observer.begin(`https://m.ctrip.com/restapi/soa2/${path}`, '{}', 'official')?.path, path);
  assert.equal(observer.begin('https://s.c-ctrip.com/bee/collect?ticket=secret', '{}', 'official')?.path, 'telemetry');
});

test('observer errors cannot break page fetch, and non-clone responses release the official loop lease', async () => {
  const observer = createPageRequestObserver(() => 1, () => { throw new Error('listener failure'); });
  observer.subscribe(() => { throw new Error('consumer failure'); });
  const response = { status: 200, text: async () => '{}' };
  const promise = Promise.resolve(response);
  const win = { fetch: () => promise };
  installContextHooks(win, createContextSniffer(), observer);
  assert.equal(win.fetch('https://m.ctrip.com/restapi/soa2/16037/getConversationList', { body: '{}' }), promise);
  await flush();
  assert.equal(observer.lastOfficial('16037/getConversationList'), null);
});
