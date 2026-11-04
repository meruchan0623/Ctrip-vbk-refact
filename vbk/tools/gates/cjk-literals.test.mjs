import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { scanFile } from './cjk-literals.mjs';

test('CJK audit detects ordinary, escaped and interpolated literals', () => {
  for (const source of [
    "button.textContent = '发送';",
    'button.textContent = "\\u53d1\\u9001";',
    'toast(`正在处理 ${name}，请稍候`);',
    'const key = { "中文": true };',
    'const label = "한국어";',
    'const label = "かなカナ";',
    'const label = `（${code}）`;',
  ]) assert.ok(scanFile('ui/apps/main/view.ts', source).length, source);
});

test('CJK audit ignores comments and matching regular expressions, not their neighbors', () => {
  const source = '// 中文注释\nconst matcher = /中文/; /* 注释 */\nconst text = "English";';
  assert.deepEqual(scanFile('view.ts', source), []);
  assert.equal(scanFile('view.ts', source + '\nconst caption = "中文";')[0].line, 4);
});

test('CJK audit accepts only named catalogs and test sources', () => {
  for (const file of ['ui/i18n.ts', 'ui/local/strings.ts', 'ui/view.test.ts', 'ui/tests/view.ts', 'ui/fixtures/view.ts']) {
    assert.deepEqual(scanFile(file, 'const text = "中文";'), [], file);
  }
  for (const file of ['ui/my-i18n.ts', 'ui/strings-extra.ts', 'ui/testing/view.ts']) {
    assert.equal(scanFile(file, 'const text = "中文";').length, 1, file);
  }
});

test('CJK audit detects JSX text and attributes', () => {
  assert.equal(scanFile('view.tsx', '<button title="发送">发送</button>').length, 2);
  assert.equal(scanFile('view.tsx', '<button title="&#21457;&#36865;">&#x53d1;&#x9001;</button>').length, 2);
  assert.deepEqual(scanFile('view.tsx', '<button title="&amp;#21457;">&amp;#x53d1;</button>'), []);
  assert.deepEqual(scanFile('view.ts', 'const text = "&#x53d1;";'), []);
});

test('standard String.raw uses raw template fragments without inferring custom tags', () => {
  assert.deepEqual(scanFile('view.ts', 'String.raw`\\u53d1${name}\\u9001`'), []);
  assert.equal(scanFile('view.ts', 'String.raw`发送`').length, 1);
  assert.equal(scanFile('view.ts', 'custom`\\u53d1`').length, 1);
  assert.equal(scanFile('view.ts', 'function view(String) { return String.raw`\\u53d1`; }').length, 1);
  for (const declaration of [
    'const view = function String() { return String.raw`\\u53d1`; };',
    'const View = class String { render() { return String.raw`\\u53d1`; } };',
    "import String = require('./custom-tag'); String.raw`\\u53d1`;",
    'namespace String { export const raw = tag; } String.raw`\\u53d1`;',
  ]) assert.equal(scanFile('view.ts', declaration).length, 1, declaration);
});

test('protocol sets permit only exact top-level const keys and retain neighboring UI checks', () => {
  const file = 'ui/apps/main/package-preview.ts';
  const allowed = readFileSync(new URL('../../ui/apps/main/package-preview.ts', import.meta.url), 'utf8');
  assert.deepEqual(scanFile(file, allowed), []);
  for (const source of [
    allowed.replace('const DETAIL_LABELS', 'let DETAIL_LABELS'),
    allowed.replace('DETAIL_LABELS', 'UI_LABELS'),
    allowed.replace('业务流水号', '发送'),
    'function view() { ' + allowed + ' }',
    'const Set = CustomSet; ' + allowed,
    allowed + " render('业务流水号');",
    allowed + ' export const leakedLabels = [...DETAIL_LABELS];',
    allowed.replace('const DETAIL_LABELS', 'export const DETAIL_LABELS'),
    allowed.replace('labels.has(item.label)', 'labels.has(item.value)'),
  ]) assert.ok(scanFile(file, source).length, source);
  assert.ok(scanFile('ui/apps/main/other.ts', allowed).length);
});

test('protocol lookup exceptions resolve exact immutable helper bindings', async () => {
  const { readFileSync } = await import('node:fs');
  const file = 'ui/apps/main/companion-card.ts';
  const source = readFileSync(new URL('../../ui/apps/main/companion-card.ts', import.meta.url), 'utf8');
  assert.deepEqual(scanFile(file, source), []);
  for (const [before, after] of [
    ['const field =', 'let field ='],
    ['const cdrField =', 'let cdrField ='],
    ['const get = cdrField', 'let get = cdrField'],
    ['const records =', 'let records ='],
    ['row.label === label', 'row.label !== label'],
    ["'业务流水号'", "'新协议字段'"],
  ]) {
    assert.ok(source.includes(before), before);
    assert.ok(scanFile(file, source.replace(before, after)).length, after);
  }
  assert.ok(scanFile(file, source + "\nfunction unrelated(field) { return field(plan, '业务流水号'); }").length);
  assert.ok(scanFile(file, source + "\nrender('业务流水号');").length);
  assert.ok(scanFile('ui/apps/main/other.ts', source).length);
});

test('only the exact release-excluded IPC mock path is exempt', () => {
  assert.deepEqual(scanFile('ui/packages/ipc/src/mock.ts', "const demo = '示例';"), []);
  for (const file of ['ui/packages/ipc/src/mock-loader.ts', 'ui/apps/main/mock.ts']) {
    assert.equal(scanFile(file, "const demo = '示例';").length, 1);
  }
});
