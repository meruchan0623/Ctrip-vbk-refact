/**
 * Test support: deterministic deps (fake clock/timers/random/fetch/sdk).
 * Not a test file itself so `tsc` includes it; it has no runtime effect
 * unless a test calls it. Contains only placeholder values.
 */

import type {
  AdapterDeps,
  FetchInit,
  FetchResponseLike,
  ImSdkHandle,
  PageContext,
  SdkEventMap,
  SdkReadReceiptRequest,
  SdkSendRequest,
  SdkCallOutcome,
  TimerHandle,
} from './deps.ts';

export const FAKE_CONTEXT: PageContext = {
  cid: '{{cid}}',
  sid: '{{sid}}',
  clientId: '{{clientId}}',
  locale: 'zh-CN',
  cookieOrigin: 'https://vbooking.ctrip.com',
};

interface Pending {
  readonly id: number;
  readonly at: number;
  readonly cb: () => void;
}

export class FakeClock {
  #now: number;
  #nextId = 1;
  #pending: Pending[] = [];

  constructor(startMs = 1_700_000_000_000) {
    this.#now = startMs;
  }

  now = (): number => this.#now;

  setTimeout = (cb: () => void, ms: number): TimerHandle => {
    const id = this.#nextId++;
    this.#pending.push({ id, at: this.#now + Math.max(0, ms), cb });
    return id;
  };

  clearTimeout = (handle: TimerHandle): void => {
    this.#pending = this.#pending.filter((p) => p.id !== handle);
  };

  pendingCount(): number {
    return this.#pending.length;
  }

  /** Advance time, firing due timers in order and flushing microtasks between them. */
  async advance(ms: number): Promise<void> {
    const target = this.#now + ms;
    for (;;) {
      // settle already-resolved promises before any timer fires (microtasks run before macrotasks)
      await flush();
      const due = this.#pending.filter((p) => p.at <= target).sort((a, b) => a.at - b.at || a.id - b.id);
      const next = due[0];
      if (!next) break;
      this.#now = Math.max(this.#now, next.at);
      this.#pending = this.#pending.filter((p) => p.id !== next.id);
      next.cb();
      await flush();
    }
    this.#now = target;
    await flush();
  }
}

export async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

export interface RecordedCall {
  readonly url: string;
  readonly init: FetchInit;
  readonly bodyJson: unknown;
}

export type FetchScript = (call: RecordedCall, index: number) => FetchResponseLike | Promise<FetchResponseLike> | 'hang' | Error;

export class FakeFetch {
  readonly calls: RecordedCall[] = [];
  #script: FetchScript;

  constructor(script: FetchScript) {
    this.#script = script;
  }

  set(script: FetchScript): void {
    this.#script = script;
  }

  fetch = (url: string, init: FetchInit): Promise<FetchResponseLike> => {
    let bodyJson: unknown = null;
    if (typeof init.body === 'string') {
      try {
        bodyJson = JSON.parse(init.body);
      } catch {
        bodyJson = init.body;
      }
    }
    const call: RecordedCall = { url, init, bodyJson };
    this.calls.push(call);
    const r = this.#script(call, this.calls.length - 1);
    if (r === 'hang') return new Promise(() => undefined);
    if (r instanceof Error) return Promise.reject(r);
    return Promise.resolve(r);
  };
}

export function jsonResponse(body: unknown, status = 200): FetchResponseLike {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return { status, text: () => Promise.resolve(text) };
}

export const OK_STATUS = { Timestamp: '/Date(1700000000000+0800)/', Ack: 'Success', Errors: [], Extension: [] };
export const FAILURE_STATUS = {
  Timestamp: '/Date(1700000000000+0800)/',
  Ack: 'Failure',
  Errors: [{ Message: '{{msg}}', ErrorCode: '{{code}}', SeverityCode: 'Error', ErrorClassification: 'ServiceError' }],
  Extension: [],
};
export const AUTH_FAILURE_STATUS = {
  Timestamp: '/Date(1700000000000+0800)/',
  Ack: 'Failure',
  Errors: [
    {
      Message: null,
      ErrorCode: 'AccountsMobileRequestFilterException',
      StackTrace: null,
      SeverityCode: 'Error',
      ErrorFields: [{ FieldName: null, ErrorCode: '101', Message: '{{msg}}' }],
      ErrorClassification: 'FrameworkError',
    },
  ],
  Extension: [],
};

type Listener<K extends keyof SdkEventMap> = (p: SdkEventMap[K]) => void;

export class FakeSdk implements ImSdkHandle {
  readonly sent: SdkSendRequest[] = [];
  readonly readReceipts: SdkReadReceiptRequest[] = [];
  socketConnected = true;
  readReceiptOutcome: SdkCallOutcome = { kind: 'success', raw: null };
  #listeners: { [K in keyof SdkEventMap]: Listener<K>[] } = { message: [], send_result: [], socket_status: [] };

  on<K extends keyof SdkEventMap>(event: K, cb: Listener<K>): () => void {
    const list = this.#listeners[event] as Listener<K>[];
    list.push(cb);
    return () => {
      const i = list.indexOf(cb);
      if (i >= 0) list.splice(i, 1);
    };
  }

  emit<K extends keyof SdkEventMap>(event: K, payload: SdkEventMap[K]): void {
    for (const cb of [...(this.#listeners[event] as Listener<K>[])]) cb(payload);
  }

  listenerCount(event: keyof SdkEventMap): number {
    return this.#listeners[event].length;
  }

  sendMessage(req: SdkSendRequest): void {
    this.sent.push(req);
  }

  putAdviceOfReadByMsgId(req: SdkReadReceiptRequest): Promise<SdkCallOutcome> {
    this.readReceipts.push(req);
    return Promise.resolve(this.readReceiptOutcome);
  }

  getSocketStatus(): boolean {
    return this.socketConnected;
  }
}

export interface FakeDeps extends AdapterDeps {
  readonly clock: FakeClock;
  readonly fakeFetch: FakeFetch;
  readonly fakeSdk: FakeSdk;
  readonly invoked: { cmd: string; payload: unknown }[];
  readonly randomQueue: number[];
}

export function makeDeps(script: FetchScript = () => jsonResponse({ ResponseStatus: OK_STATUS }), ctx: PageContext = FAKE_CONTEXT): FakeDeps {
  const clock = new FakeClock();
  const fakeFetch = new FakeFetch(script);
  const fakeSdk = new FakeSdk();
  const invoked: { cmd: string; payload: unknown }[] = [];
  const randomQueue: number[] = [];
  return {
    clock,
    fakeFetch,
    fakeSdk,
    invoked,
    randomQueue,
    fetch: fakeFetch.fetch,
    now: clock.now,
    random: () => (randomQueue.length > 0 ? (randomQueue.shift() as number) : 0.5),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    context: ctx,
    sdk: fakeSdk,
    invoke: (cmd, payload) => {
      invoked.push({ cmd, payload });
      return Promise.resolve(null);
    },
  };
}

/** `PageSdk` fake for the page-session / RPC tests (send/read through `FakeSdk`). */
export class FakePageSdk extends FakeSdk {
  attached = true;
  canSend = true;
  readonly jids = new Map<string, string>();

  sdkVersion(): string | null {
    return null;
  }

  partnerJidOf(gid: string): string | null {
    return this.jids.get(gid) ?? null;
  }

  rememberPartnerJid(gid: string, jid: string): void {
    this.jids.set(gid, jid.split('/')[0] ?? jid);
  }

  waitReady(): Promise<boolean> {
    return Promise.resolve(this.attached);
  }

  dispose(): void {
    // nothing to release
  }
}

/** A `conversationList[]` row shaped like the documented sample (placeholders only). */
export function sampleRow(gid: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    uid: `cust-${gid}`,
    serviceType: '1513',
    id: 9001,
    isOwner: false,
    gid,
    threadId: '',
    conversationKey: '{{key}}',
    lastMessageTime: 1700000000500,
    relationOrderId: '1234567890',
    ext: { orderId: '1234567890' },
    status: 2,
    conversationType: 'B2C',
    groupTitle: `Title ${gid}`,
    sessionId: `sess-${gid}`,
    inGroup: 1,
    star: 2,
    isRead: 0,
    lastUpdateTime: 1700000000600,
    lastMessageJsonString: JSON.stringify({ msgId: `m-${gid}`, messageBody: 'hello  there', fromJid: `cust-${gid}@im.x`, toJid: `${gid}@conf.x`, createTime: 1700000000500, msgtype: 0 }),
    languageInfo: { lang: 'en_PH' },
    ...extra,
  };
}
