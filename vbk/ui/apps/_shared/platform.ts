/** Platform class for window chrome. Sets `<html data-platform="macos|windows">`. */
export type Platform = 'macos' | 'windows';

function isPlatform(x: unknown): x is Platform {
  return x === 'macos' || x === 'windows';
}

export function detectPlatform(): Platform {
  // The host may inject `window.__VBK_PLATFORM__` before the page loads (M0-3); it wins over the UA guess.
  const injected = typeof window === 'undefined' ? undefined : (window as unknown as { __VBK_PLATFORM__?: unknown }).__VBK_PLATFORM__;
  if (isPlatform(injected)) return injected;
  const p = typeof navigator === 'undefined' ? '' : `${navigator.platform} ${navigator.userAgent}`;
  return /Mac/i.test(p) ? 'macos' : 'windows';
}

/** Call first thing in every window entry; `?platform=` overrides for smoke tests. */
export function applyPlatform(): Platform {
  const forced = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('platform') : null;
  const p: Platform = isPlatform(forced) ? forced : detectPlatform();
  document.documentElement.dataset['platform'] = p;
  return p;
}

export function currentPlatform(): Platform {
  const p = typeof document === 'undefined' ? undefined : document.documentElement.dataset['platform'];
  return isPlatform(p) ? p : detectPlatform();
}
