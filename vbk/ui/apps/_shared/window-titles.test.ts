import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import ts from 'typescript';
import { t } from '../../packages/ui-kit/src/i18n.ts';
import { LOGIN_STRINGS } from '../login/strings.ts';
import { ALARM_STRINGS } from '../alarm/strings.ts';
import { UPDATE_STRINGS } from '../update/strings.ts';

const windows = [
  { app: 'main', expected: 'VBK 商家工作台', strings: {} },
  { app: 'setting', expected: '设置', strings: {} },
  { app: 'package-detail', expected: 'TSim 套餐详情', strings: {} },
  { app: 'update', expected: '软件更新', strings: UPDATE_STRINGS },
  { app: 'login', expected: '登录', strings: LOGIN_STRINGS },
  { app: 'alarm', expected: '回复超时提醒', strings: ALARM_STRINGS },
];
for (const { app, expected, strings } of windows) test(`${app}: actual early title initialization matches unchanged HTML fallback before fallible startup`, () => {
  const text = readFileSync(new URL(`../${app}/main.ts`, import.meta.url), 'utf8');
  const html = readFileSync(new URL(`../${app}/index.html`, import.meta.url), 'utf8');
  assert.equal(/<html lang="([^"]+)">/.exec(html)?.[1], 'zh-CN');
  const fallback = /<title>([^<]+)<\/title>/.exec(html)?.[1];
  assert.equal(fallback, expected);
  const source = ts.createSourceFile('main.ts', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const titleIndex = source.statements.findIndex(statement => ts.isExpressionStatement(statement)
    && ts.isBinaryExpression(statement.expression) && statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
    && statement.expression.left.getText(source) === 'document.title');
  assert.ok(titleIndex >= 0, 'entry initializes the actual document title');
  const prefix = source.statements.slice(0, titleIndex + 1).filter(statement => !ts.isImportDeclaration(statement));
  // Only the existing synchronous platform initialization may precede the title.
  // This rejects moving it below stores, IPC, location parsing, render or async work.
  assert.deepEqual(prefix.slice(0, -1).map(statement => statement.getText(source)), app === 'package-detail' ? [] : ['alarm', 'update', 'login'].includes(app) ? ['applyPlatform();'] : ['const platform = applyPlatform();']);
  const initialization = prefix.map(statement => statement.getText(source)).join('\n');
  const document = { title: fallback }, calls: string[] = [];
  const failure = new Error('synthetic later startup failure');
  const run = new Function('document', 't', 'S', 'applyPlatform', 'laterStartup', stripTypeScriptTypes(initialization) + '\nlaterStartup();');
  assert.throws(() => run(document, t, strings, () => { calls.push('platform'); return 'macos'; }, () => {
    assert.equal(document.title, expected, 'title is ready before even a failing asynchronous bootstrap begins');
    calls.push('startup'); throw failure;
  }), error => error === failure);
  assert.equal(document.title, fallback);
  assert.equal(calls.at(-1), 'startup');
});

test('login and alarm static document titles are independent of dynamic or longer window chrome', () => {
  assert.equal(LOGIN_STRINGS.documentTitle, '登录'); assert.notEqual(LOGIN_STRINGS.documentTitle, LOGIN_STRINGS.title);
  assert.equal(ALARM_STRINGS.documentTitle, '回复超时提醒');
  assert.equal(ALARM_STRINGS.documentTitle.includes('{'), false);
});
