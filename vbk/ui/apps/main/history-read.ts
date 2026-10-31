import type { UiMessagePage } from '../../packages/ipc/src/client.ts';

/** The host can be blocked before its own RPC deadline starts (e.g. native window creation). */
export function readHistoryPage(read: Promise<unknown>, timeoutMs = 20_000): Promise<UiMessagePage | null> {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    read.then(value => {
      clearTimeout(timer);
      if (!value || typeof value !== 'object') { resolve(null); return; }
      const page = value as Partial<UiMessagePage>;
      const cursor = page.before_ms;
      const validCursor = cursor === null || (typeof cursor === 'number' && Number.isSafeInteger(cursor) && cursor > 0);
      resolve(Array.isArray(page.items) && typeof page.has_more === 'boolean' && validCursor && (!page.has_more || cursor !== null) ? page as UiMessagePage : null);
    }, () => { clearTimeout(timer); resolve(null); });
  });
}
