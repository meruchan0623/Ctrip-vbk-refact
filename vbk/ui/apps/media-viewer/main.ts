import { applyPlatform } from '../_shared/platform.ts';
const platform = applyPlatform();
import { h, icon } from '../../packages/ui-kit/src/h.ts';
import { UiCommands, UiEvents } from '../../packages/ipc/src/client.ts';
import { selectIpc, exposeForTests } from '../_shared/ipc.ts';
import { IC } from '../_shared/icons.ts';
import { isViewerGallery, renderViewer, type ViewerSurface } from './attachment.ts';
import { MEDIA_VIEWER_STRINGS as S } from './strings.ts';

const sel = selectIpc(), ipc = sel.ipc;
const root = document.getElementById('app');
if (!root) throw new Error('#app missing');
const appRoot: HTMLElement = root;

const windowAction = (action: 'minimize' | 'toggle_maximize' | 'close') => void ipc.invoke(UiCommands.SHELL_WINDOW, { action }).catch(() => { /* The system window controls remain available. */ });
const close = () => windowAction('close');
function caption(): HTMLElement | null {
  if (platform !== 'windows') return null;
  const button = (label: string, action: 'minimize' | 'toggle_maximize' | 'close', path: string, size: number) => h('button', { type: 'button', 'aria-label': label, title: label, dataset: { win: action }, onclick: () => windowAction(action) }, icon(path, size));
  return h('div', { class: 'viewer-win' }, button(S.minimize, 'minimize', IC.min, 14), button(S.maximize, 'toggle_maximize', IC.max, 13), button(S.close, 'close', IC.close, 14));
}

let surface: ViewerSurface | null = null;
function mount(next: ViewerSurface): void {
  surface?.dispose();
  surface = next;
  appRoot.replaceChildren(next.element);
}
function showExpired(): void {
  surface?.dispose();
  surface = null;
  appRoot.replaceChildren(h('div', { class: 'viewer' },
    h('header', { class: 'viewer-bar', 'data-tauri-drag-region': 'deep' }, h('div', { class: 'viewer-heading' }, h('strong', null, S.windowTitle)), caption()),
    h('div', { class: 'viewer-stage' }, h('div', { class: 'viewer-file' }, h('p', { role: 'alert' }, S.expired)))));
}

// Two quick opens: only the newest read may mount.
let loadToken = 0;
async function load(): Promise<void> {
  const token = ++loadToken;
  try {
    const gallery = await ipc.invoke<unknown>(UiCommands.MEDIA_VIEWER_CURRENT, {});
    if (token !== loadToken) return;
    if (!isViewerGallery(gallery)) { showExpired(); return; }
    mount(renderViewer(gallery, { openExternal: index => ipc.invoke(UiCommands.MEDIA_VIEWER_OPEN_EXTERNAL, { index }), save: async index => { const result = await ipc.invoke<unknown>(UiCommands.MEDIA_SAVE_IMAGE, { index }); return !!result && typeof result === 'object' && (result as { saved?: unknown }).saved === true; }, close, caption: caption() }));
  } catch {
    if (token === loadToken) showExpired();
  }
}

// Subscribe first: a change landing during the first read must not be lost.
void ipc.listen<unknown>(UiEvents.MEDIA_VIEWER_CHANGED, () => { void load(); });
void load();
window.addEventListener('pagehide', () => surface?.dispose());
exposeForTests(sel);
