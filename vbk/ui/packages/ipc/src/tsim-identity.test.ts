import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMockIpc } from './mock.ts';
import { UiCommands, UiEvents, type UiTsimStatus } from './client.ts';

test('same-name login and logout publish distinct nonsecret TSim identity generations', async () => {
  const ipc = createMockIpc('default', { tick: false, latency: 0 });
  try {
    const events: UiTsimStatus[] = [];
    ipc.listen<UiTsimStatus>(UiEvents.TSIM_STATUS, value => events.push(value));
    const before = await ipc.invoke<UiTsimStatus>(UiCommands.ASSIST_TSIM_STATUS);
    const first = await ipc.invoke<UiTsimStatus>(UiCommands.ASSIST_TSIM_LOGIN, { user: 'synthetic-user', password: 'synthetic-password' });
    const out = await ipc.invoke<UiTsimStatus>(UiCommands.ASSIST_TSIM_LOGOUT);
    const second = await ipc.invoke<UiTsimStatus>(UiCommands.ASSIST_TSIM_LOGIN, { user: 'synthetic-user', password: 'synthetic-password' });
    assert.ok(first.logged_in && second.logged_in); assert.equal(out.logged_in, false);
    assert.ok(before.session_epoch < first.session_epoch && first.session_epoch < out.session_epoch && out.session_epoch < second.session_epoch);
    assert.deepEqual(events.at(-1), second);
    assert.equal(JSON.stringify(events).includes('synthetic-password'), false);
  } finally { ipc.dispose(); }
});
