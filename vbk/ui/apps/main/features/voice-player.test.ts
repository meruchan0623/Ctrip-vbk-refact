import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFeatureRuntime } from './runtime.ts';
import { createVoicePlayer, createVoicePlayerModule, isPlayableVoiceUrl, type AudioLike } from './voice-player.ts';
import { ACCOUNT, GID, makeHost } from './testing.ts';

const A = 'https://dimg04.c-ctrip.com/a.mp3';
const B = 'https://static.tripcdn.com/b.amr';

class FakeAudio implements AudioLike {
  playing = false;
  failPlay = false;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
  }
  play(): Promise<void> {
    if (this.failPlay) return Promise.reject(new Error('NotSupported'));
    this.playing = true;
    return Promise.resolve();
  }
  pause(): void {
    this.playing = false;
  }
}

function setup() {
  const made: FakeAudio[] = [];
  let changes = 0;
  const player = createVoicePlayer((url) => {
    const a = new FakeAudio(url);
    made.push(a);
    return a;
  }, () => { changes++; });
  return { made, player, changes: () => changes };
}

test('url policy mirrors the media CSP', () => {
  assert.equal(isPlayableVoiceUrl(A), true);
  for (const bad of ['http://x.ctrip.com/a.mp3', 'https://evil.example/a.mp3', 'https://u:p@x.ctrip.com/a.mp3', 'https://x.ctrip.com:444/a.mp3', 'blob:https://x.ctrip.com/1', '', 7, null]) {
    assert.equal(isPlayableVoiceUrl(bad), false, String(bad));
  }
});

test('one clip at a time: starting B stops A; toggling the playing clip pauses it', async () => {
  const { made, player } = setup();
  assert.equal(await player.toggle(A), 'playing');
  assert.equal(await player.toggle(B), 'playing');
  assert.equal(made[0]!.playing, false);
  assert.equal(player.state(A), 'idle');
  assert.equal(player.state(B), 'playing');
  assert.equal(await player.toggle(B), 'idle');
  assert.equal(made[1]!.playing, false);
});

test('natural end returns to idle; load/play failure is reported once and not retried', async () => {
  const { made, player } = setup();
  await player.toggle(A);
  made[0]!.onended!();
  assert.equal(player.state(A), 'idle');
  await player.toggle(A);
  made[1]!.onerror!();
  assert.equal(player.state(A), 'error');
  assert.equal(made.length, 2, 'no automatic retry');
  const p2 = createVoicePlayer((url) => { const a = new FakeAudio(url); a.failPlay = true; return a; }, () => undefined);
  assert.equal(await p2.toggle(A), 'error');
  assert.equal(p2.state(A), 'error');
});

test('a non-playable URL never reaches the audio factory', async () => {
  const { made, player } = setup();
  assert.equal(await player.toggle('https://evil.example/a.mp3'), 'error');
  assert.equal(made.length, 0);
});

test('stop() only notifies when something was playing', async () => {
  const { player, changes } = setup();
  player.stop();
  assert.equal(changes(), 0);
  await player.toggle(A);
  const before = changes();
  player.stop();
  assert.equal(changes(), before + 1);
});

test('module: playback stops when the conversation or account changes, and on dispose', async () => {
  const made: FakeAudio[] = [];
  const mod = createVoicePlayerModule((url) => { const a = new FakeAudio(url); made.push(a); return a; });
  const host = makeHost();
  const rt = createFeatureRuntime([mod], host);
  rt.start();
  host.changed(); // records the scope
  await mod.player.toggle(A);
  host.changed(); // same scope: keeps playing
  assert.equal(made[0]!.playing, true);
  host.active = { account: ACCOUNT, gid: '777' };
  host.changed();
  assert.equal(made[0]!.playing, false);
  host.active = { account: ACCOUNT, gid: GID };
  host.changed();
  await mod.player.toggle(B);
  rt.stop();
  assert.equal(made[1]!.playing, false);
});
