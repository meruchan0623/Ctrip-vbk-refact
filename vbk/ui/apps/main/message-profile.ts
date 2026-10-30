import type { UiMessage } from '../../packages/ipc/src/client.ts';
import { safeMediaUrl } from './viewmodel.ts';
import { initialOf } from '../../packages/ui-kit/src/format.ts';

/** A send receipt may omit sender metadata already delivered by the account adapter. */
export function mergeMessageProfile(existing: UiMessage, incoming: UiMessage): UiMessage {
  const oldId = existing.sender_id?.trim().toLowerCase() || null;
  const newId = incoming.sender_id?.trim().toLowerCase() || null;
  // A sparse receipt may inherit a known sender only while its role is unchanged.
  // A new explicit identity never inherits an unbound or conflicting profile.
  const sameSender = oldId !== null && (newId !== null ? oldId === newId : existing.sender_role === incoming.sender_role);
  if (!sameSender) return incoming;
  const present = (value: string | null | undefined): boolean => typeof value === 'string' && value.trim() !== '';
  return {
    ...incoming,
    ...(!present(incoming.sender_id) && present(existing.sender_id) ? { sender_id: existing.sender_id! } : {}),
    ...(!present(incoming.sender_name) && present(existing.sender_name) ? { sender_name: existing.sender_name! } : {}),
    ...(!present(incoming.sender_avatar) && present(existing.sender_avatar) ? { sender_avatar: existing.sender_avatar! } : {}),
  };
}

/** Only an actual API-provided safe URL is loaded; failures keep this person's text fallback. */
export function renderMessageAvatar(doc: Pick<Document, 'createElement' | 'createTextNode'>, name: string, source: string | null | undefined): Node {
  const url = safeMediaUrl(source);
  if (!url) return doc.createTextNode(initialOf(name));
  const image = doc.createElement('img');
  image.src = url;
  image.alt = name;
  image.referrerPolicy = 'no-referrer';
  image.onerror = () => {
    image.onerror = null;
    image.replaceWith(doc.createTextNode(initialOf(name)));
  };
  return image;
}
