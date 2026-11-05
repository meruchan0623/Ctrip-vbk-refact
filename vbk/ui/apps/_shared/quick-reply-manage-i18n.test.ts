import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { t, hasKey } from '../../packages/ui-kit/src/i18n.ts';
import { quickReplyManageStrings } from '../../packages/ui-kit/src/quick-reply-manage/strings.ts';
const { scanFile, expectNoCjkLiterals } = await import(new URL('../../../tools/gates/cjk-literals.mjs', import.meta.url).href);

test('quick-reply manager copy is catalogued with static keys and complete named interpolations', () => {
  const keys = new Set<string>();
  for (const path of ['./quick-reply-manager.ts', './quick-reply-manager.test.ts']) {
    const text = readFileSync(new URL(path, import.meta.url), 'utf8');
    expectNoCjkLiterals(scanFile(`ui/apps/_shared/${path.slice(2)}`, text));
    if (path.endsWith('.test.ts')) continue;
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    const inspect = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.expression.getText(source) === 't') {
        const key = node.arguments[0];
        assert.ok(key && ts.isStringLiteral(key), node.getText(source));
        assert.ok(hasKey(key.text), key.text);
        keys.add(key.text);
        const value = (quickReplyManageStrings as Record<string, string>)[key.text];
        assert.ok(value !== undefined, `${key.text} belongs to the quick-reply manager catalog`);
        const names = [...value.matchAll(/[{]([A-Za-z0-9_]+)[}]/g)].map(m => m[1]!).sort();
        if (names.length) {
          const vars = node.arguments[1];
          assert.ok(vars && ts.isObjectLiteralExpression(vars), key.text);
          assert.deepEqual(vars.properties.map(p => p.name?.getText(source)).sort(), names, key.text);
        } else assert.equal(node.arguments[1], undefined, key.text);
      }
      ts.forEachChild(node, inspect);
    };
    inspect(source);
  }
  assert.deepEqual([...keys].sort(), Object.keys(quickReplyManageStrings).sort(), 'every catalog entry is referenced and every reference has an entry');
});

test('45-entry quick-reply manager copy snapshot is locked and served by the shared table', () => {
  assert.equal(Object.keys(quickReplyManageStrings).length, 45);
  assert.equal(createHash('sha256').update(JSON.stringify(Object.entries(quickReplyManageStrings).sort())).digest('hex'), 'b75085d7de1b6b9b0a106cde9795b39f38ca69e92fef4c972c733ab9cca5d582');
  for (const key of Object.keys(quickReplyManageStrings) as (keyof typeof quickReplyManageStrings)[]) assert.equal(t(key), quickReplyManageStrings[key]);
  assert.equal(t('qrManage.confirm.group', { name: 'A', count: 2 }), quickReplyManageStrings['qrManage.confirm.group'].replace('{name}', 'A').replace('{count}', '2'));
});
