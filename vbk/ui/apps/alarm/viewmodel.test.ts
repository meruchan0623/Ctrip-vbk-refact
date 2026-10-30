import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AlarmEntry, AlarmSnapshot } from '../../packages/ipc/src/contracts.ts';
import { DEFAULT_REMINDER_SETTINGS, ErrorCodes, RED_AFTER_SECONDS } from '../../packages/ipc/src/contracts.ts';
import { Events, NotifyCommands } from '../../packages/ipc/src/commands.ts';
import { createMockIpc } from '../../packages/ipc/src/mock.ts';
import { SNOOZE_OPTIONS, acceptsSnapshotResponse, deriveAlarmRows, entryCommand, headerTitle, hideAllCommand, thresholdText } from './viewmodel.ts';

const acc = { account_id: 'a', environment: 'production', session_generation: 2 };
const now = 1_700_000_000_000;

function entry(gid: string, waited: number, extra: Partial<AlarmEntry> = {}): AlarmEntry {
  return { account: acc, gid, round_id: `r-${gid}`, version: 1, label: `客户${gid}`, waiting_since_ms: now - waited * 1000, waited_seconds: waited, level: 'L3', start_confirmed: true, snoozed_until_ms: null, ...extra };
}

function snap(entries: AlarmEntry[], extra: Partial<AlarmSnapshot> = {}): AlarmSnapshot {
  return { generated_at_ms: now, clock_trusted: true, reconciling: false, settings: { ...DEFAULT_REMINDER_SETTINGS }, entries, ...extra };
}

test('alarm rows: red threshold, 待核对, snoozed, sorted by waited desc with snoozed last', () => {
  const s = snap([
    entry('a', 45),
    entry('b', RED_AFTER_SECONDS, { version: 3 }),
    entry('c', 33, { start_confirmed: false, waiting_since_ms: null }),
    entry('d', 200, { snoozed_until_ms: now + 60_000 }),
    entry('e', RED_AFTER_SECONDS - 1),
    entry('f', 500, { snoozed_until_ms: now - 1 }), // snooze expired → active again
  ]);
  const rows = deriveAlarmRows(s, now);
  assert.deepEqual(rows.map((r) => r.entry.gid), ['f', 'b', 'e', 'a', 'c', 'd']);
  const byGid = Object.fromEntries(rows.map((r) => [r.entry.gid, r]));
  assert.equal(byGid['b']?.red, true);
  assert.equal(byGid['e']?.red, false);
  assert.equal(byGid['c']?.pending, true);
  assert.equal(byGid['a']?.pending, false);
  assert.equal(byGid['d']?.snoozed, true);
  assert.equal(byGid['f']?.snoozed, false);
  assert.equal(byGid['b']?.waitedText, '1分30秒');
  assert.equal(byGid['a']?.waitedText, '45秒');
  assert.equal(headerTitle(s, now), '5 个回复超时提醒');
  assert.equal(thresholdText(s), '阈值 30 秒');
});

test('entry commands echo account/gid/round_id/version from the snapshot', () => {
  const e = entry('g', 10, { version: 7 });
  assert.deepEqual(entryCommand(e, { kind: 'hide' }), { cmd: NotifyCommands.HIDE_ROUND, payload: { account: acc, gid: 'g', round_id: 'r-g', version: 7 } });
  assert.deepEqual(entryCommand(e, { kind: 'snooze', minutes: 10 }).payload, { account: acc, gid: 'g', round_id: 'r-g', version: 7, minutes: 10 });
  assert.equal(entryCommand(e, { kind: 'open' }).cmd, NotifyCommands.OPEN_CONVERSATION);
  assert.deepEqual(hideAllCommand(snap([e, entry('h', 5)])), { cmd: NotifyCommands.HIDE_ALL, payload: { seen: [{ gid: 'g', round_id: 'r-g', version: 7 }, { gid: 'h', round_id: 'r-h', version: 1 }] } });
});

test('snooze menu offers exactly 5/10/30 minutes and the red threshold is inclusive at 90 s', () => {
  assert.deepEqual(SNOOZE_OPTIONS.map((o) => o.minutes), [5, 10, 30]);
  assert.equal(RED_AFTER_SECONDS, 90);
  const rows = deriveAlarmRows(snap([entry('x', 90), entry('y', 89)]), now);
  assert.deepEqual(rows.map((r) => [r.entry.gid, r.red]), [['x', true], ['y', false]]);
});

test('hide_all echoes exactly the versions currently displayed (snoozed rows included, nothing else)', () => {
  const s = snap([entry('a', 45, { version: 2 }), entry('b', 200, { version: 9, snoozed_until_ms: now + 60_000 })]);
  const shown = deriveAlarmRows(s, now).map((r) => ({ gid: r.entry.gid, round_id: r.entry.round_id, version: r.entry.version }));
  const { payload } = hideAllCommand(s);
  assert.deepEqual([...payload.seen].sort((x, y) => x.gid.localeCompare(y.gid)), [...shown].sort((x, y) => x.gid.localeCompare(y.gid)));
  assert.ok(payload.seen.every((x) => !('account' in x) && Object.keys(x).length === 3), 'seen entries carry only gid/round_id/version');
});

test('a notify_snapshot response older than the snapshot pushed meanwhile is ignored (subscribe-first race)', async () => {
  const older = snap([entry('a', 10)], { generated_at_ms: now - 500 });
  const newer = snap([entry('a', 11)], { generated_at_ms: now });
  assert.equal(acceptsSnapshotResponse(null, older), true, 'first snapshot always applies');
  assert.equal(acceptsSnapshotResponse(newer, older), false, 'late response must not overwrite the event');
  assert.equal(acceptsSnapshotResponse(older, newer), true);
  assert.equal(acceptsSnapshotResponse(newer, newer), true, 'same generation is accepted (idempotent)');
  // end-to-end with the mock: an event delivered while `notify_snapshot` is in flight is never lost
  const ipc = createMockIpc('default', { tick: false, latency: 20 });
  let current: AlarmSnapshot | null = null;
  const seen: number[] = [];
  ipc.listen<AlarmSnapshot>(Events.ALARM_SNAPSHOT, (s) => {
    current = s;
    seen.push(s.entries.length);
  });
  const pending = ipc.invoke<AlarmSnapshot>(NotifyCommands.SNAPSHOT);
  ipc.tick(1); // arrives before the response
  assert.deepEqual(seen, [3]);
  const response = await pending;
  if (acceptsSnapshotResponse(current, response)) current = response;
  const cur = current as AlarmSnapshot | null;
  assert.ok(cur);
  assert.ok(cur.generated_at_ms >= response.generated_at_ms, 'displayed snapshot is never older than the response');
  ipc.dispose();
});

test('mock notify: version mismatch rejected, snooze bumps version, subscribe-first order delivers ticks', async () => {
  const ipc = createMockIpc('default', { tick: false, latency: 0 });
  const seen: AlarmSnapshot[] = [];
  const off = ipc.listen<AlarmSnapshot>(Events.ALARM_SNAPSHOT, (s) => seen.push(s));
  const s0 = await ipc.invoke<AlarmSnapshot>(NotifyCommands.SNAPSHOT);
  assert.equal(s0.entries.length, 3);
  const target = s0.entries.find((e) => e.gid === 'g-demo-2');
  assert.ok(target);
  await assert.rejects(
    ipc.invoke(NotifyCommands.HIDE_ROUND, { account: target.account, gid: target.gid, round_id: target.round_id, version: target.version + 1 }),
    (e: { code: string }) => e.code === ErrorCodes.NOTIFY_ROUND_VERSION_MISMATCH,
  );
  await ipc.invoke(NotifyCommands.SNOOZE, { account: target.account, gid: target.gid, round_id: target.round_id, version: target.version, minutes: 5 });
  const s1 = seen.at(-1);
  assert.ok(s1);
  const snoozed = s1.entries.find((e) => e.gid === 'g-demo-2');
  assert.equal(snoozed?.version, target.version + 1);
  assert.ok((snoozed?.snoozed_until_ms ?? 0) > s1.generated_at_ms);
  // the old version is now stale
  await assert.rejects(ipc.invoke(NotifyCommands.HIDE_ROUND, { account: target.account, gid: target.gid, round_id: target.round_id, version: target.version }));
  await ipc.invoke(NotifyCommands.HIDE_ROUND, { account: target.account, gid: target.gid, round_id: target.round_id, version: target.version + 1 });
  assert.equal(seen.at(-1)?.entries.length, 2);
  ipc.tick(1);
  assert.equal(seen.at(-1)?.entries.every((e) => e.waited_seconds > 0), true);
  await assert.rejects(ipc.invoke(NotifyCommands.SET_THRESHOLD, { t1_seconds: 45 }), (e: { code: string }) => e.code === 'notify.bad_threshold');
  off();
  ipc.dispose();
});

test('selected row: picked row while listed, else the first (longest-waiting active) row', async () => {
  const { selectedRow } = await import('./viewmodel.ts');
  const rows = deriveAlarmRows(snap([entry('a', 45), entry('b', 120), entry('c', 300, { snoozed_until_ms: now + 60_000 })]), now);
  assert.equal(selectedRow(rows, null)?.entry.gid, 'b');
  assert.equal(selectedRow(rows, rows[1]?.key ?? null)?.entry.gid, 'a');
  assert.equal(selectedRow(rows, 'gone')?.entry.gid, 'b');
  assert.equal(selectedRow([], null), null);
});

test('avatar colour is stable per conversation and from the palette', async () => {
  const { avatarColor, AVATAR_COLORS } = await import('./viewmodel.ts');
  assert.equal(avatarColor('g-1'), avatarColor('g-1'));
  assert.ok(AVATAR_COLORS.includes(avatarColor('anything')));
  assert.ok(AVATAR_COLORS.includes(avatarColor('')));
});
