/**
 * Nephele uploads (docs/api/authentication.md "图片上传：独立授权",
 * "普通文件上传：另一条链路", "视频上传与处理").
 *
 * Image:  uploadTokenCreate{channel:'im_business', type:'img'} →
 *         POST https://nephele.ctrip.com/image/v2/api/upload?channel=im_business&scene={scene}&rand={rand}
 *         raw bytes (not multipart), `Authorization: Nephele {rand32}/{yyyyMMddHHmm}/{channel}/{btoa('token:'+token)}`,
 *         `Content-MD5` = hex MD5 of the bytes, `Content-Type` = mime.
 *         Success only when `Code === 2000` and `Content.url` is present.
 * File:   POST /file/v1/api/upload?channel=im&public=1 raw bytes, NO auth, NO MD5; `{file_name, url}`.
 * Video:  token {channel:'im', type:'video'} → /video/v3/api/upload?channel=im&rand= with auth + MD5
 *         → /video/v1/api/proc?video={file_name} JSON `{"extract":{"interval":20,"end_second":3}}`.
 *
 * Upload success is NOT a sent message: these functions return a `MediaRef`
 * that `send.ts` turns into a message. Token lifetime/reuse is unverified,
 * so a fresh token is fetched per upload.
 */

import type { AdapterDeps, FetchInit } from './deps.ts';
import { Endpoints } from './endpoints.ts';
import { businessHead } from './heads.ts';
import { md5Hex } from './md5.ts';
import type { SoaClient, SoaOutcome } from './soa.ts';
import type { MediaFileRef, MediaImageRef, MediaVideoRef } from './send.ts';

export const NEPHELE_HOST = 'https://nephele.ctrip.com';
export const NEPHELE_ALPHABET = 'ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678';
export const NEPHELE_OK_CODE = 2000;
export const IMAGE_CHANNEL = 'im_business';
export const FILE_CHANNEL = 'im';
export const VIDEO_CHANNEL = 'im';

/** `randomString(32)` from the observed alphabet, driven by the injected RNG. */
export function nepheleRandomString(random: () => number, length = 32): string {
  let s = '';
  for (let i = 0; i < length; i++) {
    const idx = Math.min(NEPHELE_ALPHABET.length - 1, Math.floor(random() * NEPHELE_ALPHABET.length));
    s += NEPHELE_ALPHABET[idx];
  }
  return s;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** `btoa` equivalent for Latin-1/ASCII strings (tokens are ASCII). */
export function base64Latin1(s: string): string {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c1 = s.charCodeAt(i++) & 0xff;
    const has2 = i < s.length;
    const c2 = has2 ? s.charCodeAt(i++) & 0xff : 0;
    const has3 = i < s.length;
    const c3 = has3 ? s.charCodeAt(i++) & 0xff : 0;
    out += B64[c1 >> 2];
    out += B64[((c1 & 3) << 4) | (c2 >> 4)];
    out += has2 ? B64[((c2 & 15) << 2) | (c3 >> 6)] : '=';
    out += has3 ? B64[c3 & 63] : '=';
  }
  return out;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** `yyyyMMddHHmm` in the browser's local time (the source uses local getters). */
export function formatNepheleDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}${pad2(d.getHours())}${pad2(d.getMinutes())}`;
}

export function nepheleAuthorization(parts: { rand32: string; dateStamp: string; channel: string; token: string }): string {
  return `Nephele ${parts.rand32}/${parts.dateStamp}/${parts.channel}/${base64Latin1(`token:${parts.token}`)}`;
}

export type UploadFailure =
  | { readonly kind: 'token_failed'; readonly outcome: SoaOutcome<unknown> }
  | { readonly kind: 'http_error'; readonly httpStatus: number }
  | { readonly kind: 'network_error' }
  | { readonly kind: 'malformed' }
  | { readonly kind: 'rejected'; readonly code: number | null; readonly message: string };

interface TokenResponse {
  readonly token?: unknown;
}

async function fetchToken(deps: AdapterDeps, soa: SoaClient, channel: string, type: 'img' | 'video'): Promise<{ token: string } | UploadFailure> {
  const outcome = await soa.post<TokenResponse>(Endpoints.UPLOAD_TOKEN_CREATE, { head: businessHead(deps.context), channel, type });
  if (outcome.kind !== 'success' || typeof outcome.body.token !== 'string' || outcome.body.token === '') return { kind: 'token_failed', outcome };
  return { token: outcome.body.token };
}

interface RawPost {
  readonly status: number;
  readonly json: unknown;
}

async function rawPost(deps: AdapterDeps, url: string, headers: Record<string, string>, body: Uint8Array | string): Promise<RawPost | UploadFailure> {
  const init: FetchInit = { method: 'POST', headers, body, credentials: 'include' };
  let status: number;
  let text: string;
  try {
    const res = await deps.fetch(url, init);
    status = res.status;
    text = await res.text();
  } catch {
    return { kind: 'network_error' };
  }
  if (status < 200 || status >= 300) return { kind: 'http_error', httpStatus: status };
  try {
    return { status, json: JSON.parse(text) };
  } catch {
    return { kind: 'malformed' };
  }
}

function isFailure(x: unknown): x is UploadFailure {
  return typeof x === 'object' && x !== null && 'kind' in x;
}

interface NepheleEnvelope {
  readonly Code?: unknown;
  readonly Message?: unknown;
  readonly Content?: unknown;
}

function nepheleContent(json: unknown): Record<string, unknown> | UploadFailure {
  const env = (typeof json === 'object' && json !== null ? json : {}) as NepheleEnvelope;
  const code = typeof env.Code === 'number' ? env.Code : null;
  if (code !== NEPHELE_OK_CODE) return { kind: 'rejected', code, message: typeof env.Message === 'string' ? env.Message : '' };
  if (typeof env.Content !== 'object' || env.Content === null) return { kind: 'malformed' };
  return env.Content as Record<string, unknown>;
}

// ------------------------------------------------------------- image

export interface ImageUploadInput {
  readonly bytes: Uint8Array;
  readonly mime: string;
  /** Upload scene; dynamic per page, injected (also echoed into the message `ext.scene`). */
  readonly scene: string;
  readonly width: number;
  readonly height: number;
}

export type ImageUploadResult = { readonly kind: 'uploaded'; readonly media: MediaImageRef; readonly fileName: string } | { readonly kind: 'failed'; readonly failure: UploadFailure };

export async function uploadImage(deps: AdapterDeps, soa: SoaClient, input: ImageUploadInput): Promise<ImageUploadResult> {
  const tok = await fetchToken(deps, soa, IMAGE_CHANNEL, 'img');
  if (isFailure(tok)) return { kind: 'failed', failure: tok };
  const rand = nepheleRandomString(deps.random);
  const url = `${NEPHELE_HOST}/image/v2/api/upload?channel=${IMAGE_CHANNEL}&scene=${encodeURIComponent(input.scene)}&rand=${encodeURIComponent(rand)}`;
  const headers = {
    Accept: 'application/json, text/plain, */*',
    Authorization: nepheleAuthorization({ rand32: nepheleRandomString(deps.random), dateStamp: formatNepheleDate(deps.now()), channel: IMAGE_CHANNEL, token: tok.token }),
    'Content-MD5': md5Hex(input.bytes),
    'Content-Type': input.mime,
  };
  const res = await rawPost(deps, url, headers, input.bytes);
  if (isFailure(res)) return { kind: 'failed', failure: res };
  const content = nepheleContent(res.json);
  if (isFailure(content)) return { kind: 'failed', failure: content };
  const fileUrl = content['url'];
  if (typeof fileUrl !== 'string' || fileUrl === '') return { kind: 'failed', failure: { kind: 'malformed' } };
  return {
    kind: 'uploaded',
    fileName: typeof content['file_name'] === 'string' ? (content['file_name'] as string) : '',
    media: { kind: 'image', url: fileUrl, thumbUrl: fileUrl, width: input.width, height: input.height, scene: input.scene, channel: IMAGE_CHANNEL },
  };
}

// ------------------------------------------------------------- file

export interface FileUploadInput {
  readonly bytes: Uint8Array;
  readonly mime: string;
  readonly filename: string;
}

export type FileUploadResult = { readonly kind: 'uploaded'; readonly media: MediaFileRef } | { readonly kind: 'failed'; readonly failure: UploadFailure };

export async function uploadFile(deps: AdapterDeps, input: FileUploadInput): Promise<FileUploadResult> {
  const url = `${NEPHELE_HOST}/file/v1/api/upload?channel=${FILE_CHANNEL}&public=1`;
  const res = await rawPost(deps, url, { Accept: 'application/json, text/plain, */*', 'Content-Type': input.mime }, input.bytes);
  if (isFailure(res)) return { kind: 'failed', failure: res };
  const j = (typeof res.json === 'object' && res.json !== null ? res.json : {}) as { file_name?: unknown; url?: unknown };
  if (typeof j.url !== 'string' || j.url === '') return { kind: 'failed', failure: { kind: 'malformed' } };
  return { kind: 'uploaded', media: { kind: 'file', filename: input.filename, url: j.url, size: input.bytes.length } };
}

// ------------------------------------------------------------- video

export interface VideoUploadInput {
  readonly bytes: Uint8Array;
  readonly mime: string;
  readonly filename: string;
}

export interface VideoProcResult {
  readonly cover: string;
  readonly samples: readonly string[];
}

export type VideoUploadResult =
  | { readonly kind: 'uploaded'; readonly media: MediaVideoRef; readonly previewUrl: string; readonly proc: VideoProcResult | null }
  | { readonly kind: 'failed'; readonly failure: UploadFailure; readonly stage: 'token' | 'upload' | 'proc' };

export const VIDEO_PROC_BODY = { extract: { interval: 20, end_second: 3 } } as const;

export async function uploadVideo(deps: AdapterDeps, soa: SoaClient, input: VideoUploadInput): Promise<VideoUploadResult> {
  const tok = await fetchToken(deps, soa, VIDEO_CHANNEL, 'video');
  if (isFailure(tok)) return { kind: 'failed', failure: tok, stage: 'token' };
  const rand = nepheleRandomString(deps.random);
  const url = `${NEPHELE_HOST}/video/v3/api/upload?channel=${VIDEO_CHANNEL}&rand=${encodeURIComponent(rand)}`;
  const headers = {
    Accept: 'application/json, text/plain, */*',
    Authorization: nepheleAuthorization({ rand32: nepheleRandomString(deps.random), dateStamp: formatNepheleDate(deps.now()), channel: VIDEO_CHANNEL, token: tok.token }),
    'Content-MD5': md5Hex(input.bytes),
    'Content-Type': input.mime,
  };
  const res = await rawPost(deps, url, headers, input.bytes);
  if (isFailure(res)) return { kind: 'failed', failure: res, stage: 'upload' };
  const content = nepheleContent(res.json);
  if (isFailure(content)) return { kind: 'failed', failure: content, stage: 'upload' };
  const fileName = typeof content['file_name'] === 'string' ? (content['file_name'] as string) : '';
  const previewUrl = typeof content['preview_url'] === 'string' ? (content['preview_url'] as string) : '';
  if (fileName === '') return { kind: 'failed', failure: { kind: 'malformed' }, stage: 'upload' };
  const video = (typeof content['video'] === 'object' && content['video'] !== null ? content['video'] : {}) as Record<string, unknown>;
  const num = (k: string): number => (typeof video[k] === 'number' ? (video[k] as number) : 0);
  const size = typeof content['size'] === 'number' ? (content['size'] as number) : input.bytes.length;

  // frame extraction for the cover; failure here keeps the upload but marks proc null
  const procUrl = `${NEPHELE_HOST}/video/v1/api/proc?video=${encodeURIComponent(fileName)}`;
  const procRes = await rawPost(deps, procUrl, { Accept: 'application/json, text/plain, */*', 'Content-Type': 'application/json' }, JSON.stringify(VIDEO_PROC_BODY));
  let proc: VideoProcResult | null = null;
  if (!isFailure(procRes)) {
    const image = (typeof procRes.json === 'object' && procRes.json !== null ? (procRes.json as { image?: unknown }).image : null) as Record<string, unknown> | null;
    if (image && typeof image === 'object') {
      const cover = typeof image['conver'] === 'string' ? (image['conver'] as string) : typeof image['cover'] === 'string' ? (image['cover'] as string) : '';
      const samples = Array.isArray(image['samples']) ? (image['samples'] as unknown[]).filter((s): s is string => typeof s === 'string') : [];
      proc = { cover, samples };
    }
  }
  return {
    kind: 'uploaded',
    previewUrl,
    proc,
    media: {
      kind: 'video',
      filename: fileName,
      cover: proc?.cover ?? previewUrl,
      url: previewUrl,
      duration: num('duration'),
      size,
      width: num('width'),
      height: num('height'),
    },
  };
}
