import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { renderMessageAvatar } from './message-profile.ts';
import { initialOf } from '../../packages/ui-kit/src/format.ts';
import { cx } from '../../packages/ui-kit/src/h.ts';

// Execute the actual main render functions with a synthetic DOM factory, without booting a webview.
const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
interface RenderNode { tag: string; props?: Record<string, unknown>; children?: unknown[]; src?: string; alt?: string; referrerPolicy?: string; onerror?: unknown }
const avatarA = 'https://dimg04.c-ctrip.com/synthetic-customer.png';
const avatarB = 'https://dimg04.c-ctrip.com/synthetic-colleague.png';
function nodes(tree: unknown): RenderNode[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== 'object') return [];
  const node = tree as RenderNode;
  return [node, ...nodes(node.children ?? [])];
}
function render(name: 'conversationList' | 'chatPane' | 'peripheralDialog', next: string, state: Record<string, unknown>, conv: Record<string, unknown>) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf(`\nfunction ${next}(`, start);
  assert.ok(start >= 0 && end > start);
  const body = stripTypeScriptTypes(source.slice(start, end));
  const doc = {
    createElement: (tag: string) => ({ tag, replaceWith() {} }),
    createTextNode: (text: string) => ({ tag: '#text', text }),
    querySelector: () => null,
  };
  const env = {
    document: doc, renderMessageAvatar, initialOf, cx,
    h: (tag: string, props: Record<string, unknown> | null, ...children: unknown[]) => ({ tag, props: props ?? {}, children }),
    icon: () => ({ tag: 'icon' }), IC: {}, t: (key: string) => key,
    tabCounts: () => ({ doing: 1, done: 0 }), filterConversations: () => [conv],
    activeAccount: () => ({ context: { account_id: 'synthetic-account' }, state: 'online', avatar: 'https://example.invalid/never-use-account.png' }),
    activeConv: () => conv, agentView: () => ({}), netView: () => ({ offline: false }),
    MARK_COLORS: [], isDone: () => false, langName: (lang: string) => lang,
    accBadge: () => null, formatRelativeTime: () => '', stillActive: () => true,
    visibleMessages: () => [], composer: () => null, emojiPicker: () => null,
    S: () => state, peripheralWriteView: () => null, notWired: (node: RenderNode) => node,
  };
  return new Function(...Object.keys(env), body + `\nreturn ${name};`)(...Object.values(env))(state) as RenderNode;
}
function fixture(avatar: string | null | undefined) {
  const conv = { gid: 'synthetic-room', title: 'Customer', color: '#aaa', lang: 'zh', biz: 'synthetic', service_type: 'synthetic', waiting_since_ms: null, waiting_confirmed: false, last_message_time_ms: null, preview: '', draft: '', mark: 0, is_top: false, vendor_name: '', customer_avatar: avatar };
  const state = { conversations: [conv], drafts: {}, activeGid: conv.gid, messages: {}, history: {}, query: '', tab: 'doing', now: 100, sideOpen: false };
  return { conv, state };
}

for (const [name, next] of [['conversationList', 'contextMenu'], ['chatPane', 'messagesView']] as const) {
  test(`${name} uses the customer's API avatar, never the account avatar; missing and unsafe stay placeholders`, () => {
    for (const avatar of [avatarA, null, undefined, 'javascript:synthetic']) {
      const { conv, state } = fixture(avatar);
      const images = nodes(render(name, next, state, conv)).filter((node) => node.tag === 'img');
      assert.deepEqual(images.map((image) => image.src), avatar === avatarA ? [avatarA] : []);
      if (images[0]) assert.equal(images[0].alt, 'Customer');
    }
  });
}
