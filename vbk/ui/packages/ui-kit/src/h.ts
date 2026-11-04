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
/** 无键配对用的「标签 + 首个 class」缓存：无键节点只会被同 kind 的新节点 morph，首个 class 因而在生命周期内不变。 */
const KIND = Symbol('vbk.kind');
type MorphHost = { [SURVIVOR]?: Node; [KEY]?: string | null; [KIND]?: string };

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
const MEDIA_KEY_RANK = KEY_ATTRS.indexOf('data-media-key');
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
  const host = node as MorphHost;
  const cached = host[KIND];
  if (cached !== undefined) return cached;
  const cls = (node as Element).getAttribute('class') ?? '';
  const space = cls.indexOf(' ');
  return (host[KIND] = `${node.nodeName}.${space < 0 ? cls : cls.slice(0, space)}`);
}

function syncAttributes(from: Element, to: Element): void {
  if (from === to) return;
  const next = to.attributes;
  const count = next.length;
  for (let i = 0; i < count; i++) {
    const attr = next[i]!;
    const name = attr.name, value = attr.value;
    if (from.getAttribute(name) !== value) from.setAttribute(name, value);
  }
  // 此时 from 的属性已包含 to 的全部；个数相同即完全一致，省掉逐个反查。
  const prev = from.attributes;
  if (prev.length === count) return;
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
  const first = to.firstChild;
  if (first || from.firstChild) morphChildren(from, first, null, used);
  syncFormState(from, to);
  (next as MorphHost)[SURVIVOR] = old;
  return old;
}

/** 无键配对时从游标起最多考察的旧节点数。 */
const UNKEYED_WINDOW = 8;
/**
 * 各层 morphChildren 的配对结果栈（新子节点 i → 留在树上的节点）。morph 是深度优先递归，每层只用自己压入的那一段，
 * 返回前截断；共用一个数组省掉每个父节点一次分配。
 */
const plan: Node[] = [];

/**
 * 把 `parent` 的子节点就地 morph 成新子节点序列 `first ..< stop`（兄弟链，`stop` 为 null 即到末尾）。
 * 新节点一般仍挂在新树的父节点下，放置时才被 insertBefore 搬进 `parent`，因此每次都先取 nextSibling 再动节点。
 */
function morphChildren(parent: Node, first: Node | null, stop: Node | null, used: Set<Node>): void {
  const retained = session?.retained;
  // 带键旧节点表只在新序列里真的出现带键节点时才建（首个同键节点胜出，与按序扫描一致）。
  let keyed: Map<string, Node> | null = null;
  /** 最近一次无键配对到的旧节点：下一次从它后面开始找，游标只前进。 */
  let last: Node | null = null;
  const base = plan.length;
  try {
    for (let node: Node | null = first; node && node !== stop; node = node.nextSibling) {
      const kept = node.nodeType === 8 && retained ? retained.get(node as Comment) : undefined;
      if (kept) { used.add(kept); plan.push(kept); continue; }
      let match: Node | undefined;
      const key = keyOf(node);
      if (key !== null) {
        if (!keyed) {
          keyed = new Map();
          for (let old = parent.firstChild; old; old = old.nextSibling) {
            const k = keyOf(old);
            if (k !== null && !keyed.has(k)) keyed.set(k, old);
          }
        }
        match = keyed.get(key);
      } else {
        const kind = kindOf(node);
        // 上一个配对到的旧节点若已被嵌套 morph 搬进了兄弟子树（它是别处保留的活节点），其兄弟链不再属于 parent，不再往后找。
        let candidate: Node | null = last ? (last.parentNode === parent ? last.nextSibling : null) : parent.firstChild;
        for (let seen = 0; candidate && seen < UNKEYED_WINDOW; candidate = candidate.nextSibling) {
          if (keyOf(candidate) !== null) continue;
          seen++;
          if (!used.has(candidate) && kindOf(candidate) === kind) { match = candidate; last = candidate; break; }
        }
      }
      if (match && !used.has(match)) {
        used.add(match);
        const result = morphNode(match, node, used);
        if (result !== match) used.delete(match);
        plan.push(result);
      } else plan.push(node);
    }
    for (let old: Node | null = parent.firstChild, next: Node | null; old; old = next) {
      next = old.nextSibling;
      if (!used.has(old)) parent.removeChild(old);
    }
    // 常见情况下配对节点相对顺序不变，因此不会被移动（移动 = 先脱离文档）。
    let at: Node | null = parent.firstChild;
    let i = base;
    for (let node: Node | null = first, next: Node | null; node && node !== stop; node = next) {
      next = node.nextSibling;
      const target = plan[i++]!;
      if (target === at) { at = at.nextSibling; continue; }
      parent.insertBefore(target, at);
    }
  } finally {
    plan.length = base;
  }
}

/** 把 `root` 的子树就地 morph 成 `build()` 的结果，能配对的节点全部保留。 */
function morphRoot(root: Element, build: () => Node): void {
  const own: BuildSession = { refs: [], retained: new Map() };
  const outer = session;
  session = own;
  try {
    const next = build();
    // 单个节点时只 morph 它自己：它可能是已挂载的活节点，不能顺着兄弟链把 root 的其他子节点也当成新序列。
    if (next.nodeType === 11) morphChildren(root, next.firstChild, null, new Set());
    else morphChildren(root, next, next.nextSibling, new Set());
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
      const record = v as Record<string, boolean>;
      for (const k in record) if (record[k]) out.push(k);
    }
  }
  return out.join(' ');
}

/** dataset 键 camelCase → `data-*` 属性名的缓存（键的种类有限，正则替换只做一次）。 */
const DATA_ATTR = new Map<string, string>();
function dataAttr(key: string): string {
  let name = DATA_ATTR.get(key);
  if (name === undefined) DATA_ATTR.set(key, (name = `data-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`));
  return name;
}

/** 键属性的优先级（KEY_ATTRS 下标），非键属性为 -1。属性名以 `data-` 开头时才查。 */
function keyRank(name: string): number {
  return name.charCodeAt(0) === 100 /* d */ && name.startsWith('data-') ? KEY_ATTRS.indexOf(name) : -1;
}

function applyProps(el: HTMLElement | SVGElement, props: Props): void {
  if (!props) { (el as unknown as MorphHost)[KEY] = null; return; }
  // 建树时顺手定下配对键，morph 时就不必对每个新元素逐个 getAttribute 试探 KEY_ATTRS。
  let rank = KEY_ATTRS.length, keyName = '', keyValue = '';
  for (const key in props) {
    const value = props[key];
    if (value === null || value === undefined || value === false) {
      if (key === 'value') (el as HTMLInputElement).value = '';
      continue;
    }
    if (key === 'class') {
      const cls = cx(value as ClassValue);
      if (cls) el.setAttribute('class', cls);
    } else if (key === 'style') {
      if (typeof value === 'string') el.setAttribute('style', value);
      else {
        const record = value as Record<string, string>;
        for (const k in record) el.style.setProperty(k, record[k]!);
      }
    } else if (key === 'ref') {
      // 增量渲染期间延后到 morph 之后，交给最终留在页面里的那个元素。
      if (session) session.refs.push([el, value as (e: Element) => void]);
      else (value as (e: Element) => void)(el);
    } else if (key === 'dataset') {
      // camelCase keys become kebab-case attributes, mirroring `el.dataset`.
      const record = value as Record<string, string>;
      for (const k in record) {
        const name = dataAttr(k), v = String(record[k]);
        el.setAttribute(name, v);
        const r = keyRank(name);
        if (r >= 0 && r < rank) { rank = r; keyName = name; keyValue = v; }
      }
    } else if (key.startsWith('on')) {
      // Listeners only: an `on*` prop is never written as an inline-handler attribute (CSP: no inline script).
      // 监听器挂在元素的处理表上，经固定的跳板分发：morph 复用旧元素时只换表，不残留旧闭包。
      if (typeof value === 'function') setHandler(el, key.slice(2).toLowerCase(), value as EventListener);
    } else if (BOOL_PROPS.has(key)) {
      (el as unknown as Record<string, unknown>)[key] = value === true;
    } else if (key === 'value') {
      (el as HTMLInputElement).value = String(value);
    } else {
      const v = value === true ? '' : String(value);
      el.setAttribute(key, v);
      const r = keyRank(key);
      if (r >= 0 && r < rank) { rank = r; keyName = key; keyValue = v; }
    }
  }
  // 媒体键要连同 src 一起算，而 src 可能在建树之后才设置：留给 morph 时的 computeKey 按原规则处理。
  if (rank !== MEDIA_KEY_RANK) (el as unknown as MorphHost)[KEY] = rank === KEY_ATTRS.length ? null : `${el.nodeName}|${keyName}|${keyValue}`;
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
