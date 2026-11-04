import assert from 'node:assert/strict';
import test from 'node:test';
import { bannerKey, ignoredKey, loadIgnored, saveIgnored, splitCategories, toggleIgnored, withBannerCategory } from './notice-ignore.ts';

const account = { environment: 'prod', account_id: 'a1' } as const;
function memory() {
  const data = new Map<string, string>();
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k), data };
}

test('忽略列表按账号保存并可清空', () => {
  const s = memory();
  saveIgnored(account, ['order', 'system'], s);
  assert.deepEqual(loadIgnored(account, s), ['order', 'system']);
  assert.deepEqual(loadIgnored({ ...account, account_id: 'a2' }, s), []);
  saveIgnored(account, [], s);
  assert.equal(s.data.has(ignoredKey(account)), false);
});

test('损坏或不可用的存储读作空列表', () => {
  const s = memory();
  s.setItem(ignoredKey(account), '{bad');
  assert.deepEqual(loadIgnored(account, s), []);
  s.setItem(ignoredKey(account), JSON.stringify(['a', 1, 'a']));
  assert.deepEqual(loadIgnored(account, s), ['a']);
  assert.deepEqual(loadIgnored(account, null), []);
});

test('toggleIgnored 与 splitCategories', () => {
  assert.deepEqual(toggleIgnored(['a'], 'b', true), ['a', 'b']);
  assert.deepEqual(toggleIgnored(['a', 'b'], 'a', false), ['b']);
  assert.deepEqual(toggleIgnored(['a'], 'a', true), ['a']);
  const { visible, hidden } = splitCategories([{ id: 'a' }, { id: 'b' }], ['b', 'gone']);
  assert.deepEqual(visible, [{ id: 'a' }]);
  assert.deepEqual(hidden, [{ id: 'b' }]);
});

test('横幅提醒按账号开关，账号没有分类后删掉该项', () => {
  const other = { environment: 'prod', account_id: 'a2' } as const;
  assert.equal(bannerKey(account), 'prod:a1');
  let map = withBannerCategory({}, account, '1:1', true);
  map = withBannerCategory(map, account, '1:2', true);
  map = withBannerCategory(map, account, '1:1', true);
  map = withBannerCategory(map, other, '9:9', true);
  assert.deepEqual(map, { 'prod:a1': ['1:2', '1:1'], 'prod:a2': ['9:9'] });
  map = withBannerCategory(withBannerCategory(map, account, '1:1', false), account, '1:2', false);
  assert.deepEqual(map, { 'prod:a2': ['9:9'] });
});
