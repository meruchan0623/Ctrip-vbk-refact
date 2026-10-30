# 网页 IM 长连接与客人会话轮询核验

2026-10-30，Asia/Singapore。本文记录真实网页网络行为和对应版本的公开脚本；不是新客户端实现或故障恢复验收。

## 1. 结论

**两个实测入口均存在 WebSocket 长连接，同时独立轮询客人会话列表。** 会话列表通过普通 HTTP POST 周期获取，不需要等到 Socket 断线才开始轮询。因此“客人会话列表采用定时轮询”的观察得到证实；不能进一步将整个 IM 描述为纯轮询，或断言大部分新消息都只能由轮询收到。

需要区分三层：

| 层次 | 本次证据 | 结论 |
| --- | --- | --- |
| 会话列表及其业务状态 | `16037/getConversationList[.json]` 持续约 5 秒一次 | 存在独立的会话列表增量轮询；正常有 WSS 时也运行 |
| 消息增量补拉 | `11679/getRecentMessages` 约 10 秒一轮；SDK 有不同连接状态下的补偿策略 | HTTP 消息补偿与 WSS 并行，不能删掉 |
| 实时消息与协议确认 | WSS 的 `message`、`notify_ack`、IQ 与 ping | 存在实时推送路径；Socket 在线不等于会话列表已同步完整 |

本次没有制造新的客户消息并追踪它首次通过哪条路径出现，不能给出“推送/轮询收到新客户消息的占比”。也未覆盖所有前后台、账号、角色和断网状态。

## 2. 取证方法与版本

使用 `ego-browser` 2.2.0，在单一临时任务空间内复用现有网页登录态。先打开消息入口，再在**同一轮脚本**中执行 `Network.enable → 清空事件缓冲 → reload/goto → 连续采集 Network 事件`；不把跨轮空缓冲当成没有网络连接。按 requestId 关联请求、响应和完成时间；统计 POST，排除 OPTIONS。

没有人工发送消息、选择客户会话、改客服状态或接受公告协议；网页自己的初始化、历史预取、协议应答和埋点仍正常发生。第二入口有“我已仔细阅读并同意”的公告遮罩，没有点击同意；底层消息模块继续运行。本结论针对捕获到的网络层，不能据此宣称该入口全部 UI 操作通过。

| 样本 | 时间（新加坡） | 入口与页面版本 |
| --- | --- | --- |
| 长连接单独复核 | 18:25:43 采集结束；刷新后等待约 12 秒 | `https://imvendor.ctrip.com/main?currentTab=BC&lang=zh-CN` |
| A：客人列表静置 | 18:28:08.733–18:28:54.090，约 45.4 秒 | 同上；NFES `100017720/1793085240908`，`pages/main-7928b3c422bccbc5.js`，SDK `ares2/basebiz.im/nodesdk/1.0.70/default/imsdk.js` |
| B：另一入口对照 | 18:29:47.845–18:30:24.504，约 36.7 秒 | `https://vbooking.ctrip.com/vbk/im/main?currentTab=BC&lang=zh-CN`；NFES `vbkIm/1793340371237`，`pages/main-3007b16f6fe839b6.js`，SDK `web-imclient-core/imsdk.850ee19f2122897fcb3d3d18f17bc8d4.js` |

两个入口载入的页面包不同，不能把同名方法的所有语义视作相同。B 的部署版本也不同于早先 15 时观测的 `1792569719501`。

## 3. 长连接形式与协议方法

### 连接与握手

- A 捕获 `wss://im3.ctrip.com/ws-xmpp/`；B 捕获该地址和 `wss://im.ctrip.com/ws-xmpp/`。
- 单独复核明确得到 HTTP `101 Switching Protocols`，WebSocket 子协议 `xmpp`。这是 **XMPP over WebSocket**，不是 SSE，也不是一次普通 HTTP 请求。
- 实际帧序列为客户端 `open`、服务端 `open / stream:features`、客户端 `auth`、服务端 `success`、重新 `open / stream:features`、客户端 bind IQ、服务端 IQ result。
- 命名空间包括 `urn:ietf:params:xml:ns:xmpp-framing`、`urn:ietf:params:xml:ns:xmpp-sasl`、`urn:ietf:params:xml:ns:xmpp-bind`。
- 沿用官方 SDK 和网页登录会话完成鉴权；不从抓包提取/重放认证值，也不把桌面 SDK 的票据模板套到网页。

### 消息、确认与心跳

- 收到 `type="chat"`、包含 `body` 的 `message` 帧，网页发送 `type="notify_ack"` 的 `message`。后者是协议确认，不能直接等同于客户已读或人工发送成功。
- 心跳是应用层 XMPP IQ：`type="get"` 加 `urn:xmpp:ping`；之后收到 IQ `type="result"`。它与 WebSocket 底层 ping/pong 不应混记。
- 单独复核中相邻两次出站 XMPP ping 相隔 `4.999910` 秒，随后分别约 `59.3 / 45.8 ms` 出现 IQ result；这是短窗口实测，不是跨环境心跳 SLA。
- A 的 45 秒样本共 57 个收发帧，其中 13 个 `message`、36 个 IQ、8 个出站 ping；B 共 131 个收发帧。帧数包含控制/确认，不能当作独立客户消息数。
- B 的两条连接均有流量，尚未逐一确认其页面组件/账号职责，不能命名为主备，也不能把两边的消息直接相加计算业务量。

接入方法是通过官方 Web IM SDK 的结构化消息和连接状态事件衔接宿主，由 SDK 负责现有 XMPP 传输。Rust 不另写协议栈，强提醒不另开连接；原始 XML 只用于定位协议，不成为业务层消息契约。SDK 脱离原站、后台运行与恢复仍需原型验证。

## 4. 客人会话列表的轮询证据

### A：imvendor 独立消息页

`POST https://m.ctrip.com/restapi/soa2/16037/getConversationList.json` 在窗口内发出 **9 次**，全部 HTTP 200。连续间隔为：

```text
5.127036, 5.119191, 5.161609, 5.240284,
5.252860, 5.230867, 5.134729, 5.207404 秒
```

各次请求完成耗时 `116–251 ms`。首次 body 字段为 `needTodoList,locale,head`，后续增加 `startTime`；响应观察到 `conversationList,currentStatus,lastUpdateTime,haveRest`。首次列表有 20 项，后续出现空增量。

对应版本 `commons-16402123d854e2fd.js` 的调用链已静态核对：

1. 会话控制器调用 `conversationModel.loop({interval:5e3,...,params:{needTodoList:1}})`。
2. 模型 URL 是 `getConversationList.json`；把响应 `lastUpdateTime` 用作下轮 `startTime`。
3. 通用 `infinite` 方法执行 POST，响应处理后再用 `setTimeout(..., interval)` 安排下次请求；鉴权失效另行处理。

这解释了“5 秒等待 + 本次请求耗时”的约 5.1–5.3 秒间隔。请求很快结束，再按时重发，属于**普通定时轮询**，不是等待服务端长期挂起响应的 HTTP long polling。该循环不以 Socket 断线为启动前提；本窗口 WSS 同时正常收发。

### B：vbooking 消息入口

无 `.json` 后缀的 `POST /16037/getConversationList` 共 **9 次**。前两次相隔约 `0.181` 秒，属于启动阶段；之后连续间隔：

```text
4.982316, 5.001364, 5.000416, 4.999056,
5.001477, 4.997986, 5.000840 秒
```

请求完成耗时 `116–209 ms`，全部 HTTP 200。与此同时，两条 WSS 均存在。带 `.json` 的同族接口仅在启动阶段出现 2 次，不能合并两个 URL 后再计算周期；B 的具体定时器实现未另做静态定位。

因此，两个本次正常前台样本均证明客人会话列表持续以约 5 秒轮询更新。早先“未观察到网页列表每 5 秒轮询”只适用于当时窗口，不能继续作为当前版本没有轮询的依据。

## 5. 消息补拉与历史请求不是同一个循环

- A 的 `/11679/getRecentMessages` 共 6 次。前两次相隔约 `0.526` 秒，之后为 `10.145 / 10.120 / 10.232 / 10.214` 秒；请求耗时 `72–234 ms`，同样是短 HTTP 请求。body 字段为 `beginMsgTime,pageSize,head`，响应含 `lastMessageTimestamp`，部分含 `messages,localIds`，其中一轮返回 2 条消息。
- B 的该接口共 10 次，启动后的时间序列与两路约 10 秒循环交错相符；这是时序推断，两个调用来源和消息重复程度尚未逐一关联。不将交错后的短间隔错误解释成单一路由的固定周期。
- A 的 `getMessageList` 在启动阶段集中发出 15 次，B 集中初始化后另有后续请求；不能把启动预取的突发请求当成稳定的历史消息轮询周期。

对 A 实际加载的 SDK 脚本已核对：默认 `compensationInterval=10000`；`GetRecentMessages.loop` 将 `chat/groupchat` 消息交给消息处理链。Socket 接收链也调用消息处理，标注 `pollType="socket"` 并发送必要的 `notify_ack`。这是两条消息来源共存的静态依据。

SDK 另有以下**静态策略，尚未故障注入验证**：连接建立后 `startNormalLoop` 采用默认 10 秒补偿，并设置 300000 ms 后停止该循环；连接中/断线走 `startFrequentLoop`（默认间隔的一半，即 5 秒），不支持 WebSocket 的分支走 `startDemoteLoop`（5 秒）。因此不能把本次启动后看到的 10 秒补偿写成永远运行的固定轮询；也不能用它证明所有消息主要靠 HTTP 接收。该 SDK 策略与业务层会话列表的 5 秒循环是两件事。

## 6. 对当前设计的约束

1. 同时保留官方 SDK 实时通道、消息补偿和业务会话列表轮询。连接在线不是取消轮询的理由；只有受控验证证明等价，才可改变官方同步机制。
2. 适配器分别标明实时、初始化、历史、补偿来源；同一业务消息跨通道去重。会话责任/状态与聊天消息分别同步。
3. `startTime/lastUpdateTime` 属于会话列表链；`beginMsgTime/lastMessageTimestamp` 属于消息补偿链。两者不互换；空增量不等于删除会话或已同步全部。
4. 强提醒读取合并后的消息、责任与确认事实，不另建提醒连接或提醒轮询。恢复时必须同时核对消息与会话状态。
5. 实现前仍需验证补拉分页/边界、推送与补拉交错、后台/睡眠、断线与重新鉴权，以及新消息跨通道到达顺序。本文未完成这些验收。

## 7. 脱敏证据

- [长连接单独复核](evidence/web-im-websocket-live-20261030.json)：握手、协议帧类别和时间。
- [A：45 秒 HTTP/WSS 连续记录](evidence/web-im-polling-live-20261030.json)：请求时间、字段名、响应状态/数组长度、调用脚本位置和 WS 元数据。
- [B：36 秒入口对照](evidence/web-im-polling-vbooking-20261030.json)：两种列表 URL、请求节律、两条 WSS 与页面版本。
- [A：对应脚本静态摘录](evidence/web-im-polling-static-20261030.json)：URL、SHA-256、字符偏移、列表定时器和 SDK 消息/连接策略。

证据未保留密码、Cookie/认证值、客户身份和聊天正文。HTTP 200、协议确认、业务成功和 UI 可用分别判断。
