import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
function fixture() {
  const state: Record<string, any> = { view: 'messages' };
  let context: object | null = {}, composing = false, editor: unknown = null;
  const captured: string[] = [];
  const env = { S: () => state, activeConv: () => ({ status: state.status ?? 'active' }), isDone: (c: { status: string }) => c.status === 'done', composerInputContext: () => context,
    composerInput: { active: () => composing }, document: { activeElement: { closest: () => editor } }, attach: async (kind: string) => { captured.push(kind); } };
  const start = source.indexOf('function receiveScreenshotRequest('), end = source.indexOf('\nasync function attach(', start);
  const receive = new Function(...Object.keys(env), stripTypeScriptTypes(source.slice(start, end)) + '\nreturn receiveScreenshotRequest;')(...Object.values(env));
  return { state, receive, captured, context: (value: object | null) => { context = value; }, composing: () => { composing = true; }, editor: (fid: string) => { editor = { dataset: { fid } }; } };
}
test('host screenshot request captures only a valid composer and allows its own draft editor', () => {
  const f = fixture(); f.receive(); f.editor('draft'); f.receive(); assert.deepEqual(f.captured, ['screenshot', 'screenshot']);
});
test('host screenshot request ignores missing composer, finished rooms, pending pickers and other editors', () => {
  const contexts = fixture(); contexts.context(null); contexts.receive(); assert.deepEqual(contexts.captured, []);
  for (const key of ['logoutDialog', 'peripheral', 'receiveDiagnostics', 'unknownOutbound', 'recommendations', 'attachmentSelection']) {
    const f = fixture(); f.state[key] = {}; f.receive(); assert.deepEqual(f.captured, [], key);
  }
  const replies = fixture(); replies.state.quickReplies = { mode: 'categories' }; replies.receive(); assert.deepEqual(replies.captured, []);
  const done = fixture(); done.state.status = 'done'; done.receive(); assert.deepEqual(done.captured, []);
  const composing = fixture(); composing.composing(); composing.receive(); assert.deepEqual(composing.captured, []);
  for (const fid of ['search', 'order-query', 'remark', 'reply-search']) { const f = fixture(); f.editor(fid); f.receive(); assert.deepEqual(f.captured, [], fid); }
});
test('main subscribes to the dedicated host screenshot event', () => {
  assert.ok(source.includes('ipc.listen<unknown>(UiEvents.SCREENSHOT_REQUEST, receiveScreenshotRequest)'));
});
