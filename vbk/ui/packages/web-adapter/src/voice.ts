/**
 * I-30c voice messages (FE-12): URL / format extraction only.
 *
 * Nothing in the repo's evidence shows the `msgtype` number or the body shape
 * of a voice message (the official enum lists an audio type, the captures
 * never contained one). Guessing either would mis-render other messages, so:
 *
 * - `VOICE_MSGTYPE` is `null` (feature off) until a real sample fixes it; the
 *   host/page glue passes the verified value through `parseVoiceBody`'s
 *   `msgtype` option, and tests pin the parser against SYNTHETIC bodies only.
 * - the parser is tolerant about where the URL sits (`url`, `audio.url`,
 *   `voice.url`) but strict about what is playable: https, no credentials,
 *   and a host the page CSP `media-src` already permits.
 * - duration is NOT derived: the unit (s or ms) is unobserved. The player
 *   reads it from the loaded media element instead.
 */

import { recordOrNull } from './soa.ts';
import type { AdapterFeature } from './features.ts';

export const VOICE_MSGTYPE: number | null = null;

/** Mirrors `media-src` in `apps/main/index.html` / `tauri.conf.json`. */
export const VOICE_HOST_SUFFIXES = ['.c-ctrip.com', '.tripcdn.com', '.ctrip.com'] as const;

export interface VoiceClip {
  readonly url: string;
  /** Lower-case file extension when the URL path has one (`mp3`, `amr`, `m4a`, `wav`, `ogg`, `aac`), else null. */
  readonly format: string | null;
}

export function playableVoiceUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value === '') return null;
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    if (u.port !== '' && u.port !== '443') return null;
    const host = u.hostname.toLowerCase();
    return VOICE_HOST_SUFFIXES.some((s) => host.endsWith(s)) ? u.href : null;
  } catch {
    return null;
  }
}

export function voiceFormatOf(url: string): string | null {
  try {
    const m = /\.([A-Za-z0-9]{2,4})$/.exec(new URL(url).pathname);
    const ext = m?.[1]?.toLowerCase() ?? null;
    return ext !== null && ['mp3', 'amr', 'm4a', 'wav', 'ogg', 'aac'].includes(ext) ? ext : null;
  } catch {
    return null;
  }
}

function jsonObject(body: unknown): Record<string, unknown> | null {
  if (typeof body === 'string') {
    try {
      return recordOrNull(JSON.parse(body));
    } catch {
      return null;
    }
  }
  return recordOrNull(body);
}

/**
 * `null` unless `msgtype` equals the configured voice type AND a playable URL
 * is found. `options.msgtype` overrides the (null) default once verified.
 */
export function parseVoiceBody(msgtype: unknown, body: unknown, options: { readonly msgtype?: number | null } = {}): VoiceClip | null {
  const expected = options.msgtype !== undefined ? options.msgtype : VOICE_MSGTYPE;
  if (expected === null) return null;
  const n = typeof msgtype === 'number' ? msgtype : typeof msgtype === 'string' && /^\d+$/.test(msgtype) ? Number(msgtype) : null;
  if (n !== expected) return null;
  const obj = jsonObject(body);
  if (!obj) return null;
  const candidates = [obj['url'], recordOrNull(obj['audio'])?.['url'], recordOrNull(obj['voice'])?.['url']];
  for (const c of candidates) {
    const url = playableVoiceUrl(c);
    if (url !== null) return { url, format: voiceFormatOf(url) };
  }
  return null;
}

/** No ops: playback is entirely local to the UI; the adapter only supplies `parseVoiceBody` to the display mapper. */
export const voiceFeature: AdapterFeature = { id: 'voice', ops: {} };
