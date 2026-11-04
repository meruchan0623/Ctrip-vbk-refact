import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createImageViewer, imageViewerView, viewerImageUrl, type ImageViewerScope, type ImageViewerState, type ViewerImage } from './image-viewer.ts';
import { installFakeDom, fakeDocument, resetCounters, readCounters } from '../../tests/fake-dom.ts';
import { rerender } from '../../packages/ui-kit/src/h.ts';
const account = { account_id: 'a', environment: 'synthetic', session_generation: 1 };
const image: ViewerImage = { account, gid: '123456', revision: 'service-1', messageId: '9007199254740993123', url: 'https://dimg04.c-ctrip.com/synthetic.png', name: '会话图片' };
function deferred() { let resolve!: (value: 'saved' | 'cancelled') => void, reject!: (error: unknown) => void; return { promise: new Promise<'saved' | 'cancelled'>((res, rej) => { resolve = res; reject = rej; }), resolve, reject }; }
function fixture(save?: (value: ViewerImage) => Promise<'saved' | 'cancelled'>) {
  let scope: ImageViewerScope | null = { ...image }, state: ImageViewerState | null = null;
  const controller = createImageViewer({ current: () => scope, publish: value => { state = value; }, ...(save ? { save } : {}) });
  return { controller, get state() { return state; }, scope: (value: ImageViewerScope | null) => { scope = value; }, open: (value = image) => controller.open(value) };
}
test('viewer admits only the existing official HTTPS media CSP/host intersection', () => {
  for (const url of [image.url, 'https://media.ctrip.com/a.png', 'https://static.tripcdn.com/a.webp']) assert.equal(viewerImageUrl(url), url);
  for (const url of ['http://media.ctrip.com/a.png', 'https://media.ctrip.com:8443/a.png', 'https://user:secret@media.ctrip.com/a.png', 'https://media.ctrip.com.evil.invalid/a.png', 'https://eviltripcdn.com/a.png', 'https://images.trip.com/a.png', 'https://ctrip.com/a.png', 'https://tsim.tech/a.png', 'data:image/png;base64,AAAA', 'file:///tmp/a.png', 'javascript:alert(1)', '//media.ctrip.com/a.png']) assert.equal(viewerImageUrl(url), null, url);
});
test('zoom, rotation, bounded panning and keyboard reset work without writing or sending', () => {
  const f = fixture(); assert.equal(f.open(), true);
  for (let i = 0; i < 30; i++) f.controller.zoom(1.25); assert.equal(f.state?.zoom, 4);
  for (let i = 0; i < 60; i++) f.controller.zoom(.8); assert.equal(f.state?.zoom, .25);
  f.controller.zoom(NaN); assert.equal(f.state?.zoom, .25);
  f.controller.rotate(-1); assert.equal(f.state?.rotation, 270); f.controller.rotate(); assert.equal(f.state?.rotation, 0);
  f.controller.move(1e9, -1e9); assert.equal(f.state?.x, 4000); assert.equal(f.state?.y, -4000);
  let prevented = 0; const key = (value: string) => f.controller.key({ key: value, preventDefault() { prevented++; } });
  key('0'); assert.equal(f.state?.zoom, 1); assert.equal(f.state?.x, 0); key('+'); assert.equal(f.state?.zoom, 1.25); key('R'); assert.equal(f.state?.rotation, 270);
  assert.equal(key('toString'), false); assert.equal(key('Enter'), false); key('Escape'); assert.equal(f.state, null); assert.equal(prevented, 4);
});
test('exact account, room and service scope fences stale images and clears current resources', () => {
  for (const scope of [null, { ...image, account: { ...account, environment: 'other' } }, { ...image, account: { ...account, account_id: 'b' } }, { ...image, account: { ...account, session_generation: 2 } }, { ...image, gid: 'other' }, { ...image, revision: 'service-2' }]) {
    const f = fixture(); f.open(); f.scope(scope); f.controller.sync(); assert.equal(f.state, null); assert.equal(f.open(), false);
  }
  const f = fixture(); assert.equal(f.open({ ...image, url: 'https://evil.invalid/a.png' }), false); assert.equal(f.state, null);
});
test('native save is explicit, single flight, original-only and reports cancellation without success', async () => {
  const pending = deferred(), calls: ViewerImage[] = [], f = fixture(async value => { calls.push(value); return pending.promise; });
  f.open(); await f.controller.save(); assert.equal(calls.length, 0, 'loading image cannot be saved');
  f.controller.loaded(f.state!.visit); f.controller.zoom(2); f.controller.rotate();
  const saving = f.controller.save(); await f.controller.save(); assert.equal(calls.length, 1); assert.deepEqual(calls[0], image);
  pending.resolve('cancelled'); await saving; assert.equal(f.state?.saving, false); assert.equal(f.state?.saved, false); assert.equal(f.state?.error, null);
  const unsaved = fixture(async () => 'saved'); unsaved.open({ ...image, messageId: null }); unsaved.controller.loaded(unsaved.state!.visit); assert.equal(unsaved.controller.canSave(), false); await unsaved.controller.save(); assert.equal(unsaved.state?.saved, false);
});
test('save failures are retryable and late save/image callbacks cannot affect a closed or reopened viewer', async () => {
  let attempts = 0; const f = fixture(async () => { if (++attempts === 1) throw new Error('private backend detail'); return 'saved'; });
  f.open(); f.controller.loaded(f.state!.visit); await f.controller.save(); assert.ok(f.state?.error); await f.controller.save(); assert.equal(f.state?.saved, true); assert.equal(f.state?.error, null);
  for (const reject of [false, true]) {
    const pending = deferred(), late = fixture(async () => pending.promise); late.open(); const oldVisit = late.state!.visit; late.controller.loaded(oldVisit);
    const saving = late.controller.save(); late.controller.close(); late.open({ ...image, messageId: 'new-image' }); const fresh = late.state;
    late.controller.loaded(oldVisit, true); if (reject) pending.reject(new Error('old failure')); else pending.resolve('saved'); await saving;
    assert.equal(late.state, fresh);
  }
});
test('viewer renders a keyboard modal and reuses the original image across zoom with original-save explicitly unavailable', () => {
  const { root } = installFakeDom(), f = fixture(); f.open();
  const draw = () => rerender(root as unknown as Element, () => imageViewerView(f.state, f.controller)!, { morph: true });
  draw(); const img = root.querySelector('img')!, close = root.querySelector('button[aria-label="关闭图片查看器"]')!;
  close.focus(); resetCounters(); f.controller.zoom(2); draw();
  assert.equal(root.querySelector('img'), img); assert.equal(fakeDocument.activeElement, close); assert.equal(readCounters().detached, 0);
  assert.equal(img.getAttribute('src'), image.url); assert.equal(img.getAttribute('referrerpolicy'), 'no-referrer');
  assert.equal(root.querySelector('section')?.getAttribute('aria-modal'), 'true');
  const save = root.querySelectorAll('button').find(button => button.textContent === '另存原图'); assert.equal(save?.disabled, true); assert.equal(save?.getAttribute('title'), '图片另存为尚未接入');
  f.controller.close(); assert.equal(imageViewerView(f.state, f.controller), null);
});

test('drag panning belongs to one pointer and a closing scope cannot retain the drag', () => {
  const f = fixture(); f.open(); const captured: number[] = [];
  const event = (pointerId: number, clientX: number, clientY: number) => ({ pointerId, clientX, clientY, button: 0, currentTarget: { setPointerCapture: (id: number) => captured.push(id) }, preventDefault() {} }) as unknown as PointerEvent;
  f.controller.pointerDown(event(3, 10, 10)); f.controller.pointerMove(event(4, 70, 80)); assert.equal(f.state?.x, 0);
  f.controller.pointerMove(event(3, 70, 80)); assert.equal(f.state?.x, 60); assert.equal(f.state?.y, 70); assert.deepEqual(captured, [3]);
  f.controller.close(); f.open(); f.controller.pointerMove(event(3, 100, 100)); assert.equal(f.state?.x, 0);
});


test('preview-only images remain viewable but cannot invoke original-image saving', async () => {
  const calls: ViewerImage[] = [], f = fixture(async value => { calls.push(value); return 'saved'; });
  assert.equal(f.open({ ...image, originalAvailable: false }), true); f.controller.loaded(f.state!.visit);
  f.controller.zoom(2); f.controller.rotate();
  assert.equal(f.controller.canSave(), false); await f.controller.save(); assert.deepEqual(calls, []); assert.equal(f.state?.saved, false);
  const { root } = installFakeDom(); rerender(root as unknown as Element, () => imageViewerView(f.state, f.controller)!);
  const save = root.querySelectorAll('button').find(button => button.textContent === '另存原图');
  assert.equal(save?.disabled, true); assert.equal(save?.getAttribute('title'), '此消息仅有预览图，暂不能另存原图');
  assert.equal(root.querySelector('img')?.getAttribute('src'), image.url);
  f.controller.close(); f.open({ ...image, originalAvailable: true }); f.controller.loaded(f.state!.visit);
  assert.equal(f.controller.canSave(), true); await f.controller.save(); assert.equal(calls.length, 1); assert.equal(f.state?.saved, true);
});

test('localized viewer controls preserve accessible copy, scale and keyboard help', () => {
  const { root } = installFakeDom(), f = fixture(async () => 'saved');
  f.open({ ...image, name: '' });
  const draw = () => rerender(root as unknown as Element, () => imageViewerView(f.state, f.controller)!);
  draw();
  assert.equal(root.querySelector('section')?.getAttribute('aria-label'), '图片查看器');
  assert.equal(root.querySelector('[class="image-viewer-name"]')?.textContent, '图片');
  assert.equal(root.querySelector('img')?.getAttribute('alt'), '会话图片');
  assert.deepEqual(root.querySelectorAll('button').map(button => button.textContent), ['缩小', '放大', '向左旋转', '向右旋转', '重置', '另存原图', '关闭图片查看器']);
  assert.equal(root.querySelector('[class="image-viewer-scale"]')?.textContent, '100%');
  assert.equal(root.querySelector('[class="image-viewer-footer"]')?.textContent, '正在加载图片…');
  f.controller.loaded(f.state!.visit); f.controller.zoom(1.25); draw();
  assert.equal(root.querySelector('[class="image-viewer-scale"]')?.textContent, '125%');
  assert.equal(root.querySelector('[class="image-viewer-footer"]')?.textContent, '拖动平移 · + / − 缩放 · R 旋转 · 0 重置 · Esc 关闭');
  f.controller.close();
});

test('localized save failure never reflects backend details and load failure remains distinct', async () => {
  const { root } = installFakeDom(), f = fixture(async () => { throw new Error('secret /private/image.png <script>'); });
  f.open(); f.controller.loaded(f.state!.visit); await f.controller.save();
  rerender(root as unknown as Element, () => imageViewerView(f.state, f.controller)!);
  assert.equal(root.querySelector('[role="alert"]')?.textContent, '图片未能保存，请重试。');
  assert.equal(root.textContent.includes('secret'), false); assert.equal(root.textContent.includes('/private/image.png'), false);
  f.controller.loaded(f.state!.visit, true);
  assert.equal(f.state?.error, '图片加载失败，请关闭后重试。');
  f.controller.close();
});
