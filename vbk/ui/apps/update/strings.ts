/** Update-window copy (window-local; shared copy stays in ui-kit/i18n.ts). */
export const UPDATE_STRINGS = {
  title: '软件更新',
  heading: 'VBK 商家工作台',
  version: '当前版本 {v}',
  versionUnknown: '当前版本未知',
  check: '检查更新',
  checking: '正在检查更新…',
  notConfigured: '更新服务尚未配置',
  notConfiguredDesc: '未配置更新源与签名公钥前，客户端不会下载或安装任何更新。',
  close: '关闭',
  closeFailed: '关闭失败：{msg}',
} as const;

export function fmt(s: string, vars: Readonly<Record<string, string | number>>): string {
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (vars[k] === undefined ? m : String(vars[k])));
}
