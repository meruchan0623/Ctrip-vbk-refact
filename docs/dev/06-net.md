# 06 网页请求与消息网络边界

2026-10-30。业务请求、Web SDK 身份与补偿以目标网页实测为准，不移植桌面 SDK 网络层。

**实施前置**：先完成[逐接口请求契约](../api/README.md)及[开发准入](../api/readiness.md)。路由、HTTP 200、仅含类型的字段清单均不足以开始业务实现；Header、Authentication、方法、Query、完整 Body、动态来源与响应读回必须按接口核对。

## 实时通道与 HTTP 同步

当前网页是 **XMPP over WebSocket + 会话列表轮询 + 消息增量补偿** 的混合方式，详见[长连接与轮询实测](../research/2026-10-30-web-im-transport-and-polling.md)。

- WSS 实测地址为 `wss://im3.ctrip.com/ws-xmpp/`；另一入口还连接 `wss://im.ctrip.com/ws-xmpp/`，两者职责未确认，不按主备实现。握手为 HTTP 101、子协议 `xmpp`；经历流打开、SASL 鉴权、成功与 bind。
- 复用官方 SDK 的结构化消息和连接状态事件；SDK 收 `message`、发必要的 `notify_ack`，以 XMPP IQ `urn:xmpp:ping` 心跳。本次相邻 ping 约 5 秒；协议确认不等于客户已读或人工发送成功。宿主不另写 XMPP，也不另开提醒连接。
- **客人会话列表在 WSS 在线时仍轮询**：`16037/getConversationList[.json]` 本次两个入口均约 5 秒一次。A 的静态代码为响应后等待 5000 ms 再 POST，使用 `lastUpdateTime → startTime` 增量；另一入口的两个后缀必须分开统计。不能仅保留 WSS 而省略会话责任/状态同步。
- `11679/getRecentMessages` 本次约每 10 秒补偿消息，使用 `beginMsgTime/lastMessageTimestamp`。A 的 SDK 静态代码包含连接后普通补偿、连接中/断线时更频繁的补偿与普通补偿 5 分钟停止策略；故障分支尚未实测，不能把短窗口节律当作永久固定周期。
- 适配器区分实时、初始化、历史与补偿来源，按业务消息身份跨来源去重；会话列表游标和消息补偿游标分别维护。具体 SDK 生命周期、宿主后台运行与恢复以原型验证为准。

## 网络边界

- 网页鉴权保留真实 Cookie/Origin、动态公共头与平台请求层；不把客户端 `900004 + bticket` 直接套到网页 Web SDK。
- HTTP 状态、Ack、业务结果和页面可操作分别校验。写请求超时保留 unknown，先核对，不叠加通用自动重试。
- `getRecentMessages`、会话列表和历史承担原有同步职责；强提醒复用这些数据，不新增提醒专用轮询或声称有强提醒 API。
- 断网/重连分代处理；补偿完成后才恢复提醒。响应缺某条增量不是完整会话删除证据。
- 所有域名、跳转和请求绑定当前身份与目标网页版本；保持 TLS 校验，日志只保留脱敏结构与必要错误码。

不实现环境切换产品页、网关选择器、代理/PAC 管理或通用受限 fetch 产品接口。宿主必须的系统网络兼容性单独在实际运行环境验证，不引入用户未要求的设置。

依据：[网页调查](../research/2026-10-30-web-im-observation.md)、[订单流程](../research/2026-10-30-web-order-conversation.md)。旧网络层设计见[归档](../archive/desktop-baseline/dev/06-net.md)。
