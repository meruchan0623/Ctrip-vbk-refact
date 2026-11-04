import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { hasKey, t, type I18nKey } from '../../packages/ui-kit/src/i18n.ts';
import { unavailableAttachment } from './attachment-draft-book.ts';
import { attachmentBlockReason, ATTACHMENT_SEND_UNAVAILABLE } from './sendComposer.ts';

const catalog = ts.createSourceFile('i18n.ts', readFileSync(new URL('../../packages/ui-kit/src/i18n.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const entries = new Map<string, string>();
function visit(node: ts.Node): void {
  if (ts.isPropertyAssignment(node) && ts.isStringLiteral(node.name) && node.name.text.startsWith('attachment.')) {
    assert.ok(ts.isStringLiteral(node.initializer));
    assert.equal(entries.has(node.name.text), false, `duplicate attachment key ${node.name.text}`);
    entries.set(node.name.text, node.initializer.text);
  }
  ts.forEachChild(node, visit);
}
visit(catalog);

test('all attachment UI references are static catalog keys and every placeholder has an explicit contract', () => {
  const placeholders: Record<string, readonly string[]> = {
    'attachment.sendKeyKeepText': ['key'], 'attachment.sendKeyKeepQuote': ['key'],
    'attachment.summary': ['name', 'status'], 'attachment.uploadRejected': ['detail'], 'attachment.uploadUnknown': ['detail'],
  };
  const references = new Set<string>();
  for (const path of ['./attachment-draft-book.ts', './sendComposer.ts', './main.ts']) {
    const file = ts.createSourceFile(path, readFileSync(new URL(path, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
    function inspect(node: ts.Node): void {
      if (ts.isCallExpression(node) && node.expression.getText(file) === 't') {
        const key = node.arguments[0];
        if (key && ts.isStringLiteral(key) && key.text.startsWith('attachment.')) {
          references.add(key.text); assert.ok(hasKey(key.text));
          const expected = placeholders[key.text] ?? [];
          const vars = node.arguments[1];
          if (expected.length) {
            assert.ok(vars && ts.isObjectLiteralExpression(vars), key.text);
            assert.deepEqual(vars.properties.map(p => p.name?.getText(file)).sort(), [...expected].sort(), key.text);
          } else assert.equal(vars, undefined, key.text);
        }
      }
      ts.forEachChild(node, inspect);
    }
    inspect(file);
  }
  // Entries may be unused (video was dropped with the standalone-viewer decision); only a missing entry is wrong.
  assert.deepEqual([...references].filter(key => !entries.has(key)).sort(), [], 'no missing attachment entries');
  for (const [key, value] of entries) {
    assert.deepEqual([...value.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort(), [...(placeholders[key] ?? [])].sort(), key);
    assert.equal(t(key as I18nKey), value, 'zh-CN lookup preserves the exact catalog text');
  }
});

test('placeholder values preserve user filenames and host details literally and keep the previous spacing and punctuation', () => {
  const name = 'user {status} <script>.png', detail = ' host {key} detail';
  assert.equal(t('attachment.summary', { name, status: '正在上传附件…' }), `${name} · 正在上传附件…`);
  assert.equal(t('attachment.uploadRejected', { detail }), `附件上传被拒绝，消息尚未提交；勿重复上传或发送。${detail}`);
  assert.equal(t('attachment.uploadUnknown', { detail: '' }), '附件上传结果待核对，消息尚未提交；勿重复上传或发送。');
  assert.equal(t('attachment.sendKeyKeepText', { key: 'Ctrl/⌘+Enter' }), 'Ctrl/⌘+Enter 仅发送附件，文字保留');
  assert.equal(t('attachment.sendKeyKeepQuote', { key: 'Enter' }), 'Enter 仅发送附件，文字/引用保留');
});

test('actual draft placeholders and send blocking states retain their original Chinese copy without changing wire states or user names', () => {
  const scope = { account: { account_id: 'a', environment: 'production' as const, session_generation: 1 }, gid: 'room' };
  const expected = {
    loading: '正在恢复附件，请等待；文字草稿不会被更改。',
    missing: '附件文件缺失，请重新选择或显式移除；不会发送文字代替附件。',
    corrupt: '附件校验失败，请重新选择或显式移除。',
    pending: '此附件已有未决发送，请先核验原记录。移除草稿不会删除原发送账本。',
    error: '附件恢复失败，请重试或显式移除。',
  } as const;
  for (const state of Object.keys(expected) as (keyof typeof expected)[]) {
    const placeholder = unavailableAttachment(scope, state);
    assert.equal(placeholder.unavailable, state);
    assert.equal(placeholder.name, state === 'loading' ? '正在恢复附件…' : '附件暂不可用');
    assert.equal(attachmentBlockReason(placeholder), expected[state]);
    const custom = unavailableAttachment(scope, state, { lease_id: 'l', name: '用户文件 {name}.png' } as any);
    assert.equal(custom.name, '用户文件 {name}.png');
  }
  assert.equal(attachmentBlockReason({ name: 'x' }), ATTACHMENT_SEND_UNAVAILABLE);
  assert.equal(ATTACHMENT_SEND_UNAVAILABLE, '附件暂不可用，文字和附件草稿已保留。请检查附件或显式移除后再发送。');
});
