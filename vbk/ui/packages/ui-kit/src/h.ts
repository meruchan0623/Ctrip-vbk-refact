/**
 * Minimal hyperscript for dependency-free DOM rendering.
 *
 * `h(tag, props, ...children)` creates an element. Props:
 * - `class`: string | string[] | Record<string, boolean>
 * - `style`: string | Record<string, string>
 * - `on<Event>`: event listener (`onclick`, `oninput`, `oncontextmenu`, …)
 * - `ref`: callback receiving the element
 * - `dataset`: Record<string, string>
 * - boolean DOM properties (`disabled`, `checked`, `hidden`) are set as properties
 * - `value` is set as a property, everything else as an attribute
 *
 * Nothing here parses HTML strings; text children are always text nodes.
 */

export type Child = Node | string | number | null | undefined | false | readonly Child[];
export type ClassValue = string | readonly (string | false | null | undefined)[] | Readonly<Record<string, boolean>>;
export type Props = Readonly<Record<string, unknown>> | null | undefined;

const BOOL_PROPS = new Set(['disabled', 'checked', 'hidden', 'selected', 'readOnly', 'multiple', 'autofocus']);

export function cx(...values: readonly (ClassValue | null | undefined | false)[]): string {
  const out: string[] = [];
  for (const v of values) {
    if (!v) continue;
    if (typeof v === 'string') {
      if (v) out.push(v);
    } else if (Array.isArray(v)) {
      for (const x of v as readonly (string | false | null | undefined)[]) if (x) out.push(x);
    } else {
      for (const [k, on] of Object.entries(v as Record<string, boolean>)) if (on) out.push(k);
    }
  }
  return out.join(' ');
}

function applyProps(el: HTMLElement | SVGElement, props: Props): void {
  if (!props) return;
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) {
      if (key === 'value') (el as HTMLInputElement).value = '';
      continue;
    }
    if (key === 'class') {
      const cls = cx(value as ClassValue);
      if (cls) el.setAttribute('class', cls);
    } else if (key === 'style') {
      if (typeof value === 'string') el.setAttribute('style', value);
      else for (const [k, v] of Object.entries(value as Record<string, string>)) el.style.setProperty(k, v);
    } else if (key === 'ref') {
      (value as (e: Element) => void)(el);
    } else if (key === 'dataset') {
      // camelCase keys become kebab-case attributes, mirroring `el.dataset`.
      for (const [k, v] of Object.entries(value as Record<string, string>)) el.setAttribute(`data-${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`, v);
    } else if (key.startsWith('on')) {
      // Listeners only: an `on*` prop is never written as an inline-handler attribute (CSP: no inline script).
      if (typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (BOOL_PROPS.has(key)) {
      (el as unknown as Record<string, unknown>)[key] = value === true;
    } else if (key === 'value') {
      (el as HTMLInputElement).value = String(value);
    } else if (value === true) {
      el.setAttribute(key, '');
    } else {
      el.setAttribute(key, String(value));
    }
  }
}

export function appendChildren(parent: Node, children: readonly Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) {
      appendChildren(parent, c as readonly Child[]);
    } else if (c instanceof Node) {
      parent.appendChild(c);
    } else {
      parent.appendChild(document.createTextNode(String(c)));
    }
  }
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props, ...children: Child[]): HTMLElementTagNameMap[K];
export function h(tag: string, props?: Props, ...children: Child[]): HTMLElement;
export function h(tag: string, props?: Props, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  applyProps(el, props);
  appendChildren(el, children);
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Stroke icon from a single path `d` (prototype `.ic` style). */
export function icon(d: string, size = 16, props?: Props): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'ic');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', d);
  svg.appendChild(path);
  applyProps(svg, props);
  return svg;
}

export function fragment(...children: Child[]): DocumentFragment {
  const f = document.createDocumentFragment();
  appendChildren(f, children);
  return f;
}

/** Replace the content of `root` with `node`. */
export function mount(root: Element, node: Node): void {
  root.replaceChildren(node);
}

/**
 * Re-render helper that keeps keyboard focus, caret and scroll positions
 * across a full re-render. Inputs opt in with `data-fid`, scroll containers
 * with `data-keep-scroll`.
 */
export function rerender(root: Element, build: () => Node): void {
  const active = document.activeElement as HTMLElement | null;
  const fid = active?.dataset['fid'];
  let selStart: number | null = null;
  let selEnd: number | null = null;
  if (fid && (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement)) {
    try {
      selStart = active.selectionStart;
      selEnd = active.selectionEnd;
    } catch {
      selStart = null;
    }
  }
  const scrolls = new Map<string, number>();
  for (const el of root.querySelectorAll<HTMLElement>('[data-keep-scroll]')) {
    const key = el.dataset['keepScroll'];
    if (key) scrolls.set(key, el.scrollTop);
  }
  mount(root, build());
  for (const el of root.querySelectorAll<HTMLElement>('[data-keep-scroll]')) {
    const key = el.dataset['keepScroll'];
    const pinned = el.dataset['scrollBottom'] === '1';
    if (pinned) el.scrollTop = el.scrollHeight;
    else if (key && scrolls.has(key)) el.scrollTop = scrolls.get(key) ?? 0;
  }
  if (fid) {
    const next = root.querySelector<HTMLElement>(`[data-fid="${CSS.escape(fid)}"]`);
    if (next) {
      next.focus({ preventScroll: true });
      if (selStart !== null && (next instanceof HTMLInputElement || next instanceof HTMLTextAreaElement)) {
        try {
          next.setSelectionRange(selStart, selEnd ?? selStart);
        } catch {
          /* type=number etc. */
        }
      }
    }
  }
}
