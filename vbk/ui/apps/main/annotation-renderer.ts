import { ANNOTATION_MAX_PNG_BYTES, type Annotation } from '../../packages/ipc/src/annotation.ts';
export interface SourceSize { readonly width: number; readonly height: number }
export interface SourcePoint { readonly x: number; readonly y: number }
export function sourcePoint(clientX: number, clientY: number, box: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>, source: SourceSize, inset = 0): SourcePoint {
  if (![clientX, clientY, box.left, box.top, box.width, box.height, source.width, source.height].every(Number.isFinite) || box.width <= 0 || box.height <= 0) throw new Error('ANNOTATION_COORDINATES_INVALID');
  inset = Math.max(0, Math.min(inset, (source.width - 1) / 2, (source.height - 1) / 2));
  return { x: Math.max(inset, Math.min(source.width - inset, (clientX - box.left) * source.width / box.width)), y: Math.max(inset, Math.min(source.height - inset, (clientY - box.top) * source.height / box.height)) };
}
export function validateAnnotation(annotation: Annotation, size: SourceSize): void {
  const point = (p: SourcePoint, margin = 0) => Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= margin && p.y >= margin && p.x <= size.width - margin && p.y <= size.height - margin;
  const rgba = (c: { red: number; green: number; blue: number; alpha: number }) => [c.red, c.green, c.blue, c.alpha].every(v => Number.isInteger(v) && v >= 0 && v <= 255) && c.alpha > 0;
  if ('stroke' in annotation && (!Number.isFinite(annotation.stroke.width) || annotation.stroke.width < .5 || annotation.stroke.width > 128 || !rgba(annotation.stroke.color))) throw new Error('ANNOTATION_STROKE_INVALID');
  if ('bounds' in annotation) { const b = annotation.bounds, margin = 'stroke' in annotation ? annotation.stroke.width / 2 : 0; if (!Number.isFinite(b.width) || !Number.isFinite(b.height) || b.width <= 0 || b.height <= 0 || !point(b, margin) || !point({ x: b.x + b.width, y: b.y + b.height }, margin)) throw new Error('ANNOTATION_BOUNDS_INVALID'); }
  if (annotation.type === 'pen' && (!annotation.points.length || annotation.points.length > 4096 || annotation.points.some(p => !point(p, annotation.stroke.width / 2)))) throw new Error('ANNOTATION_PEN_LIMIT');
  if (annotation.type === 'arrow') {
    const { from, to, head_length: head, stroke } = annotation, length = Math.hypot(to.x - from.x, to.y - from.y);
    if (!Number.isFinite(head) || head < 1 || head > length || !length) throw new Error('ANNOTATION_ARROW_SIZE_INVALID');
    const ux = (to.x - from.x) / length, uy = (to.y - from.y) / length, bx = to.x - ux * head, by = to.y - uy * head;
    if (![from, to, { x: bx + uy * head / 2, y: by - ux * head / 2 }, { x: bx - uy * head / 2, y: by + ux * head / 2 }].every(p => point(p, stroke.width / 2))) throw new Error('ANNOTATION_ARROW_BOUNDS_INVALID');
  }
  if (annotation.type === 'text' && (!annotation.text.trim() || new TextEncoder().encode(annotation.text).length > 4096 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(annotation.text) || !rgba(annotation.color) || !Number.isFinite(annotation.font_size) || annotation.font_size < 4 || annotation.font_size > 512)) throw new Error('ANNOTATION_TEXT_INVALID');
  if (annotation.type === 'mosaic' && (!Number.isInteger(annotation.block_size) || annotation.block_size < 2 || annotation.block_size > 128)) throw new Error('ANNOTATION_MOSAIC_SIZE_INVALID');
}
function color(value: { red: number; green: number; blue: number; alpha: number }): string { return `rgba(${value.red},${value.green},${value.blue},${value.alpha / 255})`; }
/** Every redraw starts from the immutable decoded local source, then applies the edit list. */
export function renderAnnotations(ctx: CanvasRenderingContext2D, source: CanvasImageSource, size: SourceSize, annotations: readonly Annotation[]): void {
  for (const annotation of annotations) validateAnnotation(annotation, size);
  ctx.save();
  try {
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, size.width, size.height); ctx.drawImage(source, 0, 0, size.width, size.height);
    for (const annotation of annotations) {
      ctx.save();
      try {
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        if ('stroke' in annotation) { ctx.strokeStyle = color(annotation.stroke.color); ctx.fillStyle = color(annotation.stroke.color); ctx.lineWidth = annotation.stroke.width; }
        switch (annotation.type) {
          case 'rectangle': ctx.strokeRect(annotation.bounds.x, annotation.bounds.y, annotation.bounds.width, annotation.bounds.height); break;
          case 'ellipse': ctx.beginPath(); ctx.ellipse(annotation.bounds.x + annotation.bounds.width / 2, annotation.bounds.y + annotation.bounds.height / 2, annotation.bounds.width / 2, annotation.bounds.height / 2, 0, 0, Math.PI * 2); ctx.stroke(); break;
          case 'pen': {
            if (!annotation.points.length) throw new Error('ANNOTATION_PEN_EMPTY');
            const first = annotation.points[0]!; ctx.beginPath();
            if (annotation.points.length === 1) { ctx.arc(first.x, first.y, annotation.stroke.width / 2, 0, Math.PI * 2); ctx.fill(); }
            else { ctx.moveTo(first.x, first.y); for (const point of annotation.points.slice(1)) ctx.lineTo(point.x, point.y); ctx.stroke(); }
            break;
          }
          case 'arrow': {
            const { from, to, head_length: head } = annotation, length = Math.hypot(to.x - from.x, to.y - from.y);
            if (!length || head < 1 || head > length) throw new Error('ANNOTATION_ARROW_SIZE_INVALID');
            const ux = (to.x - from.x) / length, uy = (to.y - from.y) / length, bx = to.x - ux * head, by = to.y - uy * head;
            ctx.beginPath(); ctx.moveTo(from.x, from.y); ctx.lineTo(to.x, to.y); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(to.x, to.y); ctx.lineTo(bx + uy * head / 2, by - ux * head / 2); ctx.lineTo(bx - uy * head / 2, by + ux * head / 2); ctx.closePath(); ctx.fill(); ctx.stroke(); break;
          }
          case 'text': {
            const { bounds, font_size: font } = annotation; ctx.beginPath(); ctx.rect(bounds.x, bounds.y, bounds.width, bounds.height); ctx.clip();
            ctx.fillStyle = color(annotation.color); ctx.font = `${font}px sans-serif`; ctx.textBaseline = 'top';
            annotation.text.split('\n').forEach((line, i) => ctx.fillText(line.replaceAll('\t', '    '), bounds.x, bounds.y + i * font * 1.25)); break;
          }
          case 'mosaic': {
            const { bounds, block_size: block } = annotation;
            if (!Number.isInteger(block) || block < 2 || block > 128) throw new Error('ANNOTATION_MOSAIC_SIZE_INVALID');
            const x = Math.floor(bounds.x), y = Math.floor(bounds.y), width = Math.min(size.width, Math.ceil(bounds.x + bounds.width)) - x, height = Math.min(size.height, Math.ceil(bounds.y + bounds.height)) - y;
            // Expand to whole source pixels. putImageData bypasses antialiased clipping
            // and compositing, so no original edge pixels or transparent seams survive.
            const image = ctx.getImageData(x, y, width, height), pixels = image.data;
            if (pixels.length !== width * height * 4) throw new Error('ANNOTATION_MOSAIC_READ_FAILED');
            for (let row = 0; row < height; row += block) for (let col = 0; col < width; col += block) {
              const right = Math.min(width, col + block), bottom = Math.min(height, row + block), total = (right - col) * (bottom - row), sums = [0, 0, 0, 0];
              for (let py = row; py < bottom; py++) for (let px = col; px < right; px++) { const index = (py * width + px) * 4; sums[0]! += pixels[index]!; sums[1]! += pixels[index + 1]!; sums[2]! += pixels[index + 2]!; sums[3]! += pixels[index + 3]!; }
              const average = sums.map(sum => Math.round(sum / total));
              for (let py = row; py < bottom; py++) for (let px = col; px < right; px++) { const index = (py * width + px) * 4; pixels[index] = average[0]!; pixels[index + 1] = average[1]!; pixels[index + 2] = average[2]!; pixels[index + 3] = average[3]!; }
            }
            ctx.putImageData(image, x, y);
            break;
          }
          default: throw new Error('ANNOTATION_TOOL_UNSUPPORTED');
        }
      } finally { ctx.restore(); }
    }
  } finally { ctx.restore(); }
}
export async function exportAnnotationPng(canvas: HTMLCanvasElement): Promise<string> {
  const blob = await new Promise<Blob>((resolve, reject) => { try { canvas.toBlob(value => value ? resolve(value) : reject(new Error('ANNOTATION_EXPORT_FAILED')), 'image/png'); } catch (error) { reject(error); } });
  if (blob.type !== 'image/png' || blob.size === 0 || blob.size > ANNOTATION_MAX_PNG_BYTES) throw new Error('ANNOTATION_EXPORT_INVALID');
  const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('ANNOTATION_ENCODING_FAILED')); reader.onerror = () => reject(new Error('ANNOTATION_ENCODING_FAILED')); reader.readAsDataURL(blob); });
  const prefix = 'data:image/png;base64,';
  if (!data.startsWith(prefix)) throw new Error('ANNOTATION_ENCODING_INVALID');
  return data.slice(prefix.length);
}
