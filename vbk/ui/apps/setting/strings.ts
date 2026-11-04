import { t } from '../../packages/ui-kit/src/i18n.ts';
/** Settings-window copy local to this window (shared copy stays in ui-kit/i18n.ts). */
export const SETTING_STRINGS = {
  titleWithAccount: '设置 · {nick}',
  assistant: '商家助手 · TSim 登录',
  close: '关闭设置',
  about: '关于与更新',
  version: '当前版本',
  versionUnknown: '未知',
  account: '账号',
  personalSettings: '网页个人设置',
  open: '打开',
  checkUpdate: '检查更新',
  checkUpdateDesc: '在独立的更新窗口中检查',
} as const;

export function fmt(s: string, vars: Readonly<Record<string, string | number>>): string {
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (vars[k] === undefined ? m : String(vars[k])));
}
