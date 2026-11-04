import { historyDiagnostics } from './history-diagnostics.ts';
export type HistoryLayoutObserver = (() => void) & { refresh: () => void };

/** Keep the current reading position when media resolves after a synchronous render. */
export function observeHistoryLayout<Anchor>(
  scroll: HTMLElement,
  capture: () => Anchor | null,
  restore: (anchor: Anchor | null) => void,
  current: () => boolean,
  Observer: typeof ResizeObserver = ResizeObserver,
): HistoryLayoutObserver {
  let disposed = false;
  let anchor = capture();
  let pinned = scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop < 48;
  let lastTop = scroll.scrollTop;
  const remember = (): void => {
    if (disposed || !current()) return;
    anchor = capture();
    pinned = scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop < 48;
    lastTop = scroll.scrollTop;
  };
  const onScroll = (): void => {
    if (disposed || !current()) return;
    // A scroll queued by synchronous restore may arrive after media layout, before RO.
    // If the viewport did not move, that event must not erase the pending layout delta.
    const maximum = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
    // Shrinking media may clamp the old offset before RO. That is a layout move,
    // not a new reading position; keep the old row offset for the resize callback.
    if (lastTop > maximum && Math.abs(scroll.scrollTop - maximum) < 1) { historyDiagnostics.record('clamp', { before: lastTop, after: scroll.scrollTop, maximum }, 'observed'); return; }
    historyDiagnostics.record('scroll', { before: lastTop, after: scroll.scrollTop, maximum }, scroll.scrollTop === lastTop ? 'unchanged' : 'observed');
    if (scroll.scrollTop !== lastTop) {
      remember();
    }
  };
  const observer = new Observer(() => {
    if (disposed || !current()) return;
    historyDiagnostics.record('resize', { scrollTop: scroll.scrollTop, scrollHeight: scroll.scrollHeight, clientHeight: scroll.clientHeight, pinned: pinned ? 1 : 0 }, 'observed');
    if (pinned) scroll.scrollTop = scroll.scrollHeight;
    else restore(anchor);
    remember();
  });
  // Keep unchanged rows subscribed: re-observing them produces an initial RO delivery.
  const watched = new Set<Element>();
  const reconcile = (): void => {
    // Spacers are written by the restore itself; observing them would only echo that write back.
    const children = new Set<Element>([...scroll.children].filter(child => (child as HTMLElement).dataset?.['msgSpacer'] === undefined));
    for (const row of watched) if (!children.has(row)) { observer.unobserve(row); watched.delete(row); }
    for (const row of children) if (!watched.has(row)) { observer.observe(row); watched.add(row); }
  };
  // Container dimensions alone do not change when an image grows inside an overflow pane.
  observer.observe(scroll);
  reconcile();
  scroll.addEventListener('scroll', onScroll, { passive: true });
  const stop = (): void => {
    disposed = true;
    observer.disconnect();
    watched.clear();
    scroll.removeEventListener('scroll', onScroll);
  };
  return Object.assign(stop, { refresh: (): void => {
    if (disposed || !current()) return;
    reconcile();
    remember();
  } });
}

/** Skip synchronous row reads only when both rendered content and pane geometry survived. */
export function createHistoryLayoutFrames() {
  let previous: { pane: HTMLElement; scope: string; revision: unknown; width: number; height: number; contentHeight: number } | undefined;
  return {
    sync(pane: HTMLElement | null, scope: string, revision: unknown, restore: () => void): boolean {
      if (!pane) { previous = undefined; return false; }
      const geometry = () => ({ pane, scope, revision, width: pane.clientWidth, height: pane.clientHeight, contentHeight: pane.scrollHeight });
      const next = geometry();
      if (previous && previous.pane === pane && previous.scope === scope && previous.revision === revision
        && previous.width === next.width && previous.height === next.height && previous.contentHeight === next.contentHeight) return false;
      restore();
      previous = geometry();
      return true;
    },
  };
}

let active: { pane: HTMLElement; scope: string; stop: HistoryLayoutObserver } | undefined;
/** One observer per live pane/scope; refresh only after synchronous content/layout changes. */
export function stopHistoryLayout(): void { active?.stop(); active = undefined; }
export function startHistoryLayout<Anchor>(scroll: HTMLElement | null, capture: () => Anchor | null, restore: (anchor: Anchor | null) => void, current: () => boolean, scope = '', refresh = true): void {
  if (scroll && active?.pane === scroll && active.scope === scope) {
    if (refresh) active.stop.refresh();
    return;
  }
  stopHistoryLayout();
  if (scroll && typeof ResizeObserver !== 'undefined') active = { pane: scroll, scope, stop: observeHistoryLayout(scroll, capture, restore, current) };
}
