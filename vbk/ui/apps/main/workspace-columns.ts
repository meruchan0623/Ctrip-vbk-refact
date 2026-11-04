import { h } from '../../packages/ui-kit/src/h.ts';
import { t } from '../../packages/ui-kit/src/i18n.ts';

type Widths = { left: number; right: number };
const DEFAULTS: Widths = { left: 280, right: 330 };
const KEY = 'vbk.workspace-columns.v1';
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(n, max));
export function fitColumns(width: number, preferred: Widths, side: boolean): Widths {
  const available = Math.max(side ? 892 : 626, width) - 400 - (side ? 12 : 6);
  const right = side ? clamp(preferred.right, 260, Math.min(520, available - 220)) : 0;
  return { left: clamp(preferred.left, 220, Math.min(480, available - right)), right };
}

/** Local layout preference, independent of account and conversation state. */
export function createWorkspaceColumns() {
  let preferred = { ...DEFAULTS };
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (Number.isFinite(saved?.left) && Number.isFinite(saved?.right)) preferred = { left: clamp(saved.left, 220, 480), right: clamp(saved.right, 260, 520) };
  } catch { /* Storage may be unavailable in a restricted webview. */ }
  let root: HTMLElement | null = null;
  let observer: ResizeObserver | null = null;
  /** 上次 apply 的结果：渲染树直接把它写成 props，morph 就不会先删掉 style 再由 ref 写回（每帧一次强制布局）。 */
  let applied: { side: boolean; widths: Widths; max: Widths } | null = null;
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(preferred)); } catch {} };
  const apply = () => {
    if (!root) return;
    const side = root.dataset.sideOpen === 'true';
    const width = root.clientWidth;
    const widths = fitColumns(width, preferred, side);
    const total = Math.max(side ? 892 : 626, width) - 400 - (side ? 12 : 6);
    const max = { left: Math.min(480, total - widths.right), right: Math.min(520, total - widths.left) };
    applied = { side, widths, max };
    root.style.setProperty('--list-width', `${widths.left}px`);
    root.style.setProperty('--detail-width', `${widths.right}px`);
    for (const which of ['left', 'right'] as const) {
      const separator = root.querySelector<HTMLElement>(`[data-column-resize="${which}"]`);
      separator?.setAttribute('aria-valuenow', String(Math.round(widths[which])));
      separator?.setAttribute('aria-valuemax', String(max[which]));
    }
  };
  /** 容器元素的 style props：与 apply 写进活节点的完全一致，尺寸变化只由 ResizeObserver 驱动。 */
  const rootStyle = (): Record<string, string> | undefined => applied ? { '--list-width': `${applied.widths.left}px`, '--detail-width': `${applied.widths.right}px` } : undefined;
  const attach = (element: Element) => {
    if (root === element) {
      // 同一容器、侧栏开合未变：尺寸由 ResizeObserver 跟踪，这里不再读 clientWidth（那是一次强制同步布局）。
      if (applied && applied.side === (root!.dataset.sideOpen === 'true')) return;
      apply();
      return;
    }
    observer?.disconnect();
    root = element as HTMLElement;
    observer = new ResizeObserver(apply);
    observer.observe(root);
    apply();
  };
  const change = (which: keyof Widths, value: number) => {
    if (!root) return;
    const side = root.dataset.sideOpen === 'true';
    const current = fitColumns(root.clientWidth, preferred, side);
    const total = Math.max(side ? 892 : 626, root.clientWidth) - 400 - (side ? 12 : 6);
    const other = which === 'left' ? current.right : current.left;
    preferred[which] = clamp(value, which === 'left' ? 220 : 260, Math.min(which === 'left' ? 480 : 520, total - other));
    apply();
  };
  const separator = (which: keyof Widths) => h('div', {
    class: 'column-resizer', role: 'separator', tabindex: '0',
    'aria-label': which === 'left' ? t('orderMisc.columns.resizeLeft') : t('orderMisc.columns.resizeRight'),
    'aria-orientation': 'vertical', 'aria-valuemin': which === 'left' ? 220 : 260,
    'aria-valuenow': applied ? Math.round(applied.widths[which]) : undefined, 'aria-valuemax': applied ? applied.max[which] : undefined,
    dataset: { columnResize: which, fid: `column-resize:${which}` },
    title: t('orderMisc.columns.resizeHint'),
    onpointerdown: (event: PointerEvent) => {
      if (event.button !== 0 || !root) return;
      event.preventDefault();
      const handle = event.currentTarget as HTMLElement;
      handle.focus();
      const startX = event.clientX;
      const startWidth = fitColumns(root.clientWidth, preferred, root.dataset.sideOpen === 'true')[which];
      const pointer = event.pointerId;
      const move = (e: PointerEvent) => {
        if (e.pointerId === pointer) change(which, startWidth + (e.clientX - startX) * (which === 'left' ? 1 : -1));
      };
      const end = (e: Event) => {
        if ('pointerId' in e && e.pointerId !== pointer) return;
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', end);
        document.removeEventListener('pointercancel', end);
        window.removeEventListener('blur', end);
        if (handle.hasPointerCapture(pointer)) handle.releasePointerCapture(pointer);
        document.documentElement.classList.remove('resizing-columns');
        save();
      };
      handle.setPointerCapture(pointer);
      document.documentElement.classList.add('resizing-columns');
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', end);
      document.addEventListener('pointercancel', end);
      window.addEventListener('blur', end);
    },
    ondblclick: () => { preferred = { ...DEFAULTS }; apply(); save(); },
    onkeydown: (event: KeyboardEvent) => {
      if (!root || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const width = fitColumns(root.clientWidth, preferred, root.dataset.sideOpen === 'true')[which];
      const delta = (event.key === 'ArrowRight' ? 1 : -1) * (which === 'left' ? 1 : -1) * (event.shiftKey ? 40 : 10);
      change(which, event.key === 'Home' ? 0 : event.key === 'End' ? 10000 : width + delta);
      save();
    },
  });
  return { attach, separator, rootStyle };
}
