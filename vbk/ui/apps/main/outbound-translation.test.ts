import { t as translateUi } from '../../packages/ui-kit/src/i18n.ts';
import { t as translate, type I18nKey } from '../../packages/ui-kit/src/i18n.ts';
// 出站翻译端到端：从输入中文草稿到发出译文，驱动 main.ts 中真实的
// setDraft → scheduleTranslation → runPreviewTranslation → handleSend → translateAndSend/sendText，
// IPC 用桩记录 assistant_translate / im_send_text，不访问 TSim 或携程。
// 另覆盖已结束会话：输入区不锁定，发送照常提交（宿主侧由适配器先重开会话）。
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import * as vm from './viewmodel.ts';
import { settleAccountSend } from './sendScope.ts';
import * as composerBoundary from './sendComposer.ts';
import { isAppError } from '../../packages/ipc/src/contracts.ts';
import { isUiMessage } from '../_shared/guards.ts';
import { mergeMessageProfile } from './message-profile.ts';
import { createStore } from '../../packages/ui-kit/src/store.ts';
import { cx } from '../../packages/ui-kit/src/h.ts';
import type { UiMessage } from '../../packages/ipc/src/client.ts';

const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
const account = { account_id: 'synthetic-account', environment: 'synthetic', session_generation: 1 };
const gid = 'synthetic-room';
const CUSTOMER_RU = 'Здравствуйте, могу я увеличить тарифный план?';
const DRAFT = '您好，购买后无法更改。';
const RU = 'Здравствуйте, после покупки это изменить нельзя.';
interface RenderNode { tag: string; props: Record<string, any>; children: unknown[] }
function nodes(tree: unknown): RenderNode[] { if (Array.isArray(tree)) return tree.flatMap(nodes); if (!tree || typeof tree !== 'object') return []; const n = tree as RenderNode; return [n, ...nodes(n.children ?? [])]; }
function deferred() { let resolve!: (v: unknown) => void; return { promise: new Promise(r => { resolve = r; }), resolve: (v: unknown) => resolve(v) }; }

function inbound(text: string): UiMessage {
  return { gid, message_id: 'synthetic-in-1', local_id: null, create_time_ms: 1, sender_role: 'customer', sender_id: 'synthetic-customer', sender_name: null, sender_avatar: null, kind: 'text', text, translation: null, original: null, quote: null, order_id: null, disposition: null };
}

function fixture(opts: { mode?: 'replace_draft' | 'send_direct'; sendKey?: 'enter' | 'ctrl_enter'; lang?: string; status?: string; customer?: string } = {}) {
  // 官方行 languageInfo.lang = zh_HK → langOf 归为 zh；客户实际写俄语。
  const conv = { gid, account, status: opts.status ?? 'active', unread_count: 0, lang: opts.lang ?? 'zh', draft: '', title: 'SYNTHETIC', color: '#aaa' };
  const store = createStore({ accounts: { active_account_id: account.account_id, accounts: [{ context: account, state: 'online', color: '#aaa' }] }, conversations: [conv], activeGid: gid, messages: { [gid]: [inbound(opts.customer ?? CUSTOMER_RU)] } as Record<string, UiMessage[]>, history: {}, banners: [], view: 'messages', draft: '', drafts: {} as Record<string, string>, draftVersion: 1, quote: null, attachment: null, attachmentSelection: null, mediaOperation: null, translation: { ...vm.TRANSLATION_IDLE } as vm.TranslationState, prefs: { assistant: { enabled: true, outbound_translation: true, send_mode: opts.mode ?? 'replace_draft' }, keys: { send_key: opts.sendKey ?? 'enter' } }, trBarOff: false, emoOpen: false, hideInboundTr: false });
  const calls: { command: string; payload: any }[] = [], notices: string[] = [];
  let translateResult: unknown = null;
  const invoke = async (command: string, payload: any) => {
    calls.push({ command, payload });
    const value = await (command === 'translate' ? (translateResult ?? { draft_version: payload.draft_version, text: RU }) : command === 'send' ? { kind: 'confirmed', server_message_id: 'synthetic-server', server_time_ms: 2 } : null);
    if (value instanceof Error) throw value;
    return value;
  };
  const env: Record<string, any> = { quickReplies: { close() {}, suggest() {} }, quickRepliesView: () => ({ tag: 'div', props: { class: 'synthetic-suggestions' }, children: [] }), replyContext: () => null, ...vm, ...composerBoundary, settleAccountSend, isAppError, isUiMessage, mergeMessageProfile, cx, store, S: () => store.get(), ipc: { invoke }, invokeSafe: invoke, invokeQuiet: invoke, UiCommands: { IM_SEND_TEXT: 'send', ASSIST_TRANSLATE: 'translate', IM_SEND_MEDIA: 'media' }, toast: (text: string) => notices.push(text), errorMessage: (e: unknown) => (e instanceof Error ? e.message : 'synthetic error'), t: translateUi, h: (tag: string, props: object | null, ...children: unknown[]) => ({ tag, props: props ?? {}, children }), icon: () => null, IC: {}, TR_TARGETS: vm.OUTBOUND_TARGETS, langName: (c: string) => c, notWired: (n: unknown) => n, copyText() {}, openPeripheral() {}, trTimer: null, composerInput: { bind: () => ({}), active: () => false, revision: () => 0 }, visibleReads: { retry() {}, afterRender() {} } };
  function actual(name: string): (...args: any[]) => any {
    const a = source.search(new RegExp('(?:async )?function ' + name + '\\(')); assert.ok(a >= 0, name);
    const tail = source.slice(a), next = /\n(?:(?:async )?function |(?:let|const) [A-Za-z])/.exec(tail); assert.ok(next, name);
    return new Function(...Object.keys(env), stripTypeScriptTypes(tail.slice(0, next.index)) + '\nreturn ' + name + ';')(...Object.values(env));
  }
  for (const name of ['activeAccount', 'activeConv', 'stillActive', 'upsertMessage', 'translationOn', 'translationTarget', 'sendText', 'translateAndSend', 'runPreviewTranslation', 'scheduleTranslation', 'sendMediaAttachment', 'composerInputContext']) env[name] = actual(name);
  env['setSendMode'] = () => {};
  for (const name of ['setDraft', 'handleSend', 'translationBar', 'ctool', 'formatFileSize', 'composerMoreMenu', 'composer']) env[name] = actual(name);
  return {
    store, calls, notices, env,
    get state() { return store.get(); },
    type: (text: string) => env['setDraft'](text),
    send: () => env['handleSend'](),
    translate: (r: unknown) => { translateResult = r; },
    render: () => env['composer'](store.get(), store.get().conversations[0]),
    sent: () => calls.filter(c => c.command === 'send').map(c => ({ text: c.payload.text, original: c.payload.original ?? null })),
    translations: () => calls.filter(c => c.command === 'translate'),
  };
}
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

test('替换草稿（默认）：行上 zh_HK 的俄语客户，输入中文 → 自动预览俄语 → 发送键发出俄语译文并保留中文原文', async () => {
  const timers = mock.timers; timers.enable({ apis: ['setTimeout'] });
  try {
    const f = fixture();
    const bar = vm.shouldShowTranslationBar(f.state.conversations[0] as any, true, true, vm.customerLanguage(f.state.conversations[0] as any, f.state.messages[gid]!));
    assert.equal(bar, true, '客户语言按消息识别为俄语，翻译栏出现');
    f.type(DRAFT);
    assert.equal(f.translations().length, 0, '防抖 500 ms 内不请求');
    timers.tick(500); await flush();
    assert.equal(f.translations().length, 1);
    assert.deepEqual({ target: f.translations()[0]!.payload.target, text: f.translations()[0]!.payload.text, gid: f.translations()[0]!.payload.gid }, { target: 'ru', text: DRAFT, gid });
    assert.equal(f.state.translation.status, 'done'); assert.equal(f.state.translation.text, RU);
    const barNode = nodes(f.env['translationBar'](f.state, f.state.conversations[0]));
    assert.ok(barNode.some(n => n.tag === 'option' && n.props.selected && n.props.value === 'ru'), '目标语言下拉选中俄语');
    await f.send(); await flush();
    assert.deepEqual(f.sent(), [{ text: RU, original: DRAFT }], '发出的是译文，原文随消息保留');
    assert.equal(f.translations().length, 1, '复用当前草稿版本的预览，不重复请求');
    const local = f.state.messages[gid]!.at(-1)!;
    assert.equal(local.text, RU); assert.equal(local.original, DRAFT); assert.equal(local.disposition?.kind, 'confirmed');
    assert.equal(f.state.draft, '');
  } finally { timers.reset(); }
});

test('替换草稿：预览未返回就按发送，现译现发，绝不先发中文', async () => {
  const f = fixture(), pending = deferred(); f.translate(pending.promise);
  f.type(DRAFT); const sending = f.send(); await flush();
  assert.equal(f.sent().length, 0, '译文返回前不发送');
  pending.resolve({ draft_version: f.state.draftVersion, text: RU }); await sending; await flush();
  assert.deepEqual(f.sent(), [{ text: RU, original: DRAFT }]);
});

test('翻译失败不静默发送原文，草稿保留并给出「发送原文 / 重试」', async () => {
  const f = fixture(); f.translate(new Error('SYNTHETIC TSIM DOWN'));
  f.type(DRAFT); await f.send(); await flush();
  assert.equal(f.sent().length, 0);
  assert.equal(f.state.draft, DRAFT);
  assert.equal(f.state.translation.status, 'error');
  const bar = nodes(f.env['translationBar'](f.state, f.state.conversations[0]));
  assert.ok(bar.some(n => n.props.dataset?.tr === 'send-original') && bar.some(n => n.props.dataset?.tr === 'retry'));
});

test('非中文草稿也预览并发送客户目标语言，替换后复用译文', async () => {
  for (const draft of ['Hello, please try again.', 'ご予約ありがとうございます', '안녕하세요', 'Bonjour']) {
    const timers = mock.timers; timers.enable({ apis: ['setTimeout'] });
    try {
      const f = fixture(); f.type(draft); timers.tick(500); await flush();
      assert.equal(f.translations()[0]!.payload.text, draft);
      assert.equal(f.translations()[0]!.payload.target, 'ru');
      await f.send(); await flush();
      assert.deepEqual(f.sent(), [{ text: RU, original: draft }]);
    } finally { timers.reset(); }
  }
  const f = fixture(); f.type(DRAFT); await f.env['runPreviewTranslation']();
  nodes(f.env['translationBar'](f.state, f.state.conversations[0])).find(n => n.props.dataset?.tr === 'replace')!.props.onclick();
  await f.send(); await flush();
  assert.equal(f.translations().length, 1);
  assert.deepEqual(f.sent(), [{ text: RU, original: null }]);
});

test('空译文视为失败', async () => {
  const g = fixture(); g.translate({ draft_version: 2, text: '   ' }); g.type(DRAFT); await g.send(); await flush();
  assert.equal(g.sent().length, 0); assert.equal(g.state.translation.status, 'error');
});

test('客户写中文的会话不翻译，直接发出中文', async () => {
  const f = fixture({ customer: '你好，请问可以退款吗' }); f.type(DRAFT); await f.send(); await flush();
  assert.equal(f.translations().length, 0); assert.deepEqual(f.sent(), [{ text: DRAFT, original: null }]);
});

test('直接发送 + 已结束会话：输入区可用，发送键直接发原文', async () => {
  const f = fixture({ mode: 'send_direct', status: 'finished', lang: 'ru' });
  const tree = nodes(f.render());
  const ta = tree.find(n => n.tag === 'textarea')!; const btn = tree.find(n => n.props.dataset?.action === 'send')!;
  assert.equal(ta.props.disabled, false); assert.equal(btn.props.disabled, false);
  assert.equal(ta.props.placeholder, translateUi('composer.placeholderFinished'));
  assert.ok(f.env['composerInputContext'](f.state), '已结束会话的输入可提交到草稿');
  f.type(DRAFT); await f.send(); await flush();
  assert.equal(f.translations().length, 0);
  assert.deepEqual(f.sent(), [{ text: DRAFT, original: null }]);
});

test('已结束会话的附件不发送并提示先用文字激活；转出会话整体锁定', async () => {
  const f = fixture({ status: 'finished' });
  f.store.patch({ attachment: { attachment_id: 'a', name: 'x.png' } as any });
  const send = nodes(f.render()).find(n => n.props.dataset?.action === 'send')!;
  assert.equal(send.props.disabled, true);
  const t = fixture({ status: 'transferred_out' });
  const tree = nodes(t.render());
  assert.equal(tree.find(n => n.tag === 'textarea')!.props.disabled, true);
  assert.equal(tree.find(n => n.props.dataset?.action === 'send')!.props.disabled, true);
  assert.equal(t.env['composerInputContext'](t.state), null);
  t.store.patch({ draft: DRAFT }); await t.send(); await flush();
  assert.equal(t.calls.length, 0);
});


test('翻译栏提示与实际发送快捷键、模式一致且不再显示供应商品牌', () => {
  for (const mode of ['replace_draft', 'send_direct'] as const) {
    for (const sendKey of ['enter', 'ctrl_enter'] as const) {
      const f = fixture({ mode, sendKey });
      f.type(DRAFT);
      const tree = f.render();
      const bar = nodes(tree).find(n => String(n.props.class).split(' ').includes('trmode'));
      assert.ok(bar);
      const text = JSON.stringify(bar.children);
      assert.ok(text.includes(sendKey === 'enter' ? 'Enter' : 'Ctrl/⌘+Enter'));
      assert.ok(text.includes(mode === 'send_direct' ? '直接发送输入框原文' : '发送译文'));
      assert.equal(text.includes('TSim'), false);
      const textarea = nodes(tree).find(n => n.tag === 'textarea')!;
      assert.equal(textarea.props.value, DRAFT, '可编辑草稿仍在输入框里');
    }
  }
});

test('开启出站翻译时不再在输入框上方重复展示快捷回复联想内容', () => {
  const f = fixture();
  f.store.patch({ quickReplies: { mode: 'suggestions' } } as any);
  assert.equal(nodes(f.render()).some(n => n.props.class === 'synthetic-suggestions'), false);
  f.store.patch({ attachment: { name: 'synthetic' } } as any);
  const hint = nodes(f.render()).find(n => String(n.props.class).split(' ').includes('trmode'))!;
  assert.ok(JSON.stringify(hint.children).includes('Enter 仅发送附件'));
  f.store.patch({ attachment: null, trBarOff: true });
  assert.equal(nodes(f.render()).some(n => n.props.class === 'synthetic-suggestions'), true, '未开启翻译时保留联想功能');
});


test('直接发送的 Enter 和发送按钮忽略已有译文或翻译错误', async () => {
  for (const status of ['done', 'busy', 'error'] as const) {
    const f = fixture({ mode: 'send_direct' }); f.type(DRAFT);
    f.store.patch({ translation: { ...f.state.translation, status, gid, draftVersion: f.state.draftVersion, text: RU } } as any);
    const editor = nodes(f.render()).find(n => n.tag === 'textarea')!;
    let prevented = false;
    editor.props.onkeydown({ key: 'Enter', preventDefault() { prevented = true; } });
    await flush();
    assert.equal(prevented, true);
    assert.deepEqual(f.sent(), [{ text: DRAFT, original: null }]);
    assert.equal(f.translations().length, 0);
  }
});

test('替换草稿模式在翻译返回之前不提交原文', async () => {
  const f = fixture(); f.type(DRAFT);
  let resolve!: (value: unknown) => void;
  f.translate(new Promise(r => { resolve = r; }));
  const pending = f.send(); await flush();
  assert.equal(f.sent().length, 0);
  resolve({ draft_version: f.state.draftVersion, text: RU });
  await pending; await flush();
  assert.deepEqual(f.sent(), [{ text: RU, original: DRAFT }]);
});
