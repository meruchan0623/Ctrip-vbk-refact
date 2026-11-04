import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import ts from 'typescript';
import { t, hasKey } from '../../packages/ui-kit/src/i18n.ts';
import { packageDetailStrings } from '../../packages/ui-kit/src/package-detail/strings.ts';
import { UiCommands } from '../../packages/ipc/src/client.ts';
import { createPackageDetail, type DetailView } from './controller.ts';
const { scanFile, expectNoCjkLiterals } = await import(new URL('../../../tools/gates/cjk-literals.mjs', import.meta.url).href);

test('package-detail fixed UI copy and errors use static catalog keys with exact named placeholder contracts', () => {
  const references = new Set<string>();
  for (const path of ['./main.ts', './controller.ts']) {
    const text = readFileSync(new URL(path, import.meta.url), 'utf8'); expectNoCjkLiterals(scanFile(`ui/apps/package-detail/${path.slice(2)}`, text));
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    function inspect(node: ts.Node): void {
      if (ts.isCallExpression(node) && node.expression.getText(source) === 't') {
        const key = node.arguments[0]; assert.ok(key && ts.isStringLiteral(key)); assert.ok(hasKey(key.text)); references.add(key.text);
        const names = [...packageDetailStrings[key.text as keyof typeof packageDetailStrings].matchAll(new RegExp('[{]([A-Za-z0-9_]+)[}]', 'g'))].map(m => m[1]!).sort();
        if (names.length) { const vars = node.arguments[1]; assert.ok(vars && ts.isObjectLiteralExpression(vars)); assert.deepEqual(vars.properties.map(p => p.name?.getText(source)).sort(), names, key.text); }
        else assert.equal(node.arguments[1], undefined, key.text);
      }
      ts.forEachChild(node, inspect);
    }
    inspect(source);
  }
  assert.deepEqual([...references].sort(), Object.keys(packageDetailStrings).sort());
});

test('25-entry copy snapshot preserves original Chinese, whitespace and punctuation without recursively formatting data', () => {
  assert.equal(Object.keys(packageDetailStrings).length, 25);
  assert.equal(createHash('sha256').update(JSON.stringify(Object.entries(packageDetailStrings).sort())).digest('hex'), 'da88bdbb94abea409f54a010960f0919188c49a7750ee0a4d2ee68e98a2c02eb');
  for (const key of Object.keys(packageDetailStrings) as (keyof typeof packageDetailStrings)[]) assert.equal(t(key), packageDetailStrings[key]);
  assert.equal(t('packageDetailRuntime.order', { id: 'ID {id}' }), '订单 ID {id}');
  assert.equal(t('packageDetailRuntime.record', { index: 2 }), '记录 2');
  assert.equal(t('packageDetailRuntime.fetched', { time: 'TIME {time}' }), '数据读取时间：TIME {time}');
});

test('actual detail projection and render retain dynamic API field labels and values as text without extra reads', async () => {
  let view: DetailView = { busy: false, data: null, error: null, invalidated: false };
  const current = () => view, calls: unknown[] = [];
  const detail = createPackageDetail({ publish: value => { view = value; }, invoke: async (command, payload) => { calls.push({ command, payload }); return { order_id: '1234567890123456', session_epoch: 1, plan: { iccid: '8986000000000000001', plan: 'API套餐 {id}', status: 'API状态 {status}', remain_pct: 50, remain: '5 GB', total: '10 GB', supplier: 'Synthetic', apn: 'synthetic', fetched_at_ms: 1000 }, detail_fields: [{ label: 'API字段 {label}', value: '<img src=x> {value}' }], live_fields: [], cdrs: [[{ label: 'API用量字段', value: 'API用量值' }]], fetched_at_ms: 1000 }; } });
  await detail.load(); assert.ok(current().data);
  const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  const env: Record<string, any> = { t, h: (tag: string, props: object | null, ...children: unknown[]) => ({ tag, props: props ?? {}, children }), platform: 'windows', detail, close() {} };
  function actual(name: string, next: string) { const a = source.indexOf('function ' + name + '('), b = source.indexOf('\n' + next, a); assert.ok(a >= 0 && b > a); return new Function(...Object.keys(env), stripTypeScriptTypes(source.slice(a, b)) + '\nreturn ' + name + ';')(...Object.values(env)); }
  env['fieldTable'] = actual('fieldTable', 'function render('); const render = actual('render', 'subscribeBatched(');
  const output = JSON.stringify(render(current()));
  for (const value of ['API套餐 {id}', 'API状态 {status}', 'API字段 {label}', '<img src=x> {value}', 'API用量字段', 'API用量值', '订单 1234567890123456', '记录 1', '未返回可显示的数据']) assert.ok(output.includes(value), value);
  assert.equal(output.includes('innerHTML'), false);
  assert.deepEqual(calls, [{ command: UiCommands.ASSIST_PACKAGE_DETAIL, payload: {} }]);
});

test('actual native-close failure still displays the original fixed explanation and issues only the close request', async () => {
  const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  const start = source.indexOf('function close()'), end = source.indexOf('\nfunction fieldTable(', start); assert.ok(start >= 0 && end > start);
  const calls: unknown[] = [], patches: unknown[] = [];
  const close = new Function('t', 'UiCommands', 'ipc', 'store', stripTypeScriptTypes(source.slice(start, end)) + '\nreturn close;')(t, UiCommands, { invoke: async (command: string, payload: unknown) => { calls.push({ command, payload }); throw new Error('PRIVATE_NATIVE_DETAIL'); } }, { patch: (value: unknown) => patches.push(value) });
  close(); await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(calls, [{ command: UiCommands.SHELL_WINDOW, payload: { action: 'close' } }]);
  assert.deepEqual(patches, [{ error: '无法关闭窗口，请使用系统窗口关闭操作。' }]);
});
