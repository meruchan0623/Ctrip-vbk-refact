/**
 * Alarm window (strong-alert §6): compact, always-on-top, content only from
 * the Rust snapshot (masked label plus the host's message preview). Layout:
 * red header with 全部清除, then one row per round whose height follows its
 * preview; a click jumps to the conversation and each row has its own 清除.
 * The window hugs the rows. Subscribe to `Events.ALARM_SNAPSHOT`
 * first, then request a snapshot.
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
import { acceptsSnapshotResponse, avatarColor, deriveAlarmRows, entryCommand, hasL4, headerTitle, hideAllCommand, rowKey, thresholdText } from './viewmodel.ts';
import type { AlarmAction, AlarmRow } from './viewmodel.ts';
import { ALARM_STRINGS as S } from './strings.ts';
document.title = S.documentTitle;

interface AlarmState {
  readonly snapshot: AlarmSnapshot | null;
  readonly notice: string | null;
  readonly busy: string | null;
}

const store = createStore<AlarmState>({ snapshot: null, notice: null, busy: null });
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
  store.patch({ busy: key });
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

/** Status bits after the name. */
function subLine(r: AlarmRow): Node[] {
  const parts: Node[] = [];
  if (r.pending) parts.push(h('span', { class: 'chip chip-warn', title: t('alarm.pendingTitle'), dataset: { pending: '1' } }, t('alarm.pending')));
  if (r.snoozed && r.snoozedUntilText) parts.push(h('span', { dataset: { snoozed: '1' } }, t('alarm.snoozed', { t: r.snoozedUntilText })));
  return parts;
}

function renderRow(r: AlarmRow, s: AlarmState): Node {
  const busy = s.busy === r.key;
  return h(
    'div',
    {
      class: cx('arow', { snoozed: r.snoozed, red: r.red }),
      role: 'button',
      tabindex: '0',
      title: S.jumpTitle,
      dataset: { key: r.key, fid: `row:${r.key}`, gid: r.entry.gid, round: r.entry.round_id, version: String(r.entry.version) },
      onclick: () => { if (!busy) act(r.entry, { kind: 'open' }); },
      onkeydown: (ev: KeyboardEvent) => { if ((ev.key === 'Enter' || ev.key === ' ') && ev.target === ev.currentTarget && !busy) { ev.preventDefault(); act(r.entry, { kind: 'open' }); } },
    },
    h('span', { class: 'ava xs', style: { background: avatarColor(r.entry.gid) } }, initialOf(r.label)),
    h('span', { class: 'arow-text' }, h('span', { class: 'arow-name' }, r.label), ...(() => {
      const bits = subLine(r);
      return bits.length > 0 ? [h('span', { class: 'muted arow-sub' }, ...bits)] : [];
    })()),
    h(
      'span',
      { class: 'arow-acts', onclick: (ev: Event) => ev.stopPropagation() },
      h('button', { class: 'ibtn xs', 'aria-label': S.rowHide, title: S.rowHide, disabled: busy, dataset: { fid: `hide:${r.key}`, act: 'hide' }, onclick: () => act(r.entry, { kind: 'hide' }) }, icon(IC.close, 12)),
    ),
    h('span', { class: cx('wait alarm-wait', r.red ? 'red' : 'amber'), dataset: { waited: String(r.entry.waited_seconds) } }, r.waitedText),
    r.preview ? h('span', { class: 'arow-preview', dataset: { preview: '1' } }, r.preview) : null,
  );
}

function render(s: AlarmState): Node {
  const snap = s.snapshot;
  if (!snap) return h('div', { class: 'alarm' }, h('div', { class: 'alarm-h', dataset: { key: 'header' } }, icon(IC.clock, 16), t('app.loading')));
  const now = Date.now();
  const rows = deriveAlarmRows(snap, now);
  return h(
    'div',
    { class: 'alarm', role: 'alertdialog', 'aria-label': headerTitle(snap, now) },
    h(
      'div',
      { class: 'alarm-h', dataset: { key: 'header' } },
      icon(IC.clock, 16),
      h('span', { dataset: { alarmTitle: '1' } }, headerTitle(snap, now)),
      hasL4(snap) ? h('span', { class: 'chip l4' }, t('alarm.l4')) : null,
      h('span', { class: 'sp' }),
      h('span', { class: 'alarm-th', dataset: { alarmThreshold: '1' } }, thresholdText(snap)),
      rows.length > 1 ? h('button', { class: 'alarm-h-btn', disabled: s.busy === 'all', dataset: { fid: 'hide-all', act: 'hide-all' }, onclick: hideAll }, t('alarm.hideAll')) : null,
    ),
    snap.reconciling ? h('div', { class: 'notice-box warn flat', dataset: { alarmBanner: 'reconciling' } }, t('alarm.reconciling')) : null,
    !snap.settings.enabled ? h('div', { class: 'notice-box info flat' }, t('alarm.disabled')) : null,
    s.notice ? h('div', { class: 'notice-box info flat', role: 'status', dataset: { alarmNotice: '1' } }, s.notice) : null,
    h(
      'div',
      { class: 'alarm-list', dataset: { keepScroll: 'alarm' } },
      h(
        'div',
        { class: 'alarm-rows', dataset: { key: 'rows' } },
        rows.map((r) => renderRow(r, s)),
        rows.length === 0 ? h('div', { class: 'empty', style: { margin: '12px' } }, t('alarm.empty')) : null,
      ),
    ),
    !snap.clock_trusted ? h('div', { class: 'notice-box warn flat', dataset: { alarmBanner: 'clock' } }, t('alarm.clockUntrusted')) : null,
  );
}

subscribeBatched(store, (s) => rerender(root, () => render(s), { morph: true }));
rerender(root, () => render(store.get()), { morph: true });

let reportedHeight = 0;
/** Asks the host for exactly the rendered height; the list scrolls past its cap. Rerenders run first. */
function fitWindow(): void {
  const list = root?.querySelector<HTMLElement>('.alarm-list');
  const rows = list?.querySelector<HTMLElement>('.alarm-rows');
  if (!list || !rows || !list.parentElement) return;
  let height = 0;
  for (const el of Array.from(list.parentElement.children)) height += el === list ? rows.offsetHeight : (el as HTMLElement).offsetHeight;
  if (height === reportedHeight) return;
  reportedHeight = height;
  void ipc.invoke(NotifyCommands.ALARM_RESIZE, { height }).catch(() => undefined);
}
subscribeBatched(store, fitWindow);

// subscribe-first, then snapshot; a malformed event payload is dropped, never rendered
ipc.listen<unknown>(Events.ALARM_SNAPSHOT, guarded(Events.ALARM_SNAPSHOT, isAlarmSnapshot, (snap) => store.patch({ snapshot: snap })));
void refresh();

exposeForTests(sel, { __vbkStore: store });
