import { t } from '../../packages/ui-kit/src/i18n.ts';
import { ImCommands } from '../../packages/ipc/src/commands.ts';
import { UiCommands, type UiAttachment, type UiDraftAttachment, type UiDraftAttachmentSnapshot } from '../../packages/ipc/src/client.ts';
import type { AccountContext } from '../../packages/ipc/src/contracts.ts';
import { isRegisteredMediaAttachment } from './sendComposer.ts';
export interface AttachmentDraftScope { readonly account: AccountContext; readonly gid: string }
export interface UnavailableAttachment { readonly name: string; readonly unavailable: 'loading' | 'missing' | 'corrupt' | 'pending' | 'error'; readonly lease_id?: string; readonly owner: { readonly account: AccountContext; readonly gid: string } }
export type RestoredAttachment = { readonly kind: 'current'; readonly attachment: UiAttachment | UnavailableAttachment | null; readonly snapshot: UiDraftAttachmentSnapshot } | { readonly kind: 'stale' };
export type SavedAttachment = { readonly kind: 'current'; readonly attachment: UiAttachment | null; readonly snapshot: UiDraftAttachmentSnapshot } | { readonly kind: 'stale'; readonly committed: boolean };
const key = (scope: AttachmentDraftScope) => JSON.stringify([scope.account.environment, scope.account.account_id, scope.gid]);
const sameAccount = (a: AccountContext, b: AccountContext) => a.environment === b.environment && a.account_id === b.account_id && a.session_generation === b.session_generation;
export function unavailableAttachment(scope: AttachmentDraftScope, unavailable: UnavailableAttachment['unavailable'], summary?: UiDraftAttachment): UnavailableAttachment {
  return { name: summary?.name ?? (unavailable === 'loading' ? t('attachment.loadingName') : t('attachment.unavailableName')), unavailable, ...(summary ? { lease_id: summary.lease_id } : {}), owner: { account: { ...scope.account }, gid: scope.gid } };
}
export function parseAttachmentSnapshot(value: unknown): UiDraftAttachmentSnapshot {
  if (!value || typeof value !== 'object') throw new Error('attachment_draft.invalid_snapshot');
  const v = value as Partial<UiDraftAttachmentSnapshot>, version = v.attachment_version === undefined ? 0 : v.attachment_version, items = v.attachments === undefined ? [] : v.attachments;
  if (!Number.isSafeInteger(version) || version < 0 || !Array.isArray(items) || items.length > 1) throw new Error('attachment_draft.invalid_snapshot_shape');
  for (const item of items) if (!item || typeof item !== 'object' || typeof item.lease_id !== 'string' || !item.lease_id || item.lease_id.length > 512 || typeof item.name !== 'string' || !['image', 'file', 'video'].includes(item.kind) || typeof item.mime !== 'string' || !Number.isSafeInteger(item.size) || item.size <= 0 || typeof item.content_sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(item.content_sha256) || !['ready', 'missing', 'corrupt', 'pending'].includes(item.state)) throw new Error('attachment_draft.invalid_summary');
  return { attachment_version: version, attachments: items.map(item => ({ ...item })) };
}
export function createAttachmentDraftBook(port: {
  invoke(command: string, payload: unknown): Promise<unknown>;
  release(attachment: UiAttachment): Promise<void>;
}) {
  const versions = new Map<string, number>(), generations = new Map<string, number>(), tickets = new Map<string, number>();
  const begin = (scope: AttachmentDraftScope) => { const id = (tickets.get(key(scope)) ?? 0) + 1; tickets.set(key(scope), id); return id; };
  const current = (scope: AttachmentDraftScope, ticket: number, valid: () => boolean) => tickets.get(key(scope)) === ticket && valid();
  async function read(scope: AttachmentDraftScope): Promise<UiDraftAttachmentSnapshot> {
    const reply = await port.invoke(ImCommands.DRAFT_LOAD, { account: scope.account });
    const rows = (reply as { drafts?: unknown } | null)?.drafts;
    if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== 'object' || typeof row.gid !== 'string')) throw new Error('attachment_draft.invalid_load_response');
    const matches = rows.filter(row => row.gid === scope.gid);
    if (matches.length > 1) throw new Error('attachment_draft.duplicate_record');
    return matches.length ? parseAttachmentSnapshot(matches[0]) : { attachment_version: 0, attachments: [] };
  }
  async function inspect(scope: AttachmentDraftScope): Promise<UiDraftAttachmentSnapshot | null> {
    const ticket = begin(scope), snapshot = await read(scope);
    if (tickets.get(key(scope)) !== ticket) return null;
    versions.set(key(scope), snapshot.attachment_version); generations.set(key(scope), scope.account.session_generation); return snapshot;
  }
  async function restore(scope: AttachmentDraftScope, valid: () => boolean): Promise<RestoredAttachment> {
    const ticket = begin(scope), snapshot = await read(scope);
    if (!current(scope, ticket, valid)) return { kind: 'stale' };
    versions.set(key(scope), snapshot.attachment_version); generations.set(key(scope), scope.account.session_generation);
    const summary = snapshot.attachments[0];
    if (!summary) return { kind: 'current', attachment: null, snapshot };
    if (summary.state !== 'ready') return { kind: 'current', attachment: unavailableAttachment(scope, summary.state, summary), snapshot };
    let attachment: UiAttachment | null = null;
    try {
      const value = await port.invoke(UiCommands.IM_DRAFT_ATTACHMENT_RESTORE, { account: scope.account, gid: scope.gid, lease_id: summary.lease_id });
      if (!isRegisteredMediaAttachment(value)) throw new Error('attachment_draft.invalid_restore_response');
      attachment = value;
      if (!current(scope, ticket, valid)) { const stale = attachment; attachment = null; if (sameAccount(stale.owner.account, scope.account) && stale.owner.gid === scope.gid) await port.release(stale); return { kind: 'stale' }; }
      if (!sameAccount(value.owner.account, scope.account) || value.owner.gid !== scope.gid || value.content_sha256 !== summary.content_sha256 || value.size !== summary.size || value.kind !== summary.kind || value.mime !== summary.mime || (value.lease_id !== undefined && value.lease_id !== summary.lease_id)) throw new Error('attachment_draft.restore_mismatch');
      return { kind: 'current', attachment: { ...value, lease_id: summary.lease_id }, snapshot };
    } catch {
      if (attachment) { const invalid = attachment; attachment = null; if (sameAccount(invalid.owner.account, scope.account) && invalid.owner.gid === scope.gid) await port.release(invalid); }
      return current(scope, ticket, valid) ? { kind: 'current', attachment: unavailableAttachment(scope, 'error', summary), snapshot } : { kind: 'stale' };
    }
  }
  async function save(scope: AttachmentDraftScope, attachment: UiAttachment | null, valid: () => boolean): Promise<SavedAttachment> {
    const ticket = begin(scope);
    if (attachment && (!isRegisteredMediaAttachment(attachment) || !sameAccount(attachment.owner.account, scope.account) || attachment.owner.gid !== scope.gid)) throw new Error('attachment_draft.wrong_owner');
    if (generations.get(key(scope)) !== scope.account.session_generation) versions.delete(key(scope));
    if (!versions.has(key(scope))) {
      const snapshot = await read(scope);
      if (!current(scope, ticket, valid)) return { kind: 'stale', committed: false };
      versions.set(key(scope), snapshot.attachment_version); generations.set(key(scope), scope.account.session_generation);
    }
    if (!current(scope, ticket, valid)) return { kind: 'stale', committed: false };
    const expectedVersion = versions.get(key(scope))!;
    try {
      const raw = await port.invoke(UiCommands.IM_DRAFT_ATTACHMENT_SAVE, { account: scope.account, gid: scope.gid, attachment_id: attachment?.attachment_id ?? null, expected_version: expectedVersion });
      if (!raw || typeof raw !== 'object' || !('attachment_version' in raw) || !('attachments' in raw)) throw new Error('attachment_draft.save_unconfirmed');
      const snapshot = parseAttachmentSnapshot(raw), summary = snapshot.attachments[0];
      if (snapshot.attachment_version <= expectedVersion) throw new Error('attachment_draft.save_version_not_advanced');
      if (attachment ? !summary || summary.content_sha256 !== attachment.content_sha256 || summary.size !== attachment.size || summary.kind !== attachment.kind || summary.mime !== attachment.mime || summary.state !== 'ready' : !!summary) throw new Error('attachment_draft.save_unconfirmed');
      if (!current(scope, ticket, valid)) return { kind: 'stale', committed: true };
      versions.set(key(scope), snapshot.attachment_version); generations.set(key(scope), scope.account.session_generation);
      return { kind: 'current', attachment: attachment && summary ? { ...attachment, lease_id: summary.lease_id } : null, snapshot };
    } catch (error) {
      if (tickets.get(key(scope)) === ticket) versions.delete(key(scope));
      throw error; // In particular, never auto-replay a CAS conflict with an obsolete selection.
    }
  }
  return { restore, save, inspect, invalidateVersion(scope: AttachmentDraftScope) { versions.delete(key(scope)); }, invalidate(scope: AttachmentDraftScope) { begin(scope); versions.delete(key(scope)); } };
}
