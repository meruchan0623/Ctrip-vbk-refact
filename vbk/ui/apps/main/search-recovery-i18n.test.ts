import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { hasKey, t } from '../../packages/ui-kit/src/i18n.ts';
import { searchRecoveryStrings } from '../../packages/ui-kit/src/search-recovery/strings.ts';
import { dateSearchRange } from './server-search.ts';
const { scanFile, expectNoCjkLiterals } = await import(new URL('../../../tools/gates/cjk-literals.mjs', import.meta.url).href);

test('search and recovery have no untranslated runtime CJK and all new references have complete static placeholder contracts', () => {
  const references = new Set<string>();
  for (const path of ['./server-search.ts', '../_shared/recovery.ts']) {
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

test('76-entry search/recovery copy snapshot retains the original Chinese, whitespace and punctuation', () => {
  assert.equal(Object.keys(searchRecoveryStrings).length, 76);
  assert.equal(createHash('sha256').update(JSON.stringify(Object.entries(searchRecoveryStrings).sort())).digest('hex'), '411a19967bf921b41134757e2472947756901778d0c9db7734b02e2665b48a3f');
  for (const key of Object.keys(searchRecoveryStrings) as (keyof typeof searchRecoveryStrings)[]) assert.equal(t(key), searchRecoveryStrings[key]);
});

test('file names and composed recovery labels are inserted once rather than interpreted as a second template', () => {
  const name = '用户 {name} <script>.pdf', label = '页面 {message} <main>', message = '状态 {label}';
  assert.equal(t('searchRuntime.file', { name }), `[文件] ${name}`);
  assert.equal(t('recoveryRuntime.row', { label, message }), `${label}：${message}`);
  assert.equal(t('recoveryRuntime.warning', { label }), `重载${label}可能丢失尚未持久化的编辑、草稿或附件。不能保证恢复这些内容。`);
  assert.equal(t('recoveryRuntime.retrying', { attempt: 3 }), '页面异常，正在尝试重载（第 3 次）。');
});

test('actual date validation still reports the exact localized user error instead of changing query or time semantics', () => {
  const now = new Date(2026, 10, 3);
  assert.throws(() => dateSearchRange('2026-01-01', '2026-10-01', now), { message: '请选择最近三个月内的日期' });
  assert.throws(() => dateSearchRange('2026-09-31', '2026-10-01', now), { message: '日期格式无效' });
  assert.throws(() => dateSearchRange('2026-10-02', '2026-10-01', now), { message: '开始日期不能晚于结束日期' });
});
