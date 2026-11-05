/**
 * Windows caption: the minimize / maximize-restore / close buttons, plus the
 * native behaviour an undecorated window loses (restore glyph, dimming while
 * inactive, system menu on the title bar). Returns nothing on macOS, where the
 * traffic lights own all of this. Every window builds its caption from here.
 */
import { UiCommands } from '../../packages/ipc/src/client.ts';
import { h, icon } from '../../packages/ui-kit/src/h.ts';
import { t } from '../../packages/ui-kit/src/i18n.ts';
import { IC } from './icons.ts';
import { currentPlatform } from './platform.ts';

export type WindowAction = 'minimize' | 'toggle_maximize' | 'close';
type Invoke = (command: string, payload: unknown) => Promise<unknown>;

export interface WindowControlsOptions {
  readonly invoke: Invoke;
  /** A fixed dialog leaves out `toggle_maximize`. */
  readonly actions?: readonly WindowAction[];
  /** Replaces the plain close when the window has work to do first. */
  readonly onClose?: () => void;
  readonly closeLabel?: string;
  readonly closeDisabled?: boolean;
  readonly closeDataset?: Readonly<Record<string, string>>;
}

const ALL_ACTIONS: readonly WindowAction[] = ['minimize', 'toggle_maximize', 'close'];
const ROOT_MAXIMIZED = 'windowMaximized';
const ROOT_ACTIVE = 'windowActive';

let maximized = false;

function maximizeLabel(): string {
  return t(maximized ? 'win.restore' : 'win.maximize');
}

function applyState(result: unknown): void {
  if (typeof result !== 'object' || result === null) return;
  const state = result as { maximized?: unknown; focused?: unknown };
  const root = document.documentElement;
  if (typeof state.focused === 'boolean') root.dataset[ROOT_ACTIVE] = String(state.focused);
  if (typeof state.maximized !== 'boolean' || state.maximized === maximized) return;
  maximized = state.maximized;
  root.dataset[ROOT_MAXIMIZED] = String(maximized);
  for (const button of document.querySelectorAll('[data-win="toggle_maximize"]')) {
    button.setAttribute('aria-label', maximizeLabel());
    button.setAttribute('title', maximizeLabel());
  }
}

/** Failures are left silent: the state only decorates the caption. */
function send(invoke: Invoke, action: string): void {
  void invoke(UiCommands.SHELL_WINDOW, { action }).then(applyState, () => undefined);
}

export function windowControls(options: WindowControlsOptions): HTMLElement | null {
  if (currentPlatform() !== 'windows') return null;
  const { invoke, actions = ALL_ACTIONS } = options;
  const buttons = actions.map((action) => {
    if (action === 'minimize') {
      return h('button', { type: 'button', class: 'wbtn', 'aria-label': t('win.minimize'), title: t('win.minimize'), dataset: { win: action }, onclick: () => send(invoke, action) }, icon(IC.capMin, 10));
    }
    if (action === 'toggle_maximize') {
      return h('button', { type: 'button', class: 'wbtn', 'aria-label': maximizeLabel(), title: maximizeLabel(), dataset: { win: action }, onclick: () => send(invoke, action) },
        icon(IC.capMax, 10, { 'data-cap-icon': 'max' }),
        icon(IC.capRestore, 10, { 'data-cap-icon': 'restore' }));
    }
    const label = options.closeLabel ?? t('win.close');
    return h('button', {
      type: 'button', class: 'wbtn x', 'aria-label': label, title: label, disabled: options.closeDisabled === true,
      dataset: { win: action, ...options.closeDataset },
      onclick: options.onClose ?? (() => send(invoke, action)),
    }, icon(IC.capClose, 10));
  });
  return h('div', { class: 'wbtns' }, buttons);
}

const CLICKABLE_TAGS = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'LABEL', 'SUMMARY']);
const INTERACTIVE_ROLES = new Set(['button', 'link', 'menuitem', 'tab', 'checkbox', 'radio', 'switch', 'option']);

/** The minimal element surface `isTitleBarDragTarget` reads. */
export interface DragPathElement {
  readonly tagName: string;
  getAttribute(name: string): string | null;
}

/** Same rules as Tauri's drag script, so the menu opens exactly where a drag would start. */
export function isTitleBarDragTarget(path: readonly DragPathElement[]): boolean {
  for (const el of path) {
    const region = el.getAttribute('data-tauri-drag-region');
    const editable = el.getAttribute('contenteditable');
    const tabindex = el.getAttribute('tabindex');
    const clickable = CLICKABLE_TAGS.has(el.tagName)
      || (editable !== null && editable !== 'false')
      || (tabindex !== null && tabindex !== '-1')
      || INTERACTIVE_ROLES.has(el.getAttribute('role') ?? '');
    if (clickable && region === null) return false;
    if (region === null) continue;
    if (region === 'false') return false;
    if (region === 'deep') return true;
    return el === path[0];
  }
  return false;
}

/** Call once per window that shows a caption; a no-op on macOS. */
export function installWindowChrome(invoke: Invoke): void {
  if (currentPlatform() !== 'windows') return;
  let pending: ReturnType<typeof setTimeout> | undefined;
  window.addEventListener('resize', () => {
    clearTimeout(pending);
    pending = setTimeout(() => send(invoke, 'state'), 120);
  });
  // Blur alone is not "inactive": focus may have moved into a child webview of this window.
  window.addEventListener('focus', () => send(invoke, 'state'));
  window.addEventListener('blur', () => send(invoke, 'state'));
  document.addEventListener('contextmenu', (event) => {
    const path = event.composedPath().filter((node): node is HTMLElement => node instanceof HTMLElement);
    if (!isTitleBarDragTarget(path)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    send(invoke, 'system_menu');
  }, true);
}
