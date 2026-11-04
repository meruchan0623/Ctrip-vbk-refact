import { t } from '../../packages/ui-kit/src/i18n.ts';
import type { AccountContext } from '../../packages/ipc/src/contracts.ts';
import { h } from '../../packages/ui-kit/src/h.ts';

export interface ImageViewerScope { readonly account: AccountContext; readonly gid: string; readonly revision?: string }
export interface ViewerImage extends ImageViewerScope { readonly messageId: string | null; readonly url: string; readonly name: string; readonly originalAvailable?: boolean }
export interface ImageViewerState {
  readonly image: ViewerImage;
  readonly visit: number;
  readonly zoom: number;
  readonly rotation: number;
  readonly x: number;
  readonly y: number;
  readonly loading: boolean;
  readonly loadFailed: boolean;
  readonly saving: boolean;
  readonly saved: boolean;
  readonly error: string | null;
}
const ownerKey = (scope: ImageViewerScope) => JSON.stringify([scope.account.environment, scope.account.account_id, scope.account.session_generation, scope.gid, scope.revision ?? '']);
/** Intersection of the existing main img-src CSP and shell official-host policy. */
export function viewerImageUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    if (!['c-ctrip.com', 'tripcdn.com', 'ctrip.com'].some(domain => url.hostname.endsWith(`.${domain}`) && url.hostname.length > domain.length + 1)) return null;
    return url.href;
  } catch { return null; }
}
export function createImageViewer(deps: {
  current(): ImageViewerScope | null;
  publish(state: ImageViewerState | null): void;
  /** Host-owned message resolution and native save dialog; never a browser download. */
  save?(image: ViewerImage): Promise<'saved' | 'cancelled'>;
}) {
  let state: ImageViewerState | null = null, visit = 0;
  let drag: { pointer: number; x: number; y: number } | null = null;
  function publish(next: ImageViewerState | null) { state = next; deps.publish(next); }
  function close() { visit++; drag = null; publish(null); }
  function current() {
    const scope = deps.current();
    return !!state && !!scope && ownerKey(state.image) === ownerKey(scope);
  }
  function sync() { if (state && !current()) close(); }
  function update(patch: Partial<ImageViewerState>) { if (!current()) { sync(); return; } publish({ ...state!, ...patch }); }
  function open(image: ViewerImage): boolean {
    const scope = deps.current(), url = viewerImageUrl(image.url);
    if (!scope || !url || ownerKey(scope) !== ownerKey(image)) return false;
    drag = null;
    publish({ image: { ...image, account: { ...image.account }, url }, visit: ++visit, zoom: 1, rotation: 0, x: 0, y: 0, loading: true, loadFailed: false, saving: false, saved: false, error: null });
    return true;
  }
  function zoom(factor: number) { if (state && Number.isFinite(factor) && factor > 0) update({ zoom: Math.max(.25, Math.min(4, Math.round(state.zoom * factor * 100) / 100)) }); }
  function rotate(direction = 1) { if (state) update({ rotation: (state.rotation + (direction < 0 ? 270 : 90)) % 360, x: 0, y: 0 }); }
  function reset() { update({ zoom: 1, rotation: 0, x: 0, y: 0 }); }
  function move(x: number, y: number) { if (state && Number.isFinite(x) && Number.isFinite(y)) update({ x: Math.max(-4000, Math.min(4000, state.x + x)), y: Math.max(-4000, Math.min(4000, state.y + y)) }); }
  function loaded(expected: number, failed = false) { if (state?.visit === expected) update({ loading: false, loadFailed: failed, error: failed ? t('mediaUi.imageViewer.loadFailed') : null }); }
  async function save() {
    if (!current() || !state || state.saving || !deps.save || !state.image.messageId?.trim() || state.image.originalAvailable === false || state.loading || state.loadFailed) return;
    const expected = state.visit, image = state.image;
    update({ saving: true, saved: false, error: null });
    try {
      const result = await deps.save(image);
      if (current() && state?.visit === expected) update({ saving: false, saved: result === 'saved', error: result === 'saved' || result === 'cancelled' ? null : t('mediaUi.imageViewer.saveUnknown') });
    } catch {
      if (current() && state?.visit === expected) update({ saving: false, error: t('mediaUi.imageViewer.saveFailed') });
    }
  }
  function key(event: Pick<KeyboardEvent, 'key' | 'preventDefault'>): boolean {
    if (!current()) { sync(); return false; }
    const actions: Record<string, () => void> = { Escape: close, '+': () => zoom(1.25), '=': () => zoom(1.25), '-': () => zoom(.8), '_': () => zoom(.8), r: () => rotate(), R: () => rotate(-1), '0': reset, ArrowLeft: () => move(-40, 0), ArrowRight: () => move(40, 0), ArrowUp: () => move(0, -40), ArrowDown: () => move(0, 40) };
    if (!Object.hasOwn(actions, event.key)) return false;
    event.preventDefault(); actions[event.key]!(); return true;
  }
  function pointerDown(event: PointerEvent) {
    if (!current() || event.button !== 0) return;
    drag = { pointer: event.pointerId, x: event.clientX, y: event.clientY };
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }
  function pointerMove(event: PointerEvent) {
    if (!drag || drag.pointer !== event.pointerId) return;
    move(event.clientX - drag.x, event.clientY - drag.y);
    if (drag) drag = { pointer: event.pointerId, x: event.clientX, y: event.clientY };
  }
  return { open, close, sync, zoom, rotate, reset, move, loaded, save, key, pointerDown, pointerMove, pointerUp: () => { drag = null; }, canSave: () => !!deps.save && !!state?.image.messageId?.trim() && state.image.originalAvailable !== false, matches: (candidate: ImageViewerState) => current() && candidate.visit === state?.visit };
}
export function imageViewerView(state: ImageViewerState | null, controller: ReturnType<typeof createImageViewer>): HTMLElement | null {
  if (!state || !controller.matches(state)) return null;
  const button = (label: string, action: () => void, disabled = false) => h('button', { class: 'btn', type: 'button', 'aria-label': label, title: label, disabled, onclick: action }, label);
  return h('div', { class: 'image-viewer-shade', onclick: controller.close }, h('section', {
    class: 'image-viewer', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('mediaUi.imageViewer.dialog'), tabindex: '-1', dataset: { imageViewerDialog: '1' }, onclick: (event: Event) => event.stopPropagation(),
    onkeydown: (event: KeyboardEvent) => {
      event.stopPropagation();
      if (controller.key(event) || event.key !== 'Tab') return;
      const dialog = event.currentTarget as HTMLElement, buttons = [...dialog.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
      if (!buttons.length) { event.preventDefault(); return; }
      const active = dialog.ownerDocument.activeElement;
      if (event.shiftKey && (active === buttons[0] || active === dialog)) { event.preventDefault(); buttons.at(-1)!.focus(); }
      else if (!event.shiftKey && (active === buttons.at(-1) || active === dialog)) { event.preventDefault(); buttons[0]!.focus(); }
    },
  },
  h('header', { class: 'image-viewer-toolbar' }, h('span', { class: 'image-viewer-name' }, state.image.name || t('mediaUi.imageViewer.image')),
    button(t('mediaUi.imageViewer.zoomOut'), () => controller.zoom(.8), state.zoom <= .25), h('span', { class: 'image-viewer-scale', role: 'status' }, t('mediaUi.imageViewer.scale', { percent: Math.round(state.zoom * 100) })), button(t('mediaUi.imageViewer.zoomIn'), () => controller.zoom(1.25), state.zoom >= 4),
    button(t('mediaUi.imageViewer.rotateLeft'), () => controller.rotate(-1)), button(t('mediaUi.imageViewer.rotateRight'), () => controller.rotate()), button(t('mediaUi.imageViewer.reset'), controller.reset),
    h('button', { class: 'btn', type: 'button', disabled: !controller.canSave() || state.loading || state.saving || state.loadFailed, title: state.image.originalAvailable === false ? t('mediaUi.imageViewer.previewOnly') : controller.canSave() ? t('mediaUi.imageViewer.saveOriginalTitle') : state.image.messageId ? t('mediaUi.imageViewer.saveUnavailable') : t('mediaUi.imageViewer.missingMessageId'), onclick: () => void controller.save() }, state.saving ? t('mediaUi.imageViewer.saving') : t('mediaUi.imageViewer.saveOriginal')), button(t('mediaUi.imageViewer.close'), controller.close)),
  h('div', { class: 'image-viewer-stage', onpointerdown: controller.pointerDown, onpointermove: controller.pointerMove, onpointerup: controller.pointerUp, onpointercancel: controller.pointerUp },
    h('img', { src: state.image.url, alt: state.image.name || t('mediaUi.imageViewer.imageAlt'), referrerpolicy: 'no-referrer', draggable: false, style: { transform: `translate(${state.x}px, ${state.y}px) rotate(${state.rotation}deg) scale(${state.zoom})` }, onload: () => controller.loaded(state.visit), onerror: () => controller.loaded(state.visit, true) })),
  h('footer', { class: 'image-viewer-footer' }, state.error ? h('span', { role: 'alert' }, state.error) : state.loading ? h('span', { role: 'status' }, t('mediaUi.imageViewer.loading')) : state.saved ? h('span', { role: 'status' }, t('mediaUi.imageViewer.saved')) : h('span', null, t('mediaUi.imageViewer.keys')))));
}
