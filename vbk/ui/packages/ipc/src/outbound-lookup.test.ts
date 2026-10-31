import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockIpc } from './mock.ts';
import { UiCommands, type UiAccountSnapshot, type UiConversation, type UiOutboundLookup } from './client.ts';
import { AccountCommands } from './commands.ts';
import { ErrorCodes } from './contracts.ts';
test('mock evidence reads expose only identity metadata and enforce exact scope without changing conversation unread state', async () => {
  const ipc = createMockIpc('default', { latency: 0, tick: false });
  try {
    const accounts = await ipc.invoke<UiAccountSnapshot>(AccountCommands.SNAPSHOT);
    const account = accounts.accounts.find(a => a.context.account_id === accounts.active_account_id)!;
    const conversations = await ipc.invoke<UiConversation[]>(UiCommands.IM_CONVERSATIONS, { account: account.context });
    const gid = conversations[0]!.gid;
    assert.deepEqual(await ipc.invoke(UiCommands.IM_UNKNOWN_OUTBOUND, { account: account.context }), []);
    const rows = await ipc.invoke<UiOutboundLookup>(UiCommands.IM_OUTBOUND_LOOKUP, { account: account.context, gid });
    assert.ok(rows.items.length > 0);
    for (const row of rows.items) assert.deepEqual(Object.keys(row).sort(), ['gid', 'local_id', 'message_id', 'sender_role']);
    assert.deepEqual(await ipc.invoke(UiCommands.IM_CONVERSATIONS, { account: account.context }), conversations);
    for (const scope of [{ ...account.context, environment: 'synthetic-other' }, { ...account.context, session_generation: account.context.session_generation + 1 }, { ...account.context, session_generation: account.context.session_generation - 1 }]) {
      for (const cmd of [UiCommands.IM_UNKNOWN_OUTBOUND, UiCommands.IM_OUTBOUND_LOOKUP]) await assert.rejects(ipc.invoke(cmd, { account: scope, gid }), (e: unknown) => (e as { code: string }).code === ErrorCodes.ACCOUNT_STALE_GENERATION);
    }
  } finally { ipc.dispose(); }
});
