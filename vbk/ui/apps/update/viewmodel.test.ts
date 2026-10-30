import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkUpdate, versionText } from './viewmodel.ts';

test('version text', () => {
  assert.equal(versionText('0.1.0'), '当前版本 0.1.0');
  assert.equal(versionText(' 2.0.0-beta.3 '), '当前版本 2.0.0-beta.3');
  assert.equal(versionText(null), '当前版本未知');
  assert.equal(versionText(''), '当前版本未知');
});

test('check update reports the missing update service', () => {
  assert.equal(checkUpdate('idle'), 'not_configured');
  assert.equal(checkUpdate('not_configured'), 'not_configured');
});
