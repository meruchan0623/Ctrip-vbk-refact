import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AccountContext } from '../../packages/ipc/src/contracts.ts';
import { settleAccountSend } from './sendScope.ts';

const owner: AccountContext = { account_id: 'synthetic-account-a', environment: 'synthetic-environment', session_generation: 1 };
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }

for (const completion of ['success', 'failure'] as const) {
  for (const change of ['account', 'generation', 'environment', 'logout'] as const) {
    test(`${completion} completion is discarded after ${change} change even with an identical room gid`, async () => {
      const response = deferred<string>();
      let active: AccountContext | null = owner;
      const store = new Map<string, string[]>([['synthetic-shared-room', ['synthetic-current-message']]]);
      const pending = (async () => {
        const result = await settleAccountSend(owner, () => response.promise, () => active);
        if (result.kind !== 'stale') store.get('synthetic-shared-room')!.push(result.kind === 'result' ? result.value : 'synthetic-failure-message');
      })();
      active = change === 'account' ? { ...owner, account_id: 'synthetic-account-b' } : change === 'generation' ? { ...owner, session_generation: 2 } : change === 'environment' ? { ...owner, environment: 'synthetic-other-environment' } : null;
      if (completion === 'success') response.resolve('synthetic-old-message'); else response.reject(new Error('synthetic-lost-reply'));
      await pending;
      assert.deepEqual(store.get('synthetic-shared-room'), ['synthetic-current-message']);
    });
  }
}

test('active generation receives success and failure once; owner is captured before await', async () => {
  assert.deepEqual(await settleAccountSend(owner, async () => 'synthetic-confirmed', () => ({ ...owner })), { kind: 'result', value: 'synthetic-confirmed' });
  const failure = new Error('synthetic-error');
  const failed = await settleAccountSend(owner, async () => { throw failure; }, () => owner);
  assert.equal(failed.kind, 'error');
  if (failed.kind === 'error') assert.equal(failed.error, failure);
});
