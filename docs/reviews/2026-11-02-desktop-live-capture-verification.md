# 旅游商家桌面版实机接口截获：对 rea 逆向结论的验证

2026-11-02 14:41–14:50（Asia/Shanghai）。对象：正在运行的 `/Applications/旅游商家桌面版.app`（主进程 PID 32407，双账号，两个 `[im sdk]: inited` 于 14:41）。原始（脱敏）数据：[desktop-live-capture-2026-11-02.json](../observations/desktop-live-capture-2026-11-02.json)。

## 方法与边界

- 不重启、不改系统代理、不装证书：向主进程发 `SIGUSR1` 启用 Node inspector（127.0.0.1:9229），在主进程内对 20 个 `webContents` 被动挂 CDP `Network` 事件，只记录方法、URL、请求头**名称**、请求/响应体**字段结构**；仅 `startTime`、`lastUpdateTime`、`currentStatus` 记录了数值。未发送、未修改任何请求，未触碰账号凭据与消息正文。
- 覆盖时间约 3 分钟，只有被动轮询流量（会话列表为空）。**没有**打开会话、没有发送，因此 `getMessageList`、`SendMessage`、已读、订单等接口未验证。
- CDP 看不到 NodeService 里的 IM 长连接帧，也看不到 `Cookie`/`Origin` 等受限请求头。

## 验证结果

| # | rea 论断 | 实测 | 结论 |
| --- | --- | --- | --- |
| 1 | SOA2 国内网关为 `m.ctrip.com/restapi/soa2`（02 §5.1） | `POST https://m.ctrip.com/restapi/soa2/16037/getConversationList`、`/15529/getSessionEmpathyPhraseInfo` 均 200，`Content-Type: application/json`，query 含 `_fxpcqlniredt`、`x-traceID` | **正确** |
| 2 | FE-01/F-06：会话列表每 5 秒轮询（`startLoopConvList … 5e3`） | 间隔 5.0 s（11 次样本，仅账号初始化处有 3.1/1.9 s 两次重叠）；imWindow 缓存 js 中为裸 `setInterval(…,5e3)`，无可见性判断 | **频率正确** |
| 3 | F-06：会话列表是「**全量**拉取」 | 请求体只有 `head`+`startTime`+`needTodoList:1`。连续 6 次 `startTime=1793601440000`，响应 `lastUpdateTime` 同为 `1793601440000`，`conversationList` 长度 0。即**增量游标**（下次 `startTime`=上次 `lastUpdateTime`），无变化时返回空 | **错误**，应改为「增量轮询，游标不变时返回空」 |
| 4 | F-06：「人工坐席状态每 3 秒轮询」（`checkManualAgentStatus … 3e3`） | 静态：该定时器仅在「排队中」系统消息组件挂载期间存在；其余只在会话切换/进入排队 500 ms 后调用。实测未出现任何坐席状态请求 | **范围夸大**：不是全局常驻轮询 |
| 5 | （rea 未记录）3 秒轮询 | 持续每 3.0 s 一次 `POST …/15529/getSessionEmpathyPhraseInfo`（体：`head`+`sessionId`+`bizType`，响应 `hasAuth`/`empathyPhrases`），18 次，仅在会话未结束且已选中时运行，不随可见性暂停 | **rea 遗漏**，应补入 STA-03 定时器清单与 `docs/api` |
| 6 | （rea 未记录）埋点 | `POST s.c-ctrip.com/bee/collect`，体 `{d:str}`，约每 1–2 s 一次（32 次/60 s），来自 3 个页面 | **rea 遗漏**，已在 2026-10-30 观测中出现 |
| 7 | 02 §5.3：IM 走 utilityProcess，`wss://im*/ws-xmpp/` | 两个 NodeService（PID 32610、32634，对应两账号）各持 2 条 443 长连接，对端 157.255.189.114、211.95.54.89；`lsof` 无法给出 SNI/路径，证书探测被本机代理阻断 | **进程模型正确；URL 未能验证** |
| 8 | 请求使用 HTTP/2 关闭（`--disable-http2`，观测文档） | 全部实测 `protocol: http/1.1` | **正确** |
| 9 | 请求头/体与 `docs/api` 网页样本一致 | `head` 字段集一致（`cid ctok cver lang sid syscode auth xsid extension[{cpc:pc}] appId`）；桌面端请求头名称无 `x-ctx-country`、`x-ctx-currency`，其余 `x-ctx-*`、`w-payload-source`、`x-tour-auth-from` 同网页 | **基本一致**，差异见下 |

## 对仓库文档与代码的影响

1. `docs/reverse/2026-11-01-rea/01-frontend.md` F-06 应改：会话列表为 5 s **增量**轮询；3 s 项应改为 `getSessionEmpathyPhraseInfo`，`checkManualAgentStatus` 仅限排队组件。已连带影响 `docs/plan/2026-11-02-reverse-driven-improvement-plan.md` §2 C7（该文已写「增量」，与 F-06 原文冲突，以本文为准）与 06 报告 IM 模块的「5 秒全量轮询」措辞。
2. `vbk/ui/packages/web-adapter/src/conversationList.ts` 的游标语义（`startTime = previous lastUpdateTime`、`needTodoList: 1`、`POST`）与实测一致，不需要改。适配器若在官方页轮询之外另起轮询，会与官方页对同一端点形成双倍请求，I-06 的约束成立。
3. 补录 `getSessionEmpathyPhraseInfo` 的 3 s 轮询与 `bee/collect` 的节奏，纳入 I-06 的请求频率验收口径。
4. 桌面端缺 `x-ctx-country`/`x-ctx-currency` 是 `CDP requestWillBeSent` 视角，可能因受限头未列出；vbk 复用网页版官方页，应以网页样本为准，该差异不触发修改。

## 第二轮（用户只读操作：开会话、上滚历史、看订单、切账号）

原始（脱敏）数据：[desktop-live-capture-2026-11-02-round2.json](../observations/desktop-live-capture-2026-11-02-round2.json)（556 条 Fetch/XHR/Ping，1071 条原始事件）。本轮采集器改为定时挂载新窗口，卸载时只拆自己的监听，未再碰应用的 `app` 监听。

| 接口（均 `POST m.ctrip.com/restapi/soa2/…`，JSON，HTTP/1.1） | 次数 | 实测请求体（除 `head`） | 与 `docs/api` / vbk |
| --- | --- | --- | --- |
| `16037/getMessageList` | 31 | 三种形态：首屏 `{showTargetIsRead,groupId,conversationType,pageSize}`；`+direction:"prev"`；`+direction:"prev",endTime`（上滚翻页，19 次）。响应 `rangeMessage{isDone,lastMessageTime,messages[]}` | 与 `history-pagination.md`、`web-adapter/src/history.ts`（`prev`⇄`endTime`）**一致** |
| `11679/batchTranslateByMsgIds` | 31 | `{source:"AUTO",target,sessionId,groupId,bizType,appId,messageIdList[]}`；响应含 `supplier:"google"`、`idWithTranslatedMap` | 文档已有，**一致**；每次开会话都会自动翻译 |
| `16037/getRemarkList` | 12 | `{uidList[]}` | 一致；响应多出 `isBlock/rolesV2/extPropertys/userJid/status/sortNo/createAt`，文档未列 |
| `15529/queryToken` | 10 | `{groupId,needTokenExt}` | 一致；响应 `tokenMap` 多出 `saleCityId/extendJson/departureCityId` |
| `14735/getOrderDetailsForVbk` | 10 | `{OrderDetailsRequestDTO{orderId,requestType:"orderboard",queryType,decryptType}}` | 一致 |
| `16037/checkSessionStatus`、`getConversationInfoByGidList`、`13500/checkMemberStatus` | 4/4/4 | `{gid,customerUid}`、`{gidList[]}`、`{groupId}` | 一致 |
| `18088/getAppConfig.json` | 47 | — | 文档已有 |
| `12405/getCurrentUserInfo` | 3 | `{applicationCode:"vbk_online_new",need*…,businessLineList}` | **`docs/api` 未收录** |
| `28967/reportInjectFnInfo` | 2 | `{buildVersion,fnInfo}`，响应 `data.injectSwitch` | **`docs/api` 与 rea 均未收录**，见下 |
| `23196/json/getDiscardUbts`、`36709/createTUid`、`16163/saveLogInfo`、`s.c-ctrip.com/bee/collect`、`cdid.c-ctrip.com` | — | 埋点/设备指纹类 | 非业务，仅记录 |

补充结论：

1. **未抓到任何 WebSocket/IM 帧事件**：IM 长连接在 NodeService 进程内，CDP 无法观测，rea §5.3 的 `wss://im*/ws-xmpp/` 仍为「未验证」。要证实需对 NodeService（PID 32610/32634）做进程级观测。
2. **`reportInjectFnInfo` 值得单独跟进**：官方页面会上报「被注入函数」信息，服务端回 `injectSwitch` 开关。本机缓存的 `dist/js` 中没有该字符串，调用方很可能是远程风控脚本（如 `c-sec.js`、`ubtrms`）。vbk 正是向官方页注入适配器的方案，这条与改进计划 C10/R11 直接相关，rea 的 FE-29（输入检测）没有覆盖它。建议把它列为 R11 的新证据，并在受控账号上做「注入 vs 未注入」的 `fnInfo` 对比。
3. **加载来源与 rea SUP-01 的描述需复核**：本轮渲染页脚本加载自 `/Applications/…/app.asar.unpacked/dist/`（如 `BaseController-B_9ex1XX.js`），而上一轮读的 `~/Library/Application Support/vbk-electron/dist/` 缓存里是 `BaseController-P4oncDAK.js`。说明当前运行版本使用安装目录的 dist；「渲染层热更新目录特权加载」是否仍在生效需单独验证，不能直接沿用 SUP-01 的结论。
4. 开会话时没有出现 `SendMessage`、`PutAdviceOfReadByMsgId`，因此已读回执接口仍未验证；发送类接口不会由我代发。
5. 卸载后 9229 不再监听，应用 PID 32407 仍在运行。

## 第三轮（出站，用户在受控会话里发文本、图片、文件）

工具：[tools/desktop-capture/capture.mjs](../../tools/desktop-capture/capture.mjs)（`start --outbound`）。脱敏数据：[desktop-live-capture-2026-11-02-round3-outbound.json](../observations/desktop-live-capture-2026-11-02-round3-outbound.json)（3455 条，只含字段结构与协议枚举；消息正文、JID、id 均未保留，id 仅以 8 位哈希配对）。覆盖约 10 分钟，XMPP 帧 1418（出 593 / 入 825）。

| 项 | 实测 | 结论 |
| --- | --- | --- |
| **文本发送走哪条链路** | **XMPP over WSS，不走 HTTP**。IM 进程出站 `<message type="send">`（根属性 `to,type,id,xmlns`，子元素 `body`），约 0.15–0.21 s 后收到同 id 的 `<message type="send_result">`。整个窗口内**没有** `SendMessage.json` 请求 | rea FE-23「发送走 MessagePort 交给主进程 IM 进程」**正确**；`docs/api` 把 `SendMessage.json` 记为「HTTP 发送兜底」也**一致**（兜底未被触发） |
| IM 主机 | `im3.ctrip.com:443`（两账号各一条长连接，对端 211.95.54.89） | 补全 rea §5.3 的「im*」；WS 的 path/子协议因连接早于挂钩未捕获 |
| 图片发送 | ①`POST m.ctrip.com/restapi/soa2/16037/uploadTokenCreate {channel:"im_business",type:"img"}` → `{token}`；②`POST nephele.ctrip.com/image/v2/api/upload?channel&scene&rand`，`Content-Type: image/jpeg`，头含 `Authorization`、`Content-MD5`；③XMPP `message type=send`（长度 664，body 497） | 与 `docs/api` 的 nephele 记录**一致**（channel=im_business） |
| 文件发送 | `POST nephele.ctrip.com/file/v1/api/upload?channel&public`，`Content-Type: application/msword`，**没有** `uploadTokenCreate`、没有 `Authorization` 头；随后 XMPP `send` | 文件上传与图片上传的鉴权方式不同，文档需分别标注 |
| 快捷话术 | `POST 16037/getCustomerScripts {content}`，输入每个字符触发一次（观测到长度 1、2） | `docs/api` 目录有该端点；确认为**逐字输入联想** |
| 输入状态 | 出站 `<message type="input_state">`（`from,to,type,id,isGroup,xmlns`，body 12 字节） | rea FE-30「sendInputState」**正确**，走 XMPP |
| 送达确认 | 每条入站 `chat` 会触发出站 `<message type="notify_ack">`（183 次，134 字节） | **rea 未记录** |
| 心跳 | 出站 `iq get`+`urn:xmpp:ping`，入站 `iq result`；232 次，延迟约 0.08 s | rea STA-03「IM ping」**正确**，周期约 5 s |

**新发现的问题**（官方客户端，非 vbk）：每收到一条 `chat`，服务端还会推一条携带整条消息体的 `iq set`，官方 IM 进程**不处理**，而是回一个携带整条消息体的 `iq error service-unavailable`（173 次，约 1 KB/次，bodyLen=705）。这是无意义的回传，既浪费上行带宽，也是 rea 没记录的 STA/PRI 类缺陷；若 vbk 的页面 SDK 对同类 `iq set` 有相同行为，需要在适配器层确认。

**未触发 / 仍未验证**：
- 已读回执（`PutAdviceOfReadByMsgId`、XMPP receipt）：窗口内没有对应出站，说明本次没有触发已读，或已读走了已有链路。需要在会话中读取一条**未读**的客户消息再观察。
- 撤回（`recallMessage`）、置顶、星标、转接、结束：本次没有触发。
- 图片/文件在 XMPP `send` 中的 `msgtype` 与 body 结构：脱敏后只能看到长度，未还原。
- WebSocket 的 URL path 与子协议。

**对 vbk 的含义**：vbk 在官方**网页**中注入适配器，发送链路理应与网页一致而非桌面；本轮证明桌面端主链路是 XMPP，与 `docs/api/send-ack.md` 描述的「XMPP 为主、HTTP 兜底」一致，不需要为发送改传输。出站验收（`send_result` 到达时延约 0.15–0.21 s）可作为 R02 的对照基线（单样本，非统计结论）。

## 第四轮（补测已读与撤回）

脱敏数据：[desktop-live-capture-2026-11-02-round4-read-recall.json](../observations/desktop-live-capture-2026-11-02-round4-read-recall.json)（约 3 分钟，XMPP 帧 300）。

| 项 | 实测 | 结论 |
| --- | --- | --- |
| **撤回** | **HTTP**：`POST m.ctrip.com/restapi/soa2/11679/recallMessage`，体 `{messageId, partnerId}`（均 19 位字符串），响应 `{status:{code,msg}, ResponseStatus}`，200。两次撤回各约 0.2 s 后收到一条入站 `message type=groupchat`（带 `ext` 属性）作为撤回广播。**没有**对应的出站 XMPP 帧 | 与 `docs/api/endpoints/…recallMessage-post.md` 的字段**一致**；撤回走 HTTP，与文本发送走 XMPP 不同 |
| **已读（第四轮，已被第五轮更正）** | 窗口内打开了会话两次（+153 s、+160 s），出站只有 `notify_ack`、`input_state`、`send`、ping、`iq error`；**没有** `PutAdviceOfReadByMsgId` 请求，也没有 receipt 类 XMPP 出站 | **未能复现已读回执**。不能据此说桌面端不发已读：可能是测试时对应客户消息本就是已读状态，或桌面端对该业务线不发。不推翻 `docs/api/transports.md` 对网页端的记录 |
| 打开会话的请求组合 | `getRemarkList`(`{gid}`+`{uidList}`)、`getConversationInfoByGidList`、`getMessageList`(20/50 两次)、`checkSessionStatus`、`checkMemberStatus`、`getOrderDetailsForVbk`、`queryToken`、`vbooking …/ivbk/accountV2/restapi/ab`、`vbooking …/tour/im/ex-area/qconfig/json` | 与第二轮一致，新增 `ab`（`{expCode,uid}`）、`qconfig/json`（`{contentType,fileName,property}`） |
| `batchTranslateByMsgIds` | 请求体多出 `chatType`，`bizType` 为数字（实测 1513），`target:"zh-CN"` | 文档里的字段集需补 `chatType` |
| `getMessageList.conversationType` | 同一会话出现 `B2C` 与 `C2B` | 与会话方向有关，适配器不得写死 |

已读回执仍是唯一没有任何一轮抓到的出站路径。要证实它，需要一个**确定带未读客户消息**的会话：让对端发消息，确认红点出现后再打开，且在 `getConversationInfoByGidList` 的 `unreadCount` 大于 0 时观察。

## 第五轮（已读回执，更正第四轮）

脱敏数据：[desktop-live-capture-2026-11-02-round5-read-receipt.json](../observations/desktop-live-capture-2026-11-02-round5-read-receipt.json)。

**第四轮「没有抓到已读」是抓取盲区，不是桌面端不发。** 前端 `receiptCurrentMessage` 通过 `postImMessage({event:"sendMessageReceipt"})` 把已读交给 IM 子进程，由 **IM 子进程用 Node 自己的 HTTPS** 发出，渲染进程的 CDP 看不到，XMPP 帧里也没有。抓取器补上 `http(s).request` 与 `fetch` 钩子后（红点 3 条未读、打开会话）：

| 项 | 实测 |
| --- | --- |
| 请求 | `POST https://m.ctrip.com/restapi/soa2/11679/PutAdviceOfReadByMsgId.json`，由 NodeService 发出，200 |
| 请求体 | `{partnerJid:str, msgId:str(19), type:"groupchat", head}`（296 字符，字段集与 `docs/api` 样本 1 完全一致） |
| 请求头名 | `Accept, Content-Type, Accept-Encoding, User-Agent, Content-Length`；**没有** `x-ctx-*`、`w-payload-source`、`x-tour-auth-from`、`Cookie`，query 为空 |
| 次数 | 3 条未读只发 **2 次**，间隔 0.4 s，且每次只带**最后一条**对方消息的 `msgId`（前端只取最后一条非本人、非系统且有 `messageId` 的消息；`isRead` 已为真则不发） |

对 vbk 的含义：
1. 已读是「按会话取最后一条对方消息」的游标式回执，不是逐条回执；适配器若逐条补发会与官方行为不同。
2. 官方桌面端的该请求**不带**网页端那组平台请求头（`x-ctx-*`、`w-payload-source` 等）也被服务端接受，说明这些头对该接口不是必需的；但 vbk 在官方网页内发起，仍应沿用网页行为，不依赖此结论去裁剪。
3. 同一次打开会话重复发 2 次，是官方的冗余，vbk 应去重（同一 `msgId` 只发一次）。
4. **抓取方法教训**：IM 子进程内的 Node HTTP 在先前三轮里不可见，之前所有「出站只有 XMPP」的结论只适用于 XMPP 通道。`recallMessage` 来自渲染进程，已确认；其余出站接口（置顶、星标、转接、结束）也可能走 Node 侧 HTTP，需要用新钩子复测。

## 第六轮（置顶、星标、转接、结束；带 Node 侧钩子）

脱敏数据：[desktop-live-capture-2026-11-02-round6-star-transfer-finish.json](../observations/desktop-live-capture-2026-11-02-round6-star-transfer-finish.json)。窗口 179 s，出站 XMPP 只有心跳、`notify_ack`、`iq error`，**没有**业务类 XMPP 出站。

| 操作 | 实测请求（均 200，`bizResponseStatus.resultCode = SUCCESS`） | 发起方 | 与 `docs/api` |
| --- | --- | --- | --- |
| 星标 | `POST 16037/setWorkSheetStar {sessionId:str, groupId:number, worksheetId:number, action:number}`，操作 3 次（+138.9/+140.6/+142.3 s） | 渲染进程 | 字段集**一致** |
| 转接 | `POST 16037/transferVenMaster {sessionId:str, groupId:str(19), targetVenAgentUid:str(16)}`（+157.2 s） | 渲染进程 | **一致**；注意 `groupId` 在此为字符串，在 `setWorkSheetStar` 中为数字 |
| 结束会话 | `POST 16037/finishConversation {conversationKey:str(57), conversationType:"B2C", sessionId:str, workSheetId:number}` → `{workSheetId:[number]}`（+163.0 s） | 渲染进程 | **一致** |
| 置顶 | **窗口内没有任何对应请求**（渲染进程 HTTP、IM 进程 Node HTTP、XMPP 均无） | — | 置顶在桌面端是**本地状态**，不上行服务端；若用户在置顶操作时应用并未执行，可复测 |
| 已读 | 打开会话时 IM 进程再次发出 `PutAdviceOfReadByMsgId` 2 次（+120.2/+120.5 s） | IM 进程 | 与第五轮一致 |

要点：
1. 转接、结束、星标都由**渲染进程**发起，没有走 IM 进程的 Node 侧通道；第五轮担心的“这几项可能藏在 Node 侧”不成立。需要 Node 侧通道的只有已读回执。
2. 置顶不上行，意味着 vbk 的置顶应当是本地偏好，不能期望跨设备同步；与官方一致，不需要设计服务端契约。（待复核：确认测试时置顶按钮确实生效。）
3. 这三个写接口的返回结构统一用 `bizResponseStatus.resultCode`，不是 `ResponseStatus.Ack`；适配器判定成功时不能只看 `Ack`。
4. 本轮转接与结束是真实执行（返回 SUCCESS），操作对象为用户自己指定的测试会话，未对其他会话做操作。

## 未验证项（需要受控操作，第二轮后仍剩）

`getMessageList`、`getRecentMessages`、`SendMessage`、`PutAdviceOfReadByMsgId`、`getOrderDetailsForVbk`、转接/结束等接口；IM WebSocket 的 URL、子协议与帧格式。需要用户在应用里**打开一个会话**（只读）再采一轮；发送类接口需受控对端，我不会代发。

## 操作留痕

- 采集器已卸载、debugger 已 detach、inspector 已关闭（9229 不再监听）。
- **清理缺陷**：卸载时我对 `app` 调用了 `removeAllListeners('web-contents-created')`，可能同时移除了应用自己注册的同名监听，影响之后新建窗口的初始化（例如新窗口的安全/导航处理）。已打开的窗口不受影响。建议重启一次应用恢复。
