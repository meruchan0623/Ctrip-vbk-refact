import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourcePoint, renderAnnotations, validateAnnotation, exportAnnotationPng } from './annotation-renderer.ts';
import type { Annotation } from '../../packages/ipc/src/annotation.ts';
const stroke = { color: { red: 200, green: 0, blue: 0, alpha: 255 }, width: 4 }, size = { width: 100, height: 80 };
function context(pixels = new Uint8ClampedArray()) {
  const calls: { method: string; args: any[] }[] = [], styles: Record<string, unknown> = {};
  const ctx = new Proxy({}, { get: (_t, key) => key in styles ? styles[String(key)] : (...args: any[]) => { calls.push({ method: String(key), args }); if (key === 'getImageData') return { data: pixels }; }, set: (_t, key, value) => { styles[String(key)] = value; calls.push({ method: `set:${String(key)}`, args: [value] }); return true; } }) as CanvasRenderingContext2D;
  return { ctx, calls, styles };
}
test('fit-to-source mapping uses the displayed canvas box and clamps centered strokes inside source', () => {
  assert.deepEqual(sourcePoint(60, 45, { left: 10, top: 5, width: 200, height: 160 }, size), { x: 25, y: 20 });
  assert.deepEqual(sourcePoint(-100, 1000, { left: 10, top: 5, width: 200, height: 160 }, size, 2), { x: 2, y: 78 });
  assert.throws(() => sourcePoint(NaN, 0, { left: 0, top: 0, width: 200, height: 160 }, size));
});
test('renderer draws all geometry with round strokes, model arrowhead and clipped text', () => {
  const f = context(), bounds = { x: 10, y: 10, width: 30, height: 30 };
  const annotations: Annotation[] = [{ type: 'rectangle', bounds, stroke }, { type: 'ellipse', bounds, stroke }, { type: 'pen', points: [{ x: 10, y: 20 }], stroke }, { type: 'pen', points: [{ x: 10, y: 20 }, { x: 20, y: 25 }], stroke }, { type: 'arrow', from: { x: 20, y: 20 }, to: { x: 60, y: 20 }, head_length: 10, stroke }, { type: 'text', bounds, text: 'first\nsecond', font_size: 12, color: stroke.color }];
  renderAnnotations(f.ctx, {} as CanvasImageSource, size, annotations);
  assert.ok(f.calls.some(c => c.method === 'arc' && c.args[2] === 2), 'single pen point is a round dot');
  assert.ok(f.calls.some(c => c.method === 'ellipse'));
  assert.ok(f.calls.some(c => c.method === 'lineTo' && c.args[0] === 50 && c.args[1] === 15));
  assert.ok(f.calls.some(c => c.method === 'lineTo' && c.args[0] === 50 && c.args[1] === 25));
  const clip = f.calls.findIndex(c => c.method === 'clip'), text = f.calls.findIndex(c => c.method === 'fillText'); assert.ok(clip < text);
  assert.equal(f.styles.lineCap, 'round'); assert.equal(f.styles.lineJoin, 'round');
});
test('mosaic reads actual pixels and replaces a source block with its average including transparency', () => {
  const f = context(new Uint8ClampedArray([0, 0, 0, 255, 200, 0, 0, 255, 0, 200, 0, 255, 0, 0, 200, 255]));
  renderAnnotations(f.ctx, {} as CanvasImageSource, { width: 2, height: 2 }, [{ type: 'mosaic', bounds: { x: 0, y: 0, width: 2, height: 2 }, block_size: 2 }]);
  assert.ok(f.calls.some(c => c.method === 'getImageData')); const write = f.calls.find(c => c.method === 'putImageData'); assert.ok(write);
  assert.deepEqual([...write.args[0].data], Array.from({ length: 4 }, () => [50, 50, 50, 255]).flat());
  assert.equal(f.calls.some(c => c.method === 'clip' || c.method === 'fillRect'), false);
});
test('invalid geometry rejects before any source draw and export failure never returns original bytes', async () => {
  const f = context();
  assert.throws(() => renderAnnotations(f.ctx, {} as CanvasImageSource, size, [{ type: 'rectangle', bounds: { x: 0, y: 0, width: 10, height: 10 }, stroke }]));
  assert.equal(f.calls.length, 0);
  assert.throws(() => validateAnnotation({ type: 'pen', points: [{ x: NaN, y: 10 }], stroke }, size));
  await assert.rejects(exportAnnotationPng({ toBlob(callback: BlobCallback) { callback(null); } } as HTMLCanvasElement), { message: 'ANNOTATION_EXPORT_FAILED' });
});


test('fractional mosaic bounds expand to whole source pixels and overwrite RGBA without antialias seams', () => {
  const f = context(new Uint8ClampedArray([0, 0, 0, 0, 200, 0, 0, 255, 0, 200, 0, 255, 0, 0, 200, 255]));
  renderAnnotations(f.ctx, {} as CanvasImageSource, { width: 3, height: 3 }, [{ type: 'mosaic', bounds: { x: .2, y: .3, width: 1.1, height: 1.1 }, block_size: 2 }]);
  assert.deepEqual(f.calls.find(c => c.method === 'getImageData')?.args, [0, 0, 2, 2]);
  const write = f.calls.find(c => c.method === 'putImageData'); assert.ok(write);
  assert.deepEqual(write.args.slice(1), [0, 0]); assert.deepEqual([...write.args[0].data], Array.from({ length: 4 }, () => [50, 50, 50, 191]).flat());
});
