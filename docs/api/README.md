# 接口请求契约

2026-10-30，Asia/Singapore。**当前仅采集、整理与验证契约，业务实现准入保持关闭。**

用户要求拿到所有必要请求要素后才开始开发。本目录替代历史材料中“仅有路由和业务字段”的实施入口，历史调查仍保留事实与时点。

- [Authentication、公共 Header 与两类 head](authentication.md)
- [WebSocket、HTTP 兜底与侧栏文档](transports.md)
- [TSim 登录、翻译与套餐查询源码契约](external-tsim.md)
- [真实操作与读回记录](validation.md)
- [开发准入与剩余缺项](readiness.md)
- [逐接口机器目录及全部样本](catalog.json)
- [旧证据接口清点](inventory.json)

本轮实际采集 **72 个 HTTP method + host + path 组合**，其中 72 个至少有一份请求头、ExtraInfo 与请求结构齐全的样本。该数字不等于接口已全部验证或可开始开发。OPTIONS 保留在证据中，不计业务接口。

用户最新要求：头像内设置本轮不再继续采集；已有只读旁证保留，不列为本轮补齐阻塞。接口行中的自动辅助请求和官方订单页内部读取不构成新增功能范围。

| 方法 | Host / Path | 样本 | 请求要素观测 | 范围 |
| --- | --- | --- | --- | --- |
| POST | [m.ctrip.com/restapi/soa2/11419/getLoginAdvisorOpenInfo](endpoints/m.ctrip.com-11419-getLoginAdvisorOpenInfo-post.md) | 2 | 有完整请求形态样本 | 网页消息/身份/联系入口及共享读取契约 |
| POST | [m.ctrip.com/restapi/soa2/11679/GetMyInfo.json](endpoints/m.ctrip.com-11679-GetMyInfo.json-post.md) | 7 | 有完整请求形态样本 | 网页消息/身份/联系入口及共享读取契约 |
| POST | [m.ctrip.com/restapi/soa2/11679/PutAdviceOfReadByMsgId.json](endpoints/m.ctrip.com-11679-PutAdviceOfReadByMsgId.json-post.md) | 1 | 有完整请求形态样本 | 网页消息/身份/联系入口及共享读取契约 |
| POST | [m.ctrip.com/restapi/soa2/11679/SendMessage.json](endpoints/m.ctrip.com-11679-SendMessage.json-post.md) | 1 | 有完整请求形态样本 | 网页消息/身份/联系入口及共享读取契约 |
| POST | [m.ctrip.com/restapi/soa2/11679/batchTranslateByMsgIds](endpoints/m.ctrip.com-11679-batchTranslateByMsgIds-post.md) | 12 | 有完整请求形态样本 | 网页消息/身份/联系入口及共享读取契约 |
| POST | [m.ctrip.com/restapi/soa2/11679/getIQConversations](endpoints/m.ctrip.com-11679-getIQConversations-post.md) | 4 | 有完整请求形态样本 | 网页消息/身份/联系入口及共享读取契约 |
| POST | [m.ctrip.com/restapi/soa2/11679/getRecentMessages](endpoints/m.ctrip.com-11679-getRecentMessages-post.md) | 15 | 有完整请求形态样本 | 网页消息/身份/联系入口及共享读取契约 |
| POST | [m.ctrip.com/restapi/soa2/11679/recallMessage](endpoints/m.ctrip.com-11679-recallMessage-post.md) | 10 | 有完整请求形态样本 | 网页消息/身份/联系入口及共享读取契约 |
| POST | [m.ctrip.com/restapi/soa2/13500/checkMemberStatus](endpoints/m.ctrip.com-13500-checkMemberStatus-post.md) | 25 | 有完整请求形态样本 | 网页消息/身份/联系入口及共享读取契约 |
| POST | [m.ctrip.com/restapi/soa2/14735/getOrderDetailsForVbk](endpoints/m.ctrip.com-14735-getOrderDetailsForVbk-post.md) | 8 | 有完整请求形态样本 | 网页消息/身份/联系入口及共享读取契约 |
| POST | [m.ctrip.com/restapi/soa2/15529/getSessionEmpathyPhraseInfo](endpoints/m.ctrip.com-15529-getSessionEmpathyPhraseInfo-post.md) | 32 | 有完整请求形态样本 | 网页消息/身份/联系入口及共享读取契约 |
| POST | [m.ctrip.com/restapi/soa2/15529/getSessionUrls](endpoints/m.ctrip.com-15529-getSessionUrls-post.md) | 5 | 有完整请求形态样本 | 网页消息/身份/联系入口及共享读取契约 |
| POST | [m.ctrip.com/restapi/soa2/15529/queryToken](endpoints/m.ctrip.com-15529-queryToken-post.md) | 8 | 有完整请求形态样本 | 网页消息/身份/联系入口及共享读取契约 |
| POST | [m.ctrip.com/restapi/soa2/16037/checkSessionStatus](endpoints/m.ctrip.com-16037-checkSessionStatus-post.md) | 8 | 有完整请求形态样本 | 网页消息/身份/联系入口及共享读取契约 |
| POST | [m.ctrip.com/restapi/soa2/16037/finishConversation](endpoints/m.ctrip.com-16037-finishConversation-post.md) | 2 | 有完整请求形态样本 | 网页消息/身份/联系入口及共享读取契约 |
| POST | [m.ctrip.com/restapi/soa2/16037/getAgentWorkingSchedule](endpoints/m.ctrip.com-16037-getAgentWorkingSchedule-post.md) | 3 | 有完整请求形态样本 | 网页消息/身份/联系入口及共享读取契约 |
| POST | [m.ctrip.com/restapi/soa2/16037/getCategories](endpoints/m.ctrip.com-16037-getCategories-post.md) | 1 | 有完整请求形态样本 | 网页消息/身份/联系入口及共享读取契约 |
| POST | [m.ctrip.com/restapi/soa2/16037/getConversationInfoByGidList](endpoints/m.ctrip.com-16037-getConversationInfoByGidList-post.md) | 19 | 有完整请求形态样本 | 网页消息/身份/联系入口及共享读取契约 |
| POST | [m.ctrip.com/restapi/soa2/16037/getConversationList](endpoints/m.ctrip.com-16037-getConversationList-post.md) | 22 | 有完整请求形态样本 | 网页消息/身份/联系入口及共享读取契约 |
| POST | [m.ctrip.com/restapi/soa2/16037/getConversationList.json](endpoints/m.ctrip.com-16037-getConversationList.json-post.md) | 4 | 有完整请求形态样本 | 网页消息/身份/联系入口及共享读取契约 |
| POST | [m.ctrip.com/restapi/soa2/16037/getCustomerScripts](endpoints/m.ctrip.com-16037-getCustomerScripts-post.md) | 3 | 有完整请求形态样本 | 网页消息/身份/联系入口及共享读取契约 |
| POST | [m.ctrip.com/restapi/soa2/16037/getInviteCtripData](endpoints/m.ctrip.com-16037-getInviteCtripData-post.md) | 1 | 有完整请求形态样本 | 网页消息/身份/联系入口及共享读取契约 |
| POST | [m.ctrip.com/restapi/soa2/16037/getInviteMemberListBySkillGroup](endpoints/m.ctrip.com-16037-getInviteMemberListBySkillGroup-post.md) | 2 | 有完整请求形态样本 | 网页消息/身份/联系入口及共享读取契约 |
| POST | [m.ctrip.com/restapi/soa2/16037/getLatestConversationByGid](endpoints/m.ctrip.com-16037-getLatestConversationByGid-post.md) | 11 | 有完整请求形态样本 | 网页消息/身份/联系入口及共享读取契约 |
| POST | [m.ctrip.com/restapi/soa2/16037/getLatestSingleChat](endpoints/m.ctrip.com-16037-getLatestSingleChat-post.md) | 4 | 有完整请求形态样本 | 网页消息/身份/联系入口及共享读取契约 |
| POST | [m.ctrip.com/restapi/soa2/16037/getMessageList](endpoints/m.ctrip.com-16037-getMessageList-post.md) | 61 | 有完整请求形态样本 | 网页消息/身份/联系入口及共享读取契约 |
| POST | [m.ctrip.com/restapi/soa2/16037/getRemarkList](endpoints/m.ctrip.com-16037-getRemarkList-post.md) | 23 | 有完整请求形态样本 | 网页消息/身份/联系入口及共享读取契约 |
| POST | [m.ctrip.com/restapi/soa2/16037/getTimeZoneList](endpoints/m.ctrip.com-16037-getTimeZoneList-post.md) | 1 | 有完整请求形态样本 | 头像设置只读旁证；用户已要求本轮不继续 |
| POST | [m.ctrip.com/restapi/soa2/16037/getVenAgentByUid](endpoints/m.ctrip.com-16037-getVenAgentByUid-post.md) | 5 | 有完整请求形态样本 | 网页消息/身份/联系入口及共享读取契约 |
| POST | [m.ctrip.com/restapi/soa2/16037/getVenAgentByUid.json](endpoints/m.ctrip.com-16037-getVenAgentByUid.json-post.md) | 5 | 有完整请求形态样本 | 网页消息/身份/联系入口及共享读取契约 |
| POST | [m.ctrip.com/restapi/soa2/16037/getWordsAboves](endpoints/m.ctrip.com-16037-getWordsAboves-post.md) | 1 | 有完整请求形态样本 | 头像设置只读旁证；用户已要求本轮不继续 |
| POST | [m.ctrip.com/restapi/soa2/16037/inviteVenAgent](endpoints/m.ctrip.com-16037-inviteVenAgent-post.md) | 2 | 有完整请求形态样本 | 网页消息/身份/联系入口及共享读取契约 |
| POST | [m.ctrip.com/restapi/soa2/16037/searchConversation](endpoints/m.ctrip.com-16037-searchConversation-post.md) | 6 | 有完整请求形态样本 | 网页消息/身份/联系入口及共享读取契约 |
| POST | [m.ctrip.com/restapi/soa2/16037/searchInviteMemberListBySkillGroup](endpoints/m.ctrip.com-16037-searchInviteMemberListBySkillGroup-post.md) | 1 | 有完整请求形态样本 | 网页消息/身份/联系入口及共享读取契约 |
| POST | [m.ctrip.com/restapi/soa2/16037/setWorkSheetStar](endpoints/m.ctrip.com-16037-setWorkSheetStar-post.md) | 2 | 有完整请求形态样本 | 网页消息/身份/联系入口及共享读取契约 |
| POST | [m.ctrip.com/restapi/soa2/16037/startChatB2C](endpoints/m.ctrip.com-16037-startChatB2C-post.md) | 6 | 有完整请求形态样本 | 网页消息/身份/联系入口及共享读取契约 |
| POST | [m.ctrip.com/restapi/soa2/16037/syncVenAgentInfo](endpoints/m.ctrip.com-16037-syncVenAgentInfo-post.md) | 2 | 有完整请求形态样本 | 网页消息/身份/联系入口及共享读取契约 |
| POST | [m.ctrip.com/restapi/soa2/16037/transferVenMaster](endpoints/m.ctrip.com-16037-transferVenMaster-post.md) | 1 | 有完整请求形态样本 | 网页消息/身份/联系入口及共享读取契约 |
| POST | [m.ctrip.com/restapi/soa2/16037/uploadTokenCreate](endpoints/m.ctrip.com-16037-uploadTokenCreate-post.md) | 4 | 有完整请求形态样本 | 网页消息/身份/联系入口及共享读取契约 |
| POST | [m.ctrip.com/restapi/soa2/16163/saveLogInfo](endpoints/m.ctrip.com-16163-saveLogInfo-post.md) | 15 | 有完整请求形态样本 | 页面自动辅助请求；不扩展为本项目功能 |
| POST | [m.ctrip.com/restapi/soa2/18088/getAppConfig.json](endpoints/m.ctrip.com-18088-getAppConfig.json-post.md) | 32 | 有完整请求形态样本 | 网页消息/身份/联系入口及共享读取契约 |
| POST | [m.ctrip.com/restapi/soa2/20016/checkVBKRealNameAuthStatus](endpoints/m.ctrip.com-20016-checkVBKRealNameAuthStatus-post.md) | 2 | 有完整请求形态样本 | 网页消息/身份/联系入口及共享读取契约 |
| POST | [m.ctrip.com/restapi/soa2/22015/getSceneConfig](endpoints/m.ctrip.com-22015-getSceneConfig-post.md) | 5 | 有完整请求形态样本 | 网页消息/身份/联系入口及共享读取契约 |
| POST | [m.ctrip.com/restapi/soa2/36709/createTUid](endpoints/m.ctrip.com-36709-createTUid-post.md) | 3 | 有完整请求形态样本 | 页面自动辅助请求；不扩展为本项目功能 |
| POST | [nephele.ctrip.com/file/v1/api/upload](endpoints/nephele.ctrip.com-file-v1-api-upload-post.md) | 1 | 有完整请求形态样本 | 网页消息/身份/联系入口及共享读取契约 |
| POST | [nephele.ctrip.com/image/v2/api/upload](endpoints/nephele.ctrip.com-image-v2-api-upload-post.md) | 3 | 有完整请求形态样本 | 网页消息/身份/联系入口及共享读取契约 |
| POST | [nephele.ctrip.com/video/v1/api/proc](endpoints/nephele.ctrip.com-video-v1-api-proc-post.md) | 1 | 有完整请求形态样本 | 网页消息/身份/联系入口及共享读取契约 |
| POST | [nephele.ctrip.com/video/v3/api/upload](endpoints/nephele.ctrip.com-video-v3-api-upload-post.md) | 1 | 有完整请求形态样本 | 网页消息/身份/联系入口及共享读取契约 |
| POST | [online.ctrip.com/restapi/soa2/12405/generateWaterMark](endpoints/online.ctrip.com-12405-generateWaterMark-post.md) | 5 | 有完整请求形态样本 | 页面自动辅助请求；不扩展为本项目功能 |
| POST | [online.ctrip.com/restapi/soa2/12405/getCurrentUserInfo](endpoints/online.ctrip.com-12405-getCurrentUserInfo-post.md) | 15 | 有完整请求形态样本 | 网页消息/身份/联系入口及共享读取契约 |
| POST | [online.ctrip.com/restapi/soa2/13191/validateTicket](endpoints/online.ctrip.com-13191-validateTicket-post.md) | 5 | 有完整请求形态样本 | 网页消息/身份/联系入口及共享读取契约 |
| POST | [online.ctrip.com/restapi/soa2/14894/ContactUs](endpoints/online.ctrip.com-14894-ContactUs-post.md) | 3 | 有完整请求形态样本 | 页面自动辅助请求；不扩展为本项目功能 |
| POST | [online.ctrip.com/restapi/soa2/14894/getDoorFunctionGuide](endpoints/online.ctrip.com-14894-getDoorFunctionGuide-post.md) | 5 | 有完整请求形态样本 | 页面自动辅助请求；不扩展为本项目功能 |
| POST | [online.ctrip.com/restapi/soa2/14894/getProviderBusinessLineList](endpoints/online.ctrip.com-14894-getProviderBusinessLineList-post.md) | 5 | 有完整请求形态样本 | 页面自动辅助请求；不扩展为本项目功能 |
| POST | [online.ctrip.com/restapi/soa2/15529/queryRecommendProductList](endpoints/online.ctrip.com-15529-queryRecommendProductList-post.md) | 1 | 有完整请求形态样本 | 网页消息/身份/联系入口及共享读取契约 |
| POST | [online.ctrip.com/restapi/soa2/15529/sendCardMessageForOffline](endpoints/online.ctrip.com-15529-sendCardMessageForOffline-post.md) | 1 | 有完整请求形态样本 | 网页消息/身份/联系入口及共享读取契约 |
| POST | [online.ctrip.com/restapi/soa2/16566/queryCountByEid](endpoints/online.ctrip.com-16566-queryCountByEid-post.md) | 8 | 有完整请求形态样本 | 页面自动辅助请求；不扩展为本项目功能 |
| POST | [online.ctrip.com/restapi/soa2/16881/searchPop](endpoints/online.ctrip.com-16881-searchPop-post.md) | 5 | 有完整请求形态样本 | 页面自动辅助请求；不扩展为本项目功能 |
| POST | [online.ctrip.com/restapi/soa2/17092/listNoticeReceiveConfig](endpoints/online.ctrip.com-17092-listNoticeReceiveConfig-post.md) | 5 | 有完整请求形态样本 | 网页消息/身份/联系入口及共享读取契约 |
| POST | [sec-m.ctrip.com/restapi/soa2/11380/queryevent](endpoints/sec-m.ctrip.com-11380-queryevent-post.md) | 2 | 有完整请求形态样本 | 页面自动辅助请求；不扩展为本项目功能 |
| POST | [sec-m.ctrip.com/restapi/soa2/14361/createimchat](endpoints/sec-m.ctrip.com-14361-createimchat-post.md) | 1 | 有完整请求形态样本 | 网页消息/身份/联系入口及共享读取契约 |
| POST | [sec-m.ctrip.com/restapi/soa2/14361/getdeliveryinfo](endpoints/sec-m.ctrip.com-14361-getdeliveryinfo-post.md) | 1 | 有完整请求形态样本 | 官方订单详情页内部读取旁证；不恢复完整订单管理 |
| POST | [sec-m.ctrip.com/restapi/soa2/14361/getorderclient](endpoints/sec-m.ctrip.com-14361-getorderclient-post.md) | 1 | 有完整请求形态样本 | 官方订单详情页内部读取旁证；不恢复完整订单管理 |
| POST | [sec-m.ctrip.com/restapi/soa2/14361/getorderinfo](endpoints/sec-m.ctrip.com-14361-getorderinfo-post.md) | 2 | 有完整请求形态样本 | 官方订单详情页内部读取旁证；不恢复完整订单管理 |
| POST | [sec-m.ctrip.com/restapi/soa2/14361/getorderrefund](endpoints/sec-m.ctrip.com-14361-getorderrefund-post.md) | 1 | 有完整请求形态样本 | 官方订单详情页内部读取旁证；不恢复完整订单管理 |
| POST | [sec-m.ctrip.com/restapi/soa2/14361/getordersettlement](endpoints/sec-m.ctrip.com-14361-getordersettlement-post.md) | 1 | 有完整请求形态样本 | 官方订单详情页内部读取旁证；不恢复完整订单管理 |
| POST | [sec-m.ctrip.com/restapi/soa2/14361/getprocessloglist](endpoints/sec-m.ctrip.com-14361-getprocessloglist-post.md) | 2 | 有完整请求形态样本 | 官方订单详情页内部读取旁证；不恢复完整订单管理 |
| POST | [sec-m.ctrip.com/restapi/soa2/14361/getsupreceiptcountbystatus](endpoints/sec-m.ctrip.com-14361-getsupreceiptcountbystatus-post.md) | 2 | 有完整请求形态样本 | 官方订单详情页内部读取旁证；不恢复完整订单管理 |
| POST | [sec-m.ctrip.com/restapi/soa2/14361/queryordervoucher](endpoints/sec-m.ctrip.com-14361-queryordervoucher-post.md) | 2 | 有完整请求形态样本 | 官方订单详情页内部读取旁证；不恢复完整订单管理 |
| POST | [sec-m.ctrip.com/restapi/soa2/14361/searchorderlist](endpoints/sec-m.ctrip.com-14361-searchorderlist-post.md) | 3 | 有完整请求形态样本 | 网页消息/身份/联系入口及共享读取契约 |
| GET | [vbooking.ctrip.com/tour/im/ex-area/b](endpoints/vbooking.ctrip.com-tour-im-ex-area-b-get.md) | 1 | 有完整请求形态样本 | 网页消息/身份/联系入口及共享读取契约 |
| GET | [vbooking.ctrip.com/tour/im/ex-area/b/imExtraInfo](endpoints/vbooking.ctrip.com-tour-im-ex-area-b-imExtraInfo-get.md) | 1 | 有完整请求形态样本 | 网页消息/身份/联系入口及共享读取契约 |

占位符保留动态位置与原始类型；`dynamic_ref_*` 是动态字典键的不可逆脱敏引用，不是固定字段。同一采集文件内可对应，不跨动作强行关联。证据 schema 是观测描述，不是推定 required 的 OpenAPI 声明。

采集 stage 表示观察窗口；初始化、后台同步与埋点可能混入。动作验收以对应主请求、当前目标校验及业务/UI 读回为准，不把该窗口全部请求都解释成用户动作。

本轮新网页主包版本为 `1793340371237`，业务逻辑位于 `296-1776b2655d6f3342.js`；SDK 为 `imsdk.850ee19f2122897fcb3d3d18f17bc8d4.js`。旧版本 `1792569719501` 的材料不能未经核对直接作为当前契约。
