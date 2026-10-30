# 消息面板可见字段与按钮对照矩阵

核对日期：2026-10-31（Asia/Singapore）。初版由已有脱敏采证材料及源码只读编制；后续主代理已追加ego和原生实测。下列第3轮更新优先于初版源码快照，未取得的端证据仍明确保留。所有例子为合成展示值，不能发送到真实接口；示例字段省略不代表真实请求可省略 head、鉴权或上下文。

## 第3轮实测更新（2026-10-31）

| 本次范围 | 官方网页/真实字段 | 项目代码与脱敏样例 | 当前状态及证据 |
|---|---|---|---|
| 本人/商户成员消息靠右 | 用户明确覆盖默认布局；sender_role仍按真实身份确定 | main.messageRow → messageAlignment；synthetic-self/colleague | fa45301已提交，独立7项与真实messageRow评审通过；第3轮原生本人和Sara商户同事均在右侧、客户卡在左侧。其他商户消息没有本人重试/发送状态权限 |
| 每人头像与姓名 | members[].uid/nick/avatar；remarkList[].username/nickName/avatar；本人GetMyInfo.jid与venAgent.ctripUid相等才用agent头像 | RoleBook.profileOf、identity.selfProfile、boot→session；https://example.invalid/person.png | foundation 2b73b74独立12项通过；10-31 ego成员4条均有头像，self/customer DOM已对应，消息d41e5fd、列表/标题d3aaaa5、账号d152f66、成员/邀请eb67560均已提交并独立离线通过；客户侧卡/提醒5db15cc已提交；第3轮新包全部回退文字占位，ego实际meta CSP拦截dimg04，修复/复验进行中。见[人员资料](../api/person-profiles.md)，不称三端头像通过 |
| 常规启动密钥读取 | 标记存在查询不是获取登录密码 | KeychainStore.probe、CredentialLedger.recover；synthetic marker | e49ca90元数据查询+不可用保留引用已提交，核心301/host59通过；第3轮启动自动恢复账号且无需再次点提示，仅证明一次启动 |
| 文本客户端→官方 | callback confirmed有效消息ID；官方stanza同字符串ID | sdkFacade/send、主UI消息ID；合成R3-C标记 | 第3轮04:56:10单次原生发送，官方可见且服务端ID逐字匹配；官方显示未读，不能记客户已读 |
| 官方→客户端实时 | stanza groupchat与HTTP历史 | sdkGlue/session/DisplayCache；合成R3-W标记 | 第3轮05:02:03官方发送，49秒未自动到达；加载历史后正文/发送者/服务端ID对应。连续三轮实时失败，转脱敏链路计数诊断，不倒推根因 |
| 同步帧/单聊路由 | 官方sys_muc→groupchat、sys_mam→chat；本人uid与room/peer区分 | resolveSdkAddress、createAdapter动态rolesProxy | 58f46fd与65117a8已提交，含动态身份突变红→绿，SDK健康重绑c73f5ad已提交并离线验证。并非native实时已经通过 |
| unknown重启屏障 | 上游缺少已验证幂等保证，local_id仅关联键 | im_send_text→send_once→FileStore；synthetic local_id | 79e5e50已提交，写前fsync与stable account/local_id去重，独立host72/专项13通过；新包重启及专用只读核验UI未验，首轮unknown不可补造历史账本 |
| 媒体/引用撤回/重连 | 分别需要真实资源/引用ID及状态读回 | 现有media/upload函数及UI | 第3轮视频仍Invalid；10-31 ego同历史视频已加载readyState4/error=null，不能归因素材失效。媒体发送仍阻断伪文本；引用撤回/可靠重连未完成 |

本表真实运行依据：[第3轮记录](2026-10-31-round3-runtime.md)。新包为target/bundle、PID80117、binary hash0e5a3915…65f56c8，TS387/核心301/宿主95及完整构建门禁通过，实机未通过。官方桌面CUA超时、助手认证失败继续生效，网页证据不能代替对应端视觉。

## 证据层级与三个界面边界

| 界面/产物 | 2026-10-31 已有证据 | 不可据此声称 |
| --- | --- | --- |
| 官方网页登录页/消息工作台 | 主代理环境重勘确认 ego-browser 登录有效、受控客户及关联订单侧栏可见；2026-10-30 受控网页操作另有逐项请求及读回记录 | 10 月 30 日写操作不代表本轮重做；单个账号/业务线成功不代表全账号权限、桌面原生和新客户端通过 |
| 官方 macOS 桌面 | 本轮主代理提供诊断：CUA 连接出现 AppleEvent `-1712` timeout；重勘文件记录准确路径连接 `timeoutReached`；进程/安装可核实 | 未取得本轮原生消息面板视觉，不能将超时推断为停在登录页、未安装或签名坏；`-1712` 是本轮主代理诊断摘要，本文件编制者未独立执行 |
| 旅游商家助手/原插件 | CUA `timeoutReached`；重勘见插件 0.7.5、助手 0.3.2，`panel-mounted`、`attached=true`、`composerSource=verified-editor`；日志曾 auth ready，最新 auth failed/phase failed | 静态部署/挂载有效不等于 TSim 认证、翻译或查询成功；旧“插件缺载荷”结论失效 |
| 自制客户端旧运行包 | `vbk/release/macos/VBooking 商家客户端.app` 原生可读，旧界面仍有“发送中”及禁用控件 | 当前源码、新构建 app/dmg、实际运行旧包是三份状态；本矩阵源码入口存在不算新包实机通过 |

上述时点来源：[环境重勘](2026-10-31-environment-resurvey.md)；[桌面插件调查](2026-10-31-desktop-plugin-parity.md) 末尾已说明早期缺载荷记录过期。官方 `-1712` 诊断由主代理本轮提供，原始 UI 工具结果应由主代理保留。下面每行“网页证据”仅指该文件记载的层级，**官方桌面/助手均继承上表的原生未验状态，自制客户端均继承旧包不代表新包的限制**，不在每行重复宣称通过。

## 本轮接线更新（第 1 轮构建前，覆盖下表的早期源码快照）

- 话术、成员、邀请、转交、结束已有 adapter→RPC→IPC→宿主ACL→可见对话框完整接线。实际入口为 `main.ts::peripheralDialog`、`peripheralPanel.ts::createPeripheralPanel`；非空话术仍明确unsupported，未编造内容。新包实机尚未通过。
- 选择凭据绑定真实会话字段、30秒期限与页面run代次，写前重读成员，写后只读核验；confirmed/accepted/unknown分别显示。unknown/accepted不重发。前置缺字段零请求允许补齐后重试，已尝试的操作按gid+sessionId+action+targets记忆，metadata补全不能重放。
- UI已加入账号/环境/auth generation/请求代次隔离；发送成功与异常、译文预览与发送晚到均检查原归属。unknown同room换新service session但auth generation不变时仍保守锁写，属于尚未完善的限制。
- 历史未读出口及宿主ACK强清零已修；SDK回执无损ID/缺证据unknown、disposed写保护、历史preview防回滚和stop/start旧请求写栅栏有离线回归与独立评审。242项TS、300核心Rust、63宿主通过，不替代三端视觉/真实收发。
- 原生官方/助手连接与TSim认证阻塞、附件文本占位、推荐与完整来源轨迹、插件查询/撤销等缺口仍未解决；不能把本节接线更新读成整体完成。

## 路径与阅读约定

- `M::符号` = `vbk/ui/apps/main/main.ts` 中对应函数/常量；本文件 2026-10-31 源码快照。`A/文件::符号` = `vbk/ui/packages/web-adapter/src/文件`；`IPC` = `vbk/ui/packages/ipc/src/client.ts` 的 `UiCommands`。精确函数名用于代码持续变化时定位。
- `E/文件` = `docs/api/evidence/2026-10-30/文件`；`P/文件` = `docs/api/endpoints/文件`。这些是精确仓库相对路径，日期由目录固定为 2026-10-30。每行“10-30”表示已有采证日期；“10-31 源码”仅表示本次阅读时间。
- 主依据为 [接口采集与读回](../api/validation.md)、[传输契约](../api/transports.md)、[鉴权](../api/authentication.md)、[TSim 源码契约](../api/external-tsim.md)。早期 research 静态候选如与新采证冲突，以当前 docs/api 请求与读回为准。
- 合成 `synthetic-*` ID 故意不符合部分上游数值校验；颜色 action、工作状态值、msgtype 等协议枚举则保持实际值。未找到数据的区域不填假名字、人数、订单金额或业务成功。
- 周边 RPC/宿主由并行实现任务接线中；下表准确描述读文件时 UI 的 `notWired` 状态，不阻止后续实现。完成接线后仍须重建并做新包实机读回，再更新状态。

## 列表、搜索、标记与身份

| 可见字段/控件 | 官方行为与接口字段 | 当前代码入口 | 合成样例 | 当前实现/实机状态 | 证据日期与精确文件 |
| --- | --- | --- | --- | --- | --- |
| 会话列表/正在处理/已结束 | `getConversationList[.json]` 返回 `conversationList,currentStatus,lastUpdateTime,haveRest`；请求 `needTodoList:1` 为数字，增量用 `startTime` | M::loadForActiveAccount/conversationList；A/conversationList.ts::conversationListBody/createConversationListPoller | `gid=synthetic-room-a,status=2` | 源码有轮询/过滤；新包未实机。状态以实际映射表解释，非任意非零都结束 | 10-30：P/m.ctrip.com-16037-getConversationList-post.md；E/17-full-list-exact-replay.json；10-31 源码 |
| 客户标题/头像/语言/商家 | 官方行含 `groupTitle,uid,languageInfo.lang,ext.locale,vendorName,serviceType`；groupTitle 可是产品标题，不保证客户名 | M::conversationList/chatPane；A/display.ts::toDisplayConversation | `客户=synthetic-customer,产品=synthetic-product,lang=en` | 列表使用 c.title；当前 display 仍以 groupTitle 优先，客户身份标题准确性需核验；头像无数据时只显示首字，不等于真实头像 | 10-30：P/m.ctrip.com-16037-getConversationList-post.md；10-31：A/display.ts::toDisplayConversation |
| 预览/最后消息时间 | `lastMessageJsonString` 内消息与上游时间；内部控制消息不能当客户正文 | M::conversationList；A/display.ts；A/facts.ts | `preview=SYNTHETIC TEXT,time=1800000000000` | 有预览/相对时间显示；控制消息过滤及新包显示待实机 | 10-30：P/m.ctrip.com-16037-getConversationList-post.md；E/54-sdk-restored-by-official-page-reload.json |
| 红点/未读数/等待计时 | 消息增量及未读事实与 `waiting_since_ms/waiting_confirmed` 分开；未读不是成员数 | M::conversationList/waitedSeconds/accBadge；A/conversationList.ts::toConversationFact | `unread=3,waiting_confirmed=false` | 源码可显示待确认计时；重勘发现历史加载伪清零，最新修复须看回归与新包，本文不记已修 | 10-31：2026-10-31-environment-resurvey.md；10-30：2026-10-30-web-reminders.md |
| 列表搜索框 | 官方有 `16037/searchConversation`，请求含搜索类型/分页等；本地筛选与服务端搜索不同 | M::conversationList 的 s.query/filterConversations；A/order.ts::searchConversationByOrder | `query=synthetic-search-token` | 当前主列表输入仅改本地 query，不承诺全历史服务端检索；订单定位另有 adapter | 10-30：P/m.ctrip.com-16037-searchConversation-post.md；10-31：M::conversationList |
| 置顶/取消置顶 | 官方置顶语义不能由颜色接口推导；本项目有本地 pinned map | M::toggleTop/contextMenu；A/pinned.ts::createPinnedMap | `gid=synthetic-room-a,is_top=true` | 有本地命令入口，是否跨端同步尚未证明；不可声称等价官方云端置顶 | 10-31：M::toggleTop；A/pinned.ts::createPinnedMap |
| 橙绿蓝紫粉/清除标记 | `setWorkSheetStar` 请求 `sessionId,groupId:number,worksheetId:number,action:0..5`；橙色读回 star=1，清除 star=0 | M::setMark/contextMenu；A/worksheetStar.ts::setWorkSheetStar/STAR_COLOURS | `action=1` → 橙；`action=0` → 无 | 已有源码；旧包/新包分开验，成功不应仅靠乐观 UI | 10-30：E/72-controlled-color-orange.json、73-color-orange-server-readback.json、75-color-transition-proof.json |
| 平台账号/账号页签 | 官方 Cookie/Profile、`12405/getCurrentUserInfo.user` 是商家身份；不可用客户 UID 或 TSim agent 替代 | M::titleBar/loadAccounts/switchAccount；A/pageContext.ts | `account_id=synthetic-platform-account-a` | 多账号页签与切换源码存在；真实跨账号污染/重登录恢复待新包实机 | 10-30：P/online.ctrip.com-12405-getCurrentUserInfo-post.md、../api/authentication.md；10-31 重勘 |
| 当前客服/工作状态 | `GetMyInfo` 的 `name,avatar,jid` 与 `getVenAgentByUid.venAgent`；`currentStatus`：0在线/1挂起/2离开/3下班；网络断开不是第五状态 | M::meMenu/setAgentStatus；A/rpc.ts::readCurrentStatus | `platform_agent=synthetic-agent-a,status=0` | 有当前身份读回/状态入口；各状态分配业务效果不可凭名称推测，未实机重验 | 10-30：P/m.ctrip.com-11679-GetMyInfo.json-post.md；2026-10-30-agent-status-and-settings.md §1 |
| 客户 UID/发送者姓名头像 | 消息 `fromJid/toJid`、成员 `uid`/角色与 `getRemarkList` 资料结合；不能把 room JID 当发送者 | M::messageRow；A/facts.ts；A/display.ts（HTTP/SDK消息转换） | `customer_uid=synthetic-customer-a,sender_name=SYNTHETIC NAME` | sender_name/sender_avatar 有显示与降级逻辑；资料完整性待实机，不编造昵称 | 10-30：P/m.ctrip.com-16037-getRemarkList-post.md；E/11-members-readback.json；10-31：M::messageRow |
| room/gid/JID | 群 gid、SDK partnerJid/fromJid 的 room 地址不同于客户 uid；不能用标题/订单号代替目标 | A/display.ts::conversationRowView；A/rpc.ts::partnerJidOf；M::openConversation | `gid=synthetic-room-a,jid=synthetic-room-jid-a` | 已有目标解析；历史发送前失败问题以最新修复及受控读回验收，不算本文件测试 | 10-30：P/m.ctrip.com-16037-getConversationList-post.md；../api/transports.md；10-31 重勘 |
| service session/worksheet | `sessionId,row.id(worksheet),conversationKey,conversationType,serviceType,threadId` 分开；worksheetId/workSheetId 外发拼写按操作保留 | A/display.ts::ConversationRowView；A/peripheral.ts；M::chatPane | `session=synthetic-session-a,worksheet=synthetic-worksheet-a` | 部分字段是内部上下文，不必全部展示；缺字段应拒绝动作，不能猜 gid 作 conversationKey | 10-30：P/m.ctrip.com-16037-finishConversation-post.md；2026-10-30-im-peripheral-apis.md §2 |
| 订单 ID 与会话关联 | 行 `relationOrderId/ext.orderId`、订单查询 ttdOrderId 与 room/session 独立；保留字符串避免长 ID 精度损失 | A/display.ts::orderIdOf/orderSummary；M::richText/runOrderQuery | `order_id=synthetic-order-a` | 关联与高亮入口存在；16 位订单问题按最新实现/新包另验，不能用产品名推订单 | 10-30：P/sec-m.ctrip.com-14361-searchorderlist-post.md；E/59-controlled-order-exact-search.json；10-31 重勘 |
| 成员数/名单/主客服角色 | `13500/checkMemberStatus {groupId}` → members；资料另取 `getRemarkList {gid,uidList?}`；roles/status 与在线图标需分别解释 | A/facts.ts 的角色映射；M::chatPane 未见完整成员弹窗 | `members=[synthetic-agent-a,synthetic-customer-a]`（不代表固定人数） | 网页旧证据有成员读回；当前主标题不应凑固定“三人”；完整名单与权限 UI 待接/实机 | 10-30：E/11-members-readback.json、26-transfer-readback-proof.json；2026-10-30-im-peripheral-apis.md §2.2 |

## 消息历史、正文、媒体与回执

| 可见字段/控件 | 官方行为与接口字段 | 当前代码入口 | 合成样例 | 当前实现/实机状态 | 证据日期与精确文件 |
| --- | --- | --- | --- | --- | --- |
| 打开会话/历史初页 | `getMessageList {groupId,conversationType,pageSize,showTargetIsRead}` → `rangeMessage.messages,isDone,lastMessageTime` | M::openConversation；A/history.ts::fetchHistoryPage | `message_id=synthetic-message-a,isDone=false` | 有分页 IPC 与回退 IM_MESSAGES；加载历史不能伪造已读，新包未实机 | 10-30：P/m.ctrip.com-16037-getMessageList-post.md；E/70-history-pagination-proof.json |
| 加载更早/滚动保持 | prev+endTime、next+beginTime；13位毫秒；同时间戳满页尚未实测，不能认定无缺口 | M::loadEarlier/chatPane；A/history.ts::HistoryCursor | `direction=prev,endTime=1800000000000` | 有 has_more/before_ms 与滚动差量补偿；不同会话切换/长历史滚动待实机 | 10-30：E/70-controlled-history-pagination-replay.json；10-31：M::loadEarlier |
| 消息时间/系统行/撤回内容 | `msgId,messageBody,createTime,msgtype`；撤回体 `title,recallMessageId,code:2`；内部 session_status 不应直接显示 | M::messageRow/visibleMessages；A/display.ts；A/facts.ts | `recallMessageId=synthetic-message-a,code=2` | 有 system 行与过滤接缝；原文隐藏/旧消息发送态已列历史缺陷，须新包回验 | 10-30：E/05-controlled-recall.json；P/m.ctrip.com-11679-recallMessage-post.md；10-31 重勘 |
| 撤回按钮/窗口限制 | 网页调用 `11679/recallMessage`，受权限和时间限制；视频菜单超窗仅引用/转发，不能绕过 | M::messageRow 当前仅引用/复制；A endpoint/事实支持不等于可见撤回按钮 | `msgId=synthetic-message-a` | 官方受控撤回有历史证据；当前主 UI 未见撤回入口，待实现/验收，不因显示撤回事件称按钮已做 | 10-30：E/36-text-message-cleanup.json、69-video-recall-menu-unavailable.json；../api/validation.md |
| 引用/取消引用/复制 | SDK XML `message` 属性 citemsgid，不是 msg JSON 内字段；复制为本地剪贴板 | M::messageRow/composer/sendText/copyText；A/send.ts::createSendIntent | `citemsgid=synthetic-upstream-message-a` | 有引用栏与取消/复制；应使用已确认上游 ID，当前 UI 还可能降级 local_id，需验合法性 | 10-30：E/40-controlled-quote-send.json、41-quote-message-cleanup.json；10-31：M::sendText |
| 文本发送/快捷键 | SDK 发送 body `chattype,biztype,localid,msg,msgtype:"0",threadid`；SDK 负责转义/兜底 | M::composer/handleSend/sendText；A/send.ts::submitIntent | `msg=SYNTHETIC TEXT,localid=synthetic-local-a` | 有乐观消息与真实命令；旧运行包“发送中”不代表最新回执；本次未发送 | 10-30：E/35-controlled-ws-text-ack.json；../api/transports.md |
| confirmed/rejected/unknown/重试 | 回执 `send_result` 含 error/reason/localid/tid/create_time；超时/SDK抛错 unknown 不重发；HTTP200不能确认 | M::sendText/resend/messageRow；A/send.ts::classifyAck/submitIntent | `kind=unknown,localid=synthetic-local-a` | 有三态；主代理新修复已将缺有效 tid/畸形错误码归 unknown，明确非零安全整数才 rejected；UI 重试由 sendStateView 控制，unknown 不得放行重发；新包未实机 | 10-31 源码；10-30：E/35-controlled-ws-text-ack.json、51-controlled-http-send-fallback.json |
| 客户已读/未读标记 | `showTargetIsRead`/消息读回与 `PutAdviceOfReadByMsgId` 是不同方向；发送已确认不等于客户已读 | M::messageRow/openConversation；A/markRead.ts::markRead | `read_status=unknown` 时不显示已读标签 | 显示 m.read_status 与回执命令；证据不足保留 unknown；历史伪清零修复需回归/实机 | 10-30：E/71-controlled-read-receipt.json、71-read-receipt-proof.json；10-31 重勘 |
| 图片选择/预览/原图 | uploadTokenCreate → image/v2/api/upload；msgtype=1，msg 是内层 JSON 字符串，含 url/尺寸/缩略图 | M::attach/messageRow/handleSend；A/upload.ts；A/send.ts::createMediaSendIntent | `filename=synthetic-image.png,mime=image/png` | 入站图片渲染与安全 URL 有源码；当前 UI handleSend 将附件名拼进文本，**不能算上传发送链完成**；新包待实机 | 10-30：E/44-image-body-and-auth-confirmed.json、44-image-auth-value-proof.json；10-31：M::handleSend |
| 文件选择/文件链接 | file/v1/api/upload 原 File body；返回 file_name/url；不能套用图片 Authorization/MD5 | M::attach/messageRow/handleSend；A/upload.ts；A/send.ts::MediaFileRef | `filename=synthetic-document.pdf,size=128` | 有文件选择/展示入口；同上 UI 出站仍文本占位，真实文件发送待接/实机 | 10-30：E/33-controlled-file-full-contract.json、34-file-message-cleanup.json |
| 视频播放/封面/时长 | uploadTokenCreate(type=video) → video/v3/api/upload → video/v1/api/proc；msgtype=3，video 含 filename/cover/url/duration/size/width/height | M::messageRow；A/send.ts::MediaVideoRef/mediaMessageJson | `filename=synthetic-video.mp4,duration=0.8` | 入站 video controls 有源码；主 composer 未见独立视频选择按钮，不能算完整视频出站；历史官方视频残留事实见 validation | 10-30：E/68-controlled-video-upload.json、69-video-recall-menu-unavailable.json；10-31 源码 |
| 截图/截图快捷键 | 官方桌面截图依赖宿主，网页上传契约不能证明原生捕获成功 | M::attach('screenshot')/composer；IPC::MEDIA_SCREENSHOT | `filename=synthetic-screenshot.png` | 有截图命令入口与附件栏；原生权限、捕获、上传、发送全链未实机；不可用附件名文本替代 | 10-31：M::attach/handleSend；官方桌面证据仍为 CUA 超时 |
| 表情面板/输入法/发送键 | 本地表情插入草稿后按文本发送；官方表情资源/特殊编码未闭环 | M::emojiPicker/setDraft/composer | `SYNTHETIC TEXT 🙂` | 有本地 EMOJI 插入；输入法组合与快捷键待实机，不等于官方贴图协议全支持 | 10-31：M::emojiPicker/composer；10-30文本发送依据 E/35-controlled-ws-text-ack.json |
| 草稿/切会话/清空附件 | 本地状态不是上游消息；不能发送旧会话草稿或异步旧翻译 | M::setDraft/openConversation/applyAccountSnapshot；ACCOUNT_SCOPED_RESET | `draft[synthetic-room-a]=SYNTHETIC DRAFT` | 有按 gid 草稿和账号切换 reset、版本计数；持久恢复及跨账号同 gid 隔离需实机，未承诺服务端草稿同步 | 10-31：M::setDraft/openConversation/switchAccount；2026-10-31-desktop-plugin-parity.md 草稿安全 |

## 订单、来源、成员操作与辅助控件

| 可见字段/控件 | 官方行为与接口字段 | 当前代码入口 | 合成样例 | 当前实现/实机状态 | 证据日期与精确文件 |
| --- | --- | --- | --- | --- | --- |
| 订单来源标题/描述/渠道 | `/tour/im/ex-area/b`、`imExtraInfo` 是带 Cookie 的 HTML；内联 `__INITIAL_STATE__` 提供咨询来源；不是已实测独立 SOA `getVBKImUserInfo` | M::sidePanel；A/display.ts::orderSummaryFromMessage | `title=SYNTHETIC SOURCE,channel=SYNTHETIC CHANNEL` | 主 UI 按 conv.order 显示；当前主要解析 CTL01 消息而非完整 SSR；不得将缺字段补造来源 | 10-30：E/55-controlled-sidebar-document.json、56-controlled-sidebar-ssr-state.json；../api/transports.md |
| 订单ID/产品/日期/金额/备注/数量/状态 | 来源卡 `action:"CTL01",ext.title/desc/dataInfoList`；Id 包含 `orderid,productName,usedate,platformName,orderamout`（原拼写）；SSR 还有权限/历史订单等 | M::sidePanel/messageRow；A/display.ts::orderSummaryFromMessage | `order_id=synthetic-order-a,total=SYNTHETIC AMOUNT` | UI 有逐字段展示并隐藏空值；当前 parser 的 quantity/status/contact 为空、备注未完整接入；未取得不能以默认值伪造 | 10-30：E/56-controlled-sidebar-ssr-state.json；10-31：A/display.ts::orderSummaryFromMessage/M::sidePanel |
| 用户资料/标签/浏览与来源轨迹 | SSR 的用户/来源/历史订单/浏览记录/权限域；静态 getVBKImUserInfo 映射含 hasUserPrivilege/hasSourceTracePrivilege 等 | M::sidePanel；A/display.ts::toDisplayConversation | `tag=SYNTHETIC TAG,privilege=unknown` | 当前 sidePanel 主要咨询来源及套餐，不是完整资料/轨迹面板；customer_tags 当前空数组不证明上游无标签 | 10-30：E/56-controlled-sidebar-ssr-state.json；2026-10-30-im-peripheral-apis.md §3（静态调用要与SSR分开） |
| 订单复制/详情/PC详情 | 复制本地；侧栏 PC/网页详情旧实测出现桌面引导；正式订单页独立查询取得详情 | M::sidePanel/copyText/goOrderDetail/openWebAdvanced | `order_id=synthetic-order-a` | 按钮存在；跳转官方网页不等于自制订单详情已支持全部字段；侧栏引导不记详情成功 | 10-30：../api/validation.md §失败边界4；10-31源码 |
| 订单精确搜索/IM联系 | `14361/searchorderlist` 用 ttdOrderId；`createimchat` 返回 URL 后校验并导航；不得拼造 gid | M::runOrderQuery/contactViaIm/orderView；A/order.ts::searchOrderExact/createImChat/validateImUrl | `ttdOrderId=synthetic-order-a` | 有订单模式与已验证结果标志；网页初次进入有旧证据，随后重载未恢复标题；新包待实机 | 10-30：E/59-controlled-order-exact-search.json、60-controlled-order-detail.json、61-controlled-order-createimchat.json、61-order-contact-ui-proof.json |
| 话术标签/搜索/插入 | `16037/getCustomerScripts {content}`；采证空 customerScripts，不足推导非空 text/id；管理接口不自动归本面板 | M::composer 的 phrases/notWired；A/peripheral.ts::getCustomerScripts | `content=SYNTHETIC SEARCH` | 主 UI 仍禁用快照；周边 RPC/宿主接线进行中，非空话术映射及新包待验，不能编造话术正文 | 10-30：P/m.ctrip.com-16037-getCustomerScripts-post.md；10-31：2026-10-31-desktop-plugin-parity.md 同日补充 |
| 推荐标签/推荐列表/发送卡片 | `queryRecommendProductList` 与 `sendCardMessageForOffline`；后者 extendJson 为 JSON字符串，卡片标题不能用列表标题直接替代 | M::composer recommend/notWired；A/send.ts::sendProductCard | `product_id=synthetic-product-a,title=SYNTHETIC CARD` | 官方旧受控查询/卡片发送有读回；当前推荐 chip 禁用，完整列表和发送UI未接/未实机 | 10-30：E/38-controlled-product-query.json、39-controlled-product-card.json、42-product-card-cleanup.json |
| 邀请候选/技能组展开 | `getInviteMemberListBySkillGroup {groupId:string,worksheetId:number,parentSkillGroupIds?:number[]}`；搜索用 searchInviteMemberListBySkillGroup+keywords；状态图标与“上班”标签不等价 | M::chatPane invite/notWired；A/peripheral.ts::getInviteMemberListBySkillGroup | `group=synthetic-room-a,keywords=SYNTHETIC AGENT` | 周边 RPC/宿主接线进行中；目标选择/在线状态/权限/会话代次待UI和实机，不自动选任意人 | 10-30：E/28-controlled-invite-search.json；2026-10-30-im-peripheral-apis.md §2.1 |
| 邀请商家客服 | `inviteVenAgent {venAgentUidList,serviceType,workSheetId:string}`；仅 accepted 后读成员，不乐观加人 | M::chatPane；A/peripheral.ts::inviteVenAgent | `venAgentUidList=[synthetic-agent-b]` | 官网10-30受控邀请有读回；本项目接线进行中、待新包实机 | 10-30：E/29-controlled-invite-jim.json；P/m.ctrip.com-16037-inviteVenAgent-post.md |
| 邀请携程客服/技能组 | `getInviteCtripData {serviceType,vendorId}`；提交 inviteCtrip 另需 groupId/sessionId/inviteServiceType/inviteSkillgroupCode | M::chatPane 未见独立入口；周边商家邀请不能代替 | `skillgroup=synthetic-ctrip-skillgroup` | 可用技能组/权限样本不完整；尚不能承诺邀请携程客服端到端，待调查 | 10-30：P/m.ctrip.com-16037-getInviteCtripData-post.md；2026-10-30-im-peripheral-apis.md §2 |
| 转交主客服 | `transferVenMaster {sessionId,groupId,targetVenAgentUid}`；旅游群另可能 updateGroupOwner，不能一概同命令 | M::chatPane transfer/notWired；A/peripheral.ts::transferVenMaster | `targetVenAgentUid=synthetic-agent-b` | 10-30另一获准会话有转交读回；周边接线进行中，新包待验。仅普通分支不宣称覆盖群主分支 | 10-30：E/26-transfer-master-to-jim.json、26-transfer-readback-proof.json；2026-10-30-im-peripheral-apis.md §2 |
| 移除指定成员 | `finishConversation` 带非空 venAgentUids；与结束动作同路径不同命令，空数组不能降级结束 | 当前 M 未见完整成员移除UI；A/peripheral.ts::finishConversation 为结束分支 | `venAgentUids=[synthetic-agent-b]` | 官网受控移除有读回；当前五组函数不等于移除功能已接，待实现/实机 | 10-30：E/30-controlled-remove-jim.json；2026-10-30-im-peripheral-apis.md §2 |
| 结束/重新进入 | finish 不带 venAgentUids，需 conversationKey/conversationType/sessionId/workSheetId；独立状态读回 status=4/inGroup=-1；重新进入 startChatB2C | M::chatPane end/notWired；A/peripheral.ts::finishConversation | `sessionId=synthetic-session-a` | 结束接线进行中、待新包实机；不代表关闭客户全部room；前置回复/转交/评价分支仍需核验 | 10-30：E/47-controlled-finish-confirmed.json、48-finish-server-readback.json、49-controlled-reopen-after-finish.json；P/m.ctrip.com-16037-startChatB2C-post.md |
| 官方入站译文/隐藏译文 | `11679/batchTranslateByMsgIds` 等上游翻译与 TSim 出站翻译不同；按实际消息ID/目标语言 | M::messageRow/composer hide-tr；A/translation.ts::translateMessages | `translation=SYNTHETIC TRANSLATION` | 有显示/隐藏控制，隐藏仅本地展示；所有消息译文来源/失败状态待实机，不把任意空译文当禁用 | 10-30：P/m.ctrip.com-11679-batchTranslateByMsgIds-post.md；10-31源码 |
| TSim 登录/翻译目标/预览/复制/替换/发送原文/重试 | TSim 独立 Bearer；`/agent/translate` body text/target_lang/source_lang/purpose/draft_request_id/composer_content_version；翻译成功不是发送成功 | M::translationBar/scheduleTranslation/runPreviewTranslation/translateAndSend；vbk/src-tauri/src/assistant/service.rs | `text=SYNTHETIC DRAFT,target_lang=en` | HTTP/钥匙串/刷新源码已接；助手最新 auth失败，本轮无在线翻译成功证据；替换与草稿版本需实机 | 10-30：../api/external-tsim.md §出站翻译；10-31：2026-10-31-environment-resurvey.md、2026-10-31-desktop-plugin-parity.md |
| 暂停/目标语言/撤销/快捷替换 | 原插件有 pause/resume、目标菜单、最近替换撤销、⌘⌥Enter；账号/会话/草稿变更使旧结果失效 | M::translationBar/composer；插件静态 runtime/page/outbound-panel.ts、runtime/native-composer.ts | `draft_version=7,target=en` | 部分控制已有；等价撤销/快捷键/持久兜底及提示未整体接齐，插件静态存在不算动态通过 | 10-31：2026-10-31-desktop-plugin-parity.md 插件行为表；原插件路径根 ../trip_vendor_im_companion |
| ICCID 套餐卡/刷新/折叠 | TSim perform→dataplan-list→detail/live-detail/cdr-more；query_id 与 card_dataplan_id 为字符串；权限和归属校验 | M::queryPackage/autoQueryPackage/packageCard；IPC::ASSIST_PACKAGE | `iccid=synthetic-iccid-a` | 主UI识别ICCID、60秒缓存、有刷新/折叠；在线归属/认证待验，不能替代订单查询浮层 | 10-30：../api/external-tsim.md §套餐速览；10-31：M::packageCard |
| 插件订单标识查询/官方查询浮层 | 插件识别会话/右侧订单或手输标识，在客服页打开 TSim 查询卡；换客户/失效关闭 | 原插件 runtime/page/operator-overlay.ts；M 中未找到等价 operator/embed 流程 | `order=synthetic-order-a` | 明确差距；当前 ICCID 卡与官方查询浮层不是同一能力，静态挂载/auth失败不算查询成功 | 10-31：2026-10-31-desktop-plugin-parity.md 订单查询行；2026-10-31-environment-resurvey.md |

## 生命周期与周边可见入口

| 可见字段/控件 | 官方行为与接口字段 | 当前代码入口 | 合成样例 | 当前实现/实机状态 | 证据日期与精确文件 |
| --- | --- | --- | --- | --- | --- |
| 断线条/立即重试/SDK重连 | 官方双WSS+增量补偿；`getRecentMessages {beginMsgTime,pageSize}`、列表 startTime；SDK已有HTTP兜底，不应宿主叠加盲重发 | M::loadNet/loadForActiveAccount/conversationList/chatPane；A/compensation.ts；A/boot.ts | `net=disconnected,attempt=synthetic-attempt-a` | 有离线提示/重载；10-30 SDK connect回调超时但后续socket=true并刷新恢复；睡眠/长期断网/所有端恢复未验 | 10-30：E/51-controlled-http-send-fallback.json、54-sdk-restored-by-official-page-reload.json；2026-10-30-web-im-transport-and-polling.md |
| 登录失效/重新登录/账号切换 | 官方登录页承载密码/风控，Cookie隔离；旧身份请求结果不能注入新账号 | M::startLogin/switchAccount/stillActive/applyAccountSnapshot | `account=synthetic-account-b,generation=8` | 有 expired重登录按钮与账号reset；多账号、异步译文、附件、提醒目标代次需新包实机，不能仅单元测试通过 | 10-30：../api/authentication.md；10-31：M::applyAccountSnapshot |
| 消息提醒/横幅/独立提醒窗 | 客户消息事实驱动本地等待/提醒；打开会话与上游已读、提醒轮次分开 | M::onBanner/locateConversation/onPlaySound；IPC::SHELL_OPEN_WINDOW | `gid=synthetic-room-a,count=1` | 产品保留强提醒结构；原生权限/声音/后台/跨账号定位待新包实机，非官方全部提醒行为复刻 | 10-30：2026-10-30-web-reminders.md；10-31：M::onBanner/openConversation |
| 通知分类/全部已读/打开 | `getIQConversations`/IQ 通知与客聊已读接口不同；不能调用客聊已读代替通知全部已读 | M::notificationsView/openNotice/markAllNotices；A/notice.ts | `category=synthetic-category-a,notice=synthetic-notice-a` | 有通知导航与命令；本文件未核验新包通知写入和全部角色权限 | 10-30：2026-10-30-web-reminders.md；P/m.ctrip.com-11679-getIQConversations-post.md；10-31源码 |
| 头像菜单/个人设置/桌面设置/检查更新/退出 | 工作状态与网络、TSim登录相互独立；头像设置新采集已由用户排除，不能无限扩范围 | M::meMenu/confirmLogout；设置单独 vbk/ui/apps/setting/main.ts | `mode=suspend,account=synthetic-account-a` | 入口存在；挂起/退出需区分是否下班及凭据保留，安装与更新未由本文件执行 | 10-30：../api/validation.md §目标范围；2026-10-30-agent-status-and-settings.md；10-31源码 |

## 验收与维护要求

1. 每次更新按“上游字段 → adapter → RPC/IPC → 宿主 → UI → 新包运行读回”标记，不能只把 disabled 改掉就记完成。实机列必须写包路径/版本或 hash、账号隔离范围、动作时间及读回证据，不能拿旧 app 的屏幕确认新源码。
2. 官方网页历史写证据以 `docs/api/validation.md` 记录的当时授权为限；本矩阵不授予新发送/邀请/转交/结束权限，也不扩展到其他客户。只有新的明确授权与实际操作读回才能增加“本轮已验”。
3. 凭据、真实客户正文/ID、签名资源URL不入矩阵。缺字段显示缺失/未授权/加载失败的真实状态；静态字段、旧网页动作、新源码、旧客户端和新包的结论保持分离。
4. 需优先核验：标题客户身份、room发送目标、历史未读伪清零、空tid/畸形ack三态、unknown不重发、附件文本占位、媒体真实发送、完整订单来源、周边动作读回和助手认证。列表中有入口不表示后端权限和上游语义已覆盖。

## 第 1 轮新包实机证据补充（2026-10-31，覆盖前文旧运行包状态）

完整时间线和产物身份见 [第 1 轮实机记录](2026-10-31-round1-runtime.md)。本节整理主代理实际工具结果；编制者未重新操作页面。`C/W` 是测试证据别名，不是实际消息正文；不在矩阵写真实客户、订单、room 或服务端消息 ID。

| 矩阵项目 | 本轮新证据 | 已证明的范围 | 仍未通过/需保留边界 |
| --- | --- | --- | --- |
| 包身份/登录 | 冻结 `dde2d0b + dirty`、清单 hash `0014cb6d…e6f60d`；新 app 二进制 `6c5da79b…3a811b`、DMG `79ef5d28…047ef9`，从 target/bundle 启动 PID33871；用户处理钥匙串后恢复 Meru 登录 | 本轮确实运行新包，区别于前文旧包快照；三项完整hash见关联记录，已只读复算 | 不是全部认证分支或多账号实机通过；后续源码 HEAD 不自动等于该包 |
| 门禁 | TypeScript 242、核心 Rust 300、宿主63，均0失败/0跳过；typecheck/bundle/diff/build通过 | 当前源码离线门禁及产物构建 | 不能替代真实双向、媒体、桌面/助手视觉 |
| 客户/订单/room | 发送前官方网页登录页与新包分别核对受控客户、关联订单；实际 iframe gid 与此前一致 | 本次受控目标已交叉核对 | 不公开真实标识，不外推其它客户/业务线 |
| 新包一次文本发送/unknown | 02:52:16 Enter 发送 C 一次，几乎同时网络不可用；02:53:02 AX 已见“结果未知（请核对，不自动重发）” | 超时最终进入 unknown；不再以较早“20秒仍发送中”推断永久 pending | 官方刷新尚未见 C，不能断言未发送或失败；禁止重发，继续只读核验 |
| 断线/立即重试 | 02:53 点击只读刷新后 native connected，C unknown仍保留 | 一次连接恢复与不确定状态保留观察；没有重发 C | 不代表全部重连/睡眠场景通过；“将排队”文案无实际离线发送队列依据，应后续修正 |
| 官方发送→新包可见 | 02:55:05 官方发 W，Meru/客户未读；02:55:09 native未见；02:55:38 加载更早后native可见同测试正文/Meru/时间/已确认 | 新包可读到官方发送消息，有显示级对应 | 无法区分实时迟到、历史或补偿；服务端 ID 尚未跨端核对，不计实时双向通过 |
| 历史/来源/滚动 | 加载更早后出现 Trip-App、正确订单、产品、使用日期、总额；原生截图仍留旧页位置 | 当前样本来源字段补全、一次滚动保留观察 | 不等于全部资料/来源权限/订单/滚动场景通过，前文“来源只有订单ID”仅早期快照 |
| 视频 | 当前原生历史视频显示 `Invalid` | 有实际可见播放问题 | 根因未定，媒体链路不通过，不能由图片/视频源码存在推定完成 |
| 官方桌面/助手 | 官方 AppleEvent -1712 timeout、助手 CUA timeoutReached/TSim auth失败仍未解 | 原有阻塞继续有效 | 不计本轮通过；挂载有效和TSim登录成功分别判断 |

原始 stanza（含 W 的 groupchat 与上游 ID）和操作采证仅在 `/tmp/vbk-goal-20261031/` 保管；原始文件不声明已安全脱敏，不提交正文、签名 URL 或凭据。正文“已实现”与本节实际可见证据保持分离，未验证项不得因本次一次样本而升级为全量通过。

### 本轮成员名单差异补充（02:56–02:58）

| 项目 | 新包原生观察（02:56） | 官方网页观察（02:58，ego-browser） | 当前结论 |
| --- | --- | --- | --- |
| 成员条数与身份 | 4条：公司 TSim Tech、Meru、受控客户、robot | 点击 `h3.group-title` 后“群聊人员3”：Meru、受控客户、游游机器人，无公司 | 存在真实可见名单差异，未完成对齐；不写真实 uid |
| 成员 status 与过滤 | 公司和 Meru 均 status=4；客户和 robot 均 status=1 | Meru 仍在官方可见名单，公司不在 | 不能按 status=4 盲目过滤；官方角色/实体种类/展示条件须继续只读核验，未证明完整规则 |
| 机器人名称 | 显示未翻译键 `key.im.servicechat.robotnickname` | 显示“游游机器人” | 有明确本地化差距，不能把原始键当真实昵称或记为已完成 |

本补充来自主代理本轮工具采证摘要；本文编制者未操作页面。它更新“成员读取有入口”的证据边界，不把读取成功升级为成员名单/权限语义全部正确。

独立评审补充：客户端发送与网页刷新两个 events 文件仅含 worker 的 `Target.attachedToTarget`，不含 native SDK 调用或发送帧。因此本轮只能确认操作者提交一次、UI最终unknown且未再次手动提交；结合已审代码没有应用层自动重投，不能声称传输层 exactly-once 已经实测。

## 第4轮增量证据（2026-10-31 05:23–05:38）

| 能力 | 本轮证据 | 状态 |
|---|---|---|
| 接口人员头像 | PID90073账号/列表/头部/消息/侧卡及3人成员头像实际显示；CSP修复3b0735a | 本轮原生通过，官方桌面/助手全面比对仍阻塞 |
| 钥匙串访问 | 第3、4轮启动连续自动恢复账号，无新提示 | 两次观察通过，非永久保证 |
| 文本C/W | C05:25:05、W05:30:21各一次，跨端服务端ID一致；W在诊断刷新后见 | 内容/ID读回通过，自然实时未通过 |
| 接收诊断 | SDK/补偿/host/UI固定schema计数可读；数据推进集中于前次RPC之后 | 隐藏调度疑点，不能断言唯一根因 |
| 视频只读播放 | 已有0.8秒视频原生点击后Pause/进度0.31；官方同资源前轮可播 | 当前只读播放通过，附件发送未实现 |
| 引用/历史/订单 | 独立评审新增引用泄文、local_id重复、订单摘要与错误侧栏P2 | 已列BLOCKED，修复后需新包 |

详见[第4轮运行证据](2026-10-31-round4-runtime.md)，原始图像/AX/接口留/tmp，不进Git。
