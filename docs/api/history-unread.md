# 历史读取与未读计数

2026-10-31。未读来源是同一账号页面会话中的 `UnreadBook`，由 `getConversationInfoByGidList.conversationInfoList[].unreadCount` 更新。任何会话展示投影（列表、成员补全、历史补全）在 `createPageSession` 的 `pushDisplay` 出口使用该来源覆盖派生值；未获取过计数时保持输入值。

读取 `getMessageList` 只读取历史，不代表本客服发送了已读回执，更不代表客户已读。`im.mark_read` 通过官方 SDK 发送回执；SDK 返回成功也不在本地直接清零。服务端确认零值后正常传播。

最小脱敏序列：`unread=3 → im.messages → unread=3 → 相同值轮询 changed=[] → im.mark_read → unread=3 → 服务端 unread=0 → unread=0`。

回归文件：`vbk/ui/packages/web-adapter/src/history-unread.test.ts`。它使用真实页面 session、RPC、history 和 unread 逻辑，仅 SOA/SDK 传输由仓库已有 fake 模拟；验证历史确实返回消息、读取本身零回执、UI 的未读门槛仍会触发回执及服务端零值可更新。

本轮继承的未提交 `rpc.ts` 历史补全会重投影会话，缺少 unread lookup 时产生零值；修复前该测试实际失败 `0 !== 3`，修复后 1/1 通过。原始输出仅存本机 `/tmp/vbk-history-unread-red.tap`、`/tmp/vbk-history-unread-green.tap`，不将日志入 Git。此行为提交是统一出口的不变量防护，不包含继承的分页/身份/订单功能，亦不把离线回归等同于三端实机验收。

宿主补充：`im_mark_read` 收到 SDK ack 后只返回调用结果，不再调用 core.on_open_conversation 或 DisplayCache.clear_unread；DisplayCache 的此本地清零入口移除。真实服务端计数经既有 adapter fact/display 路径进入核心和界面。新增 Rust cache 回归验证3→同值3不产生变化→服务端0才清零；它不模拟 Tauri 窗口，结合session回归和宿主实际diff评审作为离线证据，原生验收另计。

已读可见性安全栅栏：`im_mark_read` / `im.mark_read` 必须携带 `expected_message_id`，宿主原样转发。页面适配器在 SDK 调用前要求该值是非空字符串，且与当前 `store.latestMessage(gid).msgId` 完全相等；缺失或不匹配直接失败，不替换为最新 ID，也不发送回执或清零本地未读。列表更新在界面观察之后引入新消息时，旧观察凭据因此失效；界面重新确认可见后才可发出新请求。

回归 `rpc.test.ts` 使用真实 RPC 分发器与会话存储，覆盖缺失/错误类型/空值/错误 ID、观察后新消息到达、匹配 ID 提交以及失败/ack 均无本地未读投影；`mark-read.test.ts` 核对 mock 同样拒绝错误 ID，并保留未读与等待轮次。实际新增 RPC 回归在实现前失败（错误请求返回成功），实现后通过。宿主只改命令参数及转发，本轮未运行 Cargo 或原生客户端验收。

界面回执入口统一为真实 DOM 重绘和历史锚点恢复之后，以及滚动/恢复焦点/可见性变化时的重新核验；会话预览广播和 `openConversation` 本身不再直接发送回执。要求当前账号、环境、代次、会话一致，首屏已加载、主窗口可见且有焦点、消息视图无遮挡面板，并且最新服务端消息的唯一 DOM 行仍连接在该 scope 的消息窗格中且与可视区域相交。权威 frontier 的新 ID 尚未渲染时拒绝；无服务端 ID 的本地发送记录不提供已读依据。

同一完整 scope 和消息 ID 的自动尝试去重；结果不明不因重绘、滚动或恢复焦点自动重试。用户显式重开该会话可重新尝试已经结束的请求，但不清除在途尝试，避免在途失败后被定时重绘隐式重试。SDK ack 仍不清本地未读。此策略只界定客服实际看到的入站内容，不改变客户是否已读的展示。

同 gid 可切换客户/服务会话，因此消息 ID 之外还必须携带 `expected_context_revision`。适配器用当前 self UID、实际 partner JID 与 `assistantContextRevision` 比对；缺失或不相等时 SDK 零调用，即使最新消息缓存仍保留旧客户高时间消息也不得放行。宿主原样转发该必填凭据，mock 对照会话 `assistant_context_revision`。实际 RPC 回归先证实旧凭据在 A→B 同 gid 替换后错误放行（红），加入上下文校验后拒绝旧凭据，并验证 B 的当前上下文与当前消息可成功提交（绿）。

服务身份补强：`expected_context_revision` 同样必填，取自已加载历史的真实来源而非随最新预览更新；`im_message_page` 可选携带该 token，并在历史请求前后验证。界面 history 与 DOM 窗格必须同 token 才可回执。后端服务 epoch 在 A→B→A 仍单调增加，跨服务异步历史/未读结果不写入新服务。所有 epoch（包括首次加载）只有权威会话 row 内嵌的最新消息可以推进行快照 `latestMessage`；gid-only 来源不能自动证明所属服务，只有通过房间、客户 uid、线程与服务切换 fence 核对后才能推进 read target（`ConversationStore.#notePeerRow`）。其中历史页受行快照时间上界约束；实时 SDK 帧与补偿帧（`noteLiveMessage`）允许越过行快照，因为客户最新消息才是已读边界，若客服在下一次列表轮询之前已回复，行的最后一条将永远是本方消息，边界停在旧消息上、回执永远发不出、红点点击后不会消失（2026-11-04 修复，回归 `live-read-frontier.test.ts`）。服务切换仍丢弃该边界。补偿请求发出时记录每个 gid 的服务 revision（`onCompensationRequest` 票据），响应回来后只有请求时已知且 revision 未变的 gid 才能用其帧推进边界（A→B→A 回到旧 A 快照时，第一段 A 的迟到响应无论时间多新都只能展示；请求时尚未观察到的 gid 没有“首个上下文”例外）；滞后的 `getConversationInfoByGidList.message` 只有与行当前房间一致时才能覆盖行的最后一条消息，回执地址不会被改写到别的房间。已接受的残余：实时 SDK 帧没有请求票据，A→B→A 回到同一服务快照后，第一段 A 的极度延迟帧仍可建立边界；该帧与第三段 A 的 orderContext 完全相同（同 sessionId/客户/线程），回执发往同一房间，且界面只对 DOM 中可见的目标行发回执，故不构成错误回执；某服务的快照时间低于前一服务不影响其自身实时帧（只受自身 fence 约束）。同一时间戳的不同消息按服务端消息 ID 定序（数字越大越新），行、历史、实时三个来源收敛到同一目标，重复或乱序帧不会翻转边界。

已读消费水位（`UnreadBook`）记录回执目标、客户 uid 与确认时刻，只用于弥合服务端反映回执之前的滞后：滞后计数在以下条件同时成立时才被压为 0——详情内嵌的最新消息不是比目标更新的客户消息（本方/同事回复、目标本身、更旧消息）且距确认不超过 `READ_GRACE_MS`（30 秒）。边界移动到更新的客户消息时水位立即作废；发送者未知或客户未知时按客户消息处理；窗口到期后服务端计数无条件生效。因此红点可能显示客户端从未观测到的消息，但不会遮蔽任何真实未读；最坏情况是一条客户端未收到的客户消息被同事回复“盖住”最多 30 秒后才显示（不变量 3：可见最新不等于完整，窗口到期即以服务端为准）。SDK 回执成功但本地未采纳（在途期间出现新证据）时通过 `onReadReceiptConfirmed` 重读服务端计数。自动标读可能延迟到下一次官方列表对账，绝不本地伪清未读。所有服务的 SDK 房间地址都须匹配权威 row；缺少匹配依据不发回执。

会话投影中的 `read_target_message_id` 是当前服务可确认的已读边界，类型为可选 string/null。旧 payload 仍可显示，但缺失/null 不自动已读；空白、非字符串或超过 512 个 UTF-16 单位拒绝。UI 必须在已加载且来源 revision 一致的消息 DOM 中找到该 ID 的唯一可见行，不能使用混合历史最高时间替代。复用 gid 的未确认旧帧不覆盖当前服务预览；权威列表追上后可恢复选择 B 目标，即使历史仍保留 A 的更高时间记录。

同一完整 scope 的已尝试目标使用集合保留，不因 frontier A→B→A、切换 scope 或缓存上限而遗忘未知结果；显式重开仅释放该 scope 已结束目标。preview 时间不作为身份或已读依据，旧高时间不会阻塞当前权威且可见的确切 ID。


## 消息送达与实时已读展示（2026-11-04）

消息气泡角落使用单勾表示已送达、蓝色双勾表示已读，客户气泡右侧、商户气泡左侧，贴近下沿且不占气泡下方空间，与消息时间开关独立。本人消息只有服务端发送确认或明确读状态才显示勾，发送中、失败、结果未知不据此显示送达。客户/同事消息要求有效服务端消息 ID。历史商户消息读取 `isTargetRead`；客户消息读取 `isread`，不把两者互换。

官方桌面枚举中的 `OtherHasRead=1023` 用作实时刷新信号，证据见 `docs/research/evidence/desktop-message-classification-20261103.json`。收到已知房间的 1023 后，适配器立即读取 `getMessageList(showTargetIsRead:true)`，按已加载目标消息的时间窗口跳转，不从最新页扫固定数量页。只有服务端明确布尔状态、精确消息 ID 与发送者匹配才生成 `message_read_statuses`；不猜测通知正文的游标，也不将 `notify_ack` 或 `send_result` 当作客户已读。通知合并、最多两个会话同时刷新，查询后重新校验账号运行代次和单调服务 revision，防止 A→B→A 旧结果回流。

宿主更新已有缓存后，通过独立 `im://message-read-statuses {account,gid,items}` 将状态转给主窗口；即使目标已被宿主的 500 条缓存淘汰，也能更新界面保留的更早历史，不创建新消息或回放消息正文。宿主与 UI 的已读状态都不可被迟到的未读/未知状态回退。

当前可见客户消息的 SDK 已读回执成功后，先更新确切目标的双勾，再只读刷新其他已加载客户消息的 `isread`；不凭时间把混合服务历史批量标读，且不直接清空会话未读数。失败或结果未知不生成已读更新。

验证包含合成实时帧到 session、窗口/代次切换、重复通知、孤立旧历史、超过宿主缓存的 UI 状态更新、发送失败及单/双勾布局。已通过 ego-browser 本地演示界面验证状态事件使左右气泡从单勾即时变双勾；尚未捕获真实客户 1023 原始帧，也未完成新安装包的真实会话收发验收。
