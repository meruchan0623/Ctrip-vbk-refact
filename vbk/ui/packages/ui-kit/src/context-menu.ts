import { h, icon } from './h.ts';
import type { Child } from './h.ts';

export interface ContextMenuAction {
  readonly id: string;
  readonly label: string;
  readonly run: () => void | Promise<void>;
  readonly icon?: string;
  readonly shortcut?: string;
  readonly danger?: boolean;
  readonly disabled?: boolean;
  readonly divider?: boolean;
  readonly dataset?: Readonly<Record<string, string>>;
  readonly content?: () => Child;
}
const paths: Record<string, string> = {
  copy: 'M8 8h12v12H8zM4 16V4h12',
  quote: 'M6 17h3l2-4V7H5v6h3zM14 17h3l2-4V7h-6v6h3z',
  forward: 'M13 5l7 7-7 7M20 12H9a5 5 0 0 0-5 5',
  recall: 'M8 5L3 10l5 5M3 10h11a6 6 0 0 1 0 12',
  translate: 'M3 5h10M8 3v2M5 5c1 4 4 7 7 8M11 5c-1 4-4 7-7 8M13 21l4-10 4 10M15 17h4',
  save: 'M12 3v12M7 10l5 5 5-5M4 16v5h16v-5',
  emoji: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM8 14a5 5 0 0 0 8 0M9 9h.01M15 9h.01',
  front: 'M5 4h14M7 12l5-5 5 5M12 7v14',
  preview: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6',
  rename: 'M4 20l4-1L20 7l-3-3L5 16zM14 7l3 3',
  delete: 'M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7',
  cut: 'M6 4a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM6 14a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM8 9l12 11M8 15L20 4',
  paste: 'M9 4H5v17h14V4h-4M9 2h6v5H9z',
  select: 'M4 4h16v16H4zM8 9h8M8 13h8M8 17h5',
  top: 'M9 3h6l-1 6 4 4H6l4-4zM12 13v8',
  clear: 'M4 16l9-12 7 6-8 11H8zM12 21h9',
};
let closeActive: (() => void) | null = null;

export function createContextMenu(className = '', label = '操作菜单', keepEditorFocus = false) {
  let menu: HTMLElement | null = null;
  let previousFocus: HTMLElement | null = null;
  let cleanup: (() => void) | null = null;
  function close(restoreFocus = false): void {
    cleanup?.(); cleanup = null;
    menu?.remove(); menu = null;
    if (closeActive === close) closeActive = null;
    if (restoreFocus && previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    previousFocus = null;
  }
  function open(x: number, y: number, actions: readonly ContextMenuAction[], valid: () => boolean = () => true, failed: () => void = () => {}, container?: HTMLElement): void {
    closeActive?.(); close();
    if (!actions.length || !valid()) return;
    previousFocus = document.activeElement as HTMLElement | null;
    let activeIndex = 0;
    const own = h('div', { class: `app-context-menu ${className}`, role: 'menu', 'aria-label': label, oncontextmenu: (e: Event) => { e.preventDefault(); e.stopPropagation(); },
      onmousedown: (e: Event) => { e.stopPropagation(); if (keepEditorFocus) e.preventDefault(); },
      onkeydown: (e: KeyboardEvent) => {
        e.stopPropagation();
        const buttons = [...own.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
        const index = keepEditorFocus ? activeIndex : buttons.indexOf(document.activeElement as HTMLButtonElement);
        if (keepEditorFocus && e.key === 'Enter') { e.preventDefault(); buttons[activeIndex]?.click(); }
        if (e.key === 'Escape' || e.key === 'Tab') { if (e.key === 'Escape') e.preventDefault(); close(true); }
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
          e.preventDefault();
          const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (index + (e.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length;
          if (keepEditorFocus) { activeIndex = next; for (const [i, button] of buttons.entries()) button.classList.toggle('context-menu-active', i === next); }
          else buttons[next]?.focus();
        }
      },
    }, actions.flatMap(action => [
      action.divider ? h('div', { class: 'context-menu-separator', role: 'separator' }) : null,
      action.content ? action.content() : h('button', { type: 'button', role: 'menuitem', disabled: action.disabled, class: `context-menu-item${action.danger || action.id === 'delete' ? ' danger' : ''}`, dataset: { messageMenu: action.id, ...action.dataset },
        onclick: () => {
          const current = valid(); close(true);
          if (current && !action.disabled) { try { void Promise.resolve(action.run()).catch(failed); } catch { failed(); } }
        },
      }, icon(action.icon ?? paths[action.id] ?? paths['preview']!, 16, { class: 'ic context-menu-icon', 'aria-hidden': 'true' }), h('span', { class: 'context-menu-label' }, action.label), action.shortcut ? h('kbd', { class: 'context-menu-shortcut' }, action.shortcut) : null),
    ]));
    menu = own; closeActive = close;
    (container ?? document.querySelector<HTMLDialogElement>('dialog[open]') ?? document.body).append(own);
    const rect = own.getBoundingClientRect();
    own.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
    own.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
    if (!keepEditorFocus) own.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
    const editingKey = (e: KeyboardEvent) => { if (own.contains(e.target as Node)) return; if (keepEditorFocus && ['ArrowDown','ArrowUp','Home','End','Escape','Tab','Enter'].includes(e.key)) { const event = new KeyboardEvent('keydown', {key:e.key,cancelable:true}); own.dispatchEvent(event); if(event.defaultPrevented)e.preventDefault(); e.stopPropagation(); } };
    if (keepEditorFocus) document.addEventListener('keydown', editingKey, true);
    const outside = (e: Event) => { if (!own.contains(e.target as Node)) close(); };
    const resized = () => close();
    document.addEventListener('mousedown', outside, true);
    document.addEventListener('scroll', outside, true);
    window.addEventListener('resize', resized);
    window.addEventListener('blur', resized);
    cleanup = () => {
      document.removeEventListener('keydown', editingKey, true);
      document.removeEventListener('mousedown', outside, true);
      document.removeEventListener('scroll', outside, true);
      window.removeEventListener('resize', resized);
      window.removeEventListener('blur', resized);
    };
  }
  return { open, close };
}

/** Shared local-window edit menu. Passwords never expose cut/copy. */
export function installEditingContextMenu(clipboard: { read(): Promise<string>; write(text: string): Promise<unknown> }): void {
  const menu = createContextMenu('edit-context-menu', '编辑', true);
  document.addEventListener('contextmenu', event => {
    if (event.defaultPrevented) return;
    const target = event.target as HTMLElement;
    const input = target.closest<HTMLInputElement | HTMLTextAreaElement>('input,textarea');
    const editable = input && !input.disabled && ['textarea', 'input'].includes(input.tagName.toLowerCase()) && (input instanceof HTMLTextAreaElement || ['text','search','url','email','tel','password'].includes(input.type)) ? input : null;
    const selected = editable ? editable.value.slice(editable.selectionStart ?? 0, editable.selectionEnd ?? 0) : window.getSelection()?.toString() ?? '';
    const secret = editable instanceof HTMLInputElement && editable.type === 'password';
    event.preventDefault();
    const mac = document.documentElement.dataset['platform'] === 'macos';
    const mod = mac ? '⌘' : 'Ctrl+';
    const actions: ContextMenuAction[] = [];
    const start = editable?.selectionStart ?? 0, end = editable?.selectionEnd ?? 0;
    const original = editable?.value;
    const valid = () => !editable || editable.isConnected && editable.value === original && !editable.disabled;
    const replace = (text: string) => {
      if (!editable || editable.readOnly || !valid()) return;
      editable.focus({ preventScroll: true });
      try { editable.setSelectionRange(start, end); } catch { /* Email controls keep their native selection. */ }
      // Browser editing preserves undo history and dispatches the normal input event.
      if (!document.execCommand('insertText', false, text)) {
        try { editable.setRangeText(text, start, end, 'end'); } catch { return; }
        editable.dispatchEvent(new Event('input', { bubbles: true }));
      }
    };
    if (editable && !secret) actions.push({ id:'cut',label:'剪切',shortcut:`${mod}X`,disabled:!selected || editable.readOnly,run:async()=>{ await clipboard.write(selected); replace(''); } });
    if (!secret && (selected || editable)) actions.push({ id:'copy',label:'复制',shortcut:`${mod}C`,disabled:!selected,run:()=>clipboard.write(selected).then(()=>{}) });
    if (editable) {
      actions.push({ id:'paste',label:'粘贴',shortcut:`${mod}V`,disabled:editable.readOnly,run:async()=>{const text=await clipboard.read();replace(text);} });
      actions.push({ id:'select',label:'全选',shortcut:`${mod}A`,divider:true,run:()=>{ if(valid()){editable.focus();editable.select();} } });
    }
    menu.open(event.clientX,event.clientY,actions,valid,()=>{},target.closest<HTMLElement>('dialog[open]') ?? undefined);
  });
  window.addEventListener('pagehide', () => menu.close());
}
