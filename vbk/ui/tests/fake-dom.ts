/**
 * 测试用的最小 DOM：只覆盖 ui-kit `h`/`rerender` 用到的接口，并统计
 * 「创建了多少元素」「有多少节点被插入/移出已连接的树」「哪些滚动容器被拔出过文档」，
 * 用来给增量渲染做计数型回归保护。无依赖，不跑布局。
 */

/** attached/detached 按进入/离开文档的节点数（含子孙）计。 */
export interface DomCounters { created: number; attached: number; detached: number; scrollResets: number }

let counters: DomCounters = { created: 0, attached: 0, detached: 0, scrollResets: 0 };
export function resetCounters(): DomCounters { counters = { created: 0, attached: 0, detached: 0, scrollResets: 0 }; return counters; }
export function readCounters(): DomCounters { return { ...counters }; }

type Listener = (event: FakeEvent) => void;
export interface FakeEvent { type: string; target: FakeNode; currentTarget: FakeNode | null }

export class FakeNode {
  nodeType: number;
  nodeName: string;
  parentNode: FakeNode | null = null;
  readonly childNodes: FakeNode[] = [];
  data = '';
  /** 被当作文档根（document.body）的节点。 */
  root = false;
  constructor(nodeType: number, nodeName: string) { this.nodeType = nodeType; this.nodeName = nodeName; }
  get firstChild(): FakeNode | null { return this.childNodes[0] ?? null; }
  get nextSibling(): FakeNode | null { const p = this.parentNode; if (!p) return null; return p.childNodes[p.childNodes.indexOf(this) + 1] ?? null; }
  get isConnected(): boolean { let n: FakeNode | null = this; while (n) { if (n.root) return true; n = n.parentNode; } return false; }
  get textContent(): string { return this.nodeType === 3 ? this.data : this.childNodes.map(c => c.textContent).join(''); }
  set textContent(value: string) { for (const c of [...this.childNodes]) this.removeChild(c); if (value) this.appendChild(fakeDocument.createTextNode(value)); }
  #detach(node: FakeNode): void {
    const p = node.parentNode;
    if (!p) return;
    const connected = node.isConnected;
    p.childNodes.splice(p.childNodes.indexOf(node), 1);
    node.parentNode = null;
    if (connected) { counters.detached += subtreeSize(node); markDetached(node); }
  }
  insertBefore<T extends FakeNode>(node: T, ref: FakeNode | null): T {
    if (node.nodeType === 11) { for (const c of [...node.childNodes]) this.insertBefore(c, ref); return node; }
    this.#detach(node);
    const at = ref ? this.childNodes.indexOf(ref) : -1;
    if (at < 0) this.childNodes.push(node); else this.childNodes.splice(at, 0, node);
    node.parentNode = this;
    if (this.isConnected) counters.attached += subtreeSize(node);
    return node;
  }
  appendChild<T extends FakeNode>(node: T): T { return this.insertBefore(node, null); }
  removeChild<T extends FakeNode>(node: T): T { this.#detach(node); return node; }
  replaceChild<T extends FakeNode>(node: FakeNode, old: T): T { this.insertBefore(node, old); this.#detach(old); return old; }
  replaceChildren(...nodes: FakeNode[]): void { for (const c of [...this.childNodes]) this.removeChild(c); for (const n of nodes) this.appendChild(n); }
  replaceWith(node: FakeNode): void { this.parentNode?.replaceChild(node, this); }
}

function subtreeSize(node: FakeNode): number { let n = 1; for (const c of node.childNodes) n += subtreeSize(c); return n; }

/** 脱离文档的滚动容器丢掉滚动位置（真实浏览器里同时丢掉进行中的滚动手势）。 */
function markDetached(node: FakeNode): void {
  if (node instanceof FakeElement && node.scrollTop !== 0) { node.scrollTop = 0; counters.scrollResets++; }
  for (const c of node.childNodes) markDetached(c);
}

export class FakeElement extends FakeNode {
  readonly attrs = new Map<string, string>();
  readonly listeners = new Map<string, Set<Listener>>();
  value = '';
  checked = false;
  selected = false;
  disabled = false;
  hidden = false;
  scrollTop = 0;
  clientHeight = 400;
  scrollHeight = 1000;
  shadowRoot: FakeNode | null = null;
  constructor(tag: string) { super(1, tag.toUpperCase()); counters.created++; }
  get tagName(): string { return this.nodeName; }
  get attributes(): { name: string; value: string }[] { return [...this.attrs].map(([name, value]) => ({ name, value })); }
  getAttribute(name: string): string | null { return this.attrs.get(name) ?? null; }
  hasAttribute(name: string): boolean { return this.attrs.has(name); }
  setAttribute(name: string, value: string): void { this.attrs.set(name, String(value)); }
  removeAttribute(name: string): void { this.attrs.delete(name); }
  get className(): string { return this.attrs.get('class') ?? ''; }
  get dataset(): Record<string, string | undefined> {
    const el = this;
    const attr = (k: string) => `data-${k.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`;
    return new Proxy({}, {
      get: (_t, k) => (typeof k === 'string' ? el.getAttribute(attr(k)) ?? undefined : undefined),
      set: (_t, k, v) => { if (typeof k === 'string') el.setAttribute(attr(k), String(v)); return true; },
    }) as Record<string, string | undefined>;
  }
  get style() { const el = this; return { setProperty(k: string, v: string) { const prev = el.getAttribute('style'); el.setAttribute('style', `${prev ? `${prev} ` : ''}${k}: ${v};`); } }; }
  addEventListener(type: string, fn: Listener): void { let set = this.listeners.get(type); if (!set) this.listeners.set(type, set = new Set()); set.add(fn); }
  removeEventListener(type: string, fn: Listener): void { this.listeners.get(type)?.delete(fn); }
  dispatch(type: string): void { const event: FakeEvent = { type, target: this, currentTarget: this }; for (const fn of this.listeners.get(type) ?? []) fn.call(this, event); }
  focus(): void { fakeDocument.activeElement = this; }
  #all(): FakeElement[] { const out: FakeElement[] = []; const walk = (n: FakeNode) => { for (const c of n.childNodes) { if (c instanceof FakeElement) { out.push(c); walk(c); } } }; walk(this); return out; }
  /** 仅支持 `tag`、`[attr]`、`[attr="v"]` 及其组合。 */
  querySelectorAll(selector: string): FakeElement[] {
    const m = /^([a-z]*)((?:\[[^\]]+\])*)$/i.exec(selector.trim());
    if (!m) throw new Error(`unsupported selector ${selector}`);
    const tag = m[1]!.toUpperCase();
    const conds = [...m[2]!.matchAll(/\[([^\]=]+)(?:="([^"]*)")?\]/g)].map(x => [x[1]!, x[2]] as const);
    return this.#all().filter(el => (!tag || el.nodeName === tag) && conds.every(([k, v]) => (v === undefined ? el.hasAttribute(k) : el.getAttribute(k) === decodeURIComponent(v))));
  }
  querySelector(selector: string): FakeElement | null { return this.querySelectorAll(selector)[0] ?? null; }
}

export const fakeDocument = {
  activeElement: null as FakeElement | null,
  body: (() => { const b = new FakeElement('body'); b.root = true; return b; })(),
  createElement: (tag: string) => new FakeElement(tag),
  createElementNS: (_ns: string, tag: string) => { const el = new FakeElement(tag); el.nodeName = tag; return el; },
  createTextNode: (text: string) => { const n = new FakeNode(3, '#text'); n.data = text; return n; },
  createComment: (text: string) => { const n = new FakeNode(8, '#comment'); n.data = text; return n; },
  createDocumentFragment: () => new FakeNode(11, '#document-fragment'),
};

/** 把假 DOM 装到 globalThis 上（`h.ts` 通过全局 `document`/`Node` 工作）。 */
export function installFakeDom(): { root: FakeElement } {
  const g = globalThis as Record<string, unknown>;
  g['document'] = fakeDocument;
  g['Node'] = FakeNode;
  g['CSS'] = { escape: encodeURIComponent };
  g['HTMLInputElement'] ??= class {};
  g['HTMLTextAreaElement'] ??= class {};
  fakeDocument.body.replaceChildren();
  const root = new FakeElement('div');
  fakeDocument.body.appendChild(root);
  resetCounters();
  return { root };
}
