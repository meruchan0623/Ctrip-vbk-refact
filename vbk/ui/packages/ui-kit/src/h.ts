/**
 * Minimal hyperscript for dependency-free DOM rendering.
 *
 * `h(tag, props, ...children)` creates an element. Props:
 * - `class`: string | string[] | Record<string, boolean>
 * - `style`: string | Record<string, string>
 * - `on<Event>`: event listener (`onclick`, `oninput`, `oncontextmenu`, …); under
 *   `rerender(..., { morph: true })` it follows the node that stays on the page
 * - `ref`: callback receiving the element (the surviving one, after a morph)
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

// ---- 事件处理：每个 (元素, 类型) 只挂一个固定跳板，真正的处理函数放在元素的处理表里

const HANDLERS = Symbol('vbk.handlers');
type HandlerHost = { [HANDLERS]?: Record<string, EventListener> };

function dispatchHandler(this: Element, event: Event): void {
  const fn = (this as unknown as HandlerHost)[HANDLERS]?.[event.type];
  if (fn) fn.call(this, event);
}

function setHandler(el: Element, type: string, fn: EventListener): void {
  const host = el as unknown as HandlerHost;
  (host[HANDLERS] ??= {})[type] = fn;
  // 同一函数引用对同一类型只会被平台登记一次。
  el.addEventListener(type, dispatchHandler);
}

// ---- 增量重渲染会话（`rerender(..., { morph: true })`）

interface BuildSession {
  /** 推迟到 morph 之后执行的 `ref`，届时交给真正留在页面上的元素。 */
  readonly refs: [Element, (e: Element) => void][];
  /** 代替「已挂载节点」的注释占位符 → 该活节点。 */
  readonly retained: Map<Comment, Node>;
}
let session: BuildSession | null = null;
/** 早先构建、已被 morph 折叠进页面上旧节点的新元素上记着那个旧元素（普通属性，比 WeakMap 便宜）。 */
const SURVIVOR = Symbol('vbk.survivor');
/** 兄弟间配对键的缓存：键属性在节点生命周期内不变（只有同键/同为无键的节点才会互相 morph）。 */
const KEY = Symbol('vbk.key');
type MorphHost = { [SURVIVOR]?: Node; [KEY]?: string | null };

/** 当前在页面上代表 `node` 的节点（从未被折叠时就是它自己）。 */
export function liveNode<T extends Node>(node: T): T {
  let current: Node = node;
  for (let next = (current as MorphHost)[SURVIVOR]; next && next !== current; next = (current as MorphHost)[SURVIVOR]) current = next;
  return current as T;
}

/**
 * 构建期间传入一个已挂载的节点（缓存的子树、保留的媒体元素）时，不能在拼装新树时把它从页面上拔下来：
 * 那会让滚动容器脱离文档、丢掉滚动位置和正在进行的（触控板惯性）滚动。这里用占位符代替，morph 时原地保留活节点。
 */
function retainLive(node: Node): Node {
  const live = liveNode(node);
  if (live !== node && live.nodeType === 1 && node.nodeType === 1) syncAttributes(live as Element, node as Element);
  if (!session || !live.isConnected) return live;
  const mark = document.createComment('');
  session.retained.set(mark, live);
  return mark;
}

/** 兄弟节点间的配对键：显式身份属性优先，行被移动/重排时仍复用原节点。 */
const KEY_ATTRS = ['data-key', 'data-row-id', 'data-gid', 'data-media-key', 'data-keep-scroll', 'data-fid'];
let unpaired = 0;
function keyOf(node: Node): string | null {
  if (node.nodeType !== 1) return null;
  const host = node as MorphHost;
  const cached = host[KEY];
  if (cached !== undefined) return cached;
  return (host[KEY] = computeKey(node as Element));
}
function computeKey(el: Element): string | null {
  for (const attr of KEY_ATTRS) {
    const value = el.getAttribute(attr);
    if (value === null) continue;
    // 媒体元素只在身份完整（非空 key）且地址相同时复用，否则播放状态绝不跨身份/地址沿用。
    if (attr === 'data-media-key') return value ? `${el.nodeName}|${attr}|${value}|${el.getAttribute('src') ?? ''}` : `${el.nodeName}|unpaired|${++unpaired}`;
    return `${el.nodeName}|${attr}|${value}`;
  }
  return null;
}
/** 无键兄弟按标签 + 首个 class 配对，可选的兄弟出现/消失不会让其后所有节点错位。 */
function kindOf(node: Node): string {
  if (node.nodeType !== 1) return node.nodeName;
  const cls = (node as Element).getAttribute('class') ?? '';
  const space = cls.indexOf(' ');
  return `${node.nodeName}.${space < 0 ? cls : cls.slice(0, space)}`;
}

function syncAttributes(from: Element, to: Element): void {
  if (from === to) return;
  const next = to.attributes;
  for (let i = 0; i < next.length; i++) {
    const attr = next[i]!;
    if (from.getAttribute(attr.name) !== attr.value) from.setAttribute(attr.name, attr.value);
  }
  // 此时 from 的属性已包含 to 的全部；个数相同即完全一致，省掉逐个反查。
  const prev = from.attributes;
  if (prev.length === next.length) return;
  for (let i = prev.length - 1; i >= 0; i--) {
    const name = prev[i]!.name;
    if (!to.hasAttribute(name)) from.removeAttribute(name);
  }
}

const FORM_VALUE = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
/** 新树设置的、不（只）是属性的活属性；只在不同时写入，光标和选区得以保留。 */
function syncFormState(from: Element, to: Element): void {
  const a = from as unknown as Record<string, unknown>, b = to as unknown as Record<string, unknown>;
  if (from.nodeName === 'INPUT' && a['checked'] !== b['checked']) a['checked'] = b['checked'];
  if (from.nodeName === 'OPTION' && a['selected'] !== b['selected']) a['selected'] = b['selected'];
  if (FORM_VALUE.has(from.nodeName) && a['value'] !== b['value']) a['value'] = b['value'];
}

/** 把 `old` 原地变成 `next`；返回最终留在树上的节点（old，无法配对时为 next）。 */
function morphNode(old: Node, next: Node, used: Set<Node>): Node {
  if (old.nodeType !== next.nodeType || old.nodeName !== next.nodeName) return next;
  if (old.nodeType === 3 || old.nodeType === 8) {
    if ((old as CharacterData).data !== (next as CharacterData).data) (old as CharacterData).data = (next as CharacterData).data;
    return old;
  }
  if (old.nodeType !== 1) return next;
  const from = old as Element, to = next as Element;
  // shadow host 的内容不在 childNodes 里：与整树渲染一样直接替换。
  if ((from as HTMLElement).shadowRoot || (to as HTMLElement).shadowRoot) return next;
  syncAttributes(from, to);
  const handlers = (to as unknown as HandlerHost)[HANDLERS], previous = (from as unknown as HandlerHost)[HANDLERS];
  if (handlers) {
    // 跳板对已登记过的类型无需再登记。
    for (const type in handlers) if (!previous || !(type in previous)) from.addEventListener(type, dispatchHandler);
    (from as unknown as HandlerHost)[HANDLERS] = handlers;
  } else if (previous) delete (from as unknown as HandlerHost)[HANDLERS];
  if (to.firstChild || from.firstChild) morphChildren(from, Array.from(to.childNodes), used);
  syncFormState(from, to);
  (next as MorphHost)[SURVIVOR] = old;
  return old;
}

function morphChildren(parent: Node, next: readonly Node[], used: Set<Node>): void {
  const olds = Array.from(parent.childNodes);
  const keyed = new Map<string, Node>();
  const unkeyed: Node[] = [];
  for (const node of olds) {
    const key = keyOf(node);
    if (key === null) unkeyed.push(node);
    else if (!keyed.has(key)) keyed.set(key, node);
  }
  const plan: Node[] = [];
  let cursor = 0;
  for (const node of next) {
    const kept = node.nodeType === 8 ? session?.retained.get(node as Comment) : undefined;
    if (kept) { used.add(kept); plan.push(kept); continue; }
    let match: Node | undefined;
    const key = keyOf(node);
    if (key !== null) {
      match = keyed.get(key);
    } else {
      const kind = kindOf(node);
      for (let i = cursor; i < unkeyed.length && i < cursor + 8; i++) {
        const candidate = unkeyed[i]!;
        if (!used.has(candidate) && kindOf(candidate) === kind) { match = candidate; cursor = i + 1; break; }
      }
    }
    if (match && !used.has(match)) {
      used.add(match);
      const result = morphNode(match, node, used);
      if (result !== match) used.delete(match);
      plan.push(result);
    } else plan.push(node);
  }
  for (const node of olds) if (!used.has(node) && node.parentNode === parent) parent.removeChild(node);
  // 常见情况下配对节点相对顺序不变，因此不会被移动（移动 = 先脱离文档）。
  let at: Node | null = parent.firstChild;
  for (const node of plan) {
    if (node === at) { at = at.nextSibling; continue; }
    parent.insertBefore(node, at);
  }
}

/** 把 `root` 的子树就地 morph 成 `build()` 的结果，能配对的节点全部保留。 */
function morphRoot(root: Element, build: () => Node): void {
  const own: BuildSession = { refs: [], retained: new Map() };
  const outer = session;
  session = own;
  try {
    const next = build();
    morphChildren(root, next.nodeType === 11 ? Array.from(next.childNodes) : [next], new Set());
  } finally {
    session = outer;
  }
  // 落进新插入子树里的占位符换回它代表的活节点。
  // （留在被丢弃的新树里的占位符不在文档中，忽略。）
  for (const [mark, live] of own.retained) {
    let up: Node | null = mark.parentNode;
    while (up && up !== root) up = up.parentNode;
    if (up && mark.parentNode) mark.parentNode.replaceChild(live, mark);
  }
  for (const [el, ref] of own.refs) ref(liveNode(el));
}

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
      // 增量渲染期间延后到 morph 之后，交给最终留在页面里的那个元素。
      if (session) session.refs.push([el, value as (e: Element) => void]);
      else (value as (e: Element) => void)(el);
    } else if (key === 'dataset') {
      // camelCase keys become kebab-case attributes, mirroring `el.dataset`.
      for (const [k, v] of Object.entries(value as Record<string, string>)) el.setAttribute(`data-${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`, v);
    } else if (key.startsWith('on')) {
      // Listeners only: an `on*` prop is never written as an inline-handler attribute (CSP: no inline script).
      // 监听器挂在元素的处理表上，经固定的跳板分发：morph 复用旧元素时只换表，不残留旧闭包。
      if (typeof value === 'function') setHandler(el, key.slice(2).toLowerCase(), value as EventListener);
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
      parent.appendChild(session ? retainLive(c) : c);
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

export interface RerenderOptions {
  /**
   * 不整树替换，而是把已挂载的树就地 morph 成新树：能配对（同键，或同位置同类）的节点留在页面上，
   * 滚动容器保持位置与进行中的滚动（触控板惯性），hover/焦点/光标不丢，图片不重建；
   * 监听器与 `ref` 跟随留下的节点。
   */
  readonly morph?: boolean;
}

/**
 * Re-render helper that keeps keyboard focus, caret and scroll positions
 * across a full re-render. Inputs opt in with `data-fid`, scroll containers
 * with `data-keep-scroll`.
 */
export function rerender(root: Element, build: () => Node, options: RerenderOptions = {}): void {
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
  const before = new Map<string, HTMLElement>();
  for (const el of root.querySelectorAll<HTMLElement>('[data-keep-scroll]')) {
    const key = el.dataset['keepScroll'];
    if (key) { scrolls.set(key, el.scrollTop); before.set(key, el); }
  }
  if (options.morph && root.firstChild) morphRoot(root, build);
  else mount(root, build());
  for (const el of root.querySelectorAll<HTMLElement>('[data-keep-scroll]')) {
    const key = el.dataset['keepScroll'];
    const pinned = el.dataset['scrollBottom'] === '1';
    // 保留下来的容器本就停在原位：再写回同一偏移只会强制一次同步布局，并可能打断惯性滚动。
    if (pinned) { if (el.scrollHeight - el.clientHeight - el.scrollTop > 1) el.scrollTop = el.scrollHeight; }
    else if (key && scrolls.has(key) && before.get(key) !== el) el.scrollTop = scrolls.get(key) ?? 0;
  }
  if (fid) {
    const next = root.querySelector<HTMLElement>(`[data-fid="${CSS.escape(fid)}"]`);
    if (next) {
      if (document.activeElement !== next) next.focus({ preventScroll: true });
      if (selStart !== null && (next instanceof HTMLInputElement || next instanceof HTMLTextAreaElement) && (next.selectionStart !== selStart || next.selectionEnd !== (selEnd ?? selStart))) {
        try {
          next.setSelectionRange(selStart, selEnd ?? selStart);
        } catch {
          /* type=number etc. */
        }
      }
    }
  }
}
