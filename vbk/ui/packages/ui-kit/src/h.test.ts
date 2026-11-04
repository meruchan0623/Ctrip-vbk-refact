import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeElement, installFakeDom, readCounters, resetCounters, fakeDocument } from '../../../tests/fake-dom.ts';
import { h, rerender } from './h.ts';

const { root } = installFakeDom();
const dom = root as unknown as Element;
const ROW = 96;

/** 与主窗会话列表同构：头部 + 一个 data-keep-scroll 的窗口化列表（上下占位 + 可见行，每行一个头像 img）。 */
function app(state: { top: number; total: number; selected: number; tick: number }, onRow: (i: number) => void = () => {}): Node {
  const first = Math.max(0, Math.floor(state.top / ROW) - 6), last = Math.min(state.total, first + Math.ceil(900 / ROW) + 12);
  const rows = [];
  for (let i = first; i < last; i++) {
    rows.push(h('div', { class: ['conv', i === state.selected ? 'on' : null], dataset: { gid: `g${i}` }, onclick: () => onRow(i) },
      h('div', { class: 'ava' }, h('img', { src: `https://example.invalid/a${i}.png`, alt: '' })),
      h('div', { class: 'conv-main' }, h('span', { class: 'cname' }, `客户 ${i}`), h('span', { class: 'ctime' }, `${state.tick}s`))));
  }
  return h('div', { class: 'app' },
    h('div', { class: 'clist-h' }, h('input', { class: 'inp', value: '', dataset: { fid: 'search' } })),
    h('div', { class: 'cscroll', dataset: { keepScroll: 'clist' } },
      h('div', { style: { height: `${first * ROW}px` } }), rows, h('div', { style: { height: `${(state.total - last) * ROW}px` } })));
}

function scrollSteps(morph: boolean) {
  root.replaceChildren();
  const state = { top: 0, total: 500, selected: 3, tick: 0 };
  rerender(dom, () => app(state));
  const pane = () => root.querySelector('[data-keep-scroll="clist"]')!;
  const first = pane();
  resetCounters();
  const steps = 20;
  for (let i = 1; i <= steps; i++) {
    state.top = i * ROW; // 每步滚过一行：窗口前移一行，触发一次 store.patch → 一次渲染
    pane().scrollTop = state.top;
    rerender(dom, () => app(state), { morph });
  }
  const c = readCounters();
  return { ...c, steps, sameScroller: pane() === first, scrollTop: pane().scrollTop };
}

test('滚动一行触发的重渲染：morph 不拔出滚动容器、只新建进入窗口的行（整树替换的对照数字一并断言）', () => {
  const full = scrollSteps(false), morph = scrollSteps(true);
  // 整树替换：每次渲染都把 .cscroll（连同所有行）拔出文档再重建，滚动位置靠事后写回，惯性滚动随之中断。
  assert.equal(full.sameScroller, false);
  assert.ok(full.detached >= full.steps, `full detached ${full.detached}`);
  assert.ok(full.attached / full.steps > 100, `full attached/render ${full.attached / full.steps}`);
  assert.ok(full.scrollResets >= full.steps);
  // morph：滚动容器始终是同一个节点、从未离开文档，scrollTop 不需要写回；
  // 每步只有进入窗口的那一行（≈ 9 个节点）插入文档、滑出的一行移出文档——其余节点（含头像 img）原样保留。
  assert.equal(morph.sameScroller, true);
  assert.equal(morph.scrollResets, 0);
  assert.equal(morph.scrollTop, 20 * ROW);
  assert.ok(morph.attached / morph.steps <= 12, `morph attached/render ${morph.attached / morph.steps}`);
  assert.ok(morph.detached / morph.steps <= 12, `morph detached/render ${morph.detached / morph.steps}`);
  console.log(`[h.test] 每次滚动渲染：整树替换 插入文档 ${full.attached / full.steps} 个节点、移出 ${full.detached / full.steps} 次、滚动位置清零 ${full.scrollResets / full.steps} 次；morph 插入 ${morph.attached / morph.steps}、移出 ${morph.detached / morph.steps}、清零 ${morph.scrollResets}`);
});

test('morph 后监听器指向最新一次渲染的闭包，ref 拿到留在页面上的元素', () => {
  root.replaceChildren();
  const clicks: string[] = [];
  let seen: Element | null = null;
  const view = (label: string) => h('div', { class: 'app' }, h('button', { class: 'btn', dataset: { fid: 'b' }, onclick: () => clicks.push(label), ref: (el: Element) => { seen = el; } }, label));
  rerender(dom, () => view('v1'));
  const button = root.querySelector('button')!;
  rerender(dom, () => view('v2'), { morph: true });
  assert.equal(root.querySelector('button'), button, '同一个按钮被复用');
  assert.equal(seen, button, 'ref 指向页面上的按钮而不是被丢弃的新节点');
  button.dispatch('click');
  assert.deepEqual(clicks, ['v2'], '只调用最新闭包，一次');
  assert.equal(button.textContent, 'v2');
});

test('传入一个已挂载的缓存子树：原地保留不移动，缓存节点上的属性改动同步到活节点', () => {
  root.replaceChildren();
  let cache: HTMLElement | null = null;
  let builds = 0;
  const pane = (pinned: boolean) => {
    if (cache) { cache.dataset['scrollBottom'] = pinned ? '1' : '0'; return cache; }
    builds++;
    cache = h('div', { class: 'msgs', dataset: { keepScroll: 'msgs', scrollBottom: '0' } }, h('div', { dataset: { rowId: 'm:1' } }, 'a'), h('div', { dataset: { rowId: 'm:2' } }, 'b'));
    return cache;
  };
  const view = (n: number, pinned: boolean) => h('div', { class: 'chat' }, h('div', { class: 'chat-h' }, `n=${n}`), pane(pinned), h('div', { class: 'composer' }));
  rerender(dom, () => view(0, false));
  const live = root.querySelector('[data-keep-scroll="msgs"]')!;
  live.scrollTop = 120;
  resetCounters();
  rerender(dom, () => view(1, false), { morph: true });
  rerender(dom, () => view(2, false), { morph: true });
  assert.equal(builds, 1);
  assert.equal(root.querySelector('[data-keep-scroll="msgs"]'), live);
  assert.equal(readCounters().detached, 0, '缓存的消息面板没有被拔出文档');
  assert.equal(live.scrollTop, 120);
  // 缓存命中后改的属性（贴底标记）落到活节点上。
  cache = null; rerender(dom, () => view(3, false), { morph: true });
  const rebuilt = cache as unknown as FakeElement;
  assert.equal(root.querySelector('[data-keep-scroll="msgs"]'), live, '重建的面板被折叠进活节点');
  assert.notEqual(rebuilt, live);
  rerender(dom, () => view(4, true), { morph: true });
  assert.equal(live.getAttribute('data-scroll-bottom'), '1');
  assert.equal(live.querySelectorAll('[data-row-id]').length, 2, '被折叠过的缓存再次传入时用活节点，不会拿残缺的旧子树覆盖');
});

test('焦点输入框：值相同时不回写，值不同才写；被替换的节点恢复焦点', () => {
  root.replaceChildren();
  const view = (value: string, tag = 'input') => h('div', { class: 'app' }, h(tag, { class: 'inp', value, dataset: { fid: 'search' } }));
  rerender(dom, () => view('ab'));
  const input = root.querySelector('input')!;
  input.focus();
  let writes = 0;
  let current = 'ab';
  Object.defineProperty(input, 'value', { get: () => current, set: (v: string) => { writes++; current = v; } });
  rerender(dom, () => view('ab'), { morph: true });
  assert.equal(writes, 0);
  assert.equal(fakeDocument.activeElement, input);
  rerender(dom, () => view('abc'), { morph: true });
  assert.equal(writes, 1);
  assert.equal(current, 'abc');
});

test('媒体元素：只有非空 data-media-key 且 src 相同才复用；空 key 永不复用', () => {
  root.replaceChildren();
  const view = (key: string, src: string) => h('div', { class: 'msg', dataset: { rowId: 'm:1' } }, h('video', { class: 'media-video', src, dataset: { mediaKey: key } }));
  rerender(dom, () => view('k', 'https://example.invalid/a.mp4'));
  const video = root.querySelector('video');
  rerender(dom, () => view('k', 'https://example.invalid/a.mp4'), { morph: true });
  assert.equal(root.querySelector('video'), video);
  rerender(dom, () => view('k', 'https://example.invalid/b.mp4'), { morph: true });
  assert.notEqual(root.querySelector('video'), video, '地址变了就换新节点');
  const other = root.querySelector('video');
  rerender(dom, () => view('', 'https://example.invalid/b.mp4'), { morph: true });
  const unkeyed = root.querySelector('video');
  assert.notEqual(unkeyed, other);
  rerender(dom, () => view('', 'https://example.invalid/b.mp4'), { morph: true });
  assert.notEqual(root.querySelector('video'), unkeyed, '身份不完整的媒体每次都是新节点');
});

test('shadow host 不做子树 morph，整体替换（与整树渲染一致）', () => {
  root.replaceChildren();
  const view = (label: string) => { const host = h('div', { class: 'companion-card' }); (host as unknown as FakeElement).shadowRoot = fakeDocument.createDocumentFragment(); host.dataset['label'] = label; return h('div', { class: 'side' }, host); };
  rerender(dom, () => view('a'));
  const first = root.querySelector('div[data-label]');
  rerender(dom, () => view('b'), { morph: true });
  assert.notEqual(root.querySelector('div[data-label]'), first);
  assert.equal(root.querySelector('div[data-label]')!.getAttribute('data-label'), 'b');
});

test('无键的可选兄弟出现/消失不会让后面的带键滚动容器移动', () => {
  root.replaceChildren();
  const view = (offline: boolean) => h('div', { class: 'clist' }, h('div', { class: 'clist-h' }), offline ? h('div', { class: 'netbar' }, '离线') : null, h('div', { class: 'cscroll', dataset: { keepScroll: 'clist' } }, h('div', { dataset: { gid: 'g1' } })));
  rerender(dom, () => view(false));
  const scroller = root.querySelector('[data-keep-scroll="clist"]')!;
  scroller.scrollTop = 300;
  resetCounters();
  rerender(dom, () => view(true), { morph: true });
  rerender(dom, () => view(false), { morph: true });
  assert.equal(root.querySelector('[data-keep-scroll="clist"]'), scroller);
  assert.equal(scroller.scrollTop, 300);
  assert.equal(readCounters().scrollResets, 0);
  assert.equal(readCounters().detached, 2, "只有 netbar 自己（元素 + 文本）被移除");
});

test('配对键在建树时定下：多个键属性并存时仍按 data-key > data-row-id > data-gid 的优先级，与属性写入顺序无关', () => {
  root.replaceChildren();
  const row = (gid: string, key: string, label: string) => h('div', { class: 'row', dataset: { gid, key }, 'data-row-id': `r-${label}` }, label);
  rerender(dom, () => h('div', { class: 'list' }, row('g1', 'k1', 'a'), row('g2', 'k2', 'b')));
  const [a, b] = root.querySelectorAll('div[data-key]');
  // 顺序调换 + gid/row-id 都变：只要 data-key 相同就复用原节点。
  rerender(dom, () => h('div', { class: 'list' }, row('g9', 'k2', 'b2'), row('g8', 'k1', 'a2')), { morph: true });
  const after = root.querySelectorAll('div[data-key]');
  assert.equal(after[0], b);
  assert.equal(after[1], a);
  assert.equal(a!.textContent, 'a2');
  assert.equal(a!.getAttribute('data-gid'), 'g8');
  // data-key 变了，即便 gid 相同也不复用。
  rerender(dom, () => h('div', { class: 'list' }, row('g9', 'k3', 'c'), row('g8', 'k1', 'a3')), { morph: true });
  const third = root.querySelectorAll('div[data-key]');
  assert.notEqual(third[0], b);
  assert.equal(third[1], a);
  // 不传 props 的元素按同类无键配对。
  const plain = () => h('div', { class: 'wrap' }, h('b', null, 'x'), h('i', null, 'y'));
  rerender(dom, () => plain());
  const bold = root.querySelector('b');
  rerender(dom, () => plain(), { morph: true });
  assert.equal(root.querySelector('b'), bold);
});

test('build() 返回单个已挂载的活节点时：它原地保留，root 里多出来的兄弟被移除而不是被当作新序列', () => {
  root.replaceChildren();
  const live = h('div', { class: 'pane' }, h('span', { class: 't' }, 'v1'));
  rerender(dom, () => live);
  const extra = h('div', { class: 'extra' });
  root.appendChild(extra as unknown as FakeElement);
  resetCounters();
  rerender(dom, () => live, { morph: true });
  assert.equal(root.childNodes.length, 1);
  assert.equal(root.childNodes[0], live);
  assert.equal(readCounters().detached, 1, '只有 extra 被移出文档，live 从未离开');
  assert.equal(readCounters().created, 0);
});
