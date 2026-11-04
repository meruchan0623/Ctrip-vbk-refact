import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attachmentInfo, carouselSlots, isViewerAttachment, isViewerGallery, slotPosition } from './attachment.ts';

test('file messages use media preview for known formats, including signed URL paths', () => {
  for (const [name, kind] of [['photo.JPG', 'image'], ['clip.mp4', 'video'], ['recording.m4a', 'audio'], ['report.pdf', 'file'], ['archive.zip', 'file'], ['page.html', 'file'], ['image.svg', 'file']]) {
    assert.equal(attachmentInfo({ kind: 'file', name: name!, url: `https://static.tripcdn.com/${name}?token=fixture` }).kind, kind);
  }
  assert.deepEqual(attachmentInfo({ kind: 'file', name: '', url: 'https://static.tripcdn.com/my%20photo.png?token=fixture' }), { name: 'my photo.png', extension: 'png', kind: 'image' });
});

test('explicit media type wins over extension and malformed names remain plain text', () => {
  assert.equal(attachmentInfo({ kind: 'image', name: 'resource', url: 'https://static.tripcdn.com/resource' }).kind, 'image');
  assert.equal(attachmentInfo({ kind: 'video', name: 'cover.png', url: 'https://static.tripcdn.com/stream' }).kind, 'video');
  assert.equal(attachmentInfo({ kind: 'file', name: '<script>alert(1)</script>', url: 'https://static.tripcdn.com/%ZZ' }).kind, 'file');
});

test('the viewer accepts only well-formed https attachments from the host', () => {
  const good = { kind: 'image', url: 'https://static.tripcdn.com/a.png', name: 'a.png', thumbnail: null };
  assert.equal(isViewerAttachment(good), true);
  for (const bad of [null, {}, 'x', { ...good, kind: 'voice' }, { ...good, url: 'http://static.tripcdn.com/a.png' }, { ...good, url: 'javascript:alert(1)' }, { ...good, name: 1 }]) {
    assert.equal(isViewerAttachment(bad), false, JSON.stringify(bad));
  }
});

test('the viewer accepts only a gallery whose index points at a valid item', () => {
  const item = { kind: 'image', url: 'https://static.tripcdn.com/a.png', name: 'a.png', thumbnail: null };
  assert.equal(isViewerGallery({ items: [item, item], index: 1 }), true);
  for (const bad of [null, {}, item, { items: [], index: 0 }, { items: [item], index: 1 }, { items: [item], index: -1 }, { items: [item], index: 0.5 }, { items: [item, { ...item, url: 'http://x.tripcdn.com/a' }], index: 0 }]) {
    assert.equal(isViewerGallery(bad), false, JSON.stringify(bad));
  }
});

test('carousel keeps neighbours mounted around the current image and stops at both ends', () => {
  const items = (count: number, index: number) => carouselSlots(count, index).map(s => [s.item, s.offset]);
  assert.deepEqual(items(1, 0), [[0, 0]]);
  assert.deepEqual(items(3, 0), [[0, 0], [1, 1], [2, 2]]);
  assert.deepEqual(items(3, 2), [[0, -2], [1, -1], [2, 0]]);
  assert.deepEqual(items(9, 4), [[1, -3], [2, -2], [3, -1], [4, 0], [5, 1], [6, 2], [7, 3]]);
});

test('only direct neighbours are visible peeks; further ones wait hidden on their side', () => {
  assert.deepEqual([-3, -2, -1, 0, 1, 2, 3].map(slotPosition), ['before', 'before', 'prev', 'main', 'next', 'after', 'after']);
});
