import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeElement, installFakeDom } from '../../tests/fake-dom.ts';
import type { UiMessage } from '../../packages/ipc/src/client.ts';
import { h, icon } from '../../packages/ui-kit/src/h.ts';
import { createVoicePlayer, type AudioLike } from './features/voice-player.ts';
import { formatVoiceTime, voiceBubble } from './voice-bubble.ts';

installFakeDom();

const URL_OK = 'https://synthetic.tripcdn.com/clip.mp3';

const message = (over: Partial<UiMessage> = {}): UiMessage => ({
  gid: 'synthetic-room', message_id: 'm', local_id: null, create_time_ms: 1, sender_role: 'customer',
  kind: 'voice', text: '', media_url: URL_OK, voice_duration_s: 8, translation: null, original: null, quote: null, order_id: null, disposition: null, ...over,
});

class FakeAudio implements AudioLike {
  currentTime = 0;
  duration = Number.NaN;
  failPlay = false;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeupdate: (() => void) | null = null;
  ondurationchange: (() => void) | null = null;
  play(): Promise<void> {
    return this.failPlay ? Promise.reject(new Error('NotSupported')) : Promise.resolve();
  }
  pause(): void {}
}

function setup(failPlay = false) {
  const made: FakeAudio[] = [];
  let renders = 0;
  const player = createVoicePlayer(() => { const a = new FakeAudio(); a.failPlay = failPlay; made.push(a); return a; }, () => { renders++; });
  return { player, made, renders: () => renders };
}

const el = (node: HTMLElement) => node as unknown as FakeElement;
const part = (root: HTMLElement, cls: string) => el(root).querySelectorAll('[class]').find(n => n.className.split(' ').includes(cls)) ?? null;
const bubble = (m: UiMessage, player: ReturnType<typeof setup>['player'], options = {}) => voiceBubble(m, player, h, icon, options);

test('time format rounds partial seconds up', () => {
  assert.equal(formatVoiceTime(5), '0:05');
  assert.equal(formatVoiceTime(4.2), '0:05');
  assert.equal(formatVoiceTime(65), '1:05');
  assert.equal(formatVoiceTime(-1), '0:00');
});

test('idle: shows the body duration and the transcript; no audio is created before a click', () => {
  const { player, made } = setup();
  const node = bubble(message({ text: 'synthetic transcript' }), player);
  assert.equal(part(node, 'voice-time')?.textContent, '0:08');
  assert.equal(part(node, 'voice-text')?.textContent, 'synthetic transcript');
  assert.equal(part(node, 'voice-toggle')?.getAttribute('aria-label'), '播放语音');
  assert.equal(made.length, 0);
});

test('no duration anywhere: only the play key is visible', () => {
  const { player } = setup();
  const node = bubble(message({ voice_duration_s: null }), player);
  assert.equal(part(node, 'voice-bar')?.hidden, true);
  assert.equal(part(node, 'voice-time')?.hidden, true);
  assert.equal(part(node, 'voice-toggle')?.hidden, false);
});

test('progress paints the live nodes without a render; media duration beats the body value', async () => {
  const { player, made, renders } = setup();
  const node = bubble(message({ voice_duration_s: null }), player);
  part(node, 'voice-toggle')!.dispatch('click');
  await Promise.resolve();
  const audio = made[0]!;
  const before = renders();
  audio.duration = 10;
  audio.currentTime = 4;
  audio.ontimeupdate!();
  assert.equal(renders(), before, 'progress never requests a render');
  assert.equal(part(node, 'voice-bar')?.hidden, false);
  assert.equal(part(node, 'voice-bar')?.getAttribute('aria-valuenow'), '40');
  assert.equal(part(node, 'voice-time')?.textContent, '0:06');
  assert.match(part(node, 'voice-fill')!.getAttribute('style')!, /width: 40%;$/);
});

test('a row rebuilt while playing reflects position, pause label, and receives later progress', async () => {
  const { player, made } = setup();
  await player.toggle(URL_OK);
  const audio = made[0]!;
  audio.currentTime = 3;
  const node = bubble(message(), player);
  assert.equal(part(node, 'voice-toggle')?.getAttribute('aria-label'), '暂停语音');
  assert.equal(part(node, 'voice-time')?.textContent, '0:05');
  audio.currentTime = 7;
  audio.ontimeupdate!();
  assert.equal(part(node, 'voice-time')?.textContent, '0:01');
});

test('failure: shows the failed text and an external-open entry with the original URL', async () => {
  const { player } = setup(true);
  await player.toggle(URL_OK);
  const opened: string[] = [];
  const node = bubble(message(), player, { onOpenExternal: (url: string) => opened.push(url) });
  assert.match(part(node, 'voice-note')!.textContent, /语音无法播放/);
  part(node, 'voice-external')!.dispatch('click');
  assert.deepEqual(opened, [URL_OK]);
  assert.equal(part(bubble(message(), player), 'voice-external'), null, 'no callback, no entry');
});

test('a URL outside the media policy renders the unavailable state and no controls', () => {
  const { player, made } = setup();
  for (const media_url of [null, 'http://synthetic.tripcdn.com/a.mp3', 'https://evil.example/a.mp3']) {
    const node = bubble(message({ media_url, text: 'kept transcript' }), player);
    assert.equal(part(node, 'voice-toggle'), null);
    assert.equal(part(node, 'voice-note')?.textContent, '语音消息暂不支持');
    assert.equal(part(node, 'voice-text')?.textContent, 'kept transcript');
  }
  assert.equal(made.length, 0);
});
