/** Login-header copy (window-local; shared copy stays in ui-kit/i18n.ts). */
export const LOGIN_STRINGS = {
  title: '登录 VBK 商家工作台',
  url: 'https://vbooking.ctrip.com/ivbk/accountV2/login',
  embedded: '内嵌官方网页',
  close: '关闭',
  cancelFailed: '取消登录失败：{msg}',
} as const;

export function fmt(s: string, vars: Readonly<Record<string, string | number>>): string {
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (vars[k] === undefined ? m : String(vars[k])));
}
