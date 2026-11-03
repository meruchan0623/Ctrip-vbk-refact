import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOST_UNAVAILABLE, createTauriIpc, hasTauri } from './client.ts';
import { CONTRACT_VERSION, ErrorCodes, isAppError } from './contracts.ts';

const g = globalThis as unknown as Record<string, unknown>;

function withWindow(fn: () => Promise<void>): Promise<void> {
  const saved = g['window'];
  return fn().finally(() => {
    if (saved === undefined) delete g['window'];
    else g['window'] = saved;
  });
}

test('createTauriIpc never throws without window.__TAURI__; invoke rejects with an AppError, listen is a no-op', () =>
  withWindow(async () => {
    delete g['window'];
    assert.equal(hasTauri(), false);
    let ipc: ReturnType<typeof createTauriIpc> | null = null;
    assert.doesNotThrow(() => {
      ipc = createTauriIpc();
    });
    const client = ipc as unknown as ReturnType<typeof createTauriIpc>;
    await assert.rejects(client.invoke('notify_snapshot'), (e: unknown) => isAppError(e) && e.code === HOST_UNAVAILABLE);
    const off = client.listen('notify://alarm-snapshot', () => assert.fail('no event without a host'));
    assert.equal(typeof off, 'function');
    assert.doesNotThrow(off);
    // a partially injected global (no event API) is treated the same way
    g['window'] = { __TAURI__: { core: { invoke: async () => 1 } } };
    assert.equal(hasTauri(), false);
    assert.doesNotThrow(() => createTauriIpc().listen('x', () => undefined)());
    await assert.rejects(createTauriIpc().invoke('x'), (e: unknown) => isAppError(e) && e.code === HOST_UNAVAILABLE);
  }));

test('createTauriIpc resolves the host globals lazily and unsubscribes correctly', () =>
  withWindow(async () => {
    delete g['window'];
    const ipc = createTauriIpc(); // created before the host injects its globals
    const calls: unknown[] = [];
    let handler: ((ev: { payload: unknown }) => void) | null = null;
    let unlistened = 0;
    g['window'] = {
      __TAURI__: {
        core: {
          invoke: async (cmd: string, args: unknown) => {
            calls.push([cmd, args]);
            return { ok: cmd };
          },
        },
        event: {
          listen: async (_name: string, h: (ev: { payload: unknown }) => void) => {
            handler = h;
            return () => {
              unlistened += 1;
            };
          },
        },
      },
    };
    assert.equal(hasTauri(), true);
    assert.deepEqual(await ipc.invoke('prefs_snapshot'), { ok: 'prefs_snapshot' });
    assert.deepEqual(
      calls,
      [
        ['contract_hello', { version: CONTRACT_VERSION }],
        ['prefs_snapshot', {}],
      ],
      'the first call announces the contract version; a missing payload is sent as an empty object',
    );
    const got: unknown[] = [];
    const off = ipc.listen<unknown>('prefs://changed', (p) => got.push(p));
    await Promise.resolve();
    const h = handler as ((ev: { payload: unknown }) => void) | null;
    assert.ok(h);
    h({ payload: 1 });
    off();
    h({ payload: 2 });
    assert.deepEqual(got, [1], 'events after unsubscribe are not delivered');
    assert.equal(unlistened, 1);
  }));

function hostWith(invoke: (cmd: string, args: unknown) => Promise<unknown>): void {
  g['window'] = { __TAURI__: { core: { invoke }, event: { listen: async () => () => undefined } } };
}

test('contract handshake: hello is sent once, before and not again after the first command', () =>
  withWindow(async () => {
    const calls: string[] = [];
    hostWith(async (cmd) => {
      calls.push(cmd);
      return null;
    });
    const ipc = createTauriIpc();
    await Promise.all([ipc.invoke('notify_snapshot'), ipc.invoke('prefs_snapshot')]);
    await ipc.invoke('prefs_snapshot');
    assert.deepEqual(calls.filter((c) => c === 'contract_hello'), ['contract_hello']);
    assert.equal(calls[0], 'contract_hello', 'hello goes out before any other command');
    assert.equal(calls.length, 4);
  }));

test('contract handshake: a host that rejects the version blocks every command of the window', () =>
  withWindow(async () => {
    const calls: string[] = [];
    const mismatch = { code: ErrorCodes.HOST_CONTRACT_MISMATCH, message: 'contract version 1 is not supported', retryable: false };
    hostWith(async (cmd) => {
      calls.push(cmd);
      if (cmd === 'contract_hello') throw mismatch;
      return 'should not be reached';
    });
    const ipc = createTauriIpc();
    for (const cmd of ['notify_snapshot', 'prefs_snapshot', 'account_snapshot']) {
      await assert.rejects(ipc.invoke(cmd), (e: unknown) => isAppError(e) && e.code === ErrorCodes.HOST_CONTRACT_MISMATCH);
    }
    assert.deepEqual(calls, ['contract_hello'], 'no business command reaches the host, and hello is not retried');
  }));

test('contract handshake: a transient hello failure is retried by the next call', () =>
  withWindow(async () => {
    const calls: string[] = [];
    let first = true;
    hostWith(async (cmd) => {
      calls.push(cmd);
      if (cmd === 'contract_hello' && first) {
        first = false;
        throw { code: 'host.unavailable', message: 'starting', retryable: true };
      }
      return null;
    });
    const ipc = createTauriIpc();
    await assert.rejects(ipc.invoke('prefs_snapshot'));
    await ipc.invoke('prefs_snapshot');
    assert.deepEqual(calls, ['contract_hello', 'contract_hello', 'prefs_snapshot']);
  }));
