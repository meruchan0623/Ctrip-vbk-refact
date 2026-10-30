/** Offline executable examples. No browser, network, credentials or TSim writes. */
import assert from 'node:assert/strict';
import { createPageSdk } from '../../vbk/ui/packages/web-adapter/src/sdkGlue.ts';
import { createSendIntent, submitIntent } from '../../vbk/ui/packages/web-adapter/src/send.ts';
import { makeDeps, OK_STATUS } from '../../vbk/ui/packages/web-adapter/src/testing.ts';

const room = '900719925474099312345'; // Synthetic, deliberately beyond JS safe integer.
const messageId = '9223372036854775806';
const results: unknown[] = [];
for (const mode of ['confirmed', 'rejected', 'missing_ack', 'unsafe_id', 'disposed'] as const) {
  const deps = makeDeps();
  let writes = 0;
  let success: ((raw: unknown) => void) | undefined;
  const sdk = createPageSdk({ IMClient: {
    sendMessageInSocket: (model: Record<string, unknown>, done: (raw: unknown) => void, fail: (raw: unknown) => void) => {
      writes++;
      assert.equal(model['toJid'], room);
      assert.equal(model['messageType'], 0);
      assert.equal(model['content'], 'SYNTHETIC CONTRACT ONLY');
      success = done;
      if (mode === 'confirmed') done({ msgId: messageId, localId: model['localId'], msgCreateTime: deps.now() });
      if (mode === 'rejected') fail({ error: 7, errmsg: 'synthetic explicit refusal', localId: model['localId'] });
      if (mode === 'unsafe_id') done({ msgId: Number(messageId), localId: model['localId'] });
    },
  } }, { ...deps, facadeSendTimeoutMs: 100 });
  sdk.rememberPartnerJid(room, `${room}@muc.example`);
  const intent = createSendIntent(deps, room, 'SYNTHETIC CONTRACT ONLY', { serviceType: '1513', threadId: '' });
  const pending = submitIntent(deps, sdk, intent, 100);
  if (mode === 'disposed') { sdk.dispose(); success?.({ msgId: messageId }); }
  await deps.clock.advance(1000);
  const { disposition } = await pending;
  assert.equal(disposition.kind, mode === 'confirmed' || mode === 'rejected' ? mode : 'unknown');
  if (disposition.kind === 'confirmed') assert.equal(disposition.server_message_id, messageId);
  assert.equal(writes, 1, 'unknown must not create another write');
  assert.equal(deps.fakeFetch.calls.length, 0, 'facade attempt must not add host HTTP fallback');
  sdk.dispose();
  assert.equal(deps.clock.pendingCount(), 0);
  results.push({ scenario: mode, disposition, sdk_calls: writes, host_http_calls: 0 });
}

{
  const deps = makeDeps();
  let acknowledge: ((raw: unknown) => void) | undefined;
  const sdk = createPageSdk({ IMClient: {
    putAdviceOfReadByMsgId: (_request: unknown, done: (raw: unknown) => void) => { acknowledge = done; },
  } }, deps);
  let settled = false;
  const pending = sdk.putAdviceOfReadByMsgId({ partnerJid: `${room}@muc.example`, msgId: messageId, conversationType: 'groupchat' }).then(result => { settled = true; return result; });
  await deps.clock.advance(1);
  assert.equal(settled, false, 'void return must not acknowledge read receipt');
  acknowledge?.({ ResponseStatus: OK_STATUS });
  assert.equal((await pending).kind, 'success');
  sdk.dispose();
  assert.equal(deps.clock.pendingCount(), 0);
  results.push({ scenario: 'read_callback_required', acknowledged_after_callback: true, means_customer_read: false });
}
console.log(JSON.stringify({ mode: 'offline_synthetic_real_adapter', implemented_in_tsim: false, results }, null, 2));
