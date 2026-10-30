import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_REMINDER_SETTINGS } from '../../packages/ipc/src/contracts.ts';
import type { AlarmSnapshot } from '../../packages/ipc/src/contracts.ts';
import { Events, NotifyCommands, PrefsCommands, AccountCommands } from '../../packages/ipc/src/commands.ts';
import { UiCommands, UiEvents } from '../../packages/ipc/src/client.ts';
import { createMockIpc } from '../../packages/ipc/src/mock.ts';
import { guarded, isAlarmSnapshot, isClockReading, isPrefsSnapshot, isToastPayload, isUiAccountSnapshot, isUiAgentStatus, isUiConversation, isUiMessage, isUiNetStatus } from './guards.ts';

const acc = { account_id: 'a', environment: 'production', session_generation: 1 };
const GARBAGE: unknown[] = [null, undefined, 0, 1, '', 'garbage', true, [], {}, { entries: null }, { entries: 'x' }, { accounts: 'x' }, { text: 1 }, { quality: null }];

test('alarm snapshot guard accepts the mock snapshot and rejects garbage / partial entries', async () => {
  const ipc = createMockIpc('default', { tick: false, latency: 0 });
  const snap = await ipc.invoke<AlarmSnapshot>(NotifyCommands.SNAPSHOT);
  assert.equal(isAlarmSnapshot(snap), true);
  assert.equal(isAlarmSnapshot({ ...snap, entries: [] }), true);
  for (const g of GARBAGE) assert.equal(isAlarmSnapshot(g), false, `garbage ${JSON.stringify(g)}`);
  const e0 = snap.entries[0];
  assert.ok(e0);
  assert.equal(isAlarmSnapshot({ ...snap, entries: [{ ...e0, version: '3' }] }), false, 'version must be a number');
  assert.equal(isAlarmSnapshot({ ...snap, entries: [{ ...e0, label: null }] }), false, 'label must be a string');
  assert.equal(isAlarmSnapshot({ ...snap, entries: [{ ...e0, account: null }] }), false, 'account context required');
  assert.equal(isAlarmSnapshot({ ...snap, entries: [{ ...e0, snoozed_until_ms: 'soon' }] }), false);
  assert.equal(isAlarmSnapshot({ ...snap, settings: { t1_seconds: 30 } }), false, 'settings must carry booleans');
  assert.equal(isAlarmSnapshot({ generated_at_ms: 1, clock_trusted: true, reconciling: false, settings: { ...DEFAULT_REMINDER_SETTINGS }, entries: [] }), true);
  ipc.dispose();
});

test('main-window payload guards accept mock payloads and reject garbage', async () => {
  const ipc = createMockIpc('default', { tick: false, latency: 0 });
  const accounts = await ipc.invoke<unknown>(AccountCommands.SNAPSHOT);
  assert.equal(isUiAccountSnapshot(accounts), true);
  const convs = await ipc.invoke<unknown[]>(UiCommands.IM_CONVERSATIONS, { account: { ...acc, account_id: 'acc-demo-a', session_generation: 3 } });
  assert.ok(convs.length > 0);
  for (const c of convs) assert.equal(isUiConversation(c), true);
  const msgs = await ipc.invoke<unknown[]>(UiCommands.IM_MESSAGES, { account: { ...acc, account_id: 'acc-demo-a', session_generation: 3 }, gid: 'g-demo-1' });
  for (const m of msgs) assert.equal(isUiMessage(m), true);
  assert.equal(isPrefsSnapshot(await ipc.invoke(PrefsCommands.SNAPSHOT)), true);
  assert.equal(isUiNetStatus(await ipc.invoke(UiCommands.NET_STATUS, {})), true);
  assert.equal(isUiAgentStatus({ status: 'online', confirmed: false }), true);
  assert.equal(isClockReading({ server_now_ms: 1, monotonic_ms: 0, quality: { kind: 'stale' } }), true);
  assert.equal(isToastPayload({ text: 'x' }), true);
  for (const g of GARBAGE) {
    assert.equal(isUiAccountSnapshot(g), false, `account ${JSON.stringify(g)}`);
    assert.equal(isUiConversation(g), false, `conv ${JSON.stringify(g)}`);
    assert.equal(isUiMessage(g), false, `msg ${JSON.stringify(g)}`);
    assert.equal(isPrefsSnapshot(g), false, `prefs ${JSON.stringify(g)}`);
    assert.equal(isUiNetStatus(g), false);
    assert.equal(isUiAgentStatus(g), false);
    assert.equal(isClockReading(g), false);
    assert.equal(isToastPayload(g), false);
  }
  const c0 = convs[0] as Record<string, unknown>;
  assert.equal(isUiConversation({ ...c0, customer_tags: 'vip' }), false, 'customer_tags must be a string array');
  assert.equal(isUiConversation({ ...c0, account: { account_id: 'a' } }), false, 'account context must be complete');
  assert.equal(isUiConversation({ ...c0, order: { product: 'p' } }), false, 'order needs order_id');
  const m0 = msgs[0] as Record<string, unknown>;
  assert.equal(isUiMessage({ ...m0, text: null }), false);
  assert.equal(isUiMessage({ ...m0, disposition: 'confirmed' }), false);
  ipc.dispose();
});

test('guarded() drops malformed payloads without throwing and still delivers good ones', () => {
  const seen: string[] = [];
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (m: unknown) => void warnings.push(String(m));
  try {
    const h = guarded(UiEvents.TOAST, isToastPayload, (p) => seen.push(p.text));
    for (const g of GARBAGE) assert.doesNotThrow(() => h(g));
    h({ text: 'ok' });
    assert.deepEqual(seen, ['ok']);
    assert.equal(warnings.length, GARBAGE.length);
    // the mock delivers to every listener even when one of them receives garbage
    const ipc = createMockIpc('default', { tick: false, latency: 0 });
    const got: unknown[] = [];
    ipc.listen(Events.ALARM_SNAPSHOT, guarded(Events.ALARM_SNAPSHOT, isAlarmSnapshot, (s) => got.push(s)));
    ipc.listen(Events.ALARM_SNAPSHOT, (p) => got.push(['raw', p]));
    assert.doesNotThrow(() => ipc.emit(Events.ALARM_SNAPSHOT, null));
    assert.deepEqual(got, [['raw', null]]);
    ipc.dispose();
  } finally {
    console.warn = origWarn;
  }
});
