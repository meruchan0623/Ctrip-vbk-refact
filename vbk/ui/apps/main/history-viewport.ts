import { createStore } from '../../packages/ui-kit/src/store.ts';

export interface HistoryReadingAnchor { readonly scope: string; readonly key: string; readonly offset: number; readonly top: number }
/** Independent view-state store: scrolling does not rebuild the app or interrupt IME.
 * One active account/conversation is retained; an account generation switch clears it. */
export const historyReadingStore = createStore<HistoryReadingAnchor | null>(null);

/** Fenwick height index: resize and offset lookup are O(log n), with no DOM scans. */
export class HistoryHeightIndex {
  private readonly heights: number[];
  private readonly tree: number[];
  constructor(count: number, estimate = 110) {
    this.heights = Array(count).fill(estimate); this.tree = Array(count + 1).fill(0);
    for (let i = 0; i < count; i++) {
      this.tree[i + 1]! += estimate;
      const parent = (i + 1) + ((i + 1) & -(i + 1));
      if (parent <= count) this.tree[parent]! += this.tree[i + 1]!;
    }
  }
  get count(): number { return this.heights.length; }
  prefix(end: number): number {
    let sum = 0;
    for (let i = Math.min(this.count, Math.max(0, end)); i > 0; i -= i & -i) sum += this.tree[i]!;
    return sum;
  }
  measure(index: number, height: number): boolean {
    if (index < 0 || index >= this.count || !Number.isFinite(height) || height <= 0) return false;
    const delta = height - this.heights[index]!;
    if (Math.abs(delta) < 0.25) return false;
    this.heights[index] = height;
    for (let i = index + 1; i <= this.count; i += i & -i) this.tree[i]! += delta;
    return true;
  }
  at(offset: number): number {
    if (!this.count) return 0;
    let index = 0, sum = 0, bit = 1;
    while (bit * 2 <= this.count) bit *= 2;
    for (; bit; bit >>= 1) {
      const next = index + bit;
      if (next <= this.count && sum + this.tree[next]! <= offset) { sum += this.tree[next]!; index = next; }
    }
    return Math.min(index, this.count - 1);
  }
  range(top: number, height: number, overscan = 600): { start: number; end: number } {
    if (!this.count) return { start: 0, end: 0 };
    return { start: this.at(Math.max(0, top - overscan)), end: Math.min(this.count, this.at(Math.max(0, top) + Math.max(1, height) + overscan) + 1) };
  }
}

export interface HistoryViewportOptions {
  scroll: HTMLElement;
  content: HTMLElement;
  keys: readonly string[];
  render(index: number): HTMLElement;
  initialTop: number;
  initialHeight: number;
  measured: Map<string, number>;
  /** Only unique, compatible IDs may supply a pre-render reading anchor. */
  initialAnchor?: { index: number; offset: number } | undefined;
  changed(): void;
  current(): boolean;
}

/** Bounded, measured row window. Scroll updates replace only the message window;
 * the editor, focused controls and browser-owned composition remain mounted. */
export function createHistoryViewport(options: HistoryViewportOptions): { mount(): void; dispose(): void } {
  const { scroll, content, keys, measured } = options;
  const document = content.ownerDocument, heights = new HistoryHeightIndex(keys.length);
  const counts = new Map<string, number>();
  for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  keys.forEach((key, index) => { const value = counts.get(key) === 1 ? measured.get(key) : undefined; if (value) heights.measure(index, value); });
  const top = document.createElement('div'), bottom = document.createElement('div');
  top.setAttribute('aria-hidden', 'true'); bottom.setAttribute('aria-hidden', 'true');
  top.dataset['historySpacer'] = 'top'; bottom.dataset['historySpacer'] = 'bottom';
  let range = { start: -1, end: -1 }, mounted = false, disposed = false, frame: number | null = null;
  let observer: ResizeObserver | undefined;
  let slots = new Map<number, HTMLElement>();
  const contentTop = (): number => content.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop;
  const firstTop = options.initialAnchor ? heights.prefix(options.initialAnchor.index) - options.initialAnchor.offset : options.initialTop;
  let lastTop = options.initialTop;
  function paint(offset: number, height: number): void {
    const next = heights.range(offset, height);
    top.style.height = `${heights.prefix(next.start)}px`;
    bottom.style.height = `${heights.prefix(heights.count) - heights.prefix(next.end)}px`;
    if (next.start === range.start && next.end === range.end) return;
    const focused = document.activeElement;
    // A focused media/control row remains mounted until focus leaves it. This keeps
    // keyboard interaction stable without retaining every off-screen message.
    for (const [index, slot] of slots) if (focused && slot.contains(focused)) { next.start = Math.min(next.start, index); next.end = Math.max(next.end, index + 1); }
    const nextSlots = new Map<number, HTMLElement>();
    for (let index = next.start; index < next.end; index++) {
      let slot = slots.get(index);
      if (!slot) {
        slot = document.createElement('div'); slot.dataset['historySlot'] = String(index);
        slot.style.paddingBottom = '14px'; slot.style.display = 'flow-root';
        slot.appendChild(options.render(index));
      }
      nextSlots.set(index, slot);
    }
    for (const [index, slot] of slots) if (!nextSlots.has(index)) observer?.unobserve(slot);
    const wanted = [top, ...nextSlots.values(), bottom];
    // Move only nodes that changed; replacing the entire container would blur a
    // retained control and restart playing media even if its row stayed in range.
    let cursor = content.firstChild;
    for (const node of wanted) {
      if (cursor === node) cursor = cursor.nextSibling;
      else content.insertBefore(node, cursor);
    }
    while (cursor) { const nextNode = cursor.nextSibling; content.removeChild(cursor); cursor = nextNode; }
    slots = nextSlots; range = next;
    top.style.height = `${heights.prefix(next.start)}px`;
    bottom.style.height = `${heights.prefix(heights.count) - heights.prefix(next.end)}px`;
    for (const slot of slots.values()) observer?.observe(slot);
  }
  function measure(): void {
    if (!mounted || disposed || !options.current()) return;
    const localTop = Math.max(0, scroll.scrollTop - contentTop());
    const reading = heights.at(localTop), offset = heights.prefix(reading) - localTop;
    const pinned = scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop < 48;
    let changed = false;
    for (const [index, slot] of slots) {
      const height = slot.getBoundingClientRect().height;
      if (heights.measure(index, height)) changed = true;
      const key = keys[index]!;
      if (height > 0 && counts.get(key) === 1) measured.set(key, height);
    }
    if (!changed) return;
    paint(localTop, scroll.clientHeight);
    if (pinned) scroll.scrollTop = scroll.scrollHeight;
    else scroll.scrollTop = contentTop() + heights.prefix(reading) - offset;
    lastTop = scroll.scrollTop;
    options.changed();
  }
  const schedule = (): void => {
    if (disposed || frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      if (disposed || !mounted || !options.current()) return;
      paint(Math.max(0, scroll.scrollTop - contentTop()), scroll.clientHeight);
      measure(); options.changed();
    });
  };
  const onScroll = (): void => {
    if (scroll.scrollTop !== lastTop) lastTop = scroll.scrollTop;
    schedule();
  };
  const initialHeight = options.initialHeight || 600;
  paint(Math.max(0, Math.min(firstTop, heights.prefix(heights.count) - initialHeight)), initialHeight);
  return {
    mount() {
      if (mounted || disposed || !options.current()) return;
      mounted = true;
      if (typeof ResizeObserver !== 'undefined') {
        observer = new ResizeObserver(() => { measure(); schedule(); });
        observer.observe(scroll); for (const slot of slots.values()) observer.observe(slot);
      }
      scroll.addEventListener('scroll', onScroll, { passive: true });
      measure(); schedule();
    },
    dispose() {
      disposed = true; observer?.disconnect(); scroll.removeEventListener('scroll', onScroll);
      if (frame !== null) cancelAnimationFrame(frame);
      slots.clear();
    },
  };
}
