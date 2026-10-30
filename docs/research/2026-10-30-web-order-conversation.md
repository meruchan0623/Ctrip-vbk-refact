# 网页按订单号打开客户会话

2026-10-30，Asia/Singapore。依据 `ego-browser` 真实操作、脱敏网络契约摘要与当前网页代码；不以桌面客户端行为作为实现要求。范围遵循[网页版决定](../decisions/2026-10-30-web-only-scope.md)。

## 1. 已走通的流程

### A. 从订单详情联系客户

1. 在旅游供应商平台展开“订单管理”，进入“景点玩乐订单”：`https://vbooking.ctrip.com/ticket_order/order/list`。
2. 选“全部”，在“完整订单号或后4位查询”输入一个本账号可见的完整订单号，点击“查询”。等待页面实际显示“搜索结果：1个订单”，再核对订单；不能只看输入框已填好或旧列表仍在。
3. 点击唯一结果的“详情”，打开 `/ticket_order/order/detail?orderId=<订单号>`。
4. 在“联系人”旁点击 **“IM 联系”**。它与上方“联系携程客服”是两个不同入口；本次探索的是联系客人。
5. 详情页调用 `POST https://sec-m.ctrip.com/restapi/soa2/14361/createimchat`，随后新标签打开返回的 IM URL。
6. 本次落地 `https://imvendor.ctrip.com/main`；页面显示对应客户的会话标题、3 人成员数、结束按钮、输入区和发送按钮。没有手动发送消息。

本次是打开真实业务会话，不是纯被动抓包：`createimchat` 和后续页面初始化可能创建/激活会话、加入成员或触发已读。未重复点击该入口，也未对它做请求 replay；不能宣称它幂等。

### B. 在新版消息页按订单号搜索

1. 在 `https://vbooking.ctrip.com/vbk/im/main` 的“消息”页，在“聊天记录/用户/日期/订单号”框输入同一完整订单号。
2. 实测先发 `16037/searchConversation`，并发出补充查询 `15529/queryGroupInfo`；页面出现“订单号”分组下的客户结果。
3. 点击结果，弹出“与……的会话历史”，底部按钮实际叫 **“开始聊天”**。
4. 点击“开始聊天”后关闭历史窗口、清空搜索，主区域出现对应客户标题、3 人成员数和“发 送”按钮。

本次只证明“已有可见会话能通过订单号找到并打开”。不能据此承诺：一个从未建立过 IM 会话的订单，仅靠搜索框就能创建新会话。创建路径以 A 的官方联系入口为依据。

## 2. 动态接口契约

以下路径相对 `/restapi/soa2`；公共 `head`、Cookie 和平台请求层动态字段沿用当前网页登录态，证据没有保存其值。

| 操作 | 方法、路径 | 已观察业务字段 | 返回/读回与限制 |
| --- | --- | --- | --- |
| 完整订单号查询 | POST `sec-m.ctrip.com/14361/searchorderlist` | `ttdOrderId:string`；另有 `contentType, page, pageIndex, pageSize, aggSortType:{property,direction}, vbkVer, datablockType` | 响应含 `response, orderList, totalCount`；UI 确认唯一订单。最初切换“全部”还会自动查询不带订单号的列表，不能把该请求误当精确查询 |
| 订单联系客户 | POST `sec-m.ctrip.com/14361/createimchat` | `ttdOrderId:string`，另有 `contentType, head` | HTTP 200、`ResponseStatus.Ack=Success`；响应含 `response:{errorCode,errorMsg}, url`；随后实际进入客户会话。未保留 errorCode 的值，业务成功以 UI 读回支持 |
| 搜索已有会话 | POST `m.ctrip.com/16037/searchConversation` | `searchType:number, searchValue:string, pageNo:number, head` | 响应的订单结果分组出现在页面；`searchType` 取值不能凭名称编造，本次只保存类型 |
| 订单补查群号 | POST `m.ctrip.com/15529/queryGroupInfo` | `orderId:string, head` | 当前样本响应为 `gid:null`；页面结果来自搜索结果，不能把这个请求算成成功完成了群号映射 |

脱敏记录：[网络证据](evidence/message-notice-order-live-20261030.json)，重点 phase 为 `click-order-im-contact`、`im-search-by-existing-order-number`、`exact-order-query-contract`。证据按收集时点分段；同一浏览器任务空间还开着其他网页，队列可能包含它们的自然请求，phase 中的 `eventDrainPage` 是读取队列的页面，不是每条请求已验证的归属。摘要已移除 OPTIONS 与无关请求；未读到的早期/其他子会话响应体以 `responseBodyReadFailures` 或 `bodyReadFailures` 计数，不将 HTTP 200 当作已取得业务数据。

## 3. 返回的 IM 地址

[脱敏地址记录](evidence/order-im-route-20261030.json)保留了字段名和非个人常量，没有保存完整订单号、账号、群号或客户标识。

本次路径为 `https://imvendor.ctrip.com/main`，参数包括：

| 参数 | 本次值/来源 |
| --- | --- |
| `initChat` | `2`，客户会话分支 |
| `serviceType` | `1513`，当前门票活动样本；不能推广到所有业务线 |
| `vendorRole` | `VBK` |
| `currentTab` | `BC` |
| `accountsource` | `VBK` |
| `client-source` | `pc-1001` |
| `lang` | 本次为空 |
| `vendorRefId, threadId, orderNo, extParams, targetGid` | 由服务端返回的 URL 提供；记录只保存字段名，本次 `targetGid` 为空 |

新客户端应校验官方返回 URL 的 HTTPS、精确来源与允许路径，再解析为类型化数据；账号、供应商和会话仍须重新授权。不要丢掉未知业务参数后自行重拼一条“看起来一样”的 URL。也不要拿 `14735/getOrderDetailsForVbk` 代替“订单号 → 联系入口”：前者是 IM 侧栏详情接口，职责不同。

## 4. 网页静态补齐的后续链路

当前新版网页 `296-1776b2655d6f3342.js` 与旧版 `imvendor` 的 `commons-16402123d854e2fd.js` 均包含客户会话创建逻辑：`initChat=2` 进入 `16037/startChatB2C`；消费返回的 `workSheetId, groupId` 等数据。当前新版调用中有 `serviceType, vendorRefId, role, threadId, orderNo, extParams, customerUid, sessionId, groupId, languageInfo`，旧版还按存在性组装 `source:"h5"` 等字段。两版不能混拼固定模板。

新版订单搜索的补充路径是 `queryGroupInfo(orderId)` → 有 `gid` 才调 `16037/getLatestConversationByGid(head,gid)` → `16037/getRemarkList` 补显示信息。本次 `queryGroupInfo` 返回 `gid:null`，没有动态证明该补充路径成功；也没有把搜索结果中的 UID 当成新会话创建授权。

由于落地页出现浏览器通知权限提示，用户处理提示前初始化已发生。本次未完整捕获 `startChatB2C` 请求/响应，不重放初始化去补抓。它属于已定位的网页静态契约，不是这次的方法级动态验收。源码 SHA 与摘录见[网页静态证据](evidence/web-message-notice-static-20261030.json)。

## 5. 实现和验收范围

- 默认使用完整订单号，保留字符串；页面允许后四位搜索不意味着可自动选择多条匹配结果。
- 优先复用已有可见会话；无结果时保留明确的“未找到”，不要静默新建群。
- 需要新发起时，以本账号订单详情的官方“IM 联系”或其已验证契约取得目标，不直接接受外部传入的客户 UID、供应商编号或群号。
- `createimchat/startChatB2C` 均按可能改变会话状态处理；超时后先核对，不自动重试。
- 后续仍须验证无权限订单、无会话订单、失效/关闭会话、多匹配和失败返回；本次没有把这些场景标成通过。
