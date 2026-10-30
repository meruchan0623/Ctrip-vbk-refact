/**
 * Update window (prototype 02-main 「软件更新」 `.fwin`, 510×300): minimal
 * until the updater feed and signing are configured (plan M5-6). Shows the
 * current version, a 「检查更新」 button that reports 「更新服务尚未配置」,
 * and close. Holds no account or business permission (capabilities/update.json).
 */

import { applyPlatform } from '../_shared/platform.ts';
const platform = applyPlatform();

import { UiCommands } from '../../packages/ipc/src/client.ts';
import { isAppError } from '../../packages/ipc/src/contracts.ts';
import { h, icon, rerender } from '../../packages/ui-kit/src/h.ts';
import { createStore, subscribeBatched } from '../../packages/ui-kit/src/store.ts';
import { t } from '../../packages/ui-kit/src/i18n.ts';
import { IC } from '../_shared/icons.ts';
import { exposeForTests, selectIpc } from '../_shared/ipc.ts';
import { UPDATE_STRINGS as S, fmt } from './strings.ts';
import { checkUpdate, versionText } from './viewmodel.ts';
import type { UpdatePhase } from './viewmodel.ts';

interface UpdateState {
  readonly version: string | null;
  readonly phase: UpdatePhase;
  readonly error: string | null;
}

const store = createStore<UpdateState>({ version: null, phase: 'idle', error: null });
const sel = selectIpc();
const ipc = sel.ipc;
const root = document.getElementById('app');
if (!root) throw new Error('#app missing');

function close(): void {
  void ipc.invoke(UiCommands.SHELL_WINDOW, { action: 'close' }).catch((e: unknown) => store.patch({ error: fmt(S.closeFailed, { msg: isAppError(e) ? e.message : String(e) }) }));
}

function render(s: UpdateState): Node {
  return h(
    'div',
    { class: 'updwin' },
    h(
      'div',
      { class: 'fwin-h', 'data-tauri-drag-region': 'deep' },
      h('span', { class: 'fwin-title' }, S.title),
      h('span', { class: 'sp' }),
      sel.mock ? h('span', { class: 'muted mock-tag' }, t('app.mockMode')) : null,
      platform === 'windows' ? h('button', { class: 'cap-x', 'aria-label': S.close, title: S.close, dataset: { action: 'close' }, onclick: close }, icon(IC.close, 14)) : null,
    ),
    h(
      'div',
      { class: 'upd-b' },
      h('div', { class: 'upd-title' }, h('b', null, S.heading), h('span', { class: 'muted', dataset: { version: s.version ?? '' } }, versionText(s.version))),
      h(
        'div',
        { class: 'upd-body' },
        s.phase === 'not_configured' ? h('div', { class: 'notice-box info', role: 'status', dataset: { updatePhase: s.phase } }, h('b', null, S.notConfigured), h('div', null, S.notConfiguredDesc)) : null,
        s.error ? h('div', { class: 'notice-box err', role: 'alert' }, s.error) : null,
      ),
    ),
    h(
      'div',
      { class: 'dlg-f' },
      h('button', { class: 'btn', dataset: { action: 'close-footer' }, onclick: close }, S.close),
      h('button', { class: 'btn pri', dataset: { action: 'check' }, onclick: () => store.patch({ phase: checkUpdate(store.get().phase) }) }, icon(IC.refresh, 14), S.check),
    ),
  );
}

subscribeBatched(store, (s) => rerender(root, () => render(s)));
rerender(root, () => render(store.get()));

// Tauri core `app` plugin (granted by core:default); the mock has no version.
if (!sel.mock) {
  void ipc
    .invoke<unknown>('plugin:app|version')
    .then((v) => {
      if (typeof v === 'string') store.patch({ version: v });
    })
    .catch(() => undefined);
}

exposeForTests(sel, { __vbkStore: store });
