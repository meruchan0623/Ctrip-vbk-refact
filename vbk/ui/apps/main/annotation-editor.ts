import { t } from '../../packages/ui-kit/src/i18n.ts';
import { ANNOTATION_MAX_DIMENSION, ANNOTATION_MAX_PIXELS, ANNOTATION_MAX_PNG_BYTES, ANNOTATION_MAX_SHAPES, type Annotation, type AnnotationSource, type AnnotationPoint } from '../../packages/ipc/src/annotation.ts';
import type { AccountContext } from '../../packages/ipc/src/contracts.ts';
import type { UiAttachment } from '../../packages/ipc/src/client.ts';
import { renderAnnotations, exportAnnotationPng, sourcePoint, validateAnnotation, type SourceSize } from './annotation-renderer.ts';
export interface AnnotationOwner { readonly account: AccountContext; readonly gid: string; readonly revision: string; readonly draftVersion: number; readonly operationToken: object }
export interface AnnotationApply { readonly attachment: UiAttachment; readonly owner: AnnotationOwner; readonly source: AnnotationSource; readonly annotations: readonly Annotation[]; readonly png_base64: string; readonly width: number; readonly height: number }
const ownerKey = (value: AnnotationOwner) => JSON.stringify([value.account.environment, value.account.account_id, value.account.session_generation, value.gid, value.revision, value.draftVersion]);
export function sameAnnotationOwner(a: AnnotationOwner, b: AnnotationOwner | null): boolean { return !!b && a.operationToken === b.operationToken && ownerKey(a) === ownerKey(b); }
export function createAnnotationHistory(size: SourceSize) {
  let entries: Annotation[] = [], redo: Annotation[] = [], floor = 0;
  function add(annotation: Annotation) {
    validateAnnotation(annotation, size);
    const next = [...entries, structuredClone(annotation)];
    const points = next.reduce((n, shape) => n + (shape.type === 'pen' ? shape.points.length : 0), 0);
    const text = next.reduce((n, shape) => n + (shape.type === 'text' ? new TextEncoder().encode(shape.text).length : 0), 0);
    if (next.length > ANNOTATION_MAX_SHAPES || points > 32768 || text > 256 * 1024 || JSON.stringify(next).length * 2 > 2 * 1024 * 1024) throw new Error('ANNOTATION_HISTORY_LIMIT');
    entries = next; redo = []; floor = Math.max(floor, entries.length - 256);
  }
  return { add, list: () => entries as readonly Annotation[], undo: () => { if (entries.length > floor) redo.push(entries.pop()!); }, redo: () => { const value = redo.pop(); if (value) entries.push(value); }, canUndo: () => entries.length > floor, canRedo: () => redo.length > 0, clear: () => { entries = []; redo = []; floor = 0; } };
}
async function decodeSource(source: AnnotationSource): Promise<HTMLImageElement> {
  if (source.mime !== 'image/png' || !/^[a-f0-9]{64}$/i.test(source.source_hash) || !Number.isInteger(source.width) || !Number.isInteger(source.height) || source.width < 1 || source.height < 1 || source.width > ANNOTATION_MAX_DIMENSION || source.height > ANNOTATION_MAX_DIMENSION || source.width * source.height > ANNOTATION_MAX_PIXELS || source.data_base64.length > Math.ceil(ANNOTATION_MAX_PNG_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(source.data_base64)) throw new Error('ANNOTATION_SOURCE_INVALID');
  const image = new Image();
  await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error('ANNOTATION_SOURCE_DECODE_FAILED')); image.src = `data:image/png;base64,${source.data_base64}`; });
  if (image.naturalWidth !== source.width || image.naturalHeight !== source.height) { image.src = ''; throw new Error('ANNOTATION_SOURCE_SIZE_MISMATCH'); }
  return image;
}
type Tool = Annotation['type'];
export function createAnnotationEditor(deps: {
  current(): AnnotationOwner | null;
  source(attachment: UiAttachment, owner: AnnotationOwner): Promise<AnnotationSource>;
  apply(request: AnnotationApply): Promise<UiAttachment>;
  release(attachment: UiAttachment): Promise<void>;
  publish(node: HTMLElement | null): void;
  onConfirm(attachment: UiAttachment, original: UiAttachment, owner: AnnotationOwner): boolean | void | Promise<boolean | void>;
  /** Synchronous final owner check and transfer after asynchronous preparation. */
  onCommit?(attachment: UiAttachment, original: UiAttachment, owner: AnnotationOwner): boolean | void;
  onCancel?(original: UiAttachment, owner: AnnotationOwner): void;
  save?(attachment: UiAttachment): Promise<boolean>;
  decode?(source: AnnotationSource): Promise<HTMLImageElement>;
  encode?(canvas: HTMLCanvasElement): Promise<string>;
  createCanvas?(): HTMLCanvasElement;
}) {
  let session: { attachment: UiAttachment; owner: AnnotationOwner; source: AnnotationSource | null; image: HTMLImageElement | null; canvas: HTMLCanvasElement | null; history: ReturnType<typeof createAnnotationHistory> | null; node: HTMLElement | null; busy: boolean; status: HTMLElement | null; redraw: (() => void) | null; refresh: (() => void) | null; drag: { pointer: number; start: AnnotationPoint; points: AnnotationPoint[] } | null; frame: number | null } | null = null;
  function valid(s: NonNullable<typeof session>) { return session === s && sameAnnotationOwner(s.owner, deps.current()); }
  function dispose(s: NonNullable<typeof session>) {
    if (s.frame !== null) cancelAnimationFrame(s.frame);
    if (s.image) s.image.src = '';
    if (s.canvas) { s.canvas.width = 0; s.canvas.height = 0; }
    s.history?.clear(); s.image = null; s.source = null; s.drag = null; s.node = null; s.canvas = null; s.redraw = null; s.refresh = null;
  }
  function cancel() { const s = session; if (!s) return; session = null; dispose(s); deps.publish(null); deps.onCancel?.(s.attachment, s.owner); }
  function sync() { if (session && !valid(session)) cancel(); }
  function status(s: NonNullable<typeof session>, value: string, error = false) { if (s.status) { s.status.textContent = value; s.status.setAttribute('role', error ? 'alert' : 'status'); } }
  async function output(saveOnly: boolean): Promise<UiAttachment | null> {
    const s = session;
    if (!s || !valid(s) || s.busy || !s.source || !s.canvas || !s.history || s.drag) return null;
    s.busy = true; s.refresh?.(); status(s, saveOnly ? t('annotation.saving') : t('annotation.processing'));
    let derived: UiAttachment | null = null;
    try {
      s.redraw?.();
      const png = await (deps.encode ?? exportAnnotationPng)(s.canvas);
      if (!valid(s)) return null;
      derived = await deps.apply({ attachment: s.attachment, owner: s.owner, source: s.source, annotations: s.history.list(), png_base64: png, width: s.source.width, height: s.source.height });
      if (!valid(s)) { const stale = derived; derived = null; await deps.release(stale); return null; }
      if (saveOnly) {
        if (!deps.save) throw new Error('ANNOTATION_SAVE_UNAVAILABLE');
        const saved = await deps.save(derived);
        if (valid(s)) status(s, saved ? t('annotation.saved') : t('annotation.saveCancelled'));
        return null;
      }
      const accepted = await deps.onConfirm(derived, s.attachment, s.owner);
      if (accepted === false) return null;
      if (!valid(s)) { if (session === s) cancel(); return null; }
      session = null; dispose(s); deps.publish(null);
      if (deps.onCommit?.(derived, s.attachment, s.owner) === false) return null;
      const result = derived; derived = null; return result;
    } catch { if (valid(s)) status(s, t('annotation.processingFailed'), true); return null; }
    finally {
      if (derived) { const temporary = derived; derived = null; await deps.release(temporary); }
      if (valid(s)) { s.busy = false; s.refresh?.(); }
    }
  }
  async function open(attachment: UiAttachment, owner: AnnotationOwner): Promise<boolean> {
    if (!sameAnnotationOwner(owner, deps.current()) || attachment.kind !== 'image' || attachment.mime !== 'image/png' || attachment.owner.gid !== owner.gid || JSON.stringify([attachment.owner.account.environment, attachment.owner.account.account_id, attachment.owner.account.session_generation]) !== JSON.stringify([owner.account.environment, owner.account.account_id, owner.account.session_generation])) return false;
    cancel();
    const s: NonNullable<typeof session> = { attachment, owner, source: null, image: null, canvas: null, history: null, node: null, busy: false, status: null, redraw: null, refresh: null, drag: null, frame: null }; session = s;
    const node = document.createElement('section'); node.setAttribute('class', 'annotation-editor-shade'); node.setAttribute('role', 'dialog'); node.setAttribute('aria-modal', 'true'); node.setAttribute('aria-label', t('annotation.dialog')); node.tabIndex = -1; s.node = node;
    const toolbar = document.createElement('div'); toolbar.setAttribute('class', 'annotation-toolbar'); node.appendChild(toolbar);
    const body = document.createElement('div'); body.setAttribute('class', 'annotation-stage'); node.appendChild(body);
    const message = document.createElement('p'); message.setAttribute('class', 'annotation-status'); message.setAttribute('role', 'status'); node.appendChild(message); s.status = message;
    let tool: Tool = 'rectangle', hex = '#e23b39';
    const buttons: HTMLButtonElement[] = [];
    const button = (text: string, action: () => void) => { const b = document.createElement('button'); b.setAttribute('type', 'button'); b.setAttribute('class', 'btn'); b.textContent = text; b.onclick = action; toolbar.appendChild(b); buttons.push(b); return b; };
    const tools: { key: Tool; label: string }[] = [{ key: 'rectangle', label: t('annotation.tool.rectangle') }, { key: 'ellipse', label: t('annotation.tool.ellipse') }, { key: 'arrow', label: t('annotation.tool.arrow') }, { key: 'text', label: t('annotation.tool.text') }, { key: 'pen', label: t('annotation.tool.pen') }, { key: 'mosaic', label: t('annotation.tool.mosaic') }];
    const toolButtons = tools.map(item => { const b = button(item.label, () => { tool = item.key; s.refresh?.(); }); b.setAttribute('data-annotation-tool', item.key); return b; });
    const picker = document.createElement('input'); picker.setAttribute('type', 'color'); picker.setAttribute('aria-label', t('annotation.color')); picker.value = hex; picker.oninput = () => { hex = picker.value; }; toolbar.appendChild(picker);
    const text = document.createElement('input'); text.setAttribute('type', 'text'); text.setAttribute('aria-label', t('annotation.text')); text.setAttribute('placeholder', t('annotation.textPlaceholder')); text.maxLength = 1024; toolbar.appendChild(text);
    const undo = button(t('annotation.undo'), () => { s.history?.undo(); redraw(); }), redo = button(t('annotation.redo'), () => { s.history?.redo(); redraw(); });
    const save = button(t('annotation.save'), () => void output(true));
    const confirm = button(t('annotation.confirm'), () => void output(false)); confirm.setAttribute('data-annotation-confirm', '1');
    const close = button(t('annotation.cancel'), cancel); close.setAttribute('data-annotation-cancel', '1');
    function refresh() { tools.forEach((item, i) => toolButtons[i]!.setAttribute('aria-pressed', String(tool === item.key))); buttons.forEach(b => { b.disabled = s.busy || !s.source; }); close.disabled = false; undo.disabled = s.busy || !s.history?.canUndo(); redo.disabled = s.busy || !s.history?.canRedo(); save.disabled = s.busy || !s.source || !deps.save; confirm.disabled = s.busy || !s.source || !!s.drag; picker.disabled = s.busy; text.disabled = s.busy; }
    function redraw(preview?: Annotation) {
      if (!valid(s) || !s.canvas || !s.image || !s.source || !s.history) return;
      const ctx = s.canvas.getContext('2d'); if (!ctx) throw new Error('ANNOTATION_CANVAS_UNAVAILABLE');
      renderAnnotations(ctx, s.image, s.source, preview ? [...s.history.list(), preview] : s.history.list()); refresh();
    }
    s.redraw = () => redraw(); s.refresh = refresh;
    node.onkeydown = event => {
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); cancel(); return; }
      if (event.key === 'Tab') { const focusable = [...node.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)')], active = document.activeElement; if (event.shiftKey && (active === focusable[0] || active === node)) { event.preventDefault(); focusable.at(-1)?.focus(); } else if (!event.shiftKey && (active === focusable.at(-1) || active === node)) { event.preventDefault(); focusable[0]?.focus(); } return; }
      if (event.target instanceof HTMLInputElement) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && !s.busy) { event.preventDefault(); if (event.shiftKey) s.history?.redo(); else s.history?.undo(); redraw(); }
    };
    node.onkeyup = event => event.stopPropagation();
    refresh(); status(s, t('annotation.loading')); deps.publish(node); node.focus();
    try {
      const source = await deps.source(attachment, owner); if (!valid(s)) return false;
      const image = await (deps.decode ?? decodeSource)(source); if (!valid(s)) { image.src = ''; return false; }
      s.source = source; s.image = image; s.history = createAnnotationHistory(source);
      const canvas = (deps.createCanvas ?? (() => document.createElement('canvas')))(); s.canvas = canvas; canvas.width = source.width; canvas.height = source.height; canvas.setAttribute('aria-label', t('annotation.canvas')); body.appendChild(canvas);
      const rgba = () => ({ red: parseInt(hex.slice(1, 3), 16), green: parseInt(hex.slice(3, 5), 16), blue: parseInt(hex.slice(5, 7), 16), alpha: 255 });
      const point = (event: PointerEvent) => sourcePoint(event.clientX, event.clientY, canvas.getBoundingClientRect(), source, tool === 'arrow' ? Math.min(16, source.width / 8, source.height / 8) : tool === 'mosaic' || tool === 'text' ? 0 : 2);
      const shape = (end: AnnotationPoint): Annotation | null => {
        const drag = s.drag; if (!drag) return null; const start = drag.start, bounds = { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(start.x - end.x), height: Math.abs(start.y - end.y) }, stroke = { color: rgba(), width: Math.min(4, source.width / 4, source.height / 4) };
        if (tool === 'pen') return { type: 'pen', points: drag.points, stroke };
        if (tool === 'arrow') { const length = Math.hypot(end.x - start.x, end.y - start.y); return length >= 3 ? { type: 'arrow', from: start, to: end, head_length: Math.min(24, length / 3, source.width / 8, source.height / 8), stroke } : null; }
        if (bounds.width < 2 || bounds.height < 2) return null;
        if (tool === 'text') return text.value.trim() ? { type: 'text', bounds, text: text.value, font_size: 24, color: rgba() } : null;
        if (tool === 'mosaic') return { type: 'mosaic', bounds, block_size: 12 };
        return { type: tool, bounds, stroke } as Annotation;
      };
      canvas.onpointerdown = event => { if (!valid(s) || s.busy || event.button !== 0) return; event.preventDefault(); const start = point(event); s.drag = { pointer: event.pointerId, start, points: [start] }; canvas.setPointerCapture?.(event.pointerId); refresh(); };
      canvas.onpointermove = event => { if (!valid(s) || !s.drag || s.drag.pointer !== event.pointerId || s.busy) return; const end = point(event); if (tool === 'pen' && s.drag.points.length < 4096 && Math.hypot(end.x - s.drag.points.at(-1)!.x, end.y - s.drag.points.at(-1)!.y) >= 1) s.drag.points.push(end); if (s.frame !== null) cancelAnimationFrame(s.frame); s.frame = requestAnimationFrame(() => { s.frame = null; try { const preview = shape(end); if (preview) redraw(preview); } catch { status(s, t('annotation.previewInvalid'), true); } }); };
      canvas.onpointerup = event => { if (!valid(s) || !s.drag || s.drag.pointer !== event.pointerId) return; if (s.frame !== null) { cancelAnimationFrame(s.frame); s.frame = null; } try { const next = shape(point(event)); if (next) s.history!.add(next); status(s, t('annotation.draftOnly')); } catch { status(s, t('annotation.geometryInvalid'), true); } finally { s.drag = null; redraw(); } };
      canvas.onpointercancel = () => { s.drag = null; if (s.frame !== null) { cancelAnimationFrame(s.frame); s.frame = null; } redraw(); };
      redraw(); status(s, t('annotation.draftOnly')); return true;
    } catch { if (valid(s)) status(s, t('annotation.loadFailed'), true); return false; }
  }
  return { open, confirm: () => output(false), save: () => output(true), cancel, sync, active: () => session !== null };
}
