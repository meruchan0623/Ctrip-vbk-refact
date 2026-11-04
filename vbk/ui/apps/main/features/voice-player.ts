/**
 * I-30c voice playback (FE-12), main-window half.
 *
 * The playback controller `voice-bubble.ts` drives. Rules:
 * - one clip at a time; starting another stops the first;
 * - only https URLs on the hosts the page CSP `media-src` already allows;
 * - playback stops when the conversation or account changes or the module is
 *   disposed (a clip never keeps playing for a conversation that is no longer
 *   open);
 * - a failed load walks `voiceCandidates` once, is then reported once, and is
 *   never retried in a loop (only another user click starts over);
 * - progress goes to `onProgress` listeners only: it never requests a render.
 */

import type { FeatureContext, FeatureModule } from './context.ts';

export const VOICE_HOST_SUFFIXES = ['.c-ctrip.com', '.tripcdn.com', '.ctrip.com'] as const;

export function isPlayableVoiceUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value === '') return false;
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password) return false;
    if (u.port !== '' && u.port !== '443') return false;
    const host = u.hostname.toLowerCase();
    return VOICE_HOST_SUFFIXES.some((s) => host.endsWith(s));
  } catch {
    return false;
  }
}

/**
 * URLs to try, in order. The official client rewrites `.aac/.acc/.amr` to `.wav`;
 * `.amr` has no WebView decoder so it goes straight to `.wav`, the others try the
 * original first and fall back to `.wav` once.
 */
export function voiceCandidates(url: string): readonly string[] {
  try {
    const u = new URL(url);
    const m = /\.(aac|acc|amr)$/i.exec(u.pathname);
    if (!m) return [url];
    u.pathname = `${u.pathname.slice(0, -m[0].length)}.wav`;
    return m[1]!.toLowerCase() === 'amr' ? [u.href] : [url, u.href];
  } catch {
    return [url];
  }
}

/** The slice of `HTMLAudioElement` the controller needs. */
export interface AudioLike {
  play(): Promise<void>;
  pause(): void;
  onended: (() => void) | null;
  onerror: (() => void) | null;
  ontimeupdate?: (() => void) | null;
  ondurationchange?: (() => void) | null;
  readonly currentTime?: number;
  readonly duration?: number;
  /** Drops the media resource; a stopped clip must not keep downloading. */
  dispose?(): void;
}

export type VoiceState = 'idle' | 'playing' | 'paused' | 'error';

export interface VoiceProgress {
  readonly current_s: number;
  /** From the media element; null until it knows (streams report NaN/Infinity). */
  readonly duration_s: number | null;
}

export interface VoicePlayer {
  state(url: string, key?: string): VoiceState;
  /** Position of `url` while it is the current clip, else null. */
  progress(url: string, key?: string): VoiceProgress | null;
  /** Plays `url` (stopping any other clip), pauses it when playing, resumes it when paused. */
  toggle(url: string, key?: string): Promise<VoiceState>;
  stop(): void;
  /** Fires on time and duration updates of the current clip; returns the unsubscribe. */
  onProgress(listener: (url: string, progress: VoiceProgress, key: string) => void): () => void;
}

interface Attempt {
  readonly url: string;
  /** Playback identity: two messages sharing one URL are separate targets. Defaults to the URL. */
  readonly key: string;
  readonly audio: AudioLike;
  readonly index: number;
  paused: boolean;
}

export function createVoicePlayer(factory: (url: string) => AudioLike, onChange: () => void): VoicePlayer {
  let current: Attempt | null = null;
  const errored = new Set<string>();
  const listeners = new Set<(url: string, progress: VoiceProgress, key: string) => void>();

  function release(): void {
    if (!current) return;
    const { audio } = current;
    audio.onended = null;
    audio.onerror = null;
    audio.ontimeupdate = null;
    audio.ondurationchange = null;
    try {
      audio.pause();
      audio.dispose?.();
    } catch {
      // already gone
    }
    current = null;
  }

  function progressOf(attempt: Attempt): VoiceProgress {
    const { currentTime, duration } = attempt.audio;
    return {
      current_s: typeof currentTime === 'number' && Number.isFinite(currentTime) && currentTime > 0 ? currentTime : 0,
      duration_s: typeof duration === 'number' && Number.isFinite(duration) && duration > 0 ? duration : null,
    };
  }

  /** The current attempt failed: next candidate if any, otherwise report once. Stale attempts are ignored. */
  async function fail(attempt: Attempt): Promise<void> {
    if (current !== attempt) return;
    release();
    if (attempt.index + 1 < voiceCandidates(attempt.url).length) {
      await start(attempt.url, attempt.index + 1, attempt.key);
      return;
    }
    errored.add(attempt.key);
    onChange();
  }

  async function start(url: string, index: number, key: string): Promise<void> {
    const audio = factory(voiceCandidates(url)[index]!);
    const mine: Attempt = { url, key, audio, index, paused: false };
    current = mine;
    const notify = (): void => {
      if (current !== mine) return;
      const progress = progressOf(mine);
      for (const listener of listeners) listener(url, progress, key);
    };
    audio.ontimeupdate = notify;
    audio.ondurationchange = notify;
    audio.onended = () => {
      if (current === mine) {
        release();
        onChange();
      }
    };
    audio.onerror = () => void fail(mine);
    await playAttempt(mine);
  }

  async function playAttempt(attempt: Attempt): Promise<void> {
    try {
      await attempt.audio.play();
    } catch {
      // Pausing while play() is pending rejects it: that is the user's pause, not a failed load.
      if (!attempt.paused) await fail(attempt);
    }
  }

  const player: VoicePlayer = {
    state(url, key = url) {
      if (current?.key === key) return current.paused ? 'paused' : 'playing';
      return errored.has(key) ? 'error' : 'idle';
    },
    progress(url, key = url) {
      return current?.key === key ? progressOf(current) : null;
    },
    async toggle(url, key = url) {
      if (!isPlayableVoiceUrl(url)) {
        errored.add(key);
        onChange();
        return 'error';
      }
      if (current?.key === key) {
        const attempt = current;
        attempt.paused = !attempt.paused;
        if (attempt.paused) attempt.audio.pause();
        else await playAttempt(attempt);
      } else {
        release();
        errored.delete(key);
        await start(url, 0, key);
      }
      onChange();
      return player.state(url, key);
    },
    stop() {
      const was = current !== null;
      release();
      if (was) onChange();
    },
    onProgress(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
  return player;
}

export interface VoicePlayerModule extends FeatureModule {
  readonly player: VoicePlayer;
}

function browserAudio(url: string): AudioLike {
  const a = new Audio(url);
  const wrapper: AudioLike = {
    play: () => a.play(),
    pause: () => a.pause(),
    get onended() {
      return a.onended as (() => void) | null;
    },
    set onended(cb) {
      a.onended = cb;
    },
    get onerror() {
      return a.onerror as (() => void) | null;
    },
    set onerror(cb) {
      a.onerror = cb ? () => cb() : null;
    },
    get ontimeupdate() {
      return a.ontimeupdate as (() => void) | null;
    },
    set ontimeupdate(cb) {
      a.ontimeupdate = cb ?? null;
    },
    get ondurationchange() {
      return a.ondurationchange as (() => void) | null;
    },
    set ondurationchange(cb) {
      a.ondurationchange = cb ?? null;
    },
    get currentTime() {
      return a.currentTime;
    },
    get duration() {
      return a.duration;
    },
    dispose: () => {
      a.removeAttribute('src');
      a.load();
    },
  };
  return wrapper;
}

/** The player of the registered module, for the message renderer (`main.ts` passes `FEATURES`). */
export function voicePlayerOf(features: readonly FeatureModule[]): VoicePlayer | null {
  const module = features.find((f) => f.id === 'voice-player') as VoicePlayerModule | undefined;
  return module?.player ?? null;
}

function scopeKeyOf(s: ReturnType<FeatureContext['scope']>): string {
  return s ? JSON.stringify([s.account.environment, s.account.account_id, s.account.session_generation, s.gid ?? '']) : '';
}

export function createVoicePlayerModule(factory: (url: string) => AudioLike = browserAudio): VoicePlayerModule {
  let ctx: FeatureContext | null = null;
  let off: (() => void) | null = null;
  let lastScope = '';
  const player = createVoicePlayer(factory, () => ctx?.requestRender());
  return {
    id: 'voice-player',
    commands: [],
    player,
    mount(c) {
      off?.();
      ctx = c;
      lastScope = scopeKeyOf(c.scope());
      // stop on conversation / account change; no timers
      off = c.subscribe(() => {
        if (ctx !== c) return; // disposed or remounted: a stale subscription must not stop the new one's clip
        const s = c.scope();
        const next = scopeKeyOf(s);
        if (next !== lastScope) {
          lastScope = next;
          player.stop();
        }
      });
    },
    dispose() {
      off?.();
      off = null;
      ctx = null;
      lastScope = '';
      player.stop();
    },
  };
}
