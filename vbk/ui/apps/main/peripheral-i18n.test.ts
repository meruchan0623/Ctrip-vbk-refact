import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { hasKey, t } from '../../packages/ui-kit/src/i18n.ts';
import { peripheralStrings } from '../../packages/ui-kit/src/peripheral/strings.ts';
import { createPeripheralPanel, inviteAgentRole, type PeripheralKind, type PeripheralPanelState } from './peripheralPanel.ts';
import { peripheralWriteView } from './viewmodel.ts';
import type { UiPeripheralWrite } from '../../packages/ipc/src/client.ts';
const { scanFile, expectNoCjkLiterals } = await import(new URL('../../../tools/gates/cjk-literals.mjs', import.meta.url).href);
const expected = {
  malformedMembers: '成员返回格式无效，正在等待自动更新。', malformedCandidates: '候选返回格式无效，正在等待自动更新。',
  directoryTooLarge: '部门目录过大，暂时无法完整加载。',
  memberTimeout: '成员状态读取超时，正在等待自动更新。', finishExpired: '会话确认已过期，已只读刷新。请再次确认结束。',
  candidatesExpired: '候选已过期，已自动更新。请重新选择。', finishNotSubmitted: '本次操作尚未提交。请刷新会话后再次确认。',
  membersNotSubmitted: '本次操作尚未提交，成员和会话将自动更新，请稍后再次确认。',
  confirmedTitle: '已确认', confirmedMessage: '已通过独立读回确认本次操作。', acceptedTitle: '已受理，待核验',
  acceptedMessage: '服务端已受理操作。可刷新成员和会话核对结果，请勿重复提交。', unknownTitle: '结果未知，待核验',
  unknownMessage: '操作可能已经生效。仅可只读刷新成员和会话，不会重新发送操作。',
} as const;

test('14 peripheral copy entries preserve exact original text and have static references only in the owned scope', () => {
  const references = new Set<string>();
  const panel = readFileSync(new URL('./peripheralPanel.ts', import.meta.url), 'utf8');
  const model = readFileSync(new URL('./viewmodel.ts', import.meta.url), 'utf8');
  const start = model.indexOf('export function peripheralWriteView('), end = model.indexOf('\n/** UI-only provenance:', start);
  assert.ok(start >= 0 && end > start);
  for (const text of [panel, model.slice(start, end)]) {
    expectNoCjkLiterals(scanFile('ui/apps/main/peripheral-runtime.ts', text));
    const source = ts.createSourceFile('peripheral-runtime.ts', text, ts.ScriptTarget.Latest, true);
    function inspect(node: ts.Node): void {
      if (ts.isCallExpression(node) && node.expression.getText(source) === 't') {
        const key = node.arguments[0]; assert.ok(key && ts.isStringLiteral(key));
        assert.ok(hasKey(key.text)); references.add(key.text); assert.equal(node.arguments.length, 1, 'these fixed messages contain no user-data interpolation');
      }
      ts.forEachChild(node, inspect);
    }
    inspect(source);
  }
  assert.deepEqual([...references].sort(), Object.keys(peripheralStrings).sort());
  for (const [name, value] of Object.entries(expected)) {
    const key = `peripheralRuntime.${name}`; assert.ok(hasKey(key)); assert.equal(t(key), value);
  }
});

test('Chinese job-position aliases remain protocol matches with numeric precedence and unknown roles fail closed', () => {
  for (const [job_position, id] of [['管理员', '1'], ['财务', '2'], ['运营', '3'], ['客服', '4']] as const) {
    assert.equal(inviteAgentRole({ uid: 'u', nickname: null, job_position: ` ${job_position} ` }), id);
    assert.equal(inviteAgentRole({ uid: 'u', nickname: null, job_position, job_position_type: 4 }), '4');
  }
  assert.equal(inviteAgentRole({ uid: 'u', nickname: null, job_position: 'unknown {role}' }), 'unknown');
  assert.equal(inviteAgentRole({ uid: 'u', nickname: null, job_position: '管理员 {role}' }), 'unknown');
});

test('actual accepted, contradictory-confirmed and unknown write explanations never promise success or a resend', () => {
  assert.deepEqual(peripheralWriteView({ kind: 'confirmed', confirmed: true }), { title: expected.confirmedTitle, message: expected.confirmedMessage, confirmed: true });
  for (const confirmed of [true, false]) assert.deepEqual(peripheralWriteView({ kind: 'accepted', confirmed }), { title: expected.acceptedTitle, message: expected.acceptedMessage, confirmed: false });
  for (const kind of ['unknown', 'not_submitted', 'confirmed'] as const) {
    const result: UiPeripheralWrite = { kind, confirmed: false };
    assert.deepEqual(peripheralWriteView(result), { title: expected.unknownTitle, message: expected.unknownMessage, confirmed: false });
  }
});

test('actual malformed read errors keep their exact UI explanation without introducing a write or retry', async () => {
  for (const [kind, message] of [['members', expected.malformedMembers], ['invite', expected.malformedCandidates]] as [PeripheralKind, string][]) {
    let state: PeripheralPanelState | null = null;
    const current = () => state;
    const calls: string[] = [];
    const panel = createPeripheralPanel({ current: () => ({ account: { account_id: 'a', environment: 'synthetic', session_generation: 1 }, gid: 'room' }), invoke: async command => { calls.push(command); return {}; }, publish: value => { state = value; }, now: () => 100, refreshConversation: async () => {}, schedule: () => () => {} });
    await panel.open(kind);
    assert.equal(current()?.error, message); assert.equal(calls.length, 1);
    assert.equal(current()?.submitted, false); panel.close();
  }
});
