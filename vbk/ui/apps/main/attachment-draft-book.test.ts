import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAttachmentDraftBook, parseAttachmentSnapshot } from './attachment-draft-book.ts';
import { UiCommands, type UiAttachment, type UiDraftAttachment } from '../../packages/ipc/src/client.ts';
import { ImCommands } from '../../packages/ipc/src/commands.ts';
const account = { account_id: 'a', environment: 'synthetic', session_generation: 1 }, scope = { account, gid: 'g' };
const candidate: UiAttachment = { attachment_id: 'handle-1', kind: 'image', name: 'image.png', mime: 'image/png', size: 10, content_sha256: 'a'.repeat(64), supported: true, owner: { account, gid: 'g' } };
const summary: UiDraftAttachment = { lease_id: 'lease-1', kind: 'image', name: 'image.png', mime: 'image/png', size: 10, content_sha256: 'a'.repeat(64), state: 'ready' };
function deferred<T>() { let resolve!: (v: T) => void, reject!: (e: unknown) => void; return { promise: new Promise<T>((res, rej) => { resolve = res; reject = rej; }), resolve, reject }; }
function fixture() {
  let load: unknown = { drafts: [{ gid: 'g', text: 'unchanged text', version: 12, attachment_version: 3, attachments: [summary] }] }, restore: unknown = { ...candidate, attachment_id: 'fresh-handle', lease_id: summary.lease_id }, save: unknown = { attachment_version: 4, attachments: [summary] };
  const calls: { command: string; payload: any }[] = [], released: UiAttachment[] = [];
  const book = createAttachmentDraftBook({ invoke: async (command, payload) => { calls.push({ command, payload }); const result = await (command === ImCommands.DRAFT_LOAD ? load : command === UiCommands.IM_DRAFT_ATTACHMENT_SAVE ? save : restore); if (result instanceof Error || result && typeof result === 'object' && 'code' in result) throw result; return result; }, release: async value => { released.push(value); } });
  return { book, calls, released, load: (v: unknown) => { load = v; }, restore: (v: unknown) => { restore = v; }, save: (v: unknown) => { save = v; } };
}
test('restart restores summary into a fresh current-generation handle without loading text into the composer', async () => {
  const f = fixture(), result = await f.book.restore(scope, () => true);
  assert.equal(result.kind, 'current'); if (result.kind !== 'current') return;
  assert.equal((result.attachment as UiAttachment).attachment_id, 'fresh-handle'); assert.equal((result.attachment as UiAttachment).lease_id, 'lease-1');
  assert.deepEqual(f.calls.map(call => call.command), [ImCommands.DRAFT_LOAD, UiCommands.IM_DRAFT_ATTACHMENT_RESTORE]);
  assert.deepEqual(f.calls[1]?.payload, { account, gid: 'g', lease_id: 'lease-1' }); assert.equal('text' in result, false);
});
test('old text-only rows mean empty attachment v0; unavailable and pending leases never invoke handle restore', async () => {
  const legacy = fixture(); legacy.load({ drafts: [{ gid: 'g', text: 'legacy text', version: 2 }] }); assert.deepEqual(await legacy.book.restore(scope, () => true), { kind: 'current', attachment: null, snapshot: { attachment_version: 0, attachments: [] } });
  for (const state of ['missing', 'corrupt', 'pending'] as const) {
    const f = fixture(); f.load({ drafts: [{ gid: 'g', attachment_version: 7, attachments: [{ ...summary, state }] }] });
    const result = await f.book.restore(scope, () => true); assert.equal(result.kind, 'current'); if (result.kind === 'current') assert.equal((result.attachment as any).unavailable, state);
    assert.equal(f.calls.length, 1);
  }
});
test('new attachment selection commits attachment-only CAS before returning a leased handle; explicit clear uses null', async () => {
  const f = fixture(), result = await f.book.save(scope, candidate, () => true);
  assert.equal(result.kind, 'current'); if (result.kind === 'current') assert.equal(result.attachment?.lease_id, summary.lease_id);
  assert.deepEqual(f.calls[1]?.payload, { account, gid: 'g', attachment_id: 'handle-1', expected_version: 3 });
  assert.equal('text' in f.calls[1]!.payload, false); f.save({ attachment_version: 5, attachments: [] });
  await f.book.save(scope, null, () => true); assert.deepEqual(f.calls.at(-1)?.payload, { account, gid: 'g', attachment_id: null, expected_version: 4 });
});
test('CAS conflicts are never automatically replayed and the next explicit intent relearns host version', async () => {
  const f = fixture(); f.save({ code: 'store.cas_conflict' }); await assert.rejects(f.book.save(scope, candidate, () => true));
  assert.equal(f.calls.filter(call => call.command === UiCommands.IM_DRAFT_ATTACHMENT_SAVE).length, 1);
  f.load({ drafts: [{ gid: 'g', attachment_version: 8, attachments: [] }] }); f.save({ attachment_version: 9, attachments: [summary] }); await f.book.save(scope, candidate, () => true);
  assert.equal(f.calls.at(-1)?.payload.expected_version, 8);
});
test('late restore handles are released when owner visits change, and a stale load cannot resurrect a newer selection', async () => {
  const f = fixture(), pending = deferred<unknown>(); let valid = true; f.restore(pending.promise); const restoring = f.book.restore(scope, () => valid);
  for (let i = 0; i < 5; i++) await Promise.resolve(); valid = false; pending.resolve({ ...candidate, attachment_id: 'late-handle', lease_id: summary.lease_id });
  assert.deepEqual(await restoring, { kind: 'stale' }); assert.equal(f.released[0]?.attachment_id, 'late-handle');
  const late = deferred<unknown>(), g = fixture(); g.load(late.promise); const old = g.book.restore(scope, () => true);
  g.load({ drafts: [{ gid: 'g', attachment_version: 5, attachments: [] }] }); g.save({ attachment_version: 6, attachments: [summary] }); await g.book.save(scope, candidate, () => true);
  late.resolve({ drafts: [{ gid: 'g', attachment_version: 3, attachments: [summary] }] }); assert.deepEqual(await old, { kind: 'stale' });
  g.save({ attachment_version: 7, attachments: [] }); await g.book.save(scope, null, () => true); assert.equal(g.calls.at(-1)?.payload.expected_version, 6);
});
test('commit that completes after navigation preserves old-scope persistence but never returns a publishable handle', async () => {
  const f = fixture(), pending = deferred<unknown>(); let valid = true; f.save(pending.promise); const saving = f.book.save(scope, candidate, () => valid);
  for (let i = 0; i < 5; i++) await Promise.resolve(); valid = false; pending.resolve({ attachment_version: 4, attachments: [summary] });
  assert.deepEqual(await saving, { kind: 'stale', committed: true }); assert.deepEqual(f.released, [], 'caller owns the candidate short handle');
});
test('missing bytes, corrupt metadata and malformed save replies never fall through to plain text or successful empty saves', async () => {
  const f = fixture(); f.restore(new Error('missing bytes')); const result = await f.book.restore(scope, () => true); assert.equal(result.kind, 'current'); if (result.kind === 'current') assert.equal((result.attachment as any).unavailable, 'error');
  for (const response of [null, {}, { attachment_version: -1, attachments: [] }, { attachment_version: 4, attachments: [] }]) { const bad = fixture(); bad.save(response); await assert.rejects(bad.book.save(scope, candidate, () => true)); }
  assert.throws(() => parseAttachmentSnapshot({ attachment_version: 1, attachments: [{ ...summary, content_sha256: 'wrong' }] }));
});


test('a new login generation relearns attachment CAS and rejects foreign restored handles without releasing another owner', async () => {
  const f = fixture(); await f.book.save(scope, candidate, () => true);
  const next = { ...scope, account: { ...account, session_generation: 2 } }, current = { ...candidate, owner: { account: next.account, gid: next.gid } };
  f.load({ drafts: [{ gid: 'g', attachment_version: 12, attachments: [] }] }); f.save({ attachment_version: 13, attachments: [summary] });
  await f.book.save(next, current, () => true); assert.equal(f.calls.at(-1)?.payload.expected_version, 12); assert.equal(f.calls.at(-1)?.payload.account.session_generation, 2);
  f.load({ drafts: [{ gid: 'g', attachment_version: 13, attachments: [summary] }] }); f.restore({ ...candidate, owner: { account: { ...account, account_id: 'foreign' }, gid: 'g' } });
  const result = await f.book.restore(scope, () => true); if (result.kind === 'current') assert.equal((result.attachment as any).unavailable, 'error'); assert.deepEqual(f.released, []);
});

test('explicit nulls and nonadvancing save versions are malformed instead of legacy emptiness', async () => {
  assert.throws(() => parseAttachmentSnapshot({ attachment_version: null, attachments: [] })); assert.throws(() => parseAttachmentSnapshot({ attachment_version: 0, attachments: null }));
  const f = fixture(); f.save({ attachment_version: 3, attachments: [summary] }); await assert.rejects(f.book.save(scope, candidate, () => true));
});


test('confirmation cache invalidation does not cancel a committed replacement awaiting its response', async () => {
  const f = fixture(), response = deferred<unknown>();
  f.save(response.promise);
  const saving = f.book.save(scope, candidate, () => true);
  for (let i = 0; i < 8; i++) await Promise.resolve();
  f.book.invalidateVersion(scope);
  response.resolve({ attachment_version: 4, attachments: [summary] });
  const result = await saving;
  assert.equal(result.kind, 'current');
  if (result.kind === 'current') assert.equal(result.attachment?.attachment_id, candidate.attachment_id);
  assert.deepEqual(f.released, []);
});

test('private attachment validation uses stable diagnostics without changing Error classification', async () => {
  const diagnostic = (message: string) => (error: unknown) => {
    assert.ok(error instanceof Error); assert.equal(error.message, message); assert.equal('code' in error, false); return true;
  };
  assert.throws(() => parseAttachmentSnapshot(null), diagnostic('attachment_draft.invalid_snapshot'));
  assert.throws(() => parseAttachmentSnapshot({ attachment_version: -1, attachments: [] }), diagnostic('attachment_draft.invalid_snapshot_shape'));
  assert.throws(() => parseAttachmentSnapshot({ attachments: [{}] }), diagnostic('attachment_draft.invalid_summary'));
  const invalid = fixture(); invalid.load({ drafts: null }); await assert.rejects(invalid.book.inspect(scope), diagnostic('attachment_draft.invalid_load_response'));
  const duplicate = fixture(); duplicate.load({ drafts: [{ gid: 'g' }, { gid: 'g' }] }); await assert.rejects(duplicate.book.inspect(scope), diagnostic('attachment_draft.duplicate_record'));
  const foreign = fixture(); await assert.rejects(foreign.book.save(scope, { ...candidate, owner: { account, gid: 'foreign' } }, () => true), diagnostic('attachment_draft.wrong_owner')); assert.deepEqual(foreign.calls, []);
  for (const [response, code] of [[{}, 'save_unconfirmed'], [{ attachment_version: 3, attachments: [summary] }, 'save_version_not_advanced'], [{ attachment_version: 4, attachments: [] }, 'save_unconfirmed']] as const) {
    const f = fixture(); f.save(response); await assert.rejects(f.book.save(scope, candidate, () => true), diagnostic(`attachment_draft.${code}`));
    assert.equal(f.calls.filter(call => call.command === UiCommands.IM_DRAFT_ATTACHMENT_SAVE).length, 1);
  }
  for (const response of [{}, { ...candidate, lease_id: summary.lease_id, content_sha256: 'b'.repeat(64) }]) {
    const f = fixture(); f.restore(response); const result = await f.book.restore(scope, () => true);
    assert.equal(result.kind, 'current'); if (result.kind === 'current') assert.equal((result.attachment as any).unavailable, 'error');
  }
});
