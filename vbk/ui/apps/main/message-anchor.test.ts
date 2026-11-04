// The real main.ts glue (capture/restore/withMessageAnchor, messagePane, chatPane, frame subscriber)
// driven against a small layout engine instead of a browser. Geometry is explicitly virtual.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import * as viewmodel from './viewmodel.ts';
import { historyDiagnostics } from './history-diagnostics.ts';
import { createHistoryLayoutFrames, observeHistoryLayout } from './history-layout.ts';
import { createMessagePane, HISTORY_RUNWAY, PIN_THRESHOLD, sameWindow } from './message-pane.ts';
import { messageAlignment } from './message-alignment.ts';
import { cx } from '../../packages/ui-kit/src/h.ts';
import { createStore, subscribeBatched } from '../../packages/ui-kit/src/store.ts';
import type { UiMessage } from '../../packages/ipc/src/client.ts';

const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
const GID = 'synthetic-anchor-room';
const OWNER = { account_id: 'synthetic-account', environment: 'synthetic', session_generation: 1 };
const msg = (id: string, t: number, extra: Partial<UiMessage> = {}): UiMessage => ({ gid: GID, message_id: id, local_id: null, text: 'SYNTHETIC BODY ' + id, kind: 'text', create_time_ms: t, sender_role: 'customer', sender_id: 'synthetic-customer', sender_name: null, sender_avatar: null, disposition: null, translation: null, original: null, quote: null, order_id: null, ...extra });
const thread = (n: number, from = 0): UiMessage[] => Array.from({ length: n }, (_, i) => msg(`m${from + i}`, 1000 + from + i));

interface Node { tag: string; props: Record<string, any>; children: unknown[] }
const flat = (tree: unknown): unknown[] => (Array.isArray(tree) ? tree.flatMap(flat) : [tree]);

class Pane {
  top = 0; clientHeight = 400; clientWidth = 600; measurements = 0; dataset: Record<string, string>; isConnected = true;
  readonly parts: { kind: 'row' | 'spacer' | 'other'; height: number; dataset: Record<string, string> }[] = [];
  listener: (() => void) | undefined;
  constructor(node: Node, rowHeight: (id: string) => number) {
    this.dataset = { ...(node.props['dataset'] ?? {}) };
    for (const child of flat(node.children) as (Node | null)[]) {
      if (!child || typeof child !== 'object') continue;
      const d = child.props?.['dataset'] ?? {};
      if (d['rowId']) this.parts.push({ kind: 'row', height: rowHeight(d['rowId']), dataset: d });
      else if (d['msgSpacer']) this.parts.push({ kind: 'spacer', height: Number.parseFloat(child.props['style'].height), dataset: d });
      else this.parts.push({ kind: 'other', height: 30, dataset: d });
    }
  }
  get scrollHeight(): number { return this.parts.reduce((n, p) => n + p.height, 0); }
  get scrollTop(): number { return this.top; }
  set scrollTop(value: number) { this.top = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)); }
  get children() { return this.parts; }
  addEventListener(_: string, fn: () => void) { this.listener = fn; }
  removeEventListener() { this.listener = undefined; }
  getBoundingClientRect() { return { top: 0, bottom: this.clientHeight, height: this.clientHeight }; }
  private rect(index: number) {
    let y = 0;
    for (let i = 0; i < index; i++) y += this.parts[i]!.height;
    const part = this.parts[index]!;
    // The real glue resizes the top spacer through its style; layout follows from that write.
    const style = { set height(value: string) { part.height = Number.parseFloat(value); } };
    return { top: y - this.top, height: part.height, dataset: part.dataset, style, getBoundingClientRect: () => ({ top: y - this.top, height: part.height }) };
  }
  querySelectorAll(selector: string) { this.measurements++; return selector === '[data-row-id]' ? this.parts.flatMap((p, i) => (p.kind === 'row' ? [this.rect(i)] : [])) : []; }
  querySelector(selector: string) { return selector.includes('top') ? this.parts.flatMap((p, i) => (p.dataset['msgSpacer'] === 'top' ? [this.rect(i)] : []))[0] ?? null : null; }
  rowTop(id: string): number { const i = this.parts.findIndex(p => p.dataset['rowId'] === id); if (i < 0) throw new Error('row not mounted ' + id); return this.rect(i).top; }
  mountedIds(): string[] { return this.parts.flatMap(p => (p.kind === 'row' ? [p.dataset['rowId']!] : [])); }
  /** First mounted row whose bottom edge is below the viewport top. */
  readingRow(): string { let y = 0; for (const p of this.parts) { y += p.height; if (p.kind === 'row' && y > this.top) return p.dataset['rowId']!; } throw new Error('none'); }
}

function fixture(initial: UiMessage[], options: { rowHeight?: (id: string) => number; scope?: typeof OWNER } = {}) {
  let owner = options.scope ?? OWNER;
  const truth = new Map<string, number>();
  const heightOf = (id: string): number => truth.get(id) ?? options.rowHeight?.(id) ?? 100;
  const store = createStore<Record<string, any>>({ conversations: [{ gid: GID }], activeGid: GID, messages: { [GID]: initial }, history: { [GID]: { hasMore: false, beforeMs: null, busy: false } }, quote: null, prefs: { general: { show_msg_time: false } }, hideInboundTr: false, messageView: undefined });
  let pane: Pane | null = null;
  let resize = () => {}, stopLayout = () => {};
  const jsonParses: number[] = [0];
  /** How many times the `.msgs` pane (and so every mounted row) was rebuilt. */
  const built = { count: 0, rows: 0 };
  let account: { context: typeof OWNER } = { context: owner };
  let conv: Record<string, unknown> = { gid: '', account: null };
  const env: Record<string, unknown> = {
    visibleReads: { afterRender() {}, retry() {} }, ...viewmodel, HISTORY_RUNWAY, historyDiagnostics, part: (_name: string, build: () => unknown) => build(), featureRuntime: { renderSlot: () => [] }, messageAlignment, cx, store, S: () => store.get(), PIN_THRESHOLD, sameWindow,
    messagePaneModel: createMessagePane(), createHistoryLayoutFrames,
    subscribeFrame: subscribeBatched, fillHistoryViewport() {}, syncConversationViewport() {},
    // Like the real app, the account and conversation objects are stable references between renders.
    activeAccount: () => (account.context === owner ? account : (account = { context: owner })),
    activeConv: () => (conv.gid === store.get().activeGid && conv.account === owner ? conv : (conv = { gid: store.get().activeGid, account: owner, waiting_since_ms: null, status: 'active', service_type: 'chat', lang: 'en', title: 'Synthetic Customer', color: '#aaa' })),
    document: { querySelector: () => pane }, getComputedStyle: () => ({ marginBottom: '0px' }), queueMicrotask, Element: class {}, CSS: { escape: encodeURIComponent },
    inboundTranslation: { view: () => null, supplier: () => null }, refreshMessageTranslation() {}, composerInput: { deferRender: () => false }, renderMessageAvatar: () => 'avatar', formatDate: () => 'date', formatClock: () => 'time', t: (k: string) => k, icon: () => null, IC: {}, richText: (text: string) => [text],
    h: (tag: string, props: Record<string, any> | null, ...children: unknown[]) => { if (props?.['class'] === 'msgs') built.count++; if (props?.['dataset']?.['rowId']) built.rows++; return { tag, props: props ?? {}, children, dataset: props?.['dataset'] ?? {} }; },
    netEverConnected: true, netView: () => ({ offline: false }), composer: () => null, emojiPicker: () => null, langName: (c: string) => c, openConversation: () => {}, loadEarlier: () => {}, setTimeout, clearTimeout,
    stopHistoryLayout: () => stopLayout(),
    startHistoryLayout: (scroll: Pane, capture: () => unknown, restore: (a: unknown) => void, current: () => boolean) => {
      class Observer { constructor(fn: () => void) { resize = fn; } observe() {} disconnect() {} }
      stopLayout = observeHistoryLayout(scroll as never, capture, restore, current, Observer as never);
    },
  };
  (globalThis as any).liveAnchor = null; (globalThis as any).messageViewPatches = 0;
  function slice(name: string, next: string, asyncFn = false): (...args: unknown[]) => any {
    const a = source.indexOf(`${asyncFn ? 'async ' : ''}function ${name}(`), b = source.indexOf(`\n${next}`, a);
    assert.ok(a >= 0 && b > a, name);
    return new Function(...Object.keys(env), stripTypeScriptTypes(source.slice(a, b)) + `\nreturn ${name};`)(...Object.values(env));
  }
  // paneGeometry .. persistMessageView/onMessageScroll/withMessageAnchor share module state through env/globals.
  const anchorStart = source.indexOf('function paneGeometry('), anchorEnd = source.indexOf('\nfunction messageRow(', anchorStart);
  const anchorNames = ['paneGeometry', 'measureMessagePane', 'captureMessageAnchor', 'restoreMessageAnchor', 'persistMessageView', 'onMessageScroll', 'withMessageAnchor'];
  env['messageRow'] = slice('messageRow', 'function translationBar(');
  const cacheStart = source.indexOf('let messagePaneCache:'), cacheEnd = source.indexOf('function chatPane(', cacheStart);
  // Match the module's shared lexical cache: anchor glue must see the current pane revision.
  const anchors = new Function(...Object.keys(env), stripTypeScriptTypes(source.slice(anchorStart, anchorEnd) + '\n' + source.slice(cacheStart, cacheEnd)) + `\nreturn { ${anchorNames.join(', ')}, messagePane };`)(...Object.values(env));
  Object.assign(env, anchors);
  const chatPane = slice('chatPane', 'function messagesView(');
  const find = (tree: any): Node | null => { if (!tree || typeof tree !== 'object') return null; if (Array.isArray(tree)) { for (const c of tree) { const r = find(c); if (r) return r; } return null; } return tree.props?.dataset?.keepScroll === 'msgs' ? tree : find(tree.children); };
  // What ui-kit rerender does: keep numeric scrollTop, or follow the bottom when the node says so.
  let previousNode: Node | null = null;
  env['rerender'] = (_root: unknown, build: () => unknown) => {
    const previous = pane?.scrollTop ?? 0;
    const node = find(build());
    // Morph keeps a node it is handed back on the page, with whatever was written to it since.
    if (pane && node && node === previousNode) return;
    previousNode = node;
    pane = node ? new Pane(node, heightOf) : null;
    if (pane) pane.scrollTop = pane.dataset['scrollBottom'] === '1' ? pane.scrollHeight : previous;
  };
  env['render'] = (s: unknown) => chatPane(s);
  env['root'] = {};
  const sa = source.indexOf('subscribeFrame(store,'), sb = source.indexOf('\nrerender(root, () => render(S()));', sa);
  new Function(...Object.keys(env), stripTypeScriptTypes(source.slice(sa, sb)))(...Object.values(env));
  const settle = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
  const originalParse = JSON.parse;
  return {
    store, settle, truth, get pane() { return pane!; }, unmount() { stopLayout(); pane = null; },
    open: async () => { store.patch({}); await settle(); },
    setMessages: async (messages: UiMessage[]) => { store.patch({ messages: { [GID]: messages } }); await settle(); },
    scrollTo: async (top: number) => { pane!.scrollTop = top; pane!.listener?.(); (env['onMessageScroll'] as (p: Pane) => void)(pane!); await settle(); },
    /** Media inside a mounted row resolves: layout moves first, then ResizeObserver fires. */
    grow: async (id: string, delta: number) => { truth.set(id, heightOf(id) + delta); const part = pane!.parts.find(p => p.dataset['rowId'] === id)!; part.height = heightOf(id); resize(); await settle(); },
    switchScope: async (next: typeof OWNER) => { owner = next; store.patch({}); await settle(); },
    countJsonParse: <T>(fn: () => T): { value: T; parses: number } => { let n = 0; JSON.parse = ((...a: Parameters<typeof JSON.parse>) => { n++; return originalParse(...a); }) as typeof JSON.parse; try { const value = fn(); return { value, parses: n }; } finally { JSON.parse = originalParse; } },
    env, jsonParses, built,
  };
}

test('a store change that leaves the window alone (clock tick, persisted view of the same window) does not rebuild the rows', async () => {
  const f = fixture(thread(10_000));
  await f.open();
  await f.scrollTo(100 * 5000); await f.scrollTo(100 * 5000);
  f.built.count = 0;
  f.store.patch({ now: 1 }); await f.settle();
  assert.equal(f.built.count, 0, 'unrelated patch');
  // The debounced anchor persist re-stores the same window: same rows stay mounted.
  await f.scrollTo(100 * 5000 + 8);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(f.built.count, 0, 'same window persisted');
  await f.scrollTo(100 * 3000);
  assert.ok(f.built.count >= 1, 'a new window rebuilds');
});

test('10k messages mount a bounded window through the real glue and open at the bottom', async () => {
  const f = fixture(thread(10_000));
  await f.open();
  assert.ok(f.pane.mountedIds().length <= 40, `mounted ${f.pane.mountedIds().length}`);
  assert.ok(f.pane.mountedIds().includes('m:m9999'));
  assert.ok(f.pane.scrollHeight - f.pane.clientHeight - f.pane.scrollTop < PIN_THRESHOLD);
  assert.equal(f.store.get().messageView.scope, f.pane.dataset['historyScope']);
});

test('prepending a history page while reading keeps the reading row (anchor survives in the store)', async () => {
  const f = fixture(thread(400, 100));
  await f.open();
  await f.scrollTo(100 * 150 + 30); await f.scrollTo(100 * 150 + 30);
  const reading = f.pane.readingRow(), before = f.pane.rowTop(reading);
  assert.equal(f.store.get().messageView.anchor.key.mid, reading.slice(2), 'store holds the pre-parsed key struct');
  await f.setMessages(viewmodel.mergeHistory(thread(100), f.store.get().messages[GID]));
  assert.equal(f.pane.rowTop(reading), before);
});

test('media growth above the reading row is compensated through the observer, once', async () => {
  const f = fixture(thread(300));
  await f.open();
  await f.scrollTo(100 * 120); await f.scrollTo(100 * 120);
  const reading = f.pane.readingRow(), before = f.pane.rowTop(reading);
  const above = f.pane.mountedIds()[f.pane.mountedIds().indexOf(reading) - 1]!;
  await f.grow(above, 240);
  assert.equal(f.pane.rowTop(reading), before);
});

test('a live message follows the bottom while pinned and leaves a reading position alone', async () => {
  const pinned = fixture(thread(300));
  await pinned.open(); await pinned.setMessages([...thread(300), msg('live', 5000)]);
  assert.ok(pinned.pane.mountedIds().includes('m:live'));
  assert.ok(pinned.pane.scrollHeight - pinned.pane.clientHeight - pinned.pane.scrollTop < PIN_THRESHOLD);
  const reading = fixture(thread(300));
  await reading.open(); await reading.scrollTo(100 * 100); await reading.scrollTo(100 * 100);
  const row = reading.pane.readingRow(), before = reading.pane.rowTop(row);
  await reading.setMessages([...thread(300), msg('live', 5000)]);
  assert.equal(reading.pane.rowTop(row), before);
  assert.ok(!reading.pane.mountedIds().includes('m:live'));
});

test('a rebuilt pane for the same scope resumes at the stored anchor; another scope opens at the bottom', async () => {
  const f = fixture(thread(300));
  await f.open(); await f.scrollTo(100 * 100); await f.scrollTo(100 * 100);
  const row = f.pane.readingRow(), before = f.pane.rowTop(row);
  f.unmount(); await f.open();
  assert.equal(f.pane.rowTop(row), before, 'same scope: resumes the reading row');
  await f.switchScope({ ...OWNER, session_generation: 2 });
  assert.ok(f.pane.mountedIds().includes('m:m299'), 'new generation scope: bottom');
});

test('capture and restore never parse JSON per row, even with 10k messages', async () => {
  const f = fixture(thread(10_000));
  await f.open(); await f.scrollTo(100 * 5000); await f.scrollTo(100 * 5000);
  const { parses } = f.countJsonParse(() => {
    const anchor = (f.env['captureMessageAnchor'] as (s: unknown) => unknown)(f.store.get());
    (f.env['restoreMessageAnchor'] as (a: unknown) => void)(anchor);
  });
  assert.equal(parses, 0);
});

test('scroll diagnostics stay opt-in and carry only geometry', async () => {
  historyDiagnostics.clear();
  const off = fixture(thread(200)); await off.open(); await off.scrollTo(3000); await off.scrollTo(3000);
  assert.equal(historyDiagnostics.snapshot().events.length, 0);
  historyDiagnostics.start();
  const on = fixture(thread(200)); await on.open(); await on.scrollTo(3000); await on.scrollTo(3000);
  const snapshot = historyDiagnostics.snapshot();
  assert.ok(snapshot.events.some(e => e.stage === 'capture_done'));
  assert.ok(snapshot.events.some(e => e.stage === 'restore' || e.stage === 'restore_skip'));
  assert.ok(!JSON.stringify(snapshot).includes('SYNTHETIC') && !JSON.stringify(snapshot).includes('synthetic'));
  historyDiagnostics.clear();
});

test('the managed pane keeps native anchoring off and rows own their spacing (spacers add up exactly)', () => {
  const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
  assert.match(css.match(/\.msgs\s*\{([^}]+)\}/)?.[1] ?? '', /overflow-anchor\s*:\s*none\b/);
  assert.doesNotMatch(css.match(/\.msgs\s*\{([^}]+)\}/)?.[1] ?? '', /\bgap\s*:/);
  assert.match(css, /\.msgs > \.msg,[^{]*\{[^}]*margin-bottom/);
});


test('retained message DOM avoids row geometry reads on 100 draft/sidebar frames', async () => {
  const f = fixture(thread(10_000));
  await f.open();
  await f.scrollTo(100 * 5000); await f.scrollTo(100 * 5000);
  const pane = f.pane;
  pane.measurements = 0;
  for (let i = 0; i < 100; i++) { f.store.patch({ draft: `draft-${i}`, pkgOpen: i % 2 === 0 }); await f.settle(); }
  assert.equal(f.pane, pane, 'the same rendered message window remains mounted');
  assert.equal(pane.measurements, 0, 'no row queries/rect/style reads for unchanged content and geometry');
  pane.clientWidth -= 120;
  f.store.patch({}); await f.settle();
  assert.ok(pane.measurements > 0, 'width change must measure even with the same message array and node');
});

const restoreWrites = () => historyDiagnostics.snapshot().events.filter(e => e.stage === 'restore').length;

test('a mounted pane is never pulled back by scrollTop: scrolling, a landed page and resolved media all hold the rows through the spacer', async () => {
  historyDiagnostics.clear(); historyDiagnostics.start();
  const f = fixture(thread(400, 100), { rowHeight: id => 60 + Number(id.slice(3)) % 7 * 40 });
  await f.open();
  await f.scrollTo(f.pane.scrollTop - 4000);
  const writes = restoreWrites();
  for (let i = 0; i < 40; i++) await f.scrollTo(f.pane.scrollTop - 90);
  const reading = f.pane.readingRow(), before = f.pane.rowTop(reading);
  await f.setMessages(viewmodel.mergeHistory(thread(100), f.store.get().messages[GID]));
  assert.ok(Math.abs(f.pane.rowTop(reading) - before) < 0.01, 'page landed');
  const above = f.pane.mountedIds()[f.pane.mountedIds().indexOf(reading) - 1]!;
  await f.grow(above, 240);
  assert.ok(Math.abs(f.pane.rowTop(reading) - before) < 0.01, 'media resolved');
  assert.equal(restoreWrites(), writes, 'no restore wrote scrollTop');
  historyDiagnostics.clear();
});

test('an old stored anchor cannot move a retained pane', async () => {
  const f = fixture(thread(400));
  await f.open();
  await f.scrollTo(100 * 200); await f.scrollTo(100 * 200);
  const stale = f.store.get().messageView.anchor;
  await f.scrollTo(100 * 150); await f.scrollTo(100 * 150);
  f.store.patch({ messageView: { ...f.store.get().messageView, anchor: stale } });
  const reading = f.pane.readingRow(), before = f.pane.rowTop(reading), top = f.pane.scrollTop;
  (f.env['restoreMessageAnchor'] as (a: unknown) => void)(null);
  assert.equal(f.pane.scrollTop, top);
  assert.equal(f.pane.rowTop(reading), before);
});

test('paging state and a landed page rebuild only the rows that are new', async () => {
  const f = fixture(thread(100, 300));
  await f.open();
  await f.scrollTo(f.pane.scrollTop - 1500); await f.scrollTo(f.pane.scrollTop);
  f.built.rows = 0;
  f.store.patch({ history: { [GID]: { hasMore: true, beforeMs: 1, busy: true } } }); await f.settle();
  assert.equal(f.built.rows, 0, 'the busy flag touches no row');
  const mounted = new Set(f.pane.mountedIds());
  await f.setMessages(viewmodel.mergeHistory(thread(100, 200), f.store.get().messages[GID]));
  const entered = f.pane.mountedIds().filter(id => !mounted.has(id)).length;
  assert.equal(f.built.rows, entered, 'rows that stayed mounted were reused');
});

test('a row with an ICCID button is rebuilt when the thread snapshot it is bound to changes', async () => {
  const iccid = msg('iccid', 5000, { text: '89860012345678901234' });
  assert.ok(viewmodel.highlightParts(iccid.text).some(part => part.kind === 'iccid'));
  const f = fixture([...thread(20), iccid]);
  await f.open();
  f.built.rows = 0;
  await f.setMessages([...f.store.get().messages[GID]]);
  assert.equal(f.built.rows, 1);
});
