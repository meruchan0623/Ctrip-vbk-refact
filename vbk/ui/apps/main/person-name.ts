import { t } from '../../packages/ui-kit/src/i18n.ts';
/** Translate only the observed official nickname key; identity and free names stay intact. */
export function personDisplayName(nickname: string | null | undefined, uid: string): string {
  if (nickname === 'key.im.servicechat.robotnickname') return t('displayFormat.robotName');
  return nickname || uid;
}
