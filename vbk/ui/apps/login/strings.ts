/** Login-header copy (window-local; shared copy stays in ui-kit/i18n.ts). */
export const LOGIN_STRINGS = {
  documentTitle: '登录',
  title: '登录 VBK 商家工作台',
  url: 'https://vbooking.ctrip.com/ivbk/accountV2/login',
  embedded: '内嵌官方网页',
  close: '关闭',
  cancelFailed: '取消登录失败：{msg}',

  browserImporting: '正在导入浏览器登录态…',
  browserVerifying: '正在核验携程账号…',
  browserUnavailable: '浏览器登录态不可用，可重试或使用下方官方登录页。',
  browserDiscovering: '正在查找已授权的浏览器账号…',
  browserChooseLoggedIn: '请选择已登录携程的浏览器账号',
  browserAuthorize: '请在 Chrome 或 Edge 的 VBK 扩展中授权连接，再刷新。',
  browserNotReady: '浏览器连接未就绪，请重试或使用下方官方登录页。',
  browserAccountLabel: '浏览器账号',
  browserSelect: '选择浏览器账号',
  browserConnect: '连接账号',
  browserRefresh: '刷新',
  browserDefault: '连接 Chrome 或 Edge 中的携程账号',
} as const;

export function fmt(s: string, vars: Readonly<Record<string, string | number>>): string {
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (vars[k] === undefined ? m : String(vars[k])));
}
