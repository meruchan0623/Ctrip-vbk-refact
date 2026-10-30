# 浏览器接口实测与契约修正

2026-10-30，Asia/Singapore，约 18:02–18:17。使用 `ego-browser` 同一任务空间 5，在已登录的官方网页 `https://vbooking.ctrip.com/vbk/im/main` 实际操作。网页资源版本为 `vbkIm/1793340371237`，主页面包 `main-3007b16f6fe839b6.js`；此前调查的网页包版本已有变化。

仓库仍处于调查与设计阶段，**本报告验证的是官方网页接口，不代表本项目新客户端已实现或通过验收**。用户在本轮明确授权对 `_tihk******doml43` 受控会话随意操作；此后的发送、撤回、邀请、移除、结束和转移均限定该会话。授权前只测试可恢复的颜色标记及个人设置。

## 1. 结果总表

“通过”仅指表中这一场景完成请求、业务结果及页面/服务端读回；不包含其他角色、业务线、超时、幂等或跨设备验收。路径默认位于 `/restapi/soa2/`，以证据中的完整 host、大小写和后缀为准。

| 验证项 | 本次结果 | 证据阶段/文件 |
| --- | --- | --- |
| 会话颜色标记 | 通过：写入、刷新保留、清除；五色枚举逐项操作。实际接口是 `16037/setWorkSheetStar` | `mark-orange`、`reload-mark-orange`、`controlled-color-*`；[颜色映射](evidence/browser-color-mapping-20261030.json) |
| 自动翻译开关 | 通过：开启 → 关闭 → 重新打开设置读回关闭 → 恢复开启；最后服务端读回 `Y` | `auto-translation-*`、[最终读回](evidence/browser-readonly-replay-20261030.json) |
| 个人快捷回复 | 通过：临时分类新增、话术新增/编辑/删除、空分类删除；最后只剩原 `Default (8条)` | `quick-reply-*`、`final-personal-settings-readback` |
| 工作时间/时区读取 | 通过读取：`getAgentWorkingSchedule`、`getTimeZoneList` 返回 `bizResponseStatus.resultCode=SUCCESS`，页面显示排班 | `settings-working-schedule`；未保存排班 |
| 自动答复读取 | 当前账号未返回正文的成功响应：`getWordsAboves` 返回 SUCCESS，未返回欢迎/离开/非工作时间正文；未保存 | `settings-auto-reply-read` |
| 会话搜索与重新开启 | 通过：搜到指定会话、打开历史、开始聊天；结束后发送测试消息触发 `startChatB2C` 并重新开启 | `search-controlled-conversation`、`controlled-reopen-by-send` |
| 文本发送 | 通过本次 WSS 正常路径：发出/返回帧存在相同关联 ID，页面出现测试文本及“已读”；随后撤回 | `controlled-send-text`；没有验证 HTTP 兜底 |
| 文本/图片/产品卡片撤回 | 通过：实际 POST `11679/recallMessage`，返回 `status.code="0"`；原内容替换为撤回提示，刷新后仍为撤回 | `controlled-recall-*`、`controlled-reopen-sidebar-and-history` |
| 图片上传及发送 | 通过合成 PNG 样本：取 token → Nephele 二进制上传 → WSS 发图 → 页面加载为 160×80；随后撤回 | `controlled-image-*`；[上传响应](evidence/browser-upload-contract-20261030.json) |
| 产品推荐卡片 | 通过：查询、发送、返回 `data.localId/msgId`、聊天中出现卡片并显示已读、撤回 | `controlled-product-recommendation-query`、`controlled-send-product-card` |
| 邀请供应商客服 | 通过：选中绿色 `ico_free` 候选、提交后显示邀请成功，成员 3→4，`checkMemberStatus` 读回 | `controlled-invite-submit`、`controlled-invite-member-readback` |
| 移除指定成员 | 通过：明确选中刚邀请的一个成员，`finishConversation` 带非空 `venAgentUids`，SUCCESS，成员 4→3 | `controlled-remove-member-confirm` |
| 结束会话 | 通过：确认框后 `finishConversation` 不带 `venAgentUids`，SUCCESS；按同一 gid 读回 `status=4/inGroup=-1` | `controlled-finish-confirm`、`readonly-replay-finish-and-order` |
| 转移主客服 | **部分验证**：真实点击后成员次序/管理入口变化，最终读回受邀客服 `roles=[3,4,4]`、当前客服 `[0,3,4]`；该动作请求/响应没有保存在本轮采集窗口，不能标成 HTTP 契约完整通过 | `controlled-transfer-member-readback`、[角色读回](evidence/browser-readonly-replay-20261030.json) |
| 历史分页 | 通过小样本只读 replay：2条基础页、prev 2条、next 1条；13位时间值，本样本边界排除 | `readonly-replay-history-and-final-roles`；同时间戳满页未测 |
| 14735 订单摘要 | **业务拒绝**：HTTP 200、Ack Success，但 `resultCode=3 / resultMsg="No permission"`，没有 `orderInfoDto` | `controlled-reopen-sidebar-and-history`、`readonly-replay-finish-and-order` |
| 侧栏客户资料/跳转 | 页面及服务端渲染数据已确认；未捕获 `getVBKImUserInfo/getImPlusModuleJump` 的浏览器 SOA 请求，不能升级为这两个 API 的成功样本 | [侧栏 SSR 结构](evidence/browser-sidebar-ssr-20261030.json) |

本轮保留的脱敏请求与响应结构及 WSS 关联摘要见 [主证据](evidence/browser-api-validation-20261030.json)。其中没有完整 Cookie、Authorization、head 票据、客户正文、订单号或账号 UID；字符串 `"string"`/`"number"` 表示类型占位，不是实际返回值。少数 `bodyUnavailable` 或缺少 `httpStatus` 的记录仅代表采集窗口不完整，不计作接口失败或成功。

## 2. 必须修正的接口理解

### 2.1 颜色标记与 setWorkSheetStar 是同一能力

实际请求为 **POST `https://m.ctrip.com/restapi/soa2/16037/setWorkSheetStar`**：

```text
head: 当前网页请求上下文
sessionId: 当前会话 sessionId
groupId: 当前群号
worksheetId: 当前工单号（此接口小写 s）
action: 0 | 1 | 2 | 3 | 4 | 5
```

| action | 官方网页效果 |
| --- | --- |
| 0 | 不标记/清除 |
| 1 | 橙 orange |
| 2 | 绿 green |
| 3 | 蓝 blue |
| 4 | 紫 purple |
| 5 | 粉 pink |

响应为 `ResponseStatus.Ack=Success`、`bizResponseStatus.resultCode=SUCCESS`。橙色写入后整页刷新仍存在，已恢复无标记；其余颜色在受控会话逐项验证并清除。蓝色首次 450ms 观察仍是上一次的绿色，不能把点击后的即时 DOM 当读回；补验等待 `.mark-star.blue` 出现并取得成功响应后才确认。

因此，不能再将“星标接口已找到”和“颜色标记没有接口”分列成两种独立能力。本项目不新增独立星标页，但颜色标记必须使用这个已验证的服务端接口；不再采用红/橙/黄/绿/蓝/紫六色假设。仅同浏览器刷新持久性已确认，跨设备实时同步仍未验证。

### 2.2 自动翻译

实际完整地址为 **POST `https://m.ctrip.com/restapi/soa2/16037/modifyVendorAgentOption`**，没有源码相对路径歧义。body 为 `{head, automaticTranslation:"N"/"Y"}`。两次保存均返回 Ack Success、`bizResponseStatus.resultCode=SUCCESS`、`success=true`。

关闭后重新打开个人设置会重新请求 `getVenAgentByUid`，开关读回关闭；恢复开启后，最终 `venAgentOption.agentOption.venOptionList` 中 `automatic_translation` 为 `Y`。这里只验证平台入站翻译开关，与 TSim 出站翻译服务无关。

### 2.3 个人快捷回复的字段差异

所有接口实际位于 `https://m.ctrip.com/restapi/soa2/16037/`。

| 动作 | 实际业务字段（另加 head） | 业务读回 |
| --- | --- | --- |
| 分类读取 `getCategories` | `typeList, categoryType:"CUSTOMSCRIPT", status` | `categories[].customerScripts` 已含话术，不要求每次展开分类另发 `getCustomerScripts` |
| 新增分类 `createRootCategory` | `name, type, status, ownerType:"VAGENT", vSkillGroupIds:[]` | 返回 `category`；刷新分类后出现临时分类 |
| 新增话术 `addCustomerScript` | `content, ownerType:3, categoryCode` | 返回 `id, customerScript`；分类计数0→1，展开后可见正文 |
| 编辑话术 `updateCustomerScript` | `content, id` | 后续 `getCategories` 及页面正文变成编辑后的内容 |
| 删除话术 `deleteCustomerScript` | `id` | 分类计数1→0 |
| 删除分类 `deleteCategory` | `id, ownerType:3` | 后续 `getCategories` 中分类消失 |

不要把所有接口的 `ownerType` 一律设为同一字符串：创建分类本次用 `"VAGENT"`，新增话术和删除分类本次用数字 `3`。未操作团队话术、分类改名、移动或排序；这些仍待验证。

### 2.4 图片走 Nephele 上传，不是候选 SOA 图片接口

1. 网页选择合成 PNG 后，POST `m.ctrip.com/restapi/soa2/16037/uploadTokenCreate`，body `{head,channel,type}`，返回 `token`。
2. POST **`https://nephele.ctrip.com/image/v2/api/upload`**。请求是 `File` 二进制，269字节、`image/png`，不是 JSON/FormData。已看到头名称 `Authorization`、`Content-MD5`、`Content-Type`；值未保存。
3. 上传返回 `{Code:2000,Content:{url,file_name},Message}`；随后网页通过消息通道发送，聊天图片实际加载为160×80并显示已读。
4. 通过右键撤回，服务端 `recallMessage` 成功，图片从聊天替换为撤回提示。

CDP 对上传响应提示 `Request content was evicted from inspector cache`，故补用本页 XHR `loadend` 只读观察获得返回结构，原 `open/send` 已恢复。未验证如何独立计算 Content-MD5、token 有效期/上传签名算法，也未重放上传；PDF/Office/视频路径仍不在本次图片结论内。

### 2.5 撤回、产品卡片与成员操作

- 撤回实际路径是小写无后缀的 **`11679/recallMessage`**，body `{head,messageId,partnerId}`；不能只按旧静态 `RecallMessage.json` 字符串拼地址。
- 产品卡片 POST `online.ctrip.com/restapi/soa2/15529/sendCardMessageForOffline`，本次 `inSession=true`，另有 `senderRole,platformId,bizType,templateId,groupIdentity,uid,extendJson`；响应 `data` 有 `localId,msgId`，`threadId=null`。侧栏为 `zh-HK`，发送出的卡片显示繁体名称及 HKD，不能直接拿客服查询列表的简体名称替代客户版本。尚未按返回 msgId 与历史逐字段对账，也未测未知结果重试。
- 邀请候选 `getInviteMemberListBySkillGroup` body `{head,groupId,worksheetId}`，展开分组另加 `parentSkillGroupIds`。候选“上班”文字不代表在线：本次选择的是图标类 `ico_free` 的候选。
- 提交邀请 `inviteVenAgent` 为 `{head,venAgentUidList,serviceType,workSheetId}`，注意 `workSheetId` 大小写；返回 `sessionId,workSheetId`，随后 `13500/checkMemberStatus` 读回人数与成员。
- 指定移除/结束共用 **`16037/finishConversation`**：公共字段 `{head,conversationKey,conversationType,sessionId,workSheetId}`；移除额外带非空 `venAgentUids`。本次没有发送空数组试错，也不允许适配器把空移除降为结束。
- 本次结束只出现“确定结束会话吗”确认框，没有观察到 `checkScoreStatus/getEvaluateInfo/submitScore`；不能据此宣称评价接口已通过，或所有会话都不需要评价。

## 3. 失败样本与读取边界

### 订单详情权限

实际 POST `https://m.ctrip.com/restapi/soa2/14735/getOrderDetailsForVbk`，请求为 `{head,OrderDetailsRequestDTO}`。受控会话具有关联订单、侧栏也能展示订单咨询来源，但响应仍为 `resultCode:3,resultMsg:"No permission"`，没有 `orderInfoDto`。随后使用同一浏览器、同一已观测请求体只读 replay，再次得到相同结果。

这证明“客户发送过订单卡片”“来源轨迹含订单信息”和“该账号具备14735订单详情权限”不能互相替代。实现须显示无权限/不可用，并保留官方订单联系入口；不能把这类响应当成“客户没有订单”。本次没有扩大到其他订单或尝试绕过权限。

同会话 `16037/checkSessionStatus` 也观察到 Ack Success 但 `bizResponseStatus.resultCode=UNKNOWN`，不应由 Ack 判定会话业务状态有效。

### 侧栏已由服务端预渲染

实际 iframe `/tour/im/ex-area/b` 的 HTML 内嵌 `window.__INITIAL_STATE__`，包含 `vbkUserInfo` 和 `moduleJumpInfo`。刷新 iframe、切换产品推荐/用户信息时没有抓到 `getVBKImUserInfo/getImPlusModuleJump` 的客户端请求；因此页面有资料但 Network 中没有这两个 SOA 请求并不矛盾。

本样本结构中 `hasUserPrivilege=false`、`hasHistoryOrderPrivilege=false`、`hasBrowserHistoryPrivilege=false`；`hasSourceTracePrivilege=true`、`hasProductRecommendPrivilege=true`；`moduleJumpInfo.hasOrderPrivilege/hasModuleJumpPrivilege=true`。页面能显示咨询来源与订单列表链接，但不能推断没有权限的数据存在或接口直接调用已成功。

### 历史分页与已读

通过已观测 `getMessageList` 模板，先只将 `pageSize` 改为2，再使用返回消息的 `createTime` 构造 `endTime+direction:prev` / `beginTime+direction:next`。三个请求均 HTTP200/Ack Success，分别返回2、2、1条；基础页为时间升序，时间为13位，样本的前向/后向均未包含传入边界时刻。末页 `isDone=true`，`lastMessageTime` 为 number。

这是单会话的小样本，不足以承诺同时间戳满页无丢失、所有业务线均为严格排除边界或断线恢复正确；不能自行改造成 `after=msgId` 游标。消息“已读”有页面/WSS现象，但本轮未捕获 `PutAdviceOfReadByMsgId.json` 的 HTTP 请求，不能把它列为 REST 已读契约通过。

## 4. 登录态、重放与证据保存

复用 ego-browser 继承的登录态，未读取密码。正常网页请求携带当前 `head` 上下文，上传另有授权头；只记录字段/头名称及脱敏类型，不把票据写入文档或请求模板。没有验证最小 Cookie 集、显式续期、过期或重新登录。

只读 replay 使用本轮 Network 实际请求体在页面内存中的副本，通过页面 `fetch(...,{credentials:"include"})` 发出；不导出登录态，不猜路径，不重放任何写接口。已保存[最小 replay 脚本](evidence/browser-readonly-replay-20261030.sh)，执行时先打印无凭据的 dry-run，再发出读取并检查业务结果；[执行结果](evidence/browser-replay-check-20261030.json)确认权限拒绝样本、翻译Y及原分类八条。脚本绑定本轮任务空间；内存模板不存在时会明确失败，重新采集后才能复用，不能用本轮票据长期运行。

证据文件中请求体/响应体均为脱敏结构，**不是可直接 replay 的原始 HAR**；WSS 仅保留标签、长度和关联ID摘要。未将包含真实客户信息的截图加入仓库。网络采集还包含自然轮询，不能把每条请求都归因于最近一次点击。没有进行故障注入、批量写入或接口工具化。

## 5. 清理、最终状态与剩余项

- 测试文本2条、PNG图片3条、产品卡片1张均已通过网页撤回；服务端会保留撤回/进出会话等系统记录，不能把撤回称为删除所有痕迹。
- 颜色标记已清除；自动翻译已恢复 `Y`；临时分类及话术已删除，最终读取只有原 `Default (8条)`。未由本任务切换客服工作状态、修改排班或自动答复。
- 邀请/移除验证后，为验证转移又邀请一次同一客服。**本任务18:16最后读回时，受控会话处于进行中，主客服为受邀的 Sara，Meru 为次客服**；角色和会话 `status=2` 见只读 replay。没有冒用另一客服身份转回；该转移的 HTTP 请求/响应尚需补采。
- 仍待：转移完整网络契约/旅游群主分支、邀请携程侧客服、评价、团队话术与排序、排班/自动答复保存、文件/视频上传、HTTP发送兜底、未读/已读REST、超时/幂等/断线补偿、跨设备同步及14735有效权限样本。
- TSim 登录/翻译/套餐查询及本项目更新服务没有本轮官方网页实际请求模板，本次未测；独立客户端、强提醒窗口、Windows WebView2 等也未验收。

当前支持状态以[后端接口支持对照](2026-10-30-backend-support-matrix.md)和本报告为准；旧调查中的“未执行”是当时状态，不能继续覆盖本次新增证据。
