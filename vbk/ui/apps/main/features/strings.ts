/**
 * zh-CN strings of the feature modules. Kept next to the modules so a
 * sub-item never edits the window's shared string table; the runtime's
 * `ctx.t` looks here first. Keys are `<feature>.<name>`.
 */

const featureZhCN = {
  'typing.indicator': '对方正在输入…',
  'recall.action': '撤回',
  'recall.confirmTitle': '撤回这条消息？',
  'recall.confirmBody': '撤回后对方将看到「消息已撤回」，此操作不可恢复。仅限发送后 2 分钟内的消息。',
  'recall.confirmOk': '撤回',
  'recall.cancel': '取消',
  'recall.done': '消息已撤回',
  'recall.expired': '已超过 2 分钟，无法撤回',
  'recall.clockUnknown': '服务器时间未校准，暂时无法判断是否可撤回',
  'recall.unknown': '撤回结果未知，请刷新会话确认；不会自动重试',
  'recall.rejected': '服务器拒绝撤回：{msg}',
  'recall.failed': '撤回失败，请稍后重试',
  'recall.recalledLabel': '消息已撤回',
  'queue.banner': '客户正在排队等待人工',
  'queue.detail': '服务器返回：{msg}',
  'queue.dropOut': '退出排队',
  'queue.dropOutUnsupported': '退出排队接口尚未验证，暂不可用',
  'queue.dismiss': '关闭',
  'voice.play': '播放语音',
  'voice.pause': '暂停语音',
  'voice.failed': '语音无法播放',
  'voice.unavailable': '语音消息暂不支持',
} as const;

export type FeatureStringKey = keyof typeof featureZhCN;

export function hasFeatureString(key: string): key is FeatureStringKey {
  return Object.prototype.hasOwnProperty.call(featureZhCN, key);
}

export function featureText(key: FeatureStringKey, vars?: Readonly<Record<string, string | number>>): string {
  const raw: string = featureZhCN[key];
  if (!vars) return raw;
  return raw.replace(/\{(\w+)\}/g, (m, name: string) => (Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m));
}
