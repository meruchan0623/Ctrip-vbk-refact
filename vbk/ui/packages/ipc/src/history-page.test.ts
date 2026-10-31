import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockIpc } from './mock.ts';
import { UiCommands, type UiAccountSnapshot, type UiConversation, type UiMessagePage } from './client.ts';
import { AccountCommands } from './commands.ts';
import { ErrorCodes } from './contracts.ts';

test('history mock: actual handler pages newest thirty then exclusive earlier records, with account/generation isolation', async () => {
  let now = 1700000000000;
  const ipc = createMockIpc('default', { latency: 0, tick: false, now: () => now });
  try {
    const accounts = await ipc.invoke<UiAccountSnapshot>(AccountCommands.SNAPSHOT);
    const account = accounts.accounts.find(a => a.context.account_id === accounts.active_account_id); assert.ok(account);
    const conversations = await ipc.invoke<UiConversation[]>(UiCommands.IM_CONVERSATIONS, { account: account.context });
    const conversation = conversations.find(c => c.status === 'active'); assert.ok(conversation);
    for (let i = 0; i < 45; i++) {
      now++;
      await ipc.invoke(UiCommands.IM_SEND_TEXT, { account: account.context, gid: conversation.gid, local_id: `synthetic-page-${i}`, text: 'synthetic page fixture' });
    }
    const first = await ipc.invoke<UiMessagePage>(UiCommands.IM_MESSAGE_PAGE, { account: account.context, gid: conversation.gid });
    assert.equal(first.items.length, 30); assert.equal(first.has_more, true); assert.equal(first.before_ms, first.items[0]?.create_time_ms);
    const second = await ipc.invoke<UiMessagePage>(UiCommands.IM_MESSAGE_PAGE, { account: account.context, gid: conversation.gid, before_ms: first.before_ms });
    assert.ok(second.items.length > 0); assert.ok(second.items.every(m => m.create_time_ms < first.before_ms!));
    const ids = new Set(first.items.map(m => m.message_id)); assert.ok(second.items.every(m => !ids.has(m.message_id)));
    assert.equal(second.has_more, false); assert.equal(second.before_ms, null);
    await assert.rejects(ipc.invoke(UiCommands.IM_MESSAGE_PAGE, { account: { ...account.context, session_generation: account.context.session_generation + 1 }, gid: conversation.gid }), (e: unknown) => (e as { code: string }).code === ErrorCodes.ACCOUNT_STALE_GENERATION);
    for (const scope of [{ ...account.context, session_generation: account.context.session_generation - 1 }, { ...account.context, environment: 'other' }]) {
      await assert.rejects(ipc.invoke(UiCommands.IM_MESSAGE_PAGE, { account: scope, gid: conversation.gid }), (e: unknown) => (e as { code: string }).code === ErrorCodes.ACCOUNT_STALE_GENERATION);
    }
    await assert.rejects(ipc.invoke(UiCommands.IM_MESSAGE_PAGE, { account: account.context, gid: conversation.gid, before_ms: 123 }), (e: unknown) => (e as { code: string }).code === ErrorCodes.ADAPTER_FAILED);
    const other = accounts.accounts.find(a => a.context.account_id !== account.context.account_id); assert.ok(other);
    await assert.rejects(ipc.invoke(UiCommands.IM_MESSAGE_PAGE, { account: other.context, gid: conversation.gid }), (e: unknown) => (e as { code: string }).code === ErrorCodes.IM_PERMISSION_DENIED);
  } finally { ipc.dispose(); }
});
