import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAnnotationEditor, createAnnotationHistory, sameAnnotationOwner, type AnnotationApply, type AnnotationOwner } from './annotation-editor.ts';
import { installFakeDom, fakeDocument } from '../../tests/fake-dom.ts';
import type { UiAttachment } from '../../packages/ipc/src/client.ts';
const account = { account_id: 'a', environment: 'synthetic', session_generation: 1 }, token = {};
const owner: AnnotationOwner = { account, gid: '123456', revision: 'service-1', draftVersion: 3, operationToken: token };
const original: UiAttachment = { attachment_id: 'source', name: 'source.png', kind: 'image', mime: 'image/png', size: 8, content_sha256: 'a'.repeat(64), owner: { account, gid: owner.gid }, supported: true };
const derived: UiAttachment = { ...original, attachment_id: 'derived', name: 'marked.png' };
const stroke = { color: { red: 255, green: 0, blue: 0, alpha: 255 }, width: 4 };
function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>(r => { resolve = r; }), resolve }; }
function fixture(options: { encodeFails?: boolean; apply?: Promise<UiAttachment>; prepare?: (value: UiAttachment) => Promise<boolean>; blockCommit?: boolean } = {}) {
  const { root } = installFakeDom(); let current: AnnotationOwner | null = owner, node: HTMLElement | null = null;
  const calls: AnnotationApply[] = [], released: UiAttachment[] = [], confirmed: UiAttachment[] = [], cancelled: UiAttachment[] = [], saved: UiAttachment[] = [];
  const context = new Proxy({}, { get: (_t, method) => (...args: any[]) => method === 'getImageData' ? { data: new Uint8ClampedArray(args[2] * args[3] * 4) } : undefined, set: () => true }) as CanvasRenderingContext2D;
  const canvas = fakeDocument.createElement('canvas') as any; canvas.getContext = () => context; canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 80 });
  const editor = createAnnotationEditor({ current: () => current, source: async () => ({ source_hash: 'a'.repeat(64), mime: 'image/png', width: 100, height: 80, data_base64: 'AAAA' }),
    decode: async () => ({ src: 'data:image/png;base64,AAAA', naturalWidth: 100, naturalHeight: 80 }) as HTMLImageElement,
    createCanvas: () => canvas, encode: async () => { if (options.encodeFails) throw new Error('secret-token /private/source.png <img src=x>'); return 'encoded-annotation'; },
    apply: async request => { calls.push(request); return options.apply ? await options.apply : derived; }, release: async value => { released.push(value); },
    publish: value => { node = value; root.replaceChildren(...value ? [value as any] : []); }, onConfirm: value => options.prepare ? options.prepare(value) : true, onCommit: value => { if (options.blockCommit) return false; confirmed.push(value); return true; }, onCancel: value => { cancelled.push(value); }, save: async value => { saved.push(value); return true; } });
  return { editor, calls, released, confirmed, cancelled, saved, canvas, root, node: () => node, current: (value: AnnotationOwner | null) => { current = value; } };
}
test('annotation history has bounded undo/redo and invalid edits preserve redo', () => {
  const history = createAnnotationHistory({ width: 100, height: 80 });
  history.add({ type: 'pen', points: [{ x: 10, y: 10 }], stroke }); history.undo(); assert.equal(history.canRedo(), true);
  assert.throws(() => history.add({ type: 'pen', points: [{ x: -1, y: 10 }], stroke })); assert.equal(history.canRedo(), true);
  history.redo(); assert.equal(history.list().length, 1); history.undo(); history.add({ type: 'pen', points: [{ x: 20, y: 20 }], stroke }); assert.equal(history.canRedo(), false);
  for (let i = 0; i < 300; i++) history.add({ type: 'pen', points: [{ x: 20, y: 20 }], stroke });
  for (let i = 0; i < 300; i++) history.undo(); assert.equal(history.list().length, 45); assert.equal(history.canUndo(), false);
  const paths = createAnnotationHistory({ width: 100, height: 80 });
  for (let i = 0; i < 8; i++) paths.add({ type: 'pen', points: Array.from({ length: 4096 }, () => ({ x: 20, y: 20 })), stroke });
  assert.throws(() => paths.add({ type: 'pen', points: [{ x: 20, y: 20 }], stroke }));
});
test('source ownership includes full account, revision, draft and operation identity', () => {
  assert.equal(sameAnnotationOwner(owner, { ...owner }), true);
  for (const next of [null, { ...owner, operationToken: {} }, { ...owner, draftVersion: 4 }, { ...owner, revision: 'service-2' }, { ...owner, gid: 'other' }, { ...owner, account: { ...account, environment: 'other' } }, { ...owner, account: { ...account, session_generation: 2 } }]) assert.equal(sameAnnotationOwner(owner, next), false);
});
test('all six tools edit one persistent local canvas and confirmation submits only the rendered derived PNG', async () => {
  const f = fixture(); assert.equal(await f.editor.open(original, owner), true);
  const node = f.node() as any; const text = f.root.querySelector('input[type="text"]')!; text.value = '本地文字';
  for (const tool of ['rectangle', 'ellipse', 'arrow', 'text', 'pen', 'mosaic']) {
    (f.root.querySelector(`[data-annotation-tool="${tool}"]`) as any).onclick();
    const event = (x: number, y: number) => ({ button: 0, pointerId: 1, clientX: x, clientY: y, preventDefault() {} });
    f.canvas.onpointerdown(event(20, 20)); f.canvas.onpointerup(event(60, 50)); assert.equal(f.node(), node);
  }
  assert.equal(await f.editor.confirm(), derived); assert.equal(f.calls.length, 1); assert.equal(f.calls[0]?.png_base64, 'encoded-annotation');
  assert.deepEqual(f.calls[0]?.annotations.map(a => a.type), ['rectangle', 'ellipse', 'arrow', 'text', 'pen', 'mosaic']);
  assert.deepEqual(f.confirmed, [derived]); assert.deepEqual(f.released, []); assert.deepEqual(f.cancelled, []); assert.equal(f.editor.active(), false); assert.equal(f.canvas.width, 0);
});
test('cancel and scope changes clean source canvas once; late APPLY is released rather than inserted', async () => {
  const pending = deferred<UiAttachment>(), f = fixture({ apply: pending.promise }); await f.editor.open(original, owner);
  const confirm = f.editor.confirm(); for (let i = 0; i < 5; i++) await Promise.resolve();
  f.current({ ...owner, operationToken: {} }); f.editor.sync(); f.editor.cancel();
  pending.resolve(derived); assert.equal(await confirm, null); assert.deepEqual(f.released, [derived]); assert.deepEqual(f.confirmed, []); assert.deepEqual(f.cancelled, [original]); assert.equal(f.canvas.width, 0);
});
test('export failure never applies unannotated source; save-only releases temporary derivative and keeps editing', async () => {
  const failed = fixture({ encodeFails: true }); await failed.editor.open(original, owner); assert.equal(await failed.editor.confirm(), null); assert.deepEqual(failed.calls, []); assert.equal(failed.editor.active(), true);
  const f = fixture(); await f.editor.open(original, owner); await f.editor.save(); assert.deepEqual(f.saved, [derived]); assert.deepEqual(f.released, [derived]); assert.deepEqual(f.confirmed, []); assert.equal(f.editor.active(), true);
});


test('asynchronous persisted preparation is fenced by cancellation and owner ABA before synchronous publication', async () => {
  for (const aba of [false, true]) {
    const pending = deferred<boolean>(), persisted: UiAttachment[] = [], f = fixture({ prepare: async value => { persisted.push(value); return pending.promise; } });
    await f.editor.open(original, owner); const confirming = f.editor.confirm(); for (let i = 0; i < 10; i++) await Promise.resolve();
    assert.equal(persisted.length, 1); assert.deepEqual(f.confirmed, []);
    f.current({ ...owner, operationToken: {} }); f.editor.sync(); if (aba) f.current(owner);
    pending.resolve(true); assert.equal(await confirming, null); assert.deepEqual(f.released, [derived]); assert.deepEqual(f.confirmed, []); assert.equal(persisted.length, 1, 'old-scope durable reference is not removed');
    assert.deepEqual(f.cancelled, [original]);
  }
});

test('prepared durable edit whose final publication is rejected releases only the new temporary derivative', async () => {
  const persisted: UiAttachment[] = [], f = fixture({ prepare: async value => { persisted.push(value); return true; }, blockCommit: true });
  await f.editor.open(original, owner); assert.equal(await f.editor.confirm(), null);
  assert.deepEqual(persisted, [derived]); assert.deepEqual(f.released, [derived]); assert.deepEqual(f.confirmed, []);
});


test('late annotation apply or persisted preparation cannot close a newer same-account room visit', async () => {
  for (const phase of ['apply', 'prepare'] as const) {
    const apply = deferred<UiAttachment>(), prepare = deferred<boolean>();
    const f = fixture(phase === 'apply' ? { apply: apply.promise } : { prepare: () => prepare.promise });
    await f.editor.open(original, owner);
    const oldConfirm = f.editor.confirm(); for (let i = 0; i < 8; i++) await Promise.resolve();
    f.current({ ...owner, account: { ...account, account_id: 'other' }, operationToken: {} }); f.editor.sync();
    const next = { ...owner, operationToken: {} }; f.current(next);
    await f.editor.open(original, next);
    if (phase === 'apply') apply.resolve(derived); else prepare.resolve(true);
    assert.equal(await oldConfirm, null);
    assert.equal(f.editor.active(), true, 'old completion cannot dismiss the replacement editor');
    assert.deepEqual(f.confirmed, []); assert.deepEqual(f.released, [derived]);
    f.editor.cancel();
  }
});


test('localized editor preserves labels, draft-only promise and accessible descriptions', async () => {
  const f = fixture(); await f.editor.open(original, owner);
  assert.equal(f.node()?.getAttribute('aria-label'), '截图标注');
  assert.deepEqual(f.root.querySelectorAll('button').map(button => button.textContent),
    ['矩形', '椭圆', '箭头', '文字', '画笔', '马赛克', '撤销', '重做', '另存为', '确认插入草稿', '取消']);
  assert.equal(f.root.querySelector('input[type="color"]')?.getAttribute('aria-label'), '标注颜色');
  const text = f.root.querySelector('input[type="text"]');
  assert.equal(text?.getAttribute('aria-label'), '标注文字');
  assert.equal(text?.getAttribute('placeholder'), '选择文字工具后拖出文字区域');
  assert.equal(f.canvas.getAttribute('aria-label'), '截图标注画布');
  assert.equal(f.root.querySelector('[class="annotation-status"]')?.textContent, '本地标注，确认后只插入草稿，不会自动发送');
  await f.editor.save();
  assert.equal(f.root.querySelector('[class="annotation-status"]')?.textContent, '标注图片已保存，尚未插入或发送');
  assert.deepEqual(f.confirmed, []); assert.equal(f.editor.active(), true); f.editor.cancel();
});

test('localized failure uses fixed copy without reflecting renderer or service details', async () => {
  const f = fixture({ encodeFails: true }); await f.editor.open(original, owner); await f.editor.confirm();
  const status = f.root.querySelector('[class="annotation-status"]');
  assert.equal(status?.textContent, '标注处理失败，未插入图片；请重试或取消。');
  assert.equal(status?.getAttribute('role'), 'alert');
  assert.equal(f.root.textContent.includes('secret-token'), false);
  assert.equal(f.root.textContent.includes('/private/source.png'), false);
  assert.equal(f.calls.length, 0); assert.equal(f.editor.active(), true); f.editor.cancel();
});
