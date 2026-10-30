/**
 * Alarm window (strong-alert §6): compact, always-on-top, content only from
 * the Rust snapshot (masked labels, no customer text). Subscribe to
 * `Events.ALARM_SNAPSHOT` first, then request a snapshot.
 */

import type { AlarmEntry, AlarmSnapshot } from '../../packages/ipc/src/contracts.ts';
import { ErrorCodes, isAppError } from '../../packages/ipc/src/contracts.ts';
import { Events, NotifyCommands } from '../../packages/ipc/src/commands.ts';
import { h, icon, rerender, cx } from '../../packages/ui-kit/src/h.ts';
import { createStore, subscribeBatched } from '../../packages/ui-kit/src/store.ts';
import { t } from '../../packages/ui-kit/src/i18n.ts';
import { IC } from '../_shared/icons.ts';
import { exposeForTests, selectIpc } from '../_shared/ipc.ts';
import { SNOOZE_OPTIONS, deriveAlarmRows, entryCommand, hasL4, headerTitle, hideAllCommand, rowKey, thresholdText } from './viewmodel.ts';
import type { AlarmAction } from './viewmodel.ts';

interface AlarmState {
  readonly snapshot: AlarmSnapshot | null;
  readonly notice: string | null;
  readonly snoozeMenu: string | null;
  readonly busy: string | null;
}

const store = createStore<AlarmState>({ snapshot: null, notice: null, snoozeMenu: null, busy: null });
const sel = selectIpc();
const ipc = sel.ipc;
const root = document.getElementById('app');
if (!root) throw new Error('#app missing');

let noticeTimer: ReturnType<typeof setTimeout> | null = null;
function notice(text: string): void {
  store.patch({ notice: text });
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => store.patch({ notice: null }), 3000);
}

async function refresh(): Promise<void> {
  try {
    const snap = await ipc.invoke<AlarmSnapshot>(NotifyCommands.SNAPSHOT, {});
    store.patch({ snapshot: snap });
  } catch (e) {
    notice(t('alarm.cmdFailed', { msg: isAppError(e) ? e.message : String(e) }));
  }
}

async function run(key: string, cmd: string, payload: unknown): Promise<void> {
  store.patch({ busy: key, snoozeMenu: null });
  try {
    await ipc.invoke(cmd, payload);
  } catch (e) {
    if (isAppError(e) && e.code === ErrorCodes.NOTIFY_ROUND_VERSION_MISMATCH) {
      notice(t('alarm.versionMismatch'));
      await refresh();
    } else {
      notice(t('alarm.cmdFailed', { msg: isAppError(e) ? e.message : String(e) }));
    }
  } finally {
    store.patch({ busy: null });
  }
}

function act(e: AlarmEntry, action: AlarmAction): void {
  const { cmd, payload } = entryCommand(e, action);
  void run(rowKey(e), cmd, payload);
}

function hideAll(): void {
  const snap = store.get().snapshot;
  if (!snap) return;
  const { cmd, payload } = hideAllCommand(snap);
  void run('all', cmd, payload);
}

function render(s: AlarmState): Node {
  const snap = s.snapshot;
  if (!snap) return h('div', { class: 'alarm' }, h('div', { class: 'alarm-h' }, icon(IC.clock, 16), t('app.loading')));
  const now = Date.now();
  const rows = deriveAlarmRows(snap, now);
  return h(
    'div',
    { class: 'alarm', role: 'alertdialog', 'aria-label': headerTitle(snap, now) },
    h(
      'div',
      { class: 'alarm-h' },
      icon(IC.clock, 16),
      h('span', { dataset: { alarmTitle: '1' } }, headerTitle(snap, now)),
      hasL4(snap) ? h('span', { class: 'chip l4' }, t('alarm.l4')) : null,
      h('span', { class: 'sp' }),
      h('span', { class: 'alarm-th', dataset: { alarmThreshold: '1' } }, thresholdText(snap)),
    ),
    snap.reconciling ? h('div', { class: 'notice-box warn flat', dataset: { alarmBanner: 'reconciling' } }, t('alarm.reconciling')) : null,
    !snap.settings.enabled ? h('div', { class: 'notice-box info flat' }, t('alarm.disabled')) : null,
    s.notice ? h('div', { class: 'notice-box info flat', role: 'status', dataset: { alarmNotice: '1' } }, s.notice) : null,
    h(
      'div',
      { class: 'alarm-list', dataset: { keepScroll: 'alarm' } },
      rows.map((r) => {
        const busy = s.busy === r.key;
        const menuOpen = s.snoozeMenu === r.key;
        return h(
          'div',
          { class: cx('arow', { snoozed: r.snoozed, red: r.red }), dataset: { gid: r.entry.gid, round: r.entry.round_id, version: String(r.entry.version) } },
          h(
            'div',
            { class: 'arow-main' },
            h('div', { class: 'arow-top' }, h('b', { class: 'arow-label' }, r.label), r.pending ? h('span', { class: 'chip chip-warn', title: t('alarm.pendingTitle'), dataset: { pending: '1' } }, t('alarm.pending')) : null, h('span', { class: 'chip chip-muted' }, r.level)),
            r.snoozed && r.snoozedUntilText ? h('div', { class: 'muted arow-sub', dataset: { snoozed: '1' } }, t('alarm.snoozed', { t: r.snoozedUntilText })) : null,
            h(
              'div',
              { class: 'arow-acts' },
              h('button', { class: 'btn sm pri', disabled: busy, dataset: { act: 'open' }, onclick: () => act(r.entry, { kind: 'open' }) }, t('alarm.open')),
              h('button', { class: 'btn sm', disabled: busy, dataset: { act: 'hide' }, onclick: () => act(r.entry, { kind: 'hide' }) }, t('alarm.hide')),
              h(
                'span',
                { class: 'snooze-wrap' },
                h('button', { class: 'btn sm', disabled: busy, 'aria-expanded': String(menuOpen), dataset: { act: 'snooze' }, onclick: (e: Event) => { e.stopPropagation(); store.patch({ snoozeMenu: menuOpen ? null : r.key }); } }, t('alarm.snooze'), icon(IC.chevDown, 11)),
                menuOpen ? h('div', { class: 'menu snooze-menu', role: 'menu', onmousedown: (e: Event) => e.stopPropagation() }, SNOOZE_OPTIONS.map((o) => h('button', { class: 'mi', role: 'menuitem', dataset: { snooze: String(o.minutes) }, onclick: () => act(r.entry, { kind: 'snooze', minutes: o.minutes }) }, t(o.labelKey)))) : null,
              ),
            ),
          ),
          h('div', { class: 'arow-wait' }, h('div', { class: cx('alarm-wait', { red: r.red }), dataset: { waited: String(r.entry.waited_seconds) } }, r.waitedText), h('div', { class: 'muted', style: { 'font-size': '11px' } }, t('alarm.waited'))),
        );
      }),
      rows.length === 0 ? h('div', { class: 'empty', style: { margin: '12px' } }, t('alarm.empty')) : null,
    ),
    h('div', { class: 'alarm-f' }, h('span', { class: 'sp' }), h('button', { class: 'btn sm', disabled: rows.length === 0 || s.busy === 'all', dataset: { act: 'hide-all' }, onclick: hideAll }, t('alarm.hideAll'))),
    !snap.clock_trusted ? h('div', { class: 'notice-box warn flat', dataset: { alarmBanner: 'clock' } }, t('alarm.clockUntrusted')) : null,
  );
}

subscribeBatched(store, (s) => rerender(root, () => render(s)));
rerender(root, () => render(store.get()));
document.addEventListener('mousedown', () => {
  if (store.get().snoozeMenu) store.patch({ snoozeMenu: null });
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && store.get().snoozeMenu) store.patch({ snoozeMenu: null });
});

// subscribe-first, then snapshot
ipc.listen<AlarmSnapshot>(Events.ALARM_SNAPSHOT, (snap) => store.patch({ snapshot: snap }));
void refresh();

exposeForTests(sel, { __vbkStore: store });
