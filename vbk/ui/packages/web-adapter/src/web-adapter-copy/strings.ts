/** web-adapter display copy (message previews, labels, business-line names). Keys prefixed `web-adapter.`.
 * Template functions insert each dynamic value once, without interpreting placeholders in that value.
 * Upstream data labels are matched verbatim against the source payload; they are listed separately in
 * `webAdapterUpstreamLabels` and must never be shown as copy. */
export const webAdapterStrings = {
  'web-adapter.display.ticketsActivities': '门票活动',
  'web-adapter.display.serviceType': (value0: string | number): string => `业务线 ${value0}`,
  'web-adapter.display.labelledValue': (value0: string | number, value1: string | number): string => `${value0}：${value1}`,
  'web-adapter.display.systemOperator': '系统',
  'web-adapter.display.recalledMessage': (value0: string | number): string => `${value0} 撤回了一条消息`,
  'web-adapter.display.summaryOrder': '[订单]',
  'web-adapter.display.summaryVoice': '[语音]',
  'web-adapter.display.summaryQa': '[问答消息]',
  'web-adapter.display.summaryProduct': '[商品]',
  'web-adapter.display.summaryContent': '[内容]',
  'web-adapter.display.image': '[图片]',
  'web-adapter.display.card': '[卡片]',
  'web-adapter.display.video': '[视频]',
  'web-adapter.display.voice': '[语音]',
  'web-adapter.display.file': '[文件]',
  'web-adapter.display.fileNamed': (value0: string | number): string => `[文件] ${value0}`,
  'web-adapter.display.location': '[位置]',
  'web-adapter.display.message': '[消息]',
  'web-adapter.display.visitor': '访客',
  'web-adapter.display.sticker': '[表情]',
  'web-adapter.display.mentionMessage': '[提及消息]',
} as const;

/** Upstream field labels used as lookup keys (traditional and simplified variants). Not display copy. */
export const webAdapterUpstreamLabels = {
  productName: ['产品名称', '產品名稱'],
  sourceChannel: ['来源渠道', '來源渠道'],
  productId: ['产品ID', '產品ID'],
  customerLanguage: ['客户语言', '客戶語言'],
  productPrice: ['产品价格', '產品價格'],
} as const;
