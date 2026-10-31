/** Keep the current reading position when media resolves after a synchronous render. */
export function observeHistoryLayout<Anchor>(
  scroll: HTMLElement,
  capture: () => Anchor | null,
  restore: (anchor: Anchor | null) => void,
  current: () => boolean,
  Observer: typeof ResizeObserver = ResizeObserver,
): () => void {
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
    // A scroll queued by synchronous restore may arrive after media layout, before RO.
    // If the viewport did not move, that event must not erase the pending layout delta.
    const maximum = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
    // Shrinking media may clamp the old offset before RO. That is a layout move,
    // not a new reading position; keep the old row offset for the resize callback.
    if (lastTop > maximum && Math.abs(scroll.scrollTop - maximum) < 1) return;
    if (scroll.scrollTop !== lastTop) remember();
  };
  const observer = new Observer(() => {
    if (disposed || !current()) return;
    if (pinned) scroll.scrollTop = scroll.scrollHeight;
    else restore(anchor);
    remember();
  });
  // Container dimensions alone do not change when an image grows inside an overflow pane.
  observer.observe(scroll);
  for (const row of scroll.children) observer.observe(row);
  scroll.addEventListener('scroll', onScroll, { passive: true });
  return () => {
    disposed = true;
    observer.disconnect();
    scroll.removeEventListener('scroll', onScroll);
  };
}

let stop: (() => void) | undefined;
/** One active message pane; release detached nodes before each full render. */
export function stopHistoryLayout(): void { stop?.(); stop = undefined; }
export function startHistoryLayout<Anchor>(scroll: HTMLElement | null, capture: () => Anchor | null, restore: (anchor: Anchor | null) => void, current: () => boolean): void {
  stopHistoryLayout();
  if (scroll && typeof ResizeObserver !== 'undefined') stop = observeHistoryLayout(scroll, capture, restore, current);
}
