import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALLOWED_T1_SECONDS, DEFAULT_REMINDER_SETTINGS } from '../../packages/ipc/src/contracts.ts';
import { Events, NotifyCommands, PrefsCommands } from '../../packages/ipc/src/commands.ts';
import { UiCommands } from '../../packages/ipc/src/client.ts';
import type { PrefsSnapshot } from '../../packages/ipc/src/client.ts';
import { createMockIpc } from '../../packages/ipc/src/mock.ts';
import { EMPTY_TSIM_FORM, SECTIONS, isAllowedT1, prefsCommand, reminderCommand, sendModeDescription, tsimFormValid, validateReminderSettings } from './viewmodel.ts';

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
  assert.equal(SECTIONS.length, 8);
  assert.match(sendModeDescription('replace_draft'), /替换草稿/);
  assert.match(sendModeDescription('send_direct'), /直接发送/);
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
  const ts = await ipc.invoke<{ logged_in: boolean; user: string }>(UiCommands.ASSIST_TSIM_LOGIN, { user: 'demo', password: 'ok' });
  assert.deepEqual(ts, { logged_in: true, user: 'demo' });
  ipc.dispose();
});

test('every reminder toggle persists through the command the view-model picks (notify_set_* or prefs_set reminder.*)', async () => {
  const ipc = createMockIpc('default', { tick: false, latency: 0 });
  const alarmPushes: { settings: Record<string, unknown> }[] = [];
  ipc.listen<{ settings: Record<string, unknown> }>(Events.ALARM_SNAPSHOT, (s) => alarmPushes.push(s));
  const keys = ['continuous_l4', 'position_bottom_right', 'alert_during_dnd', 'alert_during_fullscreen', 'tray_flash', 'taskbar_badge'] as const;
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
