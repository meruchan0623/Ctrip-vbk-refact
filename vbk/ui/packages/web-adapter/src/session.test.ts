import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AdapterFactEnvelope } from '../../ipc/src/contracts.ts';
import type { AdapterDisplayPayload } from '../../ipc/src/adapterProtocol.ts';
import { createPageSession } from './session.ts';
import { FakePageSdk, OK_STATUS, jsonResponse, makeDeps, sampleRow } from './testing.ts';

const account = { account_id: 'acc-1', environment: 'production' as const, session_generation: 1 };

function setup() {
  let unread = 4;
  const base = makeDeps((call) => {
    if (call.url.includes('getConversationList')) return jsonResponse({ ResponseStatus: OK_STATUS, conversationList: [sampleRow('g1')], currentStatus: 2, lastUpdateTime: 1700000000600, haveRest: false });
    if (call.url.includes('getConversationInfoByGidList')) return jsonResponse({ ResponseStatus: OK_STATUS, bizResponseStatus: { resultCode: 'SUCCESS' }, conversationInfoList: [{ gid: 'g1', unreadCount: unread }] });
    return jsonResponse({ ResponseStatus: OK_STATUS });
  });
  const sdk = new FakePageSdk();
  const deps = { ...base, sdk };
  const displays: AdapterDisplayPayload[] = [];
  const session = createPageSession(deps, {
    account,
    selfUid: 'me',
    beginMsgTime: 1700000000000,
    initialEpoch: 1,
    sdk,
    pushDisplay: (p) => (displays.push(p), Promise.resolve(null)),
    unreadDebounceMs: 10,
  });
  return { base, sdk, session, displays, setUnread: (n: number) => (unread = n) };
}

const envs = (base: ReturnType<typeof makeDeps>) => base.invoked.map((i) => i.payload as AdapterFactEnvelope);

test('session: display conversations + agent status; unread from getConversationInfoByGidList re-emits the fact', async () => {
  const { base, session, displays } = setup();
  session.start();
  await base.clock.advance(50);
  await session.adapter.bridge.flush();
  const conv = displays.find((d) => d.kind === 'conversations');
  assert.ok(conv && conv.kind === 'conversations' && conv.full === true && conv.items[0]?.title === 'Title g1');
  assert.ok(displays.some((d) => d.kind === 'agent_status' && d.status === 'leaving' && d.confirmed));
  const facts = envs(base).filter((e) => e.fact.kind === 'conversation');
  assert.ok(facts.length >= 2);
  const last = facts.at(-1)?.fact;
  assert.ok(last && last.kind === 'conversation' && last.fact.unread_count === 4 && last.fact.is_full_snapshot === false);
  for (const e of envs(base)) assert.equal(JSON.stringify(e).includes('Title g1'), false, 'titles never enter facts');
  session.stop();
  assert.equal(base.clock.pendingCount(), 0);
});

test('session: U02 — a restarted run (new epoch) starts with a full conversation snapshot', async () => {
  const { base, session } = setup();
  session.start();
  await base.clock.advance(5100);
  const bodies = base.fakeFetch.calls.filter((c) => c.url.includes('getConversationList')).map((c) => c.bodyJson as Record<string, unknown>);
  assert.equal('startTime' in (bodies[0] ?? {}), false);
  assert.equal(bodies[1]?.['startTime'], 1700000000600);
  session.stop();
  session.start();
  await base.clock.advance(10);
  await session.adapter.bridge.flush();
  const after = base.fakeFetch.calls.filter((c) => c.url.includes('getConversationList')).at(-1)?.bodyJson as Record<string, unknown>;
  assert.equal('startTime' in after, false, 'first poll of the new epoch is full');
  const fullSync = envs(base).filter((e) => e.epoch === 2 && e.fact.kind === 'conversation_list_sync');
  assert.ok(fullSync.length > 0 && fullSync[0]?.fact.kind === 'conversation_list_sync' && fullSync[0].fact.full === true);
  session.stop();
});

test('session: realtime SDK message → display message + preview update, fact without body', async () => {
  const { base, sdk, session, displays } = setup();
  session.start();
  await base.clock.advance(50);
  sdk.emit('message', { id: 's1', localid: 'l', type: 'groupchat', msgtype: '0', create_time: '1700000009000', from: 'g1@conf.x/cust-g1', to: 'me@x', body: 'new text' });
  await session.adapter.bridge.flush();
  const msg = displays.find((d) => d.kind === 'messages');
  assert.ok(msg && msg.kind === 'messages' && msg.items[0]?.text === 'new text' && msg.items[0]?.sender_role === 'customer');
  const conv = displays.filter((d) => d.kind === 'conversations').at(-1);
  assert.ok(conv && conv.kind === 'conversations' && conv.items[0]?.preview === 'new text');
  assert.equal(envs(base).some((e) => JSON.stringify(e).includes('new text')), false);
  session.stop();
});
