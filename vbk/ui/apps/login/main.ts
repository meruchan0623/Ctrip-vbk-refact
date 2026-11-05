/**
 * Login window local header (68px, prototype 01-login `.bar` + URL row).
 *
 * The host stacks the official login page as a second, capability-less child
 * WebView directly below this header (02-account-login). This page therefore
 * renders no form and no waiting placeholder: only the title row, the
 * official-URL row and — on Windows — the close button. On macOS the traffic
 * lights sit in the left 78px of the first row (titleBarStyle Overlay).
 */

import { applyPlatform } from '../_shared/platform.ts';
applyPlatform();

import { AccountCommands, Events } from '../../packages/ipc/src/commands.ts';
import type { UiAccountSnapshot } from '../../packages/ipc/src/client.ts';
import { UiCommands } from '../../packages/ipc/src/client.ts';
import { isAppError } from '../../packages/ipc/src/contracts.ts';
import { h, icon, rerender } from '../../packages/ui-kit/src/h.ts';
import { createStore, subscribeBatched } from '../../packages/ui-kit/src/store.ts';
import { IC } from '../_shared/icons.ts';
import { installWindowChrome, windowControls } from '../_shared/window-controls.ts';
import { exposeForTests, selectIpc } from '../_shared/ipc.ts';
import { guarded, isUiAccountSnapshot } from '../_shared/guards.ts';
import { LOGIN_STRINGS as S, fmt } from './strings.ts';
document.title = S.documentTitle;
import { resolveAttemptId } from './viewmodel.ts';
import { createBrowserLogin, shouldDiscoverBrowsers, type BrowserLoginState } from './browser-login.ts';

interface LoginState {
  readonly accounts: UiAccountSnapshot | null;
  readonly closing: boolean;
  readonly error: string | null;
  readonly browser?: BrowserLoginState;
}

const store = createStore<LoginState>({ accounts: null, closing: false, error: null });
const sel = selectIpc();
const ipc = sel.ipc;
installWindowChrome((command, payload) => ipc.invoke(command, payload));
const root = document.getElementById('app');
if (!root) throw new Error('#app missing');
const browser = createBrowserLogin({
  attempt: () => resolveAttemptId(location.search, store.get().accounts),
  invoke: (command, payload) => ipc.invoke(command, payload),
  update: (state) => store.patch({ browser: state }),
});

async function cancelAndClose(): Promise<void> {
  if (store.get().closing) return;
  browser.cancel();
  store.patch({ closing: true, error: null });
  const attempt_id = resolveAttemptId(location.search, store.get().accounts);
  try {
    // cancel first so the host tears down the attempt's profile webview; an
    // unknown/finished attempt must not keep the window open
    if (attempt_id) await ipc.invoke(UiCommands.ACCOUNT_CANCEL_LOGIN, { attempt_id }).catch(() => undefined);
    await ipc.invoke(UiCommands.SHELL_WINDOW, { action: 'close' });
  } catch (e) {
    store.patch({ error: fmt(S.cancelFailed, { msg: isAppError(e) ? e.message : String(e) }) });
  } finally {
    store.patch({ closing: false });
  }
}

function render(s: LoginState): Node {
  return h(
    'header',
    { class: 'lhead', 'data-tauri-drag-region': 'deep' },
    h(
      'div',
      { class: 'bar' },
      h('div', { class: 'logo' }, 'V'),
      h('span', { class: 'title' }, S.title),
      h('span', { class: 'sp' }),
      windowControls({ invoke: (command, payload) => ipc.invoke(command, payload), onClose: () => void cancelAndClose(), closeLabel: S.close, closeDisabled: s.closing, closeDataset: { action: 'cancel' } }),
    ),
    h(
      'div',
      { class: 'urlbar', title: s.error ?? undefined },
      icon(IC.lock, 12, { style: 'color: var(--c-ok-text)' }),
      h('span', { class: 'url' }, S.url),
      h('span', { class: 'embed' }, S.embedded),
    ),
    h('div', { class: 'browser-login' },
      s.browser && s.browser.choices.length > 0 ? h('select', { 'aria-label': S.browserAccountLabel, value: s.browser.selected, disabled: s.browser.busy, onchange: (e: Event) => browser.select((e.target as HTMLSelectElement).value) },
        h('option', { value: '' }, S.browserSelect), ...s.browser.choices.map(p => h('option', { value: p.id }, p.label))) : null,
      h('button', { type: 'button', disabled: s.browser?.busy || !s.browser?.selected, onclick: () => void browser.connect() }, S.browserConnect),
      h('button', { type: 'button', disabled: s.browser?.busy, onclick: () => void browser.discover() }, S.browserRefresh),
      h('span', { role: 'status', title: s.browser?.message }, s.browser?.message ?? S.browserDefault),
    ),
  );
}

subscribeBatched(store, (s) => rerender(root, () => render(s)));
rerender(root, () => render(store.get()));
ipc.listen<unknown>(Events.ACCOUNT_CHANGED, guarded(Events.ACCOUNT_CHANGED, isUiAccountSnapshot, (snap) => store.patch({ accounts: snap })));
void ipc
  .invoke<unknown>(AccountCommands.SNAPSHOT)
  .then((snap) => {
    if (isUiAccountSnapshot(snap)) store.patch({ accounts: snap });
  })
  .catch(() => undefined);
exposeForTests(sel, { __vbkStore: store });
const discoverVisible = () => { if (shouldDiscoverBrowsers(location.search, document.visibilityState, store.get().closing)) void browser.discover(true); };
discoverVisible();
const browserPoll = new URLSearchParams(location.search).get('browser') === 'manual' ? null : window.setInterval(discoverVisible, 2000);
document.addEventListener('visibilitychange', discoverVisible);
window.addEventListener('pagehide', () => { if (browserPoll !== null) window.clearInterval(browserPoll); document.removeEventListener('visibilitychange', discoverVisible); browser.cancel(); });
