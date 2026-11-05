import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createQuickReplies, flattenReplyCategories, filteredReplyCategories, quickRepliesView, replyDialogOpen, type ReplyContext, type QuickRepliesState } from './quick-replies.ts';
import { UiCommands, type UiQuickReplyScript } from '../../packages/ipc/src/client.ts';
import type { QuickReplyManagerOptions } from '../_shared/quick-reply-manager.ts';
import { h, rerender } from '../../packages/ui-kit/src/h.ts';
import { installFakeDom, type FakeElement } from '../../tests/fake-dom.ts';

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

// ---- group column and in-dialog manager (fake DOM)

type ReplyCategory = { id: string; name: string; scripts: UiQuickReplyScript[]; sub_categories: ReplyCategory[] };
const reply = (id: string, content: string, short_cut = ''): UiQuickReplyScript => ({ id, content, short_cut, type: 'text' });
const group = (id: string, name: string, scripts: UiQuickReplyScript[], sub_categories: ReplyCategory[] = []): ReplyCategory => ({ id, name, scripts, sub_categories });
const PERSONAL = [
  group('g-common', 'Common', [reply('p1', 'hello there', 'hi'), reply('p2', 'thank you')], [group('g-common-sub', 'Greeting', [reply('p3', 'good morning')])]),
  group('g-order', 'Orders', [reply('p4', 'order shipped')]),
  group('g-empty', 'Pending', [], [group('g-empty-sub', 'Nothing', [])]),
  group('g-nested', 'Nested only', [], [group('g-nested-sub', 'Leaf', [reply('p5', 'refund policy')])]),
];
const TEAM = [group('t-team', 'Team', [reply('t1', 'team reply')]), group('t-night', 'Night shift', [reply('t2', 'handover')])];
interface MountRecord { host: HTMLElement; options: QuickReplyManagerOptions; calls: string[]; accounts: unknown[]; busy: boolean }
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

function dialog(options: { real?: boolean } = {}) {
  const { root } = installFakeDom();
  let context: ReplyContext | null = { account: { account_id: 'a', environment: 'synthetic', session_generation: 1 }, gid: 'chat-a', revision: 'visit-1', draft: '', version: 1 };
  let state: QuickRepliesState | null = null;
  const lists: Record<string, unknown[]> = { VAGENT: [], VSKILLGROUP: [] };
  const calls: { command: string; payload: { account: unknown; type: string } }[] = [], inserts: string[] = [], mounts: MountRecord[] = [], notices: string[] = [];
  const controller = createQuickReplies({
    current: () => context, publish: value => { state = value; },
    async invoke(command, payload) {
      calls.push({ command, payload: payload as { account: unknown; type: string } });
      const type = (payload as { type: 'VAGENT' | 'VSKILLGROUP' }).type;
      if (command === UiCommands.IM_QUICK_REPLY_CATEGORIES) { const next = lists[type]!.shift(); if (next instanceof Error) throw next; return next ?? { categories: type === 'VAGENT' ? PERSONAL : TEAM }; }
      if (command === UiCommands.IM_QUICK_REPLY_MANAGE_INFO) return { can_edit: true, skill_groups: [] };
      throw new Error(`unexpected ${command}`);
    },
    insert: text => inserts.push(text), setTimer: () => 0, clearTimer() {}, notify: text => notices.push(text),
    ...(options.real ? {} : {
      mountManager(host: HTMLElement, opts: QuickReplyManagerOptions) {
        const record: MountRecord = { host, options: opts, calls: [], accounts: [], busy: false };
        mounts.push(record);
        host.appendChild(h('div', { dataset: { qr: 'root' } }, 'editor'));
        return {
          setAccount(account: unknown) { record.calls.push('setAccount'); record.accounts.push(account); },
          setType() { record.calls.push('setType'); }, async refresh() { record.calls.push('refresh'); },
          busy: () => record.busy,
          destroy() { record.calls.push('destroy'); host.replaceChildren(); },
        };
      },
    }),
  });
  const render = () => rerender(root as unknown as Element, () => quickRepliesView(state, context, controller) ?? h('div', { class: 'none' }), { morph: true });
  const q = (selector: string) => root.querySelector(selector);
  const must = (selector: string) => { const el = q(selector); assert.ok(el, `missing ${selector}`); return el; };
  const click = (selector: string) => { must(selector).dispatch('click'); render(); };
  // The fake DOM does not reflect `disabled` to an attribute, so a morph keeps the old value: rebuild to read it.
  const fresh = () => { (root as unknown as Element).replaceChildren(); render(); };
  const byClass = (cls: string) => root.querySelectorAll('span').filter(el => el.getAttribute('class') === cls);
  return {
    root, controller, calls, inserts, mounts, notices, lists, render, fresh, q, must, click, byClass,
    get state() { return state; },
    patch(patch: Partial<ReplyContext>) { context = { ...context!, ...patch }; },
    drop() { context = null; },
    groups: () => root.querySelectorAll('[data-reply-group]').map(el => el.getAttribute('data-reply-group')),
    pressed: () => [...root.querySelectorAll('[data-reply-group-all]'), ...root.querySelectorAll('[data-reply-group]')].filter(el => el.getAttribute('aria-pressed') === 'true').map(el => el.getAttribute('data-reply-group') ?? 'all'),
    cards: () => root.querySelectorAll('[data-reply-id]').map(el => el.getAttribute('data-reply-id')),
    reads: () => calls.filter(c => c.command === UiCommands.IM_QUICK_REPLY_CATEGORIES).map(c => c.payload.type),
    search(value: string) { const input = must('input[data-fid="reply-search"]'); input.value = value; input.dispatch('input'); render(); },
  };
}

test('replyDialogOpen covers picking and managing but not the inline suggestions', () => {
  assert.equal(replyDialogOpen({ mode: 'categories' } as QuickRepliesState), true);
  assert.equal(replyDialogOpen({ mode: 'manage' } as QuickRepliesState), true);
  assert.equal(replyDialogOpen({ mode: 'suggestions' } as QuickRepliesState), false);
  assert.equal(replyDialogOpen(null), false);
});

test('group column defaults to 全部, lists only top-level groups that hold replies and keeps labels under 全部', async () => {
  const f = dialog(); await f.controller.open(); f.render();
  assert.equal(f.state?.group, null);
  assert.equal(f.must('[data-reply-group-all]').textContent, '全部');
  assert.deepEqual(f.pressed(), ['all']);
  assert.deepEqual(f.groups(), ['g-common', 'g-order', 'g-nested'], 'empty groups (including empty sub-trees) are not listed');
  assert.deepEqual(f.cards(), ['p1', 'p2', 'p3', 'p4', 'p5']);
  assert.deepEqual(f.byClass('reply-card-category').map(el => el.textContent), ['Common', 'Common', 'Greeting', 'Orders', 'Leaf']);
  assert.ok(f.root.textContent.includes('5 条回复'));
});

test('a selected group shows its own and nested replies without category labels', async () => {
  const f = dialog(); await f.controller.open(); f.render();
  f.click('[data-reply-group="g-common"]');
  assert.equal(f.state?.group, 'g-common'); assert.deepEqual(f.pressed(), ['g-common']);
  assert.deepEqual(f.cards(), ['p1', 'p2', 'p3']);
  assert.equal(f.byClass('reply-card-category').length, 0);
  assert.deepEqual(f.byClass('reply-shortcut').map(el => el.textContent), ['hi'], 'shortcuts stay');
  assert.ok(f.root.textContent.includes('3 条回复'));
  f.click('[data-reply-group="g-nested"]'); assert.deepEqual(f.cards(), ['p5']);
  f.click('[data-reply-group-all]'); assert.equal(f.state?.group, null); assert.equal(f.cards().length, 5); assert.equal(f.byClass('reply-card-category').length, 5);
  f.controller.selectGroup('g-empty'); assert.equal(f.state?.group, null, 'a group without replies cannot be selected');
  f.click('[data-reply-id="p5"]'); assert.deepEqual(f.inserts, ['refund policy']); assert.equal(f.state, null);
  assert.deepEqual(f.calls.map(c => c.command), [UiCommands.IM_QUICK_REPLY_CATEGORIES], 'only the list read: inserting never sends');
});

test('search always covers every group and any input returns to 全部', async () => {
  const f = dialog(); await f.controller.open(); f.render();
  f.click('[data-reply-group="g-order"]'); assert.deepEqual(f.cards(), ['p4']);
  f.search('good'); assert.equal(f.state?.group, null); assert.deepEqual(f.pressed(), ['all']); assert.deepEqual(f.cards(), ['p3']);
  f.click('[data-reply-group="g-order"]'); f.search(''); assert.equal(f.state?.group, null, 'clearing the search is input too'); assert.equal(f.cards().length, 5);
  f.search('o'); f.click('[data-reply-group-all]'); assert.equal(f.state?.query, 'o', '全部 keeps the search');
  f.click('[data-reply-group="g-order"]'); assert.equal(f.state?.query, '', 'picking a group leaves the search'); assert.deepEqual(f.cards(), ['p4']);
});

test('switching personal/team returns to 全部 and a group gone after a re-read falls back to 全部', async () => {
  const f = dialog(); await f.controller.open(); f.render();
  f.click('[data-reply-group="g-common"]');
  f.click('button[aria-pressed="false"][class="reply-tab"]'); await settle(); f.render();
  assert.equal(f.state?.type, 'VSKILLGROUP'); assert.equal(f.state?.group, null); assert.deepEqual(f.groups(), ['t-team', 't-night']); assert.deepEqual(f.pressed(), ['all']);
  f.click('[data-reply-group="t-night"]');
  await f.controller.open('VSKILLGROUP'); assert.equal(f.state?.group, 't-night', 'refreshing the same list keeps a group that still has replies');
  f.lists['VSKILLGROUP']!.push({ categories: [TEAM[0], group('t-night', 'Night shift', [])] });
  await f.controller.open('VSKILLGROUP'); f.render(); assert.equal(f.state?.group, null, 'emptied group'); assert.deepEqual(f.pressed(), ['all']); assert.deepEqual(f.groups(), ['t-team']);
  f.click('[data-reply-group="t-team"]');
  f.lists['VSKILLGROUP']!.push({ categories: [TEAM[1]] });
  await f.controller.open('VSKILLGROUP'); assert.equal(f.state?.group, null, 'removed group');
  f.controller.selectGroup('t-night'); assert.equal(f.state?.group, 't-night'); f.lists['VSKILLGROUP']!.push(new Error('offline'));
  await f.controller.open('VSKILLGROUP'); assert.equal(f.state?.group, null, 'failed read');
  assert.deepEqual(f.reads(), ['VAGENT', 'VSKILLGROUP', 'VSKILLGROUP', 'VSKILLGROUP', 'VSKILLGROUP', 'VSKILLGROUP']);
});

test('设置 mounts the shared manager in the dialog with the full account and tab; 返回 destroys it and re-reads', async () => {
  const f = dialog(); await f.controller.open('VSKILLGROUP'); f.render();
  f.click('[data-reply-group="t-team"]');
  assert.equal(f.must('[data-action="reply-manage"]').textContent, '设置');
  f.click('[data-action="reply-manage"]');
  assert.equal(f.state?.mode, 'manage'); assert.ok(replyDialogOpen(f.state));
  assert.equal(f.mounts.length, 1);
  const mount = f.mounts[0]!;
  assert.deepEqual(mount.options.account, { account_id: 'a', environment: 'synthetic', session_generation: 1 });
  assert.equal(mount.options.type, 'VSKILLGROUP');
  assert.equal((mount.host as unknown as FakeElement).isConnected, true, 'the manager host is inside the dialog');
  const editor = f.must('[data-qr="root"]');
  assert.equal(f.q('[data-reply-group-all]'), null, 'the picker is replaced'); assert.equal(f.q('input[data-fid="reply-search"]'), null);
  assert.equal(f.must('[data-action="reply-back"]').textContent, '返回');
  f.render(); f.render(); assert.equal(f.must('[data-qr="root"]'), editor, 're-renders keep the editor the manager owns');
  // Escape in the editor's name/content field only cancels that form; elsewhere (a checkbox, the move menu, a button) it reaches the window and closes the dialog.
  const field = h('input', { 'data-fid': 'qrm-name' }) as unknown as FakeElement, checkbox = h('input', { type: 'checkbox' }) as unknown as FakeElement, menu = h('select', {}) as unknown as FakeElement;
  for (const el of [field, checkbox, menu]) (mount.host as unknown as FakeElement).appendChild(el);
  let stopped = 0;
  const keydown = (target: unknown) => { const dlg = f.must('[data-commerce-dialog="replies"]'); for (const fn of dlg.listeners.get('keydown') ?? []) fn.call(dlg, { type: 'keydown', key: 'Escape', target, currentTarget: dlg, stopPropagation: () => { stopped++; } } as never); };
  keydown(field); assert.equal(stopped, 1);
  keydown(checkbox); keydown(menu); keydown(f.must('[data-action="reply-back"]')); assert.equal(stopped, 1);
  mount.options.onTypeChange?.('VAGENT'); assert.equal(f.state?.type, 'VAGENT'); assert.equal(f.state?.group, null);
  mount.options.onChanged?.({ account: mount.options.account!, type: 'VAGENT', categories: null }); assert.deepEqual(f.state?.categories, [], 'the picker cache is dropped after a write');
  f.controller.select(reply('t1', 'team reply')); assert.deepEqual(f.inserts, [], 'nothing is inserted while managing');
  f.click('[data-action="reply-back"]'); await settle(); f.render();
  assert.deepEqual(mount.calls, ['destroy']);
  assert.equal(f.state?.mode, 'categories'); assert.equal(f.state?.type, 'VAGENT', 'the picker follows the editor tab');
  assert.deepEqual(f.reads(), ['VSKILLGROUP', 'VAGENT']);
  assert.equal(f.q('[data-qr="root"]'), null); assert.deepEqual(f.groups(), ['g-common', 'g-order', 'g-nested']);
  mount.options.onChanged?.({ account: mount.options.account!, type: 'VAGENT', categories: null }); assert.equal(f.state?.categories.length, 4, 'a destroyed editor cannot touch the picker');
  f.click('[data-action="reply-manage"]'); assert.equal(f.mounts.length, 2);
  f.controller.close(); f.render(); assert.deepEqual(f.mounts[1]!.calls, ['destroy']); assert.equal(f.state, null); assert.equal(f.q('[data-commerce-dialog="replies"]'), null);
  assert.ok(f.calls.every(c => c.command === UiCommands.IM_QUICK_REPLY_CATEGORIES), 'no write from the picker');
});

test('the editor rebinds on an account or generation change and keeps working across conversations', async () => {
  const f = dialog(); await f.controller.open(); f.render(); f.click('[data-action="reply-manage"]');
  const mount = f.mounts[0]!;
  f.controller.sync(); assert.deepEqual(mount.calls, [], 'same context: nothing to do');
  f.patch({ gid: 'chat-b', revision: 'visit-2' }); f.controller.sync(); f.render();
  assert.deepEqual(mount.calls, [], 'another conversation of the same account keeps the editor'); assert.equal(f.state?.scope.gid, 'chat-b'); assert.ok(f.q('[data-qr="root"]'));
  f.patch({ account: { account_id: 'a', environment: 'synthetic', session_generation: 2 } }); f.controller.sync();
  assert.deepEqual(mount.calls, ['setAccount']); assert.deepEqual(mount.accounts, [{ account_id: 'a', environment: 'synthetic', session_generation: 2 }]);
  f.controller.sync(); assert.deepEqual(mount.calls, ['setAccount'], 'no repeated rebind');
  f.patch({ account: { account_id: 'b', environment: 'synthetic', session_generation: 1 } }); f.controller.sync(); f.render();
  assert.deepEqual(mount.accounts.at(-1), { account_id: 'b', environment: 'synthetic', session_generation: 1 }); assert.ok(f.q('[data-qr="root"]'));
  f.click('[data-action="reply-back"]'); await settle();
  assert.deepEqual(f.calls.at(-1)?.payload.account, { account_id: 'b', environment: 'synthetic', session_generation: 1 }, 'the picker re-reads for the current account');
});

test('the real shared manager renders inside the dialog, survives re-renders and is emptied by 返回', async () => {
  const f = dialog({ real: true }); await f.controller.open(); f.render(); f.click('[data-action="reply-manage"]');
  await settle(); f.render();
  const editor = f.must('[data-qr="root"]');
  assert.deepEqual(f.root.querySelectorAll('[data-qr="group"]').map(el => el.getAttribute('data-id')), ['g-common', 'g-order', 'g-empty', 'g-nested'], 'the editor lists every group, empty ones included');
  f.render(); assert.equal(f.must('[data-qr="root"]'), editor);
  assert.deepEqual(f.calls.map(c => [c.command, c.payload.type]).slice(1).sort(), [[UiCommands.IM_QUICK_REPLY_CATEGORIES, 'VAGENT'], [UiCommands.IM_QUICK_REPLY_MANAGE_INFO, 'VAGENT']]);
  f.click('[data-action="reply-back"]'); await settle(); f.render();
  assert.equal(f.q('[data-qr="root"]'), null); assert.equal(f.state?.mode, 'categories'); assert.equal(f.cards().length, 5);
});

test('a write that is out locks 返回, ×, the shade and Escape; a forced close says its result is unconfirmed', async () => {
  const f = dialog(); await f.controller.open(); f.render(); f.click('[data-action="reply-manage"]');
  const mount = f.mounts[0]!;
  mount.busy = true; mount.options.onBusyChange?.(true); f.fresh();
  assert.equal(f.state?.busy, true);
  assert.equal(f.must('[data-action="reply-back"]').disabled, true);
  assert.equal(f.must('[aria-label="关闭快捷回复"]').disabled, true);
  f.must('div[class="shade"]').dispatch('click'); f.render();
  assert.equal(f.controller.dismiss(), false, 'Escape (main window) goes through dismiss');
  await f.controller.back();
  assert.equal(f.state?.mode, 'manage'); assert.deepEqual(mount.calls, [], 'the editor and its write stay');
  mount.busy = false; mount.options.onBusyChange?.(false); f.fresh();
  assert.equal(f.state?.busy, false); assert.equal(f.must('[data-action="reply-back"]').disabled, false);
  assert.equal(f.controller.dismiss(), true); assert.equal(f.state, null); assert.deepEqual(mount.calls, ['destroy']);
  assert.deepEqual(f.notices, [], 'a settled editor closes quietly');

  await f.controller.open(); f.render(); f.click('[data-action="reply-manage"]');
  const second = f.mounts[1]!;
  second.busy = true; second.options.onBusyChange?.(true);
  f.controller.close(); // account, generation or conversation change
  assert.equal(f.state, null); assert.deepEqual(second.calls, ['destroy']);
  assert.deepEqual(f.notices, ['快捷回复的修改仍在提交，结果未确认，请重新打开快捷回复设置核对']);
  second.options.onBusyChange?.(false); assert.equal(f.state, null, 'a destroyed editor cannot reopen the dialog');
});

test('the editor closes when the reply context is gone, so the page is not left covered', async () => {
  const f = dialog(); await f.controller.open(); f.render(); f.click('[data-action="reply-manage"]');
  assert.ok(replyDialogOpen(f.state));
  f.drop(); f.controller.sync(); f.render();
  assert.equal(f.state, null); assert.equal(replyDialogOpen(f.state), false);
  assert.deepEqual(f.mounts[0]!.calls, ['destroy']); assert.deepEqual(f.notices, []);
});
