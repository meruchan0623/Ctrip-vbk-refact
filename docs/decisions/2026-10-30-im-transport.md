# IM 接口选型：网页与客户端路线

2026-10-30（新加坡时间）。状态：已完成网页登录与 IM 连接实测；已取得130秒自然入站样本；发送业务成功与恢复场景尚未验证。

## 当前判断

建议：业务 HTTP 按网页实测契约接入；实时传输优先做 Web SDK 原型，与 Node sidecar 对照，在后台可靠性验收前保留 sidecar 候选。已实测网页同样加载携程 Web IM SDK，使用 XMPP over WebSocket，并复用 16037/11679 服务；当前更像运行时和客户端实现的选择，而非两套完全不同后端的选择。不能仅因网页能够聊天，就认定可用若干 HTTP 请求替代持续收消息；也不能因客户端 SDK 已拆出，就认定必须带 Node。应分别选择业务 API、实时传输实现与 UI，三者不必捆绑。

本次已在用户现有 Ego 人工空间完成网页登录；通知权限提示处理后恢复观测，已捕获 IM 初始化与 XMPP 认证/bind。连续观察窗口为15:23:00.578–15:25:10.767（新加坡时间），共506条脱敏事件、164个入站 message 帧。两连接各82帧，可能重复；其中162帧带 body，2帧为 MUC invite/reason，不把它们当作164条独立客户消息。50个出站 message 帧都无 body，不能当作发送正文成功证据。没有向客户发送测试消息，没有验证生产收发成功率、重连或多账号。因此下表是待验证决策，不是已经实施的架构变更。

证据：[网页调查](../research/2026-10-30-web-im-observation.md)、[客户端静态核对](../research/2026-10-30-client-im-static-evidence.md)。接口存在于源码、真实请求出现、业务动作成功，分别是不同证据等级。

## 已获得的差异

| 项目 | 网页证据（含已标明的静态代码） | 客户端源码 | 判断 |
| --- | --- | --- | --- |
| 登录 | `risk_inspect` → `online.ctrip.com/restapi/soa2/22160/pwdLogin` → `12405/getCurrentUserInfo` → `12405/authToken` → dashboard | 本地登录页调用 SOA 登录接口 | 已确认网页登录入口可用；`authToken` 出现不等于证明续期用途 |
| IM 入口 | 首页链接指向 `imvendor.ctrip.com/main?currentTab=BC…`；实际顶层仍为 `/vbk/im/main`，无 iframe | 文档记录生产 IM 域 `imvendor.ctrip.com` | 不能把首页链接域直接当作当前页面最终域 |
| 客服身份 | 首页真实调用 `16037/getVenAgentByUid.json` | 同名方法存在于业务 API 表 | 路径后缀仍需逐项核对；至少存在共用服务；不能外推全部请求契约相同 |
| 会话/历史 | 实际有 `16037/getConversationList.json`、`getLatestSingleChat`、`getConversationInfoByGidList`，以及 `11679/getRecentMessages`、`getIQConversations` | 业务 UI 调 16037；SDK 另有 11679 泛用历史接口 | 应按实际商家 UI 请求比较，不混用泛用与业务接口 |
| 发送 | 未主动发送；网页静态 main 调 `sendMessageInSocket`；SDK init appId=`100067816`，业务 getHead 默认=`900004` | WSS 优先，HTTP `/11679/SendMessage.json` 兜底；存在两层重试 | 网页 SDK 内部仅在未连接或 error=-2 时转 HTTP；页面包装未见客户端式额外通用重试。需验证 localId 与 Ack |
| 实时接收 | 创建 `im3.ctrip.com/ws-xmpp/` 与 `im.ctrip.com/ws-xmpp/`，已见 SASL auth/success 和 bind；130秒取得164个入站 message 帧（非去重业务消息数） | XMPP over WSS，默认 `im3.ctrip.com/ws-xmpp/` | 已确认同属 XMPP over WSS；两连接角色及扩展报文兼容性仍需确认 |
| 补偿与轮询 | 130秒内 `getRecentMessages` 26次，呈两路约10秒交错；会话列表仅2次，未见5秒循环 | 原客户端 UI 每5秒拉会话列表 | 网页更值得参考补偿设计；双调用来源未明，不能直接复制数量与周期 |
| SDK 初始化 | 网页 main 静态代码：`appId=100067816`，`conversationType=conversationList`、`initPageSize=0`、`withoutExtra=true`，无显式 token | `appId=900004`，显式传入 token | 业务 head 的900004不能代替网页 SDK appId；登录态来源需按实际初始化分支验证 |
| 鉴权 | 已见 SASL 成功；当前网页 init 无显式 token，SDK HTTP 无 token 分支使用 credentials；SASL 无 token 分支组合自定义扩展字段（详见调查） | SDK Node HTTP 用 `head.auth`、不带 Cookie，WSS 使用 UID/token | 网页当前配置不能按客户端 bticket 模式直接移植；静态密码构造不等于脱离浏览器验证通过 |

网页登录实测 `bticket`、`vbkticket` 为 `.ctrip.com` 下 HttpOnly/Secure/SameSite=None 的持久 Cookie，`BDUID` 非 HttpOnly。尚未证明只复制这三项即可独立恢复登录，不能省略 Origin、风控及其他 Cookie 依赖验证。

## 候选方案

| 路线 | 收益 | 成本与待验证项 | 当前定位 |
| --- | --- | --- | --- |
| A：复用官方网页 IM 页面 | 接入快，现成业务交互与登录态 | 每账号页面常驻；隐藏节流、睡眠恢复、消息事件接入、UI 性能和版本漂移；不能通过开放广泛 IPC 获取本机权限 | 可作快速原型；是否适合长期承载需实测 |
| B：复用网页实际 HTTP/实时协议，保留本地 UI 和 core-im | 可避免 Node 打包；业务逻辑与界面可独立优化 | HTTP 发送不等于接收；需补齐握手、回执、去重、补拉、鉴权刷新等。若使用浏览器 SDK，须确认它可独立运行及生命周期 | 优先调查的替换候选 |
| C：保留客户端 SDK + Node sidecar | 有明确源码与现有包装参考；业务语义较完整 | 每账号进程、SEA/代理兼容、包体；删除 TLS 降级、清理日志；SDK 自带 HTTP 与 core-net 需要明确边界 | 未完成原型的候选基线 |

网页 B 已确认使用 XMPP over WSS，主候选应进一步拆成 B1（复用 Web SDK，由专用 WebView 承载传输）和 B2（Rust 原生实现）。B1 可能省去 Node，但仍需要浏览器运行时和后台生命周期管理；B2 则承担协议实现与维护。若 Rust 原生实现网页所用协议，则仍承担原文档二期协议实现的工作，不能按省掉 Node 直接扣除全部开发成本。

### 已证实的 SDK 差异

网页加载的 Web SDK 标记 `sdkVersion=3.0.0`、`xmppVersion=1.3.1`；客户端归档为 `s-node-imclient-core 1.0.24`。网页发送方法在 socket 未连接或回调 `error=-2` 时内部调用 HTTP `11679/SendMessage.json`，默认 socket 超时5000 ms；其他错误回调失败。页面包装没有发现客户端 `imsdk.js` 的额外通用失败重试。共享方法名与服务地址不代表重试、认证和 appId 完全相同。

## 实现边界

如果选择 Web SDK，建议原型将它放进按账号隔离、生命周期独立于聊天窗口的传输 WebView，向 core-im 只发送结构化消息与连接事件；聊天窗口关闭不销毁传输。是否能在本地页面初始化 SDK、是否要求特定 Origin/Cookie、是否允许隐藏运行，均须验证。不能仅把远程 IM 页面隐藏后便宣称具有与后台进程等价的可靠性。

core-im 仍统一持有本地入库、去重、发送状态、未读、回复计时和通知事实。网页 SDK 的内部状态只作为传输实现状态，不让远程页面直接访问数据库、凭据库或通用本机命令。若必须依赖远程页面的私有全局变量/DOM 才能拿到消息，需将其维护成本单独列出，不能视为稳定 SDK 集成。

同一账号的两条已观察 WS 尚未确认职责；不要为了省资源直接删掉其中一条，也不要把两条消息流未经区分重复入库。调查时需关联连接初始化配置、消息种类和会话标识，再决定保留范围。

## 决策项

| 编号 | 拟决策 | 生效条件 / 待补证据 |
| --- | --- | --- |
| D-IM-01 | 业务 API 与实时传输分别选型；保留 `ImTransport` 接缝 | 补全网页端点、字段和鉴权对照；方法同名不代表响应/分页一致 |
| D-IM-02 | 网页路线先做可替换原型，不先锁定 Node | 自然入站、人工发信及回执关联；普通文本、图片、文件、引用、撤回、已读/未读、会话分配等覆盖。未触发项目标注缺证据 |
| D-IM-03 | 若 B 覆盖业务且后台可靠，优先 B；否则保留 C 或评估 A | 隐藏/最小化/锁屏、断网恢复、睡眠恢复、多账号隔离与被踢下线，按相同场景对比资源和丢重消息情况 |
| D-IM-04 | 所有路线稳定保留 localId，并区分 HTTP 与业务成功；不无条件叠加两端重试 | 发送超时后查明服务端是否已接收；重试不生成新 localId；核实 `status.code=3` 与 Ack 契约 |
| D-IM-05 | 若保留 C，修正 TLS、日志及网络边界 | 不允许证书失败后关闭验证；不记录 token/客户正文；明确 SDK HTTP 例外或转发适配 |
| D-IM-06 | 本次不调整整体工作量承诺 | 现有41人日仅是 sidecar 路线旧估计，未包括新增契约/可靠性验证；两路线原型完成后再估。包体统一为总纲一期≤45 MB、二期≤30 MB |

## 推荐实施顺序

1. 采用本次已观测到的网页业务请求作为 HTTP 对接样本，同时保留客户端源码用于补齐功能，不直接复制整套网页 UI。
2. 做 Web SDK 在独立账号传输 WebView 中运行的最小原型，先解决 appId、Cookie/Origin、SASL 分支和消息流归属；不先写 Rust XMPP。
3. 与修正TLS/日志后的 Node sidecar 用相同场景验证收发、回执、后台与恢复。Web SDK 通过后推荐以它替代 Node；B1不通过时只有通过同等验收的C才可冻结一期；两者均未通过则保持原型阶段，不能以本次短时抓包批准替换，也不能自动将未验证sidecar当上线退路。
4. 协议与错误样本足够后再评估 Rust 原生。自然观测已经证明网页可接收 XMPP 消息，但未证明它可脱离原站长期运行。

## 下一轮采集

本次已恢复同一人工工作空间，完成 IM 初始化、WS 握手和130秒自然入站采集。后续补齐消息去重关联、分页/增量语义与发送确认。观察用户正常发送，不向真实客户主动发送试验消息。上传、转接、结束会话等未自然发生的动作只记录静态发现，后续用测试会话验证。

仅保留脱敏结构和统计，不提交完整 Cookie、token、密码、账号标识或客户正文。收集时长、消息样本数、请求是否实际发生均写明；没有捕获不等于不存在。

## 最终对抗审查结论（15:35 后补充）

本轮再次在 Ego 页面只读复核：当前版本与前轮一致，两条 WSS 均认证成功；真实 `getCurrentUserInfo` 返回 `user`，客服身份与排班读取也存在。新增证据见 [最终复核](../research/2026-10-30-web-im-observation.md#最终对抗审查只读复核1535) 与 [独立脱敏记录](../research/evidence/web-im-final-verification-20261030.json)。这仍不是三 Cookie 独立恢复或本地 WebView 运行证据。

本轮将开发门槛明确为：**允许进入隔离原型与本地核心开发，禁止在缺少受控发送、分页补偿、账号隔离、后台恢复和失效处理验收时冻结正式 IM 传输或替换现有工作台。** API 与鉴权的成功判断按具体方法定义，HTTP 200、Ack Success、Socket Connected 和业务可操作四者不能合并。

优先风险按第一性原理排序：

| 风险 | 失效结果 | 必须落实的契约 |
| --- | --- | --- |
| ACK丢失后盲目重试 | 客户收到重复回复或客服误以为未发 | 持久化outbox、稳定localId、confirmed/rejected/unknown、结果核对后重试 |
| 裸gid/全局msgId与旧异步回调 | 串号、错会话或覆盖新登录数据 | AccountContext + ConversationRef + session/view generation；作用域内原子去重 |
| 只比较最后消息时间并假设after分页 | 同毫秒、迟到或离线消息被遗漏 | 方法级游标/分页证据、重叠去重、全页完成后推进水位 |
| 已读/点击/发送按钮清提醒 | 未回复客户被静默漏提醒 | 首条未回复等待轮次，仅服务端确认回复/结束/责任转移清除 |
| 备用路线未经同样验收 | 网页失败后把风险转给sidecar | B1/C使用同一业务与故障矩阵；没有未经验证的自动备用路线 |

两个SDK目前都只有部分事实证据，不作“无丢无重”的线上承诺。私有SDK分发许可、来源可信性与版本固定属于实现准备条件，不因可拆出源码自动成立。
