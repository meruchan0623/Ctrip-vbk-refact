import { t as translateUi } from '../../packages/ui-kit/src/i18n.ts';
/**
 * I-04a send barrier, UI side: `UiAccountSnapshot.persist_failed` pauses the
 * composer, shows the status-bar notice, and the host's `store.persist_failed`
 * refusal is rendered as a local reject (nothing submitted), never as unknown.
 * The host is the real gate; these tests cover the mirror in main.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { createComposerInput } from './composer-input.ts';
import { createStore, subscribeBatched } from '../../packages/ui-kit/src/store.ts';
import * as vm from './viewmodel.ts';
import { cx } from '../../packages/ui-kit/src/h.ts';
import { ErrorCodes } from '../../packages/ipc/src/contracts.ts';
import { isUiAccountSnapshot } from '../_shared/guards.ts';
import { createMockIpc } from '../../packages/ipc/src/mock.ts';
import { AccountCommands } from '../../packages/ipc/src/commands.ts';

const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
type Tree = { tag: string; props: Record<string, any>; children: unknown[] };
function nodes(tree: unknown): Tree[] { if (Array.isArray(tree)) return tree.flatMap(nodes); if (!tree || typeof tree !== 'object' || !('tag' in tree)) return []; const node = tree as Tree; return [node, ...node.children.flatMap(nodes)]; }
function slice(name: string, end: string): string { const sync = source.indexOf(`function ${name}(`); const a = source.startsWith('async ', sync - 6) ? sync - 6 : sync; const b = source.indexOf(`\n${end}`, a); assert.ok(sync >= 0 && b > a, name); return stripTypeScriptTypes(source.slice(a, b)); }
const account = { account_id: 'synthetic-account', environment: 'test', session_generation: 1 };
const conv = { gid: 'synthetic-room', account, status: 'active', lang: 'en' };

function composerFixture(persist_failed: boolean | undefined) {
  const store = createStore<any>({ view: 'messages', draft: 'kept draft', drafts: {}, draftVersion: 3, activeGid: conv.gid, conversations: [conv], accounts: { active_account_id: account.account_id, accounts: [{ context: account, state: 'online' }], max_accounts: 16, persist_failed }, translation: { ...vm.TRANSLATION_IDLE }, messages: {}, quote: null, attachment: null, prefs: { keys: { send_key: 'enter' }, assistant: { enabled: false } } });
  let sends = 0;
  const env: Record<string, any> = { visibleReads: { retry() {}, afterRender() {} },
    ...vm, createComposerInput, cx, store, S: () => store.get(),
    activeAccount: () => store.get().accounts.accounts[0], activeConv: () => store.get().conversations[0],
    scheduleTranslation() {}, clearTimeout,
    h: (tag: string, props: Record<string, any> | null, ...children: unknown[]) => ({ tag, props: props ?? {}, children }),
    t: translateUi, icon: () => null, IC: {}, translationOn: () => false, translationBar: () => null, notWired: (x: unknown) => x,
    handleSend: () => { sends++; }, subscribeFrame: subscribeBatched, fillHistoryViewport() {}, syncConversationViewport() {}, withMessageAnchor: (_: unknown, redraw: () => void) => redraw(), root: {}, rerender() {},
  };
  env['setDraft'] = new Function(...Object.keys(env), slice('setDraft', 'async function resend(') + '\nreturn setDraft;')(...Object.values(env));
  const a = source.indexOf('const composerInput ='), b = source.indexOf('function scheduleTranslation(', a);
  Object.assign(env, new Function(...Object.keys(env), stripTypeScriptTypes('let trTimer = null;\n' + source.slice(a, b)) + '\nreturn {composerInput, composerInputContext};')(...Object.values(env)));
  env['setSendMode'] = () => {};
  for (const [n, e] of [['ctool', 'function formatFileSize('], ['formatFileSize', 'function composerMoreMenu('], ['composerMoreMenu', 'function composer(']] as const) env[n] = new Function(...Object.keys(env), slice(n, e) + `\nreturn ${n};`)(...Object.values(env));
  const composer = new Function(...Object.keys(env), slice('composer', 'function emojiPicker(') + '\nreturn composer;')(...Object.values(env));
  const tree = composer(store.get(), conv);
  return { tree, send: nodes(tree).find((x) => x.props.dataset?.action === 'send')!, hint: nodes(tree).find((x) => x.props.dataset?.persistFailed === '1'), sends: () => sends };
}

test('viewmodel: persist_failed mirror reads only an explicit true; absent or null snapshot is open', () => {
  assert.equal(vm.persistFailed(null), false);
  assert.equal(vm.persistFailed(undefined), false);
  assert.equal(vm.persistFailed({}), false);
  assert.equal(vm.persistFailed({ persist_failed: false }), false);
  assert.equal(vm.persistFailed({ persist_failed: true }), true);
  assert.equal(vm.persistFailedView({ persist_failed: false }), null);
  const view = vm.persistFailedView({ persist_failed: true });
  assert.ok(view);
  assert.equal(view.label, '本地保存失败，发送已暂停');
  assert.ok(view.title.length > 0);
});

test('viewmodel: a store.persist_failed IPC refusal is a local reject (nothing submitted); other failures stay unknown', () => {
  const barrier = { code: ErrorCodes.STORE_PERSIST_FAILED, message: 'local persistence failed', retryable: true };
  assert.deepEqual(vm.sendFailureDisposition(barrier), { kind: 'rejected', code: 'store.persist_failed', reason: '本地保存失败，发送已暂停' });
  assert.deepEqual(vm.sendFailureDisposition({ code: ErrorCodes.IM_PERMISSION_DENIED, message: 'no', retryable: false }), { kind: 'rejected', code: 'im.permission_denied', reason: 'no' });
  assert.deepEqual(vm.sendFailureDisposition({ code: ErrorCodes.ADAPTER_TIMEOUT, message: 'late', retryable: true }), { kind: 'unknown' }, 'a timeout may have been submitted');
  assert.deepEqual(vm.sendFailureDisposition(new Error('transport')), { kind: 'unknown' });
  assert.equal(vm.sendStateView(vm.sendFailureDisposition(barrier)).canRetry, true, 'the user may resend once the barrier reopens');
});

test('actual composer: persist_failed disables the send button and replaces the hint; the draft is untouched', () => {
  const blocked = composerFixture(true);
  assert.equal(blocked.send.props.disabled, true);
  assert.ok(blocked.hint, 'hint carries data-persist-failed');
  assert.equal(blocked.hint!.props.role, 'status');
  assert.deepEqual(blocked.hint!.children, [translateUi('composer.persistFailed')]);
  assert.equal(nodes(blocked.tree).find((x) => x.tag === 'textarea')!.props.value, 'kept draft');
  for (const flag of [false, undefined]) {
    const open = composerFixture(flag);
    assert.equal(open.send.props.disabled, false, `flag=${String(flag)}`);
    assert.equal(open.hint, undefined);
  }
});

test('actual handleSend: refuses with a toast while persist_failed, without calling sendComposer', async () => {
  let composed = 0; const toasts: string[] = [];
  const state = { draft: 'x', attachment: null, prefs: null, accounts: { persist_failed: true } };
  const env: Record<string, any> = { ...vm, S: () => state, activeConv: () => conv, toast: (m: string) => toasts.push(m), t: translateUi, sendComposer: async () => { composed++; return 'sent'; }, sendText: async () => {}, translateAndSend: async () => {}, sendMediaAttachment: async () => {}, translationOn: () => false, ATTACHMENT_SEND_UNAVAILABLE: 'x' };
  const handleSend = new Function(...Object.keys(env), slice('handleSend', 'function ownedAttachment(') + '\nreturn handleSend;')(...Object.values(env));
  await handleSend();
  assert.equal(composed, 0);
  assert.deepEqual(toasts, [translateUi('bar.persistFailed')]);
  state.accounts.persist_failed = false;
  await handleSend();
  assert.equal(composed, 1, 'sending resumes once the host clears the flag');
});

test('actual statusBar: shows the persist_failed notice as an alert only while the flag is set', () => {
  const env: Record<string, any> = { cx, h: (tag: string, props: Record<string, any> | null, ...children: unknown[]) => ({ tag, props: props ?? {}, children }), icon: () => null, IC: {}, t: (key: string) => key, formatDate: () => 'd', formatClock: () => 'c', agentView: () => ({ known: false }), netEverConnected: true, netView: () => ({ ok: true }), persistFailedView: vm.persistFailedView, activeAccount: () => ({ context: account }), sel: { mock: false }, clockEl: null, openUnknownOutbound() {}, receiveDiagnostics: { open() {} } };
  const statusBar = new Function(...Object.keys(env), slice('statusBar', 'function unknownOutboundDialog(') + '\nreturn statusBar;')(...Object.values(env));
  const item = (s: unknown) => nodes(statusBar(s)).find((n) => n.props.dataset?.sb === 'persist-failed');
  const shown = item({ now: 1, alarmCount: 0, clockTrusted: true, accounts: { persist_failed: true } });
  assert.ok(shown);
  assert.equal(shown.props.role, 'alert');
  assert.ok(shown.children.includes('本地保存失败，发送已暂停'));
  assert.equal(item({ now: 1, alarmCount: 0, clockTrusted: true, accounts: { persist_failed: false } }), undefined);
  assert.equal(item({ now: 1, alarmCount: 0, clockTrusted: true, accounts: null }), undefined);
});

test('guard: account snapshot accepts a boolean persist_failed, tolerates its absence, rejects a non-boolean', async () => {
  const ipc = createMockIpc('default', { tick: false, latency: 0 });
  const snap = await ipc.invoke<Record<string, unknown>>(AccountCommands.SNAPSHOT);
  ipc.dispose();
  assert.equal(isUiAccountSnapshot(snap), true, 'mock snapshot has no flag');
  assert.equal(isUiAccountSnapshot({ ...snap, persist_failed: true }), true);
  assert.equal(isUiAccountSnapshot({ ...snap, persist_failed: false }), true);
  assert.equal(isUiAccountSnapshot({ ...snap, persist_failed: 'yes' }), false);
  assert.equal(isUiAccountSnapshot({ ...snap, persist_failed: 1 }), false);
});
