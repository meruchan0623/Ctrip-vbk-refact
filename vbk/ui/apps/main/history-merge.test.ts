import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import * as viewmodel from './viewmodel.ts';
import { mergeMessageProfile } from './message-profile.ts';
import { isUiMessage } from '../_shared/guards.ts';
import type { UiMessage } from '../../packages/ipc/src/client.ts';
const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
const pending: UiMessage = { gid: 'synthetic-A', message_id: null, local_id: 'synthetic-local', text: 'SYNTHETIC CURRENT', kind: 'text', create_time_ms: 100, sender_role: 'merchant_self', sender_id: 'synthetic-agent', sender_name: 'Synthetic Agent', sender_avatar: 'https://example.invalid/current.png', disposition: { kind: 'unknown' }, translation: null, original: null, quote: null, order_id: null };
const confirmed: UiMessage = { ...pending, message_id: 'synthetic-server', text: 'SYNTHETIC HISTORY', sender_name: null, sender_avatar: null, disposition: { kind: 'confirmed', server_message_id: 'synthetic-server', server_time_ms: 105 } };
function fixture(current: UiMessage[], page: UiMessage[]) {
  const state = { activeGid: 'synthetic-B', messages: { [pending.gid]: current }, drafts: {}, conversations: [{ gid: pending.gid, unread_count: 0 }], history: {}, banners: [], draftVersion: 0, view: 'messages', quote: null };
  const env = { ...viewmodel, mergeMessageProfile, isUiMessage, S: () => state, store: { patch: (patch: object) => Object.assign(state, patch) }, activeAccount: () => ({ context: { account_id: 'synthetic-account', environment: 'test', session_generation: 1 } }), stillActive: () => true, peripheral: { close: () => {} }, TRANSLATION_IDLE: {}, PKG_IDLE: {}, UiCommands: { IM_MESSAGE_PAGE: 'page' }, invokeQuiet: async () => ({ items: page, has_more: false, before_ms: null }), autoQueryPackage: () => {} };
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
  const state = { activeGid: pending.gid, messages: { [pending.gid]: [pending] }, history: { [pending.gid]: { hasMore: true, beforeMs: 100, busy: false } } };
  const env = { ...viewmodel, S: () => state, store: { patch: (patch: object) => Object.assign(state, patch) }, stillActive: () => active, invokeSafe: (...args: unknown[]) => { requests.push(args); return new Promise(resolve => { complete = resolve; }); }, UiCommands: { IM_MESSAGE_PAGE: 'page' }, isUiMessage, document: { querySelector: () => scroll }, queueMicrotask: (callback: () => void) => queued.push(callback) };
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
  const state = { activeGid: pending.gid, messages: { [pending.gid]: [pending] }, history: { [pending.gid]: { hasMore: true, beforeMs: 100, busy: false } } };
  const env = { ...viewmodel, S: () => state, store: { patch: (patch: object) => Object.assign(state, patch) }, stillActive: () => active, invokeSafe: () => new Promise(resolve => { complete = resolve; }), UiCommands: { IM_MESSAGE_PAGE: 'page' }, isUiMessage, document: { querySelector: () => { throw new Error('stale page must not inspect current DOM'); } } };
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
function anchorFixture() {
  const scope = { account_id: 'synthetic-account', environment: 'synthetic', session_generation: 1 };
  let owner = scope;
  const base: UiMessage = { ...pending, gid: 'synthetic-anchor-room', sender_role: 'customer', sender_id: 'synthetic-customer', message_id: 'synthetic-anchor-current', local_id: null, create_time_ms: 200, disposition: null };
  const older = { ...base, message_id: 'synthetic-anchor-old', create_time_ms: 100 };
  const live = { ...base, message_id: 'synthetic-anchor-live', create_time_ms: 300 };
  const store = createStore({ activeGid: base.gid, messages: { [base.gid]: [base] } as Record<string, UiMessage[]>, history: { [base.gid]: { hasMore: true, beforeMs: 200, busy: false } }, quote: null });
  let complete!: (page: unknown) => void;
  type Row = { dataset: Record<string, string>; getBoundingClientRect(): { top: number; bottom: number } };
  class Scroll {
    scrollTop = 120; clientHeight = 400; scrollHeight = 1000;
    dataset: Record<string, string> = {}; rows: Row[] = [];
    getBoundingClientRect() { return { top: 50, bottom: 450 }; }
    querySelectorAll() { return this.rows; }
  }
  let scroll = new Scroll();
  class Root { constructor(readonlyScroll: Scroll) { this.scroll = readonlyScroll; } scroll: Scroll; querySelectorAll() { return []; } querySelector() { return null; } }
  const env: Record<string, unknown> = { ...viewmodel, messageAlignment, cx, createStore, subscribeBatched, store, S: () => store.get(), activeAccount: () => ({ context: owner }), activeConv: () => ({ gid: store.get().activeGid, account: owner }), stillActive: (account: typeof scope) => account.account_id === owner.account_id && account.environment === owner.environment && account.session_generation === owner.session_generation, isUiMessage, invokeSafe: () => new Promise(resolve => { complete = resolve; }), UiCommands: { IM_MESSAGE_PAGE: 'page' }, document: { querySelector: () => scroll }, queueMicrotask, Element: Root, CSS: { escape: encodeURIComponent }, root: { querySelector: () => null }, renderMessageAvatar: () => 'avatar', formatDate: () => 'date', formatClock: () => 'time', t: (key: string) => key, icon: () => null, IC: {}, richText: (text: string) => [text], h: (tag: string, props: unknown, ...children: unknown[]) => ({ tag, props, children }) };
  function actual(name: string, next: string, async = false) { const a = source.indexOf(`${async ? 'async ' : ''}function ${name}(`), b = source.indexOf(`\n${next}`, a); assert.ok(a >= 0 && b > a, name); return new Function(...Object.keys(env), stripTypeScriptTypes(source.slice(a, b)) + '\nreturn ' + name + ';')(...Object.values(env)); }
  // Load the actual helper group when present; the old production callback is exercised unchanged for red evidence.
  for (const [name, next] of [['captureMessageAnchor', 'function restoreMessageAnchor('], ['restoreMessageAnchor', 'function withMessageAnchor('], ['withMessageAnchor', 'function messageRow(']] as const) if (source.includes(`function ${name}(`)) env[name] = actual(name, next);
  if (source.includes('function mediaNodeKey(')) env['mediaNodeKey'] = actual('mediaNodeKey', source.includes('function captureMessageAnchor(') ? 'function captureMessageAnchor(' : 'function messageRow(');
  const row = actual('messageRow', 'function translationBar(');
  function build() {
    const next = new Scroll(); next.scrollTop = scroll.scrollTop;
    next.dataset['historyScope'] = env['historyScopeKey'] ? (env['historyScopeKey'] as (account: typeof scope, gid: string) => string)(owner, store.get().activeGid) : 'old-scope';
    let offset = 100;
    for (const message of store.get().messages[store.get().activeGid] ?? []) {
      const rendered = row({ ...store.get(), prefs: { general: { show_msg_time: false } } }, message, { gid: store.get().activeGid, account: owner, title: 'Synthetic Customer', color: '#aaa' }, { context: owner });
      const height = message.create_time_ms < 200 ? 300 : 200;
      const at = offset;
      next.rows.push({ dataset: rendered.props.dataset ?? {}, getBoundingClientRect: () => ({ top: 50 + at - next.scrollTop, bottom: 50 + at + height - next.scrollTop }) });
      offset += height;
    }
    next.scrollHeight = 1000 + (store.get().messages[store.get().activeGid] ?? []).filter(m => m.create_time_ms < 200).length * 300 + (store.get().messages[store.get().activeGid] ?? []).filter(m => m.create_time_ms > 200).length * 200;
    return new Root(next);
  }
  env['render'] = build; env['rerender'] = (_root: unknown, render: () => Root) => { const top = scroll.scrollTop; const next = render(); scroll = next.scroll; scroll.scrollTop = top; };
  scroll = build().scroll;
  const a = source.indexOf('subscribeBatched(store,'), b = source.indexOf('\nrerender(root, () => render(S()));', a);
  new Function(...Object.keys(env), stripTypeScriptTypes(source.slice(a, b)))(...Object.values(env));
  const load = actual('loadEarlier', '/** `im://locate-conversation`', true), upsert = actual('upsertMessage', 'function upsertConversation(');
  return { store, older, live, base, context: scope, scroll: () => scroll, load: () => load({ gid: base.gid, account: scope }), upsert, complete: () => complete({ items: [older], has_more: false, before_ms: null }), setScope: (next: typeof scope) => { owner = next; store.patch({ activeGid: base.gid }); } };
}
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
