/** Alarm-window copy that is local to this window (shared copy stays in ui-kit/i18n.ts). */
export const ALARM_STRINGS = {
  jumpTitle: '点击跳转到会话',
  pickTitle: '单击选中，双击跳转到会话',
  waitingReply: '等待商家回复',
  levelSep: ' · ',
  snoozeOption: '{m} 分钟后提醒',
  rowHide: '清除此提醒',
  rowSnooze: '此会话稍后提醒',
} as const;

export function fmt(s: string, vars: Readonly<Record<string, string | number>>): string {
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (vars[k] === undefined ? m : String(vars[k])));
}
