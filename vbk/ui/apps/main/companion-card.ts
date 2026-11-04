import { t } from '../../packages/ui-kit/src/i18n.ts';
import { h as dom, icon } from '../../packages/ui-kit/src/h.ts';
import type { Child } from '../../packages/ui-kit/src/h.ts';
import { IC } from '../_shared/icons.ts';
import type { PackagePlanInfo, PackageReissue } from './package-preview.ts';
import type { UiPackageField } from '../../packages/ipc/src/client.ts';
import { COMPANION_CARD_STYLE } from './companion-card-style.ts';

// Visual selection follows the same immutable account/conversation/query key as the data.
let selectedScope: string | null = null;
let selectedPlan = 0;
// 每个套餐当前展示的版本：0 = 原单，k = 第 k 个补发；随 selectedScope 重置。
let selectedVariant: number[] = [];
let bodyScroll = 0;
let cdrScroll: number[] = [];
let previousCard: { scope: string; host: HTMLElement } | null = null;

/** Capture before replacement; restore only after the old focused card was removed.
 * An outside focus, identity change, hidden/disabled target or inactive window wins. */
export function preserveCompanionFocus(previous: HTMLElement | null, next: HTMLElement, sameScope: boolean, schedule: (restore: () => void) => void = queueMicrotask): void {
  if (!sameScope || !previous?.isConnected || previous.ownerDocument.activeElement !== previous) return;
  const focused = previous.shadowRoot?.activeElement as HTMLElement | null;
  if (!focused) return;
  const key = (node: HTMLElement) => JSON.stringify([node.tagName, node.getAttribute('aria-label'), node.className, node.closest<HTMLElement>('[data-package-plan]')?.dataset.packagePlan ?? null]);
  const targetKey = key(focused), document = next.ownerDocument;
  schedule(() => {
    if (!next.isConnected || previous.isConnected || !document.hasFocus()) return;
    const active = document.activeElement;
    if (active && active !== previous && active !== document.body && active !== document.documentElement) return;
    const target = [...next.shadowRoot?.querySelectorAll<HTMLElement>('button,[tabindex]') ?? []].find(node => key(node) === targetKey);
    if (!target || target.closest('[hidden]') || (target as HTMLButtonElement).disabled) return;
    target.focus({ preventScroll: true });
  });
}

const pad2 = (n: number): string => String(n).padStart(2, '0');
/** 补发时间（毫秒时间戳）→ 本地时区「MM-DD HH:mm」；缺失或非法返回空串，由调用方省略该项。 */
export function formatReissueTime(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '';
  const at = new Date(ms);
  return Number.isFinite(at.getTime()) ? `${pad2(at.getMonth() + 1)}-${pad2(at.getDate())} ${pad2(at.getHours())}:${pad2(at.getMinutes())}` : '';
}
/** 原单订单时间「YYYY-MM-DD HH:mm:ss」→「MM-DD HH:mm」；非标准格式原样返回，空值与占位符返回空串。 */
export function formatOrderTime(value: string | null | undefined): string {
  const text = (value ?? '').trim();
  if (!text || text === '-' || text === '—') return '';
  const match = /^\d{4}-(\d{2}-\d{2})[ T](\d{2}:\d{2})/.exec(text);
  return match ? `${match[1]} ${match[2]}` : text;
}

/** 宿主对同一订单/ICCID 的查询在 60 秒内复用（order_service QUERY_REUSE_MS / core-assistant CACHE_REUSE_MS）。 */
export const PACKAGE_REUSE_SECONDS = 60;
/** 卡片在右栏中的高度上限：可以顶到订单信息中部，右栏剩余部分仍可滚动。 */
export const COMPANION_MAX_HEIGHT = '78%';
/** 含补发单时卡片固定高度（仍受上限约束）：切换套餐/补发版本、内容多寡都不改变卡片高度，超出部分在卡片内滚动。 */
export const COMPANION_FIXED_HEIGHT = '440px';

/** 底栏的更新时间：一分钟内「刚刚更新」，一小时内按分钟，其余给出时刻。 */
export function packageFreshness(fetchedAtMs: number, nowMs: number): string {
  const age = nowMs - fetchedAtMs;
  if (!Number.isFinite(age)) return t('companion.freshness.unknown');
  if (age < 60_000) return t('companion.freshness.justNow');
  if (age < 3_600_000) return t('companion.freshness.minutes', { minutes: Math.floor(age / 60_000) });
  const at = new Date(fetchedAtMs), now = new Date(nowMs), pad = (n: number) => String(n).padStart(2, '0');
  const clock = `${pad(at.getHours())}:${pad(at.getMinutes())}`;
  return at.toDateString() === now.toDateString() ? t('companion.freshness.clock', { clock }) : t('companion.freshness.dateClock', { date: `${pad(at.getMonth() + 1)}-${pad(at.getDate())}`, clock });
}

/** Original plugin layout and Windows typography, rendered in its own shadow root.
 * Data absent from the current host projection stays explicitly unavailable. */
export interface CompanionCardInput {
  plans: readonly PackagePlanInfo[]; total: number; open: boolean; busy: boolean;
  hot: boolean; scope: string; identity: string; refreshDisabled: boolean; notice: Child[];
  refresh(): void; toggle(): void;
  copy(text: string): void; now?: number;
  /** Owning view dependencies, including notice/action scopes. */
  cacheKey?: readonly unknown[];
}
let cardCache: { key: readonly unknown[]; freshness: string; h: typeof dom; glyph: typeof icon; host: HTMLElement; cell: { input: CompanionCardInput } } | null = null;

export function companionPackageCard(input: CompanionCardInput, h: typeof dom = dom, glyph: typeof icon = icon): HTMLElement {
  const plans = input.plans;
  const freshness = plans[0] ? packageFreshness(plans[0].fetched_at_ms, input.now ?? Date.now()) : input.identity;
  const key = input.cacheKey && [input.scope, plans, input.open, input.busy, input.hot, input.total, input.refreshDisabled, input.identity, ...input.cacheKey];
  if (key && cardCache && cardCache.h === h && cardCache.glyph === glyph && cardCache.freshness === freshness && key.length === cardCache.key.length && key.every((value, index) => Object.is(value, cardCache!.key[index]))) {
    cardCache.cell.input = input;
    return cardCache.host;
  }
  // One active card only; callbacks follow the newest owning render on cache hits.
  const cell = { input };
  cardCache = null;
  if (selectedScope !== input.scope) { selectedScope = input.scope; selectedPlan = 0; selectedVariant = []; bodyScroll = 0; cdrScroll = []; }
  if (selectedPlan >= plans.length) selectedPlan = 0;
  const selected = selectedPlan;
  const field = (plan: PackagePlanInfo, label: string): string => plan.live_fields?.find(row => row.label === label)?.value ?? plan.detail_fields?.find(row => row.label === label)?.value ?? '';
  const mb = (text: string, unit = 'MB'): string => { const number = Number(text); return text && Number.isFinite(number) && number >= 0 ? unit === 'KB' ? t('companion.amount.mb', { amount: Number((number / 1024).toFixed(2)) }) : number >= 1024 ? t('companion.amount.gb', { amount: Number((number / 1024).toFixed(2)) }) : t('companion.amount.mb', { amount: Number(number.toFixed(2)) }) : text || t('companion.unknown'); };
  const cdrField = (row: readonly UiPackageField[], ...labels: string[]) => labels.map(label => row.find(field => field.label === label)?.value).find(Boolean) ?? '';
  const cdrAt = (row: readonly UiPackageField[]): number => {
    const seconds = cdrField(row, '更新时间戳');
    if (/^\d{9,11}$/.test(seconds)) return Number(seconds) * 1000;
    const text = cdrField(row, '更新时间', '时间', '开始时间', '结束时间', '日期');
    const iso = /^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T00:00:00+08:00` : /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?$/.test(text) ? `${text.replace(' ', 'T')}+08:00` : '';
    return iso && Number.isFinite(Date.parse(iso)) ? Date.parse(iso) : -Infinity;
  };
  const records = (plan: PackagePlanInfo, planIndex: number): Child[] => {
    const rows = [...plan.cdrs ?? []].sort((a, b) => cdrAt(b) - cdrAt(a)).slice(0, 10);
    if (!rows.length) return [h('div', { class: 'heading' }, h('span', null, t('companion.cdr.title'))), h('p', { class: 'empty' }, t('companion.cdr.empty'))];
    const get = cdrField;
    const amounts = rows.map(row => { const value = get(row, '总用量（MB）'), kb = get(row, '总用量（KB）'); return value && Number.isFinite(Number(value)) ? Number(value) : kb && Number.isFinite(Number(kb)) ? Number(kb) / 1024 : null; });
    const known = amounts.filter((amount): amount is number => amount !== null && amount >= 0), max = Math.max(0, ...known);
    const regions = new Set(rows.map(row => get(row, '国家/地区', '地区'))), shared = regions.size === 1 ? get(rows[0]!, '国家/地区', '地区') : '';
    return [h('div', { class: 'heading' }, h('span', null, t('companion.cdr.recent', { count: rows.length, region: shared ? ` · ${shared}` : '' })), known.length ? h('b', null, t('companion.cdr.total', { usage: mb(String(known.reduce((sum, value) => sum + value, 0))) })) : null),
      h('ol', { class: 'cdrs', onscroll: (event: Event) => { if (selectedScope === input.scope && selectedPlan === planIndex) cdrScroll[planIndex] = (event.currentTarget as HTMLElement).scrollTop; }, ref: (node: HTMLElement) => { queueMicrotask(() => { if (node.isConnected && selectedScope === input.scope && selectedPlan === planIndex) node.scrollTop = cdrScroll[planIndex] ?? 0; }); }, tabindex: '0', 'aria-label': t('companion.cdr.scrollLabel') }, rows.map((row, index) => { const place = [shared ? '' : get(row, '国家/地区', '地区'), get(row, '运营商', '网络')].filter(Boolean).join(' · '); const rawTime = get(row, '更新时间', '时间', '开始时间', '结束时间', '日期'); const at = cdrAt(row); const time = Number.isFinite(at) ? (() => { const date = new Date(at + 8 * 3600_000).toISOString(); return rawTime.length === 10 ? date.slice(0,10) : `${date.slice(5,10)} ${date.slice(11,16)}`; })() : rawTime; const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(5,10); const isToday = time.length === 11 && time.startsWith(today); const amount = amounts[index]; return h('li', { class: 'cdr' }, h('i', { class: 'bar', style: { width: amount !== null && amount !== undefined && max > 0 ? `${Math.max(4, Math.round(amount / max * 100))}%` : '0%' } }), h('time', { class: isToday ? 'today' : '' }, isToday ? t('companion.cdr.today', { time: time.slice(6) }) : time || t('companion.emptyValue')), h('span', { class: place ? 'op' : 'op none', title: place }, place || t('companion.emptyValue')), h('b', null, amount === null || amount === undefined ? t('companion.emptyValue') : mb(String(amount)))); }))];
  };
  const button = (label: string, cls: string, props: Record<string, unknown>, ...children: Child[]) => h('button', { type: 'button', class: cls, 'aria-label': label, title: label, ...props }, ...children);
  const ring = (plan: typeof plans[number], mini = false) => {
    const percent = plan.remain && typeof plan.remain_pct === 'number' && Number.isFinite(plan.remain_pct) ? Math.max(0, Math.min(100, plan.remain_pct)) : null, unlimited = !plan.remain && plan.unlimited === true, size = mini ? 22 : 44, radius = mini ? 8.5 : 18, circumference = 2 * Math.PI * radius;
    const svg = h('span', { ref: (element: Element) => {
      // Only validated numeric values enter SVG geometry; service text remains text nodes.
      const doc = element.ownerDocument, ns = 'http://www.w3.org/2000/svg';
      const svgNode = doc.createElementNS(ns, 'svg');
      svgNode.setAttribute('viewBox', `0 0 ${size} ${size}`);
      svgNode.setAttribute('aria-hidden', 'true');
      const circle = (cls: string, extra: Record<string, string> = {}): void => {
        const node = doc.createElementNS(ns, 'circle');
        for (const [name, value] of Object.entries({ class: cls, cx: String(size / 2), cy: String(size / 2), r: String(radius), ...extra })) node.setAttribute(name, value);
        svgNode.append(node);
      };
      circle('tr');
      circle('fg', { 'stroke-dasharray': `${(circumference * (percent ?? (unlimited ? 100 : 0)) / 100).toFixed(1)} ${circumference.toFixed(1)}` });
      element.replaceChildren(svgNode);
    } });
    return h('span', { class: mini ? 'mini' : 'ring', dataset: { tone: percent === null ? 'muted' : percent <= 0 ? 'over' : percent <= 20 ? 'warn' : 'ok' }, ...(percent === null ? {} : { role: 'meter', 'aria-label': t('companion.remainingTraffic'), 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(percent) }) }, svg, mini ? null : h('b', null, percent === null ? unlimited ? t('companion.unlimitedSymbol') : t('companion.emptyValue') : t('companion.percentage', { value: Math.round(percent) })));
  };
  const status = (plan: PackagePlanInfo): [string, string] => {
    const value = plan.status, key = value.toLowerCase();
    const known: Record<string, [string, string]> = { using: [t('companion.status.using'), 'ok'], activated: [t('companion.status.using'), 'ok'], active: [t('companion.status.using'), 'ok'], inactive: [t('companion.status.inactive'), 'warn'], not_activated: [t('companion.status.inactive'), 'warn'], pending: [t('companion.status.pending'), 'warn'], default: [t('companion.status.pending'), 'warn'], cancel: [t('companion.status.cancelled'), 'muted'], cancelled: [t('companion.status.cancelled'), 'muted'], expired: [t('companion.status.expired'), 'muted'], terminated: [t('companion.status.terminated'), 'bad'], success: [t('companion.status.success'), 'ok'], fail: [t('companion.status.failed'), 'bad'], failed: [t('companion.status.failed'), 'bad'], refundreview: [t('companion.status.refundReview'), 'warn'], refund: [t('companion.status.refunded'), 'muted'] };
    if (known[key]) return known[key]!;
    return [value, /使用中|成功/.test(value) ? 'ok' : /未激活|待处理|审核中/.test(value) ? 'warn' : /已终止|失败/.test(value) ? 'bad' : 'muted'];
  };
  const pill = (plan: typeof plans[number]) => plan.status.trim() ? h('span', { class: 'pill', title: plan.status, dataset: { tone: status(plan)[1] } }, status(plan)[0]) : null;
  const section = (cls: string, ...children: Child[]) => h('section', { class: `row ${cls}` }, ...children);
  // 展示版本：补发项必须是 ready 且有投影，否则（刷新后下标失效、读取失败）回到原单。
  const variantOf = (root: PackagePlanInfo, index: number): number => {
    const variant = selectedVariant[index] ?? 0, item: PackageReissue | undefined = variant > 0 ? root.reissues?.[variant - 1] : undefined;
    return item?.state === 'ready' && item.info ? variant : 0;
  };
  const pickVariant = (event: Event, position: number, next: number): void => {
    if (selectedScope !== input.scope || next > 0 && !plans[position]?.reissues?.[next - 1]?.info) return;
    selectedVariant[position] = next; cdrScroll[position] = 0;
    const root = (event.currentTarget as HTMLElement).getRootNode() as ShadowRoot, old = root.querySelector<HTMLElement>(`[data-package-plan="${position}"]`);
    if (!old) return;
    const scrollLeft = old.querySelector<HTMLElement>('.rtrack')?.scrollLeft ?? 0, panel = buildPanel(plans[position]!, position);
    panel.hidden = false;
    old.replaceWith(panel);
    built.add(position);
    const track = panel.querySelector?.<HTMLElement>('.rtrack');
    if (track) track.scrollLeft = scrollLeft;
    const target = panel.querySelector?.<HTMLElement>(`[data-reissue="${next}"]`);
    target?.focus?.({ preventScroll: true });
    target?.scrollIntoView?.({ inline: 'nearest', block: 'nearest' });
  };
  /** 从左到右时间轴：原套餐 → 补发 1 → 补发 2 …；点击只在本地切换展示，不发起任何请求。 */
  const timeline = (root: PackagePlanInfo, index: number, active: number): Child | null => {
    const list = root.reissues;
    if (!list?.length) return null;
    const chip = (variant: number, label: string, at: string, info: PackagePlanInfo | null): Child => {
      const failed = !info, [text, tone] = info ? status(info) : ['失败', 'bad'] as [string, string];
      const remain = info ? info.remain || (info.unlimited ? '不限量' : '') : '';
      const title = [label, at && `时间 ${at}`, failed ? '详情获取失败' : info!.status.trim() && `状态 ${info!.status}`, remain && `剩余 ${remain}`].filter(Boolean).join(' · ');
      return h('button', { type: 'button', class: `rchip${variant === active ? ' on' : ''}`, title, disabled: failed, 'aria-pressed': String(variant === active), dataset: { reissue: String(variant), tone }, onclick: (event: Event) => pickVariant(event, index, variant) },
        h('b', { class: 'rtag' }, label), at ? h('time', null, at) : null, failed || info!.status.trim() ? h('span', { class: 'rst' }, h('i'), text) : null, remain ? h('span', { class: 'rrem' }, remain) : null);
    };
    const chips: Child[] = [chip(0, '原套餐', formatOrderTime(root.order_time), root)];
    list.forEach((item, position) => chips.push(h('span', { class: 'rarrow', 'aria-hidden': 'true' }, '→'), chip(position + 1, `补发 ${position + 1}`, formatReissueTime(item.create_time_ms), item.state === 'ready' ? item.info : null)));
    return section('reissues', h('div', { class: 'rbar', role: 'group', 'aria-label': `补发套餐时间线，共 ${list.length} 个，按时间升序` }, h('div', { class: 'rtrack' }, chips)));
  };
  const buildPanel = (root: PackagePlanInfo, index: number) => {
    const variant = variantOf(root, index), plan = variant ? root.reissues![variant - 1]!.info! : root;
    // 没有数据的字段整格/整行隐藏，不显示占位文案。
    const cells = ([[t('companion.supplier'), plan.supplier, false], [t('companion.apn'), plan.apn, true], [t('companion.esim'), field(plan, 'eSIM状态'), true]] as const)
      .filter(([, value]) => value.trim()).map(([label, value, mono]) => h('div', null, h('small', null, label), h('b', { class: mono ? 'mono' : '', title: value }, value)));
    const ids: Child[] = [];
    for (const [label, value, device] of [[t('companion.serial'), field(plan, '业务流水号'), false], [t('companion.iccid'), plan.iccid, false], [t('companion.eid'), field(plan, 'EID'), false], [t('companion.device'), field(plan, '设备型号'), true]] as const) {
      if (!value.trim()) continue;
      ids.push(h('dt', null, label), h('dd', { class: device ? 'txt' : '', title: value }, device ? value : value.replace(/(.{4})(?=.)/g, '$1 ')), h('span', null, !device ? button(t('companion.copy', { label }), 'copy', { onclick: () => cell.input.copy(value) }, glyph(IC.copy, 12)) : null));
    }
    const name = field(plan, '渠道套餐') || plan.plan, source = field(plan, '来源套餐');
    return h('div', { role: 'tabpanel', hidden: index !== selected, dataset: { packagePlan: String(index) }, 'aria-label': `套餐 ${index + 1}` },
      timeline(root, index, variant),
      section('hero', ring(plan), h('div', null, h('div', { class: 'lab' }, pill(plan), h('span', null, plan.remain ? plan.usage_scope === 'daily' ? '今日剩余' : '套餐剩余' : plan.unlimited ? '不限量套餐' : '用量待查询')), h('div', { class: 'num' }, h('b', { class: plan.remain || plan.unlimited ? '' : 'none' }, plan.remain || (plan.unlimited ? '不限量' : '未知')), plan.remain && plan.total ? h('span', null, `/ ${plan.total}`) : null), h('div', { class: 'sub' }, h('span', null, h('em', null, '总用量'), ` ${mb(field(plan, '原始累计用量（MB）') || field(plan, '累计用量（MB）'))}`), field(plan, '当日用量（MB）') ? h('span', null, h('em', null, '当日'), ` ${mb(field(plan, '当日用量（MB）'))}`) : null))),
      name || source || cells.length ? section('names', name || source ? h('div', { class: 'nm' }, name ? h('div', { class: 'ch' }, name) : null, source ? h('div', { class: 'src' }, source) : null) : null, cells.length ? h('div', { class: 'spec', style: { 'grid-template-columns': `repeat(${cells.length},minmax(0,auto))` } }, cells) : null) : null,
      ids.length ? section('identifiers', h('dl', { class: 'ids' }, ids)) : null,
      plan.cdrs ? section('records', ...records(plan, index)) : null);
  };
  const built = new Set<number>(input.open ? [selected] : []);
  const panels = input.open ? plans.map((plan, index) => index === selected ? buildPanel(plan, index) : h('div', { role: 'tabpanel', hidden: true, dataset: { packagePlan: String(index) }, 'aria-label': t('companion.planNumber', { number: index + 1 }) })) : [];
  const tabs = plans.map((plan, index) => button(t('companion.planNumber', { number: index + 1 }), 'tab', { role: 'tab', 'aria-selected': String(index === selected), onclick: (event: Event) => {
    if (selectedScope !== input.scope) return;
    selectedPlan = index;
    const tab = event.currentTarget as HTMLElement, root = tab.getRootNode() as ShadowRoot;
    if (!built.has(index)) {
      const empty = root.querySelector<HTMLElement>(`[data-package-plan="${index}"]`);
      const panel = buildPanel(plans[index]!, index);
      if (empty) { empty.replaceWith(panel); built.add(index); }
    }
    root.querySelectorAll('[role="tab"]').forEach((node, position) => node.setAttribute('aria-selected', String(position === index)));
    root.querySelectorAll<HTMLElement>('[role="tabpanel"]').forEach((node, position) => { node.hidden = position !== index; if (position === index) { const cdr = node.querySelector<HTMLElement>('.cdrs'); if (cdr) cdr.scrollTop = cdrScroll[index] ?? 0; } });
  } }, h('i', { dataset: { tone: status(plan)[1] } }), t('companion.planNumber', { number: index + 1 }), plan.status.trim() ? h('span', { class: 'st' }, status(plan)[0]) : null));
  const card = h('div', { class: `card${input.open ? '' : ' collapsed'}${input.busy ? ' busy' : ''}` },
    h('div', { class: 'head' }, button(t('companion.toggle'), 'tg', { 'aria-expanded': String(input.open), onclick: () => cell.input.toggle() }, h('span', { class: 'title' }, t('companion.title')), h('span', { class: 'count' }, t('companion.planCount', { count: input.total }))), button(t('companion.refresh'), 'icon refresh', { disabled: input.refreshDisabled, dataset: { packageAction: 'refresh' }, onclick: () => cell.input.refresh() }, glyph(IC.refresh, 14)), button(t('companion.toggle'), 'icon toggle', { 'aria-expanded': String(input.open), onclick: () => cell.input.toggle() }, glyph(IC.chevDown, 14))),
    !input.open && plans[selected] ? h('div', { class: 'sum' }, ring(plans[selected]!, true), pill(plans[selected]!), h('b', null, plans[selected]!.remain || (plans[selected]!.unlimited ? t('companion.unlimited') : t('companion.unknown'))), h('span', null, plans[selected]!.plan)) : null,
    h('div', { class: 'body', onscroll: (event: Event) => { if (selectedScope === input.scope) bodyScroll = (event.currentTarget as HTMLElement).scrollTop; }, ref: (node: HTMLElement) => { queueMicrotask(() => { if (node.isConnected && selectedScope === input.scope) node.scrollTop = bodyScroll; }); }, 'aria-busy': String(input.busy), 'aria-live': 'polite' },
      plans.length > 1 || input.total > plans.length ? h('div', { class: 'tabs', role: 'tablist', 'aria-label': t('companion.planList') }, tabs, input.total > plans.length ? h('span', { class: 'more', title: t('companion.morePlans', { total: input.total }) }, t('companion.moreCount', { count: input.total - plans.length })) : null) : null,
      input.open ? input.notice : null, panels),
    h('div', { class: 'foot' }, h('span', { class: 'rel' }, plans[0] ? `${packageFreshness(plans[0].fetched_at_ms, input.now ?? Date.now())} · TSIM · ${PACKAGE_REUSE_SECONDS} 秒内复用` : input.identity)));
  const style = h('style', null, COMPANION_CARD_STYLE + '\n.ring>span,.mini>span{position:absolute;inset:0;display:block}[data-tone=warn]>span>svg .fg{stroke:#e7a034}[data-tone=over]>span>svg .fg{stroke:#e0574c}[data-tone=muted]>span>svg .fg{stroke:#c3c9d5}.card{max-height:inherit;animation:none}:host(.fixed) .card{flex:1 1 0;min-height:0}.body{min-height:0}.actions{padding-top:6px}:host(.hot) .card{border-color:var(--accent);box-shadow:0 0 0 2px var(--accent-soft)}');
  const fixed = input.open && plans.some(plan => plan.reissues?.length);
  const host = h('div', { class: `companion-card${input.hot ? ' hot' : ''}${fixed ? ' fixed' : ''}`, role: 'region', 'aria-label': '订单套餐信息', style: { margin: '8px 8px 10px', ...(fixed ? { height: COMPANION_FIXED_HEIGHT } : {}), 'max-height': COMPANION_MAX_HEIGHT, 'min-height': '0', display: 'flex', 'flex-direction': 'column', 'flex-shrink': '0' } }, style, card);
  // Test renderers return structural trees; native DOM uses the original isolation boundary.
  if (typeof host.attachShadow === 'function') {
    host.attachShadow({ mode: 'open' }).append(style, card);
    preserveCompanionFocus(previousCard?.host ?? null, host, previousCard?.scope === input.scope);
    previousCard = { scope: input.scope, host };
    if (key) cardCache = { key, freshness, h, glyph, host, cell };
  }
  return host;
}
