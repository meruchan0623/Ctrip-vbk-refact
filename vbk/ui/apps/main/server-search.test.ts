import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServerSearchPanel, EMPTY_SERVER_SEARCH, dateSearchRange, searchDateBounds, serverSearchView, type ServerSearchState } from './server-search.ts';
import { UiCommands, type UiMessage } from '../../packages/ipc/src/client.ts';
import type { AccountContext } from '../../packages/ipc/src/contracts.ts';
import type { UiServerSearchPage, UiServerSearchQuery, UiSearchHistoryRequest } from '../../packages/ipc/src/server-search.ts';
import { installFakeDom } from '../../tests/fake-dom.ts';

const hit = (token = 'token-1', id = 'm1') => ({ selection_token: token, gid: 'room', message_id: id, time_ms: 1700000000000, title: '客人记录', preview: 'matched text' });
const message = (id: string): UiMessage => ({ gid: 'room', message_id: id, local_id: null, create_time_ms: 1700000000000, sender_role: 'customer', sender_id: 'customer', kind: 'text', text: 'history text', translation: null, original: null, quote: null, order_id: null, disposition: null });
const deferred = () => { let resolve!: (value: unknown) => void; return { promise: new Promise<unknown>(r => { resolve = r; }), resolve }; };
function fixture() {
  let state: ServerSearchState = { ...EMPTY_SERVER_SEARCH }, account: AccountContext = { account_id: 'A', environment: 'synthetic', session_generation: 1 };
  const calls: { cmd: string; payload: { query: UiServerSearchQuery & UiSearchHistoryRequest } }[] = [], queue: unknown[] = [];
  const controller = createServerSearchPanel({ account: () => account, current: () => state, publish: value => { state = value; }, error: e => e instanceof Error ? e.message : String(e),
    async invoke<T>(cmd: string, raw: unknown): Promise<T> {
      const payload = raw as { query: UiServerSearchQuery & UiSearchHistoryRequest }; calls.push({ cmd, payload });
      if (queue.length) { const value = await queue.shift(); if (value instanceof Error) throw value; return value as T; }
      if (cmd === UiCommands.SERVER_SEARCH) return { query_id: payload.query.query_id, search_type: payload.query.search_type, page_no: payload.query.page_no, page_count: 2, has_more: payload.query.page_no < 2 && payload.query.search_type !== 3, groups: { customer: [], content: [hit(`token-${payload.query.page_no}`, `m${payload.query.page_no}`)], order: [], date: [] } } as T;
      return { selection_token: payload.query.selection_token, direction: payload.query.direction, items: [message('m1')], cursor_ms: 1699999999000, has_more: false, anchor_message_id: 'm1' } as T;
    },
  });
  return { controller, calls, get state() { return state; }, setAccount(value: AccountContext) { account = value; }, queue(value: unknown) { queue.push(value); } };
}

test('search, append and independent hit history use only read commands and retain earlier page tokens', async () => {
  const f = fixture(); f.controller.configure({ type: 0, text: 'find' }); await f.controller.search();
  assert.equal(f.state.result?.has_more, true);
  await f.controller.more();
  assert.equal(f.state.result?.groups.content.length, 2);
  assert.equal(f.calls[0]?.payload.query.query_id, f.calls[1]?.payload.query.query_id);
  const first = f.state.result!.groups.content[0]!;
  await f.controller.pick(first);
  assert.equal(f.state.selected?.selection_token, 'token-1');
  assert.equal(f.state.messages.length, 1, 'overlapping anchored directions deduplicate by exact message id');
  assert.deepEqual(f.calls.map(c => c.cmd), [UiCommands.SERVER_SEARCH, UiCommands.SERVER_SEARCH, UiCommands.SEARCH_HISTORY, UiCommands.SEARCH_HISTORY]);
  assert.deepEqual(f.calls.slice(2).map(c => c.payload.query), ['prev', 'next'].map(direction => ({ selection_token: 'token-1', direction })));
});

test('changed form immediately rejects in-flight search and A→B→A visit rejects late data', async () => {
  const f = fixture(), wait = deferred();
  f.controller.configure({ text: 'old' }); f.queue(wait.promise); const pending = f.controller.search();
  const original = f.calls[0]!.payload.query;
  f.controller.configure({ text: 'new' });
  wait.resolve({ query_id: original.query_id, search_type: 3, page_no: 1, page_count: 1, has_more: false, groups: { customer: [hit()], content: [], order: [], date: [] } });
  await pending; assert.equal(f.state.result, null); assert.equal(f.state.text, 'new');
  const again = deferred(); f.queue(again.promise); const second = f.controller.search();
  f.controller.reset(); f.setAccount({ account_id: 'B', environment: 'synthetic', session_generation: 1 }); f.controller.reset(); f.setAccount({ account_id: 'A', environment: 'synthetic', session_generation: 1 });
  again.resolve({}); await second; assert.equal(f.state.result, null); assert.equal(f.state.status, 'idle');
});

test('a selected history cannot publish after selection changes or account generation expires', async () => {
  const f = fixture(); f.controller.configure({ type: 0, text: 'find' }); await f.controller.search();
  const a = deferred(), b = deferred(); f.queue(a.promise); f.queue(b.promise);
  const pending = f.controller.pick(f.state.result!.groups.content[0]!);
  f.controller.closeHistory();
  const page = { selection_token: 'token-1', direction: 'prev', items: [message('m1')], cursor_ms: null, has_more: false, anchor_message_id: 'm1' };
  a.resolve(page); b.resolve({ ...page, direction: 'next' }); await pending;
  assert.equal(f.state.selected, null); assert.deepEqual(f.state.messages, []);
  const c = deferred(), d = deferred(); f.queue(c.promise); f.queue(d.promise);
  const next = f.controller.pick(f.state.result!.groups.content[0]!);
  f.setAccount({ account_id: 'A', environment: 'synthetic', session_generation: 2 });
  c.resolve(page); d.resolve({ ...page, direction: 'next' }); await next; assert.deepEqual(f.state.messages, []);
});

test('errors and empty results remain distinct and retryable without automatic requests', async () => {
  const f = fixture(); f.controller.configure({ text: 'find' }); f.queue(new Error('offline')); await f.controller.search();
  assert.equal(f.state.status, 'error'); assert.equal(f.state.error, 'offline'); assert.equal(f.calls.length, 1);
  await f.controller.search(); assert.equal(f.state.status, 'loaded');
  f.controller.configure({ text: ' ' }); await f.controller.search(); assert.equal(f.calls.length, 2); assert.equal(f.state.status, 'error');
});

test('local dates use day boundaries and three-month clamp, including month-end dates', () => {
  const now = new Date(2026, 4, 31, 12);
  assert.deepEqual(searchDateBounds(now), { min: '2026-02-28', max: '2026-05-31' });
  const range = dateSearchRange('2026-05-01', '2026-05-02', now);
  assert.equal(range.start_ms, new Date(2026, 4, 1).getTime());
  assert.equal(range.end_ms, new Date(2026, 4, 3).getTime() - 1);
  for (const values of [['2026-02-27', '2026-05-01'], ['2026-05-04', '2026-05-01'], ['2026-02-31', '2026-05-01']]) assert.throws(() => dateSearchRange(values[0]!, values[1]!, now));
});

test('real search view exposes five modes, four all groups, view-all and readonly anchor without a chat action', () => {
  const { root } = installFakeDom(), f = fixture();
  const page: UiServerSearchPage = { query_id: 'q', search_type: 3, page_no: 1, page_count: 5, has_more: false, groups: { customer: [hit(), hit('2'), hit('3'), hit('4')], content: [], order: [], date: [] } };
  root.appendChild(serverSearchView({ ...f.state, result: page, selected: hit(), messages: [message('m1')] }, f.controller) as unknown as Parameters<typeof root.appendChild>[0]);
  assert.ok(root.textContent.includes('搜索聊天记录'));
  assert.ok(root.textContent.includes('查看全部'));
  assert.ok(root.textContent.includes('消息内容'));
  assert.ok(root.textContent.includes('history text'));
  assert.equal(root.querySelectorAll('[data-search-group]').length, 4);
  assert.equal(root.querySelectorAll('[data-anchor="true"]').length, 1);
  const source = readFileSync(new URL('./server-search.ts', import.meta.url), 'utf8');
  assert.equal(/IM_MARK_READ|ORDER_CREATE_IM_CHAT|IM_MESSAGES|openConversation/.test(source), false);
});

test('stable message identity deduplicates timestamp corrections within one gid and preserves another gid', async () => {
  const f = fixture(); f.controller.configure({ type: 0, text: 'find' }); await f.controller.search();
  const first = f.state.result!, original = first.groups.content[0]!;
  f.queue({ ...first, page_no: 2, has_more: false, groups: { ...first.groups, content: [{ ...original, selection_token: 'corrected', time_ms: original.time_ms + 1000 }, { ...original, gid: 'other-room', selection_token: 'other', time_ms: original.time_ms + 2000 }] } });
  await f.controller.more();
  assert.equal(f.state.result?.groups.content.length, 2);
  assert.deepEqual(f.state.result?.groups.content.map(row => [row.gid, row.time_ms]), [['room', original.time_ms + 1000], ['other-room', original.time_ms + 2000]]);
});

test('actual DOM marks the selected search option after category and date changes', () => {
  const { root } = installFakeDom(), f = fixture();
  for (const type of [1, 4] as const) {
    root.replaceChildren(serverSearchView({ ...f.state, type }, f.controller) as unknown as Parameters<typeof root.appendChild>[0]);
    const selected = root.querySelectorAll('option').filter(option => (option as unknown as { selected: boolean }).selected);
    assert.equal(selected.length, 1);
    assert.equal(selected[0]?.value, String(type));
  }
});
