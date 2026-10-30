/**
 * Adapter → host bridge. Wraps every `AdapterFact` in an
 * `AdapterFactEnvelope {account, stream, epoch, seq, fact}` and hands it to
 * `invoke(ImCommands.PUSH_FACT, envelope)`.
 *
 * - stream by fact kind: message/compensation_sync → `im.message`,
 *   conversation/conversation_list_sync → `im.conversation`,
 *   transport/auth_invalid → `im.transport`
 * - `epoch`/`seq` come from the shared `CursorAllocator`; a reconnect or
 *   reload bumps the epoch so the host re-handshakes
 * - the envelope carries only the frozen fact shapes: no cookies, tokens,
 *   display names or message text can pass through here
 * - the host re-validates `account` and the source view; the adapter's
 *   claim is never trusted on its own
 */

import { FactStreams, type AccountContext, type AdapterFact, type AdapterFactEnvelope } from '../../ipc/src/contracts.ts';
import { ImCommands } from '../../ipc/src/commands.ts';
import type { InvokeLike } from './deps.ts';
import { CursorAllocator } from './facts.ts';

export type FactStream = (typeof FactStreams)[keyof typeof FactStreams];

export function streamFor(fact: AdapterFact): FactStream {
  switch (fact.kind) {
    case 'message':
    case 'compensation_sync':
      return FactStreams.MESSAGE;
    case 'conversation':
    case 'conversation_list_sync':
      return FactStreams.CONVERSATION;
    case 'transport':
    case 'auth_invalid':
      return FactStreams.TRANSPORT;
  }
}

export interface AdapterBridgeOptions {
  readonly account: AccountContext;
  readonly invoke: InvokeLike;
  readonly cursors?: CursorAllocator;
  /** Called when `invoke` rejects; the adapter never retries a push (the host handshakes on gaps). */
  readonly onPushError?: (envelope: AdapterFactEnvelope, error: unknown) => void;
}

export class AdapterBridge {
  readonly #account: AccountContext;
  readonly #invoke: InvokeLike;
  readonly #cursors: CursorAllocator;
  readonly #onPushError: ((envelope: AdapterFactEnvelope, error: unknown) => void) | undefined;
  #queue: Promise<void> = Promise.resolve();

  constructor(opts: AdapterBridgeOptions) {
    this.#account = opts.account;
    this.#invoke = opts.invoke;
    this.#cursors = opts.cursors ?? new CursorAllocator();
    this.#onPushError = opts.onPushError;
  }

  get cursors(): CursorAllocator {
    return this.#cursors;
  }

  get epoch(): number {
    return this.#cursors.epoch;
  }

  /** New epoch; the next push on every stream starts at seq 1. */
  bumpEpoch(): number {
    return this.#cursors.bumpEpoch();
  }

  envelope(fact: AdapterFact): AdapterFactEnvelope {
    const stream = streamFor(fact);
    const cursor = this.#cursors.next(stream);
    return { account: this.#account, stream, epoch: cursor.epoch, seq: cursor.seq, fact };
  }

  /** Allocates the cursor synchronously (order is fixed at call time) and pushes in order. */
  push(fact: AdapterFact): AdapterFactEnvelope {
    const env = this.envelope(fact);
    this.#queue = this.#queue.then(() => this.#invoke(ImCommands.PUSH_FACT, env)).then(
      () => undefined,
      (error: unknown) => {
        this.#onPushError?.(env, error);
      },
    );
    return env;
  }

  /** Resolves once every push issued so far has been handed to `invoke`. */
  flush(): Promise<void> {
    return this.#queue;
  }

  emit = (fact: AdapterFact): void => {
    this.push(fact);
  };
}
