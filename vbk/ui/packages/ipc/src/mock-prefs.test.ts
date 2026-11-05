import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockIpc } from './mock.ts';
import { UiCommands, type PrefsSnapshot } from './client.ts';
import { Events, PrefsCommands } from './commands.ts';

test('mock rejects each unsupported runtime preference without changing old readable values or publishing events', async () => {
  const ipc = createMockIpc('default', { latency: 0, tick: false });
  try {
    const events: unknown[] = [];
    ipc.listen(Events.PREFS_CHANGED, value => events.push(value));
    ipc.listen(Events.ALARM_SNAPSHOT, value => events.push(value));
    const before = await ipc.invoke<PrefsSnapshot>(PrefsCommands.SNAPSHOT);
    assert.deepEqual({ gpu: before.display.gpu, follow: before.dnd.follow_system, days: before.storage.cache_days, mb: before.storage.cache_mb }, { gpu: true, follow: true, days: 90, mb: 236 });
    for (const [section, key, value] of [
      ['display', 'gpu', false], ['dnd', 'follow_system', false], ['storage', 'cache_days', 30], ['storage', 'cache_mb', 0],
    ] as const) {
      await assert.rejects(ipc.invoke(UiCommands.PREFS_SET, { section, key, value }),
        error => { assert.deepEqual(error, { code: 'host.unsupported', message: 'unsupported preference runtime', retryable: false }); return true; });
      assert.deepEqual(await ipc.invoke(PrefsCommands.SNAPSHOT), before);
      assert.deepEqual(events, []);
    }
  } finally { ipc.dispose(); }
});

test('mock keeps supported schedule, zoom, shortcuts and autostart writes working', async () => {
  const ipc = createMockIpc('default', { latency: 0, tick: false });
  try {
    const events: PrefsSnapshot[] = [];
    ipc.listen<PrefsSnapshot>(Events.PREFS_CHANGED, value => events.push(value));
    for (const [section, key, value] of [
      ['dnd', 'schedule_enabled', true], ['display', 'zoom', 125], ['keys', 'send_key', 'ctrl_enter'],
      ['keys', 'toggle_main', 'Ctrl + Alt + M'], ['general', 'autostart', true],
    ] as const) {
      const result = await ipc.invoke<PrefsSnapshot>(UiCommands.PREFS_SET, { section, key, value });
      assert.equal((result[section] as Readonly<Record<string, unknown>>)[key], value);
      assert.deepEqual(await ipc.invoke(PrefsCommands.SNAPSHOT), result);
      assert.deepEqual(events.at(-1), result);
    }
    assert.equal(events.length, 5);
    await assert.rejects(ipc.invoke(UiCommands.PREFS_SET, { section: 'keys', key: 'screenshot', value: 'Ctrl + Shift + S' }), (error: { code?: string }) => error.code === 'prefs.unknown_key');
  } finally { ipc.dispose(); }
});
