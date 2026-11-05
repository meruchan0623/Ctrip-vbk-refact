/**
 * Notification tones generated with WebAudio (no bundled audio files), driven
 * by `notify://play-sound` / `notify://stop-sound`. Tone shapes follow the
 * prototype's `beep()`: a two-note chime for new messages, a three-note
 * alert for reply timeouts (`timeout`, and each `loop` tick of L4).
 */

import type { SoundName } from '../_shared/guards.ts';

type Tone = readonly [freqHz: number, offsetSec: number];

const TONES: Readonly<Record<SoundName, readonly Tone[]>> = {
  new_message: [
    [1046, 0],
    [1318, 0.1],
  ],
  timeout: [
    [880, 0],
    [660, 0.2],
    [880, 0.4],
  ],
  loop: [
    [880, 0],
    [660, 0.2],
    [880, 0.4],
  ],
};

/** 提示音档位：soft 为默认较轻的提示音；strong 近似官方客户端的强提醒。 */
export type SoundProfile = 'soft' | 'strong';
export const SOUND_PROFILE_KEY = 'vbk.sound.profile';

interface Shape {
  readonly type: OscillatorType;
  readonly gain: number;
  readonly hold: number;
}

const SHAPES: Readonly<Record<SoundProfile, Shape>> = {
  soft: { type: 'sine', gain: 0.1, hold: 0.18 },
  strong: { type: 'triangle', gain: 0.4, hold: 0.09 },
};

// 强提醒：中频高低双音快速连敲（三角波，较圆润），音量大但不刺耳。
const STRONG_PULSE: readonly Tone[] = [
  [880, 0], [660, 0.08], [880, 0.16], [660, 0.24], [880, 0.32], [660, 0.4],
];
const STRONG_TONES: Readonly<Record<SoundName, readonly Tone[]>> = {
  new_message: STRONG_PULSE.slice(0, 4),
  timeout: STRONG_PULSE,
  loop: STRONG_PULSE,
};

export function getSoundProfile(): SoundProfile {
  try {
    return localStorage.getItem(SOUND_PROFILE_KEY) === 'strong' ? 'strong' : 'soft';
  } catch {
    return 'soft';
  }
}

export function setSoundProfile(profile: SoundProfile): void {
  try {
    localStorage.setItem(SOUND_PROFILE_KEY, profile);
  } catch {
    /* 存储不可用时保持默认档位 */
  }
}

interface AudioCtor {
  new (): AudioContext;
}

let ctx: AudioContext | null = null;
const live = new Set<OscillatorNode>();
let lastMessageTone = 0;

// Release WebKit's audio resources between short notification effects.
function releaseContext(): void {
  if (live.size || !ctx) return;
  const finished = ctx;
  ctx = null;
  void finished.close().catch(() => undefined);
}

function context(): AudioContext | null {
  if (ctx) return ctx;
  const w = window as unknown as { AudioContext?: AudioCtor; webkitAudioContext?: AudioCtor };
  const C = w.AudioContext ?? w.webkitAudioContext;
  if (!C) return null;
  try {
    // Supported by newer WebKit versions: this is a short notification,
    // not long-form media. Cleanup below also works without this optional API.
    const session = (window.navigator as Navigator & {
      audioSession?: { type: string };
    }).audioSession;
    try {
      if (session) session.type = 'transient';
    } catch {
      // An unsupported session hint must not prevent the notification.
    }
    ctx = new C();
  } catch {
    ctx = null;
  }
  return ctx;
}

/** Returns the number of oscillators scheduled (0 when audio is unavailable or throttled). */
export function playSound(name: SoundName): number {
  // Coalesce bursts of new-message events into one chime (prototype: 1.5 s).
  if (name === 'new_message') {
    const now = Date.now();
    if (now - lastMessageTone < 1500) return 0;
    lastMessageTone = now;
  }
  const ac = context();
  if (!ac) return 0;
  try {
    if (ac.state === 'suspended') void ac.resume().catch(() => undefined);
    let n = 0;
    const profile = getSoundProfile();
    const shape = SHAPES[profile];
    const tones = profile === 'strong' ? STRONG_TONES[name] : TONES[name];
    for (const [freq, offset] of tones) {
      const o = ac.createOscillator();
      const g = ac.createGain();
      const st = ac.currentTime + offset;
      o.type = shape.type;
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, st);
      g.gain.exponentialRampToValueAtTime(shape.gain, st + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, st + shape.hold);
      o.connect(g);
      g.connect(ac.destination);
      o.onended = () => {
        o.disconnect();
        g.disconnect();
        live.delete(o);
        releaseContext();
      };
      o.start(st);
      o.stop(st + shape.hold + 0.02);
      live.add(o);
      n += 1;
    }
    return n;
  } catch {
    stopSound();
    return 0;
  }
}

export function stopSound(): void {
  for (const o of Array.from(live)) {
    try {
      o.stop();
    } catch {
      /* already stopped */
    }
    live.delete(o);
  }
  releaseContext();
}
