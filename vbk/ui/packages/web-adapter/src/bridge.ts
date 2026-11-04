/**
 * Adapter → host bridge. Wraps every `AdapterFact` in an
 * `AdapterFactEnvelope {account, stream, epoch, seq, fact}` and hands it to
 * `invoke(ImCommands.PUSH_FACT, envelope)`.
 *
 * - stream by fact kind: message/compensation_sync → `im.message`,
 *   conversation/conversation_list_sync → `im.conversation`,
 *   transport/auth_invalid → `im.transport`, feature → `im.feature` (its own
 *   cursor: the host forwards these without ingesting, so they must not
 *   consume a seq on a core-tracked stream)
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
    case 'bridge_fault':
      return FactStreams.TRANSPORT;
    case 'feature':
      return FactStreams.FEATURE;
  }
}

export const DEFAULT_BRIDGE_CAPACITY = 1024;
const MAX_BRIDGE_CAPACITY = 16384;
const DRAINED = Promise.resolve();
const count = (value: number, amount = 1): number => Math.min(Number.MAX_SAFE_INTEGER, value + amount);
export type BridgeFailureCode = 'bridge.queue_overflow' | 'bridge.delivery_failed' | 'bridge.epoch_expired' | 'bridge.disposed';
export class BridgeQueueError extends Error {
  readonly code: BridgeFailureCode;
  constructor(code: BridgeFailureCode) { super(code); this.code = code; }
}
/** Fixed enums/counters only; never retain ids, facts, upstream errors or text. */
export interface BridgeDiagnostics {
  readonly state: 'active' | 'overflow' | 'disposed';
  readonly capacity: number;
  readonly pending: number;
  readonly queued: number;
  readonly in_flight: number;
  readonly high_water: number;
  readonly accepted: number;
  readonly invoked: number;
  readonly delivered: number;
  readonly failed: number;
  readonly overflow_events: number;
  readonly rejected: number;
  readonly expired: number;
  readonly stale_completions: number;
  readonly callback_errors: number;
  readonly waiting: number;
  readonly waiting_high_water: number;
}
export interface AdapterBridgeOptions {
  readonly account: AccountContext;
  readonly invoke: InvokeLike;
  readonly cursors?: CursorAllocator;
  /** Includes the one in-flight invoke. Invalid capacities use the default. */
  readonly capacity?: number;
  /** Never retried. Called once before current-generation failure stops dispatch. */
  readonly onPushError?: (envelope: AdapterFactEnvelope, error: unknown) => void;
  /** One notification per latched overflow or delivery failure; owner must stop intake and resync/relogin. */
  readonly onQueueFault?: (error: BridgeQueueError, diagnostics: BridgeDiagnostics) => void;
}
interface Entry { readonly envelope: AdapterFactEnvelope; readonly generation: number; waiter?: Drain }
interface Admission { readonly fact: AdapterFact; readonly generation: number; readonly current: () => boolean; readonly resolve: (accepted: boolean) => void }
interface Drain { readonly promise: Promise<void>; readonly resolve: () => void; readonly reject: (error: BridgeQueueError) => void }

export class AdapterBridge {
  readonly #account: AccountContext;
  readonly #invoke: InvokeLike;
  readonly #cursors: CursorAllocator;
  readonly #capacity: number;
  readonly #onPushError: AdapterBridgeOptions['onPushError'];
  readonly #onQueueFault: AdapterBridgeOptions['onQueueFault'];
  #queue: Entry[] = [];
  #inFlight: Entry | null = null;
  #scheduled = false;
  readonly #admissions = new Map<string, Admission>();
  #generation = 1;
  #state: BridgeDiagnostics['state'] = 'active';
  #failure: BridgeQueueError | null = null;
  #failurePromise: Promise<void> | null = null;
  #counts = { high_water: 0, accepted: 0, invoked: 0, delivered: 0, failed: 0, overflow_events: 0, rejected: 0, expired: 0, stale_completions: 0, callback_errors: 0, waiting_high_water: 0 };

  constructor(opts: AdapterBridgeOptions) {
    this.#account = opts.account;
    this.#invoke = opts.invoke;
    this.#cursors = opts.cursors ?? new CursorAllocator();
    this.#onPushError = opts.onPushError;
    this.#onQueueFault = opts.onQueueFault;
    this.#capacity = typeof opts.capacity === 'number' && Number.isSafeInteger(opts.capacity) && opts.capacity >= 1 && opts.capacity <= MAX_BRIDGE_CAPACITY ? opts.capacity : DEFAULT_BRIDGE_CAPACITY;
  }
  get cursors(): CursorAllocator { return this.#cursors; }
  get epoch(): number { return this.#cursors.epoch; }
  get diagnostics(): BridgeDiagnostics {
    return { state: this.#state, capacity: this.#capacity, pending: this.#queue.length + (this.#inFlight ? 1 : 0), queued: this.#queue.length, in_flight: this.#inFlight ? 1 : 0, waiting: this.#admissions.size, ...this.#counts };
  }
  /** Explicit lifecycle invalidation. An already-issued invoke cannot be cancelled or replayed. */
  cancelPending(): void {
    this.#generation++;
    this.#counts.expired = count(this.#counts.expired, this.#queue.length);
    const error = new BridgeQueueError('bridge.epoch_expired');
    for (const entry of this.#queue) entry.waiter?.reject(error);
    this.#inFlight?.waiter?.reject(error);
    if (this.#inFlight) delete this.#inFlight.waiter;
    this.#queue = [];
    for (const waiter of this.#admissions.values()) { this.#counts.rejected = count(this.#counts.rejected); waiter.resolve(false); }
    this.#admissions.clear();
  }
  /** New epoch starts only a fresh resync; discarded facts are never claimed recovered. */
  bumpEpoch(): number {
    if (this.#state === 'disposed') throw this.#failure!;
    this.cancelPending();
    this.#state = 'active'; this.#failure = null; this.#failurePromise = null;
    return this.#cursors.bumpEpoch();
  }
  dispose(): void {
    if (this.#state === 'disposed') return;
    this.cancelPending();
    this.#state = 'disposed';
    this.#setFailure(this.#failure ?? new BridgeQueueError('bridge.disposed'));
  }
  envelope(fact: AdapterFact): AdapterFactEnvelope {
    const stream = streamFor(fact), cursor = this.#cursors.next(stream);
    return { account: this.#account, stream, epoch: cursor.epoch, seq: cursor.seq, fact };
  }
  /** Admission is synchronous and ordered. A returned envelope is queued, never an ACK. */
  push(fact: AdapterFact): AdapterFactEnvelope {
    if (fact.kind === 'bridge_fault') throw new Error('bridge control requires the out-of-band host path');
    if (this.#state !== 'active') {
      this.#counts.rejected = count(this.#counts.rejected);
      throw this.#failure!;
    }
    if (this.diagnostics.pending >= this.#capacity) {
      this.#counts.rejected = count(this.#counts.rejected);
      throw this.#overflow();
    }
    const envelope = this.envelope(fact);
    this.#queue.push({ envelope, generation: this.#generation });
    this.#counts.accepted = count(this.#counts.accepted);
    this.#counts.high_water = Math.max(this.#counts.high_water, this.diagnostics.pending);
    this.#schedule();
    return envelope;
  }
  /** At most five named batch producers may await capacity. Admission is
   * atomic, leaves a realtime reserve, and cancellation immediately wakes them. */
  pushAsync(fact: AdapterFact, current: () => boolean, producer: string): Promise<boolean> {
    if (this.#state !== 'active' || !current()) return Promise.resolve(false);
    for (const [key, waiter] of this.#admissions) if (waiter.generation !== this.#generation || !waiter.current()) { this.#admissions.delete(key); this.#counts.rejected = count(this.#counts.rejected); waiter.resolve(false); }
    if (this.diagnostics.pending < this.#asyncLimit() && this.#admissions.size === 0) {
      this.push(fact);
      return Promise.resolve(true);
    }
    if (this.#admissions.has(producer) || this.#admissions.size >= 5) {
      this.#counts.rejected = count(this.#counts.rejected);
      this.#overflow();
      return Promise.resolve(false);
    }
    return new Promise(resolve => {
      this.#admissions.set(producer, { fact, current, generation: this.#generation, resolve });
      this.#counts.waiting_high_water = Math.max(this.#counts.waiting_high_water, this.#admissions.size);
    });
  }
  /** A bounded upstream batch queue also uses this terminal fault path. */
  overflow(): void { this.#counts.rejected = count(this.#counts.rejected); this.#overflow(); }
  #asyncLimit(): number { return Math.max(1, this.#capacity - Math.min(64, Math.floor(this.#capacity / 4))); }
  #overflow(): BridgeQueueError {
    if (this.#state !== 'active') return this.#failure!;
    return this.#fault('bridge.queue_overflow');
  }
  #fault(code: 'bridge.queue_overflow' | 'bridge.delivery_failed'): BridgeQueueError {
    if (this.#state !== 'active') return this.#failure!;
    const error = new BridgeQueueError(code);
    if (code === 'bridge.queue_overflow') this.#counts.overflow_events = count(this.#counts.overflow_events);
    this.#state = 'overflow'; this.#setFailure(error);
    for (const waiter of this.#admissions.values()) { this.#counts.rejected = count(this.#counts.rejected); waiter.resolve(false); }
    this.#admissions.clear();
    try { this.#onQueueFault?.(error, this.diagnostics); }
    catch { this.#counts.callback_errors = count(this.#counts.callback_errors); }
    return error;
  }
  #resumeAdmissions(): void {
    while (this.#state === 'active' && this.#admissions.size && this.diagnostics.pending < this.#asyncLimit()) {
      const [key, waiter] = this.#admissions.entries().next().value!;
      this.#admissions.delete(key);
      if (waiter.generation !== this.#generation || !waiter.current()) { this.#counts.rejected = count(this.#counts.rejected); waiter.resolve(false); continue; }
      this.push(waiter.fact);
      waiter.resolve(true);
    }
  }
  /** Snapshot barrier: later facts cannot starve an earlier flush. One shared
   * waiter per retained entry keeps all bridge-owned barriers within capacity. */
  flush(): Promise<void> {
    if (this.#failurePromise) return this.#failurePromise;
    const tail = this.#queue.at(-1) ?? (this.#inFlight?.generation === this.#generation ? this.#inFlight : null);
    if (!tail) return DRAINED;
    tail.waiter ??= this.#newDrain();
    return tail.waiter.promise;
  }
  emit = (fact: AdapterFact): void => { this.push(fact); };

  #newDrain(): Drain {
    let resolve!: () => void, reject!: (error: BridgeQueueError) => void;
    const promise = new Promise<void>((ok, failed) => { resolve = ok; reject = failed; });
    // Fire-and-forget producers need no extra promise per fact; retain errors
    // for explicit flush callers without generating unhandled rejections.
    void promise.catch(() => undefined);
    return { promise, resolve, reject };
  }
  #setFailure(error: BridgeQueueError): void {
    this.#failure = error;
    for (const entry of this.#queue) entry.waiter?.reject(error);
    this.#inFlight?.waiter?.reject(error);
    this.#failurePromise = Promise.reject(error);
    void this.#failurePromise.catch(() => undefined);
  }
  #schedule(): void {
    if (this.#scheduled || this.#inFlight || this.#state === 'disposed' || !this.#queue.length) return;
    this.#scheduled = true;
    queueMicrotask(() => { this.#scheduled = false; this.#pump(); });
  }
  #pump(): void {
    if (this.#inFlight || this.#state === 'disposed') return;
    const entry = this.#queue.shift();
    if (!entry) return;
    if (entry.generation !== this.#generation) { this.#counts.expired = count(this.#counts.expired); this.#schedule(); return; }
    this.#inFlight = entry;
    this.#counts.invoked = count(this.#counts.invoked);
    let result: Promise<unknown>;
    try { result = this.#invoke(ImCommands.PUSH_FACT, entry.envelope); }
    catch (error) { this.#complete(entry, false, error); return; }
    void Promise.resolve(result).then(value => {
      const report = value !== null && typeof value === 'object' ? value as Record<string, unknown> : null;
      const failed = report?.['applied'] === false && report['needs_resync'] !== undefined && report['needs_resync'] !== null;
      this.#complete(entry, !failed);
    }, error => this.#complete(entry, false, error));
  }
  #complete(entry: Entry, success: boolean, error?: unknown): void {
    if (this.#inFlight !== entry) return;
    if (!success && entry.generation === this.#generation && this.#state === 'active') {
      this.#counts.failed = count(this.#counts.failed);
      try { this.#onPushError?.(entry.envelope, error); }
      catch { this.#counts.callback_errors = count(this.#counts.callback_errors); }
      this.#fault('bridge.delivery_failed');
      // A failed current-generation delivery invalidates every later fact.
      // The owner may already have cancelled/disposed during the callback.
      if (entry.generation === this.#generation) this.cancelPending();
      this.#inFlight = null;
      return;
    }
    this.#inFlight = null;
    if (entry.generation !== this.#generation) this.#counts.stale_completions = count(this.#counts.stale_completions);
    this.#counts[success ? 'delivered' : 'failed'] = count(this.#counts[success ? 'delivered' : 'failed']);
    if (!success && entry.generation === this.#generation && this.#state !== 'disposed') {
      try { this.#onPushError?.(entry.envelope, error); }
      catch { this.#counts.callback_errors = count(this.#counts.callback_errors); }
    }
    this.#resumeAdmissions();
    entry.waiter?.resolve();
    delete entry.waiter;
    this.#schedule();
  }
}
