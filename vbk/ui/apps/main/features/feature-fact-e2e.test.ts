/**
 * `feature://fact` end to end on the window side: the raw host payload
 * (`FeatureFactEventDto`, same JSON shape as the Rust/contract tests) goes
 * through the `ipc.listen` callback `main.ts` registers
 * (`(fact) => featureRuntime.onFact(fact)`) and changes module state.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFeatureRuntime } from './runtime.ts';
import { FeatureEvents } from './context.ts';
import { createTypingIndicator } from './typing-indicator.ts';
import { createRecall } from './recall.ts';
import { QUEUE_STATUS_COMMAND, createQueueBanner } from './queue-banner.ts';
import { ACCOUNT, GID, MSG_ID, makeHost } from './testing.ts';

const accountJson = JSON.stringify(ACCOUNT);

function setup() {
  const host = makeHost();
  host.invokeReply = () => Promise.resolve({ kind: 'ok', resultCode: null, resultMessage: 'wait' });
  const recall = createRecall();
  const rt = createFeatureRuntime([createTypingIndicator(), recall, createQueueBanner()], host);
  rt.start();
  // what main.ts registers: ipc.listen(FeatureEvents.FACT, (fact) => featureRuntime.onFact(fact))
  const listeners = new Map<string, (payload: unknown) => void>();
  listeners.set(FeatureEvents.FACT, (fact) => rt.onFact(fact));
  const deliver = (event: string, json: string): void => listeners.get(event)?.(JSON.parse(json));
  return { host, rt, recall, deliver };
}

test('listen(feature://fact) → typing: indicator state + one expiry timer', async () => {
  const { host, deliver } = setup();
  const until = host.now + 5000;
  deliver(FeatureEvents.FACT, `{"kind":"typing","gid":"${GID}","from":"cust-9","until_ms":${until},"account":${accountJson}}`);
  assert.equal(host.timers.length, 1, 'one expiry timer, no polling');
  assert.equal(host.renders, 1);
  await host.advance(5000);
  assert.equal(host.timers.length, 0);
});

test('listen(feature://fact) → recalled: message marked recalled for the current account', () => {
  const { recall, deliver } = setup();
  assert.equal(recall.recalled(GID, MSG_ID), false);
  deliver(FeatureEvents.FACT, `{"kind":"recalled","gid":"${GID}","message_id":"${MSG_ID}","account":${accountJson}}`);
  assert.equal(recall.recalled(GID, MSG_ID), true);
});

test('listen(feature://fact) → queue_notice: bounded status polling starts for the open conversation', async () => {
  const { host, deliver } = setup();
  deliver(FeatureEvents.FACT, `{"kind":"queue_notice","gid":"${GID}","account":${accountJson}}`);
  await host.advance(0);
  assert.equal(host.invokes.length, 1);
  assert.equal(host.invokes[0]!.command, QUEUE_STATUS_COMMAND);
  assert.deepEqual(host.invokes[0]!.payload, { gid: GID, account: ACCOUNT });
});

test('listen(feature://fact) → other account / unknown event name: nothing changes', async () => {
  const { host, recall, deliver } = setup();
  const other = JSON.stringify({ ...ACCOUNT, session_generation: 9 });
  deliver(FeatureEvents.FACT, `{"kind":"typing","gid":"${GID}","from":"c","until_ms":${host.now + 5000},"account":${other}}`);
  deliver(FeatureEvents.FACT, `{"kind":"recalled","gid":"${GID}","message_id":"${MSG_ID}","account":${other}}`);
  deliver(FeatureEvents.FACT, `{"kind":"queue_notice","gid":"${GID}","account":${other}}`);
  deliver('feature://other', `{"kind":"queue_notice","gid":"${GID}","account":${accountJson}}`);
  await host.advance(0);
  assert.equal(host.timers.length, 0);
  assert.equal(host.invokes.length, 0);
  assert.equal(recall.recalled(GID, MSG_ID), false);
});
