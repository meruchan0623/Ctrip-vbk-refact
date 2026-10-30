import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AlarmEntry, AlarmSnapshot } from '../../packages/ipc/src/contracts.ts';
import { DEFAULT_REMINDER_SETTINGS, ErrorCodes, RED_AFTER_SECONDS } from '../../packages/ipc/src/contracts.ts';
import { Events, NotifyCommands } from '../../packages/ipc/src/commands.ts';
import { createMockIpc } from '../../packages/ipc/src/mock.ts';
import { deriveAlarmRows, entryCommand, headerTitle, hideAllCommand, thresholdText } from './viewmodel.ts';

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
