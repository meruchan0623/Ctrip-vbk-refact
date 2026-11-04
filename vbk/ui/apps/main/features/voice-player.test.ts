import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFeatureRuntime } from './runtime.ts';
import { FEATURES } from './registry.ts';
import { createVoicePlayer, createVoicePlayerModule, isPlayableVoiceUrl, voiceCandidates, voicePlayerOf, type AudioLike } from './voice-player.ts';
import { ACCOUNT, GID, makeHost } from './testing.ts';

const A = 'https://dimg04.c-ctrip.com/a.mp3';
const B = 'https://static.tripcdn.com/b.ogg';
const AAC = 'https://ak-a.tripcdn.com/synthetic/clip.aac?sig=1';
const AMR = 'https://voice.c-ctrip.com/synthetic/clip.AMR';

class FakeAudio implements AudioLike {
  playing = false;
  failPlay = false;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeupdate: (() => void) | null = null;
  ondurationchange: (() => void) | null = null;
  currentTime = 0;
  duration = Number.NaN;
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
  const failing = new Set<string>();
  const player = createVoicePlayer((url) => {
    const a = new FakeAudio(url);
    a.failPlay = failing.has(url);
    made.push(a);
    return a;
  }, () => { changes++; });
  return { made, player, failing, changes: () => changes };
}

test('url policy mirrors the media CSP', () => {
  assert.equal(isPlayableVoiceUrl(A), true);
  for (const bad of ['http://x.ctrip.com/a.mp3', 'https://evil.example/a.mp3', 'https://u:p@x.ctrip.com/a.mp3', 'https://x.ctrip.com:444/a.mp3', 'blob:https://x.ctrip.com/1', '', 7, null]) {
    assert.equal(isPlayableVoiceUrl(bad), false, String(bad));
  }
});

test('candidates: only aac/acc fall back; amr goes straight to wav; others stay as is', () => {
  assert.deepEqual(voiceCandidates(AAC), [AAC, 'https://ak-a.tripcdn.com/synthetic/clip.wav?sig=1']);
  assert.deepEqual(voiceCandidates('https://x.ctrip.com/a.acc'), ['https://x.ctrip.com/a.acc', 'https://x.ctrip.com/a.wav']);
  assert.deepEqual(voiceCandidates(AMR), ['https://voice.c-ctrip.com/synthetic/clip.wav']);
  assert.deepEqual(voiceCandidates(A), [A]);
  assert.deepEqual(voiceCandidates('https://x.ctrip.com/a.wav'), ['https://x.ctrip.com/a.wav']);
});

test('wav fallback runs once: both candidates failing ends in error with no third attempt', async () => {
  const { made, player, failing, changes } = setup();
  failing.add(AAC);
  failing.add('https://ak-a.tripcdn.com/synthetic/clip.wav?sig=1');
  assert.equal(await player.toggle(AAC), 'error');
  assert.deepEqual(made.map(a => a.url), [AAC, 'https://ak-a.tripcdn.com/synthetic/clip.wav?sig=1']);
  assert.equal(player.state(AAC), 'error');
  assert.ok(changes() >= 1);
});

test('wav fallback that works keeps the state under the original URL and releases the failed attempt', async () => {
  const { made, player, failing } = setup();
  failing.add(AAC);
  assert.equal(await player.toggle(AAC), 'playing');
  assert.equal(made[0]!.onerror, null, 'the failed attempt was released');
  assert.equal(made.length, 2);
  assert.equal(made[1]!.playing, true);
  assert.equal(player.state(AAC), 'playing');
});

test('onerror during playback falls back once, then reports once', async () => {
  const { made, player, changes } = setup();
  await player.toggle(AAC);
  made[0]!.onerror!();
  await Promise.resolve();
  assert.equal(made.length, 2);
  assert.equal(player.state(AAC), 'playing');
  const before = changes();
  made[1]!.onerror!();
  await Promise.resolve();
  assert.equal(made.length, 2, 'no loop');
  assert.equal(player.state(AAC), 'error');
  assert.equal(changes(), before + 1, 'reported once');
});

test('amr tries only wav; a user click after failure starts the candidates over', async () => {
  const { made, player, failing } = setup();
  failing.add('https://voice.c-ctrip.com/synthetic/clip.wav');
  assert.equal(await player.toggle(AMR), 'error');
  assert.equal(made.length, 1);
  await player.toggle(AMR);
  assert.equal(made.length, 2);
});

test('progress reaches listeners without onChange and reports unknown duration as null', async () => {
  const { made, player, changes } = setup();
  const seen: unknown[] = [];
  const off = player.onProgress((url, p) => seen.push([url, p.current_s, p.duration_s]));
  await player.toggle(A);
  const before = changes();
  made[0]!.currentTime = 2;
  made[0]!.ontimeupdate!();
  made[0]!.duration = 9;
  made[0]!.ondurationchange!();
  assert.deepEqual(seen, [[A, 2, null], [A, 2, 9]]);
  assert.equal(changes(), before);
  assert.deepEqual(player.progress(A), { current_s: 2, duration_s: 9 });
  assert.equal(player.progress(B), null);
  off();
  made[0]!.ontimeupdate!();
  assert.equal(seen.length, 2);
});

test('pause keeps the same audio element; resume does not rebuild it, and a rejected pending play is not a failure', async () => {
  const { made, player } = setup();
  await player.toggle(A);
  assert.equal(await player.toggle(A), 'paused');
  assert.equal(player.state(A), 'paused');
  assert.equal(await player.toggle(A), 'playing');
  assert.equal(made.length, 1);
  const pending = createVoicePlayer(() => {
    const a = new FakeAudio(A);
    let reject = (_: Error) => {};
    a.play = () => new Promise((_, r) => { reject = r; });
    a.pause = () => reject(new Error('AbortError'));
    return a;
  }, () => undefined);
  const first = pending.toggle(A);
  await pending.toggle(A);
  await first;
  assert.equal(pending.state(A), 'paused');
});

test('voicePlayerOf finds the registered module', () => {
  assert.ok(voicePlayerOf(FEATURES));
  assert.equal(voicePlayerOf([]), null);
});

test('one clip at a time: starting B stops A; toggling the playing clip pauses it', async () => {
  const { made, player } = setup();
  assert.equal(await player.toggle(A), 'playing');
  assert.equal(await player.toggle(B), 'playing');
  assert.equal(made[0]!.playing, false);
  assert.equal(player.state(A), 'idle');
  assert.equal(player.state(B), 'playing');
  assert.equal(await player.toggle(B), 'paused');
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
