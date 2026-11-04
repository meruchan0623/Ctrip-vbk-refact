/** Message tools copy (forward dialog, saved emoji panel). Interpolation mirrors i18n `t()` `{name}` placeholders. */
export const messageToolsStrings = {
  'messageTools.feedback.sent': '已发送',
  'messageTools.feedback.rejected': '发送失败',
  'messageTools.feedback.rejectedReason': '发送失败：{reason}',
  'messageTools.feedback.unknown': '结果未知，请核对会话',

  'messageTools.forward.title': '转发消息',
  'messageTools.forward.close': '关闭转发',
  'messageTools.forward.list': '选择接收会话',
  'messageTools.forward.search': '搜索会话',
  'messageTools.forward.selectConversation': '选择 {title}',
  'messageTools.forward.send': '发送',
  'messageTools.forward.sending': '发送中…',
  'messageTools.forward.cancel': '取消',
  'messageTools.forward.avatarFallback': '会',
  'messageTools.forward.noMatch': '没有找到会话',
  'messageTools.forward.empty': '暂无可转发的会话',
  'messageTools.forward.selectedCount': '已选 {count} 个会话',
  'messageTools.forward.revisionChanged': '会话已变化，未发送',
  'messageTools.forward.partialUnconfirmed': '部分消息未确认，请查看各会话的结果。',
  'messageTools.forward.done': '已转发到 {count} 个会话',

  'messageTools.summary.image': '[图片]',
  'messageTools.summary.video': '[视频]',
  'messageTools.summary.voice': '[语音]',
  'messageTools.summary.file': '[文件] {name}',
  'messageTools.summary.card': '[卡片]',

  'messageTools.emoji.title': '我的表情',
  'messageTools.emoji.close': '关闭表情',
  'messageTools.emoji.search': '搜索表情',
  'messageTools.emoji.listLabel': '已保存的表情',
  'messageTools.emoji.loading': '正在加载…',
  'messageTools.emoji.saving': '正在保存…',
  'messageTools.emoji.deleted': '已删除',
  'messageTools.emoji.saved': '已保存',
  'messageTools.emoji.saveFailed': '保存失败，请重试',
  'messageTools.emoji.sending': '正在发送…',
  'messageTools.emoji.sent': '表情已发送',
  'messageTools.emoji.menuFront': '移到最前',
  'messageTools.emoji.menuPreview': '预览',
  'messageTools.emoji.menuRename': '编辑名称',
  'messageTools.emoji.menuDelete': '删除',
  'messageTools.emoji.itemTitle': '{name} · 点击发送，右键管理',
  'messageTools.emoji.defaultName': '表情',
  'messageTools.emoji.unnamed': '未命名',
  'messageTools.emoji.itemLabel': '发送表情 {name}',
  'messageTools.emoji.noMatch': '没有找到表情',
  'messageTools.emoji.empty': '暂无保存的表情',
  'messageTools.emoji.nameRequired': '请输入名称',
  'messageTools.emoji.deleteConfirm': '删除这个表情？',
  'messageTools.emoji.save': '保存',
  'messageTools.emoji.nameLabel': '表情名称',
  'messageTools.emoji.loadFailed': '加载表情失败，请重新打开',
  'messageTools.emoji.addFailed': '添加表情失败，请重试',
  'messageTools.emoji.added': '已添加到我的表情',
  'messageTools.emoji.hint': '点击发送 · 右键管理',
} as const;

export type MessageToolsKey = keyof typeof messageToolsStrings;

/** Same placeholder semantics as `t()`: unknown placeholders are left verbatim. */
export function messageToolsText(key: MessageToolsKey, vars?: Readonly<Record<string, string | number>>): string {
  const s: string = messageToolsStrings[key];
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, name: string) => {
    const v = vars[name];
    return v === undefined ? m : String(v);
  });
}
