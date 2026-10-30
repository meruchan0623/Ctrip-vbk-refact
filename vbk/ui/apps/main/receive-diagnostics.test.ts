import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { createReceiveCounters, createReceiveDiagnostics, safeReceiveDiagnostics, receiveDiagnosticsJson, type ReceiveDiagnosticsView } from './receive-diagnostics.ts';
import { mergeMessageProfile } from './message-profile.ts';
import { guarded, isUiMessage, messageAccount } from '../_shared/guards.ts';
import type { AccountContext } from '../../packages/ipc/src/contracts.ts';

const account: AccountContext = { account_id: 'synthetic-account', environment: 'synthetic', session_generation: 1 };
const diagnostics = { version: 1, captured_at_ms: 100, availability: 'ready', page: null, host: { display_entered: 1, display_decode_rejected: 0, display_apply_rejected: 0, message_items: 1, changed_messages: 1, main_emit_attempts: 1 } };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }

test('actual main message entry counts received, malformed, account drop and applied messages separately', () => {
  const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  const start = source.indexOf('function receiveMainMessage(');
  const end = source.indexOf('\nfunction upsertMessage(', start);
  assert.ok(start >= 0 && end > start);
  const counters = createReceiveCounters();
  let current = account;
  let state: { messages: Record<string, unknown[]> } = { messages: { 'synthetic-room': [] } };
  const upsertStart = source.indexOf('function upsertMessage(');
  const upsertEnd = source.indexOf('\nfunction upsertConversation(', upsertStart);
  assert.ok(upsertStart >= 0 && upsertEnd > upsertStart);
  const upsertMessage = new Function('S', 'store', 'mergeMessageProfile', stripTypeScriptTypes(source.slice(upsertStart, upsertEnd)) + '\nreturn upsertMessage;')(() => state, { patch: (patch: object) => Object.assign(state, patch) }, mergeMessageProfile);
  const env = { receiveCounters: counters, activeAccount: () => ({ context: current }), guarded, isUiMessage, messageAccount, Events: { IM_MESSAGE_NEW: 'im://message-new' }, stillActive: (owner: AccountContext) => owner.account_id === current.account_id && owner.environment === current.environment && owner.session_generation === current.session_generation, upsertMessage };
  const receive = new Function(...Object.keys(env), stripTypeScriptTypes(source.slice(start, end)) + '\nreturn receiveMainMessage;')(...Object.values(env)) as (payload: unknown) => void;
  const message = { account, gid: 'synthetic-room', message_id: 'synthetic-message', local_id: null, sender_role: 'customer', kind: 'text', text: 'SYNTHETIC NEVER IN DIAGNOSTICS', create_time_ms: 100, translation: null, original: null, quote: null, order_id: null, disposition: null };
  receive(message);
  receive({ malformed: true });
  receive({ ...message, account: { ...account, session_generation: 2 } });
  assert.deepEqual(counters.snapshot(account), { received: 3, guard_rejected: 1, account_dropped: 1, upserted: 1 });
  assert.equal(state.messages['synthetic-room']?.length, 1);
  current = { ...account, account_id: 'synthetic-other-account', session_generation: 2 };
  receive(message);
  assert.deepEqual(counters.snapshot(current), { received: 1, guard_rejected: 0, account_dropped: 1, upserted: 0 });
  assert.equal(counters.snapshot(account).received, 3);
  state = { messages: {} };
  receive({ ...message, account: current });
  assert.deepEqual(counters.snapshot(current), { received: 2, guard_rejected: 0, account_dropped: 1, upserted: 0 }, 'a valid message for an unopened thread was not actually upserted');
});

test('manual pull captures account generation, never polls, and ignores late responses after switching', async () => {
  const pending = deferred<unknown>();
  let current = account;
  const calls: unknown[] = [];
  let view: ReceiveDiagnosticsView | null = null;
  const panel = createReceiveDiagnostics({ current: () => current, counters: createReceiveCounters(), now: () => 100, publish: (next) => { view = next; }, invoke: async (payload) => { calls.push(payload); return calls.length === 1 ? pending.promise : { diagnostics }; } });
  const opening = panel.open();
  assert.deepEqual(calls, [{ include_diagnostics: true, account }]);
  current = { ...account, session_generation: 2 };
  panel.close(); await panel.open();
  assert.equal((view as ReceiveDiagnosticsView | null)?.snapshot?.availability, 'ready');
  const after = view;
  pending.resolve({ diagnostics: { ...diagnostics, availability: 'timeout' } }); await opening;
  assert.equal(view, after);
  await Promise.resolve(); assert.equal(calls.length, 2, 'no implicit polling or retries');
  await panel.refresh(); assert.equal(calls.length, 3, 'only explicit refresh pulls again');
});

test('copied snapshot strips all unknown identifiers, payloads and arbitrary error strings', () => {
  const safe = safeReceiveDiagnostics({ ...diagnostics, account_id: 'SYNTHETIC PRIVATE ACCOUNT', body: 'SYNTHETIC PRIVATE BODY', host: { ...diagnostics.host, uid: 'SYNTHETIC PRIVATE UID', url: 'https://example.invalid/private' } }, 100);
  const serialized = receiveDiagnosticsJson({ ...safe, main: { received: 1, guard_rejected: 0, account_dropped: 0, upserted: 1 } });
  assert.equal(serialized.includes('PRIVATE'), false);
  assert.equal(serialized.includes('example.invalid'), false);
  assert.equal(JSON.parse(serialized).host.message_items, 1);
  assert.equal(safeReceiveDiagnostics({ ...diagnostics, host: { ...diagnostics.host, message_items: 'SYNTHETIC PRIVATE ERROR' } }, 100).availability, 'invalid');
});

test('no account and pull failure remain fixed safe availability values', async () => {
  let current: AccountContext | null = null;
  let calls = 0; let view: ReceiveDiagnosticsView | null = null;
  const panel = createReceiveDiagnostics({ current: () => current, counters: createReceiveCounters(), now: () => 100, publish: (next) => { view = next; }, invoke: async () => { calls++; throw new Error('SYNTHETIC PRIVATE ERROR'); } });
  await panel.open(); assert.equal(calls, 0); assert.equal((view as ReceiveDiagnosticsView | null)?.snapshot?.availability, 'no_account');
  current = account; panel.close(); await panel.open();
  assert.equal((view as ReceiveDiagnosticsView | null)?.snapshot?.availability, 'unavailable');
  assert.equal(JSON.stringify(view).includes('PRIVATE'), false);
});

const fullDiagnostics = {
  ...diagnostics,
  page: {
    version: 1, captured_at_ms: 100, running: true, run_generation: 1,
    sdk: { binding: { global_state: 'emitter', listener_health: 'verified', attached: true, can_rebind: true, binding_generation: 1, attach_count: 1, repair_count: 0, uid: 'SYNTHETIC PRIVATE UID' }, counters: { callbacks: 2, stale_callbacks: 0, messages: 1, acks: 1, ignored: 0, listener_errors: 0 }, last_stanza_ms: 100, body: 'SYNTHETIC PRIVATE BODY' },
    session: { received: 1, ui_mapped: 1, ui_dropped: 0, display_batches: 1, display_items: 1, display_resolved: 1, display_rejected: 0 },
    compensation: { running: true, mode: 'normal', cursor_ms: 100, last_outcome_ms: null, outcomes: { success: 1, business_failure: 0, auth_invalid: 0, http_error: 0, malformed: 0, network_error: 0, timeout: 0, unknown: 0 }, rows: 0, mapped: 0, dropped: 0, url: 'https://example.invalid/PRIVATE' },
  },
};

test('full SDK/session/compensation diagnostics remain typed aggregates after sanitization', () => {
  const safe = safeReceiveDiagnostics(fullDiagnostics, 100);
  assert.equal(safe.availability, 'ready');
  assert.equal(safe.page?.sdk?.counters.messages, 1);
  assert.equal(safe.page?.compensation.mode, 'normal');
  assert.equal(JSON.stringify(safe).includes('PRIVATE'), false);
  assert.equal(safeReceiveDiagnostics({ ...fullDiagnostics, page: { ...fullDiagnostics.page, sdk: { ...fullDiagnostics.page.sdk, counters: { ...fullDiagnostics.page.sdk.counters, callbacks: 'SYNTHETIC PRIVATE' } } } }, 100).availability, 'invalid');
});

test('actual visible diagnostics dialog copies only safe JSON and performs no implicit refresh', () => {
  const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  const start = source.indexOf('function receiveDiagnosticsDialog(');
  const end = source.indexOf('\nfunction logoutDialog(', start);
  assert.ok(start >= 0 && end > start);
  interface Node { tag: string; props: Record<string, unknown>; children: unknown[] }
  const walk = (tree: unknown): Node[] => Array.isArray(tree) ? tree.flatMap(walk) : tree && typeof tree === 'object' ? [tree as Node, ...walk((tree as Node).children ?? [])] : [];
  const copies: string[] = []; let refreshes = 0;
  const env = { receiveDiagnostics: { close() {}, refresh() { refreshes++; } }, h: (tag: string, props: Record<string, unknown> | null, ...children: unknown[]) => ({ tag, props: props ?? {}, children }), icon: () => null, IC: {}, formatClock: () => 'synthetic-time', receiveDiagnosticsJson, copyText: (text: string) => { copies.push(text); } };
  const render = new Function(...Object.keys(env), stripTypeScriptTypes(source.slice(start, end)) + '\nreturn receiveDiagnosticsDialog;')(...Object.values(env));
  const snapshot = { ...safeReceiveDiagnostics(fullDiagnostics, 100), main: { received: 1, guard_rejected: 0, account_dropped: 0, upserted: 1 } };
  const tree = walk(render({ receiveDiagnostics: { busy: false, snapshot } }));
  assert.ok(tree.some((node) => node.props['role'] === 'dialog'));
  const pre = tree.find((node) => node.tag === 'pre');
  assert.ok(pre);
  assert.equal(JSON.parse(pre.children[0] as string).main.upserted, 1);
  const copy = tree.find((node) => node.tag === 'button' && node.children.includes('复制安全JSON'));
  assert.ok(copy);
  (copy.props['onclick'] as () => void)();
  assert.equal(copies[0], pre.children[0]);
  assert.equal(copies[0]?.includes('PRIVATE'), false);
  assert.equal(refreshes, 0);
  const refresh = tree.find((node) => node.tag === 'button' && node.children.includes('只读刷新'));
  assert.ok(refresh);
  (refresh.props['onclick'] as () => void)();
  assert.equal(refreshes, 1);
});
