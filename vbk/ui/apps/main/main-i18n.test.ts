import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { hasKey, t } from '../../packages/ui-kit/src/i18n.ts';
import { mainStrings } from '../../packages/ui-kit/src/main/strings.ts';
const { scanFile, expectNoCjkLiterals } = await import(new URL('../../../tools/gates/cjk-literals.mjs', import.meta.url).href);
const text = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
const source = ts.createSourceFile('main.ts', text, ts.ScriptTarget.Latest, true);

test('all main-window runtime CJK copy is catalogued using the common scanner, including Chinese punctuation', () => {
  expectNoCjkLiterals(scanFile('ui/apps/main/main.ts', text));
});

test('main catalog references are static and every named interpolation matches its complete sentence', () => {
  const referenced = new Set<string>();
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && node.expression.getText(source) === 't') {
      const key = node.arguments[0];
      if (key && ts.isStringLiteral(key) && key.text.startsWith('main.')) {
        assert.ok(hasKey(key.text)); referenced.add(key.text);
        const value = mainStrings[key.text as keyof typeof mainStrings];
        const names = [...value.matchAll(new RegExp('[{]([A-Za-z0-9_]+)[}]', 'g'))].map(match => match[1]!).sort();
        const vars = node.arguments[1];
        if (!names.length) assert.equal(vars, undefined, key.text);
        else {
          assert.ok(vars && ts.isObjectLiteralExpression(vars), key.text);
          assert.deepEqual(vars.properties.map(prop => prop.name?.getText(source)).sort(), names, key.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.deepEqual([...referenced].sort(), Object.keys(mainStrings).sort(), 'every main entry is referenced and every reference has an entry');
});

test('reviewed 134-entry copy snapshot retains original Chinese, spaces, punctuation and placeholder names', () => {
  assert.equal(Object.keys(mainStrings).length, 134);
  const hash = createHash('sha256').update(JSON.stringify(Object.entries(mainStrings).sort())).digest('hex');
  assert.equal(hash, '1414bb94e3b74db37f20810485db1c88b1e40ebdf4eebe7143e400c670d26f54');
  for (const key of Object.keys(mainStrings) as (keyof typeof mainStrings)[]) assert.equal(t(key), mainStrings[key]);
});

test('UI interpolation inserts user labels and diagnostics once without interpreting their braces or changing surrounding spaces', () => {
  const message = 'upstream {message}', name = '成员 {count}';
  assert.equal(t('main.orderView.detailSuffix', { message }), ` （${message}）`);
  assert.equal(t('main.unknownOutboundDialog.intentMetadata', { date: 'DATE', time: 'TIME', generation: 3, phase: message }), `DATE TIME · 创建代次 3 · ${message}`);
  assert.equal(t('main.peripheralDialog.selectPerson', { name }), `选择${name}`);
  assert.equal(t('main.peripheralDialog.confirmInvite', { count: '' }), '确认邀请');
  assert.equal(t('main.peripheralDialog.confirmInvite', { count: t('main.peripheralDialog.countSuffix', { count: 3 }) }), '确认邀请（3）');
});
