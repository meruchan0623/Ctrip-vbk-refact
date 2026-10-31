import { historyDiagnostics } from './history-diagnostics.ts';
import { readHistoryPage } from './history-read.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import * as viewmodel from './viewmodel.ts';
import { mergeMessageProfile } from './message-profile.ts';
import { isUiMessage } from '../_shared/guards.ts';
import type { UiMessage } from '../../packages/ipc/src/client.ts';
const source = readFileSync(process.env['VBK_HISTORY_MAIN_SOURCE'] ?? new URL('./main.ts', import.meta.url), 'utf8');
const pending: UiMessage = { gid: 'synthetic-A', message_id: null, local_id: 'synthetic-local', text: 'SYNTHETIC CURRENT', kind: 'text', create_time_ms: 100, sender_role: 'merchant_self', sender_id: 'synthetic-agent', sender_name: 'Synthetic Agent', sender_avatar: 'https://example.invalid/current.png', disposition: { kind: 'unknown' }, translation: null, original: null, quote: null, order_id: null };
const confirmed: UiMessage = { ...pending, message_id: 'synthetic-server', text: 'SYNTHETIC HISTORY', sender_name: null, sender_avatar: null, disposition: { kind: 'confirmed', server_message_id: 'synthetic-server', server_time_ms: 105 } };
function fixture(current: UiMessage[], page: UiMessage[]) {
  const state = { activeGid: 'synthetic-B', messages: { [pending.gid]: current }, drafts: {}, conversations: [{ gid: pending.gid, unread_count: 0 }], history: {}, banners: [], draftVersion: 0, view: 'messages', quote: null };
  const env = { visibleReads: { retry() {}, afterRender() {} }, ...viewmodel, historyDiagnostics, readHistoryPage, mergeMessageProfile, isUiMessage, S: () => state, store: { patch: (patch: object) => Object.assign(state, patch) }, activeAccount: () => ({ context: { account_id: 'synthetic-account', environment: 'test', session_generation: 1 } }), stillActive: () => true, peripheral: { close: () => {} }, TRANSLATION_IDLE: {}, PKG_IDLE: {}, UiCommands: { IM_MESSAGE_PAGE: 'page' }, invokeQuiet: async () => ({ items: page, has_more: false, before_ms: null }), autoQueryPackage: () => {} };
  function actual(name: string, next: string, async = false): (...args: unknown[]) => unknown {
    const a = source.indexOf(`${async ? 'async ' : ''}function ${name}(`); const b = source.indexOf(`\n${next}`, a);
    assert.ok(a >= 0 && b > a);
    return new Function(...Object.keys(env), stripTypeScriptTypes(source.slice(a, b)) + `\nreturn ${name};`)(...Object.values(env));
  }
  return { state, open: actual('openConversation', 'async function loadEarlier(', true), upsert: actual('upsertMessage', 'function upsertConversation(') };
}
test('actual openConversation merges unknown local with confirmed history and late host event stays unique', async () => {
  const f = fixture([pending], [confirmed]); await f.open(pending.gid);
  let rows = f.state.messages[pending.gid]!;
  assert.equal(rows.length, 1); assert.equal(rows[0]?.disposition?.kind, 'confirmed');
  assert.equal(rows[0]?.text, pending.text); assert.equal(rows[0]?.sender_avatar, pending.sender_avatar);
  f.upsert(confirmed); rows = f.state.messages[pending.gid]!;
  assert.equal(rows.length, 1); assert.equal(rows[0]?.message_id, confirmed.message_id);
});
test('actual late unknown receipt cannot regress confirmed status or erase its server ID', () => {
  const f = fixture([confirmed], []); f.upsert(pending);
  const rows = f.state.messages[pending.gid]!;
  assert.equal(rows.length, 1); assert.equal(rows[0]?.disposition?.kind, 'confirmed'); assert.equal(rows[0]?.message_id, confirmed.message_id);
});
test('late bridge event collapses both preexisting server and local aliases', () => {
  const f = fixture([{ ...confirmed, local_id: null }, pending], []); f.upsert(confirmed);
  assert.equal(f.state.messages[pending.gid]!.length, 1);
});
test('page order and overlap retain confirmation; identifiers never merge across rooms or empty IDs', () => {
  for (const rows of [viewmodel.mergeHistory([confirmed], [pending]), viewmodel.mergeHistory([pending], [confirmed])]) {
    assert.equal(rows.length, 1); assert.equal(rows[0]?.disposition?.kind, 'confirmed'); assert.equal(rows[0]?.message_id, confirmed.message_id);
  }
  assert.equal(viewmodel.mergeHistory([confirmed], [{ ...pending, gid: 'synthetic-B' }]).length, 2);
  assert.equal(viewmodel.mergeHistory([{ ...pending, local_id: null }], [{ ...pending, local_id: null }]).length, 2);
});

test('actual loadEarlier uses the exclusive cursor, fences duplicate clicks and merges one latest projection', async () => {
  let complete!: (page: unknown) => void;
  let active = true;
  const requests: unknown[][] = [], queued: (() => void)[] = [];
  const scroll = { scrollHeight: 1000, scrollTop: 120 };
  const state = { conversations: [{ gid: pending.gid }], activeGid: pending.gid, messages: { [pending.gid]: [pending] }, history: { [pending.gid]: { hasMore: true, beforeMs: 100, busy: false } } };
  const env = { visibleReads: { retry() {}, afterRender() {} }, ...viewmodel, historyDiagnostics, readHistoryPage, S: () => state, store: { patch: (patch: object) => Object.assign(state, patch) }, stillActive: () => active, invokeSafe: (...args: unknown[]) => { requests.push(args); return new Promise(resolve => { complete = resolve; }); }, UiCommands: { IM_MESSAGE_PAGE: 'page' }, isUiMessage, document: { querySelector: () => scroll }, queueMicrotask: (callback: () => void) => queued.push(callback) };
  const a = source.indexOf('async function loadEarlier('), b = source.indexOf('\n/** `im://locate-conversation`', a);
  assert.ok(a >= 0 && b > a);
  const load = new Function(...Object.keys(env), stripTypeScriptTypes(source.slice(a, b)) + '\nreturn loadEarlier;')(...Object.values(env));
  const conv = { gid: pending.gid, account: { account_id: 'synthetic-account', environment: 'test', session_generation: 1 } };
  const first = load(conv); await load(conv);
  assert.equal(requests.length, 1); assert.deepEqual(requests[0]?.[1], { account: conv.account, gid: pending.gid, before_ms: 100 });
  complete({ items: [confirmed], has_more: false, before_ms: null }); await first;
  assert.equal(state.messages[pending.gid]!.length, 1); assert.equal(state.messages[pending.gid]![0]?.disposition?.kind, 'confirmed');
  assert.equal(state.history[pending.gid]?.busy, false);

});

test('actual loadEarlier drops a late page after account generation changes', async () => {
  let complete!: (page: unknown) => void; let active = true;
  const state = { conversations: [{ gid: pending.gid }], activeGid: pending.gid, messages: { [pending.gid]: [pending] }, history: { [pending.gid]: { hasMore: true, beforeMs: 100, busy: false } } };
  const env = { visibleReads: { retry() {}, afterRender() {} }, ...viewmodel, historyDiagnostics, readHistoryPage, S: () => state, store: { patch: (patch: object) => Object.assign(state, patch) }, stillActive: () => active, invokeSafe: () => new Promise(resolve => { complete = resolve; }), UiCommands: { IM_MESSAGE_PAGE: 'page' }, isUiMessage, document: { querySelector: () => { throw new Error('stale page must not inspect current DOM'); } } };
  const a = source.indexOf('async function loadEarlier('), b = source.indexOf('\n/** `im://locate-conversation`', a);
  const load = new Function(...Object.keys(env), stripTypeScriptTypes(source.slice(a, b)) + '\nreturn loadEarlier;')(...Object.values(env));
  const request = load({ gid: pending.gid, account: {} }); active = false;
  complete({ items: [confirmed], has_more: false, before_ms: null }); await request;
  assert.deepEqual(state.messages[pending.gid], [pending]);
});

test('actual upsert never merges different roles or explicit sender UIDs through a colliding local ID', () => {
  for (const incoming of [
    { ...pending, message_id: 'synthetic-customer-server', sender_role: 'customer' as const, sender_id: 'synthetic-customer', disposition: null },
    { ...pending, message_id: null, sender_role: 'customer' as const, sender_id: undefined, disposition: null },
    { ...pending, message_id: null, sender_id: 'synthetic-other-agent', disposition: null },
  ]) {
    const f = fixture([confirmed], []); f.upsert(incoming);
    const rows = f.state.messages[pending.gid]!; assert.equal(rows.length, 2);
    assert.ok(rows.some(row => row.message_id === confirmed.message_id && row.sender_id === confirmed.sender_id && row.disposition?.kind === 'confirmed'));
    const current = rows.find(row => row.sender_id === incoming.sender_id && row.sender_role === incoming.sender_role)!;
    assert.equal(current.message_id, incoming.message_id); assert.equal(current.disposition, incoming.disposition);
  }
});
test('different nonempty server IDs remain distinct despite identical sender and local ID', () => {
  const incoming = { ...confirmed, message_id: 'synthetic-second-server', disposition: { kind: 'confirmed' as const, server_message_id: 'synthetic-second-server', server_time_ms: 106 } };
  const f = fixture([confirmed], []); f.upsert(incoming); assert.equal(f.state.messages[pending.gid]!.length, 2);
  f.upsert({ ...pending, disposition: { kind: 'unknown' } });
  assert.equal(f.state.messages[pending.gid]!.filter(row => row.message_id).length, 2);
});
test('exact server match replaces conflicting identity without borrowing sender profile, local alias, quote or confirmation', () => {
  const before = { ...confirmed, sender_name: 'Synthetic Self', sender_avatar: 'https://example.invalid/self.png', original: 'SYNTHETIC OLD ORIGINAL', translation: 'SYNTHETIC OLD TRANSLATION', quote: 'synthetic-quote', quote_target_id: 'synthetic-quote' };
  const incoming = { ...pending, message_id: confirmed.message_id, local_id: null, sender_role: 'customer' as const, sender_id: 'synthetic-customer', sender_name: null, sender_avatar: null, disposition: null };
  const f = fixture([before], []); f.upsert(incoming); const rows = f.state.messages[pending.gid]!;
  assert.equal(rows.length, 1); assert.equal(rows[0]?.sender_id, incoming.sender_id); assert.equal(rows[0]?.sender_avatar, null); assert.equal(rows[0]?.sender_name, null); assert.equal(rows[0]?.disposition, null); assert.equal(rows[0]?.local_id, null); assert.equal(rows[0]?.quote, null); assert.equal(rows[0]?.original, null); assert.equal(rows[0]?.translation, null);
  f.upsert(pending); assert.equal(f.state.messages[pending.gid]!.length, 2, 'old local alias was not retained for the new sender');
});
test('server-first bridging checks every local group identity and server-ID conflict before merging', () => {
  const server = { ...confirmed, local_id: null };
  for (const other of [
    { ...pending, sender_role: 'customer' as const, sender_id: 'synthetic-customer' },
    { ...pending, sender_id: 'synthetic-other-agent' },
    { ...confirmed, message_id: 'synthetic-other-server', disposition: { kind: 'confirmed' as const, server_message_id: 'synthetic-other-server', server_time_ms: 106 } },
  ]) {
    for (const records of [[server, other], [other, server]]) {
      const f = fixture(records, []); f.upsert(confirmed); const rows = f.state.messages[pending.gid]!;
      assert.equal(rows.length, 2); assert.ok(rows.some(row => row.message_id === server.message_id && row.sender_id === server.sender_id)); assert.ok(rows.some(row => row.message_id === other.message_id && row.sender_id === other.sender_id));
    }
  }
});
test('shared local alias retains separate compatible groups for later exact server matches', () => {
  const other = { ...confirmed, message_id: 'synthetic-other-server', sender_id: 'synthetic-other-agent', disposition: { kind: 'confirmed' as const, server_message_id: 'synthetic-other-server', server_time_ms: 106 } };
  const f = fixture([confirmed, other], []); f.upsert({ ...pending, message_id: confirmed.message_id });
  assert.equal(f.state.messages[pending.gid]!.length, 2); assert.ok(f.state.messages[pending.gid]!.some(row => row.message_id === confirmed.message_id && row.disposition?.kind === 'confirmed'));
});

// Real main load/upsert/subscription and real immutable store, with explicitly virtual row geometry.
import { createStore, subscribeBatched } from '../../packages/ui-kit/src/store.ts';
import { messageAlignment } from './message-alignment.ts';
import { cx } from '../../packages/ui-kit/src/h.ts';
import { observeHistoryLayout } from './history-layout.ts';
function anchorFixture(options: { base?: Partial<UiMessage>; omitSender?: boolean; realScroll?: boolean; extra?: UiMessage[]; topPadding?: number; rowHeight?: (message: UiMessage) => number } = {}) {
  const scope = { account_id: 'synthetic-account', environment: 'synthetic', session_generation: 1 };
  let owner = scope;
  let lateGrowth = 0, resize = () => {}, stopLayout = () => {};
  const seeded: UiMessage = { ...pending, gid: 'synthetic-anchor-room', sender_role: 'customer', sender_id: 'synthetic-customer', message_id: 'synthetic-anchor-current', local_id: null, create_time_ms: 200, disposition: null, ...options.base };
  const { sender_id: _sender, ...withoutSender } = seeded;
  const base: UiMessage = options.omitSender ? withoutSender : seeded;
  const older = { ...base, message_id: 'synthetic-anchor-old', local_id: null, create_time_ms: 100 };
  const live = { ...base, message_id: 'synthetic-anchor-live', local_id: null, create_time_ms: 300 };
  const store = createStore({ conversations: [{ gid: base.gid }], activeGid: base.gid, messages: { [base.gid]: [base, ...(options.extra ?? [])] } as Record<string, UiMessage[]>, history: { [base.gid]: { hasMore: true, beforeMs: 200, busy: false } }, quote: null });
  let complete!: (page: unknown) => void;
  type Row = { dataset: Record<string, string>; getBoundingClientRect(): { top: number; bottom: number } };
  class Scroll {
    private top = 120; clientHeight = 400; scrollHeight = 1000;
    get scrollTop() { return this.top; }
    set scrollTop(value: number) { this.top = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)); }
    dataset: Record<string, string> = {}; rows: Row[] = [];
    isConnected = true;
    get children() { return this.rows; }
    onScroll: (() => void) | undefined;
    addEventListener(_name: string, callback: () => void) { this.onScroll = callback; }
    removeEventListener() { this.onScroll = undefined; }
    getBoundingClientRect() { return { top: 50, bottom: 450 }; }
    querySelectorAll() { return this.rows; }
  }
  let scroll = new Scroll();
  class Root { constructor(readonlyScroll: Scroll) { this.scroll = readonlyScroll; } scroll: Scroll; querySelectorAll(selector: string) { return selector === '[data-keep-scroll]' ? [this.scroll] : []; } querySelector() { return null; } replaceChildren(next: Root) { this.scroll = next.scroll; scroll = next.scroll; } }
  const env: Record<string, unknown> = { visibleReads: { retry() {}, afterRender() {} }, ...viewmodel, historyDiagnostics, readHistoryPage, messageAlignment, cx, createStore, subscribeBatched, store, S: () => store.get(), activeAccount: () => ({ context: owner }), activeConv: () => ({ gid: store.get().activeGid, account: owner, waiting_since_ms: null, status: 'active', service_type: 'chat', lang: 'en' }), stillActive: (account: typeof scope) => account.account_id === owner.account_id && account.environment === owner.environment && account.session_generation === owner.session_generation, isUiMessage, invokeSafe: () => new Promise(resolve => { complete = resolve; }), UiCommands: { IM_MESSAGE_PAGE: 'page' }, document: { querySelector: () => scroll }, queueMicrotask, Element: Root, CSS: { escape: encodeURIComponent }, root: { querySelector: () => null }, renderMessageAvatar: () => 'avatar', formatDate: () => 'date', formatClock: () => 'time', t: (key: string) => key, icon: () => null, IC: {}, richText: (text: string) => [text], h: (tag: string, props: unknown, ...children: unknown[]) => ({ tag, props, children }) };
  env['composerInput'] = { deferRender: () => false }; // This fixture has no composing editor.
  function actual(name: string, next: string, async = false) { const a = source.indexOf(`${async ? 'async ' : ''}function ${name}(`), b = source.indexOf(`\n${next}`, a); assert.ok(a >= 0 && b > a, name); return new Function(...Object.keys(env), stripTypeScriptTypes(source.slice(a, b)) + '\nreturn ' + name + ';')(...Object.values(env)); }
  env['stopHistoryLayout'] = () => stopLayout();
  env['startHistoryLayout'] = (pane: HTMLElement, capture: () => unknown, restore: (anchor: unknown) => void, current: () => boolean) => {
    class Observer { constructor(fn: () => void) { resize = fn; } observe() {} disconnect() {} }
    stopLayout = observeHistoryLayout(pane, capture, restore, current, Observer as unknown as typeof ResizeObserver);
  };
  // Load the actual helper group when present; the old production callback is exercised unchanged for red evidence.
  if (source.includes('function historyAnchorMatches(')) env['historyAnchorMatches'] = actual('historyAnchorMatches', 'interface MessageAnchor');
  for (const [name, next] of [['captureMessageAnchor', 'function restoreMessageAnchor('], ['restoreMessageAnchor', 'function withMessageAnchor('], ['withMessageAnchor', 'function messageRow(']] as const) if (source.includes(`function ${name}(`)) env[name] = actual(name, next);
  if (source.includes('function mediaNodeKey(')) env['mediaNodeKey'] = actual('mediaNodeKey', source.includes('function captureMessageAnchor(') ? 'function captureMessageAnchor(' : 'function messageRow(');
  const row = actual('messageRow', 'function translationBar(');
  env['messageRow'] = row;
  Object.assign(env, { netView: () => ({ offline: false }), composer: () => null, emojiPicker: () => null, langName: (code: string) => code });
  const pane = actual('chatPane', 'function messagesView(');
  function findScroll(tree: any): any { if (!tree || typeof tree !== 'object') return null; if (Array.isArray(tree)) return tree.map(findScroll).find(Boolean); return tree.props?.dataset?.keepScroll === 'msgs' ? tree : findScroll(tree.children); }
  function build() {
    const next = new Scroll(); next.scrollTop = scroll.scrollTop;
    next.dataset['historyScope'] = env['historyScopeKey'] ? (env['historyScopeKey'] as (account: typeof scope, gid: string) => string)(owner, store.get().activeGid) : 'old-scope';
    if (options.realScroll) next.dataset = findScroll(pane(store.get())).props.dataset;
    let offset = options.topPadding ?? 100;
    for (const message of store.get().messages[store.get().activeGid] ?? []) {
      const rendered = row({ ...store.get(), prefs: { general: { show_msg_time: false } } }, message, { gid: store.get().activeGid, account: owner, title: 'Synthetic Customer', color: '#aaa' }, { context: owner });
      const height = options.rowHeight?.(message) ?? (message.create_time_ms < 200 ? 300 : 200);
      const at = offset;
      next.rows.push({ dataset: rendered.props.dataset ?? {}, getBoundingClientRect: () => ({ top: 50 + at + (message.create_time_ms >= 200 ? lateGrowth : 0) - next.scrollTop, bottom: 50 + at + height + (message.create_time_ms >= 200 ? lateGrowth : 0) - next.scrollTop }) });
      offset += height;
    }
    next.scrollHeight = 1000 + (store.get().messages[store.get().activeGid] ?? []).filter(m => m.create_time_ms < 200).length * 300 + (store.get().messages[store.get().activeGid] ?? []).filter(m => m.create_time_ms > 200).length * 200;
    return new Root(next);
  }
  env['render'] = build; env['rerender'] = (_root: unknown, render: () => Root) => { const top = scroll.scrollTop; const next = render(); scroll = next.scroll; scroll.scrollTop = top; };
  scroll = build().scroll;
  if (options.realScroll) {
    const uiSource = readFileSync(new URL('../../packages/ui-kit/src/h.ts', import.meta.url), 'utf8');
    const rerenderStart = uiSource.indexOf('export function rerender(');
    env['root'] = new Root(scroll);
    env['rerender'] = new Function('document', 'mount', stripTypeScriptTypes(uiSource.slice(rerenderStart).replace('export function', 'function')) + '\nreturn rerender;')({ activeElement: null }, (root: Root, next: Root) => root.replaceChildren(next));
  }
  const a = source.indexOf('subscribeBatched(store,'), b = source.indexOf('\nrerender(root, () => render(S()));', a);
  new Function(...Object.keys(env), stripTypeScriptTypes(source.slice(a, b)))(...Object.values(env));
  const load = actual('loadEarlier', '/** `im://locate-conversation`', true), upsert = actual('upsertMessage', 'function upsertConversation(');
  return { store, older, live, base, context: scope, scroll: () => scroll, userScroll: (top: number) => { scroll.scrollTop = top; scroll.onScroll?.(); }, growMedia: () => { lateGrowth += 240; scroll.scrollHeight += 240; resize(); }, load: () => load({ gid: base.gid, account: scope }), upsert, complete: (items: UiMessage[] = [older]) => complete({ items, has_more: false, before_ms: null }), setScope: (next: typeof scope) => { owner = next; store.patch({ activeGid: base.gid }); } };
}

test('actual pagination retains the visible row after older media gains its intrinsic height', async () => {
  const f = anchorFixture({ realScroll: true });
  const loading = f.load(); await Promise.resolve(); f.complete(); await loading; await Promise.resolve();
  assert.equal(f.scroll().scrollTop, 420);
  f.growMedia(); assert.equal(f.scroll().scrollTop, 660);
});

test('incremental history rows cannot take over the original reading anchor while it remains visible', async () => {
  const f = anchorFixture({ realScroll: true, topPadding: 57, rowHeight: message => message.create_time_ms === 100 ? 115 : message.create_time_ms === 150 ? 253 : 23 });
  f.scroll().scrollTop = 0;
  const loading = f.load(); await Promise.resolve();
  f.upsert(f.older); await Promise.resolve();
  assert.equal(f.scroll().scrollTop, 115);
  assert.equal(f.scroll().rows[1]!.getBoundingClientRect().top - 50, 57);
  f.scroll().onScroll?.(); // Queued programmatic scroll must not erase the preference.
  const middle = { ...f.older, message_id: 'synthetic-middle-page-row', create_time_ms: 150 };
  f.upsert(middle); await Promise.resolve();
  assert.equal(f.scroll().scrollTop, 368, 'second insertion must preserve the original row, not the newly clipped first row');
  assert.equal(f.scroll().rows[2]!.getBoundingClientRect().top - 50, 57);
  f.complete([f.older, middle]); await loading; await Promise.resolve();
  assert.equal(f.scroll().scrollTop, 368);
});

test('user scrolling during incremental history selects a fresh reading row even if the former anchor is visible', async () => {
  const f = anchorFixture({ realScroll: true, topPadding: 57, rowHeight: message => message.create_time_ms === 100 ? 115 : message.create_time_ms === 150 ? 253 : 23 });
  f.scroll().scrollTop = 0;
  f.upsert(f.older); await Promise.resolve();
  assert.equal(f.scroll().scrollTop, 115);
  f.userScroll(0);
  f.upsert({ ...f.older, message_id: 'synthetic-middle-page-row', create_time_ms: 150 }); await Promise.resolve();
  assert.equal(f.scroll().scrollTop, 0, 'explicit scroll to the new first row replaces the former preference');
  assert.equal(f.scroll().rows[0]!.getBoundingClientRect().top - 50, 57);
});

test('the managed message pane disables competing native anchoring and keeps its reading row through media then another page row', async () => {
  const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
  assert.match(css.match(/\.msgs\s*\{([^}]+)\}/)?.[1] ?? '', /overflow-anchor\s*:\s*none\b/);
  const f = anchorFixture({ realScroll: true, topPadding: 57, rowHeight: message => message.create_time_ms === 100 ? 115 : message.create_time_ms === 150 ? 253 : 23 });
  f.scroll().scrollTop = 0;
  f.upsert(f.older); await Promise.resolve();
  f.growMedia();
  assert.equal(f.scroll().scrollTop, 355, 'ResizeObserver compensates the media layout without a native scroll adjustment');
  assert.equal(f.scroll().rows[1]!.getBoundingClientRect().top - 50, 57);
  f.upsert({ ...f.older, message_id: 'synthetic-middle-page-row', create_time_ms: 150 }); await Promise.resolve();
  assert.equal(f.scroll().scrollTop, 608);
  assert.equal(f.scroll().rows[2]!.getBoundingClientRect().top - 50, 57);
});
test('actual capture/restore diagnostics are opt-in and report only geometry and match rejection', async () => {
  historyDiagnostics.clear();
  const off = anchorFixture(); off.upsert(off.older); await Promise.resolve();
  assert.equal(historyDiagnostics.snapshot().events.length, 0);
  historyDiagnostics.start();
  const system = { ...pending, gid: 'synthetic-anchor-room', kind: 'system' as const, sender_role: 'unknown' as const, message_id: null, local_id: null, create_time_ms: 200, disposition: null, text: 'SECRET CUSTOMER TEXT' };
  const ambiguous = anchorFixture({ base: system, extra: [system] }); ambiguous.upsert(ambiguous.older); await Promise.resolve();
  const rejected = historyDiagnostics.snapshot();
  assert.ok(rejected.events.some(e => e.stage === 'candidate' && e.reason === 'ambiguous' && e.metrics.matches === 2));
  assert.ok(rejected.events.some(e => e.stage === 'capture_done' && e.reason === 'no_candidates'));
  assert.ok(rejected.events.some(e => e.stage === 'restore_skip' && e.reason === 'no_anchor'));
  assert.ok(!JSON.stringify(rejected).includes('SECRET')); assert.ok(!JSON.stringify(rejected).includes('synthetic'));
  historyDiagnostics.start();
  const reading = anchorFixture(); reading.upsert(reading.older); await Promise.resolve();
  assert.ok(historyDiagnostics.snapshot().events.some(e => e.stage === 'restore' && e.metrics.before === 120 && e.metrics.after === 420 && e.metrics.delta === 300));
  historyDiagnostics.clear();
});
test('actual history broadcast before RPC return preserves the visible row once, with no double adjustment', async () => {
  const f = anchorFixture(), loading = f.load(); await Promise.resolve(); f.upsert(f.older); await Promise.resolve();
  f.complete(); await loading; await Promise.resolve(); assert.equal(f.scroll().scrollTop, 420);
  assert.equal(f.store.get().messages[f.base.gid]?.length, 2);
});
test('bottom realtime growth during an old-page request is not counted as top-page growth', async () => {
  const f = anchorFixture(), loading = f.load(); await Promise.resolve(); f.upsert(f.live); await Promise.resolve();
  assert.equal(f.scroll().scrollTop, 120); f.upsert(f.older); await Promise.resolve(); f.complete(); await loading; await Promise.resolve(); assert.equal(f.scroll().scrollTop, 420);
});
test('waiting user scroll establishes the latest viewport anchor, rather than dragging back to request start', async () => {
  const f = anchorFixture(), loading = f.load(); await Promise.resolve(); f.scroll().scrollTop = 200;
  f.upsert(f.older); await Promise.resolve(); f.complete(); await loading; await Promise.resolve(); assert.equal(f.scroll().scrollTop, 500);
});
test('queued history redraw never restores an anchor across account/environment/generation/room change', async () => {
  for (const change of ['account_id', 'environment', 'session_generation', 'gid'] as const) {
    const f = anchorFixture(), loading = f.load(); await Promise.resolve();
    if (change === 'gid') f.store.patch({ activeGid: 'synthetic-other-room' });
    else f.setScope({ ...f.context, [change]: change === 'session_generation' ? 2 : 'synthetic-other' } as never);
    await Promise.resolve(); f.complete(); await loading; await Promise.resolve(); assert.equal(f.scroll().scrollTop, 120);
  }
});

test('actual pagination keeps its visible anchor through local confirmation and sparse sender enrichment', async () => {
  for (const change of ['server', 'sender', 'both']) {
    const f = anchorFixture({ realScroll: true, omitSender: change !== 'server', base: { sender_role: 'merchant_self', message_id: change === 'sender' ? 'synthetic-server' : null, local_id: 'synthetic-local-anchor' } });
    const loading = f.load(); await Promise.resolve();
    f.complete([f.older, { ...f.base, message_id: 'synthetic-server', sender_id: 'synthetic-customer' }]); await loading; await Promise.resolve();
    assert.equal(f.scroll().scrollTop, 420, change); assert.equal(f.store.get().messages[f.base.gid]?.length, 2);
  }
});

test('actual history anchor rejects conflicting senders/server IDs and ambiguous local aliases', async () => {
  for (const change of ['sender', 'role', 'server', 'ambiguous']) {
    const f = anchorFixture({ base: { message_id: change === 'ambiguous' ? null : 'synthetic-server', local_id: 'synthetic-shared-local' } });
    const replacement = { ...f.base, message_id: change === 'server' ? 'synthetic-other-server' : 'synthetic-server', sender_id: change === 'sender' ? 'synthetic-other-sender' : f.base.sender_id ?? '', sender_role: change === 'role' ? 'merchant_self' as const : f.base.sender_role };
    f.store.patch({ messages: { [f.base.gid]: [f.older, replacement, ...(change === 'ambiguous' ? [{ ...replacement, message_id: 'synthetic-other-server' }] : [])] } });
    await Promise.resolve(); assert.equal(f.scroll().scrollTop, 120, change);
  }
});

test('actual history redraw uses a stable second visible row when the first anchor disappears', async () => {
  const second = { ...pending, gid: 'synthetic-anchor-room', message_id: 'synthetic-second', local_id: null, create_time_ms: 250 };
  const f = anchorFixture({ extra: [second] });
  f.store.patch({ messages: { [f.base.gid]: [f.older, second] } }); await Promise.resolve();
  assert.equal(f.scroll().scrollTop, 220, 'second row moves down 100px after 300px prepend and 200px first-row removal');
});

test('a newly sparse local alias cannot select between multiple former server identities', async () => {
  const other = { ...pending, gid: 'synthetic-anchor-room', message_id: 'synthetic-other-server', local_id: 'synthetic-shared-local', create_time_ms: 250, sender_role: 'customer' as const, sender_id: 'synthetic-customer' };
  const f = anchorFixture({ base: { local_id: 'synthetic-shared-local' }, extra: [other] });
  f.store.patch({ messages: { [f.base.gid]: [f.older, { ...f.base, message_id: null }] } }); await Promise.resolve();
  assert.equal(f.scroll().scrollTop, 120);
});

test('real chatPane and ui-kit rerender preserve user scrolling and follow realtime only while pinned', async () => {
  for (const pinned of [false, true]) {
    const f = anchorFixture({ realScroll: true }); f.scroll().scrollTop = pinned ? 600 : 200;
    f.upsert(f.live); await Promise.resolve(); assert.equal(f.scroll().dataset['scrollBottom'], pinned ? '1' : '0'); assert.equal(f.scroll().scrollTop, pinned ? 800 : 200);
    f.scroll().scrollTop = 240; f.upsert({ ...f.live, message_id: 'synthetic-live-next', create_time_ms: 400 }); await Promise.resolve();
    assert.equal(f.scroll().dataset['scrollBottom'], '0'); assert.equal(f.scroll().scrollTop, 240);
  }
});

test('real chatPane starts a new account scope at bottom even when the room ID is reused', async () => {
  for (const change of ['account_id', 'environment', 'session_generation'] as const) {
    const f = anchorFixture({ realScroll: true }); f.scroll().scrollTop = 200;
    f.setScope({ ...f.context, [change]: change === 'session_generation' ? 2 : 'synthetic-other' } as never); await Promise.resolve();
    assert.equal(f.scroll().dataset['scrollBottom'], '1'); assert.equal(f.scroll().scrollTop, 600);
  }
});

test('ID-less system first row keeps its viewport through actual pagination without becoming a message merge identity', async () => {
  const f = anchorFixture({ realScroll: true, base: { kind: 'system', sender_role: 'unknown', message_id: null, local_id: null, text: 'SYNTHETIC RECALL NOTICE' } });
  const loading = f.load(); await Promise.resolve(); f.complete(); await loading; await Promise.resolve();
  assert.equal(f.scroll().scrollTop, 420); assert.equal(f.store.get().messages[f.base.gid]?.length, 2);
  assert.equal(viewmodel.mergeHistory([f.base], [f.base]).length, 2, 'a scroll fingerprint is never a message deduplication key');
});

test('ID-less system anchors survive a page broadcast while an identified video remains below the viewport', async () => {
  const system = { ...pending, gid: 'synthetic-anchor-room', kind: 'system' as const, sender_role: 'unknown' as const, message_id: null, local_id: null, create_time_ms: 201, disposition: null };
  const video = { ...system, kind: 'video' as const, message_id: 'synthetic-video', media_url: 'https://example.invalid/video.mp4', create_time_ms: 250 };
  const f = anchorFixture({ realScroll: true, base: { kind: 'system', sender_role: 'unknown', message_id: null, local_id: null }, extra: [system, { ...system, create_time_ms: 202 }, video] });
  const loading = f.load(); await Promise.resolve(); f.upsert(f.older); await Promise.resolve();
  assert.equal(f.scroll().scrollTop, 420); f.complete(); await loading; await Promise.resolve(); assert.equal(f.scroll().scrollTop, 420);
  assert.equal(f.store.get().messages[f.base.gid]?.filter(m => m.kind === 'video').length, 1);
});

test('duplicate system fingerprints on either side refuse to guess a viewport anchor', async () => {
  for (const duplicateBefore of [true, false]) {
    const system = { ...pending, gid: 'synthetic-anchor-room', kind: 'system' as const, sender_role: 'unknown' as const, message_id: null, local_id: null, create_time_ms: 200, disposition: null };
    const f = anchorFixture({ realScroll: true, base: system, extra: duplicateBefore ? [system] : [] });
    f.store.patch({ messages: { [f.base.gid]: [f.older, system, ...(duplicateBefore ? [] : [system])] } }); await Promise.resolve();
    assert.equal(f.scroll().scrollTop, 120, duplicateBefore ? 'old-side ambiguity' : 'new-side ambiguity');
  }
});

test('system scroll fingerprints never follow changed role, sender, timestamp, visible text or account scope', async () => {
  for (const change of ['sender_role', 'sender_id', 'create_time_ms', 'text', 'scope']) {
    const f = anchorFixture({ base: { kind: 'system', sender_role: 'unknown', message_id: null, local_id: null } });
    if (change === 'scope') f.setScope({ ...f.context, session_generation: 2 });
    const updated = change === 'scope' ? f.base : { ...f.base, [change]: change === 'create_time_ms' ? 201 : 'synthetic-other' } as UiMessage;
    f.store.patch({ messages: { [f.base.gid]: [f.older, updated] } }); await Promise.resolve(); assert.equal(f.scroll().scrollTop, 120, change);
  }
});

test('ID-less system fallback respects active user scrolling, bottom pinning and account generation resets', async () => {
  const make = () => anchorFixture({ realScroll: true, base: { kind: 'system', sender_role: 'unknown', message_id: null, local_id: null } });
  const reading = make(), loading = reading.load(); await Promise.resolve(); reading.scroll().scrollTop = 200;
  reading.upsert(reading.older); await Promise.resolve(); reading.complete(); await loading; await Promise.resolve(); assert.equal(reading.scroll().scrollTop, 500);
  const pinned = make(); pinned.scroll().scrollTop = 600; pinned.upsert(pinned.live); await Promise.resolve(); assert.equal(pinned.scroll().scrollTop, 800);
  const switched = make(); switched.setScope({ ...switched.context, session_generation: 2 }); await Promise.resolve(); assert.equal(switched.scroll().scrollTop, 600);
});
