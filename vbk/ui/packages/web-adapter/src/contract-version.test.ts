import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONTRACT_VERSION, CONTRACT_VERSION_MISMATCH } from '../../ipc/src/contracts.ts';
import { AdapterCommands } from '../../ipc/src/adapterProtocol.ts';
import { hostArgs, resolveHostBridge } from './boot.ts';

test('remote native bridge versions ready, identity, facts and direct RPC replies without changing named payloads', async () => {
  for (const flavor of ['api', 'internals'] as const) {
    const calls: { cmd: string; args: unknown }[] = [];
    const invoke = async (cmd: string, args: unknown) => { calls.push({ cmd, args }); return null; };
    const globals = flavor === 'api'
      ? { __TAURI__: { core: { invoke }, event: { listen: async () => () => undefined } } }
      : { __TAURI_INTERNALS__: { invoke, transformCallback: () => 1 } };
    const host = resolveHostBridge(globals);
    assert.ok(host);
    for (const cmd of [AdapterCommands.READY, AdapterCommands.IDENTITY, AdapterCommands.PUSH_FACT, AdapterCommands.REPLY]) {
      const payload = { req_id: 'synthetic', account: null };
      await host.invoke(cmd, { ...hostArgs(cmd, payload), _contract_version: 999 });
      const last = calls.at(-1);
      assert.deepEqual(last, { cmd, args: { ...hostArgs(cmd, payload), _contract_version: CONTRACT_VERSION } });
    }
  }
});

test('remote native bridge propagates version mismatch once without retry', async () => {
  let attempts = 0;
  const host = resolveHostBridge({ __TAURI_INTERNALS__: {
    invoke: async () => { attempts += 1; throw { code: CONTRACT_VERSION_MISMATCH, retryable: false }; },
    transformCallback: () => 1,
  } });
  assert.ok(host);
  await assert.rejects(host.invoke(AdapterCommands.READY, hostArgs(AdapterCommands.READY, {})), { code: CONTRACT_VERSION_MISMATCH });
  assert.equal(attempts, 1);
});
