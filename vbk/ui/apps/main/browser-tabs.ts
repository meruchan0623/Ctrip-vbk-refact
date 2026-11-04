import { UiCommands, type UiBrowserTab } from '../../packages/ipc/src/client.ts';
import type { h as dom, icon as glyph } from '../../packages/ui-kit/src/h.ts';

/** Inline stroke paths (24x24); kept here so the shared icon table stays untouched. */
export const WEB_ICONS = {
  globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c2.5 2.5 3.5 5.5 3.5 9S14.5 18.5 12 21c-2.5-2.5-3.5-5.5-3.5-9S9.5 5.5 12 3z',
  back: 'M15 6l-6 6 6 6',
  forward: 'M9 6l6 6-6 6',
  reload: 'M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5',
  external: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  close: 'M6 6l12 12M18 6L6 18',
} as const;

type Hyper = typeof dom;
type IconFn = typeof glyph;

export interface BrowserTabsDeps {
  invoke(cmd: string, payload: unknown): Promise<unknown>;
  get(): { tabs: readonly UiBrowserTab[]; active: string | null; covered: boolean };
  patch(p: { webTabs?: readonly UiBrowserTab[]; activeWeb?: string | null }): void;
  notify(text: string): void;
  stage(): HTMLElement | null;
  schedule?(cb: () => void): void;
}

export function isBrowserTab(v: unknown): v is UiBrowserTab {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o['tab_id'] === 'string' && o['tab_id'] !== '' && typeof o['account_id'] === 'string'
    && typeof o['url'] === 'string' && typeof o['title'] === 'string' && typeof o['loading'] === 'boolean';
}

/** host + path only: the query/fragment may carry tokens and must never reach the UI. */
export function displayAddress(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname === '/' ? '' : u.pathname}`;
  } catch { return ''; }
}

export function tabLabel(tab: Pick<UiBrowserTab, 'title' | 'url'>): string {
  const title = tab.title.trim();
  if (title) return title;
  try { return new URL(tab.url).hostname || '网页'; } catch { return '网页'; }
}

export function webTabView(
  tab: UiBrowserTab, on: boolean, owner: string,
  handlers: { onSelect(): void; onClose(): void },
  h: Hyper, icon: IconFn,
): HTMLElement {
  return h('div', {
    class: on ? 'tab web-tab on' : 'tab web-tab',
    role: 'tab',
    'aria-selected': String(on),
    title: owner ? `${tabLabel(tab)}（${owner}）` : tabLabel(tab),
    dataset: { webTab: tab.tab_id },
    onclick: () => handlers.onSelect(),
    // 中键关闭仅限网页选项卡；账号选项卡不挂此处理。mousedown 拦截是为了避免 Windows 上中键触发自动滚动。
    onmousedown: (e: MouseEvent) => { if (e.button === 1) e.preventDefault(); },
    onauxclick: (e: MouseEvent) => {
      if (e.button !== 1) return;
      e.preventDefault();
      e.stopPropagation();
      handlers.onClose();
    },
  },
  icon(WEB_ICONS.globe, 14),
  h('span', { class: 'tab-name' }, tabLabel(tab)),
  tab.loading ? h('span', { class: 'spin' }) : null,
  h('button', {
    class: 'tab-x', type: 'button', 'aria-label': '关闭网页', title: '关闭网页',
    onclick: (e: Event) => { e.stopPropagation(); handlers.onClose(); },
  }, icon(WEB_ICONS.close, 13)));
}

export function browserStage(
  tab: UiBrowserTab,
  handlers: { onBack(): void; onForward(): void; onReload(): void; onExternal(): void },
  h: Hyper, icon: IconFn, attach: (el: HTMLElement) => void, notice: HTMLElement | null = null,
): HTMLElement {
  const btn = (label: string, path: string, fn: () => void) =>
    h('button', { class: 'web-btn', type: 'button', title: label, 'aria-label': label, onclick: () => fn() }, icon(path, 16));
  const address = displayAddress(tab.url);
  return h('div', { class: 'web-stage', dataset: { webStage: tab.tab_id } },
    h('div', { class: 'web-bar' },
      btn('后退', WEB_ICONS.back, handlers.onBack),
      btn('前进', WEB_ICONS.forward, handlers.onForward),
      btn('刷新', WEB_ICONS.reload, handlers.onReload),
      h('div', { class: 'web-addr', title: address }, address),
      notice,
      btn('系统浏览器打开', WEB_ICONS.external, handlers.onExternal)),
    h('div', { class: 'web-view', ref: (el: Element) => attach(el as HTMLElement) }));
}

type Sent = { key: string };

export function createBrowserTabs(deps: BrowserTabsDeps) {
  const schedule = deps.schedule ?? ((cb: () => void) => {
    const raf = (globalThis as { requestAnimationFrame?: (f: () => void) => unknown }).requestAnimationFrame;
    if (raf) raf(cb); else queueMicrotask(cb);
  });
  let disposed = false;
  let inflight = false;
  let dirty = false;
  let last: Sent | null = null;
  const unbinders = new Set<() => void>();

  const has = (id: string) => deps.get().tabs.some((t) => t.tab_id === id);

  function desired(): { key: string; payload: Record<string, unknown> } {
    const { active, covered, tabs } = deps.get();
    const el = deps.stage();
    if (active && !covered && el && tabs.some((t) => t.tab_id === active)) {
      const r = el.getBoundingClientRect();
      const bounds = { x: Math.round(r.x ?? r.left), y: Math.round(r.y ?? r.top), width: Math.round(r.width), height: Math.round(r.height) };
      if (bounds.width > 0 && bounds.height > 0) return { key: JSON.stringify([active, bounds]), payload: { tab_id: active, bounds } };
    }
    return { key: 'hidden', payload: { tab_id: null } };
  }

  async function sync(): Promise<void> {
    if (disposed) return;
    if (inflight) { dirty = true; return; }
    inflight = true;
    try {
      do {
        dirty = false;
        const next = desired();
        if (last?.key === next.key) continue;
        last = { key: next.key };
        try { await deps.invoke(UiCommands.BROWSER_SHOW, next.payload); } catch { last = null; }
        if (disposed) return;
      } while (dirty);
    } finally { inflight = false; }
  }

  function requestSync(): void { schedule(() => { void sync(); }); }

  function upsert(tab: UiBrowserTab): void {
    const tabs = deps.get().tabs;
    const i = tabs.findIndex((t) => t.tab_id === tab.tab_id);
    deps.patch({ webTabs: i < 0 ? [...tabs, tab] : tabs.map((t, j) => (j === i ? tab : t)) });
  }

  function removeLocal(id: string): void {
    const { tabs, active } = deps.get();
    const i = tabs.findIndex((t) => t.tab_id === id);
    if (i < 0) return;
    const rest = tabs.filter((t) => t.tab_id !== id);
    const nextActive = active === id ? (rest[i] ?? rest[i - 1] ?? null)?.tab_id ?? null : active;
    deps.patch({ webTabs: rest, activeWeb: nextActive });
    requestSync();
  }

  function activate(id: string | null): void {
    if (id !== null && !has(id)) return;
    deps.patch({ activeWeb: id });
    requestSync();
  }

  async function open(account: unknown, url: string): Promise<void> {
    let res: unknown;
    try { res = await deps.invoke(UiCommands.SHELL_OPEN_WEBVIEW, { account, url }); }
    catch { if (!disposed) deps.notify('打开网页失败，请稍后重试'); return; }
    if (disposed) return;
    if (!isBrowserTab(res)) { deps.notify('打开网页失败：宿主返回异常'); return; }
    upsert(res);
    activate(res.tab_id);
  }

  async function close(id: string): Promise<void> {
    if (!has(id)) return;
    try { await deps.invoke(UiCommands.BROWSER_CLOSE, { tab_id: id }); }
    catch { if (!disposed) deps.notify('关闭网页失败，请稍后重试'); return; }
    if (disposed) return;
    removeLocal(id);
  }

  async function nav(id: string, action: 'back' | 'forward' | 'reload'): Promise<void> {
    if (!has(id)) return;
    try { await deps.invoke(UiCommands.BROWSER_NAV, { tab_id: id, action }); }
    catch { if (!disposed) deps.notify('网页操作失败'); }
  }

  function receiveOpened(payload: unknown): void {
    if (disposed || !isBrowserTab(payload)) return;
    upsert(payload);
    activate(payload.tab_id);
  }
  function receiveChanged(payload: unknown): void {
    if (disposed || !isBrowserTab(payload) || !has(payload.tab_id)) return;
    upsert(payload);
  }
  function receiveClosed(payload: unknown): void {
    if (disposed || !payload || typeof payload !== 'object') return;
    const id = (payload as Record<string, unknown>)['tab_id'];
    if (typeof id !== 'string') return;
    removeLocal(id);
  }

  function attachStage(el: HTMLElement): () => void {
    const RO = (globalThis as { ResizeObserver?: new (cb: () => void) => { observe(e: Element): void; disconnect(): void } }).ResizeObserver;
    const ro = RO ? new RO(() => { void sync(); }) : null;
    ro?.observe(el);
    const onWin = () => { void sync(); };
    const g = globalThis as { addEventListener?: (t: string, f: () => void) => void; removeEventListener?: (t: string, f: () => void) => void };
    g.addEventListener?.('resize', onWin);
    const unbind = () => { ro?.disconnect(); g.removeEventListener?.('resize', onWin); unbinders.delete(unbind); };
    unbinders.add(unbind);
    requestSync();
    return unbind;
  }

  function dispose(): void {
    disposed = true;
    for (const u of [...unbinders]) u();
  }

  return { open, activate, close, nav, receiveOpened, receiveChanged, receiveClosed, sync, attachStage, dispose };
}
