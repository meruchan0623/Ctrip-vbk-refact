/**
 * I-06 request pacing: traffic classification and ledger, fetch-hook
 * observability, "consume the official conversation-list loop instead of
 * polling it", visibility gating and backoff.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AdapterFact } from '../../ipc/src/contracts.ts';
import { SoaClient, type SoaOutcome } from './soa.ts';
import { createConversationListPoller, listBackoffMs, type ConversationListResponse, type VisibilityGate } from './conversationList.ts';
import {
  classifyTrafficPath,
  conversationListVariantOf,
  createContextSniffer,
  createOfficialConversationFeed,
  createTrafficLedger,
  createTrafficTap,
  installContextHooks,
  recordAdapterFetch,
  type OfficialFeedSink,
  type TrafficLedger,
} from './pageContext.ts';
import { AUTH_FAILURE_STATUS, OK_STATUS, jsonResponse, makeDeps, type FakeDeps } from './testing.ts';

const LIST_URL = 'https://m.ctrip.com/restapi/soa2/16037/getConversationList?_fxpcqlniredt=T-1&x-traceID=a';
const row = (gid: string, extra: Record<string, unknown> = {}) => ({ gid, status: 2, inGroup: 1, lastMessageTime: 1700000000001, lastUpdateTime: 1700000000002, ...extra });
const listText = (rows: unknown[], lastUpdateTime: number, haveRest = false) => JSON.stringify({ ResponseStatus: OK_STATUS, conversationList: rows, currentStatus: 3, lastUpdateTime, haveRest });
const listBody = (startTime?: number) => JSON.stringify({ head: {}, needTodoList: 1, ...(startTime === undefined ? {} : { startTime }) });
const MIN = 60_000;

/** One round of the official page's own loop, as the hook would report it. */
function officialRound(feed: OfficialFeedSink, now: number, startTime: number | undefined, text: string | null, status = 200, url = LIST_URL): void {
  const token = feed.noteRequest(url, listBody(startTime), now);
  assert.ok(token);
  feed.noteResponse(token, status, text, now);
}

// ------------------------------------------------------------------ classification

test('classification: five counted groups, two separate classes, variants, everything else ignored', () => {
  const soa = (p: string) => `https://m.ctrip.com/restapi/soa2/${p}?_fxpcqlniredt=x`;
  assert.equal(classifyTrafficPath(soa('16037/getConversationList')), 'conversation_list');
  assert.equal(classifyTrafficPath(soa('16037/getConversationList.json')), 'conversation_list');
  assert.equal(classifyTrafficPath(soa('16037/getRemarkList')), 'remark_info');
  assert.equal(classifyTrafficPath(soa('16037/getConversationInfoByGidList')), 'remark_info');
  assert.equal(classifyTrafficPath(soa('11679/getRecentMessages')), 'recent_messages');
  assert.equal(classifyTrafficPath(soa('15529/getSessionEmpathyPhraseInfo')), 'empathy_phrase');
  for (const n of ['11679/batchTranslateByMsgIds', '15529/queryToken', '14735/getOrderDetailsForVbk']) assert.equal(classifyTrafficPath(soa(n)), 'open_session', n);
  assert.equal(classifyTrafficPath(soa('11679/PutAdviceOfReadByMsgId.json')), 'read_receipt');
  assert.equal(classifyTrafficPath('https://s.c-ctrip.com/bee/collect?x=1'), 'telemetry');
  assert.equal(classifyTrafficPath(soa('16037/getMessageList')), null);
  assert.equal(classifyTrafficPath('https://example.invalid/getConversationList'), null);
  assert.equal(classifyTrafficPath({ url: soa('11679/getRecentMessages') }), 'recent_messages');
  assert.equal(classifyTrafficPath(42), null);
});

test('classification: strict scheme / host / port check; lookalike origins are not official traffic', () => {
  const list = '/restapi/soa2/16037/getConversationList';
  for (const url of [
    `https://m.ctrip.com.evil${list}`,
    `https://evil.com${list}`,
    `https://evil.com/x${list}`,
    `https://xm.ctrip.com${list}`,
    `http://m.ctrip.com${list}`,
    `https://m.ctrip.com:8443${list}`,
    `https://user:pw@m.ctrip.com${list}`,
    `wss://m.ctrip.com${list}`,
    'https://s.c-ctrip.com.evil/bee/collect',
    'http://s.c-ctrip.com/bee/collect',
    'https://m.ctrip.com/bee/collect',
    'https://s.c-ctrip.com/x/bee/collect',
  ]) {
    assert.equal(classifyTrafficPath(url), null, url);
    assert.equal(conversationListVariantOf(url), null, url);
  }
  assert.equal(classifyTrafficPath(`https://m.ctrip.com:443${list}`), 'conversation_list');
  assert.equal(classifyTrafficPath(`https://M.CTRIP.COM${list}`), 'conversation_list', 'host is case-insensitive');
  assert.equal(classifyTrafficPath(`https://vbooking.ctrip.com${list}.json`), 'conversation_list');
  assert.equal(classifyTrafficPath(`https://imvendor.ctrip.com${list}`), 'conversation_list');
  assert.equal(classifyTrafficPath(`${list}?x=1`), 'conversation_list', 'relative URL is the page origin');
  assert.equal(classifyTrafficPath(`//m.ctrip.com.evil${list}`), null, 'protocol-relative lookalike');
  // variants
  const soa = (p: string) => `https://m.ctrip.com/restapi/soa2/${p}?_fxpcqlniredt=x`;
  assert.equal(conversationListVariantOf(soa('16037/getConversationList.json')), 'json');
  assert.equal(conversationListVariantOf(soa('16037/getConversationList')), 'plain');
  assert.equal(conversationListVariantOf(soa('11679/getRecentMessages')), null);
});

test('ledger: account x path x minute bucket x initiator, bootstrap subset, bounded retention', () => {
  const ledger = createTrafficLedger({ retainBuckets: 3 });
  ledger.setAccount('acc-1');
  const t0 = 10 * MIN;
  ledger.request(LIST_URL, 'official', t0 + 1);
  ledger.request(LIST_URL, 'official', t0 + 2);
  ledger.markBootstrap('conversation_list');
  ledger.request(LIST_URL, 'adapter', t0 + 3);
  ledger.request(LIST_URL, 'adapter', t0 + MIN);
  assert.equal(ledger.request('https://example.invalid/x', 'adapter', t0), null, 'unclassified paths are not counted');
  assert.equal(ledger.count('conversation_list', 'official', 10), 2);
  assert.equal(ledger.count('conversation_list', 'adapter', 10), 1);
  assert.equal(ledger.count('conversation_list', 'adapter', 11), 1);
  assert.deepEqual(
    ledger.rows().map((r) => [r.account, r.path, r.bucket, r.initiator, r.count, r.bootstrap]),
    [
      ['acc-1', 'conversation_list', 10, 'adapter', 1, 1],
      ['acc-1', 'conversation_list', 10, 'official', 2, 0],
      ['acc-1', 'conversation_list', 11, 'adapter', 1, 0],
    ],
  );
  ledger.request(LIST_URL, 'official', t0 + 5 * MIN);
  assert.equal(ledger.count('conversation_list', 'official', 10), 0, 'buckets older than the retention are dropped');
});

// ------------------------------------------------------------------ hook observability

class FakeResponse {
  used = false;
  readonly status: number;
  readonly #text: string;
  constructor(text: string, status = 200) {
    this.#text = text;
    this.status = status;
  }
  clone(): FakeResponse {
    if (this.used) throw new TypeError('body used');
    return new FakeResponse(this.#text, this.status);
  }
  text(): Promise<string> {
    this.used = true;
    return Promise.resolve(this.#text);
  }
}

test('fetch hook: every official call is captured with request/response order; the page still reads its body', async () => {
  const ledger = createTrafficLedger();
  const feed = createOfficialConversationFeed();
  const responses = new Map<string, FakeResponse>();
  const calls: { url: string; init: unknown; self: unknown }[] = [];
  const win: { fetch: unknown } = {
    fetch(this: unknown, url: string, init: unknown) {
      calls.push({ url, init, self: this });
      const body = url.includes('getConversationList') ? listText([row('g1')], 1700000001000) : '{}';
      const res = new FakeResponse(body);
      responses.set(url, res);
      return Promise.resolve(res);
    },
  };
  const clock = { t: 3 * MIN };
  installContextHooks(win, createContextSniffer(), createTrafficTap(ledger, feed, () => clock.t));
  const fetchFn = win.fetch as (this: unknown, url: string, init: unknown) => Promise<FakeResponse>;
  const soa = (p: string) => `https://m.ctrip.com/restapi/soa2/${p}`;
  const targets = [soa('16037/getConversationList'), soa('11679/getRecentMessages'), soa('16037/getRemarkList')];
  const pageReads: string[] = [];
  for (const url of targets) {
    const init = { body: JSON.stringify({ head: {} }) };
    const p = fetchFn.call(win, url, init);
    // like a page: consume the body right when the promise settles
    pageReads.push(await p.then((res) => res.text()));
    clock.t += 1000;
  }
  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => c.self === win), 'original `this` and arguments are preserved');
  assert.equal(pageReads[0], listText([row('g1')], 1700000001000), 'the page body was not consumed by the tap');
  await Promise.resolve();
  await Promise.resolve();
  const ev = ledger.events();
  assert.deepEqual(
    ev.map((e) => [e.seq, e.phase, e.category, e.initiator]),
    [
      [1, 'request', 'conversation_list', 'official'],
      [1, 'response', 'conversation_list', 'official'],
      [2, 'request', 'recent_messages', 'official'],
      [2, 'response', 'recent_messages', 'official'],
      [3, 'request', 'remark_info', 'official'],
      [3, 'response', 'remark_info', 'official'],
    ],
  );
  assert.ok(ev.every((e) => e.phase === 'request' || e.status === 200));
  assert.equal(ledger.count('conversation_list', 'official', 3), 1);
  assert.equal(ledger.count('recent_messages', 'official', 3), 1);
  assert.equal(ledger.count('remark_info', 'official', 3), 1);
  assert.equal(feed.active(clock.t), false, 'one call is not a loop yet');
});

test('fetch hook: concurrent calls keep their own request/response pairing; failures are logged, not thrown', async () => {
  const ledger = createTrafficLedger();
  const resolvers: ((r: FakeResponse | Error) => void)[] = [];
  const win: { fetch: unknown } = {
    fetch: () =>
      new Promise<FakeResponse>((resolve, reject) => {
        resolvers.push((r) => (r instanceof Error ? reject(r) : resolve(r)));
      }),
  };
  installContextHooks(win, createContextSniffer(), createTrafficTap(ledger, null, () => 5 * MIN));
  const fetchFn = win.fetch as (url: string, init: unknown) => Promise<unknown>;
  const a = fetchFn('https://m.ctrip.com/restapi/soa2/11679/getRecentMessages', {});
  const b = fetchFn('https://m.ctrip.com/restapi/soa2/15529/getSessionEmpathyPhraseInfo', {});
  resolvers[1]?.(new FakeResponse('{}', 200));
  resolvers[0]?.(new Error('offline'));
  await assert.rejects(a, /offline/, 'the page still sees its own rejection');
  await b;
  await Promise.resolve();
  assert.deepEqual(
    ledger.events().map((e) => [e.seq, e.phase, e.status ?? null]),
    [[1, 'request', null], [2, 'request', null], [2, 'response', 200], [1, 'response', 0]],
  );
});

test('xhr hook: official XHR calls are captured, including the conversation-list response body', () => {
  const ledger = createTrafficLedger();
  const feed = createOfficialConversationFeed();
  const listeners: (() => void)[] = [];
  class FakeXhr {
    status = 200;
    responseType = '';
    responseText = listText([row('g9')], 1700000009000);
    open(_method: string, _url: string): void {}
    send(_body?: unknown): void {}
    addEventListener(type: string, cb: () => void): void {
      if (type === 'loadend') listeners.push(cb);
    }
  }
  const win = { XMLHttpRequest: FakeXhr };
  installContextHooks(win, createContextSniffer(), createTrafficTap(ledger, feed, () => 7 * MIN));
  const x = new FakeXhr();
  x.open('POST', LIST_URL);
  x.send(listBody());
  assert.equal(ledger.count('conversation_list', 'official', 7), 1);
  const seen: string[] = [];
  const attachment = feed.attach('plain', { onRequest: () => 'ticket', onResponse: (e, t) => seen.push(`${e.full}:${String(t)}`) });
  assert.equal(attachment.complete, false);
  listeners.forEach((l) => l());
  assert.deepEqual(ledger.events().map((e) => e.phase), ['request', 'response']);
});

test('adapter fetch wrapper counts adapter traffic separately from official traffic', async () => {
  const ledger = createTrafficLedger();
  const wrapped = recordAdapterFetch(ledger, () => Promise.resolve({ status: 200, text: () => Promise.resolve('{}') }), () => 4 * MIN);
  await wrapped(LIST_URL, { method: 'POST', headers: {}, body: '{}', credentials: 'include' });
  assert.equal(ledger.count('conversation_list', 'adapter', 4), 1);
  assert.equal(ledger.count('conversation_list', 'official', 4), 0);
  assert.deepEqual(ledger.events().map((e) => e.phase), ['request', 'response']);
});

// ------------------------------------------------------------------ official feed

test('feed: loop is active only with >= 2 recent calls; goes inactive when the official page stops', () => {
  const feed = createOfficialConversationFeed();
  assert.equal(feed.active(0), false);
  officialRound(feed, 1000, undefined, null);
  assert.equal(feed.active(1000), false);
  officialRound(feed, 6000, 1, null);
  assert.equal(feed.active(6000), true);
  assert.equal(feed.active(6000 + 15_000), true);
  assert.equal(feed.active(6000 + 15_001), false);
});

test('feed: replay buffer starts at the last full snapshot, drops on overflow, never replays an unanchored increment', () => {
  const feed = createOfficialConversationFeed({ maxEntries: 3 });
  const replay = (): string[] => {
    const got: string[] = [];
    const a = feed.attach('plain', { onRequest: () => undefined, onResponse: (e) => got.push(`${e.full ? 'F' : 'i'}${e.startTime ?? ''}`) });
    a.detach();
    return got;
  };
  officialRound(feed, 1000, 5, listText([], 6)); // increment without any full snapshot
  assert.deepEqual(replay(), []);
  officialRound(feed, 2000, undefined, listText([row('a')], 10));
  officialRound(feed, 3000, 10, listText([], 11));
  officialRound(feed, 4000, 11, listText([], 12));
  assert.deepEqual(replay(), ['F', 'i10', 'i11']);
  officialRound(feed, 5000, 12, listText([], 13)); // 4 entries > max 3: chain lost
  assert.deepEqual(replay(), []);
  officialRound(feed, 6000, undefined, listText([row('a')], 20)); // next full snapshot re-anchors
  assert.deepEqual(replay(), ['F']);
  officialRound(feed, 7000, 20, listText([], 21), 502); // failed rounds are not buffered
  assert.deepEqual(replay(), ['F']);
});

// ------------------------------------------------------------------ poller: consume vs self-run

interface Harness {
  readonly deps: FakeDeps;
  readonly ledger: TrafficLedger;
  readonly feed: OfficialFeedSink;
  readonly facts: AdapterFact[];
  readonly outcomes: { kind: string; cursorAtCall: number | null }[];
}

function harness(script: Parameters<typeof makeDeps>[0] = () => jsonResponse({ ResponseStatus: OK_STATUS, conversationList: [], lastUpdateTime: 1 })): Harness {
  const base = makeDeps(script);
  const ledger = createTrafficLedger();
  const deps: FakeDeps = { ...base, fetch: recordAdapterFetch(ledger, base.fetch, base.now) };
  return { deps, ledger, feed: createOfficialConversationFeed(), facts: [], outcomes: [] };
}

function startPoller(h: Harness, extra: Partial<Parameters<typeof createConversationListPoller>[2]> = {}, visibility?: VisibilityGate) {
  const poller = createConversationListPoller(h.deps, new SoaClient(h.deps), {
    variant: 'plain',
    emit: (f) => h.facts.push(f),
    official: h.feed,
    ...(visibility ? { visibility } : {}),
    onOutcome: (o: SoaOutcome<ConversationListResponse>) => h.outcomes.push({ kind: o.kind, cursorAtCall: poller.cursor }),
    onBootstrap: () => h.ledger.markBootstrap('conversation_list'),
    ...extra,
  });
  poller.start();
  return poller;
}

const adapterListCount = (h: Harness, bucket: number): number => h.ledger.count('conversation_list', 'adapter', bucket);

/** Server-style cursor values: `normalizeTimeMs` only accepts millisecond-looking numbers. */
const U = 1_700_000_000_000;

test('official loop active: adapter sends 0 getConversationList in every one-minute bucket over 30 minutes', async () => {
  const h = harness();
  const t0 = h.deps.now();
  officialRound(h.feed, t0, undefined, listText([row('g1')], U + 1000));
  officialRound(h.feed, t0 + 5000, U + 1000, listText([], U + 6000));
  await h.deps.clock.advance(5000);
  const p = startPoller(h);
  assert.equal(p.cursor, U + 6000, 'the buffered official chain was replayed');
  const bucket0 = Math.floor(h.deps.now() / MIN);
  let cursor = U + 6000;
  for (let i = 0; i < 30 * 12; i++) {
    await h.deps.clock.advance(5000);
    const next = cursor + 5000;
    officialRound(h.feed, h.deps.now(), cursor, listText(i % 7 === 0 ? [row(`g${i}`)] : [], next));
    cursor = next;
  }
  assert.equal(h.deps.fakeFetch.calls.length, 0, 'no request of the adapter at all');
  for (let b = bucket0; b <= bucket0 + 30; b++) assert.equal(adapterListCount(h, b), 0, `bucket ${b}`);
  assert.ok(h.ledger.rows().length === 0, 'the ledger has no adapter conversation-list row; the official rounds here were fed to the feed directly');
  assert.equal(p.source, 'official');
  assert.equal(p.cursor, cursor);
  assert.ok(h.facts.filter((f) => f.kind === 'conversation').length > 5, 'official rows still reach the host as facts');
  p.stop();
  assert.equal(h.deps.clock.pendingCount(), 0);
});

test('without an official loop the very same poller does self-run (the contrast to the test above)', async () => {
  const h = harness((_c, i) => jsonResponse({ ResponseStatus: OK_STATUS, conversationList: [], lastUpdateTime: U + i }));
  const p = startPoller(h);
  await h.deps.clock.advance(0);
  await h.deps.clock.advance(60_000);
  assert.equal(h.deps.fakeFetch.calls.length, 13);
  const bucket = Math.floor(h.deps.now() / MIN);
  assert.equal(adapterListCount(h, bucket) + adapterListCount(h, bucket - 1), 13, 'adapter traffic is counted as adapter');
  assert.equal(p.source, 'self');
  p.stop();
});

test('consuming official responses: a full snapshot is reported with a null cursor, increments with the chain cursor', async () => {
  const h = harness();
  const t0 = h.deps.now();
  officialRound(h.feed, t0, undefined, listText([row('g1')], U + 100));
  officialRound(h.feed, t0 + 5000, U + 100, listText([], U + 200));
  await h.deps.clock.advance(5000);
  const poller = startPoller(h);
  // an official page that re-sends a full snapshot later (reload) resets the chain
  officialRound(h.feed, h.deps.now() + 1000, undefined, listText([row('g1'), row('g2')], U + 300));
  officialRound(h.feed, h.deps.now() + 2000, U + 300, listText([row('g2', { status: 4 })], U + 400));
  assert.deepEqual(
    h.outcomes.map((o) => [o.kind, o.cursorAtCall]),
    [['success', null], ['success', U + 100], ['success', null], ['success', U + 300]],
  );
  assert.deepEqual(
    h.facts.filter((f) => f.kind === 'conversation_list_sync'),
    [
      { kind: 'conversation_list_sync', full: true, last_update_time_ms: U + 100 },
      { kind: 'conversation_list_sync', full: false, last_update_time_ms: U + 200 },
      { kind: 'conversation_list_sync', full: true, last_update_time_ms: U + 300 },
      { kind: 'conversation_list_sync', full: false, last_update_time_ms: U + 400 },
    ],
  );
  assert.equal(poller.cursor, U + 400);
  assert.equal(h.deps.fakeFetch.calls.length, 0);
  poller.stop();
});

test('the .json variant only consumes its own official calls', () => {
  const h = harness();
  const jsonUrl = 'https://m.ctrip.com/restapi/soa2/16037/getConversationList.json?_fxpcqlniredt=T-1';
  officialRound(h.feed, 0, undefined, listText([row('plain-1')], U + 10));
  officialRound(h.feed, 0, undefined, listText([row('json-1')], U + 20), 200, jsonUrl);
  const p = startPoller(h, { variant: 'json' });
  const gids = h.facts.flatMap((f) => (f.kind === 'conversation' ? [f.fact.gid] : []));
  assert.deepEqual(gids, ['json-1']);
  p.stop();
});

test('official auth failure stops the poller once and detaches it from the feed', () => {
  const h = harness();
  const t = h.deps.now();
  officialRound(h.feed, t - 1000, undefined, listText([row('g1')], U + 10));
  officialRound(h.feed, t, U + 10, listText([], U + 11));
  const p = startPoller(h);
  officialRound(h.feed, t + 1, U + 11, JSON.stringify({ ResponseStatus: AUTH_FAILURE_STATUS }));
  assert.equal(p.running, false);
  assert.equal(h.deps.fakeFetch.calls.length, 0);
  assert.equal(h.facts.filter((f) => f.kind === 'auth_invalid').length, 1);
  officialRound(h.feed, t + 2, U + 11, listText([row('late')], U + 20));
  assert.equal(h.facts.filter((f) => f.kind === 'conversation').length, 1, 'detached: nothing after the stop');
  assert.equal(h.deps.clock.pendingCount(), 0);
});

test('official loop active but no full snapshot ever seen: one reported bootstrap pull after the grace period, then consumption', async () => {
  const h = harness((_c, i) => jsonResponse({ ResponseStatus: OK_STATUS, conversationList: [row('g1')], lastUpdateTime: U + 1000 + i }));
  // the hook missed the official page's first (full) call: only increments were seen
  let official = U + 90;
  const incrementRound = (): void => {
    officialRound(h.feed, h.deps.now(), official, listText([], official + 1));
    official += 1;
  };
  incrementRound();
  await h.deps.clock.advance(1000);
  incrementRound();
  const p = startPoller(h);
  await h.deps.clock.advance(0);
  assert.equal(h.deps.fakeFetch.calls.length, 0, 'the official loop is running: wait for its full snapshot first');
  assert.equal(p.cursor, null);
  for (let t = 1000; t <= 6000; t += 1000) {
    await h.deps.clock.advance(1000);
    incrementRound();
    assert.equal(h.deps.fakeFetch.calls.length, 0, `still inside the grace period at ${t} ms`);
  }
  // the watchdog tick runs every 5 s: the pull happens at the first tick after the 7 s grace period (here t = 10 s)
  for (let i = 0; i < 4; i++) {
    await h.deps.clock.advance(1000);
    incrementRound();
  }
  assert.equal(h.deps.fakeFetch.calls.length, 1, 'exactly one bootstrap pull');
  assert.equal('startTime' in (h.deps.fakeFetch.calls[0]?.bodyJson as object), false, 'it is a full snapshot');
  const bootstrapRow = h.ledger.rows().find((r) => r.initiator === 'adapter' && r.path === 'conversation_list');
  assert.equal(bootstrapRow?.count, 1);
  assert.equal(bootstrapRow?.bootstrap, 1, 'the exception is visible in the ledger, not hidden');
  assert.notEqual(p.cursor, null);
  for (let i = 0; i < 24; i++) {
    await h.deps.clock.advance(5000);
    incrementRound();
  }
  assert.equal(h.deps.fakeFetch.calls.length, 1, 'after the bootstrap the adapter consumes again');
  p.stop();
});

test('official loop stops: the adapter self-runs at >= 5 s intervals from the official cursor', async () => {
  const h = harness((_c, i) => jsonResponse({ ResponseStatus: OK_STATUS, conversationList: [], lastUpdateTime: U + 5000 + i }));
  officialRound(h.feed, h.deps.now() - 20_000, undefined, listText([row('g1')], U + 1000));
  officialRound(h.feed, h.deps.now() - 14_000, U + 1000, listText([], U + 2000));
  const p = startPoller(h);
  await h.deps.clock.advance(0);
  assert.equal(h.deps.fakeFetch.calls.length, 0, 'last official call is 14 s old: still active');
  await h.deps.clock.advance(5000); // 19 s old: the official loop is stale, self-run takes over
  assert.equal(h.deps.fakeFetch.calls.length, 1);
  assert.equal((h.deps.fakeFetch.calls[0]?.bodyJson as { startTime: number }).startTime, U + 2000, 'continues from the cursor of the official chain');
  assert.equal(p.source, 'self');
  const stamps: number[] = [];
  for (let i = 0; i < 40; i++) {
    const before = h.deps.fakeFetch.calls.length;
    await h.deps.clock.advance(1000);
    if (h.deps.fakeFetch.calls.length > before) stamps.push(h.deps.now());
  }
  assert.ok(stamps.length >= 6);
  for (let i = 1; i < stamps.length; i++) assert.ok((stamps[i] ?? 0) - (stamps[i - 1] ?? 0) >= 5000, 'minimum interval 5 s');
  // the official page comes back: stop requesting
  const calls = h.deps.fakeFetch.calls.length;
  let cursor = p.cursor ?? 0;
  for (let i = 0; i < 7; i++) {
    // two quick rounds are what makes the loop "active" again (>= 2 calls in the window)
    if (i === 0) {
      officialRound(h.feed, h.deps.now(), cursor, listText([], cursor + 1));
      cursor += 1;
    }
    officialRound(h.feed, h.deps.now(), cursor, listText([], cursor + 1));
    cursor += 1;
    await h.deps.clock.advance(5000);
  }
  assert.equal(h.deps.fakeFetch.calls.length, calls, 'official loop active again: no more adapter requests');
  p.stop();
});

// ------------------------------------------------------------------ silent starvation (adversarial review)

test('starvation: an official loop on the other URL variant must not silence this poller (zero requests, zero data)', async () => {
  const h = harness((_c, i) => jsonResponse({ ResponseStatus: OK_STATUS, conversationList: [row('g1')], lastUpdateTime: U + 1000 + i }));
  const jsonUrl = 'https://m.ctrip.com/restapi/soa2/16037/getConversationList.json?_fxpcqlniredt=T-1';
  let cursor = U + 10;
  const jsonRound = (): void => {
    officialRound(h.feed, h.deps.now(), cursor, listText([], cursor + 1), 200, jsonUrl);
    cursor += 1;
  };
  jsonRound();
  await h.deps.clock.advance(1000);
  jsonRound();
  const p = startPoller(h); // variant 'plain'
  await h.deps.clock.advance(0);
  const stamps: number[] = [];
  for (let i = 0; i < 120; i++) {
    const before = h.deps.fakeFetch.calls.length;
    await h.deps.clock.advance(1000);
    jsonRound();
    if (h.deps.fakeFetch.calls.length > before) stamps.push(h.deps.now());
  }
  assert.ok(h.deps.fakeFetch.calls.length >= 10, `the plain poller must self-run while only the .json loop is active (got ${h.deps.fakeFetch.calls.length} requests)`);
  for (let i = 1; i < stamps.length; i++) assert.ok((stamps[i] ?? 0) - (stamps[i - 1] ?? 0) >= 5000, 'minimum interval still 5 s');
  assert.equal(p.source, 'self');
  assert.ok(h.facts.filter((f) => f.kind === 'conversation').length >= 10, 'data keeps flowing');
  p.stop();
});

test('starvation: official requests whose bodies cannot be observed stop counting as a feed after 30 s; usable responses re-enable consumption', async () => {
  const h = harness((_c, i) => jsonResponse({ ResponseStatus: OK_STATUS, conversationList: [row('g1')], lastUpdateTime: U + 1000 + i }));
  const t0 = h.deps.now();
  officialRound(h.feed, t0, undefined, listText([row('g1')], U + 100));
  officialRound(h.feed, t0 + 5000, U + 100, listText([], U + 200));
  await h.deps.clock.advance(5000);
  const p = startPoller(h);
  assert.equal(p.cursor, U + 200);
  // From here on the page keeps requesting but the tap never gets a body (e.g. an opaque response type).
  const blindSince = h.deps.now();
  let official = U + 200;
  const blindRound = (): void => {
    officialRound(h.feed, h.deps.now(), official, null);
    official += 1;
  };
  const windowStart = h.deps.now();
  for (let i = 0; i < 6; i++) {
    await h.deps.clock.advance(5000);
    blindRound();
    if (h.deps.now() - windowStart <= 25_000) assert.equal(h.deps.fakeFetch.calls.length, 0, `still trusting the official loop at +${h.deps.now() - windowStart} ms`);
  }
  for (let i = 0; i < 12; i++) {
    await h.deps.clock.advance(5000);
    blindRound();
  }
  assert.ok(h.deps.fakeFetch.calls.length >= 5, `fallback to self-run after ${h.deps.now() - blindSince} ms blind (got ${h.deps.fakeFetch.calls.length})`);
  assert.equal(p.source, 'self');
  const selfCursor = p.cursor;
  assert.notEqual(selfCursor, null);
  // Bodies become observable again: the poller goes back to consuming.
  const resumed = h.deps.fakeFetch.calls.length;
  let c = (selfCursor ?? 0) + 1;
  for (let i = 0; i < 12; i++) {
    officialRound(h.feed, h.deps.now(), c, listText([], c + 1));
    c += 1;
    await h.deps.clock.advance(5000);
  }
  assert.ok(h.deps.fakeFetch.calls.length - resumed <= 1, 'at most one request in flight before consumption takes over again');
  assert.equal(p.source, 'official');
  p.stop();
});

test('xhr hook: a responseType "json" conversation-list response is still fed (serialised), not dropped', () => {
  const ledger = createTrafficLedger();
  const feed = createOfficialConversationFeed();
  const listeners: (() => void)[] = [];
  class FakeXhr {
    status = 200;
    responseType = 'json';
    response: unknown = JSON.parse(listText([row('g9')], U + 9000));
    get responseText(): string {
      throw new Error('InvalidStateError');
    }
    open(_method: string, _url: string): void {}
    send(_body?: unknown): void {}
    addEventListener(type: string, cb: () => void): void {
      if (type === 'loadend') listeners.push(cb);
    }
  }
  installContextHooks({ XMLHttpRequest: FakeXhr }, createContextSniffer(), createTrafficTap(ledger, feed, () => 7 * MIN));
  const x = new FakeXhr();
  x.open('POST', LIST_URL);
  x.send(listBody());
  const seen: boolean[] = [];
  feed.attach('plain', { onRequest: () => undefined, onResponse: (e) => seen.push(e.full) });
  listeners.forEach((l) => l());
  assert.deepEqual(seen, [true]);
});

// ------------------------------------------------------------------ visibility and backoff

function gate(initial: boolean): VisibilityGate & { set(v: boolean): void } {
  let visible = initial;
  const subs = new Set<() => void>();
  return {
    isVisible: () => visible,
    subscribe(cb) {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    set(v) {
      visible = v;
      for (const cb of [...subs]) cb();
    },
  };
}

async function requestsIn(ms: number, visible: boolean): Promise<number> {
  const h = harness();
  const p = startPoller(h, {}, gate(visible));
  await h.deps.clock.advance(0);
  await h.deps.clock.advance(ms);
  p.stop();
  return h.deps.fakeFetch.calls.length;
}

test('visibility gate: hidden self-run requests over 10 minutes are <= 20% of the foreground count', async () => {
  const foreground = await requestsIn(10 * MIN, true);
  const hidden = await requestsIn(10 * MIN, false);
  assert.equal(foreground, 121);
  assert.ok(hidden <= foreground * 0.2, `hidden ${hidden} vs foreground ${foreground}`);
  assert.ok(hidden >= 20, 'still alive, only slower');
});

test('visibility gate: becoming visible never beats the 5 s minimum; becoming hidden stretches the interval to 30 s', async () => {
  const h = harness();
  const g = gate(false);
  const p = startPoller(h, {}, g);
  await h.deps.clock.advance(0);
  assert.equal(h.deps.fakeFetch.calls.length, 1);
  await h.deps.clock.advance(3000);
  g.set(true); // visible 3 s after the last request: wait the remaining 2 s
  await h.deps.clock.advance(1999);
  assert.equal(h.deps.fakeFetch.calls.length, 1);
  await h.deps.clock.advance(1);
  assert.equal(h.deps.fakeFetch.calls.length, 2);
  g.set(false);
  await h.deps.clock.advance(29_999);
  assert.equal(h.deps.fakeFetch.calls.length, 2);
  await h.deps.clock.advance(1);
  assert.equal(h.deps.fakeFetch.calls.length, 3);
  p.stop();
  assert.equal(h.deps.clock.pendingCount(), 0);
});

/** Harness whose fetch script also records the clock time of every request. */
function timed(status: (index: number) => number, random: () => number = () => 0): { h: Harness; times: number[] } {
  const times: number[] = [];
  const ref: { deps?: FakeDeps } = {};
  const h = harness((_c, i) => {
    times.push(ref.deps?.clock.now() ?? 0);
    return status(i) === 200 ? jsonResponse({ ResponseStatus: OK_STATUS, conversationList: [], lastUpdateTime: 1 }) : jsonResponse('', status(i));
  });
  const deps: FakeDeps = { ...h.deps, random };
  ref.deps = h.deps;
  return { h: { ...h, deps }, times };
}

test('backoff: delay doubles per consecutive failure up to the cap, never below 5 s, success resets', async () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map((f) => listBackoffMs(5000, f, 60_000)), [5000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);
  assert.equal(listBackoffMs(5000, 0, 60_000), 5000);

  const { h, times } = timed((i) => (i < 6 ? 502 : 200));
  const p = startPoller(h);
  await h.deps.clock.advance(0);
  await h.deps.clock.advance(400_000);
  const gaps = times.slice(1).map((s, i) => s - (times[i] ?? 0));
  assert.deepEqual(gaps.slice(0, 6), [5000, 10_000, 20_000, 40_000, 60_000, 60_000], 'failures 1..6');
  assert.equal(gaps[6], 5000, 'after the first success the base interval is back');
  p.stop();
});

test('backoff jitter only lengthens the wait and keeps the failure streak non-decreasing and within the cap', async () => {
  for (let seed = 0; seed < 40; seed++) {
    let s = seed + 1;
    const rnd = () => {
      s = (s * 48271) % 2147483647;
      return s / 2147483647;
    };
    const { h, times } = timed(() => 503, rnd);
    const p = startPoller(h);
    await h.deps.clock.advance(0);
    await h.deps.clock.advance(600_000);
    p.stop();
    const gaps = times.slice(1).map((x, i) => x - (times[i] ?? 0));
    assert.ok(gaps.length >= 10, `seed ${seed}`);
    for (let i = 0; i < gaps.length; i++) {
      assert.ok((gaps[i] ?? 0) >= 5000, `seed ${seed} gap ${i}`);
      assert.ok((gaps[i] ?? 0) <= 60_000, `seed ${seed} gap ${i} above the cap`);
      if (i > 0) assert.ok((gaps[i] ?? 0) >= (gaps[i - 1] ?? 0), `seed ${seed}: interval decreased at ${i}`);
    }
  }
});
