# 旅游商家客户端实机观测与接口决策补充

观测日期：2026-10-30（Asia/Singapore）。现场连接快照时间：15:17:31；回看本机当日 15:07–15:11 启动日志。初轮仅完成进程与日志观测；随后已完成两轮应用层 HTTP 抓包（见末节）。Node 长连接帧和完整发送链路仍未覆盖。

## 初轮结论与证据边界（抓包结果见末节）

当前客户端确实采用 Electron 多进程、本地 IM 页面和独立 Node 服务。现场同时运行旅游商家助手，不能把资源消耗全部归因于未修改的官方客户端。现有 SDK/sidecar 路线保留为候选；本轮证据不足以决定它优于网页接口，也不足以批准去掉 Node。

电脑工具能列出运行中的客户端，但按 bundle ID 连接遇到多个同 ID 副本；按正式安装路径和应用名连接均报 AppleEvent 超时（-1712）。因此没有成功读取窗口内容或执行页面操作。本轮未发送消息、结束会话、改配置、重启程序或开启新的调试端口。不能把以下日志回看描述成由本轮点击触发的动作。

证据来源：

- 电脑工具应用清单及连接错误。
- Project Bridge 的 `ps` 两次采样与 `lsof -nP` 连接快照；第二次为 15:17:31。首次任务 ID `9e51ed6a-c9db-4f1c-8b47-500ad55f846d`；第二次 `f016d869-fb19-4b6c-bce7-0ac78aac8194`。
- 本机 `~/Library/Logs/vbk-electron/main.log`，当日匹配 128 行，读取时文件 458090 字节。
- 当前用户热更新缓存 `~/Library/Application Support/vbk-electron/dist/js/BaseController-P4oncDAK.js`，只用于静态接口核对。

未保存账号、Cookie、token、客户消息正文。日志是客户端自述；连接快照只能证明 socket 存在，不能证明请求成功或消息送达。

## 程序活动

| 现场事实 | 含义与限制 |
| --- | --- |
| 日志版本 1.2.12、Electron 27.3.11、darwin、PROD、appId 900004 | 这是当前 Mac 的版本，不能直接代表仓库中的 Windows 安装包 |
| TripVendorLauncher（75080）启动官方可执行文件（75081）和旅游商家助手（75082） | 当前是混合环境；助手另有 GPU、网络与原生 WindowHelper |
| 官方进程下存在 GPU、NetworkService、多个 Renderer、4 个 NodeService，以及 AudioService | 进程边界得到实机确认；不能仅按 NodeService 名称逐一认定它们的业务职责 |
| PID 75181 两次 CPU 采样为 138.4% → 6.3%，RSS 为 375500 → 296404 KiB | 有瞬时高负载，但没有 CPU profile，不能断言持续卡顿、内存泄漏或归因于 IM 输入框 |
| 主进程 CPU 16.0% → 1.6% | 采样波动明显，不作为长期性能基准 |
| 渲染进程列表在两次采样之间有增减 | 需关联页面生命周期后才能判断正常回收或异常增长 |
| NetworkService 和 NodeService 参数含 `--disable-http2` | 运行参数证实旧代码配置仍在使用；未实测每条请求协商协议 |
| 日志 `disableGPUAcceleration: true`，现场仍有 GPU 进程 | GPU 进程存在不等于硬件加速已启用，不能单凭进程名称判断偏好失效 |

## 启动与页面动作时间线（日志回看）

| 本机时间 | 日志事件 | 可确认内容 |
| --- | --- | --- |
| 15:07:39.036 | App ready | 应用 ready |
| 15:07:40–42 | DB、Account、Ubt、Shark、Preferences、Tray、Capture 初始化 | 初始化链路涉及存储、账号、埋点和截图能力 |
| 15:07:42.215–42.222 | OCR、SpellCheck 初始化，传入 wasmPaths | OCR 和拼写检查在本次启动期间初始化，不是本轮手动触发 |
| 15:07:42.473–42.494 | Notifier、ToolTip、Alarm 初始化 | 提醒组件在启动阶段初始化；不证明已向用户展示 |
| 15:07:43.465–43.467 | Overlay ready / preWarm done, windows: 1 | 截图覆盖层已预热 |
| 15:07:44.043 | ArchGuide prefetch pkg url failed，JSON 尾部异常 | 有一个包地址预取解析失败；没有响应正文，不能定位服务端原因 |
| 15:07:51.670–51.893 | child process spawn；创建 imPlus、notice BrowserView | 本地页面与子进程创建时序得到确认 |
| 15:07:53.969 | `[im sdk]: inited` | SDK 初始化日志；不是发送成功或持续连接证明 |
| 15:07:54.352 / 54.982 | SpellCheck / OCR worker ready | 两类模型 worker 就绪；OCR 字典大小 18384，wasm 线程配置 4 |
| 15:08:59.860–15:09:00.828 | 再次 spawn、创建 imPlus/notice、SDK inited | 第二组初始化存在；未关联账号，不能断言重连或多账号原因 |
| 15:11:21.385 | 创建 setting BrowserView | 设置页面曾创建；非本轮操作 |

多次 session 日志为 `useSystemProxy: false`。这只说明客户端偏好，不排除系统外部 VPN、透明代理或网络层转发。

## 网络活动

15:17:31 连接快照：

| 进程 | 已建立的 TCP 连接目标 | 判断 |
| --- | --- | --- |
| 主进程 75081 | 127.0.0.1:59001 监听，已有一个本地连接 | 启动参数已有 remote debugging；本轮没有开启或使用它进行界面控制 |
| NetworkService 75098 | 211.91.67.188:443（1 条）、157.255.189.114:443（4 条） | Chromium 网络层有独立外连 |
| NodeService 75152 | 211.95.54.89:443、157.255.189.114:443 | Node 层也持有独立外连 |
| NodeService 75472 | 157.255.189.114:443、162.14.137.42:443 | 第二个 Node 服务同样有外连 |
| NodeService 75111、75112 | 所选快照无 IP socket 输出 | 不等于整个运行期没有网络活动 |

NetworkService 另有多个 UDP socket（包括 5353）。未获得 DNS/SNI 关联，不把上述 IP 直接标为 IM、SOA 或埋点域名，也不能仅凭 443 端口区分 HTTPS 与 WSS。`lsof` 对无关 Time Machine 挂载给出 stat 警告，输出可能不完整。

日志还记录了 `static.tripcdn.com` 热组件清单、VbkFaceVerificationComponent 1.0.7、remarketing 脚本及 `webresource.c-ctrip.com` 风控脚本的资源 URL。日志中的 `file://` URL 可能涉及资源映射；不能据此认定其网络响应成功，也不能认定发生过人脸认证。

## 接口核对：当前缓存代码，不是本轮抓包

| 用途 | 当前缓存定义 | 本轮动态确认 |
| --- | --- | --- |
| 会话列表 | `/16037/getConversationList` | 未捕获请求、响应、轮询间隔 |
| 历史消息 | `/16037/getMessageList` | 未捕获分页参数或响应 |
| 结束会话 | `/16037/finishConversation` | 未执行 |
| 快捷话术 | `/16037/getCustomerScripts` | 未捕获请求 |
| 翻译 | `/11679/getMessageTranslate` | 未捕获请求 |
| 发送与状态 IPC | `send_message`、`message_send_status`、`send_message_receipt` | 只核对代码名称；不是 HTTP endpoint |

上述接口与 [IM 文档](../dev/10-im.md) 的服务分组相符，但当前缓存 bundle 名与文档中旧拆包 bundle 名不同。实施时必须记录安装包与热更新资源版本，不能以旧文件名定位所有现场代码。

初轮进程/日志观测未拿到 HTTP 方法、请求头、业务参数或响应码；这些限制已由末节两轮 HTTP 抓包部分解除。客户端 Node WebSocket 帧与发送回执仍未覆盖。约 5 秒**会话轮询**已有后续动态支持，但不能由此证明心跳周期、Socket 失败后 HTTP fallback 或发送去重语义。

## 决策项

| 编号 | 建议 | 状态与依据 |
| --- | --- | --- |
| D-DESKTOP-01 | 同时保留网页传输和客户端 SDK/sidecar 两个候选，暂不锁定最终传输 | 待决策。必须比较真实发送、回执、断线补拉、后台保活、图片文件、引用和多账号能力 |
| D-DESKTOP-02 | 性能评估分开测未注入官方版与助手版，并固定账号数、页面数、热更新版本 | 建议采用。现场已有 launcher/companion，不能拿本轮数字当纯官方基线 |
| D-DESKTOP-03 | 网络观测覆盖 Chromium 与 Node 两层 | 建议采用。两层均观察到外部连接；只抓页面 Network 可能漏掉 SDK 活动 |
| D-DESKTOP-04 | 评估 OCR/拼写检查按需加载，提醒核心独立常驻 | 建议验证。启动日志确认模型 worker 提前初始化，但本轮没有测得它们各自的成本 |
| D-DESKTOP-05 | 将缓存 bundle 版本纳入接口证据记录 | 建议采用。实机热更新文件名与旧拆包分析不同 |

后续需完成的动态验证：恢复可连接的客户端窗口后，逐项关联“打开会话、翻历史、搜索、切账号、收消息”与请求；发送、图片、引用和失败重试使用明确指定的测试会话；同时记录 Chromium 请求和 Node WSS，按操作时间关联 ack 与 UI 状态。不要将 TCP established 当作 IM 已连接或消息送达。


## 实际抓包补充：15:22–15:26

本节更新并覆盖前文“没有 HTTP 报文”的初轮限制。使用客户端**原已开放**的本地调试端口，分别对 17 个 target 启用 CDP `Network.enable`，被动接收请求/响应事件，在完成事件后调用 `Network.getResponseBody`。未执行页面脚本、导航、点击、发送、状态修改或请求重放。

这属于客户端应用层抓包，能读取 Chromium 已解密的 HTTP 请求与响应；不是网卡 PCAP，也不覆盖独立 Node SDK 的所有网络活动。尝试 dumpcap 对 en0 上指定 IP 的 443 流量抓取时，系统返回 `/dev/bpf0: Permission denied`，未生成有效网卡抓包。没有修改系统权限或安装证书。

### 抓包文件与覆盖范围

| 轮次 | 时间（UTC+8） | 请求数 | HTTP 200 | 取得响应正文 |
| --- | --- | --- | --- | --- |
| 第一轮 | 15:22:55–15:23:42 | 432 | 427 | 425 |
| 第二轮 | 15:25:38–15:26:10 | 114 | 113 | 113 |
| 合计 | 两个独立采样窗口 | 546 | 540 | 538 |

证据文件：[第一轮](desktop-network-2026-10-30.json)、[第二轮](desktop-network-2026-10-30-round2.json)。保留方法、去查询串 URL、时间戳、HTTP 状态、协商协议、头名称、请求/响应 JSON 字段结构；正文值默认转为类型，动态数字键与图片资源路径脱敏。第二轮额外保留 `Ack`、业务结果码、`hasAuth`，以区分 HTTP 成功与业务结果。第一轮未保留 target ID，第二轮补齐。

每轮各有一个 target 在监听中关闭；6 条请求没有捕获响应，不直接计为服务端失败；第一轮另有 2 条已捕获 HTTP 响应但没有取得正文。未读取到响应的原因需结合关闭/截止时间进一步定位。

### 实际接口清单

下表计数为两轮窗口内请求总数；均为现场客户端自然产生的活动，不能推断所有接口都是后台轮询，更不能归因于本轮自动化操作。公共前缀为 `https://m.ctrip.com/restapi/soa2/`。

| 接口路径 | 方法 | 次数 | HTTP 200 次数 |
| --- | --- | --- | --- |
| `11679/batchTranslateByMsgIds` | POST | 19 | 19 |
| `12405/getCurrentUserInfo` | POST | 1 | 1 |
| `13500/checkMemberStatus` | POST | 10 | 10 |
| `14735/getOrderDetailsForVbk` | POST | 4 | 4 |
| `15529/getSessionEmpathyPhraseInfo` | POST | 54 | 53 |
| `15529/getSessionUrls` | POST | 4 | 4 |
| `15529/queryToken` | POST | 4 | 4 |
| `16037/checkSessionStatus` | POST | 4 | 4 |
| `16037/getConversationInfoByGidList` | POST | 7 | 7 |
| `16037/getConversationList` | POST | 32 | 32 |
| `16037/getInviteCtripData` | POST | 2 | 2 |
| `16037/getInviteMemberListBySkillGroup` | POST | 4 | 4 |
| `16037/getLatestConversationByGid` | POST | 6 | 6 |
| `16037/getMessageList` | POST | 19 | 19 |
| `16037/getRemarkList` | POST | 12 | 12 |
| `16037/inviteVenAgent` | POST | 2 | 2 |
| `16037/setVenAgentStatus` | POST | 2 | 2 |
| `16163/saveLogInfo` | POST | 6 | 6 |
| `18088/getAppConfig.json` | POST | 15 | 15 |
| `28967/reportInjectFnInfo` | POST | 1 | 1 |
| `36709/createTUid` | POST | 2 | 2 |

其中 `inviteVenAgent`、`setVenAgentStatus` 是现场捕获到的写接口。本轮监听器没有主动触发这些请求；操作来源没有 UI 时间线，保持未知，不做重放。

### 关键请求与响应字段

| 接口 | 捕获的业务请求字段（略去公共 head） | 捕获的响应结构 |
| --- | --- | --- |
| getConversationList | appId、startTime、needTodoList | conversationList、currentStatus、lastUpdateTime、haveRest |
| getMessageList | appId、showTargetIsRead、groupId、conversationType、pageSize | rangeMessage.isDone / lastMessageTime / messages；消息含 msgId、messageBody、fromJid、toJid、threadId、createTime、msgtype、isread、receiptRange |
| getLatestConversationByGid | appId、gid | conversation 对象，含会话、订单关联与 ext 字段 |
| getConversationInfoByGidList | appId、gidList | conversationInfoList，含 gid、unreadCount、message |
| batchTranslateByMsgIds | source、target、sessionId、groupId、bizType、appId、messageIdList | status、supplier、translateMessageList、idWithTranslatedMap |
| getOrderDetailsForVbk | appId、OrderDetailsRequestDTO（orderId、requestType、queryType、decryptType） | 本轮示例只有 resultCode、resultMsg、ResponseStatus，不能认定取得订单详情 |
| queryToken | appId、groupId、needTokenExt | tokenMap、tokenExtMap；值不保留 |
| getSessionEmpathyPhraseInfo | sessionId、bizType | hasAuth、empathyPhrases |

`head` 实测出现 cid、ctok、cver、lang、sid、syscode、auth、xsid、extension；部分请求有 head.appId 和顶层 appId。不能把字段存在等同于鉴权依赖已明确，本轮未进行删字段试验。

### 实测结论与方案修正

1. **约 5 秒会话轮询得到动态支持。** 第二轮两个 imPlus target 分别捕获 8 次、6 次列表请求：常规间隔为 4.991–5.009 秒，也存在 0.396/0.750 秒追加请求及较短间隔。因此应描述为“约 5 秒定时轮询，另有事件触发请求”，不能用两账号混合时间线推算单账号周期。target 与账号的对应未采集。
2. **不能把 HTTP 200 等同于业务有权限。** 第二轮共情话术接口 20 次均 `Ack=Success`，但 `hasAuth=false`。翻译接口 5 次的 `status.code` 为字符串 `"0"`，成员状态接口为数字 `0`；统一结果解析必须按接口契约处理类型。
3. **业务 HTTP 与资源传输协议不同。** 第一轮 392 条响应为 http/1.1，35 条为 h3（34 条来自 static.tripcdn.com，1 条来自图片 CDN）。`--disable-http2` 不能推导成“客户端全部只用 HTTP/1.1”。
4. **除了 IM 查询还有明显附带流量。** 两轮 `s.c-ctrip.com/bee/collect` 合计 197 次，另有扩展信息区域页面、风控资源和配置接口。当前是注入助手环境，这些请求的必要性和归属仍需进一步分析；不能按次数直接推断带宽或 CPU 瓶颈。
5. **HTTP 业务接口候选已有真实字段结构支持。** 可据此整理会话、历史、翻译及侧栏数据适配，但是否能从独立 Rust 客户端复用鉴权仍待验证。网页端若也使用相同服务，需要比较请求契约与凭据，而不是只按“网页/客户端”二选一。
6. **IM 传输选择仍保留待决策。** 两轮没有捕获 WebSocket 事件，也没有 send/ack 证据。不能把“没有在 Chromium 中看到帧”解释成“没有长连接”；独立 Node SDK 是未覆盖边界。下一步需要补 Node WSS 报文及指定测试会话的发送/回执/重连，才可决定是否去掉 sidecar。

## 最终文档审查复核补充

2026-10-30 的最终审查重新计算了两份脱敏 JSON：546 条请求、540 条 HTTP 200、538 份响应结构，及上表 21 项 SOA 计数一致。第二轮唯一一条 `getCurrentUserInfo` 样本保留了 `ResponseStatus.Ack="Success"` 和 `user` 对象结构（身份字段值已转为类型）；没有独立业务 `resultCode`。这只能支持该样本的响应形状，不能定义所有失败分支或证明三个 Cookie 足够迁移登录态。

本次电脑工具清单再次确认「旅游商家桌面版」正在运行；按 `/Applications/旅游商家桌面版.app` 连接仍返回 AppleEvent 超时 `-1712`，未读取新窗口内容，未产生新的点击—请求关联证据。已有抓包不能冒充此次 UI 验收通过。后续开发门槛与证据缺口统一见[最终审查](../reviews/2026-10-30-final-adversarial-review.md)。
