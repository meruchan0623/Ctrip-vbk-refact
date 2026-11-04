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
    for (const [freq, offset] of TONES[name]) {
      const o = ac.createOscillator();
      const g = ac.createGain();
      const st = ac.currentTime + offset;
      o.type = 'sine';
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, st);
      g.gain.exponentialRampToValueAtTime(0.1, st + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, st + 0.18);
      o.connect(g);
      g.connect(ac.destination);
      o.onended = () => {
        o.disconnect();
        g.disconnect();
        live.delete(o);
        releaseContext();
      };
      o.start(st);
      o.stop(st + 0.2);
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
