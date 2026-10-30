# 接口采集与实际读回

2026-10-30，Asia/Singapore。所有浏览器操作通过 ego-browser 的同一任务空间 6 完成；本轮已结束该浏览器采集空间。这里记录接口事实，不代表新客户端功能、Windows 宿主或全角色验收。

## 目标与最新范围

- 发送、图片、PDF、视频、推荐卡片、引用、已读、颜色、邀请、移除、结束与重新进入，限定用户指定的 `_tihk******doml43`。
- 用户另行允许用其他会话测试主客服转移。其他会话只作转移候选核对与目标操作，未向其发送测试正文或媒体。实际转移目标会话为 `_tius******ctukj0`，目标客服 Jim；未邀请 Sara。
- 用户最终要求直接落文档，头像里的设置不再继续。本轮仅打开过头像设置的只读页面，没有保存排班、自动答复或翻译开关；这些读取旁证不作为本轮未完成项。
- 携程登录直接复用用户指定的官方登录页，不重写密码、验证码、风险验证和内部登录 API。

页面初始化、历史预读、SDK 协议应答、自动翻译和埋点照常发生。stage 是收集窗口，不保证窗口内每一条后台请求都由当次点击产生；主动作需对照请求参数、目标校验及读回，不能把全部流量当成实验动作。

## 已执行的主链路

| 链路 | 实际结果 | 可核对证据 |
| --- | --- | --- |
| 文本 Socket 发送 | XML send 与 send_result 的 localid 关联一致，返回 error=0；页面出现消息后撤回 | [35](evidence/2026-10-30/35-controlled-ws-text-ack.json)、[36](evidence/2026-10-30/36-text-message-cleanup.json) |
| 引用消息 | citemsgid 在 XML 属性中，发送与回执一致；引用文本和被引用测试卡片已撤回 | [40](evidence/2026-10-30/40-controlled-quote-send.json)、[41](evidence/2026-10-30/41-quote-message-cleanup.json)、[42](evidence/2026-10-30/42-product-card-cleanup.json) |
| HTTP 发送兜底 | 仅断开本页 SDK Socket 后经官方编辑器发送，实际出现 SendMessage.json；页面确认后撤回 | [51](evidence/2026-10-30/51-controlled-http-send-fallback.json)、[53](evidence/2026-10-30/53-http-fallback-message-cleanup.json) |
| SDK 恢复 | connect 回调十秒内未返回；随后 socket 状态为 true，再刷新官方页确认连接恢复。不能把回调超时说成已证明连接失败 | [54](evidence/2026-10-30/54-sdk-restored-by-official-page-reload.json)；终端操作记录保留回调超时 |
| 图片上传 | uploadTokenCreate → 原始 File 上传；Nephele 包装内 token 与该次返回精确匹配，MD5 hex 与 fixture 一致；图片已撤回 | [44 请求](evidence/2026-10-30/44-image-body-and-auth-confirmed.json)、[44 值来源](evidence/2026-10-30/44-image-auth-value-proof.json)、[45](evidence/2026-10-30/45-image-auth-fixture-cleanup.json) |
| PDF 上传 | 独立 file/v1/api/upload，原 File body；实际请求未带图片的 Authorization/Content-MD5，响应为 file_name/url；两条 PDF 测试消息已撤回 | [33](evidence/2026-10-30/33-controlled-file-full-contract.json)、[32](evidence/2026-10-30/32-controlled-file-recall.json)、[34](evidence/2026-10-30/34-file-message-cleanup.json) |
| 视频上传 | uploadTokenCreate(type=video) → video/v3/api/upload → video/v1/api/proc；原 File、独立授权头及提帧 JSON 均已保留；服务端 Code=2000 后消息得到 send_result | [68](evidence/2026-10-30/68-controlled-video-upload.json) |
| 产品推荐与卡片 | 推荐查询成功；sendCardMessageForOffline 的 extendJson 为 JSON 字符串，实际客户版本标题与客服列表标题不同；卡片已撤回 | [38](evidence/2026-10-30/38-controlled-product-query.json)、[39](evidence/2026-10-30/39-controlled-product-card.json)、[42](evidence/2026-10-30/42-product-card-cleanup.json) |
| 受控邀请/移除 | 搜索并邀请 Jim，成员数变为四人；指定 venAgentUids 移除返回 SUCCESS，后续受控会话为三人 | [28](evidence/2026-10-30/28-controlled-invite-search.json)、[29](evidence/2026-10-30/29-controlled-invite-jim.json)、[30](evidence/2026-10-30/30-controlled-remove-jim.json)、[55](evidence/2026-10-30/55-controlled-sidebar-document.json) |
| 其他会话主客服转移 | 邀请 Jim 后从 Meru 转移给 Jim；返回 SUCCESS，成员读回 targetRoles=[3,4,4]，原主客服变为 [0,3,4]，UI 主客服为 Jim | [25](evidence/2026-10-30/25-invite-jim-for-transfer.json)、[26 请求](evidence/2026-10-30/26-transfer-master-to-jim.json)、[26 读回](evidence/2026-10-30/26-transfer-readback-proof.json) |
| 受控结束/重新进入 | 不带 venAgentUids 的 finishConversation 返回 SUCCESS；独立读取 status=4、inGroup=-1；随后 startChatB2C 成功并恢复三人会话 | [47](evidence/2026-10-30/47-controlled-finish-confirmed.json)、[48](evidence/2026-10-30/48-finish-server-readback.json)、[49](evidence/2026-10-30/49-controlled-reopen-after-finish.json) |
| 历史分页 | pageSize=2，基础/前翻/后翻分别 2/2/1 条；本样本未包含边界本身；末页 isDone=true | [70 请求](evidence/2026-10-30/70-controlled-history-pagination-replay.json)、[70 摘要](evidence/2026-10-30/70-history-pagination-proof.json) |
| 受控已读 | 当前历史识别出指定客户的消息，再调用官方 SDK 发送对应群的已读；Ack Success | [71 请求](evidence/2026-10-30/71-controlled-read-receipt.json)、[71 摘要](evidence/2026-10-30/71-read-receipt-proof.json) |
| 颜色标记 | 橙色写入后独立服务端读回 star=1；恢复无标记后读回 star=0 | [72](evidence/2026-10-30/72-controlled-color-orange.json)、[73](evidence/2026-10-30/73-color-orange-server-readback.json)、[74](evidence/2026-10-30/74-controlled-color-restored.json)、[75](evidence/2026-10-30/75-color-transition-proof.json) |
| 订单联系客户 | 正式订单页完整订单号查询唯一结果；详情页的 createimchat 返回 URL，首次打开的 IM 标题匹配受控客户 | [59](evidence/2026-10-30/59-controlled-order-exact-search.json)、[60](evidence/2026-10-30/60-controlled-order-detail.json)、[61 请求](evidence/2026-10-30/61-controlled-order-createimchat.json)、[61 初次读回](evidence/2026-10-30/61-order-contact-ui-proof.json) |

## 失败、不完整样本及清理边界

1. 同一成员查询带 Cookie 成功，省略 Cookie 后仍 HTTP 200，但 Ack Failure / AccountsMobileRequestFilterException。完整错误枚举见 [43](evidence/2026-10-30/43-auth-failure-code-preserved.json)；[12](evidence/2026-10-30/12-auth-readonly-replay.json)保留最初对照。目录去重保留成功、失败和 Header 差异。
2. 把 getConversationList.needTodoList 从观测数字 1 改为 true 时，HTTP 200 但 Ack Failure；按数字 1 原样重放成功。不能凭“含义一样”改参数类型。[16](evidence/2026-10-30/16-full-list-readonly-replay.json)、[17](evidence/2026-10-30/17-full-list-exact-replay.json)。
3. 部分二进制上传的 CDP body/response 被 inspector cache 清除。相同动作的 XHR loadend 记录补足 File 元数据与响应，来源在目录中明确标注；未把缺失体补写成想象的 JSON。
4. 侧栏 PC/网页详情本次出现桌面版引导；正式订单详情单独从已知订单页面进入，不能将前者算成成功打开订单详情。
5. 订单“IM 联系”首次导航成功，但随后重新加载旧版入口时，十五秒内没有恢复指定会话标题；未把该重载场景验收通过，未查明原因。[61 初次与重载边界](evidence/2026-10-30/61-order-contact-ui-proof.json)。
6. **有一条约一秒的纯色合成视频没有及时撤回，仍留在指定受控会话。** 检查时官网菜单仅有引用/转发，已超过源码中的两分钟撤回窗口；没有绕过菜单强行提交撤回 API。[菜单事实](evidence/2026-10-30/69-video-recall-menu-unavailable.json)。其余本轮测试正文、图片、PDF、卡片均已提交撤回并观察到撤回结果。
7. 邀请/转移前后成员集合发生过变化；无法隔离是否由其他坐席活动、工作单变化或进入会话引起。不归因单一原因；每次开始聊天后重新读取 session、worksheet 和成员，不复用旧快照。

## 最终状态与证据保护

受控会话已在结束测试后重新进入，颜色恢复无标记；本轮邀请到受控会话的 Jim 已移除。另一转移测试会话主客服保持 Jim。未手工切换工作状态，也未保存头像内设置。

请求的完整字段名、数组、JSON 字符串及原始类型保留，凭据和业务身份用占位符替换。动态字典键和非协议 head 扩展也脱敏；原始临时事件文件已删除。独立审查发现的动态键/扩展字段泄露、目录去重丢失败分支三项已修复；最终结构与脱敏检查见[检查记录](review.md)。
