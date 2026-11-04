import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AdapterFactEnvelope } from '../../ipc/src/contracts.ts';
import { createPageSdk } from './sdkGlue.ts';
import { createPageSession } from './session.ts';
import { createSendIntent, submitIntent } from './send.ts';
import { flush, jsonResponse, makeDeps, OK_STATUS, sampleRow } from './testing.ts';

function harness() {
  const base = makeDeps(call => jsonResponse(call.url.includes('getConversationList')
    ? { ResponseStatus: OK_STATUS, conversationList: [sampleRow('g1')], currentStatus: 0, lastUpdateTime: base.now() }
    : { ResponseStatus: OK_STATUS, messages: [], lastMessageTimestamp: base.now() }));
  const hooks = new Map<string, ((...args: unknown[]) => void)[]>();
  const xmpp = { status: 'online', on(name: string, cb: (...args: unknown[]) => void) { hooks.set(name, [...(hooks.get(name) ?? []), cb]); }, removeListener(name: string, cb: (...args: unknown[]) => void) { hooks.set(name, (hooks.get(name) ?? []).filter(f => f !== cb)); }, listeners(name: string) { return hooks.get(name) ?? []; } };
  const statuses: ((status: unknown) => void)[] = [];
  let disconnects = 0, destroys = 0, registrations = 0, sdkPolls = 0;
  let sdkTimer: unknown = null;
  const sdkPoll = () => { sdkPolls++; sdkTimer = base.setTimeout(sdkPoll, 1000); };
  sdkTimer = base.setTimeout(sdkPoll, 1000);
  const facade = {
    setConnectionStatusListener({ onChanged }: { onChanged: (status: unknown) => void }) { registrations++; statuses.push(onChanged); },
    disconnect() { disconnects++; base.clearTimeout(sdkTimer); for (const cb of statuses) cb(6); },
    destroy() { destroys++; },
    sendMessageInSocket() {},
    getSocketStatus() { return true; },
  };
  const win: Record<string, unknown> = { IMClient: facade, xmppClient: xmpp };
  const sdk = createPageSdk(win, base), deps = { ...base, sdk };
  const session = createPageSession(deps, { account: { account_id: 'a', environment: 'production', session_generation: 1 }, selfUid: 'me', beginMsgTime: base.now(), initialEpoch: 1, sdk, pushDisplay: async () => null, unreadDebounceMs: 1 });
  const status = (value: unknown) => { for (const cb of statuses) cb(value); };
  const facts = () => base.invoked.map(i => i.payload as AdapterFactEnvelope).filter(e => e.fact?.kind === 'auth_invalid');
  return { base, deps, win, facade, sdk, session, status, facts, statuses, counts: () => ({ disconnects, destroys, registrations, sdkPolls }) };
}

for (const code of [4, 6, 8] as const) {
  test(`real facade terminal ${code} stops SDK and session polling, invalidates once and never reconnects`, async () => {
    const h = harness();
    h.session.start(); await h.base.clock.advance(10);
    h.status(code); h.status(code); h.status(1);
    await h.session.adapter.bridge.flush();
    assert.equal(h.sdk.terminalStatus, code);
    assert.equal(h.sdk.canSend, false);
    assert.equal(h.sdk.attached, false);
    assert.equal(h.session.adapter.running, false);
    assert.equal(h.session.adapter.compensation.running, false);
    assert.equal(h.session.adapter.conversationPollers.every(p => !p.running), true);
    assert.equal(h.facts().length, 1);
    const calls = h.base.fakeFetch.calls.length, polls = h.counts().sdkPolls;
    await h.base.clock.advance(120_000);
    assert.equal(h.base.fakeFetch.calls.length, calls);
    assert.equal(h.counts().sdkPolls, polls);
    assert.deepEqual(h.counts(), { disconnects: 1, destroys: 0, registrations: 1, sdkPolls: polls });
    assert.equal(h.base.clock.pendingCount(), 0);
    const reply = await h.session.rpc.handle({ req_id: 'send', op: 'im.send_text', args: { gid: 'g1', local_id: 'new', text: 'must not send' } });
    assert.equal(reply?.ok, false);
    h.sdk.dispose();
  });
}

test('target token, ordinary network states, malformed and string codes never invalidate this account', async () => {
  const h = harness(); h.session.start();
  for (const code of [-1, 0, 1, 2, 3, 5, 7, 9, '6', null, {}, new Error('network unavailable')]) h.status(code);
  await h.base.clock.advance(11_000); await h.session.adapter.bridge.flush();
  assert.equal(h.sdk.terminalStatus, null);
  assert.equal(h.session.adapter.running, true);
  assert.equal(h.facts().length, 0);
  assert.equal(h.counts().disconnects, 0);
  assert.ok(h.base.fakeFetch.calls.filter(c => c.url.includes('getConversationList')).length > 1);
  h.session.stop(); h.sdk.dispose(); h.facade.disconnect();
});

test('terminal captured before session start is latched and prevents initial polling', async () => {
  const h = harness(); h.status(6); h.session.start();
  await h.session.adapter.bridge.flush();
  assert.equal(h.facts().length, 1);
  assert.equal(h.base.fakeFetch.calls.length, 0);
  assert.equal(h.session.adapter.running, false);
  h.sdk.dispose();
});

test('disposed and replaced facade callbacks cannot invalidate or disconnect a successor', async () => {
  const h = harness(), old = h.statuses[0]!;
  const nextCallbacks: ((status: unknown) => void)[] = [];
  let nextDisconnects = 0;
  const next = { ...h.facade, setConnectionStatusListener({ onChanged }: { onChanged: (status: unknown) => void }) { nextCallbacks.push(onChanged); }, disconnect() { nextDisconnects++; } };
  h.win['IMClient'] = next;
  old(6); assert.equal(h.sdk.terminalStatus, null);
  await h.base.clock.advance(1000);
  old(6); assert.equal(h.sdk.terminalStatus, null);
  assert.equal(nextCallbacks.length, 1);
  h.sdk.dispose(); nextCallbacks[0]!(6);
  assert.equal(nextDisconnects, 0);
  assert.equal(h.counts().disconnects, 0);
  h.facade.disconnect();
});

test('facade observation re-registers after handle disposal, preserves other listeners and rejects old disposal callbacks', async () => {
  const h = harness(); let officialEvents = 0;
  h.statuses.push(() => { officialEvents++; });
  h.sdk.dispose();
  const next = createPageSdk(h.win, h.base);
  assert.equal(h.counts().registrations, 2);
  h.status(6);
  assert.equal(h.sdk.terminalStatus, null);
  assert.equal(next.terminalStatus, 6);
  assert.equal(h.counts().disconnects, 1);
  assert.equal(h.counts().destroys, 0);
  assert.ok(officialEvents > 0);
  next.dispose();
});

test('terminal after a stopped session sends no stale lifecycle fact and outstanding sends stay unknown', async () => {
  const h = harness(); h.session.start(); await flush();
  h.sdk.rememberPartnerJid('g1', 'g1@conf');
  const send = submitIntent(h.deps, h.sdk, createSendIntent(h.deps, 'g1', 'pending', { serviceType: '1513', threadId: '' }), 100);
  h.session.stop(); h.status(6); await h.base.clock.advance(100); await h.session.adapter.bridge.flush();
  assert.deepEqual((await send).disposition, { kind: 'unknown' });
  assert.equal(h.facts().length, 0);
  h.sdk.dispose(); assert.equal(h.base.clock.pendingCount(), 0);
});

test('terminal during SDK readiness releases boot immediately instead of waiting for the readiness timeout', async () => {
  const base = makeDeps(); let changed!: (status: unknown) => void;
  const sdk = createPageSdk({ IMClient: { setConnectionStatusListener({ onChanged }: { onChanged: (status: unknown) => void }) { changed = onChanged; }, disconnect() {} } }, base);
  const waiting = sdk.waitReady(30_000);
  changed(6);
  assert.equal(await waiting, false);
  assert.equal(await sdk.waitReady(30_000), false);
  assert.equal(base.clock.pendingCount(), 0);
  sdk.dispose();
});

test('a new handle can observe the same facade after official reset removed its old listener', () => {
  const h = harness(); h.sdk.dispose();
  h.statuses.length = 0; // Official destroy() clears its emitter before re-init.
  const next = createPageSdk(h.win, h.base);
  assert.equal(h.counts().registrations, 2);
  h.status(8);
  assert.equal(next.terminalStatus, 8);
  assert.equal(h.counts().disconnects, 1);
  next.dispose();
});
