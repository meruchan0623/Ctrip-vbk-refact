import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPageSdk } from './sdkGlue.ts';
import { createSendIntent, submitIntent } from './send.ts';
import { makeDeps } from './testing.ts';

test('SDK promise receipt preserves ID precision before submitIntent classification', async () => {
  for (const id of [9007199254740992, -1, 1.5, '', '   ', '9223372036854775806']) {
    const deps = makeDeps();
    let calls = 0;
    const sdk = createPageSdk({ IMClient: { sendMessageInSocket: (message: { localId: string }) => {
      calls++;
      return Promise.resolve({ msgId: id, localId: message.localId });
    } } }, deps);
    sdk.rememberPartnerJid('g1', 'g1@conf.example');
    const intent = createSendIntent(deps, 'g1', 'synthetic', { serviceType: '1513', threadId: '' });
    try {
      const pending = submitIntent(deps, sdk, intent, 100);
      await deps.clock.advance(100);
      const result = await pending;
      if (id === '9223372036854775806') {
        assert.equal(result.disposition.kind, 'confirmed');
        assert.equal(result.fact.message_id, id);
      } else {
        assert.deepEqual(result.disposition, { kind: 'unknown' }, String(id));
        assert.equal(result.fact.message_id, null);
      }
      assert.equal(calls, 1);
      assert.equal(deps.fakeFetch.calls.length, 0);
    } finally { sdk.dispose(); }
    assert.equal(deps.clock.pendingCount(), 0);
  }
});
