/** Bounded local staging -> one upload -> one SDK send. No filesystem access. */
import type { RpcContext } from './rpc.ts';
import type { MediaTarget, MediaUploadReply, MediaSendReply } from '../../ipc/src/adapterProtocol.ts';
import type { MediaRef } from './send.ts';
import { createMediaSendIntent, mediaMessageJson, submitIntent } from './send.ts';
import { uploadFile, uploadImage, uploadVideo, type UploadFailure } from './upload.ts';

export const MEDIA_LOCAL_CAP = 10 * 1024 * 1024;
export const MEDIA_CHUNK_CAP = 256 * 1024;
export const MEDIA_TARGET_TTL = 5 * 60 * 1000;
/** Official installed 1.2.12/ares1.2.17 constant, also observed in evidence44. */
export const IMAGE_SCENE = 'cqDA0M7F6aAGHF06jzBe';
interface Target { gid: string; identity: string; expires: number; current: () => boolean }
interface Transfer {
  target: Target; token: string; name: string; kind: 'image' | 'file' | 'video'; mime: string;
  sha256: string; bytes: Uint8Array; received: number;
  upload?: Promise<MediaUploadReply>; media?: MediaRef; body?: string;
  send?: { local: string; promise: Promise<MediaSendReply> };
}
function error(): never { throw new Error('media target, staged bytes or local capability is invalid'); }
function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : error(); }
function string(a: Record<string, unknown>, key: string): string { const v = a[key]; return typeof v === 'string' && v.length > 0 && v.length <= 1024 ? v : error(); }
function safeUrl(value: string): boolean {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && (!u.port || u.port === '443') && ['ctrip.com', 'c-ctrip.com', 'tripcdn.com'].some(d => u.hostname === d || u.hostname.endsWith(`.${d}`)); } catch { return false; }
}
function uploadFailure(failure: UploadFailure): MediaUploadReply {
  const explicit = failure.kind === 'rejected' || (failure.kind === 'token_failed' && ['business_failure', 'auth_invalid'].includes(failure.outcome.kind));
  return { kind: explicit ? 'rejected' : 'unknown', media: null, body_json: null, error: failure.kind === 'token_failed' ? 'upload token acquisition did not complete; no file upload was started; do not retry automatically' : 'file upload did not produce verified resource metadata; do not retry automatically' };
}
export function createMediaRpc(ctx: RpcContext) {
  const targets = new Map<string, Target>();
  const transfers = new Map<string, Transfer>();
  const identity = (gid: string): string => {
    const v = ctx.store.view(gid);
    const jid = ctx.sdk.partnerJidOf(gid);
    if (!v || !v.sessionId || !v.customerUid || !v.serviceType || !v.conversationType || !ctx.roles.selfUid || !jid) error();
    return JSON.stringify([gid, v.orderId, v.sessionId, v.customerUid, v.conversationType, v.serviceType, v.threadId, v.conversationKey ?? null, v.worksheetId, jid, ctx.roles.selfUid, ctx.deps.context]);
  };
  const valid = (a: Record<string, unknown>): Target => {
    const token = string(a, 'target_token'), gid = string(a, 'gid');
    const t = targets.get(token);
    if (!t || t.gid !== gid || !t.current() || t.expires <= ctx.deps.now() || identity(gid) !== t.identity) error();
    return t;
  };
  const transfer = (a: Record<string, unknown>, replay = false): Transfer => {
    const r = transfers.get(string(a, 'transfer_id'));
    if (!r || r.token !== a['target_token'] || r.target.gid !== a['gid'] || !r.target.current()) error();
    if (replay && (r.upload || r.send)) return r;
    const t = valid(a);
    if (r.target !== t) error();
    return r;
  };
  const digest = async (bytes: Uint8Array): Promise<string> => {
    if (!ctx.deps.sha256) error();
    const hash = await ctx.deps.sha256(bytes);
    if (!/^[a-f0-9]{64}$/.test(hash)) error();
    return hash;
  };
  return {
    async target(args: unknown): Promise<MediaTarget> {
      const a = object(args), gid = string(a, 'gid'), token = string(a, 'target_token');
      for (const [key, value] of transfers) if (!value.target.current() || value.target.expires <= ctx.deps.now()) transfers.delete(key);
      for (const [key, value] of targets) if (!value.current() || value.expires <= ctx.deps.now()) { targets.delete(key); for (const [id, r] of transfers) if (r.target === value) transfers.delete(id); }
      if (targets.has(token) || targets.size >= 16) error();
      const current = ctx.captureWriteGuard?.() ?? (() => true);
      if (!current()) error();
      const id = identity(gid), hash = await digest(new TextEncoder().encode(id));
      if (!current() || identity(gid) !== id) error();
      targets.set(token, { gid, identity: id, current, expires: ctx.deps.now() + MEDIA_TARGET_TTL });
      return { target_token: token, identity_sha256: hash, sender_id: ctx.roles.selfUid };
    },
    async validate(args: unknown): Promise<MediaTarget> {
      const a = object(args), t = valid(a), hash = await digest(new TextEncoder().encode(t.identity));
      valid(a);
      return { target_token: string(a, 'target_token'), identity_sha256: hash, sender_id: ctx.roles.selfUid };
    },
    async release(args: unknown): Promise<null> {
      const a = object(args), token = string(a, 'target_token'), gid = string(a, 'gid');
      const t = targets.get(token);
      if (t && t.gid !== gid) error();
      targets.delete(token);
      for (const [key, r] of transfers) if (r.token === token && !r.upload && !r.send) transfers.delete(key);
      return null;
    },
    async discard(args: unknown): Promise<null> {
      const a = object(args), id = string(a, 'transfer_id'), token = string(a, 'target_token'), gid = string(a, 'gid');
      const r = transfers.get(id);
      if (r && (r.token !== token || r.target.gid !== gid)) error();
      if (r && !r.upload && !r.send) transfers.delete(id);
      return null;
    },
    async begin(args: unknown): Promise<null> {
      const a = object(args), t = valid(a), id = string(a, 'transfer_id');
      const kind = a['kind'], size = a['size'], name = string(a, 'name'), mime = string(a, 'mime'), hash = string(a, 'sha256');
      const stagedBytes = [...transfers.values()].reduce((n, transfer) => n + transfer.bytes.length, 0);
      if (!['image', 'file', 'video'].includes(String(kind)) || !Number.isSafeInteger(size) || Number(size) <= 0 || Number(size) > MEDIA_LOCAL_CAP || stagedBytes + Number(size) > 2 * MEDIA_LOCAL_CAP || !/^[a-f0-9]{64}$/.test(hash) || /[\\/\x00-\x1f]/.test(name) || transfers.has(id) || transfers.size >= 128) error();
      if (kind === 'image' && !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mime)) error();
      if (kind === 'video' && mime !== 'video/mp4') error();
      transfers.set(id, { target: t, token: string(a, 'target_token'), name, kind: kind as Transfer['kind'], mime, sha256: hash, bytes: new Uint8Array(Number(size)), received: 0 });
      return null;
    },
    async chunk(args: unknown): Promise<null> {
      const a = object(args), r = transfer(a), data = a['data'], offset = a['offset'];
      if (r.upload || typeof data !== 'string' || data.length === 0 || data.length > Math.ceil(MEDIA_CHUNK_CAP / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data) || offset !== r.received) error();
      const raw = atob(data);
      if (raw.length === 0 || raw.length > MEDIA_CHUNK_CAP || r.received + raw.length > r.bytes.length) error();
      r.bytes.set(Uint8Array.from(raw, c => c.charCodeAt(0)), r.received);
      r.received += raw.length;
      return null;
    },
    async upload(args: unknown): Promise<MediaUploadReply> {
      const a = object(args), r = transfer(a, true);
      if (r.upload) return r.upload;
      r.upload = (async () => {
        let started = false;
        try {
          if (r.received !== r.bytes.length || await digest(r.bytes) !== r.sha256) error();
          valid(a);
          const dimensions = r.kind === 'file' ? null : await ctx.deps.mediaProbe?.(r.kind, r.mime, r.bytes);
          valid(a);
          if (r.kind !== 'file' && (!dimensions || !Number.isFinite(dimensions.width) || !Number.isFinite(dimensions.height) || dimensions.width <= 0 || dimensions.height <= 0)) return { kind: 'not_submitted', media: null, body_json: null, error: 'local media decoding failed' } as const;
          if (r.kind === 'video' && (!dimensions || dimensions.duration === null || !Number.isFinite(dimensions.duration) || dimensions.duration <= 0 || dimensions.duration > 180)) return { kind: 'not_submitted', media: null, body_json: null, error: 'video must decode and be at most three minutes' } as const;
          started = true;
          const result = r.kind === 'image'
            ? await uploadImage(ctx.deps, ctx.soa, { bytes: r.bytes, mime: r.mime, scene: IMAGE_SCENE, width: dimensions!.width, height: dimensions!.height, ensureCurrent: () => { valid(a); } })
            : r.kind === 'video' ? await uploadVideo(ctx.deps, ctx.soa, { bytes: r.bytes, mime: r.mime, filename: r.name, ensureCurrent: () => { valid(a); } })
              : await uploadFile(ctx.deps, { bytes: r.bytes, mime: r.mime, filename: r.name, ensureCurrent: () => { valid(a); } });
          valid(a);
          if (result.kind === 'failed') return uploadFailure(result.failure);
          const media = result.media;
          if (!safeUrl(media.url) || (media.kind === 'image' && !safeUrl(media.thumbUrl)) || (media.kind === 'video' && (!safeUrl(media.cover) || !Number.isFinite(media.duration) || media.duration <= 0 || media.duration > 180))) return { kind: 'unknown', media: null, body_json: null, error: 'upload metadata was not valid for the official media contract' } as const;
          r.media = media; r.body = mediaMessageJson(media);
          return { kind: 'uploaded', media, body_json: r.body, error: null } as const;
        } catch { return { kind: started ? 'unknown' : 'not_submitted', media: null, body_json: null, error: 'media operation lost its target or response; do not retry automatically' } as const; }
        finally { r.bytes = new Uint8Array(); }
      })();
      return r.upload;
    },
    async send(args: unknown): Promise<MediaSendReply> {
      const a = object(args), r = transfer(a, true), local = string(a, 'local_id');
      if (r.send) { if (r.send.local !== local) error(); return r.send.promise; }
      valid(a);
      if (!r.media || !r.body || a['body_json'] !== r.body || !ctx.sdk.canSend || !ctx.sdk.partnerJidOf(r.target.gid)) error();
      const media = r.media;
      const senderId = ctx.roles.selfUid, senderProfile = ctx.roles.profileOf(senderId);
      const v = ctx.store.view(r.target.gid)!;
      const base = createMediaSendIntent(ctx.deps, v.gid, media, { serviceType: v.serviceType, threadId: v.threadId });
      const intent = { ...base, localId: local, body: { ...base.body, localid: local } };
      valid(a);
      const promise = submitIntent(ctx.deps, ctx.sdk, intent, ctx.sendAckTimeoutMs ?? 15000).then(result => {
        const d = result.disposition;
        const message = { gid: v.gid, message_id: d.kind === 'confirmed' ? d.server_message_id : null, local_id: local, create_time_ms: d.kind === 'confirmed' ? d.server_time_ms : intent.createdAtMs, sender_role: 'merchant_self' as const, sender_id: senderId, sender_name: senderProfile.name, sender_avatar: senderProfile.avatar, kind: media.kind, text: '', translation: null, original: null, quote: null, order_id: v.orderId, disposition: d, media_url: media.url, media_thumbnail: media.kind === 'image' ? media.thumbUrl : media.kind === 'video' ? media.cover : null, media_filename: media.kind === 'file' || media.kind === 'video' ? media.filename : null };
        if (r.target.current() && identity(v.gid) === r.target.identity) { ctx.pushFact({ kind: 'message', fact: { ...result.fact, sender_id: senderId } }); ctx.pushDisplay({ kind: 'messages', gid: v.gid, replace: false, items: [message] }); }
        return { disposition: d, message };
      }).finally(() => { targets.delete(r.token); });
      r.send = { local, promise };
      return promise;
    },
  };
}
