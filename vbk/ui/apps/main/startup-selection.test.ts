import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
const start = source.indexOf('async function loadForActiveAccount():');
const end = source.indexOf('\nasync function loadNotices(', start);
assert.ok(start >= 0 && end > start);
const body = stripTypeScriptTypes(source.slice(start, end));

for (const selected of [null, 'synthetic-selected-room']) {
  test(`account refresh preserves explicit selection ${selected ?? 'none'} without opening a room`, async () => {
    const row = { gid: 'synthetic-selected-room' };
    const state = { conversations: [], noticeCats: [], noticeCat: null, activeGid: selected, agent: null, net: null };
    const opened: unknown[] = [];
    const env = {
      activeAccount: () => ({ context: { account_id: 'synthetic-account', environment: 'synthetic', session_generation: 1 } }),
      invokeQuiet: async (command: string) => command === 'convs' ? [row] : command === 'cats' ? [] : null,
      UiCommands: { IM_CONVERSATIONS: 'convs', ACCOUNT_AGENT_STATUS: 'agent', NET_STATUS: 'net', NOTICE_CATEGORIES: 'cats' },
      stillActive: () => true,
      S: () => state,
      isUiConversation: () => true,
      isUiAgentStatus: () => false,
      isUiNetStatus: () => false,
      store: { patch: (patch: object) => Object.assign(state, patch) },
      loadNotices: async () => undefined,
      filterConversations: () => [row],
      openConversation: async (gid: unknown) => { opened.push(gid); },
    };
    const load = new Function(...Object.keys(env), body + '\nreturn loadForActiveAccount;')(...Object.values(env)) as () => Promise<void>;
    await load();
    assert.deepEqual(opened, [], 'background account refresh must not open a room or acknowledge its unread messages');
    assert.equal(state.activeGid, selected);
    assert.deepEqual(state.conversations, [row]);
  });
}
