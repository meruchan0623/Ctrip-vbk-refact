# 客户端 IM 静态证据补充

2026-10-30。仅检查本地分发包源码，没有运行客户端或请求生产接口。接口存在于源码不等于已验证线上可用；浏览器实测以本目录网页调查记录为准。

## 来源与复核定位

- 归档：`vbk-electron/resources/TripVendorCompanion.Install/original.asar`，SHA-256：`e1cd32d35e9526cc29f1878532bcbdae8284e522a4d8c588b6214801a145bc49`。
- 归档内 `dist-electron/main/imsdk.js`：单行压缩文件，以函数名及字符串定位；SHA-256：`ed268519dc618efa7ad368bef8845a3bb9234843ffe40f5c23e2e64a714c9e1a`。
- 归档内 `node_modules/@ctrip/s-node-imclient-core/main.js`：下表行号均针对该文件，SHA-256：`8cfdce3050a892a95f0437e429b30a934ad5f7b1421a055893cd4c99fd629c9b`。
- 同包 `package.json` 标明 SDK 版本 `1.0.24`，入口 `main.js`，无声明 dependencies。
- 业务接口另查 `vbk-electron/resources/app.asar.unpacked/dist/js/BaseController-_xbuiF6A.js`，以 API 字符串检索；该文件属于当前解包资源，不将其与归档 SDK 的版本一致性当作已验证事实。

## 收发与鉴权

| 主题 | 源码事实 | 定位 |
| --- | --- | --- |
| SDK 初始化 | `appId:"900004"`、`conversationType:ConversationList`、`initPageSize:0`、`withoutExtra:true`、`network:EXTERNAL`、`token`；包装层没有显式传 UID | `imsdk.js` 函数 `k` |
| 包装层兜底 | `let i=await P(n);i.res\|\|(i=await I(n))`；P 调 `sendMessageInSocket`，I 调 `sendMessage` | `imsdk.js` 函数 `d`、`P`、`I` |
| SDK 内部兜底 | socket 未连接时，`sendMessageInSocket` 直接调用 HTTP `sendMessage`，所以外层失败重试可能是第二次 HTTP 尝试 | `main.js:17363`，检索 `if(!XMPPClient.isSocketConnected())` |
| HTTP 发送地址 | `/restapi/soa2/11679/SendMessage.json`，生产默认网关 `m.ctrip.com` | `main.js:18603`，`config/im.api.js` |
| HTTP 业务成功 | `status.code` 非 0 且非 3 时进入失败；源码注释明确将重复消息视为成功。包装层还要求 `ResponseStatus.Ack` 为 success | `main.js:17273` 起的 `sendMessage`；`imsdk.js` 函数 I |
| 关联标识 | 两条路径都使用 `message.localId \|\| utils.createGuid()`，调用方应提供并保留稳定 localId；缺失时不能据此承诺跨调用幂等 | `main.js:17273`、`17363` |
| HTTP 鉴权 | Node 请求 `withCredentials:false`，将 token 写入请求体 `head.auth`；Web 分支有 token 时亦如此，无 token 时才 `withCredentials:true` | `main.js:20192` 附近 `fetch` |
| 公共 body head | `cver`、`extension`：protocol、cpc、appid，并按配置加入 language、client-source、syscode、自定义扩展 | `main.js:20105` 附近 `buildParams` |
| WSS | 默认生产 `im3.ctrip.com/ws-xmpp/`，服务域 `im.ctrip.com`；IBU/Trip 走 `getImServer` 动态地址 | `main.js:17706`、`18562` |
| SASL | username 为 `IMConfig.getUID()`，password 为 `getWSPassword()`；有 token 时直接返回 token，另有扩展参数分支 | `main.js:18109`、`18138` |
| 实例隔离 | `connectXMPP` 显式保证单实例，旧 client 被停止；不能在同一 SDK 模块实例中直接 init 多账号 | `main.js:18138` 起，检索 `保证单实例` |

HTTP 发送 body 字段：`localId`、`bizType`、`localTimeStamp`、`partnerJid`、`msgType`、`messageBody`、`type`、`subject`、`threadId`、`newthread`、`resource`；存在引用时增加 `citemsgid`。Socket body 另含 `conversationType`、`toJid`。成功回调用 `msgId`、`msgCreateTime` 回填消息。以上只记录字段名，不包含客户正文、账号或 token。

这说明“网页接口”和“客户端接口”不宜先假定是两套互斥服务：SDK 自身已包含 Web/Node 环境分支、HTTP 和 WSS 两种传输。需要逐项比对网页实际 service/method、body、鉴权、回执和错误语义。

## 关键接口清单

| 用途 | SDK 或业务层路径（相对于网关） | 来源 |
| --- | --- | --- |
| IM 身份/分片 | `/restapi/soa2/11679/GetMyInfo.json`、`getImServer.json` | SDK `config/im.api.js` |
| SDK 历史/会话 | 同服务 `getRecentMessages`、`getMessagesByGid`、`getLatestConversation4js.json`、`GetMamConversationMessages.json`、`GetGroupMessages.json`、`GetConversations.json` | 同上 |
| 已读/未读 | 同服务 `PutAdviceOfReadByMsgId.json`、`PutAdviceOfRead.json`、`GetTotalUnreadcount.json`、`GetConversationUnreadInfo.json` | 同上；包装层调用前者 |
| 群/撤回 | 同服务 `GetGroupMembers.json`、`GetGroupInfo.json`、`RecallMessage.json` | 同上 |
| 商家会话与历史 | `/restapi/soa2/16037/getConversationList`、`getLatestConversationByGid`、`getConversationInfoByGidList`、`getMessageList` | BaseController API 表 |
| 客服身份/排班 | 同服务 `getVenAgentByUid`、`getAgentWorkingSchedule`、`syncVenAgentInfo`、`setVenAgentStatus` | 同上 |
| 会话业务动作 | 同服务 `finishConversation`、`transferVenMaster`、`inviteVenAgent`、`startChatB2C`、`createChatB2O` | 同上 |
| 订单/话术/备注 | 同服务 `getDLTOrderInfo`、`verifyOrderId`、`getCustomerScripts`、`getCategories`、`getRemarkList`、`modifyRemark` | 同上 |
| 上传令牌 | 同服务 `uploadTokenCreate`；实际对象上传链路不能由此推定 | 同上 |
| 翻译/IQ | `/restapi/soa2/11679/getMessageTranslate`、`batchTranslateByMsgIds`、`getIQConversations`、`getIQMessages`、`putAdviceofreadIQMessage` | 同上 |
| 业务登录校验 | `/restapi/soa2/12405/getCurrentUserInfo`、`checkUserLogin`、`authToken` | 同上；存在 authToken 不等于已证实续期用途 |

路径大小写和 `.json` 后缀按各自源码记录，不将看似同名的方法自动归并。SDK 泛用历史接口存在，也不能推翻当前商家 UI 使用 16037 的证据。

## 原方案尚未验证的边界

- SDK 源码可读及当前 Electron 使用它，不代表脱离 Electron 后 Node SEA 已运行通过。代理传递、Node 全局 WebSocket、打包、重连、Windows 后台及多账号负载仍需原型。
- 网页复用若要求隐藏 WebView 常驻，应测后台节流、系统睡眠恢复和账号隔离；若只复用 HTTP/WS 协议并放 Rust 运行，则没有“网页后台”问题，但需要自己补齐 SDK 的状态、回执、重试和群同步语义。
- 包体不应凭估计判优：目前设计预算为一期 ≤45 MB、二期 ≤30 MB，原有口径矛盾已修正；这仍是目标而非实测结果，WebView2前置运行时另计。
- SDK `onXMPPError` 在 `UNABLE_TO_VERIFY_LEAF_SIGNATURE` 时设置 `NODE_TLS_REJECT_UNAUTHORIZED='0'`（约17768行）；内部网络分支亦有同类代码。采用 sidecar 时必须移除全局降级行为，不能宣称原包符合 core-net 的 TLS 约束。
- `imsdk.js` 及 SDK 会记录初始化参数、socket 参数与消息详情。正式包装不能直接继承日志，否则凭据及客户正文可能进入诊断日志。

## 前轮建议及本轮处理

以下建议为前轮审查记录。本轮已在 IM 开发文档与决策记录同步；不代表对应功能实现或验收已完成。

1. `10-im.md` 1/4.6：将 sidecar 明确为已有静态证据的候选基线，链接网页调查与选型决策；未完成实测前不将其写成不可更改的一期结论。
2. `10-im.md` 2.1/7：补两层 HTTP 兜底、稳定 localId、业务状态判断，区分源码事实和无重复无丢失的验收目标。
3. `06-net.md` 一/4.2：业务 Cookie HTTP 与 SDK `head.auth` HTTP 分列；现有 SDK 自带 HTTP 客户端，若保留它须定义 core-net 统一代理/日志策略的例外，或设计显式请求转发适配。
4. `02-account-login.md` 11：网页入口与 Cookie 名的待确认项由浏览器证据更新；仅看到已登录页面不能证明重新认证、续期或失效链路。
5. `10-im.md` 4.6/9/11：与总纲一期45 MB口径统一；增加 TLS降级与日志处理改造项。

## 客服状态与个人设置补充

状态枚举、切换回读、角色验证、排班／快捷回复／自动答复／自动翻译及桌面偏好的详细调用链，见 [客服状态与个人设置实施调查](2026-10-30-agent-status-and-settings.md)。该补充为静态证据，未执行生产状态切换或设置保存。

## 最终审查：不能从静态代码推定的契约

- SDK源码注释把 `status.code=3` 作为重复成功，只能证明该版本客户端的处理方式；服务端去重键、作用域与保留时长没有证据。稳定localId是必要防护，不能单凭它承诺exactly-once。
- SDK内部可能在消息入库前自动确认收到。应用层后写入成功才发UI事件，不足以证明崩溃不会丢消息；应把SDK确认与服务器可补偿水位纳入原型。
- 网页历史代码真实使用 `groupId/conversationType/pageSize` 以及 `beginTime/endTime/direction`，读取 `rangeMessage.messages/lastMessageTime`；原方案的 `after=msgId` 只是臆定内部设计，不能作为上游参数直接实现。
- 账号Ready、IM已连接、客服工作状态和会话操作权限是四个不同事实；任何一个成功不能替代其余三个。
