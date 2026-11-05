import { t as translateUi } from '../../packages/ui-kit/src/i18n.ts';
import { t as translate, type I18nKey } from '../../packages/ui-kit/src/i18n.ts';
import { createAccountNavigation } from './account-navigation.ts';
import { createNoticeQuery } from './notice-query.ts';
import { createAttachmentDraftBook, unavailableAttachment } from './attachment-draft-book.ts';
import { UiCommands as RealUiCommands } from '../../packages/ipc/src/client.ts';
import { ImCommands } from '../../packages/ipc/src/commands.ts';
import { EMPTY_SERVER_SEARCH } from './server-search.ts';
import { EMPTY_NOTICE_QUERY } from './notice-query.ts';
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
  const store = createStore({ accounts: { active_account_id: account.account_id, accounts: [{ context: account, state: 'online' }] }, conversations: [conv], activeGid: gid, messages: { [gid]: [] } as Record<string, UiMessage[]>, history: {}, banners: [], view: 'messages', draft: 'SYNTHETIC CAPTION', drafts: { [gid]: 'SYNTHETIC CAPTION' } as Record<string, string>, draftVersion: 1, attachment: null as { attachment_id: string; name: string } | null, attachmentSelection: null as any, mediaOperation: null as any, quote: null as UiMessage | null, translation: { ...vm.TRANSLATION_IDLE } as vm.TranslationState, prefs: { assistant: { send_mode: 'replace_draft', enabled: true, outbound_translation: true }, keys: { send_key: 'enter' } }, trBarOff: false });
  const calls: { command: string; payload: any }[] = [], notices: string[] = [];
  let picked: unknown = registered(), sent: unknown = { stage: 'send', kind: 'confirmed', write_started: true, disposition: { kind: 'confirmed', server_message_id: 'synthetic-confirmed', server_time_ms: 1000 }, message: null, error: null } satisfies UiMediaSendResult;
  let saveReplyGate: Promise<unknown> | null = null;
  const handles = new Map<string, UiAttachment>(), persisted = new Map<string, { attachment_version: number; attachments: any[] }>();
  const invoke = async (command: string, payload: any) => {
    calls.push({ command, payload });
    if (command === ImCommands.DRAFT_LOAD) return { drafts: [...persisted].map(([gid, slot]) => ({ gid, text: '', version: 0, ...slot })) };
    if (command === RealUiCommands.IM_DRAFT_ATTACHMENT_SAVE) {
      const prior = persisted.get(payload.gid) ?? { attachment_version: 0, attachments: [] };
      if (payload.expected_version !== prior.attachment_version) throw { code: 'store.cas_conflict' };
      const a = payload.attachment_id ? handles.get(payload.attachment_id) : null;
      if (payload.attachment_id && !a) throw new Error('unknown test handle');
      const next = { attachment_version: prior.attachment_version + 1, attachments: a ? [{ lease_id: `lease-${a.attachment_id}`, name: a.name, kind: a.kind, mime: a.mime, size: a.size, content_sha256: a.content_sha256, state: 'ready' }] : [] };
      persisted.set(payload.gid, next); if (saveReplyGate) await saveReplyGate; return next;
    }
    if (command === RealUiCommands.IM_DRAFT_ATTACHMENT_RESTORE) {
      const summary = persisted.get(payload.gid)?.attachments.find(value => value.lease_id === payload.lease_id);
      if (!summary) throw new Error('missing test lease');
      const restored = { ...summary, supported: true, attachment_id: `restored-${summary.lease_id}`, owner: { account: payload.account, gid: payload.gid } }; handles.set(restored.attachment_id, restored); return restored;
    }
    const result = await (command === 'pick' ? picked : command === 'media' ? sent : command === 'conversations' ? [] : null);
    if (result instanceof Error) throw result;
    if (command === 'pick' && composerBoundary.isRegisteredMediaAttachment(result)) handles.set(result.attachment_id, result);
    if (command === 'media' && (result as any)?.kind === 'confirmed' && typeof (result as any)?.disposition?.server_message_id === 'string') {
      const prior = persisted.get(payload.gid); if (prior?.attachments[0]?.lease_id === `lease-${payload.attachment_id}`) persisted.set(payload.gid, { attachment_version: prior.attachment_version + 1, attachments: [] });
    }
    return result;
  };
  const attachmentDraftBook = createAttachmentDraftBook({ invoke, release: async a => { await invoke('release', { account: a.owner.account, gid: a.owner.gid, attachment_id: a.attachment_id }); } });
  let accountLoaded: () => void = () => {};
  let selectReply: (context: typeof account) => Promise<unknown> = async () => store.get().accounts;
  const accountNavigation = createAccountNavigation({ switch: context => selectReply(context), snapshot: async () => store.get().accounts, valid: (value): value is any => !!value });
  const noticeQuery = createNoticeQuery({ account: () => store.get().accounts.accounts.find(item => item.context.account_id === store.get().accounts.active_account_id)?.context ?? null,
    current: () => EMPTY_NOTICE_QUERY, publish() {}, invoke: async <T>() => [] as T, error: String, failed() {} });
  const env: Record<string, any> = { browserTabs: { activate() {} }, attachmentDraftBook, unavailableAttachment, openUnknownOutbound() {}, accountNavigation, quickReplies: { close() {}, suggest() {} }, closeCommerce() {}, noticeQuery, serverSearchPanel: { reset() {} }, visibleReads: { retry() {}, afterRender() {} }, ...vm, readHistoryPage, ...composerBoundary, store, S: () => store.get(), isUiMessage, isUiConversation, isUiAgentStatus, isUiNetStatus, isUiAccountSnapshot: (value: unknown) => !!value, isAppError, mergeMessageProfile, cx, ipc: { invoke }, invokeSafe: invoke, invokeQuiet: invoke, UiCommands: { IM_SEND_MEDIA: 'media', IM_SEND_TEXT: 'text', IM_MESSAGE_PAGE: 'page', IM_MESSAGES: 'messages', IM_CONVERSATIONS: 'conversations', ACCOUNT_AGENT_STATUS: 'agent', NET_STATUS: 'net', NOTICE_CATEGORIES: 'categories', MEDIA_PICK: 'pick', MEDIA_RELEASE: 'release', ASSIST_TRANSLATE: 'translate' }, PKG_IDLE: {}, peripheral: { close() {} }, receiveDiagnostics: { close() {} }, unknownOutbound: { close() {} }, loadForActiveAccount: async () => { accountLoaded(); }, scheduleTranslation() {}, autoQueryPackage() {}, translationOn: () => true, toast: (text: string) => notices.push(text), errorMessage: () => 'synthetic error', h: (tag: string, props: object | null, ...children: unknown[]) => ({ tag, props: props ?? {}, children }), t: translateUi, icon: () => null, IC: {}, TR_TARGETS: ['en', 'fr'], langName: (code: string) => code, notWired: (node: unknown) => node, copyText() {} };
  Object.assign(env, { composerInput: { bind: () => ({}), active: () => false, revision: () => 0 }, composerInputContext: () => null });
  function actual(name: string): (...args: any[]) => any { const a = source.search(new RegExp('(?:async )?function ' + name + '\\(')); assert.ok(a >= 0, name); const tail = source.slice(a), next = /\n(?:(?:async )?function |(?:let|const) [A-Za-z])/.exec(tail); assert.ok(next, name); const helperStart = name === 'loadForActiveAccount' ? source.lastIndexOf('let accountLoadTicket', a) : -1; const helpers = helperStart < 0 ? '' : source.slice(helperStart, a); return new Function(...Object.keys(env), stripTypeScriptTypes(helpers + tail.slice(0, next.index)) + '\nreturn ' + name + ';')(...Object.values(env)); }
  for (const name of ['activeAccount', 'activeConv', 'stillActive', 'releaseAttachment', 'persistSelectedAttachment', 'persistAttachmentBeforeLeave', 'restoreRoomAttachment', 'retryAttachmentDraft', 'setDraft', 'upsertMessage', 'translationTarget', 'sendText', 'translateAndSend', 'ownedAttachment', 'mediaOperationCurrent', 'sendMediaAttachment', 'removeAttachment', 'translationBar']) if (source.includes(`function ${name}(`)) env[name] = actual(name);
  const resetStart = source.indexOf('const ACCOUNT_SCOPED_RESET ='), resetEnd = source.indexOf('} as const satisfies Partial<MainState>;', resetStart) + '} as const satisfies Partial<MainState>;'.length;
  env['ACCOUNT_SCOPED_RESET'] = new Function('TRANSLATION_IDLE', 'PKG_IDLE', 'EMPTY_NOTICE_QUERY', 'EMPTY_SERVER_SEARCH', stripTypeScriptTypes(source.slice(resetStart, resetEnd)) + '\nreturn ACCOUNT_SCOPED_RESET;')(vm.TRANSLATION_IDLE, {}, EMPTY_NOTICE_QUERY, EMPTY_SERVER_SEARCH);
  env['applyAccountSnapshot'] = actual('applyAccountSnapshot');
  for (const name of ['ctool', 'composerMoreMenu', 'navigateToAccount', 'acceptAttachment']) env[name] = actual(name);
  env['switchAccount'] = actual('switchAccount');
  env['openConversation'] = actual('openConversation');
  const picks: Promise<unknown>[] = [];
  env['attach'] = (kind: string) => { const choosing = actual('attach')(kind); picks.push(choosing); return choosing; };
  env['handleSend'] = actual('handleSend');
  function control(dataset: string, value: string) { const tree = actual('composer')(store.get(), store.get().conversations[0]); const node = nodes(tree).find(n => n.props.dataset?.[dataset] === value); assert.ok(node, value); return node; }
  return { store, calls, notices, actual, control, selectReply: (handler: typeof selectReply) => { selectReply = handler; }, accountLoaded: (handler: () => void) => { accountLoaded = handler; }, pauseSaveReply: (gate: Promise<unknown> | null) => { saveReplyGate = gate; }, get state() { return store.get(); }, set: env['setDraft'], pick: (r: unknown) => { picked = r; }, send: (r: unknown) => { sent = r; }, choose: (kind: string = 'image') => actual('attach')(kind), flushPicks: () => Promise.all(picks), submit: () => actual('handleSend')(), progress: (value: unknown) => actual('receiveMediaProgress')(value) };
}

for (const kind of ['image', 'file', 'video'] as const) test(`actual composer submits registered ${kind} once as media and retains caption/quote without text or translation`, async () => {
  const f = fixture(), pending = deferred(); const attachment = registered(kind); f.pick(attachment); await f.choose(kind); f.send(pending.promise);
  const before = f.state.draft; const first = f.submit(), second = f.submit();
  assert.equal(f.calls.filter(c => c.command === 'media').length, 1); assert.equal(f.calls.filter(c => c.command === 'text' || c.command === 'translate').length, 0);
  const local = f.state.messages[gid]?.[0]; assert.equal(local?.kind, kind); assert.equal(local?.text, ''); assert.equal(local?.media_url, undefined);
  f.set('SYNTHETIC NEW CAPTION'); pending.resolve({ stage: 'send', kind: 'confirmed', write_started: true, disposition: { kind: 'confirmed', server_message_id: 'synthetic-confirmed', server_time_ms: 1000 }, message: { ...local, media_url: 'https://example.invalid/media', media_filename: attachment.name }, error: null }); await Promise.all([first, second]);
  assert.equal(before, 'SYNTHETIC CAPTION'); assert.equal(f.state.draft, 'SYNTHETIC NEW CAPTION'); assert.equal(f.state.drafts[gid], 'SYNTHETIC NEW CAPTION'); assert.equal(f.state.attachment, null); assert.equal(f.state.messages[gid]?.[0]?.media_url, 'https://example.invalid/media');
});

test('actual picker drops and releases late replies after scope changes', async () => {
  for (const change of ['account_id', 'environment', 'session_generation', 'gid']) {
    const f = fixture(), pending = deferred(); f.pick(pending.promise); const choosing = f.choose();
    if (change === 'draft') f.set('SYNTHETIC NEW DRAFT');
    else if (change === 'gid') f.store.patch({ activeGid: 'synthetic-other-room' });
    else f.store.patch({ accounts: { active_account_id: account.account_id, accounts: [{ context: { ...account, [change]: change === 'session_generation' ? 2 : 'synthetic-other' }, state: 'online' }] } });
    pending.resolve(registered()); await choosing;
    assert.equal(f.state.attachment?.attachment_id, undefined, change);
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


test('a persisted ready attachment can explicitly reload its short handle without saving a new version or sending', async () => {
  const f = fixture(); await f.choose(); const before = f.state.attachment;
  const saves = f.calls.filter(call => call.command === RealUiCommands.IM_DRAFT_ATTACHMENT_SAVE).length;
  f.control('action', 'reload-attachment').props.onclick(); for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.notEqual(f.state.attachment?.attachment_id, before?.attachment_id); assert.equal((f.state.attachment as any)?.lease_id, (before as any)?.lease_id);
  assert.equal(f.calls.filter(call => call.command === RealUiCommands.IM_DRAFT_ATTACHMENT_SAVE).length, saves); assert.equal(f.calls.filter(call => call.command === 'media' || call.command === 'text').length, 0);
  assert.ok(f.calls.some(call => call.command === 'release' && call.payload.attachment_id === before?.attachment_id)); assert.equal(f.state.draft, 'SYNTHETIC CAPTION');
});

test('review actual account snapshots fence outer openConversation after persist-before-leave including same-generation ABA', async () => {
  const observed: any[] = [];
  for (const aba of [false, true]) for (let delay = 0; delay < 6; delay++) {
    const f = fixture(); await f.choose(); const unleased: any = { ...f.state.attachment }; delete unleased.lease_id; f.store.patch({ attachment: unleased, drafts: { [gid]: 'source text', target: 'old target text' } });
    const apply = f.actual('applyAccountSnapshot'), open = f.actual('openConversation'), originalGet = f.store.get; let scheduled = false;
    f.store.get = () => {
      const s = originalGet();
      if (!scheduled && f.calls.some(c => c.command === RealUiCommands.IM_DRAFT_ATTACHMENT_SAVE && c.payload.expected_version >= 1) && s.attachmentSelection) {
        scheduled = true;
        const reset = (left: number) => left ? queueMicrotask(() => reset(left - 1)) : (() => {
          const other = { ...account, account_id: 'other-account' };
          apply({ active_account_id: other.account_id, accounts: [{ context: other, state: 'online' }] });
          if (aba) apply({ active_account_id: account.account_id, accounts: [{ context: account, state: 'online' }] });
          f.store.patch({ activeGid: 'NEW', draft: 'new owner text', drafts: { NEW: 'new owner text' } });
        })();
        queueMicrotask(() => reset(delay));
      }
      return s;
    };
    await open('target'); await Promise.resolve();
    observed.push({ aba, delay, accountId: f.state.accounts.active_account_id, activeGid: f.state.activeGid, draft: f.state.draft });
  }
  assert.equal(observed.some(x => x.activeGid === 'target'), false);
});

test('review: an old media confirmation must not silently cancel a newly committed replacement selection', async () => {
  const f = fixture(), oldReply = deferred(); await f.choose(); f.send(oldReply.promise); const sending = f.submit();
  await f.actual('openConversation')('other-room'); await f.actual('openConversation')(gid);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  const newSaveReply = deferred(); f.pauseSaveReply(newSaveReply.promise); f.pick(registered('image', 'new-draft')); const choosing = f.choose();
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal(f.calls.filter(c => c.command === RealUiCommands.IM_DRAFT_ATTACHMENT_SAVE).length, 2);
  oldReply.resolve({ stage: 'send', kind: 'confirmed', write_started: true, disposition: { kind: 'confirmed', server_message_id: 'old-confirmed', server_time_ms: 1000 }, message: null, error: null });
  await sending; newSaveReply.resolve(null); await choosing;
  assert.equal(f.state.attachment?.attachment_id, 'new-draft');
});


test('typing during attachment persistence preserves new text and publishes the selected attachment', async () => {
  const f = fixture(), reply = deferred();
  f.pauseSaveReply(reply.promise); const choosing = f.choose();
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal(f.calls.filter(call => call.command === RealUiCommands.IM_DRAFT_ATTACHMENT_SAVE).length, 1);
  f.set('typed while fsync awaited'); reply.resolve(null); await choosing;
  assert.equal(f.state.attachment?.attachment_id, 'synthetic-attachment');
  assert.equal(f.state.draft, 'typed while fsync awaited');
  assert.equal(f.state.drafts[gid], 'typed while fsync awaited');
  assert.equal(f.calls.filter(call => call.command === 'release' || call.command === 'media' || call.command === 'text').length, 0);
});


test('actual account switch fences post-persist reset and same-generation ABA, then allows a fresh selection', async () => {
  for (const aba of [false, true]) for (let delay = 0; delay < 6; delay++) {
    const f = fixture(); await f.choose();
    const unleased: any = { ...f.state.attachment }; delete unleased.lease_id;
    f.store.patch({ attachment: unleased });
    const target = { ...account, account_id: 'target-account' }, other = { ...account, account_id: 'other-account' };
    const apply = f.actual('applyAccountSnapshot'); let selections = 0;
    f.selectReply(async context => { selections++; return { active_account_id: context.account_id, accounts: [{ context, state: 'online' }] }; });
    const originalGet = f.store.get; let scheduled = false;
    f.store.get = () => {
      const state = originalGet();
      if (!scheduled && f.calls.some(call => call.command === RealUiCommands.IM_DRAFT_ATTACHMENT_SAVE && call.payload.expected_version >= 1) && state.attachmentSelection) {
        scheduled = true;
        const reset = (left: number) => left ? queueMicrotask(() => reset(left - 1)) : (() => {
          apply({ active_account_id: other.account_id, accounts: [{ context: other, state: 'online' }] });
          if (aba) apply({ active_account_id: account.account_id, accounts: [{ context: account, state: 'online' }] });
          f.store.patch({ activeGid: 'NEW', draft: 'new account text' });
        })();
        queueMicrotask(() => reset(delay));
      }
      return state;
    };
    await f.actual('switchAccount')({ context: target, state: 'online' });
    for (let i = 0; i < 8; i++) await Promise.resolve();
    assert.notEqual(f.state.accounts.active_account_id, target.account_id, `stale target at delay ${delay}`);
    assert.equal(f.state.draft, 'new account text');
    assert.equal(f.state.attachmentSelection, null);
    await f.actual('switchAccount')({ context: target, state: 'online' });
    assert.equal(f.state.accounts.active_account_id, target.account_id);
    assert.ok(selections >= 1);
  }
});

test('locate transfers only its own first host account snapshot and rejects a subsequent account ABA', async () => {
  for (const aba of [false, true]) {
    const f = fixture(), target = { ...account, account_id: 'locate-target' };
    f.store.patch({ accounts: { active_account_id: account.account_id, accounts: [{ context: account, state: 'online' }, { context: target, state: 'online' }] } });
    const apply = f.actual('applyAccountSnapshot');
    const snapshot = { active_account_id: target.account_id, accounts: [{ context: account, state: 'online' }, { context: target, state: 'online' }] };
    const newRoom = () => f.store.patch({ activeGid: 'NEW', draft: 'preserve target visit', conversations: [{ gid: 'located-room', account: target, status: 'active', unread_count: 0, lang: 'en', draft: '' }] });
    let reset = false;
    if (aba) f.accountLoaded(() => {
      // This callback runs after select's host response has completed, so the
      // real navigation projector no longer masks lifecycle snapshots.
      if (reset) return; reset = true;
      apply({ ...snapshot, active_account_id: account.account_id }); apply(snapshot); newRoom();
    });
    f.selectReply(async () => {
      if (!aba) { apply(snapshot); newRoom(); } // own event arrives before RPC reply
      return snapshot;
    });
    await f.actual('locateConversation')(target, 'located-room');
    assert.equal(f.state.activeGid, aba ? 'NEW' : 'located-room');
    if (aba) assert.equal(f.state.draft, 'preserve target visit');
  }
});

test('room restore started before a real account ABA cannot replace the returned room composer', async () => {
  const f = fixture(); await f.choose();
  const unleased: any = { ...f.state.attachment }; delete unleased.lease_id; f.store.patch({ attachment: unleased });
  const gate = deferred(); f.pauseSaveReply(gate.promise);
  const restoring = f.actual('restoreRoomAttachment')(account, gid, 'old-room');
  for (let i = 0; i < 8; i++) await Promise.resolve();
  const apply = f.actual('applyAccountSnapshot'), other = { ...account, account_id: 'other-account' };
  apply({ active_account_id: other.account_id, accounts: [{ context: other, state: 'online' }] });
  apply({ active_account_id: account.account_id, accounts: [{ context: account, state: 'online' }] });
  const newer = registered('image', 'newer-selection');
  f.store.patch({ activeGid: gid, attachment: newer, draft: 'new visit text' });
  gate.resolve(null); await restoring;
  assert.equal(f.state.attachment, newer); assert.equal(f.state.draft, 'new visit text');
  assert.equal((f.state as any).attachmentRestore, null);
});
