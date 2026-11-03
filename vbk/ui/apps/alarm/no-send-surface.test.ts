// I-10: the alarm window has no way to send a message. Three independent
// layers are pinned: (1) the page sources contain no text-entry element,
// (2) every command the alarm code can produce is in a closed set that has
// nothing to do with sending, (3) the alarm window's capability grants no
// send/finish/arbitrary-URL permission.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AlarmEntry, AlarmSnapshot } from '../../packages/ipc/src/contracts.ts';
import { DEFAULT_REMINDER_SETTINGS } from '../../packages/ipc/src/contracts.ts';
import { NotifyCommands } from '../../packages/ipc/src/commands.ts';
import { SNOOZE_OPTIONS, entryCommand, hideAllCommand } from './viewmodel.ts';

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');

const SOURCES: Record<string, string> = {
  'index.html': read('./index.html'),
  'main.ts': read('./main.ts'),
  'viewmodel.ts': read('./viewmodel.ts'),
  'strings.ts': read('./strings.ts'),
  'styles.css': read('./styles.css'),
};

/** Only these commands may ever leave the alarm window. */
const ALLOWED_COMMANDS = new Set<string>([
  NotifyCommands.SNAPSHOT,
  NotifyCommands.OPEN_CONVERSATION,
  NotifyCommands.HIDE_ROUND,
  NotifyCommands.HIDE_ALL,
  NotifyCommands.SNOOZE,
]);

const acc = { account_id: 'a', environment: 'production', session_generation: 1 } as const;
const entry: AlarmEntry = {
  account: acc, gid: 'g1', round_id: 'r1', version: 2, label: '客户', waiting_since_ms: 1, waited_seconds: 40,
  level: 'L3', start_confirmed: true, snoozed_until_ms: null,
};
const snapshot: AlarmSnapshot = { generated_at_ms: 2, clock_trusted: true, reconciling: false, settings: { ...DEFAULT_REMINDER_SETTINGS }, entries: [entry] };

test('alarm sources contain no text-entry element', () => {
  const banned = [/<input\b/i, /<textarea\b/i, /<select\b/i, /contenteditable/i, /\bh\(\s*['"](input|textarea|select)['"]/, /createElement\(\s*['"](input|textarea|select)['"]/, /role:\s*['"]textbox['"]/];
  for (const [name, src] of Object.entries(SOURCES)) {
    for (const re of banned) assert.equal(re.test(src), false, `${name} matches ${re}`);
  }
});

test('alarm sources never name a send/finish/order command or the IM command group', () => {
  for (const name of ['main.ts', 'viewmodel.ts']) {
    const src = SOURCES[name] ?? '';
    assert.equal(/ImCommands|OrderCommands|AccountCommands/.test(src), false, `${name} imports another command group`);
    // no `\b` around the snake_case names: `_` is a word character, so `\bim_send\b` would let `im_send_text` through
    assert.equal(/im_send|send_message|sendMessage|im_finish|\bfinish\b/i.test(src), false, `${name} mentions send/finish`);
    // Every ipc.invoke / run() call site goes through NotifyCommands or the view-model.
    for (const m of src.matchAll(/ipc\.invoke(?:<[^>]*>)?\(\s*([^,)]+)/g)) {
      const arg = (m[1] ?? '').trim();
      assert.ok(arg === 'NotifyCommands.SNAPSHOT' || arg === 'cmd', `${name}: unexpected invoke target ${arg}`);
    }
  }
});

test('every command the view-model can build is in the closed non-send set', () => {
  const built = new Set<string>();
  for (const action of [{ kind: 'open' }, { kind: 'hide' }, ...SNOOZE_OPTIONS.map((o) => ({ kind: 'snooze' as const, minutes: o.minutes }))] as const) {
    built.add(entryCommand(entry, action).cmd);
  }
  built.add(hideAllCommand(snapshot).cmd);
  built.add(NotifyCommands.SNAPSHOT);
  for (const cmd of built) {
    assert.ok(ALLOWED_COMMANDS.has(cmd), `unexpected command ${cmd}`);
    assert.equal(/send|finish|url|open_external/i.test(cmd.replace('notify_open_conversation', '')), false, cmd);
  }
});

test('alarm window capability grants no send/finish/URL permission', () => {
  const cap = JSON.parse(read('../../../src-tauri/capabilities/popups.json')) as { windows: string[]; permissions: string[] };
  assert.deepEqual(cap.windows, ['alarm']);
  const custom = cap.permissions.filter((p) => p.startsWith('allow-'));
  assert.deepEqual([...custom].sort(), [
    'allow-contract-hello', 'allow-notify-hide-all', 'allow-notify-hide-round', 'allow-notify-open-conversation', 'allow-notify-snapshot', 'allow-notify-snooze', 'allow-prefs-snapshot',
  ]);
  for (const p of cap.permissions) assert.equal(/send|finish|opener|shell|http|fs:/i.test(p), false, p);
});
