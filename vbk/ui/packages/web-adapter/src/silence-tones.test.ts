import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installToneSilencer, type ToneSilencerWindow } from './silence-tones.ts';

function page() {
  class Media {
    playing = false;
    stored = false;
    get autoplay() { return this.stored; }
    set autoplay(value: boolean) { this.stored = value; }
    pause() { this.playing = false; }
    play() { this.playing = true; return Promise.resolve(); }
  }
  class Audio extends Media {}
  class Video extends Media {}
  const activation = { isActive: false };
  let onPlay: ((event: { target: unknown }) => void) | null = null;
  let capture = false;
  const win: ToneSilencerWindow = {
    HTMLMediaElement: Media,
    HTMLAudioElement: Audio,
    navigator: { userActivation: activation },
    addEventListener(_type, cb, useCapture) { onPlay = cb; capture = useCapture; },
  };
  assert.equal(installToneSilencer(win), true);
  return { Audio, Video, activation, firePlay: (target: unknown) => onPlay!({ target }), capture: () => capture };
}

test('official tone path: script-set autoplay is dropped on audio', () => {
  const { Audio, Video } = page();
  const tone = new Audio();
  tone.autoplay = true;
  assert.equal(tone.autoplay, false);
  const clip = new Video();
  clip.autoplay = true;
  assert.equal(clip.autoplay, true, 'video keeps autoplay');
});

test('play() without a user gesture is refused, a clicked voice clip still plays', async () => {
  const { Audio, Video, activation } = page();
  const tone = new Audio();
  await assert.rejects(tone.play(), { name: 'NotAllowedError' });
  assert.equal(tone.playing, false);
  const video = new Video();
  await video.play();
  assert.equal(video.playing, true);
  activation.isActive = true;
  await tone.play();
  assert.equal(tone.playing, true);
});

test('markup autoplay is paused from the capture phase unless the user started it', () => {
  const { Audio, Video, activation, firePlay, capture } = page();
  assert.equal(capture(), true, 'media play events do not bubble');
  const tone = new Audio();
  tone.playing = true;
  firePlay(tone);
  assert.equal(tone.playing, false);
  const video = new Video();
  video.playing = true;
  firePlay(video);
  assert.equal(video.playing, true);
  activation.isActive = true;
  tone.playing = true;
  firePlay(tone);
  assert.equal(tone.playing, true);
});

test('pages without media classes are left untouched', () => {
  assert.equal(installToneSilencer({}), false);
});
