import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockIpc } from './mock.ts';
import { AccountCommands } from './commands.ts';
import { UiCommands, type UiAccountSnapshot, type UiConversation, type UiQuickReplyCategories, type UiCustomerScripts } from './client.ts';
import type { UiRecommendProducts, UiRecommendSend } from './recommend.ts';

test('mock quick replies expose personal/team drafts and keyword suggestions', async () => {
  const ipc = createMockIpc('default', { tick: false, latency: 0 });
  try {
    const account = (await ipc.invoke<UiAccountSnapshot>(AccountCommands.SNAPSHOT)).accounts[0]!.context;
    for (const type of ['VAGENT', 'VSKILLGROUP']) {
      const categories = await ipc.invoke<UiQuickReplyCategories>(UiCommands.IM_QUICK_REPLY_CATEGORIES, { account, type });
      assert.equal(categories.categories[0]!.scripts[0]!.type, type);
    }
    const result = await ipc.invoke<UiCustomerScripts>(UiCommands.IM_CUSTOMER_SCRIPTS, { account, content: ' 您好 ' });
    assert.equal(result.kind, 'ready');
    assert.equal(result.items?.length, 1);
    assert.equal((await ipc.invoke<UiCustomerScripts>(UiCommands.IM_CUSTOMER_SCRIPTS, { account, content: 'no match' })).kind, 'empty');
  } finally { ipc.dispose(); }
});

test('mock product pages consume one explicit selection per send', async () => {
  const ipc = createMockIpc('default', { tick: false, latency: 0 });
  try {
    const account = (await ipc.invoke<UiAccountSnapshot>(AccountCommands.SNAPSHOT)).accounts[0]!.context;
    const gid = (await ipc.invoke<UiConversation[]>(UiCommands.IM_CONVERSATIONS, { account }))[0]!.gid;
    const page = await ipc.invoke<UiRecommendProducts>(UiCommands.IM_RECOMMEND_PRODUCTS, { account, gid, query: '', page_index: 0 });
    assert.equal(page.items.length, 2); assert.equal(page.has_more, true);
    const next = await ipc.invoke<UiRecommendProducts>(UiCommands.IM_RECOMMEND_PRODUCTS, { account, gid, query: '', page_index: 1 });
    assert.equal(next.items.length, 1); assert.equal(next.has_more, false);
    const args = { account, gid, selection_token: page.selection_token, product_id: page.items[0]!.id };
    assert.equal((await ipc.invoke<UiRecommendSend>(UiCommands.IM_SEND_PRODUCT_CARD, { ...args, product_id: next.items[0]!.id })).kind, 'not_submitted');
    assert.equal((await ipc.invoke<UiRecommendSend>(UiCommands.IM_SEND_PRODUCT_CARD, args)).kind, 'confirmed');
    assert.equal((await ipc.invoke<UiRecommendSend>(UiCommands.IM_SEND_PRODUCT_CARD, args)).kind, 'not_submitted');
  } finally { ipc.dispose(); }
});
