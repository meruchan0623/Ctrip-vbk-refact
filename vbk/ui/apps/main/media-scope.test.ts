import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import * as vm from './viewmodel.ts';
import { messageAlignment } from './message-alignment.ts';
import { cx } from '../../packages/ui-kit/src/h.ts';
const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
const scope = { account_id: 'synthetic-account', environment: 'prod', session_generation: 1 };
class ElementFixture {
  replacement: ElementFixture | null = null;
  readonly tag: string; readonly props: Record<string, unknown>; readonly children: unknown[];
  constructor(tag: string, props: Record<string, unknown>, children: unknown[]) { this.tag = tag; this.props = props; this.children = children; }
  get dataset(): Record<string, string> { return (this.props['dataset'] as Record<string, string> | undefined) ?? {}; }
  querySelectorAll(): ElementFixture[] { return descendants(this).filter(n => n.tag === 'video' && n.dataset['mediaKey'] !== undefined); }
  querySelector(selector: string) { const encoded = selector.slice('video[data-media-key="'.length, -2); return this.querySelectorAll().find(n => encodeURIComponent(n.dataset['mediaKey'] ?? '') === encoded) ?? null; }
  getAttribute(key: string) { return this.props[key] ?? null; }
  replaceWith(node: ElementFixture) { this.replacement = node; }
}
function descendants(tree: unknown): ElementFixture[] { if (Array.isArray(tree)) return tree.flatMap(descendants); if (!(tree instanceof ElementFixture)) return []; return [tree, ...descendants(tree.children)]; }
function renderVideo(account = scope, room = 'synthetic-room', id: string | null = 'synthetic-message', url = 'https://media.ctrip.com/synthetic.mp4', owner = account): ElementFixture {
  const env: Record<string, unknown> = { ...vm, cx, messageAlignment, h: (tag: string, props: Record<string, unknown> | null, ...children: unknown[]) => new ElementFixture(tag, props ?? {}, children), document: {}, renderMessageAvatar: () => 'avatar', t: (k: string) => k, icon: () => null, IC: {} };
  if (source.includes('function mediaNodeKey(')) { const a = source.indexOf('function mediaNodeKey('), b = source.indexOf('\nfunction messageRow(', a); env['mediaNodeKey'] = new Function(...Object.keys(env), stripTypeScriptTypes(source.slice(a, b)) + '\nreturn mediaNodeKey;')(...Object.values(env)); }
  const a = source.indexOf('function messageRow('), b = source.indexOf('\nfunction translationBar(', a);
  const render = new Function(...Object.keys(env), stripTypeScriptTypes(source.slice(a, b)) + '\nreturn messageRow;')(...Object.values(env));
  const m = { gid: room, message_id: id, local_id: null, sender_role: 'customer', kind: 'video', media_url: url, text: 'SYNTHETIC VIDEO', disposition: null, quote: null };
  const tree = render({ messages: {}, prefs: { general: { show_msg_time: false } } }, m, { account: owner, gid: room, title: 'Synthetic Customer' }, { context: account });
  const video = descendants(tree).find(n => n.tag === 'video'); assert.ok(video); return video;
}
function actualReuse(oldVideo: ElementFixture, nextVideo: ElementFixture): void {
  const oldRoot = new ElementFixture('div', {}, [oldVideo]); const nextRoot = new ElementFixture('div', {}, [nextVideo]);
  let trigger!: (state: object) => void;
  const env = { Element: ElementFixture, CSS: { escape: encodeURIComponent }, root: oldRoot, store: {}, render: () => nextRoot, subscribeBatched: (_store: unknown, callback: typeof trigger) => { trigger = callback; }, rerender: (_root: unknown, callback: () => unknown) => callback() };
  const a = source.indexOf('subscribeBatched(store,'), b = source.indexOf('\nrerender(root, () => render(S()));', a); assert.ok(a >= 0 && b > a);
  new Function(...Object.keys(env), stripTypeScriptTypes(source.slice(a, b)))(...Object.values(env)); trigger({});
}
test('actual video render and subscribed redraw reuse only the same complete account scope', () => {
  const old = renderVideo(), next = renderVideo(); actualReuse(old, next); assert.equal(next.replacement, old);
  for (const account of [{ ...scope, environment: 'other-env' }, { ...scope, session_generation: 2 }, { ...scope, account_id: 'synthetic-other' }]) { const candidate = renderVideo(account); actualReuse(old, candidate); assert.equal(candidate.replacement, null); assert.notEqual(candidate.dataset['mediaKey'], old.dataset['mediaKey']); }
});
test('different room, message or URL and unverifiable owner/identity never reuse old playback', () => {
  const old = renderVideo();
  for (const next of [renderVideo(scope, 'synthetic-other-room'), renderVideo(scope, 'synthetic-room', 'synthetic-other-message'), renderVideo(scope, 'synthetic-room', 'synthetic-message', 'https://media.ctrip.com/other.mp4'), renderVideo(scope, 'synthetic-room', null), renderVideo(scope, 'synthetic-room', 'synthetic-message', undefined, { ...scope, session_generation: 2 })]) { actualReuse(old, next); assert.equal(next.replacement, null); }
  const unidentified = renderVideo(scope, 'synthetic-room', null), next = renderVideo(scope, 'synthetic-room', null); actualReuse(unidentified, next); assert.equal(next.replacement, null);
});
