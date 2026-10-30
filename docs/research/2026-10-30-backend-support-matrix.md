# 功能与后端接口支持对照

2026-10-30。按当前范围（只删除左侧栏携程业务模块，本项目自有功能保留，见[范围决定](../decisions/2026-10-30-web-only-scope.md)），逐项说明每个功能有没有携程后端接口、证据强到什么程度。

结论先行：**当前范围内并非所有功能都有携程后端接口支持。** 读取类功能基本都有接口并观测过；写操作接口多数已定位但没有一次业务成功的样本；另有一批功能明确没有携程接口，要么是本地能力，要么依赖 TSim 等外部服务，要么需要本项目自建后端。

HTTP 200、`Ack=Success` 或 Socket 已连接都不等于业务成功；本文的“已观测”只表示看到过真实请求与响应，不等于验收通过。

## 一、携程接口已观测到

有真实请求与响应记录。路径相对 `/restapi/soa2`。

| 功能 | 接口 | 边界 | 证据 |
| --- | --- | --- | --- |
| 网页登录、身份读取 | `22160/pwdLogin`、`12405/getCurrentUserInfo`、`12405/authToken`、`13191/validateTicket` | 只在浏览器中验证；WebView2 内登录与 Profile 隔离未验证 | [网页 IM 调查](2026-10-30-web-im-observation.md)、[最终复核](evidence/web-im-final-verification-20261030.json) |
| 客服工作状态读取、切换 | `16037/getVenAgentByUid`、`16037/setVenAgentStatus` | 切换请求抓到过但无界面时间线；各状态对派单的影响未知 | [客服状态与设置](2026-10-30-agent-status-and-settings.md) |
| 会话列表、未读数 | `16037/getConversationList`、`16037/getConversationInfoByGidList` | “处理中/已完成”由会话状态在本地区分 | [桌面实机观测](../observations/2026-10-30-desktop-runtime.md) |
| 历史消息、补拉 | `16037/getMessageList`、`11679/getRecentMessages` | 翻页参数 `beginTime/endTime/direction` 只有静态证据；同时间戳与中断恢复未验证 | [网页 IM 调查](2026-10-30-web-im-observation.md) |
| 接收消息 | `wss://im3.ctrip.com/ws-xmpp/` 等 XMPP over WSS，SASL 认证、心跳 | 两条连接分工不明；重连、被踢、token 失效、睡眠恢复未测 | [IM 选型决策](../decisions/2026-10-30-im-transport.md) |
| 入站翻译（平台官方） | `11679/batchTranslateByMsgIds` | — | [桌面第二轮抓包](../observations/desktop-network-2026-10-30-round2.json) |
| 通知中心分类、内容、标读 | `11679/getIQConversations`、`11679/getIQMessages`、`11679/putAdviceofreadIQMessage` | 进入分类会触发官方标读；部分响应体未读取 | [网页提醒调查](2026-10-30-web-reminders.md) |
| 按订单号搜索已有会话 | `16037/searchConversation`、`15529/queryGroupInfo` | `queryGroupInfo` 本次返回 `gid:null`；只证明能找到已有会话 | [订单会话](2026-10-30-web-order-conversation.md) |
| 订单查询与 IM 联系 | `14361/searchorderlist`、`14361/createimchat` | 走通一次；无权限、多结果、无会话分支未验证；未证明幂等 | [订单会话](2026-10-30-web-order-conversation.md) |
| 排班读取 | `16037/getAgentWorkingSchedule` | 只有读取 | [最终复核](evidence/web-im-final-verification-20261030.json) |
| 产品推荐查询 | `15529/queryRecommendProductList` | 只有查询，发送卡片未验证 | [IM 边际接口](2026-10-30-im-peripheral-apis.md) |
| 邀请成员候选 | `16037/getInviteMemberListBySkillGroup` | 只有候选查询；邀请提交未完成 | [IM 边际接口](2026-10-30-im-peripheral-apis.md) |

## 二、携程接口只有静态证据

接口名与字段在客户端或网页代码中定位到，**从未真正调用成功**。这些都是写操作，需在专用测试会话中各执行一次，记录响应与刷新后的读回，才能确认可用。

| 功能 | 接口（静态） | 风险 |
| --- | --- | --- |
| 发送消息与确认 | `IMClient.sendMessageInSocket`，兜底 `11679/SendMessage.json`；`status.code` 0 或 3（重复视为成功） | 服务端去重键与作用域未知；超时不得自动重发 |
| 标为已读 | `11679/PutAdviceOfReadByMsgId.json` | — |
| 图片、文件上传 | `16037/uploadTokenCreate`、`12329/uploadImageV2`、`uploadFileV2`、`18837/ImUploadImage` | 实际使用哪条路由未确认 |
| 撤回 | `11679/RecallMessage.json` | — |
| 结束会话 | `finishConversation`（不带 `venAgentUids`） | 与移除成员共用接口，空列表必须拒绝 |
| 转移主客服 | `transferVenMaster`、`15529/updateGroupOwner` | 未执行 |
| 移除成员 | `finishConversation`（带 `venAgentUids`） | 同上 |
| 邀请成员提交 | `16037/inviteVenAgent`、`inviteCtrip` | 曾自发出现过请求，来源不明，未复现 |
| 结束后评价 | `16037/checkScoreStatus`、`getEvaluateInfo`、`submitScore` | 角色条件与先后顺序未验证 |
| 发送产品卡片 | `15529/sendCardMessageForOffline` | 无响应样本 |
| 快捷回复增删改与排序 | `16037/getCustomerScripts`、`add/update/deleteCustomerScript`、`getCategories` 等 | 组长权限只在前端判断 |
| 自动答复保存 | `16037/getWordsAboves`、`saveWordsAboves` | 自动答复由哪一端发出未知 |
| 排班保存 | `16037/modifyAgentWorkingSchedule` | — |
| 自动翻译开关 | `16037/modifyVendorAgentOption` | 源码中路径缺开头 `/`，需核实完整 URL |
| 下班后上线的实名验证 | `20016/checkVBKRealNameAuthStatus`、`startVBKRealNameAuthTask`、`getVbkRealNameTask` | 仅特定角色触发 |
| 侧栏客户信息 | `15529/getVBKImUserInfo` | 从未抓到响应 |
| 侧栏订单摘要 | `14735/getOrderDetailsForVbk` | 有请求记录，但从未返回有效 `orderInfoDto` |
| 会话星标（网页另有） | `16037/setWorkSheetStar` | 当前原型按官方网页设计不提供星标入口 |

## 三、没有携程接口

| 功能 | 情况 | 处理 |
| --- | --- | --- |
| 会话颜色标记 | 官方网页右键有此操作，但仓库**没有任何抓包**；颜色选项、存储位置与接口未知 | 实现前在官方网页标记一次，记录请求、响应与读回 |
| 会话置顶 | 网页版用本地会话存储的 `isTop`，没有服务端接口 | 本地实现，不承诺跨设备同步 |
| 发送结果未知时的“核对状态” | 没有按 localId 查询的接口 | 只能通过历史消息间接对账；对账前不重发 |
| 回复超时计时、L0–L4 分级提醒、稍后提醒 | 携程没有“首条未回复”或考核时钟接口 | 用已有消息事实本地计算，见[独立强提醒](../dev/03-strong-alert.md) |
| 出站翻译、套餐速览、订单查询面板 | 依赖 **TSim** 外部服务，不是携程接口；仅有插件代码中的静态证据，未抓到 TSim 流量 | 见[商家助手](../dev/09-assistant.md)；需补 TSim 接口实测 |
| 多账号、托盘与任务栏、截图、中文纠错、诊断包 | 本地能力，不需要携程接口 | 平台能力需原型验证 |
| OCR | 本地能力；Windows 系统 OCR 需要应用包身份，普通安装没有 | 引擎与安装方式需原型决定 |
| 客户端更新 | 没有更新服务器 | 需本项目自建受控发布源与签名策略 |
| ticket 续期 | 没有显式续期接口 | 被动刷新：读回 Profile 中变化的票据后再校验 |
| 云端崩溃上报、埋点 | 旧接收端未获授权 | 默认关闭，只做本地诊断 |

## 四、要把“全部有后端支持”变成事实

1. 用专用测试账号与测试会话，把第二节的写操作各做一次，记录请求、业务结果与刷新后的读回；失败、无权限、超时各留一个样本。
2. 在官方网页标记一次会话颜色并抓包，确认第三节第一项。
3. 实测 TSim 的登录、翻译、套餐查询接口，记录鉴权方式与失败返回。
4. 决定更新发布源的归属与签名方式。

补充背景见[接口复查](2026-10-30-missing-apis.md)。
