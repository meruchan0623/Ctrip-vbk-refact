import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockIpc } from './mock.ts';
import { UiCommands, UiEvents, type UiTsimStatus } from './client.ts';
import { PrefsCommands } from './commands.ts';

test('session import has its real command name and mock never authenticates an arbitrary real-looking token', async () => {
  assert.equal(UiCommands.ASSIST_TSIM_IMPORT_SESSION, 'assistant_tsim_import_session');
  const ipc = createMockIpc('default', { tick: false, latency: 0 });
  try {
    const events: UiTsimStatus[] = []; ipc.listen<UiTsimStatus>(UiEvents.TSIM_STATUS, value => events.push(value));
    await assert.rejects(ipc.invoke(UiCommands.ASSIST_TSIM_IMPORT_SESSION, { access_token: 'eyJhbGciOiJIUzI1NiJ9.SYNTHETIC_REAL_LOOKING_SECRET.signature' }), error => {
      assert.equal(JSON.stringify(error).includes('SYNTHETIC_REAL_LOOKING_SECRET'), false); return true;
    });
    const before = await ipc.invoke<UiTsimStatus>(UiCommands.ASSIST_TSIM_STATUS);
    const status = await ipc.invoke<UiTsimStatus>(UiCommands.ASSIST_TSIM_IMPORT_SESSION, { access_token: 'SYNTHETIC_IMPORT_TOKEN', user: 'untrusted-claimed-user' });
    assert.ok(status.logged_in); assert.equal(status.user, 'synthetic-imported-user'); assert.ok(status.session_epoch > before.session_epoch);
    assert.equal(events[0]?.logged_in, false); assert.deepEqual(events.at(-1), status);
    const prefs = await ipc.invoke(PrefsCommands.SNAPSHOT);
    const wire = JSON.stringify({ status, events, prefs }); assert.equal(wire.includes('SYNTHETIC_IMPORT_TOKEN'), false); assert.equal(wire.includes('access_token'), false); assert.equal(wire.includes('untrusted-claimed-user'), false);
    await ipc.invoke(UiCommands.ASSIST_TSIM_LOGOUT, {}); assert.equal((await ipc.invoke<UiTsimStatus>(UiCommands.ASSIST_TSIM_STATUS)).logged_in, false);
  } finally { ipc.dispose(); }
});
