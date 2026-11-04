import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { t, hasKey } from '../../packages/ui-kit/src/i18n.ts';
import { repliesRecommendStrings } from '../../packages/ui-kit/src/replies-recommend/strings.ts';
import { createQuickReplies, quickRepliesView, type ReplyContext, type QuickRepliesState } from './quick-replies.ts';
import { createRecommendPanel, recommendView, type RecommendState } from './recommend-panel.ts';
import { UiCommands } from '../../packages/ipc/src/client.ts';
import { installFakeDom } from '../../tests/fake-dom.ts';
const { scanFile, expectNoCjkLiterals } = await import(new URL('../../../tools/gates/cjk-literals.mjs', import.meta.url).href);

test('reply and recommendation runtime copy is catalogued with static keys and complete named interpolations', () => {
  const keys = new Set<string>();
  for (const path of ['./quick-replies.ts', './recommend-panel.ts']) {
    const text = readFileSync(new URL(path, import.meta.url), 'utf8'); expectNoCjkLiterals(scanFile(`ui/apps/main/${path.slice(2)}`, text));
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    function inspect(node: ts.Node): void {
      if (ts.isCallExpression(node) && node.expression.getText(source) === 't') {
        const key = node.arguments[0]; assert.ok(key && ts.isStringLiteral(key)); assert.ok(hasKey(key.text)); keys.add(key.text);
        const value = repliesRecommendStrings[key.text as keyof typeof repliesRecommendStrings];
        const names = [...value.matchAll(new RegExp('[{]([A-Za-z0-9_]+)[}]', 'g'))].map(m => m[1]!).sort();
        if (names.length) { const vars = node.arguments[1]; assert.ok(vars && ts.isObjectLiteralExpression(vars)); assert.deepEqual(vars.properties.map(p => p.name?.getText(source)).sort(), names, key.text); }
        else assert.equal(node.arguments[1], undefined, key.text);
      }
      ts.forEachChild(node, inspect);
    }
    inspect(source);
  }
  // recommend-panel keeps main's literal copy until the pending migration, so entries may be unused; every reference must exist.
  assert.deepEqual([...keys].filter(key => !(key in repliesRecommendStrings)).sort(), []);
});

test('43-entry copy snapshot preserves all original Chinese, spaces, punctuation and nested page-count formatting', () => {
  assert.equal(Object.keys(repliesRecommendStrings).length, 43);
  assert.equal(createHash('sha256').update(JSON.stringify(Object.entries(repliesRecommendStrings).sort())).digest('hex'), '167b3378f3a099c05dcae20843a603e345e9aa2785b64ce2e087c54ab0f0ab33');
  for (const key of Object.keys(repliesRecommendStrings) as (keyof typeof repliesRecommendStrings)[]) assert.equal(t(key), repliesRecommendStrings[key]);
  const label = '用户 {label} <city>';
  assert.equal(t('recommendRuntime.findLabel', { label }), `查找${label}`);
  assert.equal(t('recommendRuntime.clearLabel', { label }), `清空${label}`);
  assert.equal(t('repliesRuntime.count', { count: 3 }), '3 条回复');
  assert.equal(t('recommendRuntime.page', { page: 2, total: '' }), '第 2 页');
  assert.equal(t('recommendRuntime.page', { page: 2, total: t('recommendRuntime.total', { count: 3 }) }), '第 2 页 · 共 3 项');
});

const context: ReplyContext = { account: { account_id: 'a', environment: 'synthetic', session_generation: 1 }, gid: 'room', revision: 'service', draft: 'original draft', version: 1 };

test('actual localized quick-reply controls retain VAGENT/VSKILLGROUP wire values and insert literal content only into the draft', async () => {
  for (const type of ['VAGENT', 'VSKILLGROUP'] as const) {
    const { root } = installFakeDom(); let state: QuickRepliesState | null = null;
    const current = () => state;
    const content = '用户原文 {count} <script>', calls: unknown[] = [], inserted: unknown[] = [];
    const item = { id: 'r1', content, short_cut: 'shortcut', type: 'text' };
    const controller = createQuickReplies({ current: () => context, publish: value => { state = value; }, insert: (text, replace) => inserted.push({ text, replace }), setTimer: () => 0, clearTimer() {}, invoke: async (command, payload) => { calls.push({ command, payload }); assert.equal(command, UiCommands.IM_QUICK_REPLY_CATEGORIES); return { categories: [{ id: 'c1', name: '用户分类 {name}', scripts: [item], sub_categories: [] }] }; } });
    await controller.open(type); const view = quickRepliesView(current(), context, controller); assert.ok(view); root.appendChild(view as any);
    assert.ok(root.textContent.includes(content)); assert.ok(root.textContent.includes('1 条回复'));
    assert.ok(root.textContent.includes('个人')); assert.ok(root.textContent.includes('团队'));
    const choice = root.querySelector('[data-reply-id="r1"]'); assert.ok(choice); choice.dispatch('click');
    assert.deepEqual(inserted, [{ text: content, replace: false }]);
    assert.deepEqual(calls, [{ command: UiCommands.IM_QUICK_REPLY_CATEGORIES, payload: { account: context.account, type } }]);
  }
});

