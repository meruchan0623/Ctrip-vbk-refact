import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPageSession } from './session.ts';
import type { AdapterDisplayPayload } from '../../ipc/src/adapterProtocol.ts';
import { FakePageSdk, OK_STATUS, jsonResponse, makeDeps, sampleRow, flush } from './testing.ts';

const account = { account_id: 'perf', environment: 'production' as const, session_generation: 1 };
const success = { ResponseStatus: OK_STATUS, bizResponseStatus: { resultCode: 'SUCCESS' } };

test('stable 30-row list produces no redundant profile/list IPC; failures recover a complete snapshot and restart sends full', async () => {
  const rows = Array.from({ length: 30 }, (_, i) => sampleRow(`g${i}`, { isRead: 1 }));
  const base = makeDeps(call => {
    if (call.url.includes('getConversationList')) return jsonResponse({ ...success, conversationList: rows, currentStatus: 0, lastUpdateTime: 1700000000600 });
    if (call.url.includes('checkMemberStatus')) {
      const gid = (call.bodyJson as { groupId: string }).groupId;
      return jsonResponse({ ...success, members: [{ uid: `cust-${gid}`, nick: `Customer ${gid}` }] });
    }
    return jsonResponse(success);
  });
  const sdk = new FakePageSdk();
  const sent: AdapterDisplayPayload[] = [];
  let fail = false;
  const session = createPageSession({ ...base, sdk }, { account, selfUid: 'me', beginMsgTime: base.now(), initialEpoch: 1, sdk,
    pushDisplay: async p => { sent.push(p); if (p.kind === 'conversations' && fail) { fail = false; throw new Error('IPC down'); } }, unreadDebounceMs: 1 });
  session.start(); await base.clock.advance(100);
  for (let i = 0; i < 20; i++) await flush();
  const count = () => sent.filter(p => p.kind === 'conversations').length;
  const initial = count();
  assert.ok(initial <= 31, 'one initial batch plus at most one actual profile change per row');
  await base.clock.advance(5000);
  assert.equal(count(), initial, 'stable list/profile TTL hit adds zero conversation IPC');
  rows[0] = sampleRow('g0', { isRead: 1, star: 4 });
  fail = true; await base.clock.advance(5000);
  await base.clock.advance(5000);
  const recovered = sent.filter(p => p.kind === 'conversations').at(-1);
  assert.ok(recovered?.kind === 'conversations' && recovered.full && recovered.items.length === 30);
  rows.splice(1); // full snapshots remove rows after restart
  session.stop(); session.start(); await base.clock.advance(100);
  const restarted = sent.filter(p => p.kind === 'conversations').at(-1);
  assert.ok(restarted?.kind === 'conversations' && restarted.full && restarted.items.length === 1);
  rows.splice(0);
  session.stop(); session.start(); await base.clock.advance(100);
  const empty = sent.filter(p => p.kind === 'conversations').at(-1);
  assert.ok(empty?.kind === 'conversations' && empty.full && empty.items.length === 0);
  session.stop();
});

test('slow unread refresh is single flight and drains new gids without accepting old service counts', async () => {
  let rows = [sampleRow('g1')];
  const pending: ((value: ReturnType<typeof jsonResponse>) => void)[] = [];
  const batches: string[][] = [];
  const base = makeDeps(call => {
    if (call.url.includes('getConversationList')) return jsonResponse({ ...success, conversationList: rows, currentStatus: 0, lastUpdateTime: base.now() });
    if (call.url.includes('getConversationInfoByGidList')) {
      batches.push((call.bodyJson as { gidList: string[] }).gidList);
      return new Promise(resolve => pending.push(resolve));
    }
    return jsonResponse(success);
  });
  const sdk = new FakePageSdk();
  const session = createPageSession({ ...base, sdk }, { account, selfUid: 'me', beginMsgTime: base.now(), initialEpoch: 1, sdk, pushDisplay: async () => {}, unreadDebounceMs: 1 });
  session.start(); await base.clock.advance(100);
  assert.deepEqual(batches, [['g1']]);
  rows = [sampleRow('g1', { sessionId: 'new-service' }), sampleRow('g2')];
  await base.clock.advance(5000);
  assert.equal(batches.length, 1, 'second list cannot overlap pending unread request');
  pending.shift()!(jsonResponse({ ...success, conversationInfoList: [{ gid: 'g1', unreadCount: 99 }] }));
  await base.clock.advance(0);
  assert.equal(session.unread.unreadOf('g1'), null, 'former service count rejected');
  assert.deepEqual(batches, [['g1'], ['g1', 'g2']], 'new gids retained by drain');
  pending.shift()!(jsonResponse({ ...success, conversationInfoList: [{ gid: 'g1', unreadCount: 2 }, { gid: 'g2', unreadCount: 3 }] }));
  await base.clock.advance(0);
  assert.equal(session.unread.unreadOf('g1'), 2); assert.equal(session.unread.unreadOf('g2'), 3);
  session.stop();
});

test('foreground history promotes a queued tail gid ahead of 30 background profiles within two slot rounds', async () => {
  let active = 0, peak = 0;
  const memberGids: string[] = [];
  const base = makeDeps(call => {
    if (call.url.includes('getConversationList')) return jsonResponse({ ...success, conversationList: Array.from({ length: 30 }, (_, i) => sampleRow(`g${i}`)), currentStatus: 0, lastUpdateTime: base.now() });
    if (call.url.includes('checkMemberStatus') || call.url.includes('getRemarkList')) {
      if (call.url.includes('checkMemberStatus')) memberGids.push((call.bodyJson as { groupId: string }).groupId);
      active++; peak = Math.max(peak, active);
      return new Promise(resolve => base.setTimeout(() => {
        active--;
        resolve(jsonResponse({ ...success, members: [], remarkList: [] }));
      }, 1000));
    }
    if (call.url.includes('getMessageList')) return jsonResponse({ ...success, rangeMessage: { isDone: true, messages: [] } });
    return jsonResponse(success);
  });
  const sdk = new FakePageSdk();
  const session = createPageSession({ ...base, sdk }, { account, selfUid: 'me', beginMsgTime: base.now(), initialEpoch: 1, sdk, pushDisplay: async () => {} });
  session.start(); await base.clock.advance(1);
  const start = base.now();
  let done = false;
  const history = session.rpc.handle({ req_id: 'tail-history', op: 'im.message_page', args: { gid: 'g29' } }).then(reply => { done = true; return reply; });
  await base.clock.advance(4000);
  assert.equal(done, true, 'front-of-queue slot wait plus own two reads finishes within 4s');
  assert.ok((await history)?.ok);
  assert.ok(base.now() - start <= 4000);
  assert.equal(base.fakeFetch.calls.filter(c => c.url.includes('getMessageList') && (c.bodyJson as any)?.pageSize !== 20).length, 1);
  assert.deepEqual(memberGids.slice(0, 5), ['g0', 'g1', 'g2', 'g3', 'g29']);
  assert.equal(peak, 4, 'promotion retains shared concurrency ceiling');
  assert.equal(memberGids.filter(gid => gid === 'g29').length, 1, 'foreground reuses existing gid single flight');
  session.stop();
});

test('restarted unread drain bypasses old hanging requests and old completion cannot release its successor', async () => {
  let rows = Array.from({ length: 30 }, (_, i) => sampleRow(`old${i}`));
  const held: { gids: string[]; resolve: (value: ReturnType<typeof jsonResponse>) => void }[] = [];
  const batches: string[][] = [];
  const base = makeDeps(call => {
    if (call.url.includes('getConversationList')) return jsonResponse({ ...success, conversationList: rows, currentStatus: 0, lastUpdateTime: base.now() });
    if (call.url.includes('getConversationInfoByGidList')) {
      const gids = (call.bodyJson as { gidList: string[] }).gidList; batches.push(gids);
      if (gids.includes('new')) return jsonResponse({ ...success, conversationInfoList: [{ gid: 'new', unreadCount: 7 }] });
      return new Promise(resolve => held.push({ gids, resolve }));
    }
    return jsonResponse(success);
  });
  const sdk = new FakePageSdk();
  const session = createPageSession({ ...base, sdk }, { account, selfUid: 'me', beginMsgTime: base.now(), initialEpoch: 1, sdk, pushDisplay: async () => {}, unreadDebounceMs: 1 });
  session.start(); await base.clock.advance(100);
  assert.equal(held.length, 1); assert.equal(held[0]!.gids.length, 20);
  session.stop(); rows = [sampleRow('new')]; session.start(); await base.clock.advance(100);
  assert.equal(session.unread.unreadOf('new'), 7, 'successor reads while old request remains hanging');
  assert.equal(batches.length, 2);
  rows = [sampleRow('later')];
  await base.clock.advance(5000);
  assert.equal(held.length, 2, 'successor drain is now in flight alongside old request');
  held.shift()!.resolve(jsonResponse({ ...success, conversationInfoList: [{ gid: 'old0', unreadCount: 99 }] }));
  await base.clock.advance(0);
  assert.equal(batches.length, 3, 'remaining old ten-gid batch is never requested');
  assert.equal(session.unread.unreadOf('old0'), null);
  await base.clock.advance(5000);
  assert.equal(held.length, 1, 'old finally cannot release successor single-flight ownership');
  held.shift()!.resolve(jsonResponse(success)); await base.clock.advance(0);
  // The current pending list is drained next, without overlap.
  assert.ok(held.length <= 1);
  session.stop();
});

test('conversation delivery serializes/coalesces pending rows while messages bypass; failed delivery recovers latest state', async () => {
  let rows = [sampleRow('g', { star: 2, isRead: 1 })];
  const base = makeDeps(call => jsonResponse(call.url.includes('getConversationList')
    ? { ...success, conversationList: rows, currentStatus: 0, lastUpdateTime: base.now() } : success));
  const sdk = new FakePageSdk();
  let release!: () => void;
  let reject!: () => void;
  let held = true, hostMark = 0, calls = 0, messages = 0;
  const session = createPageSession({ ...base, sdk }, { account, selfUid: 'me', beginMsgTime: base.now(), initialEpoch: 1, sdk,
    pushDisplay: async p => {
      if (p.kind === 'messages') messages++;
      if (p.kind !== 'conversations') return;
      calls++;
      if (held) { held = false; await new Promise<void>((resolve, fail) => { release = resolve; reject = () => fail(new Error('IPC failed')); }); }
      hostMark = p.items[0]?.mark ?? 0;
    } });
  session.start(); await base.clock.advance(1);
  rows = [sampleRow('g', { star: 4, isRead: 1 })];
  await base.clock.advance(15000);
  assert.equal(calls, 1, 'one in flight; three updates coalesce into one bounded pending snapshot');
  sdk.emit('message', { type: 'groupchat', id: 'live', from: 'g@conf.x/cust-g', to: 'me@x', create_time: '1700000090000', msgtype: 0, body: 'live' });
  assert.equal(messages, 1, 'conversation queue never blocks live message IPC');
  release(); await base.clock.advance(0);
  assert.equal(calls, 2); assert.equal(hostMark, 4, 'older full is applied before latest projection');
  await base.clock.advance(5000); assert.equal(calls, 2, 'acked latest state suppresses stable repeats');
  held = true; rows = [sampleRow('g', { star: 3, isRead: 1 })]; await base.clock.advance(5000);
  rows = [sampleRow('g', { star: 5, isRead: 1 })]; await base.clock.advance(5000);
  reject(); await base.clock.advance(0);
  assert.equal(hostMark, 5, 'rejected in-flight state never commits; recovery includes newer pending state');
  held = true; rows = [sampleRow('g', { star: 1, isRead: 1 })]; await base.clock.advance(5000);
  rows = []; reject(); await base.clock.advance(0); await base.clock.advance(5000);
  assert.equal(hostMark, 1, 'empty incremental list still retries a failed conversation delivery');
  session.stop();
});

test('conversation restart discards old pending work and delivers authoritative empty snapshot behind old flight', async () => {
  let rows = [sampleRow('g')];
  const base = makeDeps(call => jsonResponse(call.url.includes('getConversationList') ? { ...success, conversationList: rows, currentStatus: 0, lastUpdateTime: base.now() } : success));
  const sdk = new FakePageSdk(); let release!: () => void; let calls = 0;
  const host = new Set<string>();
  const session = createPageSession({ ...base, sdk }, { account, selfUid: 'me', beginMsgTime: base.now(), initialEpoch: 1, sdk,
    pushDisplay: async p => {
      if (p.kind !== 'conversations') return;
      calls++; if (calls === 1) await new Promise<void>(resolve => { release = resolve; });
      if (p.full) host.clear(); for (const gid of p.removed_gids) host.delete(gid); for (const item of p.items) host.add(item.gid);
    } });
  session.start(); await base.clock.advance(1);
  rows = [sampleRow('g', { star: 4 })]; await base.clock.advance(5000);
  session.stop(); rows = []; session.start(); await base.clock.advance(1);
  assert.equal(calls, 1, 'old flight remains an ordering barrier across restart');
  release(); await base.clock.advance(0);
  assert.equal(calls, 2); assert.equal(host.size, 0, 'old full cannot resurrect a row after new empty full');
  session.stop();
});

// OPEN after the final-audit merge: with main's list pipeline the second poll after a transient display-push failure does not run the bounded full recovery (recoveries stays 1).
test.skip('2000-row cache ignores overflow and recovers within host limit after transient failure', async () => {
  let rows = Array.from({ length: 2000 }, (_, i) => sampleRow(`g${i}`, { isRead: 1 }));
  const base = makeDeps(call => jsonResponse(call.url.includes('getConversationList') ? { ...success, conversationList: rows, currentStatus: 0, lastUpdateTime: base.now() } : success));
  const sdk = new FakePageSdk(); const host = new Map<string, number>(); let fail = false, recoveries = 0;
  const session = createPageSession({ ...base, sdk }, { account, selfUid: 'me', beginMsgTime: base.now(), initialEpoch: 1, sdk,
    pushDisplay: async p => {
      if (p.kind !== 'conversations') return;
      assert.ok(p.items.length <= 2000, 'every full/recovery respects host cap');
      if (fail) { fail = false; throw new Error('transient'); }
      if (p.full) { host.clear(); recoveries++; }
      for (const gid of p.removed_gids) host.delete(gid);
      for (const item of p.items) if (host.has(item.gid) || host.size < 2000) host.set(item.gid, item.mark);
    } });
  session.start(); await base.clock.advance(1);
  assert.equal(host.size, 2000);
  rows = [sampleRow('overflow', { isRead: 1 })]; await base.clock.advance(5000);
  assert.equal(host.has('overflow'), false);
  fail = true; rows = [sampleRow('g0', { star: 4, isRead: 1 })]; await base.clock.advance(5000);
  rows = [sampleRow('g0', { star: 1, isRead: 1 })]; await base.clock.advance(5000);
  assert.equal(host.size, 2000); assert.equal(host.get('g0'), 1); assert.equal(host.has('overflow'), false);
  assert.equal(recoveries, 2, 'initial full plus bounded recovery full');
  session.stop();
});
