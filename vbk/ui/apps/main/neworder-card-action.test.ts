import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { messageAlignment } from './message-alignment.ts';
import * as vm from './viewmodel.ts';
import { cx } from '../../packages/ui-kit/src/h.ts';
const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
const context = { environment: 'synthetic-env', account_id: 'synthetic-account', session_generation: 1 };
const orderA = '9007199254740993', orderB = '9007199254740992';
interface Node { tag: string; props: Record<string, unknown>; children: unknown[] }
function nodes(tree: unknown): Node[] { if (Array.isArray(tree)) return tree.flatMap(nodes); if (!tree || typeof tree !== 'object') return []; const n = tree as Node; return [n, ...nodes(n.children)]; }
function fixture(sideOrder = orderB, cardOrder: string | null = orderA) {
  let account = { context, color: '#aaa' };
  let conv = { account: context, gid: 'synthetic-room', order: { order_id: sideOrder, product: 'SYNTHETIC PRODUCT' }, title: 'Synthetic Customer', color: '#aaa' };
  const state = { activeGid: conv.gid, messages: {}, prefs: { general: { show_msg_time: false } } };
  const patches: object[] = [], notices: string[] = [], outbound: unknown[] = [];
  const env: Record<string, unknown> = { ...vm, messageAlignment, cx, h: (tag: string, props: Record<string, unknown> | null, ...children: unknown[]) => ({ tag, props: props ?? {}, children }), renderMessageAvatar: () => 'avatar', document: {}, t: (k: string) => k, icon: () => null, IC: {}, S: () => state, activeAccount: () => account, activeConv: () => conv, stillActive: (scope: typeof context) => vm.sameAccount(scope, account.context), store: { patch: (p: object) => patches.push(p) }, toast: (s: string) => notices.push(s), invokeSafe: (...args: unknown[]) => outbound.push(args) };
  function actual(name: string, next: string) { const a = source.indexOf(`function ${name}(`); const b = source.indexOf(`\nfunction ${next}(`, a); assert.ok(a >= 0 && b > a); return new Function(...Object.keys(env), stripTypeScriptTypes(source.slice(a, b)) + `\nreturn ${name};`)(...Object.values(env)); }
  const guardStart = source.indexOf('function stillActive('); const guardEnd = source.indexOf('\n}', guardStart) + 2;
  env['stillActive'] = new Function(...Object.keys(env), stripTypeScriptTypes(source.slice(guardStart, guardEnd)) + '\nreturn stillActive;')(...Object.values(env));
  if (source.includes('function openMessageOrder(')) env['openMessageOrder'] = actual('openMessageOrder', 'messageRow');
  const m = { gid: conv.gid, message_id: 'synthetic-card', local_id: null, sender_role: 'customer', kind: 'order_card', text: 'SYNTHETIC CARD', order_id: cardOrder, disposition: null, quote: null, create_time_ms: 1800000000000 };
  const tree = actual('messageRow', 'translationBar')(state, m, conv, account);
  const action = nodes(tree).find(n => n.tag === 'button' && n.children.includes('chat.viewOrder'));
  assert.ok(action); const click = action.props['onclick'] as () => void;
  return { click, patches, notices, outbound, switchAccount: (next: typeof context) => { account = { ...account, context: next }; }, changeOrder: (id: string) => { conv = { ...conv, order: { ...conv.order, order_id: id } }; }, changeRoom: () => { state.activeGid = 'synthetic-other-room'; } };
}
test('actual order A card onclick cannot open the current order B sidebar', () => { const f = fixture(); f.click(); assert.equal(f.patches.length, 0); assert.equal(f.outbound.length, 0); assert.ok(f.notices[0]?.includes('未提供此订单')); });
test('same full-precision order ID opens only the matching sidebar', () => { const f = fixture(orderA); f.click(); assert.deepEqual(f.patches, [{ sideOpen: true, hotOrder: true }]); assert.equal(f.outbound.length, 0); });
test('stale account, environment, generation and room click never changes another scope', () => {
  for (const next of [{ ...context, account_id: 'synthetic-other' }, { ...context, environment: 'synthetic-other' }, { ...context, session_generation: 2 }]) { const f = fixture(orderA); f.switchAccount(next); f.click(); assert.equal(f.patches.length, 0); assert.equal(f.outbound.length, 0); }
  const f = fixture(orderA); f.changeRoom(); f.click(); assert.equal(f.patches.length, 0);
});
test('order change after render and absent card identity stay unavailable', () => { const f = fixture(orderA); f.changeOrder(orderB); f.click(); assert.equal(f.patches.length, 0); assert.equal(f.notices.length, 1); const missing = fixture(orderA, null); missing.click(); assert.equal(missing.patches.length, 0); assert.equal(missing.outbound.length, 0); });
