import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';

// Attachments open in the host-owned viewer window: the main window names the
// message and never passes an address. The function under test is read from main.ts.
const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
const start = source.indexOf('function openMessageAttachment(');
const end = source.indexOf('\n}\n', start) + 3;
assert.ok(start >= 0 && end > start);
const body = stripTypeScriptTypes(source.slice(start, end));

const context = { account_id: 'synthetic-account', environment: 'synthetic', session_generation: 1 };
function harness(active = true) {
  const calls: { command: string; payload: unknown }[] = [];
  const toasts: string[] = [];
  const env = {
    stillActive: () => active,
    S: () => ({ view: 'messages', activeGid: 'synthetic-room' }),
    mediaNodeKey: () => 'synthetic-media',
    toast: (text: string) => toasts.push(text),
    invokeSafe: (command: string, payload: unknown) => { calls.push({ command, payload }); return Promise.resolve(null); },
    UiCommands: { MEDIA_VIEWER_OPEN_MESSAGE: 'media_viewer_open_message' },
  };
  const open = new Function(...Object.keys(env), `${body}\nreturn openMessageAttachment;`)(...Object.values(env)) as (message: object, conversation: object, account: object | null) => void;
  return { open, calls, toasts };
}
const conversation = { gid: 'synthetic-room' };

test('image, video and document messages open the viewer by message identity only', () => {
  for (const kind of ['image', 'video', 'file']) {
    const { open, calls } = harness();
    open({ kind, message_id: 'synthetic-1', media_url: 'https://evil.example/a.png', text: 'x' }, conversation, { context });
    assert.deepEqual(calls, [{ command: 'media_viewer_open_message', payload: { account: context, gid: 'synthetic-room', message_id: 'synthetic-1' } }]);
  }
});

test('other kinds, stale accounts and unconfirmed messages do not open a window', () => {
  const other = harness();
  other.open({ kind: 'text', message_id: 'synthetic-1' }, conversation, { context });
  assert.deepEqual(other.calls, []);
  const stale = harness(false);
  stale.open({ kind: 'image', message_id: 'synthetic-1' }, conversation, { context });
  assert.deepEqual(stale.calls, []);
  const pending = harness();
  pending.open({ kind: 'image', message_id: null }, conversation, { context });
  assert.deepEqual(pending.calls, []);
  assert.equal(pending.toasts.length, 1);
});
