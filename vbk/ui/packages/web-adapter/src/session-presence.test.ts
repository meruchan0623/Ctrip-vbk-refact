import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AdapterDisplayPayload } from '../../ipc/src/adapterProtocol.ts';
import { createPageSession } from './session.ts';
import { FakePageSdk, OK_STATUS, flush, jsonResponse, makeDeps, type FetchScript } from './testing.ts';

function setup(script: FetchScript) {
  const base = makeDeps(script), sdk = new FakePageSdk();
  const displays: AdapterDisplayPayload[] = [];
  const session = createPageSession({ ...base, sdk }, {
    account: { account_id: 'presence', environment: 'production', session_generation: 1 },
    selfUid: 'me', beginMsgTime: 1700000000000, initialEpoch: 1, sdk,
    pushDisplay: p => { displays.push(p); return Promise.resolve(); },
  });
  return { base, sdk, session, rawStatuses: () => displays.filter(p => p.kind === 'agent_status'), statuses: () => displays.filter(p => p.kind === 'agent_status').map(({ kind, status, confirmed }) => ({ kind, status, confirmed })) };
}
const statusResponse = (currentStatus: unknown) => jsonResponse({ ResponseStatus: OK_STATUS, conversationList: [], currentStatus, haveRest: false });

test('session presence: host-issued epoch and IPC sequence survive stop/start', async () => {
  const f = setup(call => call.url.includes('getConversationList') ? statusResponse(0) : jsonResponse({ ResponseStatus: OK_STATUS }));
  f.session.start(); await f.base.clock.advance(50);
  f.session.stop(); f.session.start(); await f.base.clock.advance(50); f.session.stop();
  const statuses = f.rawStatuses();
  assert.ok(statuses.length >= 6);
  assert.ok(statuses.every((p, i) => p.status_epoch === 1 && p.status_seq === i + 1));
});

test('session presence: empty incremental list synchronizes cross-device offline without any status write', async () => {
  let status = 0;
  const { base, session, statuses } = setup(call => call.url.includes('getConversationList') ? statusResponse(status) : jsonResponse({ ResponseStatus: OK_STATUS }));
  session.start();
  await base.clock.advance(50);
  assert.deepEqual(statuses().at(-1), { kind: 'agent_status', status: 'online', confirmed: true });
  status = 3;
  await base.clock.advance(5000);
  assert.deepEqual(statuses().at(-1), { kind: 'agent_status', status: 'getoff', confirmed: true });
  assert.equal(base.fakeFetch.calls.some(c => c.url.includes('setVenAgentStatus')), false);
  session.stop();
});

test('session presence: manual refresh bypasses cache and failed refresh invalidates online immediately', async () => {
  let status: unknown = 0;
  const { base, session, statuses } = setup(call => call.url.includes('getConversationList') ? statusResponse(status) : jsonResponse({ ResponseStatus: OK_STATUS }));
  session.start();
  await base.clock.advance(50);
  status = 3;
  const read = await session.rpc.handle({ req_id: 'read', op: 'agent.status' });
  assert.deepEqual(read, { req_id: 'read', ok: true, data: { status: 'getoff', confirmed: true } });
  status = null;
  assert.equal((await session.rpc.handle({ req_id: 'bad', op: 'agent.status' }))?.ok, false);
  assert.deepEqual(statuses().at(-1), { kind: 'agent_status', status: 'getoff', confirmed: false });
  session.stop();
});

test('session presence: pending status write cannot race a second write or old poll, readback wins', async () => {
  let reads = 0;
  let resolveOld: (value: ReturnType<typeof jsonResponse>) => void = () => assert.fail('old request missing');
  let resolveWrite: (value: ReturnType<typeof jsonResponse>) => void = () => assert.fail('write missing');
  const { base, session, statuses } = setup(call => {
    if (call.url.includes('getConversationList')) {
      reads++;
      return reads === 1 ? new Promise(resolve => { resolveOld = resolve; }) : statusResponse(3);
    }
    if (call.url.includes('setVenAgentStatus')) return new Promise(resolve => { resolveWrite = resolve; });
    return jsonResponse({ ResponseStatus: OK_STATUS });
  });
  session.start();
  await flush();
  const write = session.rpc.handle({ req_id: 'write', op: 'agent.set_status', args: { status: 'getoff' } });
  await flush();
  assert.equal((await session.rpc.handle({ req_id: 'second', op: 'agent.set_status', args: { status: 'online' } }))?.ok, false);
  resolveWrite(jsonResponse({ ResponseStatus: OK_STATUS }));
  assert.equal((await write)?.ok, true);
  resolveOld(statusResponse(0));
  await base.clock.advance(10);
  assert.deepEqual(statuses().at(-1), { kind: 'agent_status', status: 'getoff', confirmed: true });
  assert.equal(base.fakeFetch.calls.filter(c => c.url.includes('setVenAgentStatus')).length, 1);
  session.stop();
});

test('session presence: status response cannot publish after stop/restart or transport invalidation', async () => {
  const pending: ((value: ReturnType<typeof jsonResponse>) => void)[] = [];
  const { session, sdk, statuses } = setup(call => call.url.includes('getConversationList') ? new Promise(resolve => pending.push(resolve)) : jsonResponse({ ResponseStatus: OK_STATUS }));
  session.start();
  await flush();
  const read = session.rpc.handle({ req_id: 'late', op: 'agent.status' });
  await flush();
  session.stop();
  session.start();
  pending[1]!(statusResponse(0));
  assert.equal((await read)?.ok, false);
  pending[0]!(statusResponse(0));
  await flush();
  assert.equal(statuses().at(-1)?.confirmed, false);
  sdk.emit('socket_status', 'disconnected');
  pending[2]!(statusResponse(0));
  await flush();
  assert.equal(statuses().at(-1)?.confirmed, false);
  session.stop();
});
