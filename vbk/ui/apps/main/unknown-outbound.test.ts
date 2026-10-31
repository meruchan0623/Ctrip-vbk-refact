import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUnknownOutbound, type UnknownOutboundView } from './unknown-outbound.ts';
import { UiCommands } from '../../packages/ipc/src/client.ts';
import type { AccountContext } from '../../packages/ipc/src/contracts.ts';
const account: AccountContext = { environment: 'synthetic', account_id: 'synthetic-account', session_generation: 2 };
const meta = { environment: account.environment, account_id: account.account_id, local_id: 'synthetic-local', gid: 'synthetic-room', creation_generation: 1, created_at_ms: 1800000000000, write_started: true, phase: 'unknown' };
const serverId = '9007199254740993';
const match = { gid: meta.gid, local_id: meta.local_id, message_id: serverId, sender_role: 'merchant_self', text: 'SYNTHETIC PRIVATE BODY' };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function fixture() {
  let current: AccountContext | null = account;
  let view: UnknownOutboundView | null = null;
  let list: unknown = [meta], page: unknown = { items: [match], has_more: true, before_ms: 100 };
  const calls: { command: string; payload: { account: AccountContext; gid?: string } }[] = [];
  const panel = createUnknownOutbound({ current: () => current, publish: next => { view = next; }, invoke: async (command, payload) => { calls.push({ command, payload }); const result = command === UiCommands.IM_UNKNOWN_OUTBOUND ? list : page; if (result instanceof Error) throw result; return result; } });
  return { panel, calls, view: () => view, current: (next: AccountContext | null) => { current = next; }, list: (next: unknown) => { list = next; }, page: (next: unknown) => { page = next; }, noWrites: () => { assert.equal(calls.filter(c => c.command !== UiCommands.IM_UNKNOWN_OUTBOUND && c.command !== UiCommands.IM_OUTBOUND_LOOKUP).length, 0); } };
}
test('manual old-generation metadata -> explicit selection -> one latest-page lookup, without mutating the unknown ledger', async () => {
  const f = fixture(); await f.panel.open();
  assert.deepEqual(f.calls, [{ command: UiCommands.IM_UNKNOWN_OUTBOUND, payload: { account } }]);
  assert.equal(f.view()?.records[0]?.creation_generation, 1);
  f.panel.select(meta.gid, meta.local_id); assert.equal(f.calls.length, 1);
  await f.panel.verify(); assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[1], { command: UiCommands.IM_OUTBOUND_LOOKUP, payload: { account, gid: meta.gid } });
  assert.equal(f.view()?.result?.kind, 'found'); assert.equal(f.view()?.result?.server_id, serverId);
  assert.equal(f.view()?.records[0]?.phase, 'unknown'); assert.equal(JSON.stringify(f.view()).includes('PRIVATE'), false);
  await Promise.resolve(); assert.equal(f.calls.length, 2, 'has_more never starts paging or polling'); f.noWrites();
});
test('all nonunique, wrong-role, mismatched and malformed page results remain unknown with zero send or mark-read', async () => {
  const pages: unknown[] = [
    { items: [] }, { items: [match, match] }, { items: [{ ...match, sender_role: 'merchant_other' }] },
    { items: [{ ...match, account: { ...account, account_id: 'synthetic-other' } }] }, { items: [{ ...match, account: { ...account, session_generation: 3 } }] },
    { items: [{ ...match, gid: 'synthetic-other-room' }] }, { items: [{ ...match, local_id: 'synthetic-local-alias' }] },
    { items: [{ ...match, message_id: 9007199254740992 }] }, { items: [{ ...match, message_id: ' ' + serverId }] },
    { items: [{ ...match, message_id: '' }] }, { items: 'invalid' }, null, new Error('SYNTHETIC PRIVATE ERROR'),
  ];
  for (const page of pages) { const f = fixture(); f.page(page); await f.panel.open(); f.panel.select(meta.gid, meta.local_id); await f.panel.verify(); assert.equal(f.view()?.result?.kind, 'unknown'); assert.equal(f.view()?.result?.server_id, null); assert.equal(JSON.stringify(f.view()).includes('PRIVATE'), false); assert.equal(f.calls.length, 2); f.noWrites(); }
  const f = fixture(); f.page({ items: [] }); await f.panel.open(); f.panel.select(meta.gid, meta.local_id); await f.panel.verify(); assert.ok(f.view()?.result?.message.includes('不是发送被拒绝的证据'));
});
test('metadata guards reject other scopes and unsafe values, whitelist extra fields and refuse duplicate selection', async () => {
  const f = fixture();
  f.list([{ ...meta, body: 'SYNTHETIC PRIVATE BODY' }, { ...meta, account_id: 'synthetic-other' }, { ...meta, environment: 'other' }, { ...meta, creation_generation: NaN }, { ...meta, created_at_ms: Number.MAX_SAFE_INTEGER + 1 }, { ...meta, created_at_ms: 8900000000000000 }, { ...meta, phase: 'confirmed' }, { ...meta, write_started: false }, { ...meta, local_id: ' synthetic-local' }]);
  await f.panel.open(); assert.equal(f.view()?.records.length, 1); assert.equal(JSON.stringify(f.view()).includes('PRIVATE'), false);
  f.list([meta, meta]); await f.panel.refresh(); f.panel.select(meta.gid, meta.local_id); await f.panel.verify();
  assert.equal(f.view()?.selected, null); assert.equal(f.view()?.result?.kind, 'unknown'); assert.equal(f.calls.length, 2); f.noWrites();
});
test('list failures/no account and verify without selection never send anything', async () => {
  const f = fixture(); f.current(null); await f.panel.open(); assert.equal(f.calls.length, 0); assert.equal(f.view(), null);
  f.current(account); f.list(new Error('SYNTHETIC PRIVATE ERROR')); await f.panel.open(); await f.panel.verify();
  assert.equal(f.calls.length, 1); assert.equal(f.view()?.records.length, 0); assert.equal(JSON.stringify(f.view()).includes('PRIVATE'), false); f.noWrites();
});
test('busy prevents double lookup and late page after environment/account/generation switch cannot publish a result', async () => {
  for (const next of [{ ...account, environment: 'other' }, { ...account, account_id: 'synthetic-other' }, { ...account, session_generation: 3 }]) {
    const f = fixture(), pending = deferred<unknown>(); await f.panel.open(); f.panel.select(meta.gid, meta.local_id); f.page(pending.promise);
    const read = f.panel.verify(); await f.panel.verify(); assert.equal(f.calls.length, 2);
    f.current(next); pending.resolve({ items: [match] }); await read;
    assert.equal(f.view(), null); f.noWrites();
  }
});
test('old list response and close/reopen page response are discarded by request generation', async () => {
  const f = fixture(), listing = deferred<unknown>(); f.list(listing.promise); const open = f.panel.open();
  f.panel.close(); f.list([meta]); await f.panel.open(); const visible = f.view(); listing.resolve([{ ...meta, local_id: 'synthetic-stale' }]); await open; assert.equal(f.view(), visible);
  const reading = deferred<unknown>(); f.panel.select(meta.gid, meta.local_id); f.page(reading.promise); const read = f.panel.verify(); f.panel.close(); await f.panel.open(); const reopened = f.view();
  reading.resolve({ items: [match] }); await read; assert.equal(f.view(), reopened); assert.equal(f.view()?.result, null); f.noWrites();
});
test('a changed scope before selecting or refreshing closes without making another read', async () => {
  for (const operation of ['select', 'refresh'] as const) { const f = fixture(); await f.panel.open(); f.current({ ...account, session_generation: 3 }); if (operation === 'select') f.panel.select(meta.gid, meta.local_id); else await f.panel.refresh(); assert.equal(f.view(), null); assert.equal(f.calls.length, 1); f.noWrites(); }
});

// Execute the real dialog and status-bar click entry against the real controller.
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { cx } from '../../packages/ui-kit/src/h.ts';
interface RenderNode { tag: string; props: Record<string, unknown>; children: unknown[] }
function allNodes(tree: unknown): RenderNode[] { if (Array.isArray(tree)) return tree.flatMap(allNodes); if (!tree || typeof tree !== 'object') return []; const node = tree as RenderNode; return [node, ...allNodes(node.children ?? [])]; }
test('actual status-bar -> dialog -> selected latest-page click uses only metadata/page commands and displays no body', async () => {
  const f = fixture();
  const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  const env: Record<string, unknown> = { cx, h: (tag: string, props: Record<string, unknown> | null, ...children: unknown[]) => ({ tag, props: props ?? {}, children }), stillActive: () => true, unknownOutbound: f.panel, peripheral: { close() {} }, receiveDiagnostics: { close() {} }, formatDate: () => 'synthetic-date', formatClock: () => 'synthetic-time', icon: () => null, IC: {}, t: (key: string) => key, agentView: () => ({ known: false }), netView: () => ({ ok: true }), activeAccount: () => ({ context: account }), sel: { mock: false }, clockEl: null };
  function actual(name: string, next: string) { const a = source.indexOf(`function ${name}(`), b = source.indexOf(`\nfunction ${next}(`, a); assert.ok(a >= 0 && b > a); return new Function(...Object.keys(env), stripTypeScriptTypes(source.slice(a, b)) + `\nreturn ${name};`)(...Object.values(env)); }
  env['openUnknownOutbound'] = actual('openUnknownOutbound', 'openPeripheral');
  const bar = actual('statusBar', 'unknownOutboundDialog')({ now: 100, alarmCount: 0, clockTrusted: true });
  const entry = allNodes(bar).find(node => (node.props['dataset'] as Record<string, string> | undefined)?.['action'] === 'unknown-outbound'); assert.ok(entry);
  (entry.props['onclick'] as () => void)(); await Promise.resolve(); await Promise.resolve();
  assert.equal(f.calls.length, 1);
  const dialog = actual('unknownOutboundDialog', 'receiveDiagnosticsDialog');
  const before = dialog({ unknownOutbound: f.view() });
  const readBefore = allNodes(before).find(node => node.tag === 'button' && node.children.includes('读取所选会话最新页')); assert.equal(readBefore?.props['disabled'], true);
  const radio = allNodes(before).find(node => node.tag === 'input'); assert.ok(radio); (radio.props['onchange'] as () => void)();
  const selected = dialog({ unknownOutbound: f.view() });
  const read = allNodes(selected).find(node => node.tag === 'button' && node.children.includes('读取所选会话最新页')); assert.ok(read); (read.props['onclick'] as () => void)(); await Promise.resolve(); await Promise.resolve();
  const result = JSON.stringify(dialog({ unknownOutbound: f.view() }));
  assert.equal(f.calls.length, 2); assert.ok(result.includes(serverId)); assert.ok(result.includes('账本仍保留未知')); assert.equal(result.includes('PRIVATE'), false); f.noWrites();
});
