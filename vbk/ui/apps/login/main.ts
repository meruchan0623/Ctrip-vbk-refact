/**
 * Login shell. The official login page itself is loaded by the host in an
 * isolated per-account WebView profile (02-account-login); this window only
 * frames it: which account is being added, the official URL, and a cancel
 * button. No credential form lives here.
 */

import { AccountCommands, Events } from '../../packages/ipc/src/commands.ts';
import type { UiAccountSnapshot } from '../../packages/ipc/src/client.ts';
import { UiCommands } from '../../packages/ipc/src/client.ts';
import { h, icon, rerender } from '../../packages/ui-kit/src/h.ts';
import { createStore, subscribeBatched } from '../../packages/ui-kit/src/store.ts';
import { t } from '../../packages/ui-kit/src/i18n.ts';
import { IC } from '../_shared/icons.ts';
import { exposeForTests, selectIpc } from '../_shared/ipc.ts';

interface LoginState {
  readonly accounts: UiAccountSnapshot | null;
}

const store = createStore<LoginState>({ accounts: null });
const sel = selectIpc();
const ipc = sel.ipc;
const root = document.getElementById('app');
if (!root) throw new Error('#app missing');

function render(s: LoginState): Node {
  const pending = s.accounts?.accounts.find((a) => a.state === 'logging_in') ?? null;
  const total = s.accounts?.accounts.filter((a) => a.state !== 'logging_in').length ?? 0;
  const max = s.accounts?.max_accounts ?? 16;
  return h(
    'div',
    { class: 'login' },
    h('div', { class: 'bar' }, h('div', { class: 'logo' }, 'V'), t('login.title'), h('span', { class: 'sp' }), h('span', { class: 'muted' }, t('login.count', { n: total, max }))),
    h('div', { class: 'urlbar' }, icon(IC.lock, 12, { style: 'color: var(--c-ok-text)' }), h('span', { class: 'url' }, t('login.url')), h('span', { class: 'chip chip-info' }, t('login.embedded'))),
    h(
      'div',
      { class: 'stage' },
      h('div', { class: 'spin', style: { width: '28px', height: '28px', 'border-width': '3px' } }),
      h('div', { class: 'adding' }, t('login.adding'), pending ? h('b', { dataset: { pendingAccount: pending.context.account_id } }, `：${pending.nick}`) : null),
      h('p', { class: 'note' }, t('login.desc')),
      h('p', { class: 'note muted' }, t('login.waiting')),
      h('button', { class: 'btn', dataset: { action: 'cancel' }, onclick: () => void ipc.invoke(UiCommands.SHELL_WINDOW, { action: 'close' }).catch(() => undefined) }, t('login.cancel')),
    ),
  );
}

subscribeBatched(store, (s) => rerender(root, () => render(s)));
rerender(root, () => render(store.get()));
ipc.listen<UiAccountSnapshot>(Events.ACCOUNT_CHANGED, (snap) => store.patch({ accounts: snap }));
void ipc.invoke<UiAccountSnapshot>(AccountCommands.SNAPSHOT).then((snap) => store.patch({ accounts: snap })).catch(() => undefined);
exposeForTests(sel, { __vbkStore: store });
