/**
 * I-30c voice messages (FE-12): body parsing only. Playback lives in the UI.
 *
 * Evidence (official desktop imWindow bundle plus one real CBZ09 sample):
 * - legacy bubble: `messageType 4`, `audio.{filename,url,duration,size,secret}`;
 * - new bubble: `messageType 7` + `action: CBZ09`, `ext.{url,duration,content,filename,path,size}`;
 *   the bubble text is `ext.content || content || title`.
 *
 * - the parser is tolerant about where the URL sits but strict about what is
 *   playable: https, no credentials, and a host the page CSP `media-src` already
 *   permits. Anything else yields `media_url: null` (the UI's unavailable state).
 * - duration is whole seconds (unit inferred from the official `N"` label); a
 *   value that cannot be seconds becomes null rather than being guessed at.
 * - `audio.secret`, `size` and `path` are never carried to the UI.
 */

import { recordOrNull } from './soa.ts';
import type { AdapterFeature } from './features.ts';

export const VOICE_MSGTYPE = 4;
export const VOICE_CARD_MSGTYPE = 7;
export const VOICE_CARD_ACTION = 'CBZ09';
/** Longer values are not a plausible voice clip in seconds (possibly another unit): treated as unknown. */
const VOICE_MAX_DURATION_S = 3600;

/** Mirrors `media-src` in `apps/main/index.html` / `tauri.conf.json`. */
export const VOICE_HOST_SUFFIXES = ['.c-ctrip.com', '.tripcdn.com', '.ctrip.com'] as const;

export interface VoiceClip {
  readonly url: string;
  /** Lower-case file extension when the URL path has one (`mp3`, `amr`, `m4a`, `wav`, `ogg`, `aac`), else null. */
  readonly format: string | null;
}

/** Display fields of a voice message; recognized voice with no playable URL has `media_url: null`. */
export interface VoiceMessage {
  readonly media_url: string | null;
  readonly voice_duration_s: number | null;
  /** Transcript (`ext.content`, then the official fallbacks); empty on the legacy bubble. */
  readonly text: string;
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

function typeNumber(msgtype: unknown): number | null {
  return typeof msgtype === 'number' ? msgtype : typeof msgtype === 'string' && /^\d+$/.test(msgtype.trim()) ? Number(msgtype.trim()) : null;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Positive seconds (number or numeric string) as a whole number, else null. */
export function voiceDurationSeconds(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d+(\.\d+)?$/.test(value.trim()) ? Number(value.trim()) : NaN;
  if (!Number.isFinite(n) || n <= 0 || n > VOICE_MAX_DURATION_S) return null;
  return Math.max(1, Math.round(n));
}

/** Both official shapes; a type 7 row is voice only with `action: CBZ09`. */
export function isVoiceMessage(msgtype: unknown, body: unknown): boolean {
  const type = typeNumber(msgtype);
  if (type === VOICE_MSGTYPE) return true;
  return type === VOICE_CARD_MSGTYPE && jsonObject(body)?.['action'] === VOICE_CARD_ACTION;
}

export function parseVoiceMessage(msgtype: unknown, body: unknown): VoiceMessage | null {
  if (!isVoiceMessage(msgtype, body)) return null;
  const obj = jsonObject(body);
  const ext = recordOrNull(obj?.['ext']), audio = recordOrNull(obj?.['audio']), voice = recordOrNull(obj?.['voice']);
  const sources = [ext, audio, obj, voice];
  let media_url: string | null = null, voice_duration_s: number | null = null;
  for (const source of sources) {
    media_url ??= playableVoiceUrl(source?.['url']);
    voice_duration_s ??= voiceDurationSeconds(source?.['duration']);
  }
  // Official order; the `[Voice-to-Te...` title only shows when nothing else exists.
  const text = typeNumber(msgtype) === VOICE_CARD_MSGTYPE ? nonEmpty(ext?.['content']) ?? nonEmpty(obj?.['content']) ?? nonEmpty(obj?.['title']) ?? '' : '';
  return { media_url, voice_duration_s, text };
}

/** The playable clip of a voice message, `null` for anything else. */
export function parseVoiceBody(msgtype: unknown, body: unknown): VoiceClip | null {
  const url = parseVoiceMessage(msgtype, body)?.media_url ?? null;
  return url === null ? null : { url, format: voiceFormatOf(url) };
}

/** No ops: playback is entirely local to the UI; the adapter only supplies `parseVoiceMessage` to the display mapper. */
export const voiceFeature: AdapterFeature = { id: 'voice', ops: {} };
