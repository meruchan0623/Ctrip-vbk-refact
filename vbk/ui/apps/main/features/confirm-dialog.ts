/**
 * Confirmation dialog for feature actions (irreversible ones in particular).
 *
 * Mounted outside the window's store-driven render (appended to `body`) so a
 * re-render cannot discard it mid-decision. The decision logic is the
 * DOM-free `ConfirmController`; `showConfirmDialog` only paints it. Rules: a
 * second request while one is open answers the first with "no" (never two
 * stacked dialogs); a `danger` dialog focuses Cancel, not the destructive
 * button; Escape, the backdrop and Cancel all mean "no".
 */

import { h } from '../../../packages/ui-kit/src/h.ts';
import type { ConfirmRequest } from './context.ts';

export class ConfirmController {
  #pending: { readonly request: ConfirmRequest; readonly resolve: (answer: boolean) => void } | null = null;
  #listener: (() => void) | null = null;

  /** Called whenever the pending request changes (open/closed). */
  onChange(listener: (() => void) | null): void {
    this.#listener = listener;
  }

  request(request: ConfirmRequest): Promise<boolean> {
    this.answer(false);
    return new Promise<boolean>((resolve) => {
      this.#pending = { request, resolve };
      this.#listener?.();
    });
  }

  current(): ConfirmRequest | null {
    return this.#pending?.request ?? null;
  }

  answer(value: boolean): void {
    const p = this.#pending;
    if (!p) return;
    this.#pending = null;
    p.resolve(value);
    this.#listener?.();
  }
}

/** Paints the controller's pending request; call once at start-up. Returns a disposer. */
export function mountConfirmDialog(controller: ConfirmController, host: HTMLElement): () => void {
  let node: HTMLElement | null = null;
  const close = (): void => {
    node?.remove();
    node = null;
  };
  controller.onChange(() => {
    close();
    const req = controller.current();
    if (!req) return;
    const cancelBtn = h('button', { class: 'btn', dataset: { confirm: 'cancel' }, onclick: () => controller.answer(false) }, req.cancelLabel);
    const okBtn = h('button', { class: req.danger ? 'btn dan' : 'btn pri', dataset: { confirm: 'ok' }, onclick: () => controller.answer(true) }, req.confirmLabel);
    node = h(
      'div',
      { class: 'shade', dataset: { featureConfirm: '1' }, onclick: () => controller.answer(false) },
      h(
        'div',
        {
          class: 'dlg',
          style: { width: '400px' },
          role: 'alertdialog',
          'aria-modal': 'true',
          'aria-label': req.title,
          onclick: (e: Event) => e.stopPropagation(),
          onkeydown: (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              controller.answer(false);
            }
          },
        },
        h('div', { class: 'dlg-h' }, req.title),
        h('div', { class: 'dlg-b' }, req.message),
        h('div', { class: 'dlg-f' }, cancelBtn, okBtn),
      ),
    );
    host.appendChild(node);
    (req.danger ? cancelBtn : okBtn).focus();
  });
  return () => {
    controller.answer(false);
    controller.onChange(null);
    close();
  };
}
