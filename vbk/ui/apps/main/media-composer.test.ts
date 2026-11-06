import { isUiAccountSnapshot } from '../_shared/guards.ts';
import { createAccountNavigation } from './account-navigation.ts';
import { t as translateUi } from '../../packages/ui-kit/src/i18n.ts';
import { EMPTY_NOTICE_QUERY } from './notice-query.ts';
import { EMPTY_EVENT_QUERY } from './event-query.ts';
import { EVENT_PICKER_CLOSED } from './events-view.ts';
import { readHistoryPage } from './history-read.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import * as vm from './viewmodel.ts';
import * as composerBoundary from './sendComposer.ts';
import { createStore } from '../../packages/ui-kit/src/store.ts';
import { cx } from '../../packages/ui-kit/src/h.ts';
import { mergeMessageProfile } from './message-profile.ts';
import { isUiMessage, isUiConversation, isUiAgentStatus, isUiNetStatus } from '../_shared/guards.ts';
import { isAppError } from '../../packages/ipc/src/contracts.ts';
import type { UiAttachment, UiMessage, UiMediaSendResult } from '../../packages/ipc/src/client.ts';
const source = readFileSync(process.env['VBK_MEDIA_MAIN_SOURCE'] ?? new URL('./main.ts', import.meta.url), 'utf8');
const account = { account_id: 'synthetic-media-account', environment: 'synthetic', session_generation: 1 };
const gid = 'synthetic-media-room';
function registered(kind: UiAttachment['kind'] = 'image', id = 'synthetic-attachment'): UiAttachment { return { attachment_id: id, name: `SYNTHETIC.${kind}`, kind, mime: 'application/octet-stream', size: 123, content_sha256: 'a'.repeat(64), owner: { account, gid }, supported: true }; }
function deferred() { let resolve!: (v: unknown) => void; return { promise: new Promise(r => { resolve = r; }), resolve: (v: unknown) => resolve(v) }; }
interface RenderNode { tag: string; props: Record<string, any>; children: unknown[] }
function nodes(tree: unknown): RenderNode[] { if (Array.isArray(tree)) return tree.flatMap(nodes); if (!tree || typeof tree !== 'object') return []; const node = tree as RenderNode; return [node, ...nodes(node.children ?? [])]; }
function fixture() {
  const conv = { gid, account, status: 'active', unread_count: 0, lang: 'en', draft: '' };
  const store = createStore({ accounts: { active_account_id: account.account_id, accounts: [{ context: account, state: 'online' }] }, conversations: [conv], activeGid: gid, messages: { [gid]: [] } as Record<string, UiMessage[]>, history: {}, banners: [], view: 'messages', draft: 'SYNTHETIC CAPTION', drafts: { [gid]: 'SYNTHETIC CAPTION' }, draftVersion: 1, attachment: null as { attachment_id: string; name: string } | null, attachmentSelection: null as any, mediaOperation: null as any, quote: null as UiMessage | null, translation: { ...vm.TRANSLATION_IDLE } as vm.TranslationState, prefs: { assistant: { send_mode: 'replace_draft', enabled: true, outbound_translation: true }, keys: { send_key: 'enter' } }, trBarOff: false, fileDrag: false, composerMore: false, emoOpen: false, hideInboundTr: false });
  const calls: { command: string; payload: any }[] = [], notices: string[] = [];
  let picked: unknown = registered(), sent: unknown = { stage: 'send', kind: 'confirmed', write_started: true, disposition: { kind: 'confirmed', server_message_id: 'synthetic-confirmed', server_time_ms: 1000 }, message: null, error: null } satisfies UiMediaSendResult;
  const invoke = async (command: string, payload: any) => { calls.push({ command, payload }); const result = await (command === 'pick' || command === 'drop' ? picked : command === 'media' ? sent : command === 'conversations' ? [] : null); if (result instanceof Error) throw result; return result; };
  const env: Record<string, any> = { pruneTabAttention: (list: readonly string[]) => list, viewingAccountId: () => null, closeRuntimeLog() {}, persistSelectedAttachment: async (attachment: unknown) => attachment, persistAttachmentBeforeLeave: async () => true, restoreRoomAttachment: async () => undefined, attachmentDraftBook: { save: async (_scope: unknown, attachment: unknown) => ({ kind: 'current', attachment }) }, unavailableAttachment: () => null, accountNavigation: createAccountNavigation({ switch: async () => null, snapshot: async () => null, valid: isUiAccountSnapshot }), quickReplies: { close() {}, suggest() {} }, closeCommerce() {}, noticeQuery: { reset() {}, categories: async () => {} }, visibleReads: { retry() {}, afterRender() {} }, ...vm, readHistoryPage, ...composerBoundary, store, S: () => store.get(), isUiMessage, isUiConversation, isUiAgentStatus, isUiNetStatus, isAppError, mergeMessageProfile, cx, ipc: { invoke }, invokeSafe: invoke, invokeQuiet: invoke, UiCommands: { IM_SEND_MEDIA: 'media', IM_SEND_TEXT: 'text', IM_MESSAGE_PAGE: 'page', IM_MESSAGES: 'messages', IM_CONVERSATIONS: 'conversations', ACCOUNT_AGENT_STATUS: 'agent', NET_STATUS: 'net', NOTICE_CATEGORIES: 'categories', MEDIA_PICK: 'pick', MEDIA_ACCEPT_DROP: 'drop', PREFS_SET: 'prefs_set', MEDIA_RELEASE: 'release', ASSIST_TRANSLATE: 'translate' }, PKG_IDLE: {}, peripheral: { close() {} }, receiveDiagnostics: { close() {} }, unknownOutbound: { close() {} }, loadForActiveAccount: async () => {}, scheduleTranslation() {}, autoQueryPackage() {}, translationOn: () => true, toast: (text: string) => notices.push(text), errorMessage: () => 'synthetic error', h: (tag: string, props: object | null, ...children: unknown[]) => ({ tag, props: props ?? {}, children }), t: translateUi, icon: () => null, IC: {}, TR_TARGETS: ['en', 'fr'], langName: (code: string) => code, notWired: (node: unknown) => node, copyText() {}, isPrefsSnapshot: () => false, requestAnimationFrame: (fn: () => void) => fn(), document: { querySelector: () => ({ focus: () => { focused++; } }) } };
  let focused = 0, hasInput = true;
  Object.assign(env, { composerInput: { bind: () => ({}), active: () => false, revision: () => 0 }, composerInputContext: () => (hasInput ? {} : null) });
  function actual(name: string): (...args: any[]) => any { const a = source.search(new RegExp('(?:async )?function ' + name + '\\(')); assert.ok(a >= 0, name); const tail = source.slice(a), next = /\n(?:(?:async )?function |(?:let|const) [A-Za-z])/.exec(tail); assert.ok(next, name); const helperStart = name === 'loadForActiveAccount' ? source.lastIndexOf('let accountLoadTicket', a) : -1; const helpers = helperStart < 0 ? '' : source.slice(helperStart, a); return new Function(...Object.keys(env), stripTypeScriptTypes(helpers + tail.slice(0, next.index)) + '\nreturn ' + name + ';')(...Object.values(env)); }
  for (const name of ['activeAccount', 'activeConv', 'stillActive', 'setDraft', 'upsertMessage', 'translationTarget', 'sendText', 'translateAndSend', 'ownedAttachment', 'mediaOperationCurrent', 'releaseAttachment', 'acceptAttachment', 'focusComposer', 'receiveFileDrag', 'receiveFileDrop', 'setSendMode', 'sendMediaAttachment', 'removeAttachment', 'translationBar', 'ctool', 'formatFileSize', 'composerMoreMenu']) if (source.includes(`function ${name}(`)) env[name] = actual(name);
  const resetStart = source.indexOf('const ACCOUNT_SCOPED_RESET ='), resetEnd = source.indexOf('} as const satisfies Partial<MainState>;', resetStart) + '} as const satisfies Partial<MainState>;'.length;
  env['eventQuery'] = { reset() {} };
  env['ACCOUNT_SCOPED_RESET'] = new Function('TRANSLATION_IDLE', 'PKG_IDLE', 'EMPTY_NOTICE_QUERY', 'EMPTY_EVENT_QUERY', 'EVENT_PICKER_CLOSED', stripTypeScriptTypes(source.slice(resetStart, resetEnd)) + '\nreturn ACCOUNT_SCOPED_RESET;')(vm.TRANSLATION_IDLE, {}, EMPTY_NOTICE_QUERY, EMPTY_EVENT_QUERY, EVENT_PICKER_CLOSED);
  const picks: Promise<unknown>[] = [];
  env['attach'] = (kind: string) => { const choosing = actual('attach')(kind); picks.push(choosing); return choosing; };
  env['handleSend'] = actual('handleSend');
  function control(dataset: string, value: string) { const tree = actual('composer')(store.get(), store.get().conversations[0]); const node = nodes(tree).find(n => n.props.dataset?.[dataset] === value); assert.ok(node, value); return node; }
  return { store, calls, notices, actual, focused: () => focused, noInput: () => { hasInput = false; }, control, get state() { return store.get(); }, set: env['setDraft'], pick: (r: unknown) => { picked = r; }, send: (r: unknown) => { sent = r; }, choose: (kind: string = 'image') => actual('attach')(kind), flushPicks: () => Promise.all(picks), submit: () => actual('handleSend')(), progress: (value: unknown) => actual('receiveMediaProgress')(value) };
}

for (const kind of ['image', 'file'] as const) test(`actual composer submits registered ${kind} once as media and retains caption/quote without text or translation`, async () => {
  const f = fixture(), pending = deferred(); const attachment = registered(kind); f.pick(attachment); await f.choose(kind); f.send(pending.promise);
  const before = f.state.draft; const first = f.submit(), second = f.submit();
  assert.equal(f.calls.filter(c => c.command === 'media').length, 1); assert.equal(f.calls.filter(c => c.command === 'text' || c.command === 'translate').length, 0);
  const local = f.state.messages[gid]?.[0]; assert.equal(local?.kind, kind); assert.equal(local?.text, ''); assert.equal(local?.media_url, undefined);
  f.set('SYNTHETIC NEW CAPTION'); pending.resolve({ stage: 'send', kind: 'confirmed', write_started: true, disposition: { kind: 'confirmed', server_message_id: 'synthetic-confirmed', server_time_ms: 1000 }, message: { ...local, media_url: 'https://example.invalid/media', media_filename: attachment.name }, error: null }); await Promise.all([first, second]);
  assert.equal(before, 'SYNTHETIC CAPTION'); assert.equal(f.state.draft, 'SYNTHETIC NEW CAPTION'); assert.equal(f.state.drafts[gid], 'SYNTHETIC NEW CAPTION'); assert.equal(f.state.attachment, null); assert.equal(f.state.messages[gid]?.[0]?.media_url, 'https://example.invalid/media');
});

test('actual picker drops and releases late replies after scope/draft changes and newer picker instances', async () => {
  for (const change of ['account_id', 'environment', 'session_generation', 'gid', 'draft', 'new-picker']) {
    const f = fixture(), pending = deferred(); f.pick(pending.promise); const choosing = f.choose();
    if (change === 'draft') f.set('SYNTHETIC NEW DRAFT');
    else if (change === 'new-picker') { f.pick(registered('file', 'synthetic-newer')); await f.choose('file'); }
    else if (change === 'gid') f.store.patch({ activeGid: 'synthetic-other-room' });
    else f.store.patch({ accounts: { active_account_id: account.account_id, accounts: [{ context: { ...account, [change]: change === 'session_generation' ? 2 : 'synthetic-other' }, state: 'online' }] } });
    pending.resolve(registered()); await choosing;
    assert.equal(f.state.attachment?.attachment_id, change === 'new-picker' ? 'synthetic-newer' : undefined, change);
    assert.ok(f.calls.some(c => c.command === 'release' && c.payload.attachment_id === 'synthetic-attachment'), change);
    assert.equal(f.calls.filter(c => c.command === 'media' || c.command === 'text').length, 0);
  }
});

test('actual media result and progress never clear or contaminate another composer after account/room changes', async () => {
  for (const change of ['account_id', 'environment', 'session_generation', 'gid']) {
    const f = fixture(), pending = deferred(); f.pick(registered()); await f.choose(); f.send(pending.promise); const sending = f.submit(); const operation = f.state.mediaOperation;
    if (change === 'gid') f.store.patch({ activeGid: 'synthetic-other-room' });
    else f.store.patch({ accounts: { active_account_id: account.account_id, accounts: [{ context: { ...account, [change]: change === 'session_generation' ? 2 : 'synthetic-other' }, state: 'online' }] } });
    const replacement = registered('file', 'synthetic-new-selection'); f.store.patch({ attachment: replacement, mediaOperation: null, draft: 'SYNTHETIC NEW OWNER' });
    f.progress({ account, gid, attachment_id: operation.attachment.attachment_id, local_id: operation.localId, stage: 'send' });
    pending.resolve({ stage: 'send', kind: 'unknown', write_started: true, disposition: { kind: 'unknown' }, message: null, error: null }); await sending;
    assert.equal(f.state.attachment, replacement); assert.equal(f.state.mediaOperation, null); assert.equal(f.state.draft, 'SYNTHETIC NEW OWNER');
  }
});

test('actual media unknown, malformed result or IPC failure is locked without retry; local removal does not recall or send caption', async () => {
  for (const result of [new Error('SYNTHETIC IPC LOST'), null, { stage: 'send', kind: 'confirmed', write_started: true, disposition: { kind: 'confirmed' }, message: null, error: null }, { stage: 'send', kind: 'rejected', write_started: false, disposition: { kind: 'rejected', code: 'synthetic', reason: 'synthetic' }, message: null, error: null }, { stage: 'upload', kind: 'unknown', write_started: true, disposition: { kind: 'unknown' }, message: null, error: null }]) {
    const f = fixture(); await f.choose(); f.send(result); await f.submit(); await f.submit();
    assert.equal(f.calls.filter(c => c.command === 'media').length, 1); assert.equal(f.state.mediaOperation.status, 'unknown'); assert.equal(f.state.messages[gid]?.[0]?.disposition?.kind, 'unknown');
    assert.equal(f.control('action', 'send').props.disabled, true);
    const original = f.state.attachment;
    await f.actual('removeAttachment')(original); assert.equal(f.state.attachment, null); assert.equal(f.state.draft, 'SYNTHETIC CAPTION'); assert.equal(f.state.messages[gid]?.length, 1);
    f.store.patch({ attachment: original }); await f.submit(); assert.equal(f.calls.filter(c => c.command === 'media').length, 1, 'closing the card cannot unlock the same registered attachment');
    assert.equal(f.calls.filter(c => c.command === 'text' || c.command === 'translate').length, 0);
  }
});

test('actual media not_submitted retains attachment and draft; explicit send can start a fresh operation', async () => {
  const f = fixture(); await f.choose(); const attachment = f.state.attachment;
  f.send({ stage: 'prepare', kind: 'not_submitted', write_started: false, disposition: null, message: null, error: 'SYNTHETIC FILE UNAVAILABLE' }); await f.submit();
  assert.equal(f.state.attachment, attachment); assert.equal(f.state.draft, 'SYNTHETIC CAPTION'); assert.equal(f.state.messages[gid]?.length, 0); assert.equal(f.state.mediaOperation.status, 'not_submitted');
  const first = f.calls.find(c => c.command === 'media')!.payload.local_id;
  await f.submit(); assert.equal(f.calls.filter(c => c.command === 'media').length, 2); assert.notEqual(f.calls.filter(c => c.command === 'media')[1]!.payload.local_id, first);
});

test('actual composer tools: no video button, file button picks kind file, scoped phase progress and busy removal/send controls', async () => {
  const f = fixture(), pending = deferred(); f.pick(registered('file')); assert.equal(nodes(f.actual('composer')(f.state, f.state.conversations[0])).some(n => n.props.dataset?.tool === 'video'), false);
  f.control('tool', 'file').props.onclick(); await f.flushPicks();
  assert.equal(f.calls.find(c => c.command === 'pick')?.payload.kind, 'file'); assert.deepEqual(f.calls[0]?.payload.account, account); assert.equal(f.calls[0]?.payload.gid, gid);
  f.send(pending.promise); const sending = f.submit(), operation = f.state.mediaOperation;
  f.progress({ account, gid, attachment_id: 'synthetic-other', local_id: operation.localId, stage: 'send' }); assert.equal(f.state.mediaOperation.stage, 'prepare');
  f.progress({ account, gid, attachment_id: operation.attachment.attachment_id, local_id: operation.localId, stage: 'upload' }); assert.equal(f.state.mediaOperation.stage, 'upload');
  f.progress({ account, gid, attachment_id: operation.attachment.attachment_id, local_id: operation.localId, stage: 'prepare' }); assert.equal(f.state.mediaOperation.stage, 'upload');
  const tree = f.actual('composer')(f.state, f.state.conversations[0]); assert.ok(nodes(tree).some(n => n.props.role === 'status' && JSON.stringify(n.children).includes('正在上传附件')));
  assert.equal(f.control('action', 'send').props.disabled, true); await f.actual('removeAttachment')(f.state.attachment); assert.ok(f.state.attachment);
  pending.resolve({ stage: 'send', kind: 'rejected', write_started: true, disposition: { kind: 'rejected', code: 'synthetic', reason: 'synthetic' }, message: null, error: 'SYNTHETIC REJECTED' }); await sending;
  assert.equal(f.state.mediaOperation.status, 'rejected'); assert.equal(f.state.draft, 'SYNTHETIC CAPTION');
});

test('actual stale translated buttons cannot change a newly selected attachment composer; text paths remain blocked', async () => {
  for (const action of ['replace', 'send']) {
    const f = fixture(); f.store.patch({ translation: { status: 'done', gid, draftVersion: 1, target: 'en', text: 'SYNTHETIC OLD TRANSLATION', error: null } });
    const tree = f.actual('translationBar')(f.state, f.state.conversations[0]); const click = nodes(tree).find(n => n.props.dataset?.tr === action)!.props.onclick;
    await f.choose(); const attachment = f.state.attachment; click(); await Promise.resolve();
    await f.actual('sendText')('SYNTHETIC BYPASS', null); await f.actual('translateAndSend')('SYNTHETIC BYPASS');
    assert.equal(f.state.draft, 'SYNTHETIC CAPTION'); assert.equal(f.state.attachment, attachment); assert.equal(f.calls.filter(c => c.command === 'text' || c.command === 'translate' || c.command === 'media').length, 0);
  }
});

test('actual wrong-scope registered attachments and stale remove callbacks never mutate or send', async () => {
  const f = fixture(), wrong = { ...registered(), owner: { account: { ...account, session_generation: 2 }, gid } }; f.store.patch({ attachment: wrong }); await f.submit();
  assert.equal(f.calls.length, 0); assert.equal(f.state.draft, 'SYNTHETIC CAPTION');
  const current = registered('file', 'synthetic-new-selection'); f.store.patch({ attachment: current }); await f.actual('removeAttachment')(wrong); assert.equal(f.state.attachment, current);
});

test('actual fake attachments remain blocked and media retry can never enter the text send path', async () => {
  for (const attachment of [{ attachment_id: 'synthetic-fake', name: 'synthetic.png' }, { ...registered(), supported: false }, { ...registered(), content_sha256: '' }]) {
    const f = fixture(); f.store.patch({ attachment }); await f.submit(); assert.equal(f.calls.length, 0); assert.equal(f.state.attachment, attachment); assert.equal(f.state.draft, 'SYNTHETIC CAPTION');
  }
  const f = fixture();
  await f.actual('resend')({ gid, local_id: 'synthetic-media', message_id: null, kind: 'image', text: 'SYNTHETIC NEVER SEND THIS AS TEXT', disposition: { kind: 'rejected', code: 'synthetic', reason: 'synthetic' } });
  assert.equal(f.calls.length, 0);
});

test('an upload-only unknown outcome is labelled as not yet submitted and remains locked', async () => {
  const f = fixture(); await f.choose(); f.send({ stage: 'upload', kind: 'unknown', write_started: false, disposition: null, message: null, error: null }); await f.submit();
  assert.equal(f.state.mediaOperation.status, 'unknown'); assert.ok(f.state.mediaOperation.error.includes('消息尚未提交')); await f.submit(); assert.equal(f.calls.filter(c => c.command === 'media').length, 1);
});

test('starting a media send invalidates an already pending replacement picker', async () => {
  const f = fixture(); await f.choose(); const pending = deferred(), sendingResult = deferred(); f.pick(pending.promise); const choosing = f.choose('file');
  f.send(sendingResult.promise); const sending = f.submit(), attachment = f.state.attachment;
  pending.resolve(registered('file', 'synthetic-late-picker')); await choosing; assert.equal(f.state.attachment, attachment); assert.equal(f.state.mediaOperation.status, 'busy');
  sendingResult.resolve({ stage: 'send', kind: 'unknown', write_started: true, disposition: { kind: 'unknown' }, message: null, error: null }); await sending;
  assert.ok(f.calls.some(c => c.command === 'release' && c.payload.attachment_id === 'synthetic-late-picker')); assert.equal(f.state.mediaOperation.status, 'unknown');
});

test('actual media send retains the verified quote without adding caption or quote payload fields', async () => {
  const f = fixture(); const quote: UiMessage = { gid, message_id: 'synthetic-quote', local_id: null, kind: 'text', text: 'SYNTHETIC QUOTED TEXT', create_time_ms: 1, sender_role: 'customer', translation: null, original: null, quote: null, order_id: null, disposition: null };
  f.store.patch({ quote, messages: { [gid]: [quote] } }); await f.choose(); await f.submit();
  assert.equal(f.state.quote, quote); assert.equal(f.state.draft, 'SYNTHETIC CAPTION');
  const payload = f.calls.find(c => c.command === 'media')!.payload;
  assert.deepEqual(Object.keys(payload).sort(), ['account', 'attachment_id', 'gid', 'local_id']); assert.equal(f.calls.filter(c => c.command === 'text').length, 0);
});

for (const kind of ['rejected', 'unknown'] as const) test(`actual host upload ${kind} with write_started false updates only attachment operation without a phantom SDK message`, async () => {
  const f = fixture(); await f.choose();
  f.send({ stage: 'upload', kind, write_started: false, disposition: kind === 'rejected' ? { kind: 'rejected', code: 'media.upload_rejected', reason: 'media upload was rejected or failed local validation' } : { kind: 'unknown' }, message: null, error: kind === 'rejected' ? 'media upload rejected' : 'upload outcome unknown; do not retry' });
  await f.submit(); await f.submit();
  assert.equal(f.state.mediaOperation.status, kind); assert.equal(f.state.mediaOperation.stage, 'upload'); assert.ok(f.state.mediaOperation.error.includes('消息尚未提交'));
  assert.equal(f.state.messages[gid]?.length, 0, 'no SDK submission was started'); assert.equal(f.state.draft, 'SYNTHETIC CAPTION'); assert.equal(f.calls.filter(c => c.command === 'media').length, 1);
});

test('upload-only or not_submitted completion cannot erase an independently projected SDK event with the same local ID', async () => {
  for (const kind of ['not_submitted', 'rejected', 'unknown'] as const) {
    const f = fixture(), pending = deferred(); await f.choose(); f.send(pending.promise); const sending = f.submit(); const local = f.state.messages[gid]![0]!;
    const sdk = { ...local, message_id: 'synthetic-independent-sdk', disposition: { kind: 'confirmed' as const, server_message_id: 'synthetic-independent-sdk', server_time_ms: 1000 }, media_url: 'https://example.invalid/confirmed.png' };
    f.actual('upsertMessage')(sdk);
    pending.resolve({ stage: 'upload', kind, write_started: false, disposition: kind === 'rejected' ? { kind: 'rejected', code: 'media.upload_rejected', reason: 'synthetic' } : null, message: null, error: null }); await sending;
    assert.equal(f.state.messages[gid]?.length, 1); assert.equal(f.state.messages[gid]?.[0]?.message_id, sdk.message_id); assert.equal(f.state.messages[gid]?.[0]?.disposition?.kind, 'confirmed');
    assert.equal(f.state.mediaOperation.status, 'unknown'); await f.submit(); assert.equal(f.calls.filter(c => c.command === 'media').length, 1);
  }
});

for (const outcome of ['confirmed', 'upload-unknown'] as const) test(`actual host replay_only ${outcome} is metadata only and cannot confirm or unlock the selected attachment`, async () => {
  const f = fixture(); await f.choose(); const attachment = f.state.attachment;
  const original: UiMessage = { gid, message_id: null, local_id: 'synthetic-original-unknown', kind: 'image', text: '', create_time_ms: 1, sender_role: 'merchant_self', translation: null, original: null, quote: null, order_id: null, disposition: { kind: 'unknown' } };
  f.store.patch({ messages: { [gid]: [original] } });
  f.send({ replay_only: true, stage: outcome === 'confirmed' ? 'send' : 'upload', kind: outcome === 'confirmed' ? 'confirmed' : 'unknown', write_started: outcome === 'confirmed', disposition: outcome === 'confirmed' ? { kind: 'confirmed', server_message_id: 'synthetic-old-server', server_time_ms: 1000 } : { kind: 'unknown' }, message: null, error: null });
  await f.submit();
  assert.equal(f.state.attachment, attachment); assert.equal(f.state.draft, 'SYNTHETIC CAPTION'); assert.equal(f.state.messages[gid]?.length, 1); assert.equal(f.state.messages[gid]?.[0], original); await f.submit();
  assert.equal(f.state.mediaOperation.status, 'unknown'); assert.ok(f.state.mediaOperation.error.includes('仅供核验')); assert.equal(f.calls.filter(c => c.command === 'media').length, 1); assert.equal(f.calls.filter(c => c.command === 'release').length, 0);
});

test('actual successful media sends release their exact owned attachment without retaining host snapshot slots', async () => {
  const f = fixture();
  for (let i = 0; i < 5; i++) { f.pick(registered('file', `synthetic-slot-${i}`)); await f.choose('file'); await f.submit(); }
  const releases = f.calls.filter(c => c.command === 'release'); assert.equal(releases.length, 5);
  for (let i = 0; i < 5; i++) assert.deepEqual(releases[i]?.payload, { account, gid, attachment_id: `synthetic-slot-${i}` });
  assert.equal(f.state.draft, 'SYNTHETIC CAPTION');
});

test('actual room/account resets release the former owned selection while late send completion cannot change the new scope', async () => {
  for (const change of ['room', 'account_id', 'environment', 'session_generation']) {
    const f = fixture(), pending = deferred(); await f.choose(); f.send(pending.promise); const sending = f.submit();
    if (change === 'room') await f.actual('openConversation')('synthetic-new-room');
    else {
      const next = { ...account, [change]: change === 'session_generation' ? 2 : 'synthetic-next' };
      f.actual('applyAccountSnapshot')({ active_account_id: next.account_id, accounts: [{ context: next, state: 'online' }] });
    }
    assert.deepEqual(f.calls.find(c => c.command === 'release')?.payload, { account, gid, attachment_id: 'synthetic-attachment' }, change);
    const nextAttachment = registered('file', 'synthetic-next-attachment'); f.store.patch({ attachment: nextAttachment, draft: 'SYNTHETIC NEW OWNER' });
    pending.resolve({ stage: 'send', kind: 'confirmed', write_started: true, disposition: { kind: 'confirmed', server_message_id: 'synthetic-confirmed', server_time_ms: 1000 }, message: null, error: null }); await sending;
    assert.equal(f.state.attachment, nextAttachment); assert.equal(f.state.draft, 'SYNTHETIC NEW OWNER'); assert.ok(f.calls.filter(c => c.command === 'release').every(c => c.payload.attachment_id === 'synthetic-attachment'));
  }
});

test('actual conversation readback removing the selected room releases the formerly visible attachment', async () => {
  const f = fixture(); await f.choose(); await f.actual('loadForActiveAccount')();
  assert.equal(f.state.activeGid, null); assert.equal(f.state.attachment, null); assert.deepEqual(f.calls.find(c => c.command === 'release')?.payload, { account, gid, attachment_id: 'synthetic-attachment' });
});

test('file drop: only the active conversation redeems the drop; multi-file drops are announced; drag state clears', async () => {
  const f = fixture(); f.pick(registered('file', 'synthetic-dropped')); f.actual('receiveFileDrag')({ active: true }); assert.equal(f.state.fileDrag, true);
  await f.actual('receiveFileDrop')({ drop_id: 7, count: 2 });
  assert.equal(f.state.fileDrag, false); const drop = f.calls.find(c => c.command === 'drop')!;
  assert.deepEqual(drop.payload, { account, gid, drop_id: 7 }); assert.equal(f.state.attachment?.attachment_id, 'synthetic-dropped');
  assert.ok(f.notices.some(n => n.includes('一次发送一个附件') && n.includes('SYNTHETIC.file'))); assert.equal(f.focused(), 1);
  const single = fixture(); single.pick(registered('image')); await single.actual('receiveFileDrop')({ drop_id: 1, count: 1 }); assert.equal(single.notices.length, 0);
});

test('file drop: malformed, no-conversation, finished or busy contexts never redeem the drop', async () => {
  const bad = fixture(); for (const v of [null, {}, { drop_id: 1.5, count: 1 }, { drop_id: 1 }]) await bad.actual('receiveFileDrop')(v); assert.equal(bad.calls.length, 0);
  const none = fixture(); none.noInput(); await none.actual('receiveFileDrop')({ drop_id: 1, count: 1 }); assert.equal(none.calls.length, 0); assert.equal(none.notices.length, 1);
  const done = fixture(); done.store.patch({ conversations: [{ ...done.state.conversations[0], status: 'finished' }] } as any); await done.actual('receiveFileDrop')({ drop_id: 1, count: 1 }); assert.equal(done.calls.length, 0); assert.equal(done.notices.length, 1);
  const busy = fixture(); busy.store.patch({ mediaOperation: { status: 'busy' } }); await busy.actual('receiveFileDrop')({ drop_id: 1, count: 1 }); assert.equal(busy.calls.length, 0); assert.equal(busy.notices.length, 1);
});

test('file drop: late redeem after room/account/draft change is released and never attached', async () => {
  for (const change of ['gid', 'draft', 'account_id', 'cancel']) {
    const f = fixture(), pending = deferred(); f.pick(pending.promise); const dropping = f.actual('receiveFileDrop')({ drop_id: 3, count: 1 });
    if (change === 'gid') f.store.patch({ activeGid: 'synthetic-other-room' });
    else if (change === 'draft') f.set('SYNTHETIC NEW DRAFT');
    else if (change === 'cancel') f.store.patch({ attachmentSelection: null });
    else f.store.patch({ accounts: { active_account_id: account.account_id, accounts: [{ context: { ...account, account_id: 'synthetic-other' }, state: 'online' }] } });
    pending.resolve(registered('file', 'synthetic-late-drop')); await dropping;
    assert.equal(f.state.attachment, null, change); assert.ok(f.calls.some(c => c.command === 'release' && c.payload.attachment_id === 'synthetic-late-drop'), change); assert.equal(f.notices.length, 0, change);
  }
});

test('translation-mode menu: choosing a send mode sends PREFS_SET for assistant.send_mode and closes the menu', async () => {
  const f = fixture(); f.store.patch({ composerMore: true });
  const items = nodes(f.actual('composerMoreMenu')(f.state)).filter(n => n.props.dataset?.sendMode);
  assert.deepEqual(items.map(n => n.props.dataset.sendMode), ['replace_draft', 'send_direct']);
  assert.equal(f.control('tool', 'more').props['aria-expanded'], 'true');
  const g = fixture(); g.store.patch({ composerMore: true });
  await g.actual('setSendMode')('send_direct');
  assert.deepEqual(g.calls.find(c => c.command === 'prefs_set')?.payload, { section: 'assistant', key: 'send_mode', value: 'send_direct' });
  assert.equal(g.state.composerMore, false);
});
