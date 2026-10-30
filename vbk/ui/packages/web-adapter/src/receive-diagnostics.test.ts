import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createPageSdk } from './sdkGlue.ts';
import { createPageSession } from './session.ts';
import type { UiPageReceiveDiagnostics } from '../../ipc/src/client.ts';
import { OK_STATUS, jsonResponse, makeDeps, sampleRow, flush } from './testing.ts';

class Client extends EventEmitter { status = 'online'; }
const frame = (time = '1700000000900') => ({ name: 'message', attrs: { type: 'groupchat', from: '123456@muc.synthetic/customer', to: 'self@synthetic', id: 'synthetic-id', msgtype: '0', create_time: time }, getChildText: () => 'synthetic private body Cookie: placeholder' });
function fixture() {
  let failDisplay = false;
  const base = makeDeps(call => jsonResponse(call.url.includes('getConversationList')
    ? { ResponseStatus: OK_STATUS, conversationList: [sampleRow('123456')], haveRest: false }
    : call.url.includes('getRecentMessages') ? { ResponseStatus: OK_STATUS, messages: [], lastMessageTimestamp: 1700000000000 }
    : { ResponseStatus: OK_STATUS, members: [] }));
  const client = new Client(), win: Record<string, unknown> = { xmppClient: client };
  const sdk = createPageSdk(win, base);
  const session = createPageSession({ ...base, sdk }, { sdk, account: { account_id: 'synthetic', environment: 'production', session_generation: 1 }, selfUid: 'self', initialEpoch: 1, beginMsgTime: 1700000000000, pushDisplay: async p => { if (p.kind === 'messages' && failDisplay) throw new Error('synthetic private error payload'); } });
  const snapshot = async () => { const reply = await session.rpc.handle({ req_id: 'diagnostics', op: 'adapter.diagnostics', args: {} }); assert.ok(reply?.ok); return reply.data as UiPageReceiveDiagnostics; };
  return { base, client, win, sdk, session, snapshot, failDisplay: () => { failDisplay = true; } };
}

test('receive diagnostics: real SDK→session→display distinguishes ignored raw, mapper drop and rejected host push without exposing raw data', async () => {
  const f = fixture(); f.session.start(); await f.base.clock.advance(50);
  const initial = await f.snapshot();
  f.client.emit('stanza', { name: 'presence', attrs: {} });
  f.client.emit('stanza', frame('invalid-time'));
  f.failDisplay(); f.client.emit('stanza', frame()); await flush();
  const beforeCalls = f.base.fakeFetch.calls.length;
  const diag = await f.snapshot();
  assert.equal(diag.sdk?.counters.callbacks, 3);
  assert.equal(diag.sdk?.counters.ignored, 1);
  assert.equal(diag.sdk?.counters.messages, 2);
  assert.equal(diag.session.received, 2);
  assert.equal(diag.session.ui_dropped, 1);
  assert.equal(diag.session.ui_mapped, 1);
  assert.equal(diag.session.display_batches, 1);
  assert.equal(diag.session.display_rejected, 1);
  assert.equal(diag.session.display_resolved, 0);
  assert.equal(diag.compensation.outcomes.success, initial.compensation.outcomes.success);
  assert.equal(f.base.fakeFetch.calls.length, beforeCalls, 'snapshot must not poll, request history or reconnect');
  const serialized = JSON.stringify(diag);
  for (const forbidden of ['123456', 'synthetic-id', 'customer', 'Cookie:', 'private', 'https:', '@']) assert.equal(serialized.includes(forbidden), false);
  assert.equal(f.sdk.canSend, false);
  f.session.stop(); f.sdk.dispose();
});

test('receive diagnostics: rebind/disposed queued callbacks stay fenced and snapshots cannot mutate counters', async () => {
  const f = fixture(); f.session.start(); await f.base.clock.advance(50);
  const queued = f.client.listeners('stanza')[0] as (frame: unknown) => void;
  const next = new Client(); f.win['xmppClient'] = next; await f.base.clock.advance(1000);
  queued(frame()); next.emit('stanza', frame()); await flush();
  const diag = await f.snapshot();
  assert.equal(diag.sdk?.counters.stale_callbacks, 1);
  assert.equal(diag.sdk?.counters.messages, 1);
  assert.equal(diag.session.ui_mapped, 1);
  (diag.session as { ui_mapped: number }).ui_mapped = 999;
  assert.equal((await f.snapshot()).session.ui_mapped, 1);
  f.session.stop(); f.sdk.dispose(); queued(frame());
  assert.equal((await f.snapshot()).session.ui_mapped, 1);
  assert.equal((await f.snapshot()).sdk?.binding.global_state, 'disposed');
});
