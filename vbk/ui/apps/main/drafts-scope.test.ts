import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import * as vm from './viewmodel.ts';
import { mergeMessageProfile } from './message-profile.ts';
import { settleAccountSend } from './sendScope.ts';
import { sendComposer, attachmentSendUnavailable } from './sendComposer.ts';
import { isAppError } from '../../packages/ipc/src/contracts.ts';
import { isUiMessage } from '../_shared/guards.ts';
import { createStore } from '../../packages/ui-kit/src/store.ts';
import { cx } from '../../packages/ui-kit/src/h.ts';
import type { UiMessage } from '../../packages/ipc/src/client.ts';
const source = readFileSync(process.env['VBK_DRAFTS_MAIN_SOURCE'] ?? new URL('./main.ts', import.meta.url), 'utf8');
const context = { account_id: 'synthetic-account', environment: 'synthetic', session_generation: 1 };
function deferred() { let resolve!: (value: unknown) => void; const promise = new Promise<unknown>(r => { resolve = r; }); return { promise, resolve }; }
interface Node { tag: string; props: Record<string, unknown>; children: unknown[] }
function nodes(tree: unknown): Node[] { if (Array.isArray(tree)) return tree.flatMap(nodes); if (!tree || typeof tree !== 'object') return []; const node = tree as Node; return [node, ...nodes(node.children ?? [])]; }
function fixture() {
  const conversations = ['synthetic-A', 'synthetic-B'].map(gid => ({ gid, account: context, status: 'active', unread_count: 0, draft: 'SYNTHETIC SERVER ' + gid, lang: 'en' }));
  const state = { accounts: { active_account_id: context.account_id, accounts: [{ context, state: 'online', color: '#aaa' }] }, conversations, activeGid: 'synthetic-A' as string | null, messages: { 'synthetic-A': [], 'synthetic-B': [] } as Record<string, UiMessage[]>, history: {}, banners: [], view: 'messages', draft: '', drafts: {} as Record<string, string>, draftVersion: 1, quote: null, attachment: null, translation: { ...vm.TRANSLATION_IDLE } as vm.TranslationState, prefs: { assistant: { enabled: true, outbound_translation: true, send_mode: 'replace_draft' } }, trBarOff: false, loginAttempt: null };
  const store = createStore(state);
  const calls: { command: string; payload: Record<string, unknown> }[] = [];
  let sendResult: unknown = { kind: 'confirmed', server_message_id: 'synthetic-confirmed', server_time_ms: 1800000000000 };
  let translateResult: unknown = { draft_version: 1, text: 'SYNTHETIC TRANSLATION' };
  const env: Record<string, unknown> = { ...vm, isUiMessage, isAppError, mergeMessageProfile, cx, settleAccountSend, sendComposer, attachmentSendUnavailable, S: () => store.get(), store, peripheral: { close() {} }, receiveDiagnostics: { close() {} }, unknownOutbound: { close() {} }, PKG_IDLE: {}, invokeQuiet: async (command: string) => command === 'page' ? ({ items: [], has_more: false, before_ms: null }) : [], autoQueryPackage() {}, loadForActiveAccount: async () => {}, scheduleTranslation() {}, translationOn: () => true, toast() {}, errorMessage: () => 'synthetic error', t: (key: string) => key, icon: () => null, IC: {}, TR_TARGETS: ['en'], langName: (code: string) => code, copyText() {}, h: (tag: string, props: Record<string, unknown> | null, ...children: unknown[]) => ({ tag, props: props ?? {}, children }), UiCommands: { IM_SEND_TEXT: 'send', ASSIST_TRANSLATE: 'translate', IM_MESSAGE_PAGE: 'page', IM_MESSAGES: 'messages' }, ipc: { invoke: async (command: string, payload: Record<string, unknown>) => { calls.push({ command, payload }); const value = await (command === 'send' ? sendResult : translateResult); if (value instanceof Error) throw value; return value; } } };
  function actual(name: string): (...args: any[]) => any {
    const a = source.search(new RegExp('(?:async )?function ' + name + '\\(')); assert.ok(a >= 0, name);
    const tail = source.slice(a); const boundary = /\n(?:(?:async )?function |(?:let|const) [A-Za-z])/g; const next = boundary.exec(tail); assert.ok(next, name);
    return new Function(...Object.keys(env), stripTypeScriptTypes(tail.slice(0, next.index)) + '\nreturn ' + name + ';')(...Object.values(env));
  }
  for (const name of ['activeAccount', 'activeConv', 'stillActive']) env[name] = actual(name);
  const resetStart = source.indexOf('const ACCOUNT_SCOPED_RESET ='), resetEnd = source.indexOf('} as const satisfies Partial<MainState>;', resetStart) + '} as const satisfies Partial<MainState>;'.length;
  env['ACCOUNT_SCOPED_RESET'] = new Function('TRANSLATION_IDLE', 'PKG_IDLE', stripTypeScriptTypes(source.slice(resetStart, resetEnd)) + '\nreturn ACCOUNT_SCOPED_RESET;')(vm.TRANSLATION_IDLE, {});
  for (const name of ['setDraft', 'upsertMessage', 'sendText', 'translationTarget', 'translateAndSend']) env[name] = actual(name);
  const set = env['setDraft'] as (text: string) => void;
  const open = actual('openConversation'), snapshot = actual('applyAccountSnapshot');
  function doneTranslation(text = 'SYNTHETIC TRANSLATION') { const current = store.get(); store.patch({ translation: { status: 'done', gid: current.activeGid, draftVersion: current.draftVersion, target: 'en', text, error: null } }); }
  function translationClick(action: string): () => void { const row = actual('translationBar')(store.get(), store.get().conversations.find(c => c.gid === store.get().activeGid)); const control = nodes(row).find(node => (node.props['dataset'] as Record<string, string> | undefined)?.['tr'] === action); assert.ok(control, action); return control.props['onclick'] as () => void; }
  function switchScope(next: typeof context) { snapshot({ active_account_id: next.account_id, accounts: [{ context: next, state: 'online', color: '#aaa' }] }); }
  return { get state() { return store.get(); }, calls, set, open, actual, doneTranslation, translationClick, switchScope, send: (result: unknown) => { sendResult = result; }, translate: (result: unknown) => { translateResult = result; } };
}
test('actual setDraft/openConversation keeps each room draft and preserves a deliberate empty draft over server text', async () => {
  const f = fixture(); f.set('SYNTHETIC A'); await f.open('synthetic-B'); f.set('SYNTHETIC B'); await f.open('synthetic-A');
  assert.equal(f.state.draft, 'SYNTHETIC A'); assert.equal(f.state.drafts['synthetic-B'], 'SYNTHETIC B');
  f.set(''); await f.open('synthetic-B'); await f.open('synthetic-A'); assert.equal(f.state.draft, ''); assert.equal(f.calls.length, 0);
});
test('actual handleSend completion clears only the submitted room and never a later room draft', async () => {
  for (const result of [{ kind: 'confirmed', server_message_id: 'synthetic-server', server_time_ms: 1800000000000 }, new Error('SYNTHETIC ERROR')]) {
    const f = fixture(), pending = deferred(); f.set('SYNTHETIC A'); f.state.drafts['synthetic-B'] = 'SYNTHETIC B'; f.send(pending.promise);
    const sending = f.actual('handleSend')(); assert.equal(f.state.drafts['synthetic-A'], ''); assert.equal(f.state.drafts['synthetic-B'], 'SYNTHETIC B');
    await f.open('synthetic-B'); f.set('SYNTHETIC B NEW'); pending.resolve(result); await sending;
    assert.equal(f.state.draft, 'SYNTHETIC B NEW'); assert.equal(f.state.drafts['synthetic-A'], ''); assert.equal(f.calls.filter(c => c.command === 'send').length, 1);
  }
});
test('actual translated replacement writes only the selected current draft cache', () => { const f = fixture(); f.set('SYNTHETIC A'); f.state.drafts['synthetic-B'] = 'SYNTHETIC B'; f.doneTranslation(); f.translationClick('replace')(); assert.equal(f.state.draft, 'SYNTHETIC TRANSLATION'); assert.equal(f.state.drafts['synthetic-A'], 'SYNTHETIC TRANSLATION'); assert.equal(f.state.drafts['synthetic-B'], 'SYNTHETIC B'); });
for (const action of ['replace', 'send']) test(`stale actual translation ${action} callback cannot write or send another room or newer draft`, async () => {
  for (const change of ['room', 'draft', 'translation']) {
    const f = fixture(); f.set('SYNTHETIC A'); f.doneTranslation(); const click = f.translationClick(action);
    if (change === 'room') { await f.open('synthetic-B'); f.set('SYNTHETIC B'); } else if (change === 'draft') f.set('SYNTHETIC A NEW'); else f.doneTranslation('SYNTHETIC NEW TRANSLATION');
    const before = JSON.stringify({ draft: f.state.draft, drafts: f.state.drafts }); click(); await Promise.resolve(); await Promise.resolve();
    assert.equal(f.calls.length, 0); assert.equal(JSON.stringify({ draft: f.state.draft, drafts: f.state.drafts }), before);
  }
});
for (const action of ['replace', 'send']) test(`actual account snapshot resets drafts and stale translation ${action} cannot restore across account/environment/generation`, async () => {
  for (const next of [{ ...context, account_id: 'synthetic-other' }, { ...context, environment: 'synthetic-other' }, { ...context, session_generation: 2 }]) {
    const f = fixture(); f.set('SYNTHETIC OLD ACCOUNT'); f.doneTranslation(); const click = f.translationClick(action); f.switchScope(next);
    assert.equal(f.state.draft, ''); assert.deepEqual(f.state.drafts, {}); f.state.conversations = [{ gid: 'synthetic-A', account: next, status: 'active', unread_count: 0, draft: '', lang: 'en' }]; f.state.activeGid = 'synthetic-A'; f.set('SYNTHETIC NEW ACCOUNT');
    click(); await Promise.resolve(); await Promise.resolve(); assert.equal(f.state.draft, 'SYNTHETIC NEW ACCOUNT'); assert.deepEqual(f.state.drafts, { 'synthetic-A': 'SYNTHETIC NEW ACCOUNT' }); assert.equal(f.calls.length, 0);
  }
});
test('late preview and direct-translation responses never overwrite or send another room draft', async () => {
  for (const name of ['runPreviewTranslation', 'translateAndSend']) {
    const f = fixture(), pending = deferred(); f.set('SYNTHETIC A'); const version = f.state.draftVersion; f.translate(pending.promise);
    const translating = f.actual(name)('SYNTHETIC A'); await f.open('synthetic-B'); f.set('SYNTHETIC B');
    pending.resolve({ draft_version: version, text: 'SYNTHETIC LATE TRANSLATION' }); await translating;
    assert.equal(f.state.draft, 'SYNTHETIC B'); assert.equal(f.state.drafts['synthetic-A'], 'SYNTHETIC A'); assert.equal(f.calls.filter(c => c.command === 'send').length, 0); assert.equal(f.state.translation.status, 'idle');
  }
});


test('current translated send clears only its own cached draft', async () => {
  const f = fixture(); f.set('SYNTHETIC A'); f.state.drafts['synthetic-B'] = 'SYNTHETIC B'; f.doneTranslation();
  f.translationClick('send')(); await Promise.resolve(); await Promise.resolve();
  assert.equal(f.calls.filter(c => c.command === 'send').length, 1); assert.equal(f.state.drafts['synthetic-A'], ''); assert.equal(f.state.drafts['synthetic-B'], 'SYNTHETIC B');
});
test('late actual sends and previews cannot change a new account scope even with the same room ID', async () => {
  for (const next of [{ ...context, account_id: 'synthetic-other' }, { ...context, environment: 'synthetic-other' }, { ...context, session_generation: 2 }]) for (const operation of ['sendText', 'runPreviewTranslation', 'translateAndSend']) {
    const f = fixture(), pending = deferred(); f.set('SYNTHETIC OLD ACCOUNT'); const version = f.state.draftVersion; f.send(pending.promise); f.translate(pending.promise);
    const request = f.actual(operation)('SYNTHETIC OLD ACCOUNT', null); f.switchScope(next);
    f.state.conversations = [{ gid: 'synthetic-A', account: next, status: 'active', unread_count: 0, draft: '', lang: 'en' }]; f.state.activeGid = 'synthetic-A'; f.state.messages = { 'synthetic-A': [] }; f.set('SYNTHETIC NEW ACCOUNT');
    pending.resolve(operation === 'sendText' ? { kind: 'confirmed', server_message_id: 'synthetic-old-server', server_time_ms: 1800000000000 } : { draft_version: version, text: 'SYNTHETIC OLD TRANSLATION' }); await request;
    assert.equal(f.state.draft, 'SYNTHETIC NEW ACCOUNT'); assert.deepEqual(f.state.drafts, { 'synthetic-A': 'SYNTHETIC NEW ACCOUNT' }); assert.deepEqual(f.state.messages['synthetic-A'], []);
    assert.equal(f.calls.filter(c => c.command === 'send').length, operation === 'sendText' ? 1 : 0);
  }
});

test('same-scope account readback keeps the current room draft intact', () => { const f = fixture(); f.set('SYNTHETIC CURRENT'); f.switchScope(context); assert.equal(f.state.draft, 'SYNTHETIC CURRENT'); assert.deepEqual(f.state.drafts, { 'synthetic-A': 'SYNTHETIC CURRENT' }); });
test('stale translation error actions and language selection cannot mutate a later room', async () => {
  for (const action of ['send-original', 'retry', 'target']) {
    const f = fixture(); f.set('SYNTHETIC A'); f.state.translation = { status: 'error', gid: 'synthetic-A', draftVersion: f.state.draftVersion, target: 'en', text: '', error: 'SYNTHETIC ERROR' };
    let click: (event?: unknown) => void;
    if (action === 'target') {
      const row = f.actual('translationBar')(f.state, f.state.conversations[0]); const select = nodes(row).find(node => node.tag === 'select'); assert.ok(select); click = select.props['onchange'] as (event?: unknown) => void;
    } else click = f.translationClick(action);
    await f.open('synthetic-B'); f.set('SYNTHETIC B'); const before = JSON.stringify(f.state.translation);
    click({ target: { value: 'fr' } }); await Promise.resolve(); await Promise.resolve();
    assert.equal(f.state.draft, 'SYNTHETIC B'); assert.equal(JSON.stringify(f.state.translation), before); assert.equal(f.calls.length, 0);
  }
});
