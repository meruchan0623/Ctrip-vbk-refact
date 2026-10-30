/** Translate only the observed official nickname key; identity and free names stay intact. */
export function personDisplayName(nickname: string | null | undefined, uid: string): string {
  if (nickname === 'key.im.servicechat.robotnickname') return '游游机器人';
  return nickname || uid;
}
