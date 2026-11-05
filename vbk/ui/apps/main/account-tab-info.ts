import type { AccountState, UiAccount } from '../../packages/ipc/src/client.ts';
import { t, type I18nKey } from '../../packages/ui-kit/src/i18n.ts';

const STATE_KEYS: Readonly<Record<AccountState, I18nKey>> = {
  online: 'tab.online',
  logging_in: 'tab.loggingIn',
  expired: 'tab.expired',
  suspended: 'tab.suspended',
};

/** Plain-text hover details of an account tab. The local account id is deliberately left out. */
export function accountTabTitle(account: UiAccount): string {
  const line = (key: I18nKey, value: string | null | undefined): string[] => {
    const text = value?.trim();
    return text ? [t(key, { value: text })] : [];
  };
  const details = [
    ...line('tab.info.remark', account.remark),
    ...line('tab.info.nick', account.nick),
    ...line('tab.info.party', account.party),
    ...line('tab.info.agent', account.self_profile?.name),
    ...line('tab.info.imUid', account.self_profile?.uid),
    ...line('tab.info.state', t(STATE_KEYS[account.state])),
    ...line('tab.info.unread', String(account.unread)),
  ];
  // A tab that is still logging in cannot be renamed, so it gets no edit hint.
  return account.state === 'logging_in' ? details.join('\n') : [...details, '', t('tab.editRemark')].join('\n');
}
