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
const platform = applyPlatform();

import { AccountCommands, Events } from '../../packages/ipc/src/commands.ts';
import type { UiAccountSnapshot } from '../../packages/ipc/src/client.ts';
import { UiCommands } from '../../packages/ipc/src/client.ts';
import { isAppError } from '../../packages/ipc/src/contracts.ts';
import { h, icon, rerender } from '../../packages/ui-kit/src/h.ts';
import { createStore, subscribeBatched } from '../../packages/ui-kit/src/store.ts';
import { IC } from '../_shared/icons.ts';
import { exposeForTests, selectIpc } from '../_shared/ipc.ts';
import { guarded, isUiAccountSnapshot } from '../_shared/guards.ts';
import { LOGIN_STRINGS as S, fmt } from './strings.ts';
import { resolveAttemptId } from './viewmodel.ts';

interface LoginState {
  readonly accounts: UiAccountSnapshot | null;
  readonly closing: boolean;
  readonly error: string | null;
}

const store = createStore<LoginState>({ accounts: null, closing: false, error: null });
const sel = selectIpc();
const ipc = sel.ipc;
const root = document.getElementById('app');
if (!root) throw new Error('#app missing');

async function cancelAndClose(): Promise<void> {
  if (store.get().closing) return;
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
      platform === 'windows'
        ? h('button', { class: 'cap-x', 'aria-label': S.close, title: S.close, disabled: s.closing, dataset: { action: 'cancel' }, onclick: () => void cancelAndClose() }, icon(IC.close, 14))
        : null,
    ),
    h(
      'div',
      { class: 'urlbar', title: s.error ?? undefined },
      icon(IC.lock, 12, { style: 'color: var(--c-ok-text)' }),
      h('span', { class: 'url' }, S.url),
      h('span', { class: 'embed' }, S.embedded),
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
