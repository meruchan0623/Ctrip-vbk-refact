/**
 * Settings-window copy local to this window (shared copy stays in ui-kit/i18n.ts).
 * Each entry exists only here; `settings-i18n.test.ts` locks the text and requires every entry to be used.
 */
export const SETTING_STRINGS = {
  close: '关闭设置',
  version: '当前版本',
  versionUnknown: '未知',
  account: '账号',
  personalSettings: '其他个人设置（网页）',
  open: '打开',
  checkUpdate: '检查更新',
  checkUpdateDesc: '在独立的更新窗口中检查',
} as const;
