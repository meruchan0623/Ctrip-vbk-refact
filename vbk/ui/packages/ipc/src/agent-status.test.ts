import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockIpc } from './mock.ts';
import { UiCommands, UiEvents, type UiAccountSnapshot, type UiAgentStatusEvent } from './client.ts';
import { AccountCommands } from './commands.ts';

test('mock state read/write and broadcast remain bound to the requested account', async () => {
  const ipc = createMockIpc('default', { latency: 0 });
  const snap = await ipc.invoke<UiAccountSnapshot>(AccountCommands.SNAPSHOT);
  const a = snap.accounts[0]!.context, b = snap.accounts[1]!.context;
  const events: UiAgentStatusEvent[] = [];
  ipc.listen<UiAgentStatusEvent>(UiEvents.AGENT_STATUS, e => events.push(e));
  await ipc.invoke(UiCommands.ACCOUNT_SET_AGENT_STATUS, { account: a, status: 'getoff' });
  assert.deepEqual(await ipc.invoke(UiCommands.ACCOUNT_AGENT_STATUS, { account: b }), { status: 'online', confirmed: true });
  assert.deepEqual(await ipc.invoke(UiCommands.ACCOUNT_AGENT_STATUS, { account: a }), { status: 'getoff', confirmed: true });
  assert.deepEqual(events, [{ account: a, status: 'getoff', confirmed: true }]);
  await assert.rejects(ipc.invoke(UiCommands.ACCOUNT_AGENT_STATUS, { account: { ...a, environment: 'other' } }));
});
