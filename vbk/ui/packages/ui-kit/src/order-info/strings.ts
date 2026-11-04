/** Original order panel copy; protocol fields and order data remain unchanged. */
export const orderInfoStrings = {
  "orderInfo.label.source": "来源渠道",
  "orderInfo.label.id": "订单ID",
  "orderInfo.label.product": "产品名称",
  "orderInfo.label.date": "使用日期",
  "orderInfo.label.amount": "订单总额",
  "orderInfo.label.remark": "备注名称",
  "orderInfo.label.quantity": "数量",
  "orderInfo.label.status": "订单状态",
  "orderInfo.notice.order": "该订单号不是完整的 10/16 位数字，无法在 TSim 中查询。",
  "orderInfo.notice.revision": "会话身份尚未核验，请等待会话更新后再查询订单。",
  "orderInfo.notice.login": "请先在设置的“商家助手 · TSim 登录”中登录 TSim，再查询订单。",
  "orderInfo.notice.failed": "TSim 订单查询窗未打开，可能是会话、订单或 TSim 身份已变化。请核对后重试。",
  "orderInfo.queryTitle": "在 TSim 中查询该订单",
  "orderInfo.queryLabel": "在 TSim 中查询订单 {order}"
} as const;
