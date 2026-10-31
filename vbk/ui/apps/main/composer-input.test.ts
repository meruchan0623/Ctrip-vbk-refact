import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { createComposerInput } from './composer-input.ts';
import { createStore, subscribeBatched } from '../../packages/ui-kit/src/store.ts';
import * as vm from './viewmodel.ts';
import { cx } from '../../packages/ui-kit/src/h.ts';

const current = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
const source = process.env['VBK_COMPOSER_MAIN_SOURCE'] ? readFileSync(process.env['VBK_COMPOSER_MAIN_SOURCE'], 'utf8') : current;
type Tree = { tag: string; props: Record<string, any>; children: unknown[] };
function nodes(tree: unknown): Tree[] { if (Array.isArray(tree)) return tree.flatMap(nodes); if (!tree || typeof tree !== 'object' || !('tag' in tree)) return []; const node = tree as Tree; return [node, ...node.children.flatMap(nodes)]; }
function fixture() {
  const account = { account_id: 'synthetic-account', environment: 'test', session_generation: 1 };
  const conv = { gid: 'synthetic-room', account, status: 'active', lang: 'en' };
  const store = createStore<any>({ view: 'messages', draft: 'committed', drafts: {}, draftVersion: 3, activeGid: conv.gid, conversations: [conv], accounts: { active_account_id: account.account_id, accounts: [{ context: account, state: 'online' }] }, translation: { status: 'done', text: 'OLD', target: 'en' }, messages: {}, quote: null, attachment: null, prefs: { keys: { send_key: 'enter' }, assistant: { enabled: false } } });
  let renders = 0, translations = 0, sends = 0;
  const env: Record<string, any> = { visibleReads: { retry() {}, afterRender() {} },
    ...vm, createComposerInput, cx, store, S: () => store.get(),
    activeAccount: () => store.get().accounts.accounts[0], activeConv: () => store.get().conversations.find((c: any) => c.gid === store.get().activeGid),
    scheduleTranslation: () => { translations++; }, clearTimeout,
    h: (tag: string, props: Record<string, any> | null, ...children: unknown[]) => ({ tag, props: props ?? {}, children }),
    t: (key: string) => key, icon: () => null, IC: {}, translationOn: () => false, translationBar: () => null, notWired: (x: unknown) => x,
    handleSend: () => { sends++; }, subscribeBatched, withMessageAnchor: (_: unknown, redraw: () => void) => redraw(), root: {}, rerender: () => { renders++; },
  };
  const extract = (text: string, name: string, end: string) => text.slice(text.indexOf(`function ${name}(`), text.indexOf(`\n${end}`, text.indexOf(`function ${name}(`)));
  env['setDraft'] = new Function(...Object.keys(env), stripTypeScriptTypes(extract(current, 'setDraft', 'async function resend(')) + '\nreturn setDraft;')(...Object.values(env));
  const a = current.indexOf('const composerInput ='), b = current.indexOf('function scheduleTranslation(', a);
  const input = new Function(...Object.keys(env), stripTypeScriptTypes('let trTimer = null;\n' + current.slice(a, b)) + '\nreturn {composerInput, composerInputContext};')(...Object.values(env));
  Object.assign(env, input);
  const composer = new Function(...Object.keys(env), stripTypeScriptTypes(extract(source, 'composer', 'function emojiPicker(')) + '\nreturn composer;')(...Object.values(env));
  const start = source.indexOf('subscribeBatched(store,'), end = source.indexOf('\nrerender(root, () => render(S()));', start);
  new Function(...Object.keys(env), stripTypeScriptTypes(source.slice(start, end)))(...Object.values(env));
  const tree = composer(store.get(), conv), textarea = nodes(tree).find(x => x.tag === 'textarea')!;
  const send = nodes(tree).find(x => x.props.dataset?.action === 'send')!;
  const node = { value: 'committed', isConnected: true };
  const dispatch = (name: string, extra: object = {}) => textarea.props[name]?.({ target: node, currentTarget: node, ...extra });
  return { store, node, dispatch, input: input.composerInput, send: () => send.props.onclick(), translations: () => translations, sends: () => sends, renders: () => renders };
}

test('actual composer keeps IME preedit out of translation and leaves its editor mounted through background updates', async () => {
  const f = fixture(); f.dispatch('oncompositionstart'); await Promise.resolve();
  f.node.value = '未确认候选'; f.dispatch('oninput', { isComposing: true });
  f.store.patch({ now: 99 }); await Promise.resolve();
  assert.equal(f.store.get().draft, 'committed'); assert.equal(f.translations(), 0); assert.equal(f.renders(), 0);
  f.node.value = '确认文字'; f.dispatch('oncompositionend'); await Promise.resolve();
  assert.equal(f.store.get().draft, '确认文字'); assert.equal(f.translations(), 1); assert.equal(f.renders(), 1);
});
test('actual composer blocks send during composition, legacy IME Enter and Alt+Enter', () => {
  const f = fixture(); f.dispatch('oncompositionstart'); f.send();
  f.dispatch('onkeydown', { key: 'Enter', isComposing: false, keyCode: 13, preventDefault() {} }); assert.equal(f.sends(), 0);
  f.dispatch('oncompositionend');
  f.dispatch('onkeydown', { key: 'Enter', keyCode: 229, preventDefault() {} });
  f.dispatch('onkeydown', { key: 'Enter', altKey: true, preventDefault() {} }); assert.equal(f.sends(), 0);
  f.dispatch('onkeydown', { key: 'Enter', preventDefault() {} }); assert.equal(f.sends(), 1);
});
test('actual composition invalidates old translation and releases deferred rendering on blur without publishing preedit', async () => {
  const f = fixture(); const before = f.store.get().draftVersion; f.dispatch('oncompositionstart');
  assert.equal(f.store.get().draftVersion, before + 1); assert.equal(f.store.get().translation.status, 'idle');
  f.node.value = 'unfinished'; f.dispatch('onblur'); await Promise.resolve();
  f.dispatch('oncompositionend'); f.dispatch('oninput');
  assert.equal(f.store.get().draft, 'committed'); assert.equal(f.translations(), 0); assert.equal(f.renders(), 1);
});
test('starting composition preserves the selected translation target', () => {
  const f = fixture(); f.store.patch({ translation: { status: 'done', gid: 'synthetic-room', target: 'fr', text: 'OLD' } });
  f.dispatch('oncompositionstart'); assert.equal(f.store.get().translation.target, 'fr');
});
test('account, generation, room, view and newer draft changes reject late composition and render the new state', async () => {
  for (const change of ['account_id', 'environment', 'session_generation', 'room', 'view', 'draft', 'offline', 'finished']) {
    const f = fixture(); f.dispatch('oncompositionstart'); await Promise.resolve();
    const state = f.store.get();
    if (change === 'room') f.store.patch({ activeGid: 'other-room' });
    else if (change === 'view') f.store.patch({ view: 'orders' });
    else if (change === 'draft') f.store.patch({ draft: 'new draft', draftVersion: state.draftVersion + 1 });
    else if (change === 'finished') f.store.patch({ conversations: [{ ...state.conversations[0], status: 'finished' }] });
    else f.store.patch({ accounts: { ...state.accounts, accounts: [{ ...state.accounts.accounts[0], state: change === 'offline' ? 'expired' : 'online', context: { ...state.accounts.accounts[0].context, ...(change === 'offline' ? {} : { [change]: change === 'session_generation' ? 2 : 'other' }) } }] } });
    await Promise.resolve(); assert.equal(f.renders(), 1, change);
    f.node.value = 'OLD PREEDIT'; f.dispatch('oncompositionend'); f.dispatch('oninput');
    assert.notEqual(f.store.get().draft, 'OLD PREEDIT', change); assert.equal(f.translations(), 0, change);
  }
});
