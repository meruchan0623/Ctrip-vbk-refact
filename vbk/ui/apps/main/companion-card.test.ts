import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMPANION_MAX_HEIGHT, companionPackageCard, packageFreshness, preserveCompanionFocus } from './companion-card.ts';
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
function render(scope: string, plans: PackagePlanInfo[] = [plan, { ...plan, plan: '套餐二' }], now?: number) { const copied: string[] = []; const opened: number[] = []; const tree = companionPackageCard({ scope, plans, total: 3, open: true, busy: false, hot: false, identity: '订单', refreshDisabled: false, notice: [], canDetail: true, refresh() {}, toggle() {}, detail: index => opened.push(index), copy: text => copied.push(text), ...(now === undefined ? {} : { now }) }, fakeH, (() => null) as any); return { tree, nodes: nodes(tree), copied, opened }; }
test('legacy card renders actual projected identities, usage and at most ten scrollable CDR rows per plan', () => {
  const view = render('records'); const content = JSON.stringify(view.nodes.filter(n => n.tag !== 'style').map(n => n.children.filter(c => typeof c === 'string')));
  for (const text of ['原始套餐', 'Enabled', 'iPhone', '1 GB', '最近 10 条 CDR · 日本', '10 MB 合计']) assert.ok(content.includes(text), text);
  assert.equal(view.nodes.filter(n => n.props.class === 'cdr').length, 20);
  assert.equal(view.nodes.find(n => n.props.class === 'cdrs')?.props.tabindex, '0');
  view.nodes.find(n => n.props['aria-label'] === '复制 ICCID')!.props.onclick(); assert.deepEqual(view.copied, [plan.iccid]);
  view.nodes.filter(n => n.props.dataset?.packageAction === 'detail')[1]!.props.onclick(); assert.deepEqual(view.opened, [1]);
});
test('selected tab survives unrelated rerenders and resets for a new identity scope', () => {
  const view = render('selection'), tabs = view.nodes.filter(n => n.props.role === 'tab'), panels = view.nodes.filter(n => n.props.role === 'tabpanel');
  const tabElements = tabs.map(tab => ({ setAttribute: (name: string, value: string) => { tab.props[name] = value; } }));
  const panelElements = panels.map(panel => ({ querySelector: () => null, set hidden(value: boolean) { panel.props.hidden = value; } }));
  tabs[1]!.props.onclick({ currentTarget: { getRootNode: () => ({ querySelectorAll: (selector: string) => selector.includes('tabpanel') ? panelElements : tabElements }) } });
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
  const roots = () => ({ querySelectorAll: (selector: string) => selector.includes('tabpanel') ? [{ querySelector: () => null }, { querySelector: () => null }] : [{ setAttribute() {} }, { setAttribute() {} }] });
  first.nodes.filter(n => n.props.role === 'tab')[1]!.props.onclick({ currentTarget: { getRootNode: roots } });
  first.nodes.filter(n => n.props.class === 'cdrs')[1]!.props.onscroll({ currentTarget: { scrollTop: 73 } });
  const rebuilt = render('hidden-scroll'), cdr = { scrollTop: 0 };
  const tabs = rebuilt.nodes.filter(n => n.props.role === 'tab');
  const root = { querySelectorAll: (selector: string) => selector.includes('tabpanel') ? [{ querySelector: () => null }, { querySelector: () => cdr }] : [{ setAttribute() {} }, { setAttribute() {} }] };
  tabs[0]!.props.onclick({ currentTarget: { getRootNode: () => root } });
  // Hidden scroll clamping must never replace the remembered offset.
  rebuilt.nodes.filter(n => n.props.class === 'cdrs')[1]!.props.onscroll({ currentTarget: { scrollTop: 0 } });
  tabs[1]!.props.onclick({ currentTarget: { getRootNode: () => root } });
  assert.equal(cdr.scrollTop, 73);
});
test('usage ring is built with DOM APIs (no innerHTML) and carries only validated numeric geometry', () => {
  const view = render('ring');
  const rings = view.nodes.filter(n => n.tag === 'span' && typeof n.props.ref === 'function');
  assert.ok(rings.length >= 2, 'a big and a mini ring per plan');
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
