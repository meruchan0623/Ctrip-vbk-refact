import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALLOWED_T1_SECONDS, DEFAULT_REMINDER_SETTINGS } from '../../packages/ipc/src/contracts.ts';
import { Events, NotifyCommands, PrefsCommands } from '../../packages/ipc/src/commands.ts';
import { UiCommands } from '../../packages/ipc/src/client.ts';
import type { PrefsSnapshot } from '../../packages/ipc/src/client.ts';
import { createMockIpc } from '../../packages/ipc/src/mock.ts';
import { EMPTY_TSIM_FORM, SECTIONS, SPY_LOCK_MS, isAllowedT1, pickActiveSection, prefsCommand, reminderCommand, tsimFormValid, validateReminderSettings } from './viewmodel.ts';

test('T1 validation follows ALLOWED_T1_SECONDS', () => {
  for (const v of ALLOWED_T1_SECONDS) assert.equal(isAllowedT1(v), true);
  assert.equal(isAllowedT1(45), false);
  assert.equal(isAllowedT1(0), false);
  assert.deepEqual(validateReminderSettings(DEFAULT_REMINDER_SETTINGS), []);
  assert.deepEqual(validateReminderSettings({ ...DEFAULT_REMINDER_SETTINGS, t1_seconds: 31 }), ['t1_seconds']);
  assert.deepEqual(validateReminderSettings({ ...DEFAULT_REMINDER_SETTINGS, continuous_l4: 'yes' as unknown as boolean }), ['continuous_l4']);
});

test('reminder settings map to notify commands; others to prefs', () => {
  assert.deepEqual(reminderCommand('enabled', false), { cmd: NotifyCommands.SET_ENABLED, payload: { enabled: false } });
  assert.deepEqual(reminderCommand('t1_seconds', 90), { cmd: NotifyCommands.SET_THRESHOLD, payload: { t1_seconds: 90 } });
  assert.throws(() => reminderCommand('t1_seconds', 45), RangeError);
  assert.deepEqual(reminderCommand('timeout_sound', true), { cmd: NotifyCommands.SET_SOUND_ENABLED, payload: { enabled: true } });
  assert.deepEqual(reminderCommand('continuous_l4', true), { cmd: UiCommands.PREFS_SET, payload: { section: 'reminder', key: 'continuous_l4', value: true } });
  assert.deepEqual(prefsCommand('assistant', 'send_mode', 'send_direct'), { cmd: UiCommands.PREFS_SET, payload: { section: 'assistant', key: 'send_mode', value: 'send_direct' } });
  assert.equal(SECTIONS.length, 9);
  assert.equal(SECTIONS[SECTIONS.length - 1]?.id, 'about');
  assert.equal(tsimFormValid(EMPTY_TSIM_FORM), false);
  assert.equal(tsimFormValid({ user: 'u', password: 'p' }), true);
});

test('mock prefs: typed set, unknown key rejected, notify threshold validated', async () => {
  const ipc = createMockIpc('default', { tick: false, latency: 0 });
  const p0 = await ipc.invoke<PrefsSnapshot>(PrefsCommands.SNAPSHOT);
  assert.equal(p0.assistant.send_mode, 'replace_draft');
  const p1 = await ipc.invoke<PrefsSnapshot>(UiCommands.PREFS_SET, { section: 'assistant', key: 'send_mode', value: 'send_direct' });
  assert.equal(p1.assistant.send_mode, 'send_direct');
  await assert.rejects(ipc.invoke(UiCommands.PREFS_SET, { section: 'assistant', key: 'nope', value: 1 }), (e: { code: string }) => e.code === 'prefs.unknown_key');
  await assert.rejects(ipc.invoke(UiCommands.PREFS_SET, { section: 'assistant', key: 'enabled', value: 'yes' }), (e: { code: string }) => e.code === 'prefs.bad_type');
  await ipc.invoke(NotifyCommands.SET_THRESHOLD, { t1_seconds: 120 });
  const p2 = await ipc.invoke<PrefsSnapshot>(PrefsCommands.SNAPSHOT);
  assert.equal(p2.reminder.t1_seconds, 120);
  await assert.rejects(ipc.invoke(UiCommands.ASSIST_TSIM_LOGIN, { user: 'demo', password: 'wrong' }));
  const ts = await ipc.invoke<{ logged_in: boolean; user: string; session_epoch: number }>(UiCommands.ASSIST_TSIM_LOGIN, { user: 'demo', password: 'ok' });
  assert.deepEqual(ts, { logged_in: true, user: 'demo', session_epoch: 3 });
  ipc.dispose();
});

test('every reminder toggle persists through the command the view-model picks (notify_set_* or prefs_set reminder.*)', async () => {
  const ipc = createMockIpc('default', { tick: false, latency: 0 });
  const alarmPushes: { settings: Record<string, unknown> }[] = [];
  ipc.listen<{ settings: Record<string, unknown> }>(Events.ALARM_SNAPSHOT, (s) => alarmPushes.push(s));
  const keys = ['continuous_l4', 'alert_during_dnd', 'alert_during_fullscreen', 'tray_flash', 'taskbar_badge'] as const;
  for (const key of keys) {
    const before = (await ipc.invoke<PrefsSnapshot>(PrefsCommands.SNAPSHOT)).reminder[key];
    const { cmd, payload } = reminderCommand(key, !before);
    assert.equal(cmd, UiCommands.PREFS_SET);
    await ipc.invoke(cmd, payload); // used to be rejected with prefs.use_notify → toggle silently reverted
    assert.equal((await ipc.invoke<PrefsSnapshot>(PrefsCommands.SNAPSHOT)).reminder[key], !before, `${key} persisted`);
    assert.equal(alarmPushes.at(-1)?.settings[key], !before, `${key} reaches the alarm snapshot`);
    await assert.rejects(ipc.invoke(cmd, { ...payload, value: 'yes' }), (e: { code: string }) => e.code === 'prefs.bad_type');
  }
  // the three alarm-core fields stay exclusive to notify_set_*
  for (const key of ['enabled', 't1_seconds', 'timeout_sound']) {
    await assert.rejects(ipc.invoke(UiCommands.PREFS_SET, { section: 'reminder', key, value: true }), (e: { code: string }) => e.code === 'prefs.use_notify');
  }
  await assert.rejects(ipc.invoke(UiCommands.PREFS_SET, { section: 'reminder', key: 'toString', value: 'x' }), (e: { code: string }) => e.code === 'prefs.unknown_key', 'inherited keys are not settings');
  ipc.dispose();
});

test('scroll-spy: ordinary scrolling follows the last section whose top passed the viewport edge', () => {
  const tops = [{ id: 'general', top: 0 }, { id: 'display', top: 400 }, { id: 'notify', top: 800 }, { id: 'about', top: 1500 }] as const;
  const base = { tops, clientHeight: 500, scrollHeight: 2000, now: 10_000, current: 'general', lock: null } as const;
  assert.equal(pickActiveSection({ ...base, scrollTop: 0 }), 'general');
  assert.equal(pickActiveSection({ ...base, scrollTop: 300 }), 'general');
  assert.equal(pickActiveSection({ ...base, scrollTop: 380 }), 'display'); // 400 - 24 offset
  assert.equal(pickActiveSection({ ...base, scrollTop: 900 }), 'notify');
  assert.equal(pickActiveSection({ ...base, scrollTop: 1200 }), 'notify');
  assert.equal(pickActiveSection({ ...base, tops: [], scrollTop: 100 }), 'general');
});

test('scroll-spy: reaching the bottom highlights the last section even when it is too short to reach the top', () => {
  const tops = [{ id: 'general', top: 0 }, { id: 'storage', top: 1000 }, { id: 'privacy', top: 1300 }, { id: 'about', top: 1450 }] as const;
  const base = { tops, clientHeight: 500, scrollHeight: 1600, now: 10_000, current: 'privacy', lock: null } as const;
  assert.equal(pickActiveSection({ ...base, scrollTop: 1000 }), 'storage');
  assert.equal(pickActiveSection({ ...base, scrollTop: 1099 }), 'about'); // 1099 + 500 >= 1598
  assert.equal(pickActiveSection({ ...base, scrollTop: 1100 }), 'about');
  // 内容放不满一屏：没有可滚动距离，保持当前高亮
  assert.equal(pickActiveSection({ ...base, scrollHeight: 500, scrollTop: 0, current: 'storage' }), 'storage');
});

test('scroll-spy: a click lock wins until it expires, then scrolling decides again', () => {
  const tops = [{ id: 'general', top: 0 }, { id: 'privacy', top: 1300 }, { id: 'about', top: 1450 }] as const;
  const base = { tops, clientHeight: 500, scrollHeight: 1600, scrollTop: 1100, current: 'privacy' } as const;
  const lock = { id: 'privacy', until: 11_000 } as const;
  // 滚动落在底部（本会高亮 about），但锁还在：保持被点的 privacy
  assert.equal(pickActiveSection({ ...base, now: 10_500, lock }), 'privacy');
  assert.equal(pickActiveSection({ ...base, now: 10_999, lock, scrollTop: 0 }), 'privacy');
  assert.equal(pickActiveSection({ ...base, now: 11_000, lock }), 'about');
  assert.equal(pickActiveSection({ ...base, now: 12_000, lock: null, scrollTop: 0 }), 'general');
  assert.ok(SPY_LOCK_MS > 0);
});


test('scheduled DND defaults off and toggles through persisted local preferences without changing timeout exception', async () => {
  const ipc = createMockIpc('default', { tick: false, latency: 0 });
  try {
    const before = await ipc.invoke<PrefsSnapshot>(PrefsCommands.SNAPSHOT);
    assert.equal(before.dnd.schedule_enabled, false);
    assert.equal(before.reminder.alert_during_dnd, true);
    for (const enabled of [true, true, false, true]) {
      const { cmd, payload } = prefsCommand('dnd', 'schedule_enabled', enabled);
      const saved = await ipc.invoke<PrefsSnapshot>(cmd, payload);
      assert.equal(saved.dnd.schedule_enabled, enabled);
      const read = await ipc.invoke<PrefsSnapshot>(PrefsCommands.SNAPSHOT);
      assert.equal(read.dnd.schedule_enabled, enabled);
      assert.equal(read.reminder.alert_during_dnd, true);
    }
  } finally { ipc.dispose(); }
});
