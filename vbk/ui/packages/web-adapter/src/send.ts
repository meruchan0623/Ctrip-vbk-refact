/**
 * Outbound messages through the official SDK (docs/api/transports.md).
 *
 * Text body (the SDK serializes it into `<body>` and XML-escapes it; we
 * never build XML or escape strings here):
 *   `{chattype:"groupchat", biztype:<conversation.serviceType>, localid, msg, msgtype:"0", autoextend:0, threadid}`
 * `threadid` is passed as-is: an empty string stays empty, never `null`.
 * Quote: `citemsgid` is an XML attribute passed as an SDK option, not a body field.
 *
 * Dispositions:
 * - `send_result` with `error === 0` and matching `localid` → `confirmed`
 *   (`server_message_id` = `tid`, `server_time_ms` = `create_time`)
 * - `send_result` with any other `error` → `rejected`
 * - no matching ack within the timeout → `unknown`
 * `unknown` triggers NO resend and NO extra HTTP fallback: the official SDK
 * already falls back to `11679/SendMessage.json` on its own when the
 * socket is down or returns `error=-2`, and stacking another retry on top
 * is how duplicate sends happen. The host reconciles `unknown` against
 * history/compensation instead.
 *
 * Media: `msgtype:"1"` image, `"3"` video, `"5"` file; `msg` is the inner
 * JSON *as a string* (one serialization, never double-encoded).
 * Product cards go through HTTP `15529/sendCardMessageForOffline` with the
 * platform head (`cver:"1.0"`, empty extension) exactly as sampled (39).
 */

import type { MessageFact, SendDisposition } from '../../ipc/src/contracts.ts';
import type { AdapterDeps, ImSdkHandle, SdkSendBody, SdkSendResultEvent } from './deps.ts';
import { Endpoints } from './endpoints.ts';
import { platformHead } from './heads.ts';
import type { SoaClient, SoaOutcome } from './soa.ts';
import { normalizeTimeMs } from './facts.ts';

export const DEFAULT_SEND_ACK_TIMEOUT_MS = 5000;

export interface ConversationSendContext {
  /** `conversation.serviceType` (e.g. `1513` for the controlled line) — never hardcoded. */
  readonly serviceType: string;
  /** `conversation.threadId` as-is; `''` stays `''`. */
  readonly threadId: string;
}

export interface SendIntent {
  readonly gid: string;
  readonly localId: string;
  readonly createdAtMs: number;
  readonly body: SdkSendBody;
  readonly citemsgid?: string;
}

export interface MediaImageRef {
  readonly kind: 'image';
  readonly url: string;
  readonly thumbUrl: string;
  readonly width: number;
  readonly height: number;
  readonly scene: string;
  readonly channel: 'im_business';
}

export interface MediaVideoRef {
  readonly kind: 'video';
  readonly filename: string;
  readonly cover: string;
  readonly url: string;
  readonly duration: number;
  readonly size: number;
  readonly width: number;
  readonly height: number;
}

export interface MediaFileRef {
  readonly kind: 'file';
  readonly filename: string;
  readonly url: string;
  readonly size: number;
}

export type MediaRef = MediaImageRef | MediaVideoRef | MediaFileRef;

const HEX = '0123456789abcdef';

/** Stable local id from injected now + random: `<13 digit ms>-<16 hex>`. */
export function newLocalId(deps: AdapterDeps): string {
  let hex = '';
  for (let i = 0; i < 16; i++) hex += HEX[Math.floor(deps.random() * 16) % 16];
  return `${deps.now()}-${hex}`;
}

export function createSendIntent(deps: AdapterDeps, gid: string, text: string, conv: ConversationSendContext, quote?: { readonly citemsgid: string }): SendIntent {
  const localId = newLocalId(deps);
  const intent: SendIntent = {
    gid,
    localId,
    createdAtMs: deps.now(),
    body: {
      chattype: 'groupchat',
      biztype: conv.serviceType,
      localid: localId,
      msg: text,
      msgtype: '0',
      autoextend: 0,
      threadid: conv.threadId,
    },
  };
  return quote ? { ...intent, citemsgid: quote.citemsgid } : intent;
}

/** Inner JSON strings exactly as observed (image evidence 44, video 68, file 33). */
export function mediaMessageJson(media: MediaRef): string {
  switch (media.kind) {
    case 'image':
      return JSON.stringify({
        thumbUrl: media.thumbUrl,
        url: media.url,
        height: media.height,
        width: media.width,
        btype: 1,
        originImageSize: -1,
        originImageUrl: '',
        ext: { channel: media.channel, scene: media.scene },
      });
    case 'video':
      return JSON.stringify({
        btype: 3,
        video: {
          filename: media.filename,
          cover: media.cover,
          url: media.url,
          duration: media.duration,
          size: media.size,
          width: media.width,
          height: media.height,
        },
      });
    case 'file':
      return JSON.stringify({ btype: 5, file: { filename: media.filename, url: media.url, size: media.size } });
  }
}

export function createMediaSendIntent(deps: AdapterDeps, gid: string, media: MediaRef, conv: ConversationSendContext): SendIntent {
  const localId = newLocalId(deps);
  const msgtype: SdkSendBody['msgtype'] = media.kind === 'image' ? '1' : media.kind === 'video' ? '3' : '5';
  return {
    gid,
    localId,
    createdAtMs: deps.now(),
    body: {
      chattype: 'groupchat',
      biztype: conv.serviceType,
      localid: localId,
      msg: mediaMessageJson(media),
      msgtype,
      autoextend: 0,
      threadid: conv.threadId,
    },
  };
}

export interface SendResult {
  readonly intent: SendIntent;
  readonly disposition: SendDisposition;
  readonly fact: MessageFact;
}

function classifyAck(ack: SdkSendResultEvent, fallbackTime: number): SendDisposition {
  const error = typeof ack.error === 'number' ? ack.error : typeof ack.error === 'string' && /^-?\d+$/.test(ack.error) ? Number(ack.error) : null;
  if (error === 0) {
    const tid = typeof ack.tid === 'string' ? ack.tid : typeof ack.tid === 'number' ? String(ack.tid) : '';
    return { kind: 'confirmed', server_message_id: tid, server_time_ms: normalizeTimeMs(ack.create_time) ?? normalizeTimeMs(ack.ts) ?? fallbackTime };
  }
  return { kind: 'rejected', code: error === null ? 'unknown_error' : String(error), reason: typeof ack.reason === 'string' ? ack.reason : '' };
}

function factFor(intent: SendIntent, disposition: SendDisposition): MessageFact {
  return {
    gid: intent.gid,
    message_id: disposition.kind === 'confirmed' ? disposition.server_message_id : null,
    local_id: intent.localId,
    create_time_ms: disposition.kind === 'confirmed' ? disposition.server_time_ms : intent.createdAtMs,
    sender_role: 'merchant_self',
    sender_id: '',
    kind: 'business',
    source: 'realtime',
    disposition,
  };
}

/**
 * Submits once and waits for the matching `send_result`. Resolves exactly
 * once; the timeout yields `unknown` and nothing is resent.
 */
export function submitIntent(deps: AdapterDeps, sdk: ImSdkHandle, intent: SendIntent, timeoutMs = DEFAULT_SEND_ACK_TIMEOUT_MS): Promise<SendResult> {
  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe: () => void = () => undefined;
    let timer: unknown = null;
    const finish = (disposition: SendDisposition): void => {
      if (settled) return;
      settled = true;
      unsubscribe();
      if (timer !== null) deps.clearTimeout(timer);
      resolve({ intent, disposition, fact: factFor(intent, disposition) });
    };
    unsubscribe = sdk.on('send_result', (ack) => {
      // the page glue is unverified: a non-object ack is noise, never a throw inside the SDK dispatch
      if (typeof ack !== 'object' || ack === null || ack.localid !== intent.localId) return;
      finish(classifyAck(ack, deps.now()));
    });
    timer = deps.setTimeout(() => finish({ kind: 'unknown' }), timeoutMs);
    const req = intent.citemsgid === undefined ? { gid: intent.gid, body: intent.body } : { gid: intent.gid, body: intent.body, citemsgid: intent.citemsgid };
    try {
      sdk.sendMessage(req);
    } catch {
      // A synchronous SDK throw is still "we do not know": the frame may have left.
      finish({ kind: 'unknown' });
    }
  });
}

// ------------------------------------------------------------- product card

export interface ProductCardRequest {
  readonly bizType: number;
  readonly templateId: string;
  readonly groupIdentity: string;
  /** Sidebar customer uid (not the agent uid). */
  readonly uid: string;
  /** Card fields; serialized once into `extendJson`. */
  readonly card: Readonly<Record<string, string>>;
  readonly inSession?: boolean;
}

export type ProductCardResult =
  | { readonly kind: 'confirmed'; readonly localId: string; readonly msgId: string }
  | { readonly kind: 'rejected'; readonly outcome: SoaOutcome<unknown> }
  | { readonly kind: 'unknown' };

/** `15529/sendCardMessageForOffline` (write; timeout → unknown, never replayed). */
export async function sendProductCard(deps: AdapterDeps, soa: SoaClient, req: ProductCardRequest): Promise<ProductCardResult> {
  const body = {
    contentType: 'json',
    head: platformHead(deps.context),
    inSession: req.inSession ?? true,
    senderRole: 'Advisor',
    platformId: 0,
    bizType: req.bizType,
    templateId: req.templateId,
    groupIdentity: req.groupIdentity,
    uid: req.uid,
    extendJson: JSON.stringify(req.card),
  };
  const outcome = await soa.post<{ data?: unknown }>(Endpoints.SEND_CARD_MESSAGE, body);
  if (outcome.kind === 'unknown') return { kind: 'unknown' };
  if (outcome.kind !== 'success') return { kind: 'rejected', outcome };
  const data = outcome.body.data;
  if (typeof data === 'object' && data !== null) {
    const d = data as { localId?: unknown; msgId?: unknown };
    if (typeof d.localId === 'string' && typeof d.msgId === 'string') return { kind: 'confirmed', localId: d.localId, msgId: d.msgId };
  }
  return { kind: 'rejected', outcome };
}
