import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockIpc } from './mock.ts';
import { AccountCommands } from './commands.ts';
import { UiCommands, type UiAccountSnapshot, type UiConversation, type UiMessage } from './client.ts';
import { ErrorCodes } from './contracts.ts';

test('mock read receipt requires current observed message and never clears unread on acknowledgment', async () => {
  const ipc = createMockIpc('default', { latency: 0, tick: false });
  try {
    const snapshot = await ipc.invoke<UiAccountSnapshot>(AccountCommands.SNAPSHOT);
    const account = snapshot.accounts.find(a => a.context.account_id === snapshot.active_account_id)!.context;
    const conversations = () => ipc.invoke<UiConversation[]>(UiCommands.IM_CONVERSATIONS, { account });
    const conversation = (await conversations()).find(c => c.unread_count > 0)!;
    const messages = await ipc.invoke<UiMessage[]>(UiCommands.IM_MESSAGES, { account, gid: conversation.gid });
    const latest = messages.at(-1)!.message_id;
    assert.ok(latest);
    const args = { account, gid: conversation.gid, expected_context_revision: conversation.assistant_context_revision };
    for (const expected_message_id of [undefined, null, '', 123, 'unseen']) {
      await assert.rejects(ipc.invoke(UiCommands.IM_MARK_READ, { ...args, expected_message_id }), (e: unknown) => (e as { code: string }).code === ErrorCodes.ADAPTER_FAILED);
      assert.equal((await conversations()).find(c => c.gid === conversation.gid)!.unread_count, conversation.unread_count);
    }
    for (const expected_context_revision of [undefined, null, '', 123, 'stale-context']) {
      await assert.rejects(ipc.invoke(UiCommands.IM_MARK_READ, { ...args, expected_message_id: latest, expected_context_revision }), (e: unknown) => (e as { code: string }).code === ErrorCodes.ADAPTER_FAILED);
    }
    assert.equal(await ipc.invoke(UiCommands.IM_MARK_READ, { ...args, expected_message_id: latest }), null);
    const after = (await conversations()).find(c => c.gid === conversation.gid)!;
    assert.equal(after.unread_count, conversation.unread_count);
    assert.equal(after.waiting_since_ms, conversation.waiting_since_ms);
  } finally { ipc.dispose(); }
});
