# 功能与后端接口支持对照

2026-10-30，更新至本轮浏览器实测。当前范围见[范围决定](../decisions/2026-10-30-web-only-scope.md)。仓库仍为调查与设计阶段，以下是官方网页接口证据，不是本项目客户端功能验收。

**目前已有一批写操作完成受控样本验证，但仍不能声称所有功能都有已验证的携程后端支持。** HTTP200/Ack Success 不能代替业务结果；例如14735订单摘要本轮明确返回 No permission。详细动作、字段、失败样本与清理见[浏览器实测报告](2026-10-30-browser-api-validation.md)。路径默认相对 `/restapi/soa2/`。

## 一、本轮完成单场景验证

这些项目有真实页面动作、业务结果及页面或服务端读回。只代表该账号、网页版本和样本；无权限/超时/幂等/跨设备等未测分支不自动通过。

| 功能 | 实际接口/通道 | 已验证与边界 |
| --- | --- | --- |
| 会话颜色标记/清除 | `16037/setWorkSheetStar` | action0清除，1橙/2绿/3蓝/4紫/5粉；写入、橙色刷新保留、清除完成。**这是颜色接口，不是另一个独立星标功能**；跨设备未测 |
| 自动翻译开关 | `m.ctrip.com/restapi/soa2/16037/modifyVendorAgentOption` | `automaticTranslation:N/Y`；关闭后重新打开设置读回，恢复Y并服务端确认；完整URL已核实 |
| 个人快捷回复 | `16037/getCategories/createRootCategory/addCustomerScript/updateCustomerScript/deleteCustomerScript/deleteCategory` | 临时分类及话术新增、编辑、删除，最后原Default八条恢复；分类改名、移动、排序及团队权限未测 |
| 文本发送 | 网页 SDK 的 WSS 消息通道 | 发出/返回关联ID一致，页面显示文本及已读，后续撤回；未验证 `11679/SendMessage.json` 兜底、超时和去重 |
| 撤回 | **`11679/recallMessage`** | 本次小写无.json后缀，字段 `head,messageId,partnerId`；文本/图片/卡片返回 `status.code="0"` 并显示撤回，刷新后保持 |
| 图片上传与发送 | `16037/uploadTokenCreate` → **`nephele.ctrip.com/image/v2/api/upload`** → WSS | PNG二进制上传返回Code2000，聊天实际加载160×80并已读，随后撤回；文件/视频及签名独立构造未测 |
| 产品卡片 | `15529/queryRecommendProductList/sendCardMessageForOffline` | 查询、inSession=true发送、响应localId/msgId、聊天展示繁体HKD卡片、撤回完成；未做msgId逐字段对账及超时恢复 |
| 邀请供应商客服 | `16037/getInviteMemberListBySkillGroup/inviteVenAgent`、`13500/checkMemberStatus` | 选择绿色在线候选、成功邀请、成员3→4读回；携程侧邀请和其他角色未测 |
| 移除指定成员 | `16037/finishConversation` **带非空venAgentUids** | 移除所选一个测试成员，SUCCESS，成员4→3；未用空列表试错，适配器仍须禁止空移除 |
| 结束与重新开启 | `16037/finishConversation` **不带venAgentUids**、`getLatestConversationByGid/startChatB2C` | 结束SUCCESS，读回status4/inGroup-1；再次发送触发startChatB2C并重新开启；评价未触发 |
| 历史小样本分页 | `16037/getMessageList` | 真实beginTime/endTime/direction，2条基础页、prev2条、next1条；样本为13位时间、排除边界；同时间戳满页、断线恢复未测 |

以上证据：[请求与响应结构](evidence/browser-api-validation-20261030.json)、[颜色映射](evidence/browser-color-mapping-20261030.json)、[上传响应](evidence/browser-upload-contract-20261030.json)、[只读replay](evidence/browser-readonly-replay-20261030.json)、[最终核对](evidence/browser-replay-check-20261030.json)。

## 二、已观测，但仍有重要缺口

| 功能 | 接口/来源 | 当前证据及限制 |
| --- | --- | --- |
| 网页登录、身份 | `22160/pwdLogin`、`12405/getCurrentUserInfo/authToken`、`13191/validateTicket` | 历史已走通登录，本轮复用现有登录态；WebView2内登录、Profile隔离未测，见[网页调查](2026-10-30-web-im-observation.md) |
| 工作状态读取、切换 | `16037/getVenAgentByUid/getConversationList/setVenAgentStatus` | 本轮读取，未切换；历史切换请求无完整界面时间线，派单语义未知，见[状态设置](2026-10-30-agent-status-and-settings.md) |
| 会话列表、补拉与接收 | `16037/getConversationList/getConversationInfoByGidList`、`11679/getRecentMessages`、WSS | 有真实流量；重连、被踢、认证失效、睡眠恢复未测 |
| 已读 | 页面显示及WSS回执；候选HTTP `11679/PutAdviceOfReadByMsgId.json` | 本轮没有该HTTP请求，不能由页面已读推定REST契约通过 |
| 转移主客服 | 已定位 `transferVenMaster`，旅游群主候选 `15529/updateGroupOwner` | 本轮真实转移后角色读回：受邀客服[3,4,4]、当前客服[0,3,4]；**未保存该动作请求/响应，HTTP契约仍需补采**；旅游分支未测 |
| 订单摘要 | `14735/getOrderDetailsForVbk` | 本轮HTTP200/Ack Success但 **resultCode3/No permission**，只读重放同结果；无有效orderInfoDto，不能写详情可用 |
| 会话状态检查 | `16037/checkSessionStatus` | 本轮Ack Success但业务UNKNOWN，不能当有效状态 |
| 侧栏资料、跳转 | iframe HTML的 `__INITIAL_STATE__.vbkUserInfo/moduleJumpInfo`；静态映射 `15529/getVBKImUserInfo/getImPlusModuleJump` | 页面/SSR数据已确认；本轮没有这两个客户端SOA成功响应，见[SSR结构](evidence/browser-sidebar-ssr-20261030.json) |
| 排班、时区 | `16037/getAgentWorkingSchedule/getTimeZoneList` | 本轮SUCCESS并显示数据；未保存排班 |
| 自动答复 | `16037/getWordsAboves` | 本轮返回SUCCESS但无正文配置；保存及自动发送归属未验 |
| 入站翻译 | `11679/batchTranslateByMsgIds` | 本轮有请求/响应及译文显示；翻译失败与语言边界未测 |
| 通知中心 | `11679/getIQConversations/getIQMessages/putAdviceofreadIQMessage` | 历史已观测，部分响应未读；本轮未点击通知分类，见[提醒调查](2026-10-30-web-reminders.md) |
| 订单查询、IM联系及会话搜索 | `14361/searchorderlist/createimchat`、`16037/searchConversation`、`15529/queryGroupInfo` | 历史联系路径已走通，本轮按UID片段搜到受控会话；无权限/多结果/幂等仍未完整覆盖，见[订单会话](2026-10-30-web-order-conversation.md) |

## 三、只有静态定位或尚未完成目标分支

| 功能 | 候选接口 | 缺少的验证 |
| --- | --- | --- |
| HTTP发送兜底 | `11679/SendMessage.json` | WSS断开/错误分支的业务成功及未知结果恢复 |
| 文件/视频上传 | `12329/uploadFileV2`、其他上传候选 | 不能将PNG的Nephele路径直接套给其他类型 |
| 携程侧邀请、旅游群主转移 | `16037/inviteCtrip`、`15529/updateGroupOwner` | 对应网页入口、角色、响应和读回 |
| 服务评价 | `16037/checkScoreStatus/getEvaluateInfo/submitScore` | 本次结束未触发这些接口，不能主动绕过角色条件提交 |
| 快捷回复其他分支 | `updateCategory/updateCategorySortNo/updateCustomerScriptSort` 等 | 分类改名、移动/排序、团队权限 |
| 自动答复保存 | `16037/saveWordsAboves` | 保存与刷新读回、实际自动发送归属 |
| 排班保存 | `16037/modifyAgentWorkingSchedule` | 保存与权限/失败样本 |
| 上线实名验证完整流程 | `20016/checkVBKRealNameAuthStatus/startVBKRealNameAuthTask/getVbkRealNameTask` | 检查接口有初始化流量；二维码/人脸验证完整分支未测 |

## 四、本地能力与外部服务

| 功能 | 来源与处理 |
| --- | --- |
| 会话置顶 | 网页本地 `isTop`；没有新增服务端同步契约，不承诺跨设备 |
| 按localId核对发送结果 | 尚无独立查询契约；通过已验证历史/回执间接对账，未知结果不自动重发 |
| 回复超时、L0–L4提醒、稍后提醒 | 基于消息事实的本地能力，见[独立强提醒](../dev/03-strong-alert.md) |
| TSim登录、出站翻译、套餐/订单查询 | 外部TSim服务；本轮无实际模板，仍未测，不冒充携程接口 |
| 多账号、托盘/任务栏、截图、中文纠错、诊断包 | 本地能力，仍需客户端原型验证 |
| OCR | 引擎与Windows应用包身份需原型验证 |
| 客户端更新 | 需本项目受控发布源及签名策略，尚未验收 |
| ticket续期 | 沿用网页认证处理，尚无显式续期契约 |
| 云端崩溃上报、埋点 | 旧接收端未获授权，默认关闭，先做本地诊断 |

## 五、下一轮验收

优先补转移主客服完整网络链路、服务评价入口、14735有权限样本、HTTP发送兜底/断线补偿与幂等，随后验证其他设置和附件类型。不得把本轮成功样本延伸为所有角色/业务线均可用，也不得因旧清单恢复已取消的携程业务模块。

本轮测试数据已撤回/清理、个人设置恢复。本任务18:16最后读回时，受控会话仍在进行中，主客服为Sara、Meru为次客服，这是已执行转移后的状态，见[实测报告](2026-10-30-browser-api-validation.md#5-清理最终状态与剩余项)。
