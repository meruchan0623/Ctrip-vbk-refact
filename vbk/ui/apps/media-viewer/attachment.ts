import type { UiViewerAttachment, UiViewerGallery } from '../../packages/ipc/src/client.ts';
import { h } from '../../packages/ui-kit/src/h.ts';
import { safeMediaUrl } from '../main/viewmodel.ts';
import { MEDIA_VIEWER_STRINGS as S, fmt } from './strings.ts';

/** File names and URL paths are hints only; never embed an executable document. */
export function attachmentInfo(attachment: Pick<UiViewerAttachment, 'kind' | 'url' | 'name'>): { name: string; extension: string; kind: 'image' | 'video' | 'audio' | 'file' } {
  let path = '';
  try { path = decodeURIComponent(new URL(attachment.url).pathname.split('/').pop() ?? ''); } catch { /* Keep the supplied name. */ }
  const name = attachment.name.trim() || path || S.fallbackName;
  const extension = /\.([a-z0-9]{1,12})$/i.exec(name)?.[1]?.toLowerCase() ?? /\.([a-z0-9]{1,12})$/i.exec(path)?.[1]?.toLowerCase() ?? '';
  const kind = attachment.kind !== 'file' ? attachment.kind
    : /^(png|jpe?g|gif|webp|avif|bmp)$/.test(extension) ? 'image'
    : /^(mp4|webm|mov|m4v|ogv)$/.test(extension) ? 'video'
    : /^(mp3|m4a|wav|ogg|aac|flac)$/.test(extension) ? 'audio' : 'file';
  return { name, extension, kind };
}

export function isViewerAttachment(value: unknown): value is UiViewerAttachment {
  const a = value as UiViewerAttachment | null;
  return !!a && (a.kind === 'image' || a.kind === 'video' || a.kind === 'file') && typeof a.name === 'string' && !!safeMediaUrl(a.url);
}

export function isViewerGallery(value: unknown): value is UiViewerGallery {
  const g = value as UiViewerGallery | null;
  return !!g && Array.isArray(g.items) && Number.isInteger(g.index) && g.index >= 0 && g.index < g.items.length && g.items.every(isViewerAttachment);
}

/** Cards stay mounted a little beyond the visible peeks: neighbours are preloaded and rapid moves stay animated. */
const CAROUSEL_REACH = 3;
/** 滚轮每格的缩放倍率；按钮与键盘仍按 1.25 一档。 */
export const WHEEL_ZOOM_STEP = 1.05;
export function carouselSlots(count: number, index: number): { item: number; offset: number }[] {
  const slots: { item: number; offset: number }[] = [];
  for (let item = Math.max(0, index - CAROUSEL_REACH); item <= Math.min(count - 1, index + CAROUSEL_REACH); item++) slots.push({ item, offset: item - index });
  return slots;
}
export function slotPosition(offset: number): 'before' | 'prev' | 'main' | 'next' | 'after' {
  return offset === 0 ? 'main' : offset === -1 ? 'prev' : offset === 1 ? 'next' : offset < 0 ? 'before' : 'after';
}

export interface ViewerHost {
  openExternal(index: number): Promise<unknown>;
  /** Native save dialog for the original of item `index`; resolves to whether a file was written. */
  save?(index: number): Promise<boolean>;
  close(): void;
  /** Windows draws its own caption buttons; macOS keeps the traffic lights. */
  caption: HTMLElement | null;
}

export interface ViewerSurface { readonly element: HTMLElement; dispose(): void }

/** One gallery on screen. `dispose` stops playback and drops its key handlers before the next one mounts. */
export function renderViewer(gallery: UiViewerGallery, host: ViewerHost): ViewerSurface {
  const keys = new AbortController();
  const items = gallery.items;
  let index = gallery.index;
  const status = h('p', { class: 'viewer-status', role: 'status' });
  const stage = h('div', { class: 'viewer-stage' });
  const tools = h('div', { class: 'viewer-tools', 'aria-label': S.toolsLabel });
  const title = h('strong');
  const origin = h('span');
  const button = (label: string, text: string, action: () => void) => h('button', { type: 'button', title: label, 'aria-label': label, onclick: action }, text);
  const openExternal = () => { void host.openExternal(index).catch(() => { status.textContent = S.openFailed; }); };
  const saveButton = button(S.saveOriginal, S.saveShort, () => {
    const at = index;
    status.textContent = '';
    void host.save?.(at).then(saved => { if (index === at && saved) status.textContent = S.saved; }).catch(() => { status.textContent = S.saveFailed; });
  });
  const header = h('header', { class: 'viewer-bar', 'data-tauri-drag-region': 'deep' });
  header.append(h('div', { class: 'viewer-heading' }, title, origin),
      h('span', { class: 'viewer-hint' }, S.closeHint),
      saveButton, button(S.openExternal, S.openExternalShort, openExternal), ...(host.caption ? [host.caption] : []));
  const element = h('div', { class: 'viewer' },
    header,
    stage, h('footer', { class: 'viewer-footer' }, status, tools));
  header.addEventListener('dblclick', e => { if (!(e.target as HTMLElement).closest('button, .wbtn')) host.close(); });
  function showHeading(): UiViewerAttachment {
    const attachment = items[index]!;
    const name = attachmentInfo(attachment).name;
    title.textContent = name;
    title.title = name;
    origin.textContent = new URL(attachment.url).hostname;
    saveButton.hidden = !(host.save && attachment.saveable === true);
    return attachment;
  }
  const first = showHeading();
  const info = attachmentInfo(first);
  if (info.kind === 'image') mountImages();
  else if (info.kind === 'video' || info.kind === 'audio') {
    const player = h(info.kind, { class: 'viewer-player', src: first.url, controls: true, preload: 'metadata', playsinline: true, 'aria-label': info.name,
      ...(info.kind === 'video' ? { poster: safeMediaUrl(first.thumbnail) } : {}),
      onloadedmetadata: () => { status.textContent = ''; }, onerror: () => { status.textContent = S.mediaFailed; } });
    status.textContent = S.loadingMedia;
    stage.append(player);
  } else {
    stage.append(h('div', { class: 'viewer-file' },
      h('div', { class: 'viewer-file-icon', 'aria-hidden': 'true' }, info.extension.toUpperCase() || 'FILE'),
      h('h2', null, info.name), h('p', null, S.fileNotPreviewable),
      button(S.openOrDownload, S.openFile, openExternal)));
  }

  function mountImages(): void {
    interface Card { element: HTMLElement; image: HTMLImageElement; state: 'loading' | 'ready' | 'failed' }
    const cards = new Map<number, Card>();
    let scale = 1, rotation = 0, x = 0, y = 0;
    stage.classList.add('viewer-gallery');
    stage.classList.toggle('is-single', items.length === 1);
    const zoom = button(S.fitWindow, S.fit, () => { scale = 1; rotation = x = y = 0; applyZoom(); });
    const main = () => cards.get(index);
    function applyZoom(): void {
      const image = main()?.image;
      if (image) image.style.transform = `translate(${x}px, ${y}px) rotate(${rotation}deg) scale(${scale})`;
      zoom.textContent = scale === 1 && rotation === 0 ? S.fit : fmt(S.zoomReset, { percent: Math.round(scale * 100) });
    }
    const resize = (factor: number) => { scale = Math.max(.25, Math.min(5, scale * factor)); applyZoom(); };
    const rotate = () => { rotation = (rotation + 90) % 360; applyZoom(); };
    const count = h('span', { class: 'viewer-count' });
    const previous = h('button', { type: 'button', class: 'viewer-nav', title: S.previous, 'aria-label': S.previous, dataset: { nav: 'prev' }, onclick: () => move(index - 1) }, '‹');
    const next = h('button', { type: 'button', class: 'viewer-nav', title: S.next, 'aria-label': S.next, dataset: { nav: 'next' }, onclick: () => move(index + 1) }, '›');
    function showStatus(): void {
      const state = main()?.state;
      status.textContent = state === 'loading' ? S.loadingImage : state === 'failed' ? S.imageFailed : '';
    }
    function createCard(item: number): Card {
      const attachment = items[item]!;
      const card: Card = {
        element: h('div', { class: 'viewer-card', onclick: () => { if (card.element.dataset['pos'] === 'prev' || card.element.dataset['pos'] === 'next') move(item); } }),
        image: h('img', { class: 'viewer-image', src: attachment.url, alt: attachmentInfo(attachment).name, referrerpolicy: 'no-referrer', draggable: 'false',
          onload: () => { card.state = 'ready'; showStatus(); },
          onerror: () => { card.state = 'failed'; card.image.classList.add('is-failed'); showStatus(); } }),
        state: 'loading',
      };
      card.element.append(card.image);
      return card;
    }
    function placeCards(): void {
      const slots = carouselSlots(items.length, index);
      const kept = new Set(slots.map(slot => slot.item));
      for (const [item, card] of cards) if (!kept.has(item)) { card.element.remove(); cards.delete(item); }
      for (const { item, offset } of slots) {
        const position = slotPosition(offset);
        let card = cards.get(item);
        if (!card) { card = createCard(item); card.element.dataset['pos'] = position; cards.set(item, card); stage.append(card.element); }
        else card.element.dataset['pos'] = position;
        card.element.setAttribute('aria-hidden', String(offset !== 0));
      }
      count.textContent = `${index + 1} / ${items.length}`;
      previous.disabled = index === 0;
      next.disabled = index === items.length - 1;
      showHeading();
      showStatus();
    }
    function move(target: number): void {
      if (target < 0 || target >= items.length || target === index) return;
      // The zoom belongs to the image leaving the centre; the arriving one starts fitted.
      scale = 1; rotation = x = y = 0; applyZoom();
      index = target;
      placeCards();
      applyZoom();
    }
    placeCards();
    applyZoom();
    if (items.length > 1) { tools.append(count); stage.append(previous, next); }
    tools.append(button(S.zoomOut, '−', () => resize(1 / 1.25)), zoom, button(S.zoomIn, '+', () => resize(1.25)), button(S.rotate, S.rotateShort, rotate));
    const onMain = (target: EventTarget | null) => !!(target as Element | null)?.closest?.('.viewer-card[data-pos="main"]');
    stage.addEventListener('wheel', e => { e.preventDefault(); resize(e.deltaY < 0 ? WHEEL_ZOOM_STEP : 1 / WHEEL_ZOOM_STEP); }, { passive: false });
    stage.addEventListener('dblclick', e => { if (!onMain(e.target)) return; scale = scale === 1 ? 2 : 1; x = y = 0; applyZoom(); });
    let drag: { id: number; x: number; y: number } | null = null;
    // Only the main card pans: capturing a press on a peek would swallow its click.
    stage.addEventListener('pointerdown', e => { if (e.button !== 0 || !onMain(e.target)) return; drag = { id: e.pointerId, x: e.clientX - x, y: e.clientY - y }; stage.setPointerCapture(e.pointerId); });
    stage.addEventListener('pointermove', e => { if (drag?.id === e.pointerId) { x = e.clientX - drag.x; y = e.clientY - drag.y; applyZoom(); } });
    stage.addEventListener('pointerup', () => { drag = null; });
    stage.addEventListener('pointercancel', () => { drag = null; });
    document.addEventListener('keydown', e => {
      if (e.key === 'ArrowLeft') { e.preventDefault(); move(index - 1); }
      if (e.key === 'ArrowRight') { e.preventDefault(); move(index + 1); }
      if (e.key === '+' || e.key === '=') { e.preventDefault(); resize(1.25); }
      if (e.key === '-') { e.preventDefault(); resize(1 / 1.25); }
      if (e.key === '0') { e.preventDefault(); zoom.click(); }
      if (e.key.toLowerCase() === 'r') { e.preventDefault(); rotate(); }
    }, { signal: keys.signal });
  }
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); host.close(); } }, { signal: keys.signal });
  return {
    element,
    dispose() {
      keys.abort();
      for (const player of element.querySelectorAll<HTMLMediaElement>('video, audio')) {
        player.pause(); player.removeAttribute('src'); player.load();
      }
    },
  };
}
