import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockIpc } from './mock.ts';
import { UiCommands } from './client.ts';
import { AccountCommands } from './commands.ts';
import type { UiAccountSnapshot, UiConversation } from './client.ts';
import type { UiServerSearchPage, UiSearchHistoryPage } from './server-search.ts';

test('synthetic search supports four groups, pagination, independent history and empty/error acceptance', async () => {
  const ipc = createMockIpc('default', { tick: false, latency: 0 });
  const snapshot = await ipc.invoke<UiAccountSnapshot>(AccountCommands.SNAPSHOT);
  const account = snapshot.accounts[0]!.context;
  const before = await ipc.invoke<UiConversation[]>(UiCommands.IM_CONVERSATIONS, { account });
  const query = { query_id: 'test', search_type: 3, search_value: 'demo', page_no: 1 };
  const result = await ipc.invoke<UiServerSearchPage>(UiCommands.SERVER_SEARCH, { account, query });
  for (const list of Object.values(result.groups)) assert.ok(list.length > 3);
  const single = await ipc.invoke<UiServerSearchPage>(UiCommands.SERVER_SEARCH, { account, query: { ...query, query_id: 'single', search_type: 0 } });
  const first = single.groups.content[0]!;
  assert.equal(single.has_more, true); assert.equal(single.groups.content.length, 2);
  await ipc.invoke(UiCommands.SERVER_SEARCH, { account, query: { ...query, query_id: 'single', search_type: 0, page_no: 2 } });
  const history = await ipc.invoke<UiSearchHistoryPage>(UiCommands.SEARCH_HISTORY, { account, query: { selection_token: first.selection_token, direction: 'prev' } });
  assert.ok(history.items.length); assert.equal(history.anchor_message_id, first.message_id);
  assert.deepEqual(await ipc.invoke(UiCommands.IM_CONVERSATIONS, { account }), before, 'search/history leave unread and conversation state untouched');
  const empty = await ipc.invoke<UiServerSearchPage>(UiCommands.SERVER_SEARCH, { account, query: { ...query, search_value: 'empty' } });
  assert.equal(Object.values(empty.groups).flat().length, 0);
  await assert.rejects(ipc.invoke(UiCommands.SERVER_SEARCH, { account, query: { ...query, search_value: 'error' } }));
  ipc.dispose();
});
