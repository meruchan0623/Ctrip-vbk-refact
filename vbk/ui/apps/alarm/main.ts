/**
 * Alarm window (strong-alert §6; prototype 02-main `.alarm`, 03-alerts L3):
 * compact, always-on-top, content only from the Rust snapshot (masked
 * labels, no customer text). Layout: red header, the selected round on top
 * (click jumps to the conversation), the full list below (click picks,
 * double-click jumps), footer 清除 / 全部清除 / 稍后提醒 acting on the
 * selected round. Subscribe to `Events.ALARM_SNAPSHOT` first, then request a
 * snapshot.
 */

import { applyPlatform } from '../_shared/platform.ts';
applyPlatform();

import type { AlarmEntry, AlarmSnapshot } from '../../packages/ipc/src/contracts.ts';
import { ErrorCodes, isAppError } from '../../packages/ipc/src/contracts.ts';
import { Events, NotifyCommands } from '../../packages/ipc/src/commands.ts';
import { h, icon, rerender, cx } from '../../packages/ui-kit/src/h.ts';
import { createStore, subscribeBatched } from '../../packages/ui-kit/src/store.ts';
import { initialOf } from '../../packages/ui-kit/src/format.ts';
import { t } from '../../packages/ui-kit/src/i18n.ts';
import { IC } from '../_shared/icons.ts';
import { exposeForTests, selectIpc } from '../_shared/ipc.ts';
import { guarded, isAlarmSnapshot } from '../_shared/guards.ts';
import { SNOOZE_OPTIONS, acceptsSnapshotResponse, avatarColor, deriveAlarmRows, entryCommand, hasL4, headerTitle, hideAllCommand, rowKey, selectedRow, thresholdText } from './viewmodel.ts';
import type { AlarmAction, AlarmRow } from './viewmodel.ts';
import { ALARM_STRINGS as S, fmt } from './strings.ts';

interface AlarmState {
  readonly snapshot: AlarmSnapshot | null;
  readonly notice: string | null;
  readonly snoozeMenu: string | null;
  readonly busy: string | null;
  /** Row picked in the list (prototype `alarmSel`); null → longest-waiting row. */
  readonly picked: string | null;
}

/** `snoozeMenu` value for the footer menu (row menus use the row key). */
const FOOTER_MENU = '#footer';

const store = createStore<AlarmState>({ snapshot: null, notice: null, snoozeMenu: null, busy: null, picked: null });
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
    const snap = await ipc.invoke<unknown>(NotifyCommands.SNAPSHOT, {});
    if (!isAlarmSnapshot(snap)) throw new Error('notify_snapshot: malformed snapshot');
    // an event that arrived while the request was in flight is newer than this response
    if (acceptsSnapshotResponse(store.get().snapshot, snap)) store.patch({ snapshot: snap });
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

/** Status bits after the name; `full` (top block) also names the level when nothing else applies. */
function subLine(r: AlarmRow, full: boolean): Node[] {
  const parts: Node[] = [];
  if (r.pending) parts.push(h('span', { class: 'chip chip-warn', title: t('alarm.pendingTitle'), dataset: { pending: '1' } }, t('alarm.pending')));
  if (r.snoozed && r.snoozedUntilText) parts.push(h('span', { dataset: { snoozed: '1' } }, t('alarm.snoozed', { t: r.snoozedUntilText })));
  else if (full) parts.push(h('span', null, `${S.waitingReply}${S.levelSep}${r.level}`));
  return parts;
}

function snoozeMenu(e: AlarmEntry, cls: string): Node {
  return h(
    'div',
    { class: cx('menu', cls), role: 'menu', onmousedown: (ev: Event) => ev.stopPropagation() },
    SNOOZE_OPTIONS.map((o) => h('button', { class: 'mi', role: 'menuitem', dataset: { snooze: String(o.minutes) }, onclick: () => act(e, { kind: 'snooze', minutes: o.minutes }) }, fmt(S.snoozeOption, { m: o.minutes }))),
  );
}

function renderSelected(r: AlarmRow, busy: boolean): Node {
  return h(
    'div',
    { class: cx('alarm-sel', { snoozed: r.snoozed }), role: 'button', tabindex: '0', title: S.jumpTitle, 'aria-disabled': String(busy), dataset: { sel: r.key }, onclick: () => !busy && act(r.entry, { kind: 'open' }), onkeydown: (ev: KeyboardEvent) => { if ((ev.key === 'Enter' || ev.key === ' ') && !busy) { ev.preventDefault(); act(r.entry, { kind: 'open' }); } } },
    h('div', { class: 'ava', style: { background: avatarColor(r.entry.gid) } }, initialOf(r.label)),
    h('div', { class: 'sel-main' }, h('div', { class: 'sel-name' }, h('b', { class: 'arow-label' }, r.label)), h('div', { class: 'sel-sub muted' }, ...subLine(r, true))),
    h('div', { class: 'sel-wait' }, h('div', { class: cx('alarm-wait big', { red: r.red }) }, r.waitedText), h('div', { class: 'muted', style: { 'font-size': '11px' } }, t('alarm.waited'))),
  );
}

function renderRow(r: AlarmRow, s: AlarmState, selKey: string | null): Node {
  const busy = s.busy === r.key;
  const menuOpen = s.snoozeMenu === r.key;
  return h(
    'div',
    {
      class: cx('arow', { on: r.key === selKey, snoozed: r.snoozed, red: r.red, menu: menuOpen }),
      role: 'option',
      tabindex: '0',
      title: S.pickTitle,
      'aria-selected': String(r.key === selKey),
      dataset: { gid: r.entry.gid, round: r.entry.round_id, version: String(r.entry.version) },
      onclick: () => store.patch({ picked: r.key, snoozeMenu: null }),
      ondblclick: () => !busy && act(r.entry, { kind: 'open' }),
      onkeydown: (ev: KeyboardEvent) => { if (ev.key === 'Enter' && ev.target === ev.currentTarget && !busy) act(r.entry, { kind: 'open' }); },
    },
    h('span', { class: 'ava xs', style: { background: avatarColor(r.entry.gid) } }, initialOf(r.label)),
    h('span', { class: 'arow-text' }, h('span', { class: 'arow-name' }, r.label), ...(() => {
      const bits = subLine(r, false);
      return bits.length > 0 ? [h('span', { class: 'muted arow-sub' }, ...bits)] : [];
    })()),
    h(
      'span',
      { class: 'arow-acts', onclick: (ev: Event) => ev.stopPropagation(), ondblclick: (ev: Event) => ev.stopPropagation() },
      h('button', { class: 'ibtn xs', 'aria-label': S.rowHide, title: S.rowHide, disabled: busy, dataset: { act: 'hide' }, onclick: () => act(r.entry, { kind: 'hide' }) }, icon(IC.close, 12)),
      h(
        'span',
        { class: 'snooze-wrap' },
        h('button', { class: 'ibtn xs', 'aria-label': S.rowSnooze, title: S.rowSnooze, disabled: busy, 'aria-expanded': String(menuOpen), dataset: { act: 'snooze' }, onclick: (ev: Event) => { ev.stopPropagation(); store.patch({ snoozeMenu: menuOpen ? null : r.key }); } }, icon(IC.clock, 12)),
        menuOpen ? snoozeMenu(r.entry, 'snooze-menu') : null,
      ),
    ),
    h('span', { class: cx('wait alarm-wait', r.red ? 'red' : 'amber'), dataset: { waited: String(r.entry.waited_seconds) } }, r.waitedText),
  );
}

function render(s: AlarmState): Node {
  const snap = s.snapshot;
  if (!snap) return h('div', { class: 'alarm' }, h('div', { class: 'alarm-h' }, icon(IC.clock, 16), t('app.loading')));
  const now = Date.now();
  const rows = deriveAlarmRows(snap, now);
  const sel = selectedRow(rows, s.picked);
  const footerMenu = s.snoozeMenu === FOOTER_MENU;
  const selBusy = sel !== null && s.busy === sel.key;
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
    sel ? renderSelected(sel, selBusy) : null,
    h(
      'div',
      { class: 'alarm-list', role: 'listbox', dataset: { keepScroll: 'alarm' } },
      rows.map((r) => renderRow(r, s, sel?.key ?? null)),
      rows.length === 0 ? h('div', { class: 'empty', style: { margin: '12px' } }, t('alarm.empty')) : null,
    ),
    h(
      'div',
      { class: 'alarm-f' },
      h('button', { class: 'btn sm', disabled: sel === null || selBusy, dataset: { act: 'hide-selected' }, onclick: () => sel && act(sel.entry, { kind: 'hide' }) }, t('alarm.hide')),
      h('button', { class: 'btn sm', disabled: rows.length === 0 || s.busy === 'all', dataset: { act: 'hide-all' }, onclick: hideAll }, t('alarm.hideAll')),
      h(
        'button',
        { class: 'btn sm pri', disabled: sel === null || selBusy, 'aria-expanded': String(footerMenu), dataset: { act: 'snooze-selected' }, onclick: (ev: Event) => { ev.stopPropagation(); store.patch({ snoozeMenu: footerMenu ? null : FOOTER_MENU }); } },
        t('alarm.snooze'),
        icon(IC.chevUp, 12),
      ),
      footerMenu && sel ? snoozeMenu(sel.entry, 'footer-menu') : null,
    ),
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

// subscribe-first, then snapshot; a malformed event payload is dropped, never rendered
ipc.listen<unknown>(Events.ALARM_SNAPSHOT, guarded(Events.ALARM_SNAPSHOT, isAlarmSnapshot, (snap) => store.patch({ snapshot: snap })));
void refresh();

exposeForTests(sel, { __vbkStore: store });
