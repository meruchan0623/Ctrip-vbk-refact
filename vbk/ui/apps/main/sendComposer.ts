import type { UiAttachment } from '../../packages/ipc/src/client.ts';

/** Composer dispatch boundary; unregistered attachments never fall through to text. */
export interface ComposerInput {
  readonly draft: string;
  readonly attachment: { readonly name: string } | null;
}
export const ATTACHMENT_SEND_UNAVAILABLE = '附件发送尚未实现，草稿和附件已保留。请移除附件后再发送文字。';

/** Shared by direct original/translated-text entry points as well as the main composer. */
export function attachmentSendUnavailable(attachment: ComposerInput['attachment']): boolean { return attachment !== null; }

export function isRegisteredMediaAttachment(value: unknown): value is UiAttachment {
  if (!value || typeof value !== 'object') return false;
  const a = value as Partial<UiAttachment>;
  return a.supported === true && typeof a.attachment_id === 'string' && !!a.attachment_id && typeof a.name === 'string'
    && ['image', 'file', 'video'].includes(a.kind ?? '') && typeof a.mime === 'string' && typeof a.size === 'number' && Number.isFinite(a.size) && a.size > 0
    && typeof a.content_sha256 === 'string' && /^[a-f0-9]{64}$/i.test(a.content_sha256)
    && !!a.owner && typeof a.owner.gid === 'string' && !!a.owner.gid && !!a.owner.account
    && typeof a.owner.account.account_id === 'string' && !!a.owner.account.account_id && typeof a.owner.account.environment === 'string'
    && Number.isSafeInteger(a.owner.account.session_generation) && a.owner.account.session_generation >= 0;
}

export type ComposerSendResult = 'blocked_attachment' | 'empty' | 'submitted';

export async function sendComposer(input: ComposerInput, sendText: (text: string) => Promise<void>, sendMedia?: (attachment: UiAttachment) => Promise<void>): Promise<ComposerSendResult> {
  if (attachmentSendUnavailable(input.attachment)) {
    if (!sendMedia || !isRegisteredMediaAttachment(input.attachment)) return 'blocked_attachment';
    await sendMedia(input.attachment);
    return 'submitted';
  }
  const text = input.draft.trim();
  if (!text) return 'empty';
  await sendText(text);
  return 'submitted';
}
