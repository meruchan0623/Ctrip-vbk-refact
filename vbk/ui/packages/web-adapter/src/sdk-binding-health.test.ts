import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createPageSdk } from './sdkGlue.ts';
import { makeDeps } from './testing.ts';

class Client extends EventEmitter { status = 'online'; reconnect = new EventEmitter(); }
const message = { name: 'message', attrs: { type: 'groupchat', from: 'synthetic-room@muc.example/customer', msgtype: '0', create_time: '1700000000000' }, getChildText: () => 'synthetic' };
function setup(client: unknown = new Client()) {
  const deps = makeDeps();
  const win: Record<string, unknown> = { xmppClient: client, IMClient: { sendMessageInSocket: () => undefined, getSocketStatus: () => true } };
  const sdk = createPageSdk(win, deps);
  return { deps, win, sdk };
}

test('binding health: a missing/non-emitter global detaches, reports disconnected, and cannot inherit facade online', async () => {
  for (const replacement of [undefined, null, {}, { on: 'invalid' }]) {
    const old = new Client(); const { deps, win, sdk } = setup(old); const statuses: string[] = [], messages: unknown[] = [];
    sdk.on('socket_status', value => statuses.push(value)); sdk.on('message', value => messages.push(value));
    const queued = old.listeners('stanza')[0]!;
    win['xmppClient'] = replacement;
    await deps.clock.advance(1000);
    assert.equal(sdk.attached, false); assert.equal(sdk.getSocketStatus(), false);
    assert.equal(old.listenerCount('stanza'), 0); assert.equal(old.listenerCount('status'), 0); assert.equal(old.reconnect.listenerCount('reconnecting'), 0);
    queued(message); assert.equal(messages.length, 0);
    assert.equal(statuses.at(-1), 'disconnected');
    sdk.dispose(); assert.equal(deps.clock.pendingCount(), 0);
  }
});

test('binding health: throwing global lookup fails closed and later valid client attaches normally', async () => {
  const first = new Client(); const { deps, win, sdk } = setup(first);
  Object.defineProperty(win, 'xmppClient', { configurable: true, get: () => { throw new Error('synthetic inaccessible global'); } });
  await deps.clock.advance(1000);
  assert.equal(sdk.attached, false); assert.equal(sdk.getSocketStatus(), false);
  const second = new Client(); Object.defineProperty(win, 'xmppClient', { configurable: true, writable: true, value: second });
  await deps.clock.advance(1000);
  const received: unknown[] = []; sdk.on('message', value => received.push(value)); second.emit('stanza', message);
  assert.equal(sdk.attached, true); assert.equal(sdk.getSocketStatus(), true); assert.equal(received.length, 1);
  sdk.dispose(); assert.equal(deps.clock.pendingCount(), 0);
});

test('binding health: removed owned listeners on the same emitter are repaired without duplicating SDK listeners', async () => {
  const client = new Client(); const official = () => undefined; client.on('stanza', official);
  const { deps, sdk } = setup(client); const received: unknown[] = [];
  sdk.on('message', value => received.push(value));
  const owned = client.listeners('stanza').find(listener => listener !== official)!;
  const queuedStatus = client.listeners('status')[0]!;
  client.removeListener('stanza', owned as (...args: unknown[]) => void);
  await deps.clock.advance(1000);
  client.emit('stanza', message);
  assert.equal(received.length, 1);
  assert.equal(client.listeners('stanza').includes(official), true);
  assert.equal(client.listenerCount('stanza'), 2); assert.equal(client.listenerCount('status'), 1); assert.equal(client.reconnect.listenerCount('reconnecting'), 1);
  await deps.clock.advance(5000);
  assert.equal(client.listenerCount('stanza'), 2);
  const statuses: string[] = []; sdk.on('socket_status', value => statuses.push(value)); queuedStatus('offline');
  assert.equal(statuses.length, 0);
  sdk.dispose(); assert.equal(deps.clock.pendingCount(), 0);
});

test('binding health: replaced client remains positive and already-queued old/disposed events remain fenced', async () => {
  const old = new Client(); const { deps, win, sdk } = setup(old); const received: unknown[] = [];
  sdk.on('message', value => received.push(value)); const oldQueued = old.listeners('stanza')[0]!;
  const next = new Client(); win['xmppClient'] = next; await deps.clock.advance(1000);
  oldQueued(message); next.emit('stanza', message);
  assert.equal(received.length, 1); assert.equal(sdk.attached, true); assert.equal(sdk.getSocketStatus(), true);
  const queued = next.listeners('stanza')[0]!; sdk.dispose(); queued(message);
  assert.equal(received.length, 1); assert.equal(sdk.attached, false); assert.equal(sdk.getSocketStatus(), false);
  assert.equal(deps.clock.pendingCount(), 0);
});

test('binding health: unsupported listener introspection is explicit and never causes blind repeated registration', async () => {
  let registrations = 0;
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const client = { status: 'online', on: (name: string, callback: (...args: unknown[]) => void) => { registrations++; handlers.set(name, callback); }, removeListener: (name: string) => handlers.delete(name) };
  const { deps, sdk } = setup(client);
  handlers.delete('stanza'); await deps.clock.advance(5000);
  assert.equal(registrations, 2);
  assert.equal(sdk.bindingDiagnostics?.listener_health, 'unsupported');
  assert.equal(sdk.attached, true); assert.equal(sdk.getSocketStatus(), true);
  assert.equal(sdk.bindingDiagnostics?.repair_count, 0);
  const diagnostics = sdk.bindingDiagnostics!;
  assert.equal(Object.values(diagnostics).every(value => typeof value === 'boolean' || typeof value === 'number' || ['emitter', 'missing', 'invalid', 'unreadable', 'disposed', 'verified', 'unsupported', 'detached'].includes(String(value))), true);
  sdk.dispose(); assert.equal(deps.clock.pendingCount(), 0);
});

test('binding health: inspectable but non-removable emitter reports loss without multiplying registrations', async () => {
  let registrations = 0;
  const hooks = new Map<string, ((...args: unknown[]) => void)[]>();
  const client = { status: 'online', on: (name: string, callback: (...args: unknown[]) => void) => { registrations++; hooks.set(name, [...(hooks.get(name) ?? []), callback]); }, listeners: (name: string) => hooks.get(name) ?? [] };
  const { deps, sdk } = setup(client);
  hooks.delete('stanza'); await deps.clock.advance(5000);
  assert.equal(sdk.attached, false); assert.equal(sdk.getSocketStatus(), false);
  assert.equal(sdk.bindingDiagnostics?.listener_health, 'missing'); assert.equal(sdk.bindingDiagnostics?.can_rebind, false);
  assert.equal(sdk.bindingDiagnostics?.repair_count, 0); assert.equal(registrations, 2);
  sdk.dispose(); assert.equal(deps.clock.pendingCount(), 0);
});

test('binding health: throwing introspection remains explicitly unsupported', async () => {
  const client = new Client(); Object.defineProperty(client, 'listeners', { value: () => { throw new Error('synthetic unsupported API'); } });
  const { deps, sdk } = setup(client);
  await deps.clock.advance(3000);
  assert.equal(sdk.bindingDiagnostics?.listener_health, 'unsupported'); assert.equal(sdk.bindingDiagnostics?.repair_count, 0);
  sdk.dispose(); assert.equal(deps.clock.pendingCount(), 0);
});
