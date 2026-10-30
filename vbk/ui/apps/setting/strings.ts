/** Settings-window copy local to this window (shared copy stays in ui-kit/i18n.ts). */
export const SETTING_STRINGS = {
  titleWithAccount: '设置 · {nick}',
  close: '关闭设置',
  about: '关于与更新',
  aboutHead: '关于与更新',
  version: '当前版本',
  versionUnknown: '未知',
  checkUpdate: '检查更新',
  checkUpdateDesc: '在独立的更新窗口中检查',
} as const;

export function fmt(s: string, vars: Readonly<Record<string, string | number>>): string {
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (vars[k] === undefined ? m : String(vars[k])));
}
