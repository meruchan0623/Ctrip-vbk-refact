import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALLOWED_T1_SECONDS, DEFAULT_REMINDER_SETTINGS } from '../../packages/ipc/src/contracts.ts';
import { NotifyCommands, PrefsCommands } from '../../packages/ipc/src/commands.ts';
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
