# 订单联系查询接通

2026-11-03。按 `docs/dev/04-business-pages.md` 原需求实现：完整订单号查询 → 核对唯一结果 → IM 联系；退改确认仍在官方网页完成。截图的故障并非网络超时：`rpc.ts` 的 `order.search` 固定返回 `host.unsupported`，UI 把任何错误归为“可能已创建会话”。

## 桌面逆向结论

只读检查当前 `/Applications/旅游商家桌面版.app/Contents/Resources/app.asar.unpacked/dist/js`，文件哈希见[证据](evidence/order-query-20261103.json)。偏移是 Unicode 字符索引：

- `index-DKzkzNcK.js` 1960 附近：搜索类型为 content=0/customerName=1/orderId=2/all=3/time=4。
- `imWindow-BaGPtUvK.js` 2669365 附近：订单搜索走 `searchConversation`，订单命中在 `orderSearchList`，另可通过 `queryGroupInfo(orderId)` → `getLatestConversationByGid(gid)` 补查已有会话。
- 同文件 2734644、2756727、2757447 附近：`createChat` 按上下文分别调用 `startChatB2C`/`createChatB2O`，校验 `workSheetId` 后用 `groupId` 切换会话。所需 serviceType/vendorRefId/role/threadId 等来自业务上下文，不能仅凭订单号编造。
- 同文件 2758520 附近：复制群聊另有 `verifyOrderId` → `startChatB2MC`，不是当前订单联系入口。

因此保留原需求的官方订单路径 `14361/searchorderlist` → 用户点击后 `14361/createimchat`。本次接通查询，不把已有会话搜索当作完整订单查询，也不改造桌面任意请求/凭据桥接。

## 官方网页与真实代码验证

使用 ego-browser 在官方“全部”订单页，按用户提供的完整订单号操作查询。观察到 `page:"0"`、`aggSortType:{property:"orderDate",direction:"desc"}`；HTTP 业务响应 Ack Success、errorCode=0、totalCount=1，返回订单号与输入一致。其余查询参数为 pageIndex=1/pageSize=20/vbkVer=3/datablockType=0。

随后把本仓库编译出的 `searchOrderExact`、`SoaClient`、`searchedOrderSummary` 打包，在同一官方登录页面内执行真实查询：返回 one，summaryValid/idMatches/productPresent/statusPresent 全 true。没有保存客户明细、凭据或完整订单号，没有调用创建会话或发送消息。

## 实现与验收边界

- 取消 RPC 固定拒绝，使用上述已观测常量和当前账号登录态。
- 完整 10/16 位订单号以字符串提交；响应数字必须为安全整数，聚合订单和每条子订单均须匹配。展示保留多个子订单的商品/数量，联系人仅显示掩码，不透传 UID、电话或邮箱。
- 缺失业务成功码、详情或核对所需商品/状态时拒绝结果；多匹配不自动选单。
- 查询异常与超时分开，不再声称只读查询可能创建会话。创建入口原有未知结果不自动重试规则保留。
- 聚焦回归 91 项通过，全量 TypeScript/门禁测试 1060 项通过，类型检查及 UI/adapter bundle 构建通过；独立只读复核无剩余可行动问题。
- 真实浏览器查询通过不等于新原生安装包或“创建新会话”整条链路通过；本次未重启或替换正在运行的客户端。
