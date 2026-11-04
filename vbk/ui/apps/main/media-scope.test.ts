import { t as translateUi } from '../../packages/ui-kit/src/i18n.ts';
import { historyDiagnostics } from './history-diagnostics.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import * as vm from './viewmodel.ts';
import { messageAlignment } from './message-alignment.ts';
import { cx, h, rerender } from '../../packages/ui-kit/src/h.ts';
import { installFakeDom, fakeDocument } from '../../tests/fake-dom.ts';
const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
const scope = { account_id: 'synthetic-account', environment: 'prod', session_generation: 1 };
const { root } = installFakeDom();
/** The actual `messageRow` (with `mediaNodeKey`) rendered through the real ui-kit `h` into a minimal DOM. */
function renderVideo(account = scope, room = 'synthetic-room', id: string | null = 'synthetic-message', url = 'https://media.ctrip.com/synthetic.mp4', owner = account): { row: HTMLElement; video: HTMLVideoElement } {
  const env: Record<string, unknown> = { visibleReads: { retry() {}, afterRender() {} }, ...vm, historyDiagnostics, cx, messageAlignment, h, document: fakeDocument, renderMessageAvatar: () => 'avatar', t: translateUi, icon: () => null, IC: {} };
  if (source.includes('function mediaNodeKey(')) { const a = source.indexOf('function mediaNodeKey('), b = source.indexOf('\nfunction messageRow(', a); env['mediaNodeKey'] = new Function(...Object.keys(env), stripTypeScriptTypes(source.slice(a, b)) + '\nreturn mediaNodeKey;')(...Object.values(env)); }
  const a = source.indexOf('function messageRow('), b = source.indexOf('\nfunction translationBar(', a);
  const render = new Function(...Object.keys(env), stripTypeScriptTypes(source.slice(a, b)) + '\nreturn messageRow;')(...Object.values(env));
  const m = { gid: room, message_id: id, local_id: null, sender_role: 'customer', kind: 'video', media_url: url, text: 'SYNTHETIC VIDEO', disposition: null, quote: null };
  const row = render({ messages: {}, prefs: { general: { show_msg_time: false } } }, m, { account: owner, gid: room, title: 'Synthetic Customer' }, { context: account }) as HTMLElement;
  const video = row.querySelector('video') as HTMLVideoElement | null; assert.ok(video); return { row, video };
}
/** The redraw path the frame subscriber takes: an incremental `rerender(..., { morph: true })` of the pane. */
function actualReuse(old: { row: HTMLElement; video: HTMLVideoElement }, next: { row: HTMLElement }): boolean {
  root.replaceChildren();
  rerender(root as unknown as Element, () => h('div', { class: 'msgs', dataset: { keepScroll: 'msgs' } }, old.row));
  assert.equal(root.querySelector('video'), old.video);
  rerender(root as unknown as Element, () => h('div', { class: 'msgs', dataset: { keepScroll: 'msgs' } }, next.row), { morph: true });
  return root.querySelector('video') === (old.video as unknown);
}
test('the frame subscriber redraws incrementally, so a mounted video can survive a redraw', () => {
  const a = source.indexOf('subscribeFrame(store,'), b = source.indexOf('\nrerender(root, () => render(S()));', a); assert.ok(a >= 0 && b > a);
  assert.match(source.slice(a, b), /rerender\(root, [^\n]*\{ morph: true \}\)/);
});
test('actual video render and subscribed redraw reuse only the same complete account scope', () => {
  const old = renderVideo(); assert.equal(actualReuse(old, renderVideo()), true);
  for (const account of [{ ...scope, environment: 'other-env' }, { ...scope, session_generation: 2 }, { ...scope, account_id: 'synthetic-other' }]) { const fresh = renderVideo(), candidate = renderVideo(account); assert.equal(actualReuse(fresh, candidate), false); assert.notEqual(candidate.video.dataset['mediaKey'], fresh.video.dataset['mediaKey']); }
});
test('different room, message or URL and unverifiable owner/identity never reuse old playback', () => {
  for (const next of [() => renderVideo(scope, 'synthetic-other-room'), () => renderVideo(scope, 'synthetic-room', 'synthetic-other-message'), () => renderVideo(scope, 'synthetic-room', 'synthetic-message', 'https://media.ctrip.com/other.mp4'), () => renderVideo(scope, 'synthetic-room', null), () => renderVideo(scope, 'synthetic-room', 'synthetic-message', undefined, { ...scope, session_generation: 2 })]) assert.equal(actualReuse(renderVideo(), next()), false);
  assert.equal(actualReuse(renderVideo(scope, 'synthetic-room', null), renderVideo(scope, 'synthetic-room', null)), false);
});
