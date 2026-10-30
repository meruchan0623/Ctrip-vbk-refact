import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPageSdk } from './sdkGlue.ts';
import { createSendIntent, submitIntent } from './send.ts';
import { makeDeps } from './testing.ts';

test('disposed SDK refuses all customer-visible sends and read-receipt writes', async () => {
  const deps = makeDeps();
  let sends = 0, reads = 0;
  const sdk = createPageSdk({ IMClient: {
    sendMessageInSocket: () => { sends++; },
    putAdviceOfReadByMsgId: () => { reads++; },
  } }, deps);
  sdk.rememberPartnerJid('g1', 'g1@conf.example');
  sdk.dispose();
  const intent = createSendIntent(deps, 'g1', 'synthetic', { serviceType: '1513', threadId: '' });
  assert.throws(() => sdk.sendMessage({ gid: 'g1', body: intent.body }), /disposed/);
  await assert.rejects(sdk.putAdviceOfReadByMsgId({ partnerJid: 'g1@conf.example', msgId: 'm1', conversationType: 'groupchat' }), /disposed/);
  assert.equal(sends, 0);
  assert.equal(reads, 0);
});
