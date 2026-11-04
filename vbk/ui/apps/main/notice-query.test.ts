import { t as translateUi } from '../../packages/ui-kit/src/i18n.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { splitCategories } from './notice-ignore.ts';
import { createNoticeQuery, EMPTY_NOTICE_QUERY, type NoticeQueryState } from './notice-query.ts';
import { UiCommands, type UiNotice } from '../../packages/ipc/src/client.ts';
import type { AccountContext } from '../../packages/ipc/src/contracts.ts';

const cats = [{ id: '1:1', name: '订单', unread: 2 }, { id: '2:2', name: '系统', unread: 1 }];
const notice = (category = '1:1', id = 'n1'): UiNotice => ({ id, category_id: category, title: '通知', body: '', time_ms: 1, unread: true, url: 'https://example.com/notice' });
function deferred() { let resolve!: (value: unknown) => void; return { promise: new Promise<unknown>(r => { resolve = r; }), resolve }; }
function fixture() {
  let account: AccountContext = { account_id: 'a', environment: 'synthetic', session_generation: 1 };
  let state: NoticeQueryState = { ...EMPTY_NOTICE_QUERY };
  const calls: { command: string; payload: unknown }[] = [], failures: unknown[] = [];
  const queues = new Map<string, unknown[]>();
  const controller = createNoticeQuery({ account: () => account, current: () => state, publish: patch => { state = { ...state, ...patch }; },
    async invoke<T>(command: string, payload: unknown): Promise<T> {
      calls.push({ command, payload });
      const value = await (queues.get(command)?.shift() ?? (command === UiCommands.NOTICE_CATEGORIES ? cats : command === UiCommands.NOTICE_LIST ? [notice((payload as { category_id: string }).category_id)] : undefined));
      if (value instanceof Error || value && typeof value === 'object' && 'code' in value) throw value;
      return value as T;
    }, error: error => String(error), failed: error => failures.push(error),
  });
  return { controller, calls, failures, patch(patch: Partial<NoticeQueryState>) { state = { ...state, ...patch }; }, get state() { return state; }, queue(command: string, value: unknown) { queues.set(command, [...queues.get(command) ?? [], value]); },
    switchAccount(patch: Partial<AccountContext>) { controller.reset(); account = { ...account, ...patch }; state = { ...EMPTY_NOTICE_QUERY }; },
  };
}

test('category/list failures remain errors, retry recovers, actual empty replies are loaded', async () => {
  const f = fixture(); f.queue(UiCommands.NOTICE_CATEGORIES, new Error('offline'));
  await f.controller.categories(); assert.equal(f.state.noticeCatsStatus, 'error'); assert.equal(f.state.noticeListStatus, 'idle');
  f.queue(UiCommands.NOTICE_LIST, new Error('offline')); await f.controller.categories();
  assert.equal(f.state.noticeCatsStatus, 'loaded'); assert.equal(f.state.noticeListStatus, 'error');
  f.queue(UiCommands.NOTICE_LIST, []); await f.controller.list(); assert.equal(f.state.noticeListStatus, 'loaded'); assert.deepEqual(f.state.notices, []);
  f.queue(UiCommands.NOTICE_CATEGORIES, []); await f.controller.categories(); assert.equal(f.state.noticeCatsStatus, 'loaded'); assert.equal(f.state.noticeCat, null);
});

test('expired queries expose a login state and malformed responses never become real empty data', async () => {
  const f = fixture(); f.queue(UiCommands.NOTICE_CATEGORIES, { code: 'account.ticket_expired', message: 'expired' });
  await f.controller.categories(); assert.equal(f.state.noticeCatsStatus, 'expired');
  f.queue(UiCommands.NOTICE_CATEGORIES, {}); await f.controller.categories(); assert.equal(f.state.noticeCatsStatus, 'error');
  f.queue(UiCommands.NOTICE_LIST, [notice('wrong')]); await f.controller.categories(); assert.equal(f.state.noticeListStatus, 'error'); assert.deepEqual(f.state.notices, []);
});

test('latest category refresh wins and account visit/session/environment changes reject late replies', async () => {
  for (const patch of [{ account_id: 'b' }, { environment: 'other' }, { session_generation: 2 }]) {
    for (const result of [cats, new Error('late failure')]) {
      const f = fixture(), pending = deferred(); f.queue(UiCommands.NOTICE_CATEGORIES, pending.promise);
      const old = f.controller.categories(); f.switchAccount(patch); f.switchAccount({ account_id: 'a', environment: 'synthetic', session_generation: 1 });
      await f.controller.categories(); const expected = f.state; pending.resolve(result); await old; assert.equal(f.state, expected);
    }
  }
  const f = fixture(), pending = deferred(); f.queue(UiCommands.NOTICE_CATEGORIES, pending.promise);
  const old = f.controller.categories(); await f.controller.categories(); const expected = f.state;
  pending.resolve([]); await old; assert.equal(f.state, expected);
});

test('category A→B→A and same-category retries reject stale list success/error', async () => {
  for (const result of [[notice('1:1', 'old')], new Error('old')]) {
    const f = fixture(); await f.controller.categories(); const pending = deferred(); f.queue(UiCommands.NOTICE_LIST, pending.promise);
    const old = f.controller.list(); await f.controller.pick('2:2'); assert.equal(f.state.notices[0]?.category_id, '2:2');
    await f.controller.pick('1:1'); const expected = f.state; pending.resolve(result); await old; assert.equal(f.state, expected);
  }
  const f = fixture(); await f.controller.categories(); const pending = deferred(); f.queue(UiCommands.NOTICE_LIST, pending.promise);
  const old = f.controller.list(); await f.controller.list(); const expected = f.state; pending.resolve([notice('1:1', 'old')]); await old; assert.equal(f.state, expected);
});

test('failed single/all mark-read leaves unread unchanged; undefined command success is accepted', async () => {
  for (const id of ['n1', null]) {
    const f = fixture(); await f.controller.categories(); f.queue(UiCommands.NOTICE_MARK_READ, new Error('denied'));
    assert.equal(await f.controller.markRead('1:1', id), false); assert.equal(f.state.notices[0]?.unread, true); assert.equal(f.failures.length, 1);
    assert.equal(await f.controller.markRead('1:1', id), true); assert.equal(f.state.notices[0]?.unread, false);
    assert.deepEqual(f.calls.filter(c => c.command === UiCommands.NOTICE_MARK_READ).at(-1)?.payload, { account: { account_id: 'a', environment: 'synthetic', session_generation: 1 }, category_id: '1:1', id });
  }
});

test('mark-read late success and failure cannot mutate another account or a revisited category', async () => {
  for (const change of ['account', 'category']) for (const result of [undefined, new Error('denied')]) {
    const f = fixture(); await f.controller.categories(); const pending = deferred(); f.queue(UiCommands.NOTICE_MARK_READ, pending.promise);
    const old = f.controller.markRead('1:1', null);
    if (change === 'account') { f.switchAccount({ account_id: 'b' }); await f.controller.categories(); }
    else { await f.controller.pick('2:2'); await f.controller.pick('1:1'); }
    const expected = f.state; pending.resolve(result); assert.equal(await old, false); assert.equal(f.state, expected); assert.equal(f.failures.length, 0); assert.equal(f.state.notices[0]?.unread, true);
  }
});

// Render the actual production function with a minimal element port to verify what users see.
const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
function render(state: NoticeQueryState, extra: Record<string, unknown> = {}) {
  const start = source.indexOf('function notificationsView('), end = source.indexOf('// ---- order contact view', start);
  const fn = new Function('h', 't', 'cx', 'icon', 'IC', 'accBadge', 'formatRelativeTime', 'splitCategories', 'ignoredNoticeCats', 'noticeBannerCats', 'openNoticeCatMenu', 'setNoticeCatIgnored', 'store', 'S', stripTypeScriptTypes(source.slice(start, end)) + '\nreturn notificationsView;')(
    (tag: string, props: unknown, ...children: unknown[]) => ({ tag, props, children }), translateUi, () => '', () => null, {}, () => null, () => 'now',
    splitCategories, (s: { noticeIgnored?: Record<string, string[]> }) => s.noticeIgnored?.['synthetic:a'] ?? [], (s: { noticeBanner?: string[] }) => s.noticeBanner ?? [], () => {}, () => {}, { patch() {} }, () => ({}));
  return JSON.stringify(fn({ ...state, noticeIgnored: {}, noticeIgnoredOpen: false, now: 1, ...extra }));
}
test('actual notification UI distinguishes category/list loading, failed, expired and confirmed empty', () => {
  assert.match(render({ ...EMPTY_NOTICE_QUERY, noticeCatsStatus: 'loading' }), /正在加载通知分类/);
  const failed = render({ ...EMPTY_NOTICE_QUERY, noticeCatsStatus: 'error', noticeCatsError: 'offline' }); assert.match(failed, /通知分类加载失败/); assert.doesNotMatch(failed, /暂无通知分类|notice.empty/);
  assert.match(render({ ...EMPTY_NOTICE_QUERY, noticeCatsStatus: 'expired' }), /登录已过期/);
  const base: NoticeQueryState = { ...EMPTY_NOTICE_QUERY, noticeCats: cats, noticeCat: '1:1', noticeCatsStatus: 'loaded' };
  assert.match(render({ ...base, noticeListStatus: 'loading' }), /正在加载通知…/);
  assert.match(render({ ...base, noticeListStatus: 'error' }), /通知加载失败/);
  assert.match(render({ ...base, noticeListStatus: 'loaded' }), new RegExp(translateUi('notice.empty')));
});

test('account chat load starts notice read independently and does not await notice results', () => {
  const loader = source.slice(source.indexOf('async function loadForActiveAccount('), source.indexOf('async function loadPrefs('));
  assert.match(loader, /void noticeQuery.categories\(\)/); assert.doesNotMatch(loader, /await (?:noticeQuery|loadNotices)|NOTICE_CATEGORIES/);
});

const page = (category: string, newest: number, count = 100): UiNotice[] => Array.from({ length: count }, (_, i) => ({ ...notice(category, String(newest - i)), time_ms: newest - i }));
test('pagination passes oldest before_ms, merges pages by id, retries failure and stops on short/no-progress pages', async () => {
  const f = fixture(); f.queue(UiCommands.NOTICE_LIST, page('1:1', 500)); await f.controller.categories();
  assert.equal(f.state.noticeBeforeMs, 401); assert.equal(f.state.noticeHasMore, true); assert.equal(f.state.notices.length, 100);
  f.queue(UiCommands.NOTICE_LIST, new Error('offline')); await f.controller.more();
  assert.equal(f.state.noticeMoreStatus, 'error'); assert.equal(f.state.notices.length, 100); assert.equal(f.state.noticeBeforeMs, 401);
  f.queue(UiCommands.NOTICE_LIST, page('1:1', 401)); await f.controller.more();
  assert.deepEqual(f.calls.filter(c => c.command === UiCommands.NOTICE_LIST).at(-1)?.payload, { account: { account_id: 'a', environment: 'synthetic', session_generation: 1 }, category_id: '1:1', before_ms: 401 });
  assert.equal(f.state.notices.length, 199); assert.equal(f.state.noticeBeforeMs, 302); assert.equal(f.state.noticeHasMore, true);
  f.queue(UiCommands.NOTICE_LIST, page('1:1', 301, 40)); await f.controller.more(); assert.equal(f.state.notices.length, 239); assert.equal(f.state.noticeHasMore, false);
  const count = f.calls.length; await f.controller.more(); assert.equal(f.calls.length, count);
  f.queue(UiCommands.NOTICE_LIST, page('1:1', 500)); await f.controller.list();
  f.queue(UiCommands.NOTICE_LIST, Array.from({ length: 100 }, (_, i) => ({ ...notice('1:1', `stuck-${i}`), time_ms: 401 })));
  await f.controller.more(); assert.equal(f.state.noticeHasMore, false);
});

test('paging is single-flight and late pages cannot cross category/account changes or undo a successful receipt', async () => {
  for (const change of ['category', 'account', 'read']) {
    const f = fixture(); f.queue(UiCommands.NOTICE_LIST, page('1:1', 500)); await f.controller.categories();
    const pending = deferred(); f.queue(UiCommands.NOTICE_LIST, pending.promise); const old = f.controller.more();
    const count = f.calls.length; await f.controller.more(); assert.equal(f.calls.length, count);
    if (change === 'category') await f.controller.pick('2:2');
    else if (change === 'account') { f.switchAccount({ session_generation: 2 }); await f.controller.categories(); }
    else assert.equal(await f.controller.markRead('1:1', null), true);
    const rows = f.state.notices; pending.resolve(page('1:1', 400)); await old; assert.equal(f.state.notices, rows);
    if (change === 'read') { assert.equal(f.state.notices.some(n => n.unread), false); assert.equal(f.state.noticeMoreStatus, 'idle'); }
  }
});

test('actual pagination UI keeps loaded rows and offers loading, error retry and expired login actions', () => {
  const base: NoticeQueryState = { ...EMPTY_NOTICE_QUERY, noticeCats: cats, noticeCat: '1:1', noticeCatsStatus: 'loaded', noticeListStatus: 'loaded', notices: [notice()], noticeHasMore: true, noticeBeforeMs: 1 };
  assert.match(render(base), /加载更多/);
  assert.match(render({ ...base, noticeMoreStatus: 'loading' }), /正在加载…/);
  assert.match(render({ ...base, noticeMoreStatus: 'error', noticeMoreError: 'offline' }), /更多通知加载失败/);
  assert.match(render({ ...base, noticeMoreStatus: 'expired' }), /登录已过期/);
});

test('raw 100-row pages with duplicate IDs retain pagination while displayed rows are deduplicated', async () => {
  const f = fixture();
  const first = [...page('1:1', 500, 99), { ...notice('1:1', '500'), time_ms: 500 }];
  f.queue(UiCommands.NOTICE_LIST, first); await f.controller.categories();
  assert.equal(f.state.notices.length, 99); assert.equal(f.state.noticeHasMore, true); assert.equal(f.state.noticeBeforeMs, 402);
  const second = [...page('1:1', 401, 99), { ...notice('1:1', '401'), time_ms: 401 }];
  f.queue(UiCommands.NOTICE_LIST, second); await f.controller.more();
  assert.equal(f.state.notices.length, 198); assert.equal(f.state.noticeHasMore, true); assert.equal(f.state.noticeBeforeMs, 303);
  assert.equal(new Set(f.state.notices.map(n => n.id)).size, 198);
  assert.equal((f.calls.filter(c => c.command === UiCommands.NOTICE_LIST).at(-1)?.payload as { before_ms: number }).before_ms, 402);
});

function actualOpenNotice(f: ReturnType<typeof fixture>) {
  const opened: unknown[] = [], external: unknown[] = [];
  const start = source.indexOf('async function openNotice('), end = source.indexOf('\nasync function markAllNotices(', start);
  const open = new Function('activeAccount', 'S', 'noticeQuery', 'invokeSafe', 'browserTabs', 'UiCommands', stripTypeScriptTypes(source.slice(start, end)) + '\nreturn openNotice;')(
    () => ({ context: { account_id: 'a', environment: 'synthetic', session_generation: 1 } }), () => f.state, f.controller,
    async (command: string, payload: unknown) => { external.push({ command, payload }); }, { open: async (context: unknown, url: string) => { opened.push({ context, url }); } }, UiCommands) as (notice: UiNotice) => Promise<void>;
  return { open, opened, external };
}

test('actual openNotice cannot open an external URL after failed receipt or late account/category ABA', async () => {
  for (const change of ['failed', 'account-ABA', 'category-ABA']) {
    const f = fixture(); await f.controller.categories(); const view = actualOpenNotice(f), pending = deferred();
    f.queue(UiCommands.NOTICE_MARK_READ, pending.promise);
    const opening = view.open(f.state.notices[0]!);
    if (change === 'account-ABA') {
      f.switchAccount({ account_id: 'b' }); f.switchAccount({ account_id: 'a' }); await f.controller.categories();
    } else if (change === 'category-ABA') { await f.controller.pick('2:2'); await f.controller.pick('1:1'); }
    pending.resolve(change === 'failed' ? new Error('denied') : undefined); await opening;
    assert.deepEqual(view.opened, [], change);
  }
});

test('actual openNotice opens only after successful current receipt; already-read notices open directly', async () => {
  const f = fixture(); await f.controller.categories(); const view = actualOpenNotice(f);
  await view.open(f.state.notices[0]!);
  assert.deepEqual(view.opened, [{ context: { account_id: 'a', environment: 'synthetic', session_generation: 1 }, url: 'https://example.com/notice' }]);
  assert.deepEqual(view.external, [], 'notice links open in the in-app browser tab, never the external browser');
  const read = f.state.notices[0]!; assert.equal(read.unread, false);
  const count = f.calls.filter(c => c.command === UiCommands.NOTICE_MARK_READ).length;
  await view.open(read); assert.equal(view.opened.length, 2);
  assert.equal(f.calls.filter(c => c.command === UiCommands.NOTICE_MARK_READ).length, count);
});

test('a confirmed zero unread category clears all existing rows only if the queried row snapshot is still current', async () => {
  const f = fixture(); f.queue(UiCommands.NOTICE_LIST, [notice('1:1', 'first'), notice('1:1', 'second')]); await f.controller.categories();
  const zeroCats = cats.map(c => c.id === '1:1' ? { ...c, unread: 0 } : c);
  f.queue(UiCommands.NOTICE_CATEGORIES, zeroCats); await f.controller.markRead('1:1', 'first');
  for (let i = 0; i < 5; ++i) await Promise.resolve();
  assert.equal(f.state.notices.every(n => !n.unread), true);
  const pending = deferred(); f.queue(UiCommands.NOTICE_CATEGORIES, pending.promise);
  const refresh = f.controller.categories(false);
  f.patch({ notices: [...f.state.notices, notice('1:1', 'new-arrival')] });
  pending.resolve(zeroCats); await refresh;
  assert.equal(f.state.notices.find(n => n.id === 'new-arrival')?.unread, true);
});

test('mark-all only updates rows present in its request snapshot, preserving newly arrived notices', async () => {
  const f = fixture(); f.queue(UiCommands.NOTICE_LIST, [notice('1:1', 'first'), notice('1:1', 'second')]); await f.controller.categories();
  const pending = deferred(); f.queue(UiCommands.NOTICE_MARK_READ, pending.promise);
  const marking = f.controller.markRead('1:1', null);
  f.patch({ notices: [...f.state.notices, notice('1:1', 'new-arrival')] });
  pending.resolve(undefined); assert.equal(await marking, true);
  assert.equal(f.state.notices.find(n => n.id === 'first')?.unread, false);
  assert.equal(f.state.notices.find(n => n.id === 'second')?.unread, false);
  assert.equal(f.state.notices.find(n => n.id === 'new-arrival')?.unread, true);
});

test('merged older pages stay newest first, including overlapping IDs', async () => {
  const f = fixture(); f.queue(UiCommands.NOTICE_LIST, page('1:1', 500)); await f.controller.categories();
  assert.deepEqual(f.state.notices.map(n => n.time_ms), Array.from({ length: 100 }, (_, i) => 500 - i));
  f.queue(UiCommands.NOTICE_LIST, page('1:1', 401)); await f.controller.more();
  assert.deepEqual(f.state.notices.map(n => n.time_ms), Array.from({ length: 199 }, (_, i) => 500 - i));
});

test('account visit guards remain valid through category selection but reject account ABA', async () => {
  const f = fixture(); await f.controller.categories();
  const currentAccount = f.controller.accountGuard(), currentSelection = f.controller.selectionGuard();
  await f.controller.pick('2:2'); assert.equal(currentAccount(), true); assert.equal(currentSelection(), false);
  f.switchAccount({ account_id: 'b' }); f.switchAccount({ account_id: 'a' });
  assert.equal(currentAccount(), false);
});

test('ignored categories are never selected by default or as the fallback', async () => {
  let state: NoticeQueryState = { ...EMPTY_NOTICE_QUERY }, ignored: string[] = ['1:1'];
  const lists: string[] = [];
  const controller = createNoticeQuery({ account: () => ({ account_id: 'a', environment: 'synthetic', session_generation: 1 }), current: () => state, publish: patch => { state = { ...state, ...patch }; },
    async invoke<T>(command: string, payload: unknown): Promise<T> {
      if (command === UiCommands.NOTICE_LIST) { lists.push((payload as { category_id: string }).category_id); return [notice((payload as { category_id: string }).category_id)] as T; }
      return cats as T;
    }, error: String, failed: () => {}, ignored: () => ignored });
  await controller.categories();
  assert.equal(state.noticeCat, '2:2'); assert.deepEqual(lists, ['2:2']);
  assert.equal(state.noticeCats.length, 2); // 分类仍然完整保留，供“已忽略”区恢复
  ignored = ['1:1', '2:2'];
  await controller.categories();
  assert.equal(state.noticeCat, null); assert.deepEqual(state.notices, []); assert.deepEqual(lists, ['2:2']);
  ignored = [];
  await controller.categories();
  assert.equal(state.noticeCat, '1:1');
});

test('actual notification UI marks only the categories using a banner', () => {
  const base: NoticeQueryState = { ...EMPTY_NOTICE_QUERY, noticeCats: cats, noticeCat: '1:1', noticeCatsStatus: 'loaded' };
  assert.doesNotMatch(render(base), /"catBanner"/);
  const on = render(base, { noticeBanner: ['2:2'] });
  assert.match(on, /"catBanner":"2:2"/); assert.doesNotMatch(on, /"catBanner":"1:1"/);
});

test('actual notification UI hides ignored categories, lists them for restore and reports when all are ignored', () => {
  const base: NoticeQueryState = { ...EMPTY_NOTICE_QUERY, noticeCats: cats, noticeCat: '2:2', noticeCatsStatus: 'loaded' };
  const some = render(base, { noticeIgnored: { 'synthetic:a': ['1:1'] }, noticeIgnoredOpen: true });
  assert.doesNotMatch(some, /"cat":"1:1"/); assert.match(some, /"cat":"2:2"/); assert.match(some, /"catIgnored":"1:1"/); assert.match(some, /已忽略的分类（1）/);
  assert.doesNotMatch(render(base, { noticeIgnored: { 'synthetic:a': ['1:1'] } }), /"catIgnored"/); // 默认折叠
  const none = render({ ...base, noticeCat: null }, { noticeIgnored: { 'synthetic:a': ['1:1', '2:2'] } });
  assert.match(none, /所有分类均已忽略/);
});
