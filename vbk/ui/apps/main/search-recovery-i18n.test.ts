import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { hasKey, t } from '../../packages/ui-kit/src/i18n.ts';
import { searchRecoveryStrings } from '../../packages/ui-kit/src/search-recovery/strings.ts';
const { scanFile, expectNoCjkLiterals } = await import(new URL('../../../tools/gates/cjk-literals.mjs', import.meta.url).href);

test('recovery has no untranslated runtime CJK and all new references have complete static placeholder contracts', () => {
  const references = new Set<string>();
  for (const path of ['../_shared/recovery.ts']) {
    const text = readFileSync(new URL(path, import.meta.url), 'utf8');
    expectNoCjkLiterals(scanFile(`ui/apps/${path.slice(2)}`, text));
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    function inspect(node: ts.Node): void {
      if (ts.isCallExpression(node) && node.expression.getText(source) === 't') {
        const key = node.arguments[0]; assert.ok(key && ts.isStringLiteral(key));
        assert.ok(hasKey(key.text)); references.add(key.text);
        const value = searchRecoveryStrings[key.text as keyof typeof searchRecoveryStrings];
        assert.equal(typeof value, 'string');
        const placeholders = [...value.matchAll(new RegExp('[{]([A-Za-z0-9_]+)[}]', 'g'))].map(m => m[1]!).sort();
        if (placeholders.length) {
          const vars = node.arguments[1]; assert.ok(vars && ts.isObjectLiteralExpression(vars));
          assert.deepEqual(vars.properties.map(property => property.name?.getText(source)).sort(), placeholders, key.text);
        } else assert.equal(node.arguments[1], undefined, key.text);
      }
      ts.forEachChild(node, inspect);
    }
    inspect(source);
  }
  assert.deepEqual([...references].sort(), Object.keys(searchRecoveryStrings).sort());
});

test('recovery copy snapshot retains every entry and resolves through the shared catalogue', () => {
  assert.equal(Object.keys(searchRecoveryStrings).length, 37);
  for (const key of Object.keys(searchRecoveryStrings) as (keyof typeof searchRecoveryStrings)[]) assert.equal(t(key), searchRecoveryStrings[key]);
});

test('file names and composed recovery labels are inserted once rather than interpreted as a second template', () => {
  const name = '用户 {name} <script>.pdf', label = '页面 {message} <main>', message = '状态 {label}';
  assert.equal(t('recoveryRuntime.row', { label, message }), `${label}：${message}`);
  assert.equal(t('recoveryRuntime.warning', { label }), `重载${label}可能丢失尚未持久化的编辑、草稿或附件。不能保证恢复这些内容。`);
  assert.equal(t('recoveryRuntime.retrying', { attempt: 3 }), '页面异常，正在尝试重载（第 3 次）。');
});
