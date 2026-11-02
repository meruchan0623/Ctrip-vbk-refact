/**
 * Official upload limits (I-14). TypeScript mirror of `core_im::media_limits`;
 * both are locked to docs/api/media-attachment-contract.md by their tests.
 * Pure: no I/O, no clock. A violation always means "nothing submitted".
 */
export const MIB = 1024 * 1024;
export const IMAGE_MAX_BYTES = 10 * MIB;
export const FILE_MAX_BYTES = 30 * MIB;
export const VIDEO_MAX_BYTES = 300 * MIB;
export const VIDEO_MAX_DURATION_MS = 180_000;
export const MAX_FILES_PER_SEND = 10;
export const VIDEO_CHUNK_BYTES = 5 * MIB;
export const DIRECT_UPLOAD_MAX_BYTES = 30 * MIB;

export type MediaKind = 'image' | 'file' | 'video';
export type LimitCode =
  | 'media.empty' | 'media.too_large' | 'media.video_too_long' | 'media.video_duration_unknown'
  | 'media.too_many_files' | 'media.chunked_upload_unsupported' | 'media.unknown_kind';
export type LimitResult = { readonly ok: true } | { readonly ok: false; readonly code: LimitCode };
const OK: LimitResult = { ok: true };
const no = (code: LimitCode): LimitResult => ({ ok: false, code });

export function maxBytes(kind: MediaKind): number {
  return kind === 'image' ? IMAGE_MAX_BYTES : kind === 'file' ? FILE_MAX_BYTES : VIDEO_MAX_BYTES;
}
export function isMediaKind(value: unknown): value is MediaKind {
  return value === 'image' || value === 'file' || value === 'video';
}

/** Size only (the duration of a video is known later, after decoding). */
export function checkMediaSize(kind: unknown, size: unknown): LimitResult {
  if (!isMediaKind(kind)) return no('media.unknown_kind');
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) return no('media.empty');
  return size > maxBytes(kind) ? no('media.too_large') : OK;
}

/** Size plus, for video, a mandatory decoded duration of at most three minutes. */
export function checkMediaAttachment(kind: unknown, size: unknown, durationMs: number | null | undefined): LimitResult {
  const sized = checkMediaSize(kind, size);
  if (!sized.ok || kind !== 'video') return sized;
  if (durationMs === null || durationMs === undefined || !Number.isFinite(durationMs) || durationMs <= 0) return no('media.video_duration_unknown');
  return durationMs > VIDEO_MAX_DURATION_MS ? no('media.video_too_long') : OK;
}

export function checkMediaBatch(count: number): LimitResult {
  return Number.isSafeInteger(count) && count >= 0 && count <= MAX_FILES_PER_SEND ? OK : no('media.too_many_files');
}

export type UploadPlan = { readonly kind: 'direct' } | { readonly kind: 'chunked'; readonly chunkBytes: number; readonly chunks: number };
export function planUpload(size: number): UploadPlan {
  return size <= DIRECT_UPLOAD_MAX_BYTES ? { kind: 'direct' } : { kind: 'chunked', chunkBytes: VIDEO_CHUNK_BYTES, chunks: Math.ceil(size / VIDEO_CHUNK_BYTES) };
}

/** Chunked upload is specified but not implemented: refuse what only chunking could carry. */
export function checkStaging(size: number): LimitResult {
  return planUpload(size).kind === 'direct' ? OK : no('media.chunked_upload_unsupported');
}

/** Everything this build can actually send. */
export function checkMediaSendable(kind: unknown, size: unknown, durationMs: number | null | undefined): LimitResult {
  const admitted = checkMediaAttachment(kind, size, durationMs);
  return admitted.ok ? checkStaging(size as number) : admitted;
}
