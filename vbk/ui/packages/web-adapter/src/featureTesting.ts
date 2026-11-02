/** Test helpers for adapter features (not part of the bundle: only `*.test.ts` import it). */

import type { FeatureFact, FeatureOpContext, FeatureSdk } from './features.ts';
import type { PeripheralConversation } from './peripheral.ts';
import { SoaClient } from './soa.ts';
import { makeDeps, type FakeDeps, type FetchScript } from './testing.ts';

export const GID = '1234567890123456789';
export const MSG_ID = '9876543210987654321';

export const SAMPLE_VIEW: PeripheralConversation = {
  gid: GID,
  conversationKey: 'key-1',
  sessionId: 'session-1',
  worksheetId: 456,
  serviceType: '1513',
  threadId: '',
  conversationType: 'B2C',
  customerUid: 'cust-1',
  orderId: null,
  lastMessage: null,
};

export interface TestCtx extends FeatureOpContext {
  readonly fakeDeps: FakeDeps;
  readonly facts: FeatureFact[];
  serverNow: number | null;
  views: Map<string, PeripheralConversation>;
  self: string | null;
}

export function makeCtx(script?: FetchScript, sdk: FeatureSdk = {}): TestCtx {
  const deps = script ? makeDeps(script) : makeDeps();
  const soa = new SoaClient(deps, { defaultTimeoutMs: 1000 });
  const facts: FeatureFact[] = [];
  const views = new Map<string, PeripheralConversation>([[GID, SAMPLE_VIEW]]);
  const ctx: TestCtx = {
    fakeDeps: deps,
    deps,
    soa,
    sdk,
    facts,
    views,
    serverNow: deps.now(),
    self: 'agent-1',
    serverNowMs() {
      return ctx.serverNow;
    },
    conversation(gid) {
      return views.get(gid) ?? null;
    },
    selfUid() {
      return ctx.self;
    },
    emit(f) {
      facts.push(f);
    },
  };
  return ctx;
}
