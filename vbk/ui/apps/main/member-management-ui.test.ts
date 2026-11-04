import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { personDisplayName } from './person-name.ts';
import { cx } from '../../packages/ui-kit/src/h.ts';

interface Element { tag: string; props: Record<string, unknown>; children: unknown[] }
function nodes(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== 'object') return [];
  const element = value as Element;
  return [element, ...nodes(element.children ?? [])];
}
function text(value: unknown): string {
  if (Array.isArray(value)) return value.map(text).join('');
  if (value && typeof value === 'object') return text((value as Element).children ?? []);
  return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
}
const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
const start = source.indexOf('function peripheralDialog(');
const end = source.indexOf('\nfunction render(', start);
const body = stripTypeScriptTypes(source.slice(start, end));
const agents = [
  { uid: 'online', nickname: '跨部门在线客服', status: 0, duty_status: 3, job_position_type: 4, skill_group_full_name: '华东 / 客服' },
  { uid: 'offline', nickname: '名称很长的已选客服成员', status: 3, duty_status: 1, job_position_type: 4, skill_group_full_name: '华南 / 客服' },
  { uid: 'busy', nickname: '挂起成员', status: 1, job_position_type: 3 },
  { uid: 'away', nickname: '离开成员', status: 2, job_position_type: 2 },
  { uid: 'unknown', nickname: '未知状态成员', status: 99, job_position_type: 1 },
];
function render(overrides: Record<string, unknown> = {}) {
  const calls: unknown[][] = [];
  const d = { kind: 'invite', scope: { account: {}, gid: 'room' }, busy: false, refreshing: false, submitted: false, onlineOnly: true, roleFilter: '4', selected: ['offline'], candidates: { agents, skill_groups: [], selection_token: 'token', expires_at_ms: 2000 }, known: Object.fromEntries(agents.map((a) => [a.uid, a])), ...overrides };
  const state = { peripheral: d, activeGid: 'room', now: 1000, inviteQuery: '' };
  const peripheral = Object.fromEntries(['select', 'setOnlineOnly', 'setRoleFilter', 'close', 'refresh', 'expand', 'submit'].map((method) => [method, (...args: unknown[]) => calls.push([method, ...args])]));
  const env = { cx, personDisplayName, peripheral, stillActive: () => true, activeConv: () => ({ title: '会话' }), isDone: () => false,
    filteredInviteAgents: () => overrides['visibleAgents'] ?? agents, renderMessageAvatar: () => null, document: {},
    h: (tag: string, props: Record<string, unknown> | null, ...children: unknown[]) => ({ tag, props: props ?? {}, children }),
    icon: () => null, IC: {}, S: () => state, store: { patch: () => {} }, peripheralWriteView: () => null, openPeripheral: () => {},
  };
  const tree = new Function(...Object.keys(env), `${body}\nreturn peripheralDialog;`)(...Object.values(env))(state);
  return { all: nodes(tree), calls, tree };
}
test('member invitation displays explicit chat status independently from duty status', () => {
  const { all } = render();
  const badges = all.filter((node) => String(node.props['class'] ?? '').split(' ').includes('invite-presence'));
  assert.deepEqual(badges.slice(0, 5).map(text), ['在线', '下班', '挂起', '离开', '状态未知']);
  const onlineRow = all.find((node) => node.tag === 'label' && text(node).includes('跨部门在线客服'))!;
  assert.ok(text(onlineRow).includes('在线下班'));
  const offlineRow = all.find((node) => node.tag === 'label' && text(node).includes('名称很长的已选客服成员'))!;
  assert.ok(text(offlineRow).includes('下班上班'));
  assert.ok(badges[0]!.props['class']?.toString().includes('free'));
});
test('online and role filters are bound to controller state and member management has automatic updates', () => {
  const { all, calls, tree } = render();
  const online = all.find((node) => node.tag === 'label' && text(node) === '仅看在线/挂起/离开')!;
  const checkbox = nodes(online).find((node) => node.tag === 'input')!;
  assert.equal(checkbox.props['checked'], true);
  (checkbox.props['onchange'] as (e: unknown) => void)({ target: { checked: false } });
  const role = all.find((node) => node.tag === 'select')!;
  assert.equal(role.props['value'], '4');
  (role.props['onchange'] as (e: unknown) => void)({ target: { value: '3' } });
  assert.deepEqual(calls, [['setOnlineOnly', false], ['setRoleFilter', '3']]);
  assert.ok(text(tree).includes('全部部门'));
  assert.ok(text(tree).includes('自动更新'));
  assert.ok(!all.some((node) => node.tag === 'button' && text(node) === '刷新'));
});
test('selected members remain removable when hidden by filters; background reads block only submission', () => {
  const { all, calls } = render({ visibleAgents: [agents[0]], refreshing: true });
  const remove = all.find((node) => node.tag === 'button' && node.props['aria-label'] === '取消选择名称很长的已选客服成员')!;
  assert.equal(remove.props['disabled'], false);
  (remove.props['onclick'] as () => void)();
  assert.deepEqual(calls, [['select', 'offline']]);
  const confirm = all.find((node) => node.tag === 'button' && (node.props['dataset'] as Record<string, string> | undefined)?.['action'] === 'peripheral-invite-confirm')!;
  assert.equal(confirm.props['disabled'], true);
  const checkbox = all.find((node) => node.tag === 'input' && node.props['aria-label'] === '选择跨部门在线客服')!;
  assert.equal(checkbox.props['disabled'], false);
});

test('clearing the invite search explicitly clears the active query', () => {
  const { all, calls } = render({ query: '华东' });
  const search = all.find(node => node.tag === 'input' && node.props['type'] === 'search')!;
  (search.props['oninput'] as (e: unknown) => void)({ target: { value: '' } });
  assert.deepEqual(calls, [['refresh', undefined, '']]);
});
