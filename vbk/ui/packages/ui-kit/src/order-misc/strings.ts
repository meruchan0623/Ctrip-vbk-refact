/**
 * zh-CN copy for the order-info, TSIM operator overlay, column resizer,
 * inbound translation, voice bubble, message preview and message menu
 * surfaces. Spread into the shared table in `../i18n.ts`.
 */
export const orderMiscStrings = {
  // order-info reference labels (ORDER_INFO_LABELS)
  'orderMisc.orderInfo.sourceChannel': '来源渠道',
  'orderMisc.orderInfo.orderId': '订单ID',
  'orderMisc.orderInfo.customerLanguage': '客户语言',
  'orderMisc.orderInfo.productId': '产品ID',
  'orderMisc.orderInfo.product': '产品名称',
  'orderMisc.orderInfo.productPrice': '产品价格',
  'orderMisc.orderInfo.useDate': '使用日期',
  'orderMisc.orderInfo.totalAmount': '订单总额',
  'orderMisc.orderInfo.remarkName': '备注名称',
  'orderMisc.orderInfo.quantity': '数量',
  'orderMisc.orderInfo.status': '订单状态',

  // TSIM operator overlay
  'orderMisc.operator.timeout': 'TSIM 页面尚未接管登录态，可在页面内登录，或关闭后重试。',
  'orderMisc.operator.loadFailed': 'TSIM 页面未能加载，请关闭后重试。',
  'orderMisc.operator.close': '关闭窗口',
  'orderMisc.operator.opening': '正在打开 TSIM 订单页…',
  'orderMisc.operator.handoffSlow': '正在使用 TSIM 登录态打开订单…第一次打开可能较慢，请等待',
  'orderMisc.operator.completeLogin': '请在 TSIM 页面内完成登录。',

  // workspace column resizer
  'orderMisc.columns.resizeLeft': '调整会话列表宽度',
  'orderMisc.columns.resizeRight': '调整详情栏宽度',
  'orderMisc.columns.resizeHint': '拖动调整宽度，双击恢复默认；方向键微调',

  // inbound translation
  'orderMisc.translate.requestTimeout': '翻译请求超时',
  'orderMisc.translate.invalidResult': '翻译结果无效',

  // voice bubble / message preview / message menu
  'orderMisc.voice.openExternal': '外部打开',
  'orderMisc.preview.voice': '[语音]',
  'orderMisc.menu.messageActions': '消息操作',
} as const;
