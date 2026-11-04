import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mainRuntimeStrings } from '../../packages/ui-kit/src/main-runtime/strings.ts';
import { t, hasKey } from '../../packages/ui-kit/src/i18n.ts';
import { LANG_NAMES, langName, QUOTE_UNAVAILABLE, QUOTE_RECALLED, sendStateView } from './viewmodel.ts';

test('main runtime catalog is registered and only the rejection template has dynamic fields', () => {
  assert.equal(Object.keys(mainRuntimeStrings).length, 24);
  for (const [key, value] of Object.entries(mainRuntimeStrings)) {
    assert.ok(hasKey(key)); assert.equal(t(key), value);
    assert.deepEqual([...value.matchAll(/[{](\w+)[}]/g)].map(match => match[1]), key === 'mainRuntime.rejectedReason' ? ['label', 'reason'] : []);
  }
});
test('language display names preserve protocol codes and unknown values', () => {
  assert.deepEqual(LANG_NAMES, { ar: '阿拉伯语', pt: '葡萄牙语', it: '意大利语', tr: '土耳其语', zh: '中文', en: '英语', ja: '日语', ko: '韩语', th: '泰语', vi: '越南语', id: '印尼语', ms: '马来语', es: '西班牙语', fr: '法语', de: '德语', ru: '俄语', 'zh-TW': '繁体中文' });
  for (const [code, name] of Object.entries(LANG_NAMES)) assert.equal(langName(code), name);
  assert.equal(langName('untrusted-{reason}'), 'untrusted-{reason}');
  assert.equal(QUOTE_UNAVAILABLE, '引用内容不可用'); assert.equal(QUOTE_RECALLED, '引用消息已撤回');
});
test('rejection reason remains raw and is interpolated once; unknown offers no retry', () => {
  const reason = '{label}）客户原文（{reason}';
  assert.deepEqual(sendStateView({ kind: 'rejected', code: 'synthetic', reason }), { cls: 'rej', label: `${t('send.rejected')}（${reason}）`, canRetry: true, spin: false });
  assert.equal(sendStateView({ kind: 'unknown' }).canRetry, false);
});
test('attachment implementation contains stable private diagnostics and no fixed Chinese Error messages', () => {
  const source = readFileSync(new URL('./attachment-draft-book.ts', import.meta.url), 'utf8');
  const errors = [...source.matchAll(/new Error\('([^']+)'\)/g)].map(match => match[1]);
  assert.equal(errors.length, 11); assert.equal(new Set(errors).size, 10);
  for (const error of errors) assert.match(error!, /^attachment_draft\.[a-z_]+$/);
});
