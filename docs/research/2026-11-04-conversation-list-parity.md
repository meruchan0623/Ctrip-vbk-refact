# 会话列表与官方桌面版对齐核查

2026-11-04。结论：部分对齐，不能将此前预览修复称为完整迁移官方会话列表逻辑。本轮只做核查及合成探针，没有修改业务代码、访问客户数据或执行真实接口写入。

直接重读本机 `/Applications/旅游商家桌面版.app/Contents/Resources/app.asar.unpacked/dist/js/imWindow-BaGPtUvK.js`，SHA-256 `9b4894abe8eab7274749169b8db0660e43301beeebdd30a4bc384ce216bfce47`。当前产物摘录及 UTF-8 偏移见 [证据](evidence/conversation-list-parity-20261104.json)。没有把旧 Windows 版本函数名当作本机证据。

## 尚未对齐的功能路径

### 1. 详情接口携带的最新消息没有进入预览

官方 `getConversationListDetail` 将 `getConversationInfoByGidList` 的结果交给 `UPDATE_CONVERSATION_DETAIL`，再触发 `fetchLastMessage`。`ri` 明确支持会话的 `message` 字段：没有 lastMessage 时执行 `va(message)`，随后使用 `Kr` 生成摘要。

本项目 `UnreadBook.refresh` 能收到详情里的 `message`，但 `session.ts::runUnreadBatch` 的回调只用它记住房间 JID，没有把正文更新到列表。`display.ts::parseLastMessage` 只支持 `lastMessageJsonString/lastMessage`，没有 `message` 后备。

实际本地函数的合成探针：一个仅有 `message: {msgtype:0,messageBody:'synthetic self reply',...}` 的合法列表行，`toDisplayConversation(...).preview` 返回空字符串。这是剩余的直接数据路径缺口，当前历史预加载在部分情况下绕过了它，未消除它。

### 2. 预加载只补空白，未刷新已有摘要

官方 `fetchLastMessage` 对当前详情批次中 status=1/2 的会话主动读取 `getMessageList`，pageSize=20，等待上限5秒；其列表 reducer 维护最近20条候选，并选最后一条非空摘要。不依赖用户打开会话，也不限于空摘要。

当前 `session.ts::preloadPreviews` 仅在 preview 为空时读取最近30条，并发上限2；结果回来时若 preview 已非空也会放弃。因此已有旧摘要、SDK漏接且列表没有携带可用正文时，单靠此路径不能主动纠正。当前代码额外覆盖已结束会话的空预览，这是用户需求下的扩展。并发限制、跨账号/会话检查及不发送已读是合理保护，不应为了逐字一致移除。

### 3. 排序缺少时间回退

官方 `ri` 使用最新消息 createTime，缺失时回退原 lastUpdateTime；`Nve` 在置顶优先后按该 lastUpdateTime 倒序。当前 `sortConversations` 只看 last_message_time_ms，缺失即0；既不回退 last_update_time_ms，也不由内嵌消息时间统一补足。

合成探针：两行 last_message_time_ms 均为 null，last_update_time_ms 分别10和20，现有排序保留旧行在前，和官方不一致。可能影响预览旁时间及预加载后列表位置，需要统一定义排序时钟，不能简单一律改用原始更新时间。

### 4. 摘要类型覆盖不完整

官方 `Kr` 支持语音4、位置6、卡片2、文本0及7的多个业务 action 摘要。当前 `previewOf` 对4、6返回空；2按文字标题显示，官方通常显示“[卡片]”；CBZ03/CBZ09/CBZ04/CBZ58/CBZ59等也没有完整对齐。已核实合成语音/位置消息均得到空预览。

预览能力应与聊天串是否已实现语音/位置完整组件解耦。协议隐藏规则仍需保留，不能把所有系统帧都变成预览。

## 其它差异与已对齐部分

| 项目 | 当前结论 |
| --- | --- |
| 置顶 | 官方是本地数据库标记，本项目是账号隔离的本地置顶文件；业务含义一致，不承诺跨设备同步。 |
| 颜色 | 当前代码按官方原始 sessionId/id 和 +gid 请求 setWorkSheetStar，成功后才更新；没有按已结束限制菜单。静态调用链一致，非真实账号写接口验收。 |
| 状态1/2/4 | 已明确映射active/active/finished。官方列表只纳入对应状态；本项目仍将客户 unknown 放入待处理，属额外宽松规则。 |
| 客户业务分类 | B2C/C2B/B2MC及O2B+2573特例一致。官方另有企业栏和按颜色筛选；当前主列表按用户工作台方向只呈现客户待处理/已处理，无官方 currentStar 列表筛选。 |
| 未读 | 同样读取详情接口，但官方有实时消息、当前可见会话和已读事件的本地计数更新；本项目坚持权威刷新，不把SDK回执当清零证据，因此刷新时机不保证一致。 |
| 本地历史 | 官方有本地数据库先读、服务端合并和30日旧行清理。本项目正文展示缓存不持久化，完整快照会移除未返回的行，另有2000条展示上限；列表集合/数量不能保证相同。 |
| 客户语言 | 当前客户原文优先是此前用户要求的调整，不是官方地区语言字段的原样迁移。 |
| 布局 | 公司名移除、80px行高和三栏可调是用户指定改动，不作为对齐缺陷。 |

## 验证边界与优先级

本轮重读官方发布脚本及当前 owning source，并通过真实本地函数的合成输入验证 message字段、语音/位置摘要、排序回退和unknown状态差异。没有浏览器、真实账号计数对账或本地数据库内容取证，不能给出整套会话列表“已验收对齐”的结论。前轮1268项测试通过证明已编码断言通过，不证明上述尚未覆盖的官方行为一致。

建议先补详情message进入预览及已有摘要刷新，再统一摘要规则和排序时间。历史集合与状态未知值涉及产品口径，应在对应范围内明确选择后处理，不应在一次预览修复中默默改动。

## 后续实施

本报告的四个功能缺口及未读恢复链路已在同日本地修复，见 [修复与验证记录](2026-11-04-conversation-list-unread-fix.md)。以上保留核查当时的发现；本地历史集合、未知状态等未列入本次四缺口范围的差异不因此被称为完全一致。
