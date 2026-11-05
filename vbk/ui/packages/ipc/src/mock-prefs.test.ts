import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockIpc } from './mock.ts';
import { UiCommands, type PrefsSnapshot } from './client.ts';
import { Events, PrefsCommands } from './commands.ts';
import { DEFAULT_REMINDER_SETTINGS } from './contracts.ts';

test('mock preference defaults match the host defaults in src-tauri/src/prefs.rs (TSim fields are demo values)', async () => {
  const ipc = createMockIpc('default', { latency: 0, tick: false });
  try {
    const snap = await ipc.invoke<PrefsSnapshot>(PrefsCommands.SNAPSHOT);
    const { tsim_logged_in: _loggedIn, tsim_user: _user, ...assistant } = snap.assistant;
    assert.deepEqual({ ...snap, assistant }, {
      reminder: DEFAULT_REMINDER_SETTINGS,
      general: { autostart: false, close_action: 'tray', show_msg_time: true },
      display: { zoom: 100 },
      keys: { send_key: 'enter', toggle_main: 'Ctrl+Alt+V' },
      assistant: { enabled: true, outbound_translation: true, send_mode: 'replace_draft', package_quick_view: true },
      dnd: { schedule_enabled: false, follow_system: false },
      network: { system_proxy: true },
      notice_banner: { accounts: {} },
    });
    for (const gone of ['storage', 'privacy']) assert.equal(gone in snap, false, gone);
  } finally { ipc.dispose(); }
});

test('mock rejects every removed preference as prefs.unknown_key without changing values or publishing events', async () => {
  const ipc = createMockIpc('default', { latency: 0, tick: false });
  try {
    const events: unknown[] = [];
    ipc.listen(Events.PREFS_CHANGED, value => events.push(value));
    ipc.listen(Events.ALARM_SNAPSHOT, value => events.push(value));
    const before = await ipc.invoke<PrefsSnapshot>(PrefsCommands.SNAPSHOT);
    for (const [section, key, value] of [
      ['general', 'start_hidden', true], ['general', 'spell_check', false], ['display', 'gpu', false],
      ['storage', 'cache_days', 30], ['storage', 'cache_mb', 0], ['privacy', 'analytics', true], ['privacy', 'crash_upload', true],
      ['keys', 'screenshot', 'Ctrl+Shift+S'],
    ] as const) {
      await assert.rejects(ipc.invoke(UiCommands.PREFS_SET, { section, key, value }),
        (error: { code?: string }) => error.code === 'prefs.unknown_key', `${section}.${key}`);
      assert.deepEqual(await ipc.invoke(PrefsCommands.SNAPSHOT), before);
      assert.deepEqual(events, []);
    }
  } finally { ipc.dispose(); }
});

test('mock keeps supported schedule, follow-system, zoom, shortcut, autostart and proxy writes working', async () => {
  const ipc = createMockIpc('default', { latency: 0, tick: false });
  try {
    const events: PrefsSnapshot[] = [];
    ipc.listen<PrefsSnapshot>(Events.PREFS_CHANGED, value => events.push(value));
    const writes = [
      ['dnd', 'schedule_enabled', true], ['dnd', 'follow_system', true], ['display', 'zoom', 125], ['keys', 'send_key', 'ctrl_enter'],
      ['keys', 'toggle_main', 'Ctrl+Alt+M'], ['general', 'autostart', true], ['general', 'show_msg_time', false], ['network', 'system_proxy', false],
    ] as const;
    for (const [section, key, value] of writes) {
      const result = await ipc.invoke<PrefsSnapshot>(UiCommands.PREFS_SET, { section, key, value });
      assert.equal((result[section] as Readonly<Record<string, unknown>>)[key], value, `${section}.${key}`);
      assert.deepEqual(await ipc.invoke(PrefsCommands.SNAPSHOT), result);
      assert.deepEqual(events.at(-1), result);
    }
    assert.equal(events.length, writes.length);
  } finally { ipc.dispose(); }
});
