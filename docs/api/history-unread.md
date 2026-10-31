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

服务身份补强：`expected_context_revision` 同样必填，取自已加载历史的真实来源而非随最新预览更新；`im_message_page` 可选携带该 token，并在历史请求前后验证。界面 history 与 DOM 窗格必须同 token 才可回执。后端服务 epoch 在 A→B→A 仍单调增加，跨服务异步历史/未读结果不写入新服务。所有 epoch（包括首次加载）只有权威会话 row 内嵌的最新消息可以建立 read target；其他 gid-only 来源只可展示，不能自动证明所属服务。自动标读可能延迟到下一次官方列表对账，绝不本地伪清未读。所有服务的 SDK 房间地址都须匹配权威 row；缺少匹配依据不发回执。

会话投影中的 `read_target_message_id` 是当前服务可确认的已读边界，类型为可选 string/null。旧 payload 仍可显示，但缺失/null 不自动已读；空白、非字符串或超过 512 个 UTF-16 单位拒绝。UI 必须在已加载且来源 revision 一致的消息 DOM 中找到该 ID 的唯一可见行，不能使用混合历史最高时间替代。复用 gid 的未确认旧帧不覆盖当前服务预览；权威列表追上后可恢复选择 B 目标，即使历史仍保留 A 的更高时间记录。

同一完整 scope 的已尝试目标使用集合保留，不因 frontier A→B→A、切换 scope 或缓存上限而遗忘未知结果；显式重开仅释放该 scope 已结束目标。preview 时间不作为身份或已读依据，旧高时间不会阻塞当前权威且可见的确切 ID。
