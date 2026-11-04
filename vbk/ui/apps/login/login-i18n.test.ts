import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import ts from 'typescript';
import { LOGIN_STRINGS as S, fmt } from './strings.ts';
import { createBrowserLogin } from './browser-login.ts';
import { AccountCommands } from '../../packages/ipc/src/commands.ts';
const { scanFile, expectNoCjkLiterals } = await import(new URL('../../../tools/gates/cjk-literals.mjs', import.meta.url).href);
const expected = {
  browserImporting: '正在导入浏览器登录态…', browserVerifying: '正在核验携程账号…',
  browserUnavailable: '浏览器登录态不可用，可重试或使用下方官方登录页。',
  browserDiscovering: '正在查找已授权的浏览器账号…', browserChooseLoggedIn: '请选择已登录携程的浏览器账号',
  browserAuthorize: '请在 Chrome 或 Edge 的 VBK 扩展中授权连接，再刷新。',
  browserNotReady: '浏览器连接未就绪，请重试或使用下方官方登录页。',
  browserAccountLabel: '浏览器账号', browserSelect: '选择浏览器账号', browserConnect: '连接账号', browserRefresh: '刷新',
  browserDefault: '连接 Chrome 或 Edge 中的携程账号',
} as const;

test('all 12 login copy entries preserve the exact original Chinese and each has a static production reference', () => {
  assert.equal(Object.keys(expected).length, 12);
  const references = new Set<string>();
  for (const path of ['./browser-login.ts', './main.ts']) {
    const text = readFileSync(new URL(path, import.meta.url), 'utf8');
    expectNoCjkLiterals(scanFile(`ui/apps/login/${path.slice(2)}`, text));
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    function inspect(node: ts.Node): void {
      if (ts.isPropertyAccessExpression(node) && node.expression.getText(source) === 'S') references.add(node.name.text);
      ts.forEachChild(node, inspect);
    }
    inspect(source);
  }
  for (const name of Object.keys(expected) as (keyof typeof expected)[]) {
    assert.equal(S[name], expected[name]); // browser-login keeps main's literal copy until the pending migration, so references are not required
  }
});

test('actual login header preserves browser labels and state messages literally while presenting localized controls', () => {
  const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  const start = source.indexOf('function render('), end = source.indexOf('\nsubscribeBatched(', start);
  assert.ok(start >= 0 && end > start);
  const env = { S, h: (tag: string, props: object | null, ...children: unknown[]) => ({ tag, props: props ?? {}, children }), platform: 'windows', icon: () => null, IC: {}, cancelAndClose() {}, browser: { select() {}, connect() {}, discover() {} } };
  const render = new Function(...Object.keys(env), stripTypeScriptTypes(source.slice(start, end)) + '\nreturn render;')(...Object.values(env));
  const label = '用户浏览器 {label} <Chrome>', message = 'controller {message}';
  const output = JSON.stringify(render({ accounts: null, closing: false, error: null, browser: { choices: [{ id: 'Default', label }], selected: 'Default', busy: false, message } }));
  assert.ok(output.includes(label)); assert.ok(output.includes(message));
  for (const value of [S.browserAccountLabel, S.browserSelect, S.browserConnect, S.browserRefresh]) assert.ok(output.includes(value));
  assert.ok(JSON.stringify(render({ accounts: null, closing: false, error: null })).includes(S.browserDefault));
  assert.equal(fmt(S.cancelFailed, { msg: '{msg} <error>' }), '取消登录失败：{msg} <error>');
});

test('cancelled browser connect cannot publish either a late success or backend failure after the copy migration', async () => {
  for (const failed of [false, true]) {
    let finish!: () => void, reject!: (error: Error) => void;
    const calls: string[] = [], updates: unknown[] = [];
    const browser = createBrowserLogin({ attempt: () => 'attempt', update: value => updates.push(value), invoke: async command => {
      calls.push(command);
      if (command === AccountCommands.BROWSER_PROFILES) return [{ id: 'Default', label: 'USER_LABEL' }];
      return new Promise((resolve, fail) => { finish = () => resolve(null); reject = fail; });
    } });
    await browser.discover(); const pending = browser.connect();
    assert.equal(browser.state.message, expected.browserImporting);
    browser.cancel(); const state = browser.state, count = updates.length;
    if (failed) reject(new Error('PRIVATE_BACKEND_DETAIL')); else finish();
    await pending;
    assert.equal(browser.state, state); assert.equal(updates.length, count);
    assert.deepEqual(calls, [AccountCommands.BROWSER_PROFILES, AccountCommands.BROWSER_CONNECT]);
    assert.equal(JSON.stringify(browser.state).includes('PRIVATE_BACKEND_DETAIL'), false);
  }
});
