/**
 * `feature://fact` channel, page half: a feature op's `emit` becomes
 * `AdapterFact {kind: 'feature'}` on the ordinary fact push path (rpc →
 * pushFact → AdapterBridge → `adapter_push_fact`), on its own stream so the
 * host-tracked cursors never see a gap.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FactStreams, type AdapterFact, type AdapterFactEnvelope } from '../../ipc/src/contracts.ts';
import { ImCommands } from '../../ipc/src/commands.ts';
import { AdapterBridge } from './bridge.ts';
import { createRpc, type RpcContext } from './rpc.ts';
import { createFeatureDispatcher, type AdapterFeature } from './features.ts';
import { ConversationStore, RoleBook } from './stores.ts';
import { SoaClient } from './soa.ts';
import { FakePageSdk, OK_STATUS, jsonResponse, makeDeps, sampleRow } from './testing.ts';

const GID = '1234567890123456789';
const account = { account_id: 'acct-1', environment: 'production', session_generation: 3 };

/** A feature whose op only emits; what it emits is what the host must receive. */
const probe: AdapterFeature = {
  id: 'probe',
  ops: {
    'probe.typing': async (_args, ctx) => { ctx.emit({ kind: 'typing', gid: GID, from: 'cust-9', until_ms: ctx.deps.now() + 5000 }); return null; },
    'probe.recalled': async (_args, ctx) => { ctx.emit({ kind: 'recalled', gid: GID, message_id: '9876543210987654321' }); return null; },
    'probe.queue': async (_args, ctx) => { ctx.emit({ kind: 'queue_notice', gid: GID }); return null; },
  },
};

function setup(pushFact: (fact: AdapterFact) => void) {
  const base = makeDeps(() => jsonResponse({ ResponseStatus: OK_STATUS }));
  const sdk = new FakePageSdk();
  const deps = { ...base, sdk };
  const store = new ConversationStore();
  store.update([sampleRow(GID)]);
  const ctx: RpcContext = {
    deps, sdk, store, soa: new SoaClient(deps), roles: new RoleBook('me'), pushFact, pushDisplay: () => undefined,
    agent: { current: () => null, set() {} }, features: createFeatureDispatcher([probe]),
  };
  return { deps, rpc: createRpc(ctx) };
}

test('feature op emit → pushFact({kind: "feature", fact}) with the fact untouched (no account from the page)', async () => {
  const facts: AdapterFact[] = [];
  const { deps, rpc } = setup((f) => facts.push(f));
  assert.deepEqual(await rpc.handle({ req_id: 'r1', op: 'probe.typing', args: {} }), { req_id: 'r1', ok: true, data: null });
  assert.deepEqual(await rpc.handle({ req_id: 'r2', op: 'probe.recalled', args: {} }), { req_id: 'r2', ok: true, data: null });
  assert.deepEqual(await rpc.handle({ req_id: 'r3', op: 'probe.queue', args: {} }), { req_id: 'r3', ok: true, data: null });
  assert.deepEqual(facts, [
    { kind: 'feature', fact: { kind: 'typing', gid: GID, from: 'cust-9', until_ms: deps.now() + 5000 } },
    { kind: 'feature', fact: { kind: 'recalled', gid: GID, message_id: '9876543210987654321' } },
    { kind: 'feature', fact: { kind: 'queue_notice', gid: GID } },
  ]);
  for (const f of facts) assert.equal('account' in (f as { fact: object }).fact, false, 'the page never names an account');
});

test('bridge: feature facts travel as adapter_push_fact envelopes on im.feature; core streams keep a gap-free seq', async () => {
  const invoked: { cmd: string; env: AdapterFactEnvelope }[] = [];
  const bridge = new AdapterBridge({ account, invoke: (cmd, payload) => { invoked.push({ cmd, env: payload as AdapterFactEnvelope }); return Promise.resolve(null); } });
  const { rpc } = setup(bridge.emit);
  bridge.push({ kind: 'transport', state: 'connected' });
  await rpc.handle({ req_id: 'r1', op: 'probe.queue', args: {} });
  await rpc.handle({ req_id: 'r2', op: 'probe.queue', args: {} });
  bridge.push({ kind: 'transport', state: 'disconnected' });
  await bridge.flush();
  // the bridge names the logical command; boot.ts's invoke maps it to `adapter_push_fact {envelope}` (boot.test.ts)
  assert.deepEqual(invoked.map((i) => [i.cmd, i.env.stream, i.env.seq, i.env.fact.kind]), [
    [ImCommands.PUSH_FACT, FactStreams.TRANSPORT, 1, 'transport'],
    [ImCommands.PUSH_FACT, FactStreams.FEATURE, 1, 'feature'],
    [ImCommands.PUSH_FACT, FactStreams.FEATURE, 2, 'feature'],
    [ImCommands.PUSH_FACT, FactStreams.TRANSPORT, 2, 'transport'],
  ]);
  const env = invoked[1]!.env;
  assert.deepEqual(Object.keys(env), ['account', 'stream', 'epoch', 'seq', 'fact']);
  assert.deepEqual(env.account, account);
  assert.deepEqual(env.fact, { kind: 'feature', fact: { kind: 'queue_notice', gid: GID } });
  assert.equal(FactStreams.FEATURE, 'im.feature');
});

test('bridge: a host rejection of a feature fact (adapter.invalid_payload) is reported once and never retried', async () => {
  let calls = 0;
  const errors: unknown[] = [];
  const bridge = new AdapterBridge({
    account,
    invoke: () => { calls++; return Promise.reject({ code: 'adapter.invalid_payload', message: 'invalid feature fact: gid', retryable: false }); },
    onPushError: (_env, e) => errors.push(e),
  });
  bridge.push({ kind: 'feature', fact: { kind: 'queue_notice', gid: '' } });
  await bridge.flush();
  assert.equal(calls, 1);
  assert.equal(errors.length, 1);
  assert.equal((errors[0] as { code: string }).code, 'adapter.invalid_payload');
});
