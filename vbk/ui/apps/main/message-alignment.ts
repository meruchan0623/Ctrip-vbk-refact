import type { UiMessage } from '../../packages/ipc/src/client.ts';

/** Layout is independent from ownership: a colleague's message never becomes our command. */
export function messageAlignment(message: Pick<UiMessage, 'kind' | 'sender_role'>): { readonly side: 'left' | 'right' | 'system'; readonly self: boolean } {
  if (message.kind === 'system') return { side: 'system', self: false };
  const self = message.sender_role === 'merchant_self';
  const merchant = self || message.sender_role === 'merchant_other';
  return { side: merchant ? 'right' : 'left', self };
}
