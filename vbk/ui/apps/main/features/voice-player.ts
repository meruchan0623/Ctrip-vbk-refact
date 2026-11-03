/**
 * I-30c voice playback (FE-12), main-window half.
 *
 * The voice message type and body are not captured yet (see
 * `web-adapter/src/voice.ts`), so no message is rendered as voice today; this
 * module is the playback controller the message renderer calls once the
 * adapter yields a `VoiceClip`. Rules:
 * - one clip at a time; starting another stops the first;
 * - only https URLs on the hosts the page CSP `media-src` already allows;
 * - playback stops when the conversation or account changes or the module is
 *   disposed (a clip never keeps playing for a conversation that is no longer
 *   open);
 * - a failed load is reported once, never retried in a loop.
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

/** The slice of `HTMLAudioElement` the controller needs. */
export interface AudioLike {
  play(): Promise<void>;
  pause(): void;
  onended: (() => void) | null;
  onerror: (() => void) | null;
}

export type VoiceState = 'idle' | 'playing' | 'error';

export interface VoicePlayer {
  state(url: string): VoiceState;
  /** Plays `url` (stopping any other clip) or pauses it when it is already playing. */
  toggle(url: string): Promise<VoiceState>;
  stop(): void;
}

export function createVoicePlayer(factory: (url: string) => AudioLike, onChange: () => void): VoicePlayer {
  let current: { readonly url: string; readonly audio: AudioLike } | null = null;
  const errored = new Set<string>();

  function release(): void {
    if (!current) return;
    const { audio } = current;
    audio.onended = null;
    audio.onerror = null;
    try {
      audio.pause();
    } catch {
      // already gone
    }
    current = null;
  }

  return {
    state(url) {
      if (current?.url === url) return 'playing';
      return errored.has(url) ? 'error' : 'idle';
    },
    async toggle(url) {
      if (!isPlayableVoiceUrl(url)) {
        errored.add(url);
        onChange();
        return 'error';
      }
      if (current?.url === url) {
        release();
        onChange();
        return 'idle';
      }
      release();
      errored.delete(url);
      const audio = factory(url);
      const mine = { url, audio };
      current = mine;
      audio.onended = () => {
        if (current === mine) {
          release();
          onChange();
        }
      };
      audio.onerror = () => {
        if (current === mine) {
          release();
          errored.add(url);
          onChange();
        }
      };
      try {
        await audio.play();
      } catch {
        if (current === mine) release();
        errored.add(url);
        onChange();
        return 'error';
      }
      onChange();
      return current === mine ? 'playing' : 'idle';
    },
    stop() {
      const was = current !== null;
      release();
      if (was) onChange();
    },
  };
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
  };
  return wrapper;
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
      ctx = c;
      // stop on conversation / account change; no timers
      off = c.subscribe(() => {
        const s = c.scope();
        const next = s ? `${s.account.account_id}|${s.account.session_generation}|${s.gid ?? ''}` : '';
        if (next !== lastScope) {
          lastScope = next;
          player.stop();
        }
      });
    },
    dispose() {
      off?.();
      off = null;
      player.stop();
      ctx = null;
    },
  };
}
