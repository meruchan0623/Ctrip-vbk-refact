import { h as dom, icon } from '../../packages/ui-kit/src/h.ts';
import type { Child } from '../../packages/ui-kit/src/h.ts';
import { IC } from '../_shared/icons.ts';
import type { PackagePlanInfo } from './package-preview.ts';
import type { UiPackageField } from '../../packages/ipc/src/client.ts';
import { COMPANION_CARD_STYLE } from './companion-card-style.ts';

// Visual selection follows the same immutable account/conversation/query key as the data.
let selectedScope: string | null = null;
let selectedPlan = 0;
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

/** Original plugin layout and Windows typography, rendered in its own shadow root.
 * Data absent from the current host projection stays explicitly unavailable. */
export function companionPackageCard(input: {
  plans: readonly PackagePlanInfo[]; total: number; open: boolean; busy: boolean;
  hot: boolean; scope: string; identity: string; refreshDisabled: boolean; notice: Child[];
  refresh(): void; toggle(): void; detail(index: number): void; canDetail: boolean;
  copy(text: string): void;
}, h: typeof dom = dom, glyph: typeof icon = icon): HTMLElement {
  const plans = input.plans;
  if (selectedScope !== input.scope) { selectedScope = input.scope; selectedPlan = 0; bodyScroll = 0; cdrScroll = []; }
  if (selectedPlan >= plans.length) selectedPlan = 0;
  const selected = selectedPlan;
  const field = (plan: PackagePlanInfo, label: string): string => plan.live_fields?.find(row => row.label === label)?.value ?? plan.detail_fields?.find(row => row.label === label)?.value ?? '';
  const mb = (text: string, unit = 'MB'): string => { const number = Number(text); return text && Number.isFinite(number) && number >= 0 ? unit === 'KB' ? `${Number((number / 1024).toFixed(2))} MB` : number >= 1024 ? `${Number((number / 1024).toFixed(2))} GB` : `${number} MB` : text || '未回传'; };
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
    if (!rows.length) return [h('div', { class: 'heading' }, h('span', null, 'CDR')), h('p', { class: 'empty' }, plan.cdrs ? '暂无 CDR 记录' : '当前套餐速览未提供 CDR 数据')];
    const get = cdrField;
    const amounts = rows.map(row => { const value = get(row, '总用量（MB）'), kb = get(row, '总用量（KB）'); return value && Number.isFinite(Number(value)) ? Number(value) : kb && Number.isFinite(Number(kb)) ? Number(kb) / 1024 : null; });
    const known = amounts.filter((amount): amount is number => amount !== null && amount >= 0), max = Math.max(0, ...known);
    const regions = new Set(rows.map(row => get(row, '国家/地区', '地区'))), shared = regions.size === 1 ? get(rows[0]!, '国家/地区', '地区') : '';
    return [h('div', { class: 'heading' }, h('span', null, `最近 ${rows.length} 条 CDR${shared ? ` · ${shared}` : ''}`), known.length ? h('b', null, `${mb(String(known.reduce((sum, value) => sum + value, 0)))} 合计`) : null),
      h('ol', { class: 'cdrs', onscroll: (event: Event) => { if (selectedScope === input.scope && selectedPlan === planIndex) cdrScroll[planIndex] = (event.currentTarget as HTMLElement).scrollTop; }, ref: (node: HTMLElement) => { queueMicrotask(() => { if (node.isConnected && selectedScope === input.scope && selectedPlan === planIndex) node.scrollTop = cdrScroll[planIndex] ?? 0; }); }, tabindex: '0', 'aria-label': 'CDR 明细，可滚动' }, rows.map((row, index) => { const place = [shared ? '' : get(row, '国家/地区', '地区'), get(row, '运营商', '网络')].filter(Boolean).join(' · '); const rawTime = get(row, '更新时间', '时间', '开始时间', '结束时间', '日期'); const at = cdrAt(row); const time = Number.isFinite(at) ? (() => { const date = new Date(at + 8 * 3600_000).toISOString(); return rawTime.length === 10 ? date.slice(0,10) : `${date.slice(5,10)} ${date.slice(11,16)}`; })() : rawTime; const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(5,10); const isToday = time.length === 11 && time.startsWith(today); const amount = amounts[index]; return h('li', { class: 'cdr' }, h('i', { class: 'bar', style: { width: amount !== null && amount !== undefined && max > 0 ? `${Math.max(4, Math.round(amount / max * 100))}%` : '0%' } }), h('time', { class: isToday ? 'today' : '' }, isToday ? `今天 ${time.slice(6)}` : time || '—'), h('span', { class: place ? 'op' : 'op none', title: place }, place || '—'), h('b', null, amount === null || amount === undefined ? '—' : mb(String(amount)))); }))];
  };
  const button = (label: string, cls: string, props: Record<string, unknown>, ...children: Child[]) => h('button', { type: 'button', class: cls, 'aria-label': label, title: label, ...props }, ...children);
  const ring = (plan: typeof plans[number], mini = false) => {
    const percent = plan.remain ? plan.remain_pct : null, unlimited = !plan.remain && plan.unlimited === true, size = mini ? 22 : 44, radius = mini ? 8.5 : 18, circumference = 2 * Math.PI * radius;
    const svg = h('span', { ref: (element: Element) => {
      const document = element.ownerDocument, namespace = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(namespace, 'svg');
      svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
      svg.setAttribute('aria-hidden', 'true');
      for (const className of ['tr', 'fg']) {
        const circle = document.createElementNS(namespace, 'circle');
        circle.setAttribute('class', className);
        circle.setAttribute('cx', String(size / 2));
        circle.setAttribute('cy', String(size / 2));
        circle.setAttribute('r', String(radius));
        if (className === 'fg') circle.setAttribute('stroke-dasharray', `${(circumference * (percent ?? (unlimited ? 100 : 0)) / 100).toFixed(1)} ${circumference.toFixed(1)}`);
        svg.appendChild(circle);
      }
      element.appendChild(svg);
    } });
    return h('span', { class: mini ? 'mini' : 'ring', dataset: { tone: percent === null ? 'muted' : percent <= 0 ? 'over' : percent <= 20 ? 'warn' : 'ok' }, ...(percent === null ? {} : { role: 'meter', 'aria-label': '剩余流量', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(percent) }) }, svg, mini ? null : h('b', null, percent === null ? unlimited ? '∞' : '—' : `${percent}%`));
  };
  const status = (plan: PackagePlanInfo): [string, string] => {
    const value = plan.status, key = value.toLowerCase();
    const known: Record<string, [string, string]> = { using: ['使用中', 'ok'], activated: ['使用中', 'ok'], active: ['使用中', 'ok'], inactive: ['未激活', 'warn'], not_activated: ['未激活', 'warn'], pending: ['待处理', 'warn'], default: ['待处理', 'warn'], cancel: ['已取消', 'muted'], cancelled: ['已取消', 'muted'], expired: ['已过期', 'muted'], terminated: ['已终止', 'bad'], success: ['成功', 'ok'], fail: ['失败', 'bad'], failed: ['失败', 'bad'], refundreview: ['退款审核中', 'warn'], refund: ['已退款', 'muted'] };
    if (known[key]) return known[key]!;
    return [value || '未返回', /使用中|成功/.test(value) ? 'ok' : /未激活|待处理|审核中/.test(value) ? 'warn' : /已终止|失败/.test(value) ? 'bad' : 'muted'];
  };
  const pill = (plan: typeof plans[number]) => h('span', { class: 'pill', title: plan.status, dataset: { tone: status(plan)[1] } }, status(plan)[0]);
  const section = (cls: string, ...children: Child[]) => h('section', { class: `row ${cls}` }, ...children);
  const panels = plans.map((plan, index) => {
    const cell = (label: string, value: string, mono = false) => h('div', null, h('small', null, label), h('b', { class: value ? mono ? 'mono' : '' : 'none', title: value }, value || '未返回'));
    const ids: Child[] = [];
    for (const [label, value, fallback] of [['流水号', field(plan, '业务流水号'), '未返回'], ['ICCID', plan.iccid, '未返回'], ['EID', field(plan, 'EID'), '实体卡或未返回'], ['设备', field(plan, '设备型号'), '未返回']]) {
      ids.push(h('dt', null, label), h('dd', { class: value ? label === '设备' ? 'txt' : '' : 'none', title: value }, value ? label === '设备' ? value : value.replace(/(.{4})(?=.)/g, '$1 ') : fallback), h('span', null, value && label !== '设备' ? button(`复制 ${label}`, 'copy', { onclick: () => input.copy(value!) }, glyph(IC.copy, 12)) : null));
    }
    return h('div', { role: 'tabpanel', hidden: index !== selected, dataset: { packagePlan: String(index) }, 'aria-label': `套餐 ${index + 1}` },
      section('hero', ring(plan), h('div', null, h('div', { class: 'lab' }, pill(plan), h('span', null, plan.remain ? plan.usage_scope === 'daily' ? '今日剩余' : '套餐剩余' : plan.unlimited ? '不限量套餐' : '用量待查询')), h('div', { class: 'num' }, h('b', { class: plan.remain || plan.unlimited ? '' : 'none' }, plan.remain || (plan.unlimited ? '不限量' : '—')), plan.remain && plan.total ? h('span', null, `/ ${plan.total}`) : null), h('div', { class: 'sub' }, h('span', null, h('em', null, '总用量'), ` ${mb(field(plan, '原始累计用量（MB）') || field(plan, '累计用量（MB）'))}`), field(plan, '当日用量（MB）') ? h('span', null, h('em', null, '当日'), ` ${mb(field(plan, '当日用量（MB）'))}`) : null))),
      section('names', h('div', { class: 'nm' }, h('div', { class: plan.plan ? 'ch' : 'ch none' }, field(plan, '渠道套餐') || plan.plan || '—'), field(plan, '来源套餐') ? h('div', { class: 'src' }, field(plan, '来源套餐')) : null), h('div', { class: 'spec' }, cell('供应商', plan.supplier), cell('APN', plan.apn, true), cell('eSIM', field(plan, 'eSIM状态'), true))),
      section('identifiers', h('dl', { class: 'ids' }, ids)),
      section('records', ...records(plan, index)),
      input.canDetail ? section('actions', button('打开 TSim 详情', 'outline', { dataset: { packageAction: 'detail', planIndex: String(index) }, onclick: () => input.detail(index) }, '打开 TSim 详情')) : null);
  });
  const tabs = plans.map((plan, index) => button(`套餐 ${index + 1}`, 'tab', { role: 'tab', 'aria-selected': String(index === selected), onclick: (event: Event) => {
    if (selectedScope !== input.scope) return;
    selectedPlan = index;
    const tab = event.currentTarget as HTMLElement, root = tab.getRootNode() as ShadowRoot;
    root.querySelectorAll('[role="tab"]').forEach((node, position) => node.setAttribute('aria-selected', String(position === index)));
    root.querySelectorAll<HTMLElement>('[role="tabpanel"]').forEach((node, position) => { node.hidden = position !== index; if (position === index) { const cdr = node.querySelector<HTMLElement>('.cdrs'); if (cdr) cdr.scrollTop = cdrScroll[index] ?? 0; } });
  } }, h('i', { dataset: { tone: status(plan)[1] } }), `套餐 ${index + 1}`, h('span', { class: 'st' }, status(plan)[0])));
  const card = h('div', { class: `card${input.open ? '' : ' collapsed'}${input.busy ? ' busy' : ''}` },
    h('div', { class: 'head' }, button('展开或收起套餐', 'tg', { 'aria-expanded': String(input.open), onclick: input.toggle }, h('span', { class: 'title' }, '套餐速览'), h('span', { class: 'count' }, `${input.total} 个套餐`)), button('刷新套餐', 'icon refresh', { disabled: input.refreshDisabled, dataset: { packageAction: 'refresh' }, onclick: input.refresh }, glyph(IC.refresh, 14)), button('展开或收起套餐', 'icon toggle', { 'aria-expanded': String(input.open), onclick: input.toggle }, glyph(IC.chevDown, 14))),
    !input.open && plans[selected] ? h('div', { class: 'sum' }, ring(plans[selected]!, true), pill(plans[selected]!), h('b', null, plans[selected]!.remain || (plans[selected]!.unlimited ? '不限量' : '—')), h('span', null, plans[selected]!.plan)) : null,
    h('div', { class: 'body', onscroll: (event: Event) => { if (selectedScope === input.scope) bodyScroll = (event.currentTarget as HTMLElement).scrollTop; }, ref: (node: HTMLElement) => { queueMicrotask(() => { if (node.isConnected && selectedScope === input.scope) node.scrollTop = bodyScroll; }); }, 'aria-busy': String(input.busy), 'aria-live': 'polite' },
      plans.length > 1 || input.total > plans.length ? h('div', { class: 'tabs', role: 'tablist', 'aria-label': '套餐' }, tabs, input.total > plans.length ? h('span', { class: 'more', title: `共 ${input.total} 个套餐；其余请在 TSim 中查看` }, `+${input.total - plans.length}`) : null) : null,
      input.notice, panels),
    h('div', { class: 'foot' }, h('span', { class: 'rel' }, plans[0] ? `${new Date(plans[0].fetched_at_ms).toLocaleString('zh-CN')} 更新` : input.identity)));
  const style = h('style', null, COMPANION_CARD_STYLE + '\n.ring>span{display:contents}[data-tone=warn]>span>svg .fg{stroke:#e7a034}[data-tone=over]>span>svg .fg{stroke:#e0574c}[data-tone=muted]>span>svg .fg{stroke:#c3c9d5}.card{max-height:inherit;animation:none}.body{min-height:0}.actions{padding-top:6px}:host(.hot) .card{border-color:var(--accent);box-shadow:0 0 0 2px var(--accent-soft)}');
  const host = h('div', { class: `companion-card${input.hot ? ' hot' : ''}`, role: 'region', 'aria-label': '订单套餐信息', style: { margin: '8px 8px 10px', 'max-height': '64%', 'min-height': '0', display: 'flex', 'flex-direction': 'column', 'flex-shrink': '0' } }, style, card);
  // Test renderers return structural trees; native DOM uses the original isolation boundary.
  if (typeof host.attachShadow === 'function') {
    host.attachShadow({ mode: 'open' }).append(style, card);
    preserveCompanionFocus(previousCard?.host ?? null, host, previousCard?.scope === input.scope);
    previousCard = { scope: input.scope, host };
  }
  return host;
}
