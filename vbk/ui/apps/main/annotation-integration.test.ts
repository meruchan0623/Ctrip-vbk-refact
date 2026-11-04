import { t } from '../../packages/ui-kit/src/i18n.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { sameAnnotationOwner } from './annotation-editor.ts';
import type { UiAttachment } from '../../packages/ipc/src/client.ts';
import { UiCommands } from '../../packages/ipc/src/client.ts';
const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
const account = { account_id: 'a', environment: 'synthetic', session_generation: 1 };
const attachment = (id: string): UiAttachment => ({ attachment_id: id, name: `${id}.png`, kind: 'image', mime: 'image/png', size: 8, content_sha256: 'a'.repeat(64), supported: true, owner: { account, gid: '123456' } });
function fixture(persisting?: Promise<UiAttachment | null>) {
  let state: Record<string, any> = { attachment: attachment('previous'), attachmentSelection: null, annotationEditing: false, activeGid: '123456', view: 'messages', draftVersion: 4, account, conv: { gid: '123456', status: 'active', assistant_context_revision: 'service-1' } };
  const released: string[] = [], notices: string[] = [], subscribers: (() => void)[] = [], calls: { command: string; payload: any }[] = [];
  let config: any, editor: any, active: { original: UiAttachment; owner: any } | null = null;
  const releaseAttachment = async (value: UiAttachment | null) => { if (value) released.push(value.attachment_id); };
  const env: Record<string, any> = { t,
    persistSelectedAttachment: async (value: UiAttachment) => persisting ? await persisting : ({ ...value, lease_id: 'saved-lease' }), S: () => state, store: { patch(patch: object) { state = { ...state, ...patch }; subscribers.forEach(fn => fn()); }, subscribe: (fn: () => void) => subscribers.push(fn) },
    activeConv: () => state.conv, activeAccount: () => ({ context: state.account }), composerInputContext: () => state.view === 'messages' ? {} : null,
    isDone: (conv: any) => conv.status === 'finished', stillActive: (owner: any) => JSON.stringify(owner) === JSON.stringify(state.account),
    sameAnnotationOwner, releaseAttachment, toast: (value: string) => notices.push(value), imageViewer: { close() {} }, closeCommerce() {}, peripheral: { close() {} }, focusComposer() {},
    ownedAttachment: (value: UiAttachment, owner: any, gid: string) => value.owner.gid === gid && JSON.stringify(value.owner.account) === JSON.stringify(owner), isRegisteredMediaAttachment: (v: unknown) => !!v && typeof v === 'object' && 'attachment_id' in v,
    UiCommands, ipc: { invoke: async (command: string, payload: unknown) => { calls.push({ command, payload }); return command === UiCommands.MEDIA_ANNOTATION_APPLY ? attachment('derived') : command === UiCommands.MEDIA_SAVE_ATTACHMENT ? { saved: false } : null; } },
    HTMLElement: class {}, document: { activeElement: null, body: { appendChild() {} } },
    createAnnotationEditor(value: any) { config = value; editor = { async open(original: UiAttachment, owner: any) { active = { original, owner }; config.publish({ remove() {} }); return true; }, active: () => !!active, sync() { if (active && !sameAnnotationOwner(active.owner, config.current())) editor.cancel(); }, cancel() { const old = active; active = null; if (old) { config.publish(null); config.onCancel(old.original, old.owner); } } }; return editor; },
  };
  const a = source.indexOf('let annotationSession:'), b = source.indexOf('\nconst memberPreload =', a);
  const actual = new Function(...Object.keys(env), stripTypeScriptTypes(source.slice(a, b)) + '\nreturn { openAttachmentEditor, editSelectedAttachment };')(...Object.values(env));
  return { get state() { return state; }, released, notices, calls,
    start: async (original = attachment('source'), isNew = true) => { const selection = { account, gid: '123456', draftVersion: 4 }; env.store.patch({ attachmentSelection: selection }); await actual.openAttachmentEditor(original, selection, isNew); },
    async confirm() { const old = active!; const ready = await config.onConfirm(attachment('derived'), old.original, old.owner); if (!ready) return false; active = null; config.publish(null); return config.onCommit(attachment('derived'), old.original, old.owner); },
    cancel: () => editor.cancel(), edit: () => actual.editSelectedAttachment(),
    switchOwner() { void releaseAttachment(state.attachment); env.store.patch({ account: { ...account, account_id: 'b' }, activeGid: null, conv: null, attachment: null, attachmentSelection: null }); },
    patch: env.store.patch, apply: (request: unknown) => config.apply(request), save: () => config.save(attachment('derived')),
  };
}
test('new screenshot cancel preserves the former attachment and releases only new source once', async () => {
  const f = fixture(), before = f.state.attachment; await f.start(); assert.equal(f.state.attachment, before); assert.equal(f.state.annotationEditing, true);
  f.cancel(); f.cancel(); assert.equal(f.state.attachment, before); assert.deepEqual(f.released, ['source']); assert.equal(f.state.attachmentSelection, null); assert.equal(f.state.annotationEditing, false);
});
test('confirm inserts only derived draft attachment and releases captured source and previous once', async () => {
  const f = fixture(); await f.start(); assert.equal(await f.confirm(), true);
  assert.equal(f.state.attachment.attachment_id, 'derived'); assert.deepEqual(f.released.sort(), ['previous', 'source']); assert.equal(f.calls.length, 0, 'confirmation callback never sends a message');
});
test('editing existing PNG cancel retains source; account change releases original only once', async () => {
  const f = fixture(), original = f.state.attachment; await f.edit(); f.cancel(); assert.equal(f.state.attachment, original); assert.deepEqual(f.released, []);
  await f.edit(); f.switchOwner(); assert.deepEqual(f.released, ['previous']); assert.equal(f.state.annotationEditing, false);
  const captured = fixture(); await captured.start(); captured.switchOwner(); assert.deepEqual(captured.released.sort(), ['previous', 'source']);
});
test('draft/revision/operation changes synchronously cancel editor and preserve existing attachment', async () => {
  for (const patch of [{ draftVersion: 5 }, { conv: { gid: '123456', status: 'active', assistant_context_revision: 'service-2' } }, { view: 'orders' }, { attachmentSelection: {} }, { attachment: attachment('new-external') }]) {
    const f = fixture(); await f.start(); f.patch(patch); assert.equal(f.state.annotationEditing, false); assert.deepEqual(f.released, ['source']); assert.equal(f.state.attachment.attachment_id, 'attachment' in patch ? 'new-external' : 'previous');
  }
});
test('existing non-PNG stays selected with explicit unsupported notice; save-only command cancellation is not success', async () => {
  const f = fixture(); const previous = { ...attachment('jpeg'), mime: 'image/jpeg' }; f.patch({ attachment: previous }); await f.edit();
  assert.equal(f.state.attachment, previous); assert.ok(f.notices[0]?.includes('仅支持PNG')); assert.equal(f.state.annotationEditing, false); assert.equal(await f.save(), false);
  assert.equal(f.calls.at(-1)?.command, UiCommands.MEDIA_SAVE_ATTACHMENT); assert.deepEqual(f.calls.at(-1)?.payload, { account, gid: '123456', attachment_id: 'derived' });
});


test('main never publishes a prepared annotation after its selection owner was cancelled during persistence', async () => {
  let resolve!: (value: UiAttachment) => void; const pending = new Promise<UiAttachment>(r => { resolve = r; }), f = fixture(pending);
  await f.start(); const confirming = f.confirm(); f.switchOwner(); resolve(attachment('derived'));
  assert.equal(await confirming, false); assert.equal(f.state.attachment, null); assert.equal(f.state.annotationEditing, false); assert.deepEqual(f.released.sort(), ['previous', 'source']);
});
