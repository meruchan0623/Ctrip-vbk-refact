# I-05b 传输监督器到 Tauri host 的接缝图

2026-11-04，只读源码核对。本文只画 `core-transport::Supervisor` 与现有 host/page recovery 接口之间的接线边界；没有运行测试、故障注入、浏览器、真实业务或附件安全探针。核心状态机已有实现和状态/属性测试，但 Tauri host 尚未依赖或调用它：`vbk/src-tauri/Cargo.toml:23-34` 未列 `core-transport`，`vbk/src-tauri/src/state.rs:81-97,126-132` 的 `Cores`/`HostState` 也没有 supervisor 实例。

## 输入与动作接缝

| Supervisor 输入/动作 | 当前可复用的 host/page 接口 | 接线缺口与必须保留的条件 |
| --- | --- | --- |
| `Tick`、`next_wakeup_ms()` | host scheduler 已每秒调用 `HostState::tick()`；`scheduler.rs:27-50` 用 `Instant::elapsed()` 作为单调时间源。 | `HostState::tick()` 目前只处理提醒效果及持久化回执（`state.rs:688-709`），不驱动传输健康度。加入按账号的 supervisor 驱动并传单调毫秒；不要把系统墙钟作为退避计时。可以沿用 1 Hz tick，也可按 `next_wakeup_ms()` 唤醒，但要在执行动作前复核账号/页面代次仍有效。熔断计数当前只有 `CircuitCounters` 的严格 `v1` 编解码（`crates/core-transport/src/counters.rs:35-48,69-125`）；host 没有按账号持久化该值的仓储或重建装载路径。 |
| `SdkStatus`、`Alive` | Adapter 已发 `transport`、`message` 和 `compensation_sync` facts。宿主校验账号后将 `transport` 字符串转成 `TransportState`，并把 message/补偿事实送入 `ImCore`（`state.rs:242-280,875-900`）；`adapter_push_fact` 通过当前窗口绑定账号接收页面事实（`adapter.rs:1347-1397`）。 | 目前这些事实不会更新 supervisor 的最后存活时间。接入时分别映射 SDK 状态与活性证据；只有通过当前 `AccountContext`、stream epoch/seq 和当前 WebView 绑定校验的入站事实/响应才可作为 `Alive`。单独的 `connected` 状态应映射为 `SdkStatus::Connected`，不应冒充近期消息或请求成功。 |
| `Network { online }`、`Resumed` | Web adapter 的会话列表已有 `visibilitychange` 门控（`boot.ts:174-186`），host 有 `HostClock` 与 1 Hz scheduler。 | 在当前 adapter/session/host 代码中未找到 `navigator.onLine` 到 host 的事件，也未找到系统睡醒事件送入传输状态机的路径。需要明确受信任的事件源及账户范围；离线期间冻结 supervisor 计时，恢复时只发一次 `Resumed`/网络恢复事件并启动补偿。窗口可见性不是网络在线真值。 |
| `Terminal(reason)`、`NotifyTerminal(reason)` | `sdkGlue.ts:414-430` 对官方连接状态 4/6/8 设置终态 latch、停止自身探测、取消待处理操作并调用 SDK `disconnect()`；Adapter 将该 terminal 折叠为 `auth_invalid` 后停 session（`web-adapter/src/index.ts:256-260,273-283`）。HTTP `AccountsMobileRequestFilterException` 也会分类为 auth invalid。host 的 `push_auth_invalid` 会撤销账号代次、锁定存储、拆除账号 views 并显示重新登录/可能在别处登录提示（`login.rs:2362-2390,2337-2357`）。 | 现有路径可复用为终态的账号失效与提示入口，但 Adapter 传给 host 的只是 `auth_invalid`，SDK 数值没有映射成四种 `TerminalReason` 的类型化证据。不得猜测数值状态对应 KICKED、XMPP auth 或 token 错误；保留普通网络状态与终态的区分。若增加原因字段，应只接受有来源的精确信号；终态只通知账号状态机并停止自动补偿/reload/rebuild，`AccountRebound` 仅能来自用户明确重新登录产生的新身份。X11 已选择被踢时明确提示、停止自动抢回。 |
| `Compensate(plan)`、`Attempt(InPageCompensation)` | `CompensationLoop` 已支持单飞、请求间隔下限、失败退避、消息去重、`compensation_sync` 水位推进；可通过 `setTransport()` 在 connected 10 秒与其他状态 5 秒间切换（`web-adapter/src/compensation.ts:15-22,79-85,92-103,140-198,224-254`）。宿主可读当前与落盘补偿水位的较新值（`state.rs:505-518`）。 | Supervisor 的恢复计划还包含 `begin_msg_time_ms = min(now - lookback, watermark)`、5 秒 fast window 与立即恢复动作（`supervisor.rs:497-509`）；现有 loop 只在创建时接收 `initialBeginMsgTime`，没有运行中的 cursor/fast-window/立即补偿命令。需增加一个有界、单飞的恢复控制接口，更新游标并安排补偿，不得另起第二条 `getRecentMessages` loop。 |
| `reset_conversation_list_cursor` | `ConversationListPoller.start()` 将游标设为 `null`，即从全量快照起步；poller 已能消费官方页响应（`conversationList.ts:165-174,409-442`）。 | 没有运行中的 reset API。需要显式 reset/restart 控制，并确保官方 feed 活跃时仍只消费官方响应，不并行发第二个列表请求。PageReady/恢复后的全量列表同步应验证 `startTime` 缺省，再由现有 cursor/事实流程推进。 |
| `BeginDrain`、`JournalDrained`、`AbortInflightAsUnknown`、`send_gate()` | Host 已有按账号的 outbound journal 与统一发送失败分类：已发到页面但无可信答复会保留 `unknown`，不会重发（`adapter.rs:263-285`）；`PendingTable` 可按旧代次取消待答复（`adapter.rs:146-204`），journal 提供未完成记录读回（`outbound_journal.rs:642-670`）。Supervisor 定义 `draining`、`im.channel_recovering` 与超时转 unknown 的语义（`supervisor.rs:200-219,248-263,359-367`）。 | 尚无 host recovery gate 接在 `im_send_*`/上传命令入口，也无“开始 drain—待活动写入结束—发 `JournalDrained`”事件通道。需把 admission gate 与现有 outbound transition 串行化：draining 期间拒绝新的发送/上传；超时将已开始但无结论的意图保留为 unknown、不自动重放；只在活动记录已结清后继续 reload/rebuild。不能把 unknown 历史记录当作待重发，也不要绕过当前 journal 与锁顺序。 |
| `ReloadPage`、`PageReady` | 原生 `webview_recovery` 处理 WebView renderer/browser 进程故障，有 incarnation/revision/serial 栅栏；恢复时会 revoke 旧 page/RPC generation、锁定 outbound storage，再在主线程核验当前 view 和 account binding 后调用 `view.reload()`（`webview_recovery.rs:351-412,440-474`；`login.rs:2481-2520`）。当前有效的 `adapter_ready` 带 boot epoch/lease（`adapter.rs:1274-1304`；`login.rs:1868-1954`）。 | 这是原生进程崩溃恢复，不是 XMPP/HTTP 健康监督；直接调用它会带入其 generation 撤销语义。Supervisor 的主动页重载尚无专用 host executor。先明确其与 crash controller 的所有权/互斥，再复用安全生命周期。`PageReady` 必须来自当前账号、当前 view incarnation 和有效 boot lease 的 `adapter_ready`，不能只用窗口 load 事件；旧文档/旧代次的 reply 必须继续被拒绝。 |
| `RebuildWebview` | 登录模块有创建隐藏 account WebView 的流程（`login.rs:697-733`），`profiles::destroy_window()` 可销毁窗口，adapter WebView 配置了 `BackgroundThrottlingPolicy::Disabled`（`profiles.rs:165-215`）。 | 没有 supervisor 专用的受控重建操作；当前 crash 恢复只 reload 原 WebView。需由 host 生命周期代码处理 drain、destroy/recreate、profile、账户绑定、boot lease 和 ready 回读，并阻止 native crash controller 与 supervisor 同时重建同一实例。背景节流设置只是配置，不是实际 cadence 证明。 |
| `ShowChannelAbnormal`、`ManualRetry`、`AccountRebound` | `Supervisor::ManualRetry` 仅在 `Tripped` 解除熔断并发起一次新尝试；终态不接收它（`supervisor.rs:413-491`）。native `webview_recovery_retry` 仅用于 crash controller 的 `manual`/`listener_failed` 状态并核对 incarnation（`webview_recovery.rs:527-568`）。 | 主窗目前没有来自 supervisor 的“消息通道异常”状态/按钮，也没有独立的 channel retry 命令。新增 breaker UI/action 时应与 `webview_recovery_retry` 分开；终态按钮走现有重新登录流程，不得发 `ManualRetry`。`AccountRebound` 只绑定一次明确的新登录，不能由普通页 reload 触发。 |

## 必须保留的身份与恢复边界

- Supervisor、计数器、定时器和动作都要绑定具体账号/环境及会话代次；向页面发请求前验证当前账号和准确的 account WebView（`adapter.rs:749-775`）。执行 reload/rebuild/page-ready 时继续复核当前 `ViewContext`、WebView incarnation 与账户绑定（现有 crash recovery 的核验见 `webview_recovery.rs:440-460`、`login.rs:2523-2538`）。
- `PendingTable::complete()` 只接受与原请求完全相同的账号身份和代次（`adapter.rs:146-182`）。恢复动作不能放宽 native-instance、document-reply 或 generation fence 来让旧页“恢复成功”。
- 将 host state 变化收集成短动作后，在锁外执行 RPC/窗口操作；结果重新入队时再次核身份。此图不主张直接拆共享锁，也不取代 I-04b 对有序发布的设计。
- 不以关闭登录冲突保护恢复账号共存。X11 的规则是同账号不承诺与官方网页同时在线；可靠终态必须停止本账号自动抢回，不影响其他账号。

## I-05a 与本轮证据边界

I-05a 计划要求在 WKWebView 与 WebView2 的平台/官方页/窗口状态矩阵测量 SDK ping 与补偿 cadence，并规定触发停止条件后暂停 I-05b（`docs/plan/2026-11-02-reverse-driven-improvement-plan.md:151-163`）。源码只表明 hidden adapter WebView 使用 `BackgroundThrottlingPolicy::Disabled`（`vbk/src-tauri/src/profiles.rs:165-203`）；没有由此得出真实隐藏态 timer 节奏通过的依据。2026-11-04 的 reference-led 决定明确本轮不索取受控账号、不做真实业务收发，按官方机制、已有逆向证据及本地回归继续，合成/源码证据不能写成服务或目标平台验收（`docs/decisions/2026-11-04-reference-led-validation.md:1-7`）。

因此：X4/受控账号不作为本地代码接线的前置；I-05a 的平台测量仍为未知，不能宣称通过，也没有被 reference-led 指示豁免。根状态机与本地 host adapter 的确定性接线可以单独评估；是否允许在 I-05a 未知时推进 I-05b 主动 reload/rebuild 的集成，由 root 决定。未有停止条件测量结果前，不作目标平台可靠性或正式验收结论。

## 最小本地回归方案

1. **事件归属与活性**：当前账号/代次的已接受 message、compensation response 与 SDK 状态映射正确；旧 `ViewContext`、过期 epoch/seq、错误账号或旧 document reply 不更新活性。普通断线不能映射为 terminal。
2. **监督状态**：覆盖 `InPageCompensation → ReloadPage → RebuildWebview → Compensating`、退避、熔断、离线冻结、唤醒恢复；对 `TerminalReason::ALL` 验证只发终态通知、没有自动 retry/reload/rebuild/compensate，send gate 关闭，并只由显式新登录恢复。不同账号的状态、计数和提示互不影响。
3. **补偿单飞与游标**：恢复按 lookback 与已存水位取较早起点；`getRecentMessages` 同时最多一条请求，恢复时不创建第二 loop；会话列表 cursor reset 只导致一次完整同步，官方 feed 活跃时 adapter 不额外发列表请求。
4. **发送屏障**：并发开始 drain 后，新 text/upload admission 被拒；既有活动记录完成才发 `JournalDrained`，超时转 unknown、重启/页面恢复后仍不自动重发。测试覆盖 drain 与发送同时竞争的顺序。
5. **reload/rebuild 身份栅栏**：旧 incarnation 的延迟 callback/reply 被拒；只有当前 boot lease 的 adapter READY 产生 `PageReady`；主动 Supervisor recovery 与 native crash recovery 不对同一 view 双重调度。保留既有 instance/document reply tests。
6. **熔断计数与手动入口**：`CircuitCounters` 保存/重建、账号隔离与 strict decode；Tripped 才可执行 channel manual retry，Terminal 只进入明确重新登录路径，native crash retry 仍只处理 WebView process failure。

以上均为建议的本地确定性回归，没有在本轮执行；它们也不能代替 I-05a 的平台节流测量、72 小时长稳或原生 UI/目标包验收。
