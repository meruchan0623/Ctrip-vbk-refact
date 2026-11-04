/** Media-viewer window copy that is local to this window (shared copy stays in ui-kit/i18n.ts). `{name}` placeholders are filled by `fmt`. */
export const MEDIA_VIEWER_STRINGS = {
  fallbackName: '附件',
  toolsLabel: '图片工具',
  openFailed: '打开失败，请稍后重试。',
  saveFailed: '保存失败，请稍后重试。',
  saved: '已保存。',
  saveOriginal: '另存原图',
  saveShort: '另存',
  openExternal: '在系统浏览器中打开',
  openExternalShort: '外部打开 ↗',
  loadingMedia: '正在加载媒体…',
  mediaFailed: '无法播放此附件，可尝试外部打开。',
  fileNotPreviewable: '此格式暂不支持在窗口内预览，请使用系统浏览器打开或下载。',
  openOrDownload: '打开或下载文件',
  openFile: '打开文件 ↗',
  fitWindow: '恢复适应窗口',
  fit: '适应窗口',
  zoomReset: '{percent}% · 复位',
  loadingImage: '正在加载图片…',
  imageFailed: '图片加载失败，可尝试外部打开。',
  previous: '上一张',
  next: '下一张',
  zoomOut: '缩小',
  zoomIn: '放大',
  rotate: '旋转图片',
  rotateShort: '旋转 ↻',
  windowTitle: '附件查看器',
  expired: '附件预览已失效，请从会话重新打开。',
  minimize: '最小化',
  maximize: '最大化',
  close: '关闭',
} as const;

export function fmt(s: string, vars: Readonly<Record<string, string | number>>): string {
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (vars[k] === undefined ? m : String(vars[k])));
}
