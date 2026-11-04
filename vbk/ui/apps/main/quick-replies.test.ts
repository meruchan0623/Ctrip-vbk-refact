import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQuickReplies, flattenReplyCategories, filteredReplyCategories, type ReplyContext, type QuickRepliesState } from './quick-replies.ts';
import { UiCommands, type UiQuickReplyScript } from '../../packages/ipc/src/client.ts';

const script: UiQuickReplyScript = { id: 'reply-1', content: '您好，请问需要什么帮助？', short_cut: 'hello', type: 'text' };
const categories = [{ id: 'parent', name: '常用', scripts: [], sub_categories: [{ id: 'child', name: '问候', scripts: [script], sub_categories: [] }] }];
function deferred() { let resolve!: (value: unknown) => void; return { promise: new Promise<unknown>(r => { resolve = r; }), resolve }; }
async function flush() { for (let i = 0; i < 5; i++) await Promise.resolve(); }
function fixture() {
  let context: ReplyContext = { account: { account_id: 'a', environment: 'synthetic', session_generation: 1 }, gid: 'chat-a', revision: 'visit-1', draft: '帮助', version: 1 };
  let state: QuickRepliesState | null = null, time = 0, timerId = 0;
  const calls: { command: string; payload: unknown }[] = [], inserts: { text: string; replace: boolean }[] = [];
  const queue: unknown[] = [], timers = new Map<number, { at: number; callback: () => void }>();
  const controller = createQuickReplies({ current: () => context, publish: value => { state = value; },
    async invoke(command, payload) { calls.push({ command, payload }); const value = await (queue.shift() ?? (command === UiCommands.IM_QUICK_REPLY_CATEGORIES ? { categories } : { kind: 'ready', raw_count: 1, items: [script] })); if (value instanceof Error) throw value; return value; },
    insert: (text, replace) => inserts.push({ text, replace }),
    setTimer(callback, ms) { const id = ++timerId; timers.set(id, { at: time + ms, callback }); return id; }, clearTimer(id) { timers.delete(id as number); },
  });
  return { controller, calls, inserts, get state() { return state; }, patch(patch: Partial<ReplyContext>) { context = { ...context, ...patch }; }, queue(value: unknown) { queue.push(value); },
    advance(ms: number) { time += ms; for (const [id, timer] of timers) if (timer.at <= time) { timers.delete(id); timer.callback(); } },
  };
}

test('personal/team categories load, retain nested replies and filter without remote writes', async () => {
  const f = fixture(); await f.controller.open();
  assert.equal(f.state?.type, 'VAGENT'); assert.equal(f.state?.busy, false);
  assert.deepEqual(flattenReplyCategories(f.state!.categories).map(c => c.id), ['parent', 'child']);
  f.controller.filter('hello'); assert.equal(f.state?.query, 'hello'); assert.equal(f.calls.length, 1);
  await f.controller.open('VSKILLGROUP'); assert.equal(f.state?.type, 'VSKILLGROUP'); assert.equal(f.state?.query, '');
  assert.deepEqual(f.calls.map(c => c.payload), ['VAGENT', 'VSKILLGROUP'].map(type => ({ account: { account_id: 'a', environment: 'synthetic', session_generation: 1 }, type })));
  f.controller.select({ ...script, id: 'forged' }); assert.deepEqual(f.inserts, []);
  f.controller.select(script); assert.deepEqual(f.inserts, [{ text: script.content, replace: false }]); assert.equal(f.state, null);
  assert.deepEqual(f.calls.map(c => c.command), [UiCommands.IM_QUICK_REPLY_CATEGORIES, UiCommands.IM_QUICK_REPLY_CATEGORIES]);
});

test('suggestions debounce for 200 ms and replace a current draft without sending', async () => {
  const f = fixture(); f.controller.suggest(); f.advance(199); await flush(); assert.equal(f.calls.length, 0);
  f.patch({ draft: ' 最新草稿 ', version: 2 }); f.controller.suggest(); f.advance(199); await flush(); assert.equal(f.calls.length, 0);
  f.advance(1); await flush(); assert.deepEqual(f.calls, [{ command: UiCommands.IM_CUSTOMER_SCRIPTS, payload: { account: { account_id: 'a', environment: 'synthetic', session_generation: 1 }, content: '最新草稿' } }]);
  assert.equal(f.state?.mode, 'suggestions'); f.controller.select(script);
  assert.deepEqual(f.inserts, [{ text: script.content, replace: true }]); assert.equal(f.state, null);
});

test('draft versions and conversation revisions reject late suggestions and stale selections', async () => {
  for (const patch of [{ version: 2 }, { revision: 'visit-2' }, { gid: 'chat-b' }]) {
    const f = fixture(), pending = deferred(); f.queue(pending.promise); f.controller.suggest(); f.advance(200);
    f.patch(patch); pending.resolve({ kind: 'ready', raw_count: 1, items: [script] }); await flush(); assert.equal(f.state, null);
  }
  const f = fixture(); f.controller.suggest(); f.advance(200); await flush(); f.patch({ version: 2 }); f.controller.select(script); assert.deepEqual(f.inserts, []);
  f.controller.close(); f.patch({ draft: '   ' }); f.controller.suggest(); f.advance(200); await flush(); assert.equal(f.calls.length, 1);
});

test('latest category open and close win over late success/failure; scope changes prevent insertion', async () => {
  for (const result of [{ categories: [] }, new Error('late failure')]) {
    const f = fixture(), pending = deferred(); f.queue(pending.promise); const old = f.controller.open(); await f.controller.open('VSKILLGROUP'); const expected = f.state;
    pending.resolve(result); await old; assert.equal(f.state, expected);
    f.patch({ revision: 'visit-2' }); f.controller.select(script); assert.deepEqual(f.inserts, []);
  }
  const f = fixture(), pending = deferred(); f.queue(pending.promise); const old = f.controller.open(); f.controller.close(); pending.resolve({ categories }); await old; assert.equal(f.state, null);
});


test('search index retains normalized results and rebuilds for a new category snapshot', () => {
  const initial = filteredReplyCategories(categories, ' HELLO ');
  assert.equal(initial[0]?.scripts[0], script);
  assert.equal(filteredReplyCategories(categories, 'hello'), initial);
  assert.equal(filteredReplyCategories(categories, 'not found').length, 0);
  assert.equal(filteredReplyCategories(categories, '帮助')[0]?.scripts[0], script);
  const replacement = [{ ...categories[0]!, sub_categories: [], scripts: [{ ...script, content: 'new', short_cut: 'next' }] }];
  assert.equal(filteredReplyCategories(replacement, 'hello').length, 0);
  assert.equal(filteredReplyCategories(replacement, 'next')[0]?.scripts[0]?.content, 'new');
  assert.equal(filteredReplyCategories(categories, '').flatMap(c => c.scripts).length, 1);
});
