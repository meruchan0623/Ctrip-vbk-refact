# 04 订单联系入口

2026-10-30。当前不再实现通用业务页承载系统，只保留聊天需要的订单联系路径。

正式入口：订单管理 → 操作栏“详情” → 联系人旁“IM 联系” → 返回的网页会话标签。详情页的“联系携程客服”不是联系客人的同一按钮。

- `POST /14361/searchorderlist` 按完整 `ttdOrderId:string` 查询，先核对唯一结果。
- `POST /14361/createimchat` 从当前有权限的订单取得 IM URL，再校验 HTTPS、精确来源、身份并打开。
- 新版消息页的订单号搜索只证明能找到已有会话，不能替代主动发起入口。
- **客户端界面**：订单联系页的搜索结果操作栏不再放“详情”，改为两个按钮：
  - **IM 联系**：对该订单走 `createimchat` 取得会话并在消息页打开；已有会话优先复用。
  - **网页高级操作**：退改、确认等需要在网页完成的操作，用内置 WebView 直接打开 `https://vbooking.ctrip.com/ticket_order/order/detail?orderId={订单号}`，沿用当前账号的网页登录态；客户端不重做这些操作。
- 不接入确认、退款、核销、批量导出，不重建业务菜单、BI、公告或工作台，也不做它们的角标。
- 未找到/多结果/无权限都显式提示；可能创建会话的请求超时不盲目重放。

2026-10-30 落盘：`vbk/ui/packages/web-adapter/src/order.ts`（`searchorderlist` 以字符串 `ttdOrderId` 精确查询并要求唯一结果，`createimchat` 只在 Ack Success 且有 url 时成功，超时记 `unknown_may_have_created` 不重放，返回 URL 精确来源/路径校验并保留未知参数）；`vbk/crates/core-net/src/url.rs` 为宿主侧同等校验（`order_validate_im_url` 命令）；`vbk/ui/apps/main` 订单联系视图按上述两个按钮与四种失败状态实现，多结果需先“选择此订单”。审查发现并修正：订单接口曾误用 IM 业务 head，样本显示为平台 head（`cver 1.0`、无 `appId`）；`x-req-src` 来源未知，未发送。无权限判定依赖 `errorMsg` 文本，未经 14361 实测。

方法、参数、网页版本与证据边界以[实测调查](../research/2026-10-30-web-order-conversation.md)为准。旧业务页 bridge/保活方案见[归档](../archive/desktop-baseline/dev/04-business-pages.md)，不作为开发要求。
