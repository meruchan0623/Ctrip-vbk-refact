import { t as translateUi } from '../../packages/ui-kit/src/i18n.ts';
import { t as translate, type I18nKey } from '../../packages/ui-kit/src/i18n.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { createStore } from '../../packages/ui-kit/src/store.ts';
import { createAttachmentDraftBook, unavailableAttachment } from './attachment-draft-book.ts';
import { UiCommands, type UiAttachment, type UiDraftAttachmentSnapshot } from '../../packages/ipc/src/client.ts';
import { ImCommands } from '../../packages/ipc/src/commands.ts';
import * as boundary from './sendComposer.ts';
import * as vm from './viewmodel.ts';
import { readHistoryPage } from './history-read.ts';
const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
const account = { account_id: 'a', environment: 'synthetic', session_generation: 1 };
function deferred<T>() { let resolve!: (v: T) => void; return { promise: new Promise<T>(r => { resolve = r; }), resolve }; }
function durableHost() {
  const slots = new Map<string, UiDraftAttachmentSnapshot>(), handles = new Map<string, UiAttachment>(), calls: { command: string; payload: any }[] = [], released: string[] = [];
  let serial = 0, candidate: UiAttachment | null = null, saveGate: Promise<unknown> | null = null, restoreGate: Promise<unknown> | null = null, failSave = false;
  const ownerKey = (a: any, gid: string) => JSON.stringify([a.environment, a.account_id, gid]);
  const invoke = async (command: string, payload: any): Promise<any> => {
    calls.push({ command, payload });
    if (command === ImCommands.DRAFT_LOAD) return { drafts: [...slots].filter(([key]) => { const [env, id] = JSON.parse(key); return env === payload.account.environment && id === payload.account.account_id; }).map(([key, slot]) => ({ gid: JSON.parse(key)[2], text: 'host text must not replace local edits', version: 11, ...slot })) };
    if (command === UiCommands.MEDIA_PICK) { if (candidate) handles.set(candidate.attachment_id, candidate); return candidate; }
    if (command === UiCommands.MEDIA_RELEASE) { released.push(payload.attachment_id); handles.delete(payload.attachment_id); return; }
    if (command === UiCommands.IM_DRAFT_ATTACHMENT_SAVE) {
      if (saveGate) await saveGate;
      if (failSave) throw { code: 'store.io' };
      const key = ownerKey(payload.account, payload.gid), prior = slots.get(key) ?? { attachment_version: 0, attachments: [] };
      if (payload.expected_version !== prior.attachment_version) throw { code: 'store.cas_conflict' };
      const value = payload.attachment_id ? handles.get(payload.attachment_id) : null;
      if (payload.attachment_id && !value) throw new Error('missing short handle');
      const next = { attachment_version: prior.attachment_version + 1, attachments: value ? [{ lease_id: `lease-${value.content_sha256}`, name: value.name, mime: value.mime, kind: value.kind, size: value.size, content_sha256: value.content_sha256, state: 'ready' as const }] : [] };
      slots.set(key, next); return next;
    }
    if (command === UiCommands.IM_DRAFT_ATTACHMENT_RESTORE) {
      if (restoreGate) await restoreGate;
      const summary = slots.get(ownerKey(payload.account, payload.gid))?.attachments.find(value => value.lease_id === payload.lease_id);
      if (!summary || summary.state !== 'ready') throw new Error('not restorable');
      const restored: UiAttachment = { ...summary, supported: true, attachment_id: `restored-${++serial}`, owner: { account: payload.account, gid: payload.gid } }; handles.set(restored.attachment_id, restored); return restored;
    }
    if (command === UiCommands.IM_MESSAGE_PAGE) return { items: [], has_more: false, before_ms: null };
    throw new Error(`unexpected command ${command}`);
  };
  return { invoke, slots, calls, released, choose(gid = 'A', a = account, id = `picked-${++serial}`) { candidate = { attachment_id: id, name: 'local.png', kind: 'image', mime: 'image/png', size: 10, content_sha256: serial % 2 ? 'a'.repeat(64) : 'b'.repeat(64), owner: { account: a, gid }, supported: true }; return candidate; }, pauseSave: (p: Promise<unknown> | null) => { saveGate = p; }, pauseRestore: (p: Promise<unknown> | null) => { restoreGate = p; }, failSave: (v: boolean) => { failSave = v; }, slot: (gid = 'A', a = account) => slots.get(ownerKey(a, gid)), setState(state: 'missing' | 'corrupt' | 'pending', gid = 'A') { const key = ownerKey(account, gid), prior = slots.get(key)!; slots.set(key, { ...prior, attachments: prior.attachments.map(value => ({ ...value, state })) }); } };
}
function renderer(host = durableHost(), a = account) {
  const state = createStore<Record<string, any>>({ account: a, activeGid: 'A', conversations: ['A', 'B'].map(gid => ({ account: a, gid, status: 'active', agent_in_group: true, is_owner: true, lang: 'en' })), accounts: { active_account_id: a.account_id, accounts: [{ context: a, state: 'online' }] }, draft: 'local text', drafts: { A: 'local text' }, draftVersion: 1, attachment: null, attachmentSelection: null, attachmentRestore: null, attachmentRoom: null, attachmentDraftError: null, messages: {}, history: {}, banners: [], translation: { ...vm.TRANSLATION_IDLE }, view: 'messages', mediaOperation: null });
  const notices: string[] = [], outbound: string[] = []; let visit = 0;
  const env: Record<string, any> = { ...boundary, ...vm, PKG_IDLE: {}, S: () => state.get(), store: state, activeAccount: () => ({ context: state.get().account }), activeConv: () => state.get().conversations.find((c: any) => c.gid === state.get().activeGid), stillActive: (owner: any) => JSON.stringify(owner) === JSON.stringify(state.get().account),
    invokeQuiet: host.invoke, invokeSafe: host.invoke, ipc: { invoke: host.invoke }, UiCommands, readHistoryPage, isUiMessage: () => true, accountNavigation: { pending: () => false }, visibleReads: { retry() {} }, closeCommerce() {}, peripheral: { close() {} }, autoQueryPackage() {}, noticeQuery: { categories() {} }, translationTarget: () => 'en', translationOn: () => false, persistFailed: () => false,
    toast: (message: string) => notices.push(message), t: translateUi, scheduleTranslation() {}, quickReplies: { close() {} }, document: { visibilityState: 'hidden' }, sendText: async (text: string) => { outbound.push(text); }, sendMediaAttachment: async () => { outbound.push('media'); }, unavailableAttachment,
  };
  const book = createAttachmentDraftBook({ invoke: host.invoke, release: a => env.releaseAttachment(a) }); env.attachmentDraftBook = book;
  function actual(name: string) { const start = source.search(new RegExp('(?:async )?function ' + name + '\\(')), tail = source.slice(start), end = /\n(?:(?:async )?function |(?:let|const) [A-Za-z])/.exec(tail); assert.ok(start >= 0 && end, name); return new Function(...Object.keys(env), stripTypeScriptTypes(tail.slice(0, end.index)) + `\nreturn ${name};`)(...Object.values(env)); }
  for (const name of ['releaseAttachment', 'persistSelectedAttachment', 'persistAttachmentBeforeLeave', 'restoreRoomAttachment', 'retryAttachmentDraft', 'ownedAttachment', 'setDraft', 'ctool', 'composerMoreMenu', 'navigateToAccount', 'acceptAttachment']) env[name] = actual(name);
  const open = actual('openConversation'), pick = actual('attach'), remove = actual('removeAttachment'), send = actual('handleSend');
  return { host, state, book, notices, outbound, open, leave: env.persistAttachmentBeforeLeave, blockedResend: new Function("sendText", stripTypeScriptTypes(source.slice(source.indexOf("async function resend("), source.indexOf("\nasync function releaseAttachment("))) + "\nreturn resend;")(actual("sendText")), pick: () => pick('image'), remove: () => remove(state.get().attachment), send, set: env.setDraft, restore: () => env.restoreRoomAttachment(state.get().account, state.get().activeGid, `visit-${++visit}`), retry: env.retryAttachmentDraft };
}
async function settle() { for (let i = 0; i < 16; i++) await Promise.resolve(); }
test('actual UI commits before selection, preserves per-room text and restores a fresh leased handle after room switch and restart', async () => {
  const f = renderer(), picked = f.host.choose(); await f.pick(); assert.equal(f.state.get().attachment.lease_id, f.host.slot()?.attachments[0]?.lease_id); assert.equal(f.state.get().attachment.attachment_id, picked.attachment_id);
  await f.open('B'); await settle(); assert.equal(f.state.get().attachment, null); assert.ok(f.host.released.includes(picked.attachment_id)); f.set('B text');
  await f.open('A'); await settle(); assert.equal(f.state.get().draft, 'local text'); assert.notEqual(f.state.get().attachment.attachment_id, picked.attachment_id); assert.equal(f.state.get().drafts.B, 'B text');
  const restarted = renderer(f.host, { ...account, session_generation: 2 }); restarted.set('typed before restore'); await restarted.restore();
  assert.equal(restarted.state.get().draft, 'typed before restore'); assert.equal(restarted.state.get().attachment.owner.account.session_generation, 2); assert.equal(restarted.state.get().attachment.lease_id, f.host.slot()?.attachments[0]?.lease_id);
});
test('save failure keeps old composer and text and releases new temporary handle without sending', async () => {
  const f = renderer(); f.host.choose(); await f.pick(); const before = f.state.get().attachment; const replacement = f.host.choose('A', account, 'replacement'); f.host.failSave(true);
  await f.pick(); assert.equal(f.state.get().attachment, before); assert.equal(f.state.get().draft, 'local text'); assert.ok(f.state.get().attachmentDraftError); assert.ok(f.host.released.includes(replacement.attachment_id)); await f.send(); assert.deepEqual(f.outbound, []);
});
test('late commit on old room persists its durable ref but cannot populate the newly selected room', async () => {
  const f = renderer(), gate = deferred<unknown>(), picked = f.host.choose(); f.host.pauseSave(gate.promise); const picking = f.pick(); await settle();
  await f.open('B'); await settle(); gate.resolve(null); await picking;
  assert.equal(f.state.get().activeGid, 'B'); assert.equal(f.state.get().attachment, null); assert.equal(f.host.slot()?.attachments.length, 1); assert.ok(f.host.released.includes(picked.attachment_id));
  f.host.pauseSave(null); await f.open('A'); await settle(); assert.ok(f.state.get().attachment.lease_id);
});
test('missing/corrupt/pending restores block both media and text until explicit persisted removal; text remains intact', async () => {
  for (const unavailable of ['missing', 'corrupt', 'pending'] as const) {
    const f = renderer(); f.host.choose(); await f.pick(); f.host.setState(unavailable); await f.restore();
    assert.equal(f.state.get().attachment.unavailable, unavailable); await f.send(); assert.deepEqual(f.outbound, []); assert.equal(f.state.get().draft, 'local text');
    await f.remove(); assert.equal(f.state.get().attachment, null); assert.deepEqual(f.host.slot()?.attachments, []); await f.send(); assert.deepEqual(f.outbound, ['local text']);
  }
});
test('a late A restore after A→B→A is released and never overwrites new local attachment selection or text', async () => {
  const f = renderer(); f.host.choose(); await f.pick(); const gate = deferred<unknown>(); f.host.pauseRestore(gate.promise); const restoring = f.restore(); await settle();
  await f.open('B'); await settle(); await f.open('A'); await settle(); f.set('new text'); gate.resolve(null); await restoring; await settle();
  assert.equal(f.state.get().activeGid, 'A'); assert.equal(f.state.get().draft, 'new text'); assert.ok(f.host.released.some(id => id.startsWith('restored-'))); assert.ok(f.state.get().attachment.attachment_id.startsWith('restored-'));
});


test('pending placeholder offers no reload path and stale reload callbacks cannot unlock an uncertain attachment', async () => {
  const f = renderer(); f.host.choose(); await f.pick(); f.host.setState('pending'); await f.restore(); const calls = f.host.calls.length;
  await f.retry(); assert.equal(f.host.calls.length, calls); assert.equal(f.state.get().attachment.unavailable, 'pending'); assert.ok(f.notices.at(-1)?.includes('核验'));
});

test('a service revision change while restoring discards the late handle and shows a retryable blocked placeholder', async () => {
  const f = renderer(); f.host.choose(); await f.pick(); const gate = deferred<unknown>(); f.host.pauseRestore(gate.promise); const restore = f.restore(); await settle();
  f.state.patch({ conversations: f.state.get().conversations.map((c: any) => c.gid === 'A' ? { ...c, assistant_context_revision: 'new-service' } : c) }); gate.resolve(null); await restore;
  assert.equal(f.state.get().attachment.unavailable, 'error'); assert.equal(f.state.get().attachmentRestore, null); assert.ok(f.state.get().attachmentDraftError); await f.send(); assert.deepEqual(f.outbound, []);
});

test('review: navigation at persisted preparation publication boundary', async () => {
  const observations: any[] = [];
  for (let delay = 0; delay < 9; delay++) {
    const f = renderer(), picked = f.host.choose(); let scheduled = false;
    const originalGet = f.state.get;
    f.state.get = () => {
      const s = originalGet();
      if (!scheduled && f.host.slot()?.attachments.length && s.attachmentSelection) {
        scheduled = true;
        const navigate = (left: number) => left ? queueMicrotask(() => navigate(left - 1)) : void f.open('B');
        queueMicrotask(() => navigate(delay));
      }
      return s;
    };
    await f.pick(); await settle();
    observations.push({ delay, activeGid: f.state.get().activeGid, attachmentOwner: f.state.get().attachment?.owner?.gid, released: f.host.released });
  }
  assert.equal(observations.some(value => value.activeGid === 'B' && value.attachmentOwner === 'A'), false);
});

test('review: persist-before-leave cannot publish an old handle after account reset', async () => {
  const observations: any[] = [];
  for (let delay = 0; delay < 6; delay++) {
    const f = renderer(), picked = f.host.choose();
    await f.host.invoke(UiCommands.MEDIA_PICK, { account, gid: 'A', kind: 'image' });
    f.state.patch({ attachment: picked }); let scheduled = false;
    const originalGet = f.state.get;
    f.state.get = () => {
      const s = originalGet();
      if (!scheduled && f.host.slot()?.attachments.length && s.attachmentSelection) {
        scheduled = true;
        const reset = (left: number) => left ? queueMicrotask(() => reset(left - 1)) : f.state.patch({ account: { ...account, account_id: 'new-account' }, activeGid: 'B', attachment: null, attachmentSelection: null });
        queueMicrotask(() => reset(delay));
      }
      return s;
    };
    const saved = await f.leave(); await settle();
    observations.push({ delay, saved, accountId: f.state.get().account.account_id, attachmentOwner: f.state.get().attachment?.owner?.account.account_id });
  }
  assert.equal(observations.some(value => value.accountId === 'new-account' && value.attachmentOwner === 'a'), false);
});

test('review: blocked failed-text retry retains its original failed message', async () => {
  const f = renderer(), message = { gid: 'A', local_id: 'failed-text', kind: 'text', text: 'please retain', original: null };
  f.state.patch({ messages: { A: [message] }, attachment: unavailableAttachment({ account, gid: 'A' }, 'missing') });
  await f.blockedResend(message);
  assert.deepEqual(f.outbound, []);
  assert.deepEqual(f.state.get().messages.A, [message]);
});

test('review: outer conversation navigation cannot apply an old snapshot after persist-before-leave resolves', async () => {
  const observations: any[] = [];
  for (let delay = 0; delay < 8; delay++) {
    const f = renderer(), picked = f.host.choose();
    await f.host.invoke(UiCommands.MEDIA_PICK, { account, gid: 'A', kind: 'image' });
    f.state.patch({ attachment: picked, drafts: { A: 'A old text', B: 'B old text' } }); let scheduled = false;
    const originalGet = f.state.get;
    f.state.get = () => {
      const s = originalGet();
      if (!scheduled && f.host.slot()?.attachments.length && s.attachmentSelection) {
        scheduled = true;
        const reset = (left: number) => left ? queueMicrotask(() => reset(left - 1)) : f.state.patch({ account: { ...account, account_id: 'new-account' }, activeGid: 'NEW', draft: 'new owner text', drafts: { NEW: 'new owner text' }, conversations: [], attachment: null, attachmentSelection: null });
        queueMicrotask(() => reset(delay));
      }
      return s;
    };
    await f.open('B'); await settle();
    observations.push({ delay, accountId: f.state.get().account.account_id, activeGid: f.state.get().activeGid, draft: f.state.get().draft });
  }
  assert.equal(observations.some(value => value.accountId === 'new-account' && value.activeGid === 'B'), false);
});


test('stale explicit removal clears its operation flag so a later fresh removal can proceed', async () => {
  const f = renderer(); f.host.choose(); await f.pick();
  const gate = deferred<unknown>(); f.host.pauseSave(gate.promise);
  const removing = f.remove(); await settle();
  f.state.patch({ conversations: f.state.get().conversations.map((conv: any) => conv.gid === 'A' ? { ...conv, assistant_context_revision: 'later-service' } : conv) });
  gate.resolve(null); await removing;
  assert.equal(f.state.get().attachmentSelection, null);
  f.host.pauseSave(null); await f.restore();
  assert.equal(f.state.get().attachmentRestore, null);
  assert.equal(f.state.get().attachment, null);
});

test('actual attachment UI boundaries never echo private host errors or internal diagnostic codes', async () => {
  for (const reply of ['private-error', 'malformed'] as const) {
    const restoreHost = durableHost(), restoreInvoke = restoreHost.invoke;
    restoreHost.invoke = async (command, payload) => {
      if (command === ImCommands.DRAFT_LOAD) {
        if (reply === 'private-error') throw new Error('PRIVATE attachment /local/private/customer.png');
        return { drafts: [{ gid: 'A', attachment_version: -1, attachments: [] }] };
      }
      return restoreInvoke(command, payload);
    };
    const restoring = renderer(restoreHost); await restoring.restore();
    assert.equal(restoring.state.get().attachmentDraftError, '附件草稿读取失败。请重试；不会将文字当作附件发送。');
    assert.deepEqual(restoring.outbound, []);
    for (const operation of ['save', 'remove'] as const) {
      const host = durableHost(), invoke = host.invoke; let fail = false, failedRequests = 0;
      host.invoke = async (command, payload) => {
        if (fail && command === UiCommands.IM_DRAFT_ATTACHMENT_SAVE) {
          ++failedRequests;
          if (reply === 'private-error') throw new Error('PRIVATE attachment /local/private/customer.png');
          return {};
        }
        return invoke(command, payload);
      };
      const f = renderer(host); host.choose(); await f.pick(); const before = f.state.get().attachment;
      fail = true;
      if (operation === 'save') { host.choose('A', account, 'replacement'); await f.pick(); }
      else await f.remove();
      const expected = operation === 'save' ? '附件保存未获确认，原有文字和附件仍保留。请重新读取附件草稿后再操作。' : '附件移除未获确认，请重新读取附件草稿后再操作。';
      assert.equal(f.state.get().attachmentDraftError, expected);
      assert.equal(f.state.get().attachment, before); assert.equal(f.state.get().draft, 'local text');
      assert.deepEqual(f.outbound, []);
      assert.equal(failedRequests, 1, 'failed explicit request is not replayed');
      assert.equal(JSON.stringify(f.notices).includes('PRIVATE'), false);
    }
  }
});
