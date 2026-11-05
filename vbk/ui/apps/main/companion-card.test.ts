import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMPANION_MAX_HEIGHT, alignTrackItem, companionPackageCard, formatOrderTime, formatReissueTime, packageFreshness, preserveCompanionFocus } from './companion-card.ts';
import { COMPANION_CARD_STYLE } from './companion-card-style.ts';
import { packageInfo } from './package-preview.ts';
import type { PackagePlanInfo } from './package-preview.ts';
import type { h } from '../../packages/ui-kit/src/h.ts';
const plan: PackagePlanInfo = { plan: '渠道套餐', iccid: '8986000000000000001', status: '使用中', remain: '1 GB', remain_pct: 50, total: '2 GB', supplier: '供应商', apn: 'internet', fetched_at_ms: 1,
  detail_fields: [{ label: '业务流水号', value: '123456789' }, { label: '来源套餐', value: '原始套餐' }, { label: 'eSIM状态', value: 'Enabled' }],
  live_fields: [{ label: '累计用量（MB）', value: '1024' }, { label: '设备型号', value: 'iPhone' }],
  cdrs: Array.from({ length: 12 }, (_, i) => [{ label: '时间', value: `10-31 ${i}:00` }, { label: '国家/地区', value: '日本' }, { label: '运营商', value: 'TEST' }, { label: '总用量（KB）', value: '1024' }]) };
type Tree = { tag: string; props: Record<string, any>; children: unknown[] };
const fakeH = ((tag: string, props: Record<string, unknown> | null, ...children: unknown[]) => ({ tag, props: props ?? {}, children })) as unknown as typeof h;
function nodes(tree: unknown): Tree[] { if (Array.isArray(tree)) return tree.flatMap(nodes); return tree && typeof tree === 'object' && 'tag' in tree ? [tree as Tree, ...nodes((tree as Tree).children)] : []; }
function render(scope: string, plans: PackagePlanInfo[] = [plan, { ...plan, plan: '套餐二' }], now?: number) { const copied: string[] = []; const opened: number[] = []; const tree = companionPackageCard({ scope, plans, total: 3, open: true, busy: false, hot: false, identity: '订单', refreshDisabled: false, notice: [], refresh() {}, toggle() {}, copy: text => copied.push(text), ...(now === undefined ? {} : { now }) }, fakeH, (() => null) as any); return { tree, nodes: nodes(tree), copied, opened }; }
test('legacy card renders actual projected identities, usage and at most ten scrollable CDR rows per plan', () => {
  const view = render('records'); const content = JSON.stringify(view.nodes.filter(n => n.tag !== 'style').map(n => n.children.filter(c => typeof c === 'string')));
  for (const text of ['原始套餐', 'Enabled', 'iPhone', '1 GB', '最近 10 条 CDR · 日本', '10 MB 合计']) assert.ok(content.includes(text), text);
  assert.equal(view.nodes.filter(n => n.props.class === 'cdr').length, 10);
  assert.equal(view.nodes.find(n => n.props.class === 'cdrs')?.props.tabindex, '0');
  view.nodes.find(n => n.props['aria-label'] === '复制 ICCID')!.props.onclick(); assert.deepEqual(view.copied, [plan.iccid]);
  assert.equal(view.nodes.filter(n => n.props.dataset?.packageAction === 'detail').length, 0);
});
test('selected tab survives unrelated rerenders and resets for a new identity scope', () => {
  const view = render('selection'), tabs = view.nodes.filter(n => n.props.role === 'tab'), panels = view.nodes.filter(n => n.props.role === 'tabpanel');
  const tabElements = tabs.map(tab => ({ setAttribute: (name: string, value: string) => { tab.props[name] = value; } }));
  const panelElements = panels.map(panel => ({ querySelector: () => null, set hidden(value: boolean) { panel.props.hidden = value; } }));
  tabs[1]!.props.onclick({ currentTarget: { getRootNode: () => ({ querySelector: () => null, querySelectorAll: (selector: string) => selector.includes('tabpanel') ? panelElements : tabElements }) } });
  assert.equal(panels[0]!.props.hidden, true); assert.equal(panels[1]!.props.hidden, false);
  assert.equal(render('selection').nodes.filter(n => n.props.role === 'tab')[1]!.props['aria-selected'], 'true');
  assert.equal(render('other-owner').nodes.filter(n => n.props.role === 'tab')[0]!.props['aria-selected'], 'true');
});
test('optional projection rejects unknown/private labels and copies only label/value fields', () => {
  const projected = packageInfo(plan, true); assert.deepEqual(projected?.detail_fields, plan.detail_fields);
  for (const label of ['IMSI', 'MSISDN', 'LPA', 'token']) assert.equal(packageInfo({ ...plan, detail_fields: [{ label, value: 'PRIVATE' }] }, true), null);
  assert.equal(packageInfo({ ...plan, cdrs: Array(101).fill([]) }, true), null);
  assert.equal(packageInfo({ ...plan, live_fields: [{ label: 'APN', value: 'x'.repeat(4001) }] }, true), null);
  assert.deepEqual(packageInfo({ ...plan, detail_fields: [{ label: 'APN', value: 'internet', token: 'PRIVATE' }] }, true)?.detail_fields, [{ label: 'APN', value: 'internet' }]);
  assert.equal(packageInfo({ ...plan, cdrs: undefined, detail_fields: undefined, live_fields: undefined }, true)?.cdrs, undefined);
});
test('CDRs select newest ten records using the verified server time keys before formatting', () => {
  const cdrs = Array.from({ length: 12 }, (_, i) => [{ label: '更新时间', value: `2026-01-${String(i + 1).padStart(2, '0')} 09:30:00` }, { label: '总用量（MB）', value: String(i) }]);
  const view = render('sorted-records', [{ ...plan, cdrs }]);
  const clocks = view.nodes.filter(node => node.tag === 'time').map(node => node.children[0]);
  assert.equal(clocks.length, 10); assert.equal(clocks[0], '01-12 09:30'); assert.equal(clocks[9], '01-03 09:30');
  const seconds = Math.floor(Date.parse('2026-01-30T01:45:00Z') / 1000);
  const epoch = render('epoch-records', [{ ...plan, cdrs: [[{ label: '更新时间戳', value: String(seconds) }]] }]);
  assert.equal(epoch.nodes.find(node => node.tag === 'time')?.children[0], '01-30 09:45');
});


test('live usage in bytes-independent MB projection prefers original cumulative usage', () => {
  const view = render('original-usage', [{ ...plan, live_fields: [{ label: '原始累计用量（MB）', value: '512' }, { label: '累计用量（MB）', value: '1024' }] }]);
  const totals = view.nodes.filter(node => node.props.class === 'sub');
  assert.ok(JSON.stringify(totals).includes('512 MB')); assert.equal(JSON.stringify(totals).includes('1 GB'), false);
});

test('same-scope shadow focus survives replacement without stealing outside focus or crossing identities', () => {
  for (const scenario of ['restore', 'new-scope', 'outside-before', 'outside-after', 'old-connected', 'window-inactive', 'disabled', 'hidden']) {
    let restored = 0;
    const target = { tagName: 'BUTTON', className: 'tab', getAttribute: () => '套餐 2', closest: (selector: string) => selector === '[hidden]' ? scenario === 'hidden' ? {} : null : { dataset: { packagePlan: '1' } }, disabled: scenario === 'disabled', focus: (options: unknown) => { assert.deepEqual(options, { preventScroll: true }); restored++; } };
    const doc: any = { activeElement: null, body: {}, documentElement: {}, hasFocus: () => scenario !== 'window-inactive' };
    const previous: any = { isConnected: true, ownerDocument: doc, shadowRoot: { activeElement: target } };
    const next: any = { isConnected: true, ownerDocument: doc, shadowRoot: { querySelectorAll: () => [target] } };
    doc.activeElement = scenario === 'outside-before' ? {} : previous;
    const queued: (() => void)[] = [];
    preserveCompanionFocus(previous, next, scenario !== 'new-scope', restore => queued.push(restore));
    previous.isConnected = scenario === 'old-connected';
    doc.activeElement = scenario === 'outside-after' ? {} : doc.body;
    queued.forEach(restore => restore());
    assert.equal(restored, scenario === 'restore' ? 1 : 0, scenario);
  }
});
test('daily, unlimited and unknown gauges retain distinct truthful labels and meter semantics', () => {
  const daily = { ...plan, usage_scope: 'daily' as const, unlimited: false };
  assert.equal(packageInfo(daily, true)?.usage_scope, 'daily'); assert.equal(packageInfo(daily, true)?.unlimited, false);
  assert.equal(packageInfo({ ...plan, usage_scope: 'monthly' }, true), null); assert.equal(packageInfo({ ...plan, unlimited: 'yes' }, true), null);
  assert.ok(JSON.stringify(render('daily', [daily]).nodes.filter(n => n.tag !== 'style').map(n => n.children.filter(c => typeof c === 'string'))).includes('今日剩余'));
  const unlimited = render('unlimited', [{ ...plan, remain: '', remain_pct: null, unlimited: true }]);
  const words = JSON.stringify(unlimited.nodes.filter(n => n.tag !== 'style').map(n => n.children.filter(c => typeof c === 'string')));
  for (const text of ['∞', '不限量套餐', '不限量']) assert.ok(words.includes(text), text);
  assert.equal(unlimited.nodes.filter(n => n.props.role === 'meter').length, 0);
  assert.equal(unlimited.nodes.some(n => n.props['aria-valuenow'] !== undefined), false);
  for (const [percent, tone] of [[0, 'over'], [20, 'warn'], [21, 'ok']] as const) {
    const ring = render(`tone-${percent}`, [{ ...plan, remain_pct: percent }]).nodes.find(n => n.props.class === 'ring')!;
    assert.equal(ring.props.dataset.tone, tone); assert.equal(ring.props['aria-valuenow'], String(percent));
  }
  const unknown = render('unknown', [{ ...plan, remain: '', remain_pct: 0, unlimited: false }]);
  assert.equal(unknown.nodes.some(n => n.props.role === 'meter'), false);
  assert.ok(unknown.nodes.some(n => n.tag === 'b' && n.children.includes('—')));
});
test('showing a hidden package restores its CDR scroll after visibility changes', () => {
  const first = render('hidden-scroll');
  function fixture(view: ReturnType<typeof render>) {
    const tabs = view.nodes.filter(n => n.props.role === 'tab'), panels = view.nodes.filter(n => n.props.role === 'tabpanel');
    const cdr = { scrollTop: 0 };
    const root = {
      querySelector: (selector: string) => ({ replaceWith(panel: Tree) { panels[Number(selector.match(/"(\d+)"/)![1])] = panel; } }),
      querySelectorAll: (selector: string) => selector.includes('tabpanel') ? panels.map(panel => ({ set hidden(v: boolean) { panel.props.hidden = v; }, querySelector: () => panel.props.dataset.packagePlan === '1' ? cdr : null })) : tabs.map(() => ({ setAttribute() {} })),
    };
    return { cdr, panels, click(index: number) { tabs[index]!.props.onclick({ currentTarget: { getRootNode: () => root } }); } };
  }
  const initial = fixture(first); initial.click(1);
  nodes(initial.panels[1]).find(n => n.props.class === 'cdrs')!.props.onscroll({ currentTarget: { scrollTop: 73 } });
  const rebuilt = render('hidden-scroll'), next = fixture(rebuilt);
  const remembered = rebuilt.nodes.find(n => n.props.class === 'cdrs')!;
  next.click(0);
  remembered.props.onscroll({ currentTarget: { scrollTop: 0 } });
  next.click(1);
  assert.equal(next.cdr.scrollTop, 73);
});
test('usage ring is built with DOM APIs (no innerHTML) and carries only validated numeric geometry', () => {
  const view = render('ring');
  const rings = view.nodes.filter(n => n.tag === 'span' && typeof n.props.ref === 'function');
  assert.equal(rings.length, 1, 'only the active plan ring is constructed');
  const created: { tag: string; ns: string; attrs: Record<string, string>; children: unknown[] }[] = [];
  const doc = { createElementNS: (ns: string, tag: string) => { const node = { tag, ns, attrs: {} as Record<string, string>, children: [] as unknown[], setAttribute(k: string, v: string) { this.attrs[k] = v; }, append(...c: unknown[]) { this.children.push(...c); } }; created.push(node); return node; } };
  let mounted: any = null;
  const element = { ownerDocument: doc, replaceChildren: (n: unknown) => { mounted = n; }, set innerHTML(_: string) { throw new Error('innerHTML must not be used'); } };
  rings[0]!.props.ref(element);
  assert.equal(mounted.tag, 'svg'); assert.equal(mounted.ns, 'http://www.w3.org/2000/svg');
  assert.equal(mounted.attrs['aria-hidden'], 'true'); assert.match(mounted.attrs['viewBox'], /^0 0 \d+ \d+$/);
  const circles = mounted.children as typeof created;
  assert.deepEqual(circles.map(c => c.attrs['class']), ['tr', 'fg']);
  for (const c of circles) for (const k of ['cx', 'cy', 'r']) assert.ok(Number.isFinite(Number(c.attrs[k])), k);
  assert.match(circles[1]!.attrs['stroke-dasharray']!, /^\d+(\.\d)? \d+(\.\d)?$/);
});

const strings = (list: Tree[]): string => JSON.stringify(list.filter(n => n.tag !== 'style').map(n => n.children.filter(c => typeof c === 'string')));
test('fields without data are hidden instead of showing placeholders; unknown usage stays 未知', () => {
  const bare: PackagePlanInfo = { plan: '', iccid: '8986000000000000009', status: '', remain: '', remain_pct: null, total: '', supplier: '', apn: '', fetched_at_ms: 1 };
  const view = render('bare', [bare]), content = strings(view.nodes);
  for (const placeholder of ['未返回', '未回传', '实体卡', '当前套餐速览未提供']) assert.equal(content.includes(placeholder), false, placeholder);
  assert.ok(content.includes('未知'), 'unknown remaining/total usage keeps 未知');
  assert.equal(view.nodes.some(n => n.props.class === 'pill'), false, 'blank status has no badge');
  assert.equal(view.nodes.some(n => n.props.class === 'spec'), false, 'supplier/APN/eSIM grid disappears with no values');
  assert.equal(view.nodes.some(n => n.props.class === 'row records'), false, 'no CDR projection, no CDR section');
  assert.deepEqual(view.nodes.filter(n => n.tag === 'dt').map(n => n.children[0]), ['ICCID']);
  const partial = render('partial', [{ ...bare, supplier: 'ESIM_SPARKS', cdrs: [] }]);
  const spec = partial.nodes.find(n => n.props.class === 'spec')!;
  assert.equal(spec.props.style['grid-template-columns'], 'repeat(1,minmax(0,auto))');
  assert.ok(strings(partial.nodes).includes('暂无 CDR 记录'), 'an empty CDR list from the host is real data');
});
test('reference layout: status badge, hero, 源 line, three spec cells, grouped identifiers and footer reuse note', () => {
  const full: PackagePlanInfo = { ...plan, status: 'using', remain: '500 MB', total: '500 MB', remain_pct: 100, usage_scope: 'daily', supplier: 'ESIM_SPARKS', apn: 'plus', fetched_at_ms: 10_000,
    detail_fields: [{ label: '业务流水号', value: '9000026102742578' }, { label: '来源套餐', value: '波兰IP(直连) - 埃及' }, { label: 'eSIM状态', value: 'Disabled' }, { label: 'EID', value: '89049032007408882600210309968795' }],
    live_fields: [{ label: '累计用量（MB）', value: '1597.44' }, { label: '当日用量（MB）', value: '0' }, { label: '设备型号', value: 'Apple iPhone 16 Pro Max' }] };
  const view = render('reference', [full], 10_000 + 5_000), content = strings(view.nodes);
  for (const expected of ['使用中', '今日剩余', '500 MB', '/ 500 MB', '1.56 GB', '0 MB', '波兰IP(直连) - 埃及', 'ESIM_SPARKS', 'plus', 'Disabled', '9000 0261 0274 2578', '8904 9032 0074 0888 2600 2103 0996 8795', 'Apple iPhone 16 Pro Max', '刚刚更新 · TSIM · 60 秒内复用']) assert.ok(content.includes(expected), expected);
  assert.deepEqual(view.nodes.filter(n => n.tag === 'dt').map(n => n.children[0]), ['流水号', 'ICCID', 'EID', '设备']);
  assert.equal(view.nodes.filter(n => n.props.class === 'copy').length, 3, 'copy for serial, ICCID and EID only');
});
test('freshness wording and the raised height cap', () => {
  const base = new Date(2026, 10, 3, 9, 5).getTime();
  assert.equal(packageFreshness(base, base + 59_999), '刚刚更新');
  assert.equal(packageFreshness(base, base + 5 * 60_000), '5 分钟前更新');
  assert.equal(packageFreshness(base, base + 2 * 3_600_000), '09:05 更新');
  assert.equal(packageFreshness(base, base + 2 * 86_400_000), '11-03 09:05 更新');
  assert.equal(packageFreshness(Number.NaN, base), '更新时间未知');
  assert.equal(COMPANION_MAX_HEIGHT, '78%');
  assert.equal((render('height').tree as unknown as Tree).props.style['max-height'], '78%');
});
test('an open card always fills its dock, with or without reissues; a collapsed card keeps its own height', () => {
  const withReissues = render('fill', [reissued, plan]), host = withReissues.tree as unknown as Tree;
  assert.equal(host.props.style.flex, '1 1 0');
  assert.equal(host.props.style.height, undefined, 'no content-independent fixed pixel height');
  assert.equal(host.props.style['max-height'], COMPANION_MAX_HEIGHT);
  assert.ok(host.props.class.includes('fill'));
  assert.equal(withReissues.nodes.some(n => n.props.class === 'rcount'), false);
  const plain = render('fill-plain', [plan]).tree as unknown as Tree;
  assert.equal(plain.props.style.flex, '1 1 0');
  assert.ok(plain.props.class.includes('fill'));
  const collapsed = companionPackageCard({ scope: 'fill-collapsed', plans: [plan], total: 1, open: false, busy: false, hot: false, identity: '', refreshDisabled: false, notice: [], refresh() {}, toggle() {}, copy() {} }, fakeH, (() => null) as any) as unknown as Tree;
  assert.equal(collapsed.props.style.flex, '0 0 auto');
  assert.equal(collapsed.props.class.includes('fill'), false);
});
test('plan tabs and the reissue track reserve a hairline scrollbar lane that never resizes', () => {
  for (const sel of ['.tabs', '.rtrack']) {
    const rule = COMPANION_CARD_STYLE.split('\n').find(line => line.startsWith(`${sel}{`)) ?? '';
    assert.match(rule, /overflow-x:scroll/, `${sel} always reserves the lane`);
    assert.doesNotMatch(rule, /scrollbar-(width|color)/, `${sel} must not disable ::-webkit-scrollbar`);
    assert.ok(COMPANION_CARD_STYLE.includes(`${sel}::-webkit-scrollbar`), `${sel} styles its own scrollbar`);
  }
  assert.match(COMPANION_CARD_STYLE, /\.tabs::-webkit-scrollbar,\.rtrack::-webkit-scrollbar\{width:5px;height:5px\}/);
  assert.doesNotMatch(COMPANION_CARD_STYLE, /:hover::-webkit-scrollbar\{/, 'hover may recolor the thumb but never resize the bar');
});

test('fractional usage stays compact while meter precision and copy values are retained', () => {
  const view = render('fractional', [{ ...plan, remain_pct: 95.068359375, cdrs: [
    [{ label: '总用量（MB）', value: '0.1' }], [{ label: '总用量（MB）', value: '0.2' }],
  ] }]);
  const meter = view.nodes.find(n => n.props.role === 'meter')!;
  assert.equal(meter.props['aria-valuenow'], '95.068359375');
  assert.ok(strings(nodes(meter)).includes('95%'));
  assert.ok(strings(view.nodes).includes('0.3 MB 合计'));
  assert.equal(strings(view.nodes).includes('0.30000000000000004'), false);
});
test('nonfinite percentage never enters the SVG or visible label', () => {
  for (const value of [NaN, Infinity, -Infinity]) {
    const view = render('nonfinite', [{ ...plan, remain_pct: value }]);
    assert.equal(view.nodes.some(n => n.props.role === 'meter'), false);
    const ring = view.nodes.find(n => n.props.class === 'ring')!;
    assert.ok(strings(nodes(ring)).includes('—'));
  }
});


test('collapsed and inactive plans avoid CDR construction; tab activation builds once', () => {
  const plans = [plan, { ...plan, plan: 'second' }];
  const input = { scope: 'lazy', plans, total: 2, open: false, busy: false, hot: false, identity: '', refreshDisabled: false, notice: [], refresh() {}, toggle() {}, copy() {} };
  const collapsed = companionPackageCard(input, fakeH, (() => null) as any);
  assert.equal(nodes(collapsed).filter(n => n.props.class === 'cdr').length, 0);
  const expanded = companionPackageCard({ ...input, open: true }, fakeH, (() => null) as any);
  const list = nodes(expanded), tabs = list.filter(n => n.props.role === 'tab');
  let panels = list.filter(n => n.props.role === 'tabpanel'), replacements = 0;
  const root = { querySelector: () => ({ replaceWith(panel: Tree) { panels[1] = panel; replacements++; } }), querySelectorAll: (selector: string) => selector.includes('tabpanel') ? panels.map(panel => ({ set hidden(v: boolean) { panel.props.hidden = v; }, querySelector: () => null })) : tabs.map(tab => ({ setAttribute(k: string, v: string) { tab.props[k] = v; } })) };
  tabs[1]!.props.onclick({ currentTarget: { getRootNode: () => root } });
  tabs[1]!.props.onclick({ currentTarget: { getRootNode: () => root } });
  assert.equal(replacements, 1);
  assert.equal(nodes(panels[1]).filter(n => n.props.class === 'cdr').length, 10);
});

test('cached native host updates actions and invalidates notices, freshness and scope', () => {
  let creates = 0, copied = '', toggled = '', refreshed = '';
  const nativeH = ((tag: string, props: Record<string, unknown> | null, ...children: unknown[]) => {
    creates++;
    return { tag, props: props ?? {}, children, attachShadow: () => ({ append() {} }), isConnected: false };
  }) as unknown as typeof h;
  const glyph = (() => null) as any;
  const plans = [plan], dependency = {};
  const input = { scope: 'cache-owner-a', plans, total: 1, open: true, busy: false, hot: false, identity: '', refreshDisabled: false, notice: [], now: 1000, cacheKey: [dependency], refresh() { refreshed = 'old'; }, toggle() { toggled = 'old'; }, copy() { copied = 'old'; } };
  const first = companionPackageCard(input, nativeH, glyph), initial = creates;
  const next = companionPackageCard({ ...input, refresh() { refreshed = 'new'; }, toggle() { toggled = 'new'; }, copy() { copied = 'new'; } }, nativeH, glyph);
  assert.equal(next, first); assert.equal(creates, initial);
  const tree = nodes(first);
  tree.find(n => n.props.class === 'copy')!.props.onclick();
  tree.find(n => n.props.class === 'tg')!.props.onclick();
  tree.find(n => n.props.dataset?.packageAction === 'refresh')!.props.onclick();
  assert.deepEqual([copied, toggled, refreshed], ['new', 'new', 'new']);
  const notice = companionPackageCard({ ...input, notice: ['changed'], cacheKey: [{}] }, nativeH, glyph);
  assert.notEqual(notice, first); assert.ok(JSON.stringify(nodes(notice)).includes('changed'));
  const minute = companionPackageCard({ ...input, now: 61_001 }, nativeH, glyph);
  assert.notEqual(minute, notice); assert.ok(strings(nodes(minute)).includes('1 分钟前更新'));
  const other = companionPackageCard({ ...input, scope: 'cache-owner-b' }, nativeH, glyph);
  assert.notEqual(other, minute);
});

const reissued: PackagePlanInfo = { ...plan, order_time: '2026-10-28 09:30:00', reissues: [
  { create_time_ms: new Date(2026, 9, 30, 8, 5).getTime(), state: 'ready', info: { ...plan, plan: '补发渠道套餐', iccid: '8986000000000000009', remain: '3 GB', cdrs: [] } },
  { create_time_ms: null, state: 'error', info: null },
] };
const chips = (view: ReturnType<typeof render>) => view.nodes.filter(n => n.props.dataset?.reissue !== undefined);
const texts = (node: Tree) => nodes(node).flatMap(n => n.children.filter(c => typeof c === 'string')) as string[];
test('reissue time formats use local MM-DD HH:mm and omit missing values', () => {
  assert.equal(formatReissueTime(new Date(2026, 0, 2, 3, 4).getTime()), '01-02 03:04');
  for (const value of [null, undefined, 0, -1, NaN, Infinity]) assert.equal(formatReissueTime(value as number | null), '');
  assert.equal(formatOrderTime('2026-10-28 09:30:00'), '10-28 09:30');
  assert.equal(formatOrderTime('2026-10-28T09:30'), '10-28 09:30');
  assert.equal(formatOrderTime('昨天'), '昨天');
  for (const value of [undefined, null, '', ' ', '-', '—']) assert.equal(formatOrderTime(value), '');
});
test('a plan with reissues shows an original → reissue timeline; plans without reissues show none', () => {
  assert.equal(chips(render('timeline-none')).length, 0);
  const view = render('timeline', [reissued, plan]);
  assert.equal(view.nodes.filter(n => n.props.class === 'rbar').length, 1);
  const list = chips(view);
  assert.deepEqual(list.map(n => n.props.dataset.reissue), ['0', '1', '2']);
  assert.deepEqual(list.map(n => texts(n)[0]), ['原套餐', '补发 1', '补发 2']);
  assert.ok(texts(list[0]!).includes('10-28 09:30'));
  assert.ok(texts(list[1]!).includes('10-30 08:05'));
  assert.equal(list[0]!.props['aria-pressed'], 'true');
  assert.equal(list[2]!.props.disabled, true); assert.ok(texts(list[2]!).includes('失败'));
  assert.ok(!texts(list[2]!).some(text => /^\d\d-\d\d/.test(text)), 'no time for a missing create_time');
  assert.equal(view.nodes.filter(n => n.props.class === 'rarrow').length, 2);
});
test('clicking a reissue chip rebuilds the panel in place with that package and survives rerenders until the scope changes', () => {
  const view = render('timeline-switch', [reissued]);
  const slot: { panel: any } = { panel: null };
  const old = { querySelector: () => null, replaceWith: (panel: unknown) => { slot.panel = panel; } };
  const event = { currentTarget: { getRootNode: () => ({ querySelector: (selector: string) => selector === '[data-package-plan="0"]' ? old : null }) } };
  chips(view)[2]!.props.onclick?.(event); assert.equal(slot.panel, null, 'a failed reissue cannot be selected by script either');
  chips(view)[1]!.props.onclick(event);
  const replaced = slot.panel as unknown as Tree & { hidden: boolean }; assert.ok(replaced); assert.equal(replaced.hidden, false);
  const content = texts(replaced);
  assert.ok(content.includes('补发渠道套餐')); assert.ok(content.includes('3 GB'));
  assert.equal(nodes(replaced).filter(n => n.props['aria-pressed'] === 'true').map(n => n.props.dataset.reissue).join(), '1');
  assert.ok(nodes(render('timeline-switch', [reissued]).tree).some(n => n.props['aria-pressed'] === 'true' && n.props.dataset?.reissue === '1'));
  assert.ok(nodes(render('timeline-other', [reissued]).tree).some(n => n.props['aria-pressed'] === 'true' && n.props.dataset?.reissue === '0'));
});
test('a stale reissue selection falls back to the original package', () => {
  const view = render('timeline-stale', [reissued]);
  chips(view)[1]!.props.onclick({ currentTarget: { getRootNode: () => ({ querySelector: () => ({ querySelector: () => null, replaceWith() {} }) }) } });
  const refreshed = render('timeline-stale', [{ ...plan, reissues: [{ create_time_ms: 1, state: 'error', info: null }] }]);
  assert.ok(nodes(refreshed.tree).some(n => n.props['aria-pressed'] === 'true' && n.props.dataset?.reissue === '0'));
  assert.ok(!texts(refreshed.tree as unknown as Tree).includes('补发渠道套餐'));
});
test('clicking a track item with a successor aligns it to the track start; the last item only scrolls into view', () => {
  const calls: string[] = [];
  const item = (left: number) => ({ getBoundingClientRect: () => ({ left }), scrollIntoView: () => calls.push(`nearest@${left}`) }) as unknown as HTMLElement;
  const items = [item(110), item(190), item(270)];
  const view = { getComputedStyle: () => ({ paddingLeft: '10px' }), matchMedia: () => ({ matches: false }) };
  const track = { scrollLeft: 40, clientLeft: 0, ownerDocument: { defaultView: view }, querySelectorAll: () => items, getBoundingClientRect: () => ({ left: 100 }), scrollTo: (o: ScrollToOptions) => calls.push(`to:${o.left}:${o.behavior}`) } as unknown as HTMLElement;
  alignTrackItem(track, items[1], '.tab');
  assert.deepEqual(calls, ['to:120:smooth'], 'scrollLeft 40 + (190 - 100) - padding 10');
  calls.length = 0;
  alignTrackItem(track, items[2], '.tab');
  assert.deepEqual(calls, ['nearest@270']);
  calls.length = 0;
  view.matchMedia = () => ({ matches: true });
  alignTrackItem(track, items[0], '.tab');
  assert.deepEqual(calls, ['to:40:auto'], 'reduced motion jumps without animation');
  alignTrackItem(null, items[0], '.tab'); alignTrackItem(track, null, '.tab');
});
