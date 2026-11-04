/**
 * Keeps the official page's notification tones out of the OS media session.
 *
 * The official IM code plays them through a page `<audio autoplay>` (evidence:
 * `docs/research/2026-10-30-web-reminders.md`, `playVoice`), which WebKit
 * publishes as "now playing" under the page title. Reminder sounds belong to
 * the host (`notify://play-sound` → `apps/main/sound.ts`, WebAudio), so here
 * an `<audio>` may only start from a user gesture: tones never do, and a voice
 * clip the user clicks still plays. `<video>` is left alone.
 *
 * Runs at document start, before page scripts. Touches media elements only: no
 * IPC, network or storage, so it is also safe in pages with no capability.
 */

interface MediaLike {
  pause(): void;
  play(): Promise<void>;
}

export interface ToneSilencerWindow {
  readonly HTMLMediaElement?: unknown;
  readonly HTMLAudioElement?: unknown;
  readonly navigator?: { readonly userActivation?: { readonly isActive?: boolean } };
  addEventListener?(type: string, cb: (event: { readonly target: unknown }) => void, capture: boolean): void;
}

/** Returns false when the page has no media element classes to guard. */
export function installToneSilencer(win: ToneSilencerWindow): boolean {
  const media = win.HTMLMediaElement;
  const audio = win.HTMLAudioElement;
  if (typeof media !== 'function' || typeof audio !== 'function') return false;
  const isAudio = (el: unknown): el is MediaLike => el instanceof audio;
  const unattended = (el: unknown): el is MediaLike => isAudio(el) && win.navigator?.userActivation?.isActive !== true;

  // `autoplay` set by script: dropped outright, so WebKit never opens a session.
  const proto = media.prototype as MediaLike;
  const autoplay = Object.getOwnPropertyDescriptor(proto, 'autoplay');
  if (autoplay?.set) {
    const set = autoplay.set;
    Object.defineProperty(proto, 'autoplay', {
      ...autoplay,
      set(this: unknown, value: unknown) {
        if (!isAudio(this)) set.call(this, value);
      },
    });
  }

  const play = proto.play;
  proto.play = function (this: MediaLike): Promise<void> {
    // The same refusal a browser's own autoplay policy gives.
    return unattended(this) ? Promise.reject(new DOMException('tone suppressed', 'NotAllowedError')) : play.call(this);
  };

  // `autoplay` from markup or `setAttribute` reaches neither hook above.
  win.addEventListener?.('play', (event) => {
    if (unattended(event.target)) event.target.pause();
  }, true);
  return true;
}
