import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { UiAccount } from '../../packages/ipc/src/client.ts';
import { t } from '../../packages/ui-kit/src/i18n.ts';
import { accountTabTitle } from './account-tab-info.ts';

const base: UiAccount = {
  context: { account_id: 'synthetic-local-id', environment: 'production', session_generation: 1 },
  nick: 'Nick',
  remark: null,
  party: 'Party',
  color: '#000000',
  state: 'online',
  unread: 3,
};

test('online tab shows every available detail and the edit hint, never the local account id', () => {
  const title = accountTabTitle({ ...base, remark: 'Remark', self_profile: { uid: 'im-uid', name: 'Agent', avatar: 'https://example.invalid/a.png' } });
  assert.deepEqual(title.split('\n'), [
    t('tab.info.remark', { value: 'Remark' }),
    t('tab.info.nick', { value: 'Nick' }),
    t('tab.info.party', { value: 'Party' }),
    t('tab.info.agent', { value: 'Agent' }),
    t('tab.info.imUid', { value: 'im-uid' }),
    t('tab.info.state', { value: t('tab.online') }),
    t('tab.info.unread', { value: '3' }),
    '',
    t('tab.editRemark'),
  ]);
  assert.ok(!title.includes('synthetic-local-id'));
  assert.ok(!title.includes('example.invalid'));
});

test('absent optional details are omitted and a logging-in tab has no edit hint', () => {
  const title = accountTabTitle({ ...base, party: ' ', state: 'logging_in', unread: 0 });
  assert.deepEqual(title.split('\n'), [
    t('tab.info.nick', { value: 'Nick' }),
    t('tab.info.state', { value: t('tab.loggingIn') }),
    t('tab.info.unread', { value: '0' }),
  ]);
});
