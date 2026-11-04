import { t as translateUi } from '../../packages/ui-kit/src/i18n.ts';
import { personDisplayName } from './person-name.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { cx } from '../../packages/ui-kit/src/h.ts';
const key = 'key.im.servicechat.robotnickname';
const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
test('actual member dialog translates only the exact known robot key and preserves each UID', () => {
  const a = source.indexOf('function peripheralDialog('); const b = source.indexOf('\nfunction render(', a);
  const people = [{ uid: 'synthetic-bot', nickname: key, status: '1', can_transfer: true }, { uid: 'synthetic-customer', nickname: 'SYNTHETIC ' + key, status: '1', can_transfer: true }];
  const state = { activeGid: 'synthetic-room', peripheral: { kind: 'members', scope: { account: {}, gid: 'synthetic-room' }, busy: false, submitted: false, write: null, error: null, notice: null, selected: [], members: { members: people, expires_at_ms: 1000 } }, now: 100 };
  const selected: string[] = [];
  const env = { peripheral: { select: (uid: string) => selected.push(uid) }, isDone: () => false, INVITE_ROOT: 'root', personDisplayName, stillActive: () => true, activeConv: () => ({ gid: 'synthetic-room' }), h: (tag: string, props: unknown, ...children: unknown[]) => ({ tag, props, children }), cx, document: {}, renderMessageAvatar: (_doc: unknown, name: string) => name, icon: () => null, IC: {}, t: translateUi, S: () => state, peripheralWriteView: () => null };
  const render = new Function(...Object.keys(env), stripTypeScriptTypes(source.slice(a, b)) + '\nreturn peripheralDialog;')(...Object.values(env));
  const rendered = render(state);
  const tree = JSON.stringify(rendered);
  function selectMembers(node: any): void { if (Array.isArray(node)) { node.forEach(selectMembers); return; } if (!node || typeof node !== 'object') return; if (node.tag === 'input' && node.props?.type === 'checkbox') node.props.onchange(); selectMembers(node.children); }
  selectMembers(rendered);
  assert.ok(tree.includes('游游机器人')); assert.deepEqual(selected, ['synthetic-bot', 'synthetic-customer']);
  assert.ok(tree.includes('SYNTHETIC ' + key));
  assert.equal(people[0]?.nickname, key);
  assert.equal(personDisplayName(' ' + key, 'synthetic-id'), ' ' + key);
  assert.equal(personDisplayName(null, 'synthetic-id'), 'synthetic-id');
  assert.equal(personDisplayName('SYNTHETIC NAME', 'synthetic-id'), 'SYNTHETIC NAME');
});

test('localized robot label does not transform free nicknames or identity fallback', () => {
  assert.equal(personDisplayName(key, 'unchanged-uid'), '游游机器人');
  for (const nickname of [key.toUpperCase(), `${key} `, `prefix ${key}`, '<img src=x>', '{robotName}', ' ']) {
    assert.equal(personDisplayName(nickname, 'unchanged-uid'), nickname);
  }
  for (const nickname of [null, undefined, '']) assert.equal(personDisplayName(nickname, 'raw-uid'), 'raw-uid');
});
