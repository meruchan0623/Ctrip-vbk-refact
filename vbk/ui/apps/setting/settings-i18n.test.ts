import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { hasKey, t } from '../../packages/ui-kit/src/i18n.ts';
import { SETTING_STRINGS } from './strings.ts';
import { tsimErrorText, tsimImportErrorText } from './viewmodel.ts';

// Exact pre-migration zh-CN copy; changes here require an explicit copy review.
const expected = {
  "loadFailed": "无法读取设置，请重试；若仍失败，请重新打开设置。",
  "loginUnconfirmed": "登录未获确认，请检查用户名和密码后重新输入。",
  "logoutUnconfirmed": "退出未获确认，请刷新登录状态后再操作。",
  "importUnconfirmed": "已有会话导入未获确认，请重新取得会话或使用账号密码登录。",
  "browserMissing": "没有找到 TSim 网页会话。请先在 Chrome 普通窗口登录客服系统，再重试；也可以在下方使用账号密码登录。",
  "shortcutRequired": "请输入快捷键，例如 Ctrl+Shift+X。",
  "shortcutConfirm": "无法确认快捷键保存结果",
  "shortcutSaved": "快捷键已保存",
  "shortcutPlaceholder": "例如 Ctrl+Shift+X",
  "saving": "正在保存…",
  "save": "保存",
  "shortcutHelp": "输入组合后保存；注册失败时原快捷键继续生效。",
  "statusUnknown": "登录状态未知",
  "checking": "正在核对…",
  "refreshLogin": "刷新 TSim 登录状态",
  "reading": "正在读取…",
  "fromChrome": "从 Chrome 登录",
  "browserDescription": "直接使用 Chrome 中已登录的 TSim 账号；多个浏览器配置时选择要连接的账号。断开不会退出浏览器。",
  "diagnosticsExported": "诊断信息已导出",
  "retrying": "正在重试…",
  "retrySettings": "重新读取设置",
  "importExpired": "已有 TSim 会话无效或已过期，请重新取得会话或使用账号密码登录。",
  "importInvalid": "已有会话的输入格式不正确，请重新取得有效会话。",
  "browserUnavailable": "无法读取浏览器会话，可能正在写入、格式不支持或没有访问权限。请稍后重试，或使用账号密码登录。",
  "badCredentials": "用户名或密码未通过验证，请检查后重新输入。",
  "invalidLogin": "登录信息格式不正确，请检查输入。",
  "forbidden": "TSim 拒绝了当前账号的权限，请联系管理员。",
  "permissionDenied": "当前窗口或账号没有操作权限，请重新打开设置或联系管理员。",
  "unauthenticated": "TSim 尚未登录，请重新登录。",
  "sessionCleared": "TSim 会话已失效，请重新登录。",
  "timeout": "请求超时，结果尚待核对。请先刷新登录状态。",
  "offline": "无法连接 TSim，请检查网络后刷新登录状态。",
  "serviceUnavailable": "TSim 服务暂不可用，请稍后刷新登录状态。",
  "malformedResponse": "返回的登录状态无法识别，请刷新状态后再操作。",
  "credentialStoreUnavailable": "系统凭据存储不可用，请检查系统权限后重试。",
  "operationUnconfirmed": "操作未完成，登录状态尚待核对。请先刷新 TSim 登录状态后再操作。",
  "assistant": "商家助手 · TSim 登录",
  "close": "关闭设置",
  "about": "关于与更新",
  "version": "当前版本",
  "versionUnknown": "未知",
  "checkUpdate": "检查更新",
  "checkUpdateDesc": "在独立的更新窗口中检查",
  "shortcutFailed": "快捷键未保存：{message}。请检查格式或更换未被占用的组合。",
  "shortcutCurrent": "当前生效：{shortcut}",
  "connectProfile": "连接 {label}",
  "errorCode": "{message}（{code}）"
} as const;
const { scanFile, expectNoCjkLiterals } = await import(new URL('../../../tools/gates/cjk-literals.mjs', import.meta.url).href);

const placeholders: Record<string, readonly string[]> = {
  shortcutFailed: ['message'], shortcutCurrent: ['shortcut'], connectProfile: ['label'], errorCode: ['code', 'message'],
};

test('all 47 settings entries preserve the reviewed Chinese text and placeholder contracts', () => {
  assert.equal(Object.keys(expected).length, 47);
  for (const [name, value] of Object.entries(expected)) {
    const key = `set.runtime.${name}`;
    assert.ok(hasKey(key)); assert.equal(t(key), value, name);
    assert.deepEqual([...value.matchAll(/\{(\w+)\}/g)].map(m => m[1]!).sort(), [...(placeholders[name] ?? [])].sort(), name);
  }
});

test('settings production TS has no CJK copy outside the catalog and every new t reference is static, known and used', () => {
  const references = new Set<string>();
  for (const path of ['./main.ts', './viewmodel.ts', './strings.ts']) {
    const text = readFileSync(new URL(path, import.meta.url), 'utf8');
    expectNoCjkLiterals(scanFile(`ui/apps/setting/${path.slice(2)}`, text), path);
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    function inspect(node: ts.Node): void {
      // Legacy templates are read through SETTING_STRINGS (`S.name`), the same entry as `set.runtime.name`.
      if (ts.isPropertyAccessExpression(node) && ['S', 'SETTING_STRINGS'].includes(node.expression.getText(source)) && node.name.text in expected && path !== './strings.ts') references.add(`set.runtime.${node.name.text}`);
      if (ts.isCallExpression(node) && node.expression.getText(source) === 't') {
        const key = node.arguments[0];
        if (!key || !ts.isStringLiteral(key)) {
          // Existing typed navigation table dispatch; no generated translation keys.
          assert.equal(key?.getText(source), 'sec.labelKey');
          return;
        }
        if (key.text.startsWith('set.runtime.')) {
          references.add(key.text); assert.ok(hasKey(key.text));
          const name = key.text.slice('set.runtime.'.length), names = placeholders[name] ?? [];
          const vars = node.arguments[1];
          if (names.length) {
            assert.ok(vars && ts.isObjectLiteralExpression(vars), key.text);
            assert.deepEqual(vars.properties.map(p => p.name?.getText(source)).sort(), [...names].sort(), key.text);
          } else assert.equal(vars, undefined, key.text);
        }
      }
      ts.forEachChild(node, inspect);
    }
    inspect(source);
  }
  const known = new Set(Object.keys(expected).map(key => `set.runtime.${key}`));
  assert.deepEqual([...references].sort(), [...known].sort(), 'every settings runtime entry is referenced and every reference is catalogued');
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  assert.match(html, /<html lang="zh-CN">/);
  assert.equal(html.split('<title>')[1]?.split('</title>')[0], t('set.title'), 'static fallback title accurately remains zh-CN');
});

test('settings dynamic user values are interpolated once with original whitespace and punctuation', () => {
  const label = 'Chrome {label}', shortcut = 'Ctrl+{shortcut}', message = 'host {code} <private>';
  assert.equal(t('set.runtime.connectProfile', { label }), `连接 ${label}`);
  assert.equal(t('set.runtime.shortcutCurrent', { shortcut }), `当前生效：${shortcut}`);
  assert.equal(t('set.runtime.shortcutFailed', { message }), `快捷键未保存：${message}。请检查格式或更换未被占用的组合。`);
  assert.equal(t('set.runtime.errorCode', { message, code: 'net.timeout' }), `${message}（net.timeout）`);
});

test('actual safe-error mapping keeps exact Chinese and whitelisted codes without echoing unknown error details', () => {
  const cases = {
    'assistant.browser_storage_unavailable': 'browserUnavailable', 'assistant.tsim_bad_credentials': 'badCredentials',
    'assistant.invalid_input': 'invalidLogin', 'assistant.forbidden': 'forbidden', 'assistant.permission_denied': 'permissionDenied',
    'assistant.tsim_unauthenticated': 'unauthenticated', 'assistant.session_cleared': 'sessionCleared',
    'net.timeout': 'timeout', 'net.offline': 'offline', 'assistant.service_unavailable': 'serviceUnavailable',
    'assistant.malformed_response': 'malformedResponse', 'store.io': 'credentialStoreUnavailable',
  } as const;
  for (const [code, key] of Object.entries(cases)) {
    assert.equal(tsimErrorText({ code, message: 'PRIVATE_PASSWORD' }), `${expected[key]}（${code}）`);
  }
  for (const code of ['toString', '__proto__', 'constructor', 'PRIVATE_TOKEN', 'set.runtime.badCredentials']) {
    assert.equal(tsimErrorText({ code, message: 'PRIVATE_PASSWORD' }), expected.operationUnconfirmed);
    assert.equal(tsimImportErrorText({ code, message: 'PRIVATE_PASSWORD' }), expected.operationUnconfirmed);
  }
  assert.equal(tsimImportErrorText({ code: 'assistant.session_cleared', message: 'PRIVATE_TOKEN' }), expected.importExpired);
  assert.equal(tsimImportErrorText({ code: 'assistant.invalid_input', message: 'PRIVATE_TOKEN' }), expected.importInvalid);
});
