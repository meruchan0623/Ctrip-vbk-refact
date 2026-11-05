import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALLOWED_T1_SECONDS, DEFAULT_REMINDER_SETTINGS } from '../../packages/ipc/src/contracts.ts';
import { Events, NotifyCommands, PrefsCommands } from '../../packages/ipc/src/commands.ts';
import { UiCommands } from '../../packages/ipc/src/client.ts';
import type { PrefsSnapshot, UiAccount, UiAccountSnapshot } from '../../packages/ipc/src/client.ts';
import { createMockIpc } from '../../packages/ipc/src/mock.ts';
import { EMPTY_TSIM_FORM, SECTIONS, SECTION_GROUPS, SPY_LOCK_MS, accountKey, accountOptionLabel, isAllowedT1, isSectionId, loggedInAccounts, pickActiveSection, pickQuickReplyAccount, prefsCommand, reminderCommand, sectionLabel, sectionNeedsPrefs, tsimFormValid, validateReminderSettings } from './viewmodel.ts';

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
  assert.equal(SECTIONS.length, 6);
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

test('sections: two nav groups in page order, account business first; legacy ids are no longer sections', () => {
  assert.deepEqual(SECTIONS.map((s) => s.id), ['quick_replies', 'general', 'notify', 'keys', 'assistant', 'about']);
  assert.deepEqual(SECTION_GROUPS.map((g) => g.id), ['account', 'desktop']);
  assert.deepEqual(SECTIONS.filter((s) => s.group === 'account').map((s) => s.id), ['quick_replies']);
  // each group's entries are contiguous and follow SECTION_GROUPS order, so nav order equals page order
  assert.deepEqual(SECTION_GROUPS.flatMap((g) => SECTIONS.filter((s) => s.group === g.id)), SECTIONS);
  for (const s of [...SECTIONS, ...SECTION_GROUPS]) assert.ok(sectionLabel(s).length > 0, s.id);
  for (const id of SECTIONS.map((s) => s.id)) assert.equal(isSectionId(id), true, id);
  for (const legacy of ['display', 'network', 'storage', 'privacy', 'quickReplies', '']) assert.equal(isSectionId(legacy), false, legacy);
  // only the desktop sections wait for the preferences snapshot
  assert.deepEqual(SECTIONS.filter((s) => !sectionNeedsPrefs(s.id)).map((s) => s.id), ['quick_replies']);
});

function account(id: string, state: UiAccount['state'], generation = 1, extra: Partial<UiAccount> = {}): UiAccount {
  return { context: { account_id: id, environment: 'synthetic', session_generation: generation }, nick: `nick-${id}`, remark: null, party: 'p', color: '#000', state, unread: 0, ...extra };
}

test('quick-reply account picker lists only logged-in accounts and follows the preferred account through logout / new generations', () => {
  const snap = (accounts: UiAccount[]): UiAccountSnapshot => ({ accounts, active_account_id: null, max_accounts: 5 });
  const a = account('a', 'online'), b = account('b', 'online'), c = account('c', 'expired'), d = account('d', 'logging_in');
  assert.deepEqual(loggedInAccounts(snap([c, a, d, b])).map((x) => x.context.account_id), ['a', 'b']);
  assert.deepEqual(loggedInAccounts(snap([c, d])), []);
  // nothing chosen yet: the first logged-in account, adopted as the preference
  assert.deepEqual(pickQuickReplyAccount([a, b], null), { preferred: 'synthetic:a', account: a.context });
  assert.deepEqual(pickQuickReplyAccount([], null), { preferred: null, account: null });
  // keeps the preferred account and adopts its new generation
  const b2 = account('b', 'online', 7);
  assert.deepEqual(pickQuickReplyAccount([a, b2], 'synthetic:b'), { preferred: 'synthetic:b', account: b2.context });
  // the preferred account logged out: nothing bound, never silently another account; the preference stays
  assert.deepEqual(pickQuickReplyAccount([a], 'synthetic:b'), { preferred: 'synthetic:b', account: null });
  assert.deepEqual(pickQuickReplyAccount([], 'synthetic:b'), { preferred: 'synthetic:b', account: null });
  // back online with yet another generation: restored with that generation
  const b3 = account('b', 'online', 8);
  assert.deepEqual(pickQuickReplyAccount([a, b3], 'synthetic:b'), { preferred: 'synthetic:b', account: b3.context });
  // the same account_id in another environment is a different account
  assert.deepEqual(pickQuickReplyAccount([account('b', 'online', 1, { context: { account_id: 'b', environment: 'other', session_generation: 1 } })], 'synthetic:b'), { preferred: 'synthetic:b', account: null });
  // identity is environment + account_id, never the generation
  assert.equal(accountKey(b.context), accountKey(b2.context));
  assert.notEqual(accountKey(b.context), accountKey({ ...b.context, environment: 'other' }));
  assert.equal(accountOptionLabel(a), 'nick-a');
  assert.equal(accountOptionLabel(account('e', 'online', 1, { remark: '  ' })), 'nick-e');
  assert.equal(accountOptionLabel(account('e', 'online', 1, { remark: 'remark-e' })), 'remark-e');
});

test('scroll-spy: ordinary scrolling follows the last section whose top passed the viewport edge', () => {
  const tops = [{ id: 'quick_replies', top: 0 }, { id: 'general', top: 400 }, { id: 'notify', top: 800 }, { id: 'about', top: 1500 }] as const;
  const base = { tops, clientHeight: 500, scrollHeight: 2000, now: 10_000, current: 'quick_replies', lock: null } as const;
  assert.equal(pickActiveSection({ ...base, scrollTop: 0 }), 'quick_replies');
  assert.equal(pickActiveSection({ ...base, scrollTop: 300 }), 'quick_replies');
  assert.equal(pickActiveSection({ ...base, scrollTop: 380 }), 'general'); // 400 - 24 offset
  assert.equal(pickActiveSection({ ...base, scrollTop: 900 }), 'notify');
  assert.equal(pickActiveSection({ ...base, scrollTop: 1200 }), 'notify');
  assert.equal(pickActiveSection({ ...base, tops: [], scrollTop: 100 }), 'quick_replies');
});

test('scroll-spy: reaching the bottom highlights the last section even when it is too short to reach the top', () => {
  const tops = [{ id: 'general', top: 0 }, { id: 'keys', top: 1000 }, { id: 'assistant', top: 1300 }, { id: 'about', top: 1450 }] as const;
  const base = { tops, clientHeight: 500, scrollHeight: 1600, now: 10_000, current: 'assistant', lock: null } as const;
  assert.equal(pickActiveSection({ ...base, scrollTop: 1000 }), 'keys');
  assert.equal(pickActiveSection({ ...base, scrollTop: 1099 }), 'about'); // 1099 + 500 >= 1598
  assert.equal(pickActiveSection({ ...base, scrollTop: 1100 }), 'about');
  // 内容放不满一屏：没有可滚动距离，保持当前高亮
  assert.equal(pickActiveSection({ ...base, scrollHeight: 500, scrollTop: 0, current: 'keys' }), 'keys');
});

test('scroll-spy: a click lock wins until it expires, then scrolling decides again', () => {
  const tops = [{ id: 'general', top: 0 }, { id: 'assistant', top: 1300 }, { id: 'about', top: 1450 }] as const;
  const base = { tops, clientHeight: 500, scrollHeight: 1600, scrollTop: 1100, current: 'assistant' } as const;
  const lock = { id: 'assistant', until: 11_000 } as const;
  // 滚动落在底部（本会高亮 about），但锁还在：保持被点的 assistant
  assert.equal(pickActiveSection({ ...base, now: 10_500, lock }), 'assistant');
  assert.equal(pickActiveSection({ ...base, now: 10_999, lock, scrollTop: 0 }), 'assistant');
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
