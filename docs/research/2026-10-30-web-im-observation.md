# 网页 IM 实地观测记录（2026-10-30）

状态：已完成真实网页登录、IM 初始化和 130 秒连续被动网络观察；发送、已读与上传路径另以当前网页静态代码核对，未主动发送客户消息或触发业务写操作。

## 观测环境与边界

- 使用用户指定的 ego-browser 技能，运行时指南版本 2.2.0；接管既有人工空间 0、既有标签 p1，没有新建隔离浏览器或账号。
- 本地 CLI 的 GUI XPC 连接失败后，通过 Codex Project Bridge 执行同一 ego-browser CLI 成功连接。未发生审批拒绝。
- 时间：2026-10-30，约 15:14–15:29，Asia/Singapore。
- 使用页面已有的预填登录表单；未提取密码，未修改密码，未向客户发消息，未执行结束会话、转接或上传。
- 下文仅保留 URL、接口名与字段名，不包含 ticket、Cookie 值、账号标识或客户消息正文。

## 已实际观察的登录链路

1. 起点为 `https://vbooking.ctrip.com/ivbk/accountV2/login?backurl=https%3A%2F%2Fvbooking.ctrip.com%2Fmicro%2Fivbk%2FaccountV2%2Fdashboard`。
2. 勾选登录协议后提交页面已有预填表单，加载 `jigsawCaptcha/~2.0.0/default/js/jigsaw-captcha.min.js`。
3. `POST https://ic.ctrip.com/captcha/v4/risk_inspect`，HTTP 200。请求顶层字段：`extend_param`、`appid`、`business_site`、`version`、`dimensions`、`sign`、`t`、`cdn`。没有出现需要人工完成的滑块。
4. `POST https://online.ctrip.com/restapi/soa2/22160/pwdLogin`，HTTP 200。请求顶层字段：`contentType`、`head`、`accessCode`、`frontRiskInfo`、`clientInfo`、`authenticateInfo`。HTTP 200 本身不代表业务成功；后续进入 dashboard 才支持本次登录成功判断。
5. 页面弹出「登录密码修改提示」，提示超过 180 天未修改密码。选择「暂不修改」继续，未修改任何密码。
6. 依次观察到 `POST /restapi/soa2/12405/getCurrentUserInfo` 与 `POST /restapi/soa2/12405/authToken`（host 为 `online.ctrip.com`），随后导航到 `https://vbooking.ctrip.com/micro/ivbk/accountV2/dashboard`。

## 已观察的首页关联接口与 IM 入口

| 类型 | 实际观察 |
| --- | --- |
| 首页消息入口 | `https://imvendor.ctrip.com/main?currentTab=BC&initChat=3&locale=zh-CN&accountsource=vbk&disNotificationBiztype=118` |
| 首页咨询入口 | `/ivbk/accountV2/vbkChat?imUrl=`，参数指向 `https://imvendor.ctrip.com/main?currentTab=BC&lang=zh-CN` |
| IM 未读脚本 | `https://ws-s.tripcdn.cn/modules/basebiz.im/web-vendor-unread/index.57b08b3cab811c4ac12f866301513743.js` |
| 首页 IM 账号查询 | `POST https://m.ctrip.com/restapi/soa2/16037/getVenAgentByUid.json` |
| 登录态校验 | `POST https://online.ctrip.com/restapi/soa2/13191/validateTicket` |
| 配置 | `POST https://m.ctrip.com/restapi/soa2/18088/getAppConfig.json` |
| 通知配置 | `POST https://online.ctrip.com/restapi/soa2/17092/listNoticeReceiveConfig` |
| 事件数量 | `POST https://online.ctrip.com/restapi/soa2/16566/queryCountByEid` |

这些为首页实际发出的请求，不等于完整 IM 初始化接口集。未读脚本的存在不能证明具体实时推送协议。

## IM 恢复与页面版本（实测）

第一次导航遇到通知权限提示后已停止；用户回复「继续」后用 `takeOverTaskSpace(0)` 恢复原空间，权限提示已消失。最终顶层 URL 仍为上述 `/vbk/im/main?...`，无 iframe。首页链接指向 `imvendor.ctrip.com` 与本页未跳转并不矛盾，不能把两入口未经验证地视为同一部署。

- 网页主包：`https://webresource.c-ctrip.com/NFES/vbkIm/1792569719501/_next/static/chunks/pages/main-c2bb7fee0d8e9f1b.js`。
- 网页 SDK：`https://static.tripcdn.com/modules/basebiz.im/web-imclient-core/imsdk.850ee19f2122897fcb3d3d18f17bc8d4.js`。
- 当前网页 SDK 静态常量 `sdkVersion="3.0.0"`、`xmppVersion="1.3.1"`，与原文档 Node 包 `@ctrip/s-node-imclient-core 1.0.24` 不同，不能仅凭方法名相同认定行为一致。
- 观测结束已将原用户页面保留并归还，未关闭客服页面。

## IM 初始化与消息流（实测）

刷新该页捕获到两条连接：`wss://im3.ctrip.com/ws-xmpp/` 与 `wss://im.ctrip.com/ws-xmpp/`。两者均出现 `open → stream:features → auth → success → open → bind`，命名空间包含 XMPP framing、SASL、bind；随后以 `urn:xmpp:ping` 发 IQ 心跳。两个连接的具体页面组件归属尚未证明，不能凭域名将其中一个判作备用连接。

连续观察窗口为 **2026-10-30 15:23:00.578–15:25:10.767（Asia/Singapore），约 130.2 秒**：

| 观察项 | 结果与边界 |
| --- | --- |
| 脱敏事件 | 506 条，包含请求、响应、WS 帧，不代表 506 条消息 |
| 入站 `message` 帧 | 两连接各 82，共 164；其中 2 帧有 `x/invite/reason/body`（MUC 邀请结构），162 帧有 `message/body` |
| 心跳与 IQ | 单独统计，不计入上述 164；两连接各 45 个出站 IQ、64 个入站 IQ |
| 出站 `message` 帧 | 各 25，共 50，全部无 `body`，只有 `id/type/from/xmlns` 属性；不能据此声称人工发送成功，结构与自动控制/确认帧相符 |
| 人工发送正文 | 未观察到；未主动测试 |
| 去重限制 | 两连接数量完全一致且初始化时出现近同时帧；未保留消息 ID 值，不能推定 164 条独立消息，也不能精确计算重复率 |
| 消息分类限制 | 仅保存标签和属性名，无正文或属性值；不能可靠地把 162 个普通结构帧细分为文本、输入状态或业务通知 |

实际消息帧属性集合包含 `localid`、`id`、`ts`、`msgtype`、`bizType`、`threadid`、`create_time`、`skip_db`、`transmit`、`from`、`to`、`receipt_range`，部分包含 `sourceGid`、`ext`、`udl`、`ucsUid`。这里仅证明字段存在，不证明其完整语义。

## 已实际请求的 IM HTTP 接口

下表 host 均为 `m.ctrip.com/restapi/soa2`。初始化阶段观察到 HTTP 200 及表列响应字段；不把 HTTP 200 单独当作业务成功。

| 接口 | 请求字段（除 head） | 响应主要字段 |
| --- | --- | --- |
| `11679/GetMyInfo.json` | 无 | `ResponseStatus,name,avatar,jid,extPropertys` |
| `11679/getRecentMessages` | `beginMsgTime,pageSize` | `ResponseStatus,messages,lastMessageTimestamp,localIds`，空结果可能只返回时间戳 |
| `11679/getIQConversations` | `lastMsgTime` | `ResponseStatus,latestMsgTime,haveRest,categoryList` |
| `16037/getVenAgentByUid` / `.json` | 无 | `ResponseStatus,venAgent,venAgentOption,hasTodoList,abTestResult` |
| `16037/getConversationList` / `.json` | 部分只有 head | `ResponseStatus,conversationList,currentStatus,lastUpdateTime,haveRest` |
| `16037/getLatestSingleChat` | `paging` | `ResponseStatus,bizResponseStatus,messages,haveRest,lastMessageTime` |
| `16037/getConversationInfoByGidList` | `gidList` | `ResponseStatus,bizResponseStatus,conversationInfoList` |
| `18088/getAppConfig.json` | `appId,categoryList` | `ResponseStatus,resultCode,lastCver,configList,delCategoryList,actualSize` |

130 秒窗口内 `getRecentMessages` 26 次，呈两路约 10 秒周期的交错请求；`getConversationList.json`、`getLatestSingleChat`、`getIQConversations` 各 2 次，且各对间隔约 0.1 秒；`getConversationInfoByGidList` 1 次。**本窗口没有观察到网页会话列表每 5 秒轮询**，不能直接沿用旧客户端该结论。SDK 静态 `compensationInterval=10000` 与增量补偿节律相符，但尚未完整定位两个调用来源。

`getRecentMessages` 请求 head 的 `cver=1.0.7`，extension 名包括 `protocol,cpc,appid,language,amp-product-type,amp-account-source,client-source`。业务请求可另带 `cookieOrigin`、`x-tour-auth-from` 与 `x-ctx-*`；不能把所有请求归为同一个 head 模板。

## 鉴权差异

### 实测 Cookie 属性

| 名称 | 域 | HttpOnly | Secure | SameSite | 会话 Cookie |
| --- | --- | --- | --- | --- | --- |
| `bticket` | `.ctrip.com` | 是 | 是 | None | 否 |
| `vbkticket` | `.ctrip.com` | 是 | 是 | None | 否 |
| `BDUID` | `.ctrip.com` | 否 | 是 | None | 否 |

仅读取名称和属性输出，未保存 Cookie 值。此结果可补充登录文档的待确认项，但未验证是否仅这三项就足以重建完整登录态。

### 当前网页代码静态证据（未主动重放鉴权）

- 网页 `IMClient.init` 明确配置 `appId:"100067816"`、`conversationType:"conversationList"`、`initPageSize:0`、`withoutExtra:true`、语言及 `customHTTPExts`；该调用不传显式 token。
- 业务控制器 `getHead` 默认 `900004`，不能误写成网页 SDK appId 也是 `900004`。
- SDK HTTP 层有 token 时写入 `head.auth` 并 `withCredentials=false`；浏览器无 token 时 `withCredentials=true`。因此目前网页初始化代码与 Cookie 会话链路相匹配，但不等于已经验证 Rust HTTP 客户端可直接复用全部鉴权。
- SDK WS 凭据分支：有 token 则使用 token；无 token 时可按 `amp-product-type` 与 `amp-account-source` 组合一个带 NUL 分隔符的字符串。此处是静态逻辑，不是本次解码认证帧或主动重放的结果；必须同时考虑浏览器握手 Cookie，不能把该字符串当作独立可移植凭据。

## 发送、已读与业务操作（静态核对，未触发）

| 功能 | 当前网页代码路径 | 证据级别 |
| --- | --- | --- |
| 发送入口 | main 的 `window.postImMessage` → `IMClient.sendMessageInSocket`，成功回填 `localId/msgCreateTime/msgId`，失败广播错误 | 静态；没有发送正文验收 |
| SDK HTTP 兜底 | 未连接 socket，或 socket 返回 `error=-2` 时，SDK 内部转 HTTP；默认 socket 回调超时参数为 5000 ms；其他 socket 错误回调失败 | 静态；未制造断网/超时 |
| HTTP 发送 | SDK 路径 `/11679/SendMessage.json` | 静态；本窗口没有实际请求 |
| WS 发送体 | `chattype,biztype,localid,msg,msgtype,autoextend,threadid`；引用另有 `citemsgid` | 静态；幂等语义未验证 |
| 已读 | `putAdviceOfReadByMsgId({partnerJid,msgId,conversationType})` → `/11679/PutAdviceOfReadByMsgId.json` | 静态 |
| 输入状态 | main → `IMClient.sendInputState` | 静态 |
| 历史 | `/16037/getMessageList`；IQ `/11679/getIQMessages` | 静态，未主动打开会话触发 |
| 翻译 | `/11679/getMessageTranslate`、`batchTranslateByMsgIds`、`translateIQMessage` | 静态 |
| 上传候选 | `/16037/uploadTokenCreate`、`/12329/uploadImageV2`、`uploadFileV2`、`/18837/ImUploadImage` | 静态路由存在，当前场景具体选用与完整签名链路未确认 |
| 订单 | `/16037/getDLTOrderInfo`、`verifyOrderId`；`/14735/getOrderDetailsForVbk` | 静态 |
| 话术 | `/16037/getCustomerScripts`、`addCustomerScript`、`updateCustomerScript`、`deleteCustomerScript` | 静态 |
| 会话操作 | `/16037/finishConversation`、`transferVenMaster`、`inviteVenAgent`、`inviteCtrip`、`setVenAgentStatus`、`modifyRemark` | 静态，未触发业务修改 |

网页主包没有像旧客户端包装那样在任意发送失败回调中再次调用 `sendMessage`；其回退主要在网页 SDK 内部。适配时应按实际错误类别做策略，避免重复叠加兜底造成重复发送。

## 选型影响与待验证

网页并非另一套与桌面完全无关的 IM 后端：已实测共用 XMPP over WebSocket、16037/11679 服务家族，网页还提供可对照的最新初始化、补偿与业务封装。决定应拆为「业务 HTTP 契约」与「实时传输运行时」，不能二选一地整体替换。

- 业务接口：优先以当前网页实际请求与版本化代码校正客户端旧文档，保留统一 core-net / core-im 契约。
- 传输：网页方案值得立项原型，但网页登录态依赖、浏览器 WS Cookie、双连接归属、后台 WebView 生命周期及 SDK 版本差异尚未验证。不能现在宣布可删除 Node sidecar。
- 网页适配与 Node 适配都应保留在 `ImTransport` 接缝后，核心消息去重、补拉、状态与 UI 继续自有实现。
- 替代前必须补齐受控测试会话的发送确认、超时兜底去重、已读与附件、断线/睡眠恢复、失效续期、多账号隔离及后台资源测量。

本记录只修改文档，不修改实现。脱敏记录保留字段结构、计数与版本；未保存可重放 token、客户正文或完整账号标识。

## 最终对抗审查：只读复核（15:35）

2026-10-30 15:35（Asia/Singapore），使用同一 ego-browser CLI；本地GUI XPC不可用后通过Project Bridge连接。建立单一临时任务空间2，复用浏览器现有登录会话，打开相同 `/vbk/im/main` 后开启Network观察并刷新；没有操作原用户空间。观察后已关闭该临时空间，未调用发信、已读、客服状态、转接、结束或配置写入。页面自身的初始化、自动协议应答和埋点照常发生，不能将此次导航说成完全没有服务端副作用。

新增脱敏记录：[web-im-final-verification-20261030.json](evidence/web-im-final-verification-20261030.json)。它与前轮130秒样本独立，不混合计数。记录采集结束时间 `2026-10-30T07:35:11.924Z`，刷新后等待12秒收集；没有记录精确起止边界，因此不能据此计算稳定请求频率或业务吞吐。

| 复核项 | 本轮证据 | 仍未证明 |
| --- | --- | --- |
| 页面/版本 | 标题“供应商客服工作台”，无iframe；SDK/main版本URL与前轮一致；未显示密码输入框 | 本地Tauri WebView可独立运行或最低Cookie集合 |
| 身份读取 | `online.ctrip.com/12405/getCurrentUserInfo`，HTTP200、Ack Success，顶层包含 `user`（不是userInfo）及权限/菜单等字段 | user内字段和身份绑定全契约、失败码穷举、续期与账号切换 |
| 客服身份 | `16037/getVenAgentByUid`和`.json`响应含venAgent、venAgentOption；Ack Success | 任意客服可被管理、状态写入与分配规则 |
| 当前工作状态 | `getConversationList`与`.json`均返回数字型currentStatus | 状态切换、在线/挂起/离开/下班的实际服务端分配语义 |
| 排班读取 | `getAgentWorkingSchedule`请求含head/locale/venAgentUid，响应含workingSchedule与bizResponseStatus.resultCode | 保存契约及业务成功码的全部类型与取值 |
| 长连接 | 两条WSS仍为im3/im；各有auth/success，合计8个入站message、8个出站message | 未保留消息ID/连接关联，无法去重；不能当发送正文或业务完成证据 |
| HTTP数量 | 捕获31个POST，包含初始化与补偿 | 不把OPTIONS或空bodyKeys算业务响应；空bodyKeys也可能是响应体不可用 |

**登录成功判据修正**：静态主包的 `getUserInfo` 使用 `getCurrentUserInfo` 通过checkResponse后返回response.user；ErrorCode=11000另走带 `x-tour-auth-from:merchants_online` 的身份分支。通用checkResponse对Ack Success且未显式success/isSuccess=false过于宽松；新客户端必须校验预期身份字段、账号/环境及业务前提，不能把“没有错误提示”直接变为account ready。只保留字段名，本轮未提取或落盘身份值。

**历史分页纠正（同版本主包静态）**：`getMessageList` 基础body为head/showTargetIsRead/groupId/conversationType/pageSize；历史前向传 `beginTime,direction:next`，后向传 `endTime,direction:prev`；读取 `rangeMessage.messages,lastMessageTime`。必须验证排序、时间单位、包含性和同时间戳满页，不能写成已确认支持 `after=msgId`。

**前轮证据补存**：找到前轮明确路径的脱敏原始记录并校验，仅含URL、字段类型、帧标签/属性名/长度、SDK参数名和安全版本常量。现已保存 [web-im-passive-20261030.json](evidence/web-im-passive-20261030.json)：started=`07:23:00.578Z`、ended=`07:25:10.767Z`、506事件，可复算164个入站message、50个出站message、128个入站IQ、90个出站IQ、37请求、37响应。前轮逐连接域名关联来自初始化观察，单独此连续trace没有WS创建事件，不把连接ID本身当域名证明。

最终仍缺受控发信、上传、已读、状态切换、转接/结束、强制失效、睡眠/断网与多账号隔离证据。这些已转为开发原型与发布验收硬门槛，不以继续盲目操作生产客户来填补。


## 后续边际功能调查

见[成员管理、侧栏、产品推荐与订单接口补充](2026-10-30-im-peripheral-apis.md)。本篇“无 iframe”只描述当时 IM 初始化观测；后续选中会话已确认右侧存在独立业务 iframe。补充记录包含移除成员对 `finishConversation` 的复用、转移双分支、推荐查询实测及客户卡片字段、侧栏数据映射和门票订单列表真实接口。
