/** Companion-style iframe: full viewport layout, clipped to TSIM's own window.
 * Every open has a fresh frame/request; credentials live only in this closure. */
import type { UiTsimOperatorGrant } from '../../packages/ipc/src/client.ts';

export const OPERATOR_ORIGIN = 'https://csagent.tsim.tech';
export const OPERATOR_TIMEOUT_MS = 8000;
export interface OperatorRect { x: number; y: number; width: number; height: number }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Do not trust even a command reply to supply a different destination. */
export function operatorGrant(value: unknown): value is UiTsimOperatorGrant {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<UiTsimOperatorGrant>;
  if (typeof v.identifier !== 'string' || !/^(?:\d{10}|\d{16})$/.test(v.identifier)
    || typeof v.request_id !== 'string' || !UUID.test(v.request_id)
    || typeof v.access_token !== 'string' || !v.access_token || v.access_token.length > 16384
    || !Number.isSafeInteger(v.session_epoch) || v.session_epoch! < 0
    || v.session_ref !== null && typeof v.session_ref !== 'string' || typeof v.url !== 'string') return false;
  try {
    const url = new URL(v.url);
    return url.origin === OPERATOR_ORIGIN && url.pathname === '/embed/operator' && !url.username && !url.password && !url.hash
      && url.searchParams.get('identifier') === v.identifier && url.searchParams.get('requestId') === v.request_id
      && url.searchParams.get('source') === 'travel-merchant-companion' && url.searchParams.get('session') === 'handoff'
      && url.searchParams.get('identifierType') === 'order_number'
      && [...url.searchParams.keys()].length === 5;
  } catch { return false; }
}

export function operatorRect(value: unknown, width: number, height: number): OperatorRect | null {
  if (!value || typeof value !== 'object') return null;
  const r = value as OperatorRect;
  if (![r.x, r.y, r.width, r.height, width, height].every(Number.isFinite) || r.width <= 0 || r.height <= 0 || width <= 0 || height <= 0) return null;
  const x = Math.max(0, r.x), y = Math.max(0, r.y);
  const right = Math.min(width, r.x + r.width), bottom = Math.min(height, r.y + r.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

export interface OperatorOverlay {
  open(grant: UiTsimOperatorGrant, current: () => boolean): void;
  close(): void;
  dispose(): void;
  readonly frame: HTMLIFrameElement | null;
}

export function createOperatorOverlay(document: Document): OperatorOverlay {
  const view = document.defaultView!;
  let frame: HTMLIFrameElement | null = null, clip: HTMLElement | null = null, status: HTMLElement | null = null;
  let message: HTMLElement | null = null, grant: UiTsimOperatorGrant | null = null, bounds: OperatorRect | null = null;
  let current: (() => boolean) | null = null, timer: number | undefined, disposed = false, canHandoff = false;
  let previousFocus: HTMLElement | null = null, handoffRequested = false;
  const text = (value: string) => { if (message) message.textContent = value; };
  function close(): void {
    view.clearTimeout(timer); timer = undefined;
    const focus = previousFocus; previousFocus = null;
    const focused = !!frame && document.activeElement === frame;
    frame?.remove(); clip?.remove(); status?.remove();
    frame = null; clip = null; status = null; message = null; grant = null; bounds = null; current = null; canHandoff = false; handoffRequested = false;
    if (focused && focus?.isConnected) focus.focus({ preventScroll: true });
  }
  function layout(): void {
    if (!clip || !frame) return;
    const width = view.innerWidth, height = view.innerHeight;
    const rect = bounds && operatorRect(bounds, width, height)
      || { x: Math.round(width * .05), y: Math.round(height * .05), width: Math.round(width * .9), height: Math.round(height * .9) };
    Object.assign(clip.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px`, borderRadius: bounds ? '0' : '8px', boxShadow: bounds ? 'none' : '0 6px 24px rgba(0,0,0,.18)' });
    Object.assign(frame.style, { left: `${-rect.x}px`, top: `${-rect.y}px`, width: `${width}px`, height: `${height}px` });
    if (status) status.style.display = bounds ? 'none' : 'flex';
  }
  function open(value: UiTsimOperatorGrant, isCurrent: () => boolean): void {
    if (disposed || !operatorGrant(value) || !isCurrent() || document.visibilityState === 'hidden') return;
    close();
    previousFocus = document.activeElement as HTMLElement | null;
    grant = { ...value }; current = isCurrent; canHandoff = true;
    clip = document.createElement('div'); clip.id = 'tsim-operator-viewport';
    clip.style.cssText = 'position:fixed;overflow:hidden;z-index:1000;background:white';
    frame = document.createElement('iframe'); frame.id = 'tsim-operator-frame'; frame.title = 'TSIM 订单查询'; frame.referrerPolicy = 'no-referrer';
    // Remote documents have no Tauri capability. Script/forms/storage are needed
    // by official TSIM login; popups and top-level navigation remain sandboxed.
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-downloads');
    frame.style.cssText = 'position:absolute;display:block;margin:0;padding:0;border:0;background:transparent;color-scheme:normal';
    frame.src = value.url;
    const ownFrame = frame;
    // Network loading is not a failed session handshake. Start the deadline
    // only after load; the app may already have requested its session by then.
    frame.addEventListener('load', () => {
      if (frame !== ownFrame || handoffRequested || !canHandoff) return;
      view.clearTimeout(timer);
      timer = view.setTimeout(() => {
        if (frame !== ownFrame) return;
        canHandoff = false;
        text('TSIM 页面尚未接管登录态，可在页面内登录，或关闭后重试。');
      }, OPERATOR_TIMEOUT_MS);
    });
    frame.addEventListener('error', () => { if (frame === ownFrame) text('TSIM 页面未能加载，请关闭后重试。'); });
    clip.append(frame); document.body.append(clip);
    status = document.createElement('div'); status.id = 'tsim-operator-loading';
    status.style.cssText = 'position:fixed;left:50%;top:8px;transform:translateX(-50%);z-index:1001;display:flex;align-items:center;gap:12px;padding:8px 12px;background:white;border:1px solid #ddd;border-radius:8px;color:#333;font:13px sans-serif;max-width:calc(100vw - 32px)';
    message = document.createElement('span'); message.setAttribute('role', 'status');
    const button = document.createElement('button'); button.type = 'button'; button.className = 'btn'; button.style.cssText = 'flex-shrink:0;padding:6px 12px;min-height:32px;border:1px solid #b8bec8;border-radius:6px;background:#f3f4f6;color:#222;font:inherit;cursor:pointer'; button.textContent = '关闭订单'; button.addEventListener('click', close);
    status.append(message, button); document.body.append(status);
    text('正在打开 TSIM 订单页…'); layout();
  }
  function onMessage(event: MessageEvent): void {
    if (!frame || !grant || event.origin !== OPERATOR_ORIGIN || event.source !== frame.contentWindow) return;
    if (!current?.()) { close(); return; }
    const data: unknown = event.data;
    if (!data || typeof data !== 'object') return;
    const m = data as Record<string, unknown>;
    // V1 viewport events are allowed only from this unique per-open frame;
    // credential requests always require both identifier and request UUID.
    if (m.type === 'TSIM_OPERATOR_NEEDS_LOGIN' && m.version === undefined) {
      canHandoff = false; bounds = null; layout(); text('请在 TSIM 页面内完成登录。'); return;
    }
    if (m.identifier !== grant.identifier) return;
    const v2 = m.version === 2 && m.requestId === grant.request_id;
    const legacy = (m.version === 1 || m.version === undefined) && m.requestId === undefined;
    if (!v2 && !legacy) return;
    if (m.type === 'TSIM_OPERATOR_NEEDS_SESSION') {
      if (!v2) return;
      handoffRequested = true;
      view.clearTimeout(timer); timer = undefined;
      frame.contentWindow?.postMessage({ type: canHandoff ? 'TSIM_OPERATOR_SESSION' : 'TSIM_OPERATOR_SESSION_UNAVAILABLE', version: 2, identifier: grant.identifier, requestId: grant.request_id,
        ...(canHandoff ? { accessToken: grant.access_token, sessionRef: grant.session_ref } : {}) }, OPERATOR_ORIGIN);
      text(canHandoff ? '正在使用 TSIM 登录态打开订单…第一次打开可能较慢，请等待' : '请在 TSIM 页面内完成登录。');
    } else if (m.type === 'TSIM_OPERATOR_BOUNDS') {
      const rect = operatorRect(m.rect, view.innerWidth, view.innerHeight);
      if (rect) { bounds = rect; layout(); }
    } else if (m.type === 'TSIM_OPERATOR_CLOSE') close();
    else if (m.type === 'TSIM_OPERATOR_NEEDS_LOGIN') { canHandoff = false; bounds = null; layout(); text('请在 TSIM 页面内完成登录。'); }
    else if (m.type === 'TSIM_OPERATOR_BASIC_READY' || m.type === 'TSIM_OPERATOR_LOADED' || m.type === 'TSIM_OPERATOR_QUERY_TERMINAL') {
      view.clearTimeout(timer); text('请在 TSIM 页面查看订单结果。');
    }
  }
  const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && frame) { event.preventDefault(); event.stopPropagation(); close(); } };
  view.addEventListener('message', onMessage); view.addEventListener('resize', layout); view.addEventListener('keydown', onKey, true);
  // Temporary app/tab backgrounding is not an account change. Preserve the
  // query; scope invalidation and actual document teardown still destroy it.
  view.addEventListener('pagehide', close);
  return { open, close, get frame() { return frame; }, dispose() { disposed = true; close(); view.removeEventListener('message', onMessage); view.removeEventListener('resize', layout); view.removeEventListener('keydown', onKey, true); view.removeEventListener('pagehide', close); } };
}
