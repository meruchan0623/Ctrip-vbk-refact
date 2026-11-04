/** Companion-card reissue timeline and browser-tab copy. Protocol/data keys stay in their owning adapters. */
export const companionTabsStrings = {
  'companionTabs.reissue.detailFailed': '详情获取失败',
  'companionTabs.reissue.time': '时间 {at}',
  'companionTabs.reissue.status': '状态 {status}',
  'companionTabs.reissue.remain': '剩余 {remain}',
  'companionTabs.timeline.origin': '原套餐',
  'companionTabs.timeline.reissue': '补发 {n}',
  'companionTabs.timeline.label': '补发套餐时间线，共 {count} 个，按时间升序',
  'companionTabs.sourceBadge': '源',
  'companionTabs.web.fallbackLabel': '网页',
  'companionTabs.web.ownedLabel': '{label}（{owner}）',
  'companionTabs.web.close': '关闭网页',
  'companionTabs.web.back': '后退',
  'companionTabs.web.forward': '前进',
  'companionTabs.web.reload': '刷新',
  'companionTabs.web.openExternal': '系统浏览器打开',
  'companionTabs.web.openFailed': '打开网页失败，请稍后重试',
  'companionTabs.web.openInvalid': '打开网页失败：宿主返回异常',
  'companionTabs.web.closeFailed': '关闭网页失败，请稍后重试',
  'companionTabs.web.actionFailed': '网页操作失败',
} as const satisfies Readonly<Record<`companionTabs.${string}`, string>>;

export type CompanionTabsI18nKey = keyof typeof companionTabsStrings;
