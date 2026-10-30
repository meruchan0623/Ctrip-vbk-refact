import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { UiMessage } from '../../packages/ipc/src/client.ts';
import { mergeMessageProfile, renderMessageAvatar } from './message-profile.ts';

const message: UiMessage = { gid: 'synthetic-room', message_id: 'synthetic-message', local_id: 'synthetic-local', sender_role: 'merchant_self', sender_id: 'synthetic-self', sender_name: 'Synthetic Self', sender_avatar: 'https://dimg04.c-ctrip.com/synthetic-self.png', kind: 'text', text: 'SYNTHETIC FIXTURE ONLY', create_time_ms: 1800000000000, translation: null, original: null, quote: null, order_id: null, disposition: null };

test('local send receipt preserves adapter sender metadata and applies new disposition', () => {
  const { sender_id, sender_name, sender_avatar, ...sparse } = message;
  const receipt: UiMessage = { ...sparse, disposition: { kind: 'confirmed', server_message_id: 'synthetic-message', server_time_ms: message.create_time_ms } };
  const merged = mergeMessageProfile(message, receipt);
  assert.equal(merged.sender_id, sender_id);
  assert.equal(merged.sender_name, sender_name);
  assert.equal(merged.sender_avatar, sender_avatar);
  assert.equal(merged.disposition?.kind, 'confirmed');
});

test('same normalized sender may retain sparse fields; new API avatar updates old value', () => {
  const merged = mergeMessageProfile(message, { ...message, sender_id: 'SYNTHETIC-SELF', sender_name: null, sender_avatar: null });
  assert.equal(merged.sender_name, message.sender_name);
  assert.equal(merged.sender_avatar, message.sender_avatar);
  const updated = mergeMessageProfile(message, { ...message, sender_avatar: 'https://dimg04.c-ctrip.com/synthetic-updated.png' });
  assert.equal(updated.sender_avatar, 'https://dimg04.c-ctrip.com/synthetic-updated.png');
});

test('a conflicting sender never inherits previous identity or avatar, even if the role matches', () => {
  const merged = mergeMessageProfile(message, { ...message, sender_id: 'synthetic-other', sender_name: null, sender_avatar: null });
  assert.equal(merged.sender_id, 'synthetic-other');
  assert.equal(merged.sender_name, null);
  assert.equal(merged.sender_avatar, null);
  const fresh = mergeMessageProfile(message, { ...message, sender_id: 'synthetic-other', sender_name: 'Synthetic Other', sender_avatar: 'https://dimg04.c-ctrip.com/synthetic-other.png' });
  assert.equal(fresh.sender_name, 'Synthetic Other');
  assert.equal(fresh.sender_avatar, 'https://dimg04.c-ctrip.com/synthetic-other.png');
});

test('missing sender plus changed role and unbound sender identity cannot inherit old profile', () => {
  const changed = mergeMessageProfile(message, { ...message, sender_id: '', sender_role: 'customer', sender_name: null, sender_avatar: null });
  assert.equal(changed.sender_avatar, null);
  const unbound = mergeMessageProfile({ ...message, sender_id: '' }, { ...message, sender_id: 'synthetic-other', sender_avatar: null });
  assert.equal(unbound.sender_avatar, null);
});

type FakeText = { text: string };
interface FakeImage { src: string; alt: string; referrerPolicy: string; onerror: ((event: Event) => unknown) | null; replacement: FakeText | null; replaceWith(node: FakeText): void }
function fakeDocument() {
  const images: FakeImage[] = [];
  const doc = {
    createTextNode: (text: string) => ({ text }),
    createElement: (_tag: string) => {
      const image: FakeImage = { src: '', alt: '', referrerPolicy: '', onerror: null, replacement: null, replaceWith(node) { this.replacement = node; } };
      images.push(image); return image;
    },
  } as unknown as Pick<Document, 'createElement' | 'createTextNode'>;
  return { doc, images };
}

test('actual avatar renderer loads only the supplied API avatar and falls back on load failure', () => {
  const { doc, images } = fakeDocument();
  renderMessageAvatar(doc, 'Synthetic Self', message.sender_avatar);
  assert.equal(images[0]?.src, message.sender_avatar);
  assert.equal(images[0]?.alt, 'Synthetic Self');
  assert.equal(images[0]?.referrerPolicy, 'no-referrer');
  images[0]?.onerror?.(new Event('error'));
  assert.equal(images[0]?.replacement?.text, 'S');
  assert.equal(images[0]?.onerror, null);
});

test('unsafe or missing avatar never creates an image request', () => {
  for (const source of [null, undefined, '', 'javascript:alert(1)', 'data:image/png;base64,AAA', 'file:///synthetic.png', 'http://dimg04.c-ctrip.com/synthetic.png', 'https://user:password@example.invalid/synthetic.png', '//example.invalid/synthetic.png']) {
    const { doc, images } = fakeDocument();
    const node = renderMessageAvatar(doc, 'Customer', source) as unknown as FakeText;
    assert.equal(images.length, 0);
    assert.equal(node.text, 'C');
  }
});

test('late image error remains tied to that image and never changes a replacement sender', () => {
  const { doc, images } = fakeDocument();
  renderMessageAvatar(doc, 'Alice', 'https://dimg04.c-ctrip.com/synthetic-alice.png');
  renderMessageAvatar(doc, 'Bob', 'https://dimg04.c-ctrip.com/synthetic-bob.png');
  images[0]?.onerror?.(new Event('error'));
  assert.equal(images[0]?.replacement?.text, 'A');
  assert.equal(images[1]?.replacement, null);
  assert.equal(images[1]?.alt, 'Bob');
});
