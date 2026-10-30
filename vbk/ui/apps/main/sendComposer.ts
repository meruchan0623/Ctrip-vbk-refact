/** Composer dispatch boundary; media upload is not wired to this UI yet. */
export interface ComposerInput {
  readonly draft: string;
  readonly attachment: { readonly name: string } | null;
}
export const ATTACHMENT_SEND_UNAVAILABLE = '附件发送尚未实现，草稿和附件已保留。请移除附件后再发送文字。';

/** Shared by direct original/translated-text entry points as well as the main composer. */
export function attachmentSendUnavailable(attachment: ComposerInput['attachment']): boolean { return attachment !== null; }

export type ComposerSendResult = 'blocked_attachment' | 'empty' | 'submitted';

export async function sendComposer(input: ComposerInput, sendText: (text: string) => Promise<void>): Promise<ComposerSendResult> {
  if (attachmentSendUnavailable(input.attachment)) return 'blocked_attachment';
  const text = input.draft.trim();
  if (!text) return 'empty';
  await sendText(text);
  return 'submitted';
}
