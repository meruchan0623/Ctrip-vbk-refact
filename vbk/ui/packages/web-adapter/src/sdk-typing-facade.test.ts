import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createPageSdk, type ImClientLike } from './sdkGlue.ts';
import { createRpc } from './rpc.ts';
import { ConversationStore, RoleBook } from './stores.ts';
import { SoaClient } from './soa.ts';
import { makeDeps, sampleRow, flush } from './testing.ts';

const GID = '900719925474099312345';
type Callback = () => void;
function setup(options: { method?: 'missing' | 'success' | 'failure' | 'throw' | 'held'; online?: boolean; known?: boolean; room?: boolean; timeoutMs?: number } = {}) {
  const deps = makeDeps(); let generation = 1, running = true, online = options.online ?? true, terminal: ((status: unknown) => void) | undefined;
  let calls = 0, success: Callback = () => {}, failure: Callback = () => {};
  const requests: unknown[] = [], facts: unknown[] = [], displays: unknown[] = [];
  const facade: ImClientLike = { sendMessageInSocket() { assert.fail('typing cannot submit a customer message'); }, getSocketStatus: () => online, setConnectionStatusListener(listener) { terminal = listener.onChanged; }, disconnect() { online = false; } };
  if (options.method !== 'missing') facade.sendInputState = (request, yes, no) => {
    calls++; requests.push(request); success = yes; failure = () => no('websocket not connected');
    if (options.method === 'failure') failure();
    else if (options.method === 'throw') throw new Error('synthetic socket throw');
    else if (options.method !== 'held') yes();
  };
  const window: Record<string, unknown> = { IMClient: facade };
  const sdk = createPageSdk(window, { ...deps, facadeSendTimeoutMs: options.timeoutMs ?? 50, probeIntervalMs: 10 });
  if (options.room !== false) sdk.rememberPartnerJid(GID, `${GID}@muc.im.example/self`);
  const store = new ConversationStore(); if (options.known !== false) store.update([sampleRow(GID)]);
  const rpc = createRpc({ deps: { ...deps, sdk }, sdk, store, soa: new SoaClient(deps), roles: new RoleBook('self'), pushFact: fact => { facts.push(fact); }, pushDisplay: value => { displays.push(value); }, agent: { current: () => null, set() {} }, captureWriteGuard: () => { const captured = generation; return () => running && generation === captured; } });
  let request = 0;
  const call = () => rpc.handle({ req_id: `typing-${++request}`, op: 'typing.send', args: { gid: GID } });
  return { deps, sdk, store, window, requests, facts, displays, call, calls: () => calls, yes: () => success(), no: () => failure(), terminal: (status: number) => terminal?.(status), replace: () => { window.IMClient = { ...facade }; }, stop: () => { running = false; generation++; }, restart: () => { generation++; running = true; } };
}
const data = (response: unknown) => { const value = response as { ok: boolean; data: unknown }; assert.equal(value.ok, true); return value.data; };

test('actual PageSdk → RPC typing sends only the public bare-gid group model and returns socket handoff without message confirmation', async () => {
  const f = setup();
  assert.deepEqual(data(await f.call()), { sent: true });
  assert.deepEqual(f.requests, [{ partnerJid: GID, conversationType: 'groupchat' }]);
  assert.equal('status' in (f.requests[0] as object), false, 'omit status to retain the captured SDK default 0');
  assert.deepEqual(data(await f.call()), { sent: false, reason: 'throttled' });
  assert.equal(f.calls(), 1); assert.deepEqual(f.facts, []); assert.deepEqual(f.displays, []);
  assert.equal(f.deps.fakeFetch.calls.length, 0); f.sdk.dispose();
});

for (const [label, options, reason] of [
  ['missing facade capability', { method: 'missing' }, 'unsupported'],
  ['unknown conversation', { known: false }, 'unknown_conversation'],
  ['missing cached room', { room: false }, 'not_sent'],
  ['offline socket', { online: false }, 'not_sent'],
  ['failure callback', { method: 'failure' }, 'not_sent'],
  ['synchronous exception', { method: 'throw' }, 'not_sent'],
] as const) test(`typing ${label} never creates an HTTP fallback or message submission`, async () => {
  const f = setup(options); assert.deepEqual(data(await f.call()), { sent: false, reason });
  assert.equal(f.deps.fakeFetch.calls.length, 0); assert.deepEqual(f.facts, []); f.sdk.dispose();
});

test('void facade returns wait for callback, time out false, release throttle and ignore a late success', async () => {
  const f = setup({ method: 'held' }); const pending = f.call(); let settled = false; void pending.then(() => { settled = true; });
  await flush(); assert.equal(settled, false);
  await f.deps.clock.advance(50); assert.deepEqual(data(await pending), { sent: false, reason: 'not_sent' });
  f.yes(); await flush();
  const retry = f.call(); assert.equal(f.calls(), 2, 'known non-handoff failure releases the throttle but never retries itself');
  f.no(); assert.deepEqual(data(await retry), { sent: false, reason: 'not_sent' }); f.sdk.dispose();
});

for (const boundary of ['dispose', 'terminal4', 'terminal6', 'terminal8', 'facade', 'emitter', 'session', 'row'] as const) test(`typing ignores callbacks after ${boundary} lifecycle invalidation`, async () => {
  const f = setup({ method: 'held' }); const pending = f.call(); assert.equal(f.calls(), 1);
  if (boundary === 'dispose') f.sdk.dispose();
  else if (boundary.startsWith('terminal')) f.terminal(Number(boundary.slice(8)));
  else if (boundary === 'facade') f.replace();
  else if (boundary === 'emitter') f.window.xmppClient = new EventEmitter();
  else if (boundary === 'session') { f.stop(); f.restart(); }
  else f.store.update([sampleRow(GID, { sessionId: 'replacement-service' })]);
  f.yes(); f.no();
  assert.deepEqual(data(await pending), { sent: false, reason: 'not_sent' });
  if (boundary === 'dispose' || boundary.startsWith('terminal')) { assert.deepEqual(data(await f.call()), { sent: false, reason: 'not_sent' }); assert.equal(f.calls(), 1); }
  assert.equal(f.deps.fakeFetch.calls.length, 0); f.sdk.dispose();
});

test('stopped RPC refuses a new typing operation even if the official facade remains online', async () => {
  const f = setup(); f.stop(); assert.deepEqual(data(await f.call()), { sent: false, reason: 'not_sent' }); assert.equal(f.calls(), 0); f.sdk.dispose();
});


test('an old facade timeout cannot release the 3-second throttle of a newer successful handoff', async () => {
  const f = setup({ method: 'held', timeoutMs: 15000 });
  const old = f.call();
  await f.deps.clock.advance(3000);
  const second = f.call(); f.yes(); assert.deepEqual(data(await second), { sent: true });
  await f.deps.clock.advance(11000);
  const third = f.call(); f.yes(); assert.deepEqual(data(await third), { sent: true });
  await f.deps.clock.advance(1000);
  assert.deepEqual(data(await old), { sent: false, reason: 'not_sent' });
  assert.deepEqual(data(await f.call()), { sent: false, reason: 'throttled' });
  assert.equal(f.calls(), 3);
  assert.equal(f.deps.fakeFetch.calls.length, 0); f.sdk.dispose();
});
