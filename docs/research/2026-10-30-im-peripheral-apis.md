# IM 成员管理、侧栏、产品推荐与订单接口补充

调查日期：2026-10-30（Asia/Singapore）。本记录补充此前只列路由、未追到调用参数的边际功能。

## 1. 范围与证据

本轮读取已打开并已登录的 Edge 携程工作台，操作了产品推荐标签、用户订单列表链接、订单列表查询和邀请成员弹窗；邀请弹窗未选择或提交成员。随后重新加载工作台并恢复原会话，以尝试补抓初始化。未发送消息或产品卡片，未提交转移、移除、结束会话或修改设置。打开原会话可能触发官方页面自身的已读回执，不能将本轮称为完全无副作用的被动抓包。

证据分层：

- **动态**：点击对应只读入口，捕获请求及返回；仅证明当前账号、当前业务场景。
- **静态**：已读取当前网页业务代码的调用点，并与本地客户端源码对照；不代表服务端写操作成功。
- **待验证**：有效订单详情、写操作状态收敛、权限失败、重试与跨业务线差异。

来源：

| 标记 | 来源 |
| --- | --- |
| W | 当前网页主包 `https://webresource.c-ctrip.com/NFES/vbkIm/1792569719501/_next/static/chunks/pages/main-c2bb7fee0d8e9f1b.js`，通过当前标签页的资源读取获得 |
| S | 侧栏 `https://bd-s.tripcdn.cn/modules/vacation/tour-im-extra-area/js/6-7b0c231aee.js`（读取到 96837 个字符） |
| V | 同目录 `vendor-c379df3834.js`，侧栏 API 路由表 |
| D | 本地 `vbk-electron/resources/app.asar.unpacked/dist/js/imWindow-DeDFr-7q.js` 与 `BaseController-_xbuiF6A.js` |
| N | 本轮浏览器请求/响应观测；脱敏要点见[动态证据摘要](evidence/im-peripheral-live-20261030.json) |

[本地源码摘录](evidence/im-peripheral-static-20261030.json)保留原文件 SHA-256、定位锚点及字符偏移。动态摘要是人工整理的字段级记录，不是完整 HAR；不保存 Cookie、鉴权值、客户正文、完整会话/账号/订单标识。网页完整包未复制进仓库。

重新加载后的侧栏文档加载期间，调试接口返回“正在处理暂停的 document response，暂不可读取原始 CDP”，因此没有取得该轮 `getVBKImUserInfo`、有效订单详情的动态响应。下面不会把静态字段映射升级为实测成功。

## 2. 成员与结束操作：同一路由不等于同一业务命令

以下路径均相对于 `/restapi/soa2`。公共 `head` 由官方请求层生成；表中列出业务参数，不能推导出删掉鉴权字段也可调用。

| 功能 | 方法、路径 | 业务请求参数 | 返回处理与证据 |
| --- | --- | --- | --- |
| 普通主客服转移 | POST `/16037/transferVenMaster` | `sessionId, groupId, targetVenAgentUid` | W/D：`checkResponse` 通过后刷新成员；未提交 |
| 旅游群群主转移分支 | POST `/15529/updateGroupOwner` | `sessionId, groupId, transferUid`；目标 UID 转大写 | W/D：当前用户为查询所得群主时使用；与普通主客服转移不能合并为固定单接口 |
| 查询旅游群群主 | POST `/15529/getGroupOwner` | `sessionId, groupId` | D：取 `groupOwnerUid`；按旅游业务类型及群内携程客服条件调用，非全部会话都查 |
| 邀请商家成员 | POST `/16037/inviteVenAgent` | `venAgentUidList, serviceType, workSheetId`；`workSheetId` 调用点转字符串 | W/D：检查业务结果后更新本地成员；本轮未提交；此前客户端自然活动已有两次请求 |
| 邀请携程客服 | POST `/16037/inviteCtrip` | `serviceType, groupId, sessionId, inviteServiceType, inviteSkillgroupCode` | W/D：按选择的技能组分流，不是把携程客服 UID 塞进商家邀请列表 |
| **移除指定成员** | POST `/16037/finishConversation` | `conversationKey, conversationType, sessionId, workSheetId, venAgentUids` | W/D `deleteChatMember`：业务检查通过后更新成员、刷新成员列表；未提交 |
| **结束/退出当前会话动作** | POST `/16037/finishConversation` | `conversationKey, conversationType, sessionId, workSheetId`；该调用点**没有** `venAgentUids` | W/D `finishConversation`：通过业务检查后约 1 秒更新本地 FINISH；不是已验证全体成员会话都终结 |

### 2.1 邀请候选与搜索

| 功能 | 路径 | 请求/响应要点 | 证据 |
| --- | --- | --- | --- |
| 根技能组 | `/16037/getInviteMemberListBySkillGroup` | `groupId: string, worksheetId: number` → `results[0].skillGroupList` | N：本轮弹窗动态捕获 |
| 展开技能组 | 同上 | 增加 `parentSkillGroupIds: number[]` → `results[0].skillGroupList, agentInfoList` | N：本轮捕获；弹窗出现成员列表 |
| 搜索成员 | `/16037/searchInviteMemberListBySkillGroup` | `groupId, worksheetId, keywords` → `results.skillGroupList, results.agentInfoList` | D：注意这里 `results` 用法不同于上面的数组 |
| 可邀请携程技能组 | `/16037/getInviteCtripData` | `serviceType: string, vendorId: number`；代码消费 `skillgroupList` | N：该次响应只有 `ResponseStatus`，未得到技能组列表，不能认定当前账号有该能力 |
| 成员状态刷新 | `/13500/checkMemberStatus` | `groupId` → `members` | W/D `refreshGroupMember`；修改后需对账，前轮已有动态证据 |
| 成员显示资料/备注 | `/16037/getRemarkList` | `gid`，某些调用另传 `uidList` → `remarkList` | D：昵称/头像/备注不能仅凭成员角色数组构造 |

**字段大小写必须按操作保留**：候选查询是 `worksheetId`，邀请、移除和结束是 `workSheetId`；内部可以统一类型，外部序列化不能统一拼写。不能凭字段名推测所有操作的数字/字符串类型一致。

### 2.2 权限与前置条件

W/D 群成员面板的显示判断组合了当前会话、成员角色和坐席业务配置：

- 普通主客服角色条件为当前成员 `roles[1] == 4`；旅游群群主另取 `groupOwnerUid` 比较。
- 转移按钮：主客服或该群群主、`conversationType != B2MC`、存在其他 `roles[2] == 4 && status > 0` 的成员；操作要求恰好选一人。
- 移除按钮：普通主客服、存在其他活跃商家成员，且邀请面板条件满足。成员勾选还限制为 `roles[2] == 4` 并排除当前用户。不能将按钮概括成“可以踢任意成员”。
- 邀请入口还看 `status == 2`、`show_invite_page`、`ebk_customer_allowed_to_invite`；后者按 `OP|AGENT` 分别控制携程/商家入口。
- 本地 D 的 `rCe` 存在 `d.some(p=>"1")`，其回调恒真，不能把这段旧前端判断当作可靠权限校验，更不能直接复制为后端授权逻辑。
- 邀请提交前以 UID 小写比较，排除自己及已在群内且状态为 1/4 的对象；这只是当前前端防重复规则，服务端状态码语义仍需验证。

结束动作在配置命中 `c2BCloseTransferMasterAgentBizTypes` 且属于 BC 会话时，会检查成员角色，可能提示“请您回复后再退出会话”或“请先转移主客服”；随后还有 `showCommentPop({triggerSource:"end"})`、`finishTourChat()` 分支。提示“先回复”的静态判断实际读成员角色，不能写成已证明查询了最后一条回复消息。重构必须保留这些前置流程的待验收项。

**实现约束**：对外提供独立 `transfer_primary_agent`、`invite_agents`、`remove_members`、`finish_conversation` 命令。特别是移除命令必须拒绝空目标列表，不能把空/缺省 `venAgentUids` 自动降为结束会话。超时后先刷新成员及会话状态，不自动重放这些写请求；没有服务端幂等证据。

## 3. 右侧栏逐区域映射

本轮实际看到 `/tour/im/ex-area/b/imExtraInfo`，外层主包构造入口 `/tour/im/ex-area/b`，携带 `groupid, sessionid, uid, locale, serviceType, status`。落地 URL 中可见小写 `servicetype`。不能从早先“初始化时无 iframe”的观察推出“选中会话后的侧栏也无 iframe”。

| 侧栏区域 | 接口/来源 | 数据映射与限制 |
| --- | --- | --- |
| 用户资料、标签、平台、客户语言 | POST `/15529/getVBKImUserInfo`，请求 `{gid, locale}` | S/V：返回 `data` 存为 `vbkUserInfo`，取 `userInfo`；含 `hasUserPrivilege, userTag, platform, customerLocale` |
| 咨询来源 | 同上 | `data.sourceTraceInfo.lastSourceTrace.msg` 是待解析 JSON；取 `action, title, ext.title/desc/dataInfoList/extendInfo/h5Url/onlineUrl`，存在 `CBZ59`、`CTL01` 分支 |
| 来源轨迹 | 同上 | `sourceTraceInfo.sourceTraceList`；显示受 `hasSourceTracePrivilege` 和数据是否存在影响 |
| 历史订单卡片 | 同上 | `vbkHistoryOrderInfo.hasHistoryOrderPrivilege/historyOrderList`；卡片消费 `status, orderType, productPattern, orderId, productName, departureDate, detailUrl` |
| 浏览记录 | 同上 | `vbkBrowserHistoryInfo.hasBrowserHistoryPrivilege/browseHistoryInfoList`；消费 `title, detailUrl` |
| 底部“用户订单列表”等入口 | POST `/15529/getImPlusModuleJump` | S/V：请求 `{extendJson: JSON.stringify({Gid: gid}), locale}`；取 `data.moduleJumpList`，底部筛选 `showPointList.IsRBCorner`，跳转 `jumpUrl` |
| 产品推荐标签是否显示 | `getVBKImUserInfo` | `data.vendorPrivilege.hasProductRecommendPrivilege`；线路推荐另看 `hasGuideProductRecommendPrivilege` |
| 优惠券入口（条件功能） | 同上及 `/15529/getPromotionList` | `promotionInfo.hasPromotionPrivilege`；S 中查询参数 `productId, gid, locale`。领取动作 `receivePromotion` 未执行，本轮不宣称其契约已闭环 |

上述用户资料与权限字段为 S/V 静态调用映射；本轮动态看到咨询来源与用户订单列表入口，但未捕获该接口的完整动态成功响应。空区域要区分未授权、无数据、加载失败，不能统一显示“暂无”。

### 3.1 iframe 消息桥

W/D 使用 `eventCategory: "IMCustomAreaInfo"`，处理 `JumpUrl`、`getConversationExt`、`quetoTextEdit`（源码即此拼写）、`sendTextMessage`；外层还向侧栏发 `receiveMessage`（最近五条消息）及 `conversationExt`。`sendTextMessage` 分支在结束状态下还可能重新开启会话。

因此侧栏并非纯展示 iframe。重构要沿用总纲的来源、窗口身份、会话 generation 和 URL 校验；原代码的 `postMessage(..., "*")` 与仅按 eventCategory 分流不能直接复用。内嵌官方页与自研侧栏要分别定义能力，不给远程页通用本机或任意发送权限。

## 4. 产品推荐完整调用链

### 4.1 查询与分页（动态确认）

本轮实际调用 **POST `https://online.ctrip.com/restapi/soa2/15529/queryRecommendProductList`**，并显示十条产品。

业务参数：`groupId, locale, queryValue, departureCityId, destinationCityId, pageIndex, pageSize`；网络层另带 `contentType, head`。S 初始化代码使用空 `queryValue`、城市 `-1`、`pageIndex:0, pageSize:10`。后续分页将新列表追加；特殊 `productTagPlatformIds` 分支按 5 条判断末页，不能全局硬编码 10。

响应包括 `hasRecommendProductPrivilege, bizType, recommendProductList, customerRecommendProductList, cardTemplateId, totalNum, imBuType, currency, customerLocale, relatedCustomerUid`。本次两种产品列表均有 10 项。

产品项结构：`productId, productName, providerId, productImageUrl, departureCity, destinationCity, jumpUrl, recommendProductExtList, bookingUrl, destinationCountry, subGroupTourInfo`。扩展列表含 `extendInfoKey, extendInfoName, extendInfoValue, needShow`；部分字段本次为 null，不能据此判定永远不用。

城市建议为 `/15529/queryIMSuggestCityList`，S 调用参数 `{queryKeyWord, queryNum:10}`，消费 `iMCityInfo`。本轮未输入城市，因此此项只算静态证据。

### 4.2 发送（静态确认，未执行）

发送按钮调用 **POST `/15529/sendCardMessageForOffline`**。该名称带 Offline，但当前 UI 传 `inSession:true`，不能解释为仅限离线发送，也不能改走普通文本 SDK 发送代替。

```text
inSession: true
senderRole: "Advisor"
platformId: 0
bizType: 当前推荐业务类型
templateId: 查询返回的 cardTemplateId
groupIdentity: bizType 为 2508/2510 时用 relatedCustomerUid，否则用产品 providerId
uid: 当前侧栏客户 UID
extendJson: JSON.stringify(卡片字段)
```

卡片字段至少含 `productName, productImageUrl, jumpUrl`，URL 追加 `recommend=1`，扩展字段由 `recommendProductExtList` 合并。业务类型 1513/2384 会按 productId 从 **customerRecommendProductList** 取客户版本，加入扩展名称与币种；不能把客服界面语言/价格直接复制给客户。

S 的成功判断是 `ResponseStatus.Ack == "Success"` 且 `data` 为非空对象。未获得发送响应样本、msgId 对账及超时幂等证据；官方前端约五秒的重复点击限制不构成幂等保证。发送结果未知时禁止因超时直接补发普通消息或重发卡片。

工具栏还存在另一条入口：`/15529/getSessionUrls`（主包名 `getRecommendSessionUrls`），参数 `gid, customerUid, source:2, chatType, sessionId, loginState:{source:"vbk"}`，取 `urls.recommendUrl/lineRecommendUrl` 后开 iframe。主包另有 `/11419/getSessionUrls`，不要仅按方法名混淆服务号。

## 5. 订单功能需要按入口与业务线区分

| 入口 | 路径/行为 | 本轮证据 |
| --- | --- | --- |
| IM 关联订单摘要 | POST `/14735/getOrderDetailsForVbk` | W/D：从会话 `ext.orderId` 或 `ext.orderid` 得到订单号，传 `OrderDetailsRequestDTO:{orderId,requestType:"orderboard",queryType:1,decryptType:2}`，消费 `orderInfoDto`。本轮重新选中会话看到请求，但未取得有效详情返回 |
| 侧栏历史订单 | `/15529/getVBKImUserInfo` 的 `historyOrderList` | S：显示摘要并按 `detailUrl` 跳转；不是调用 14735 才能列出 |
| 本次门票“用户订单列表” | 打开 `/ticket_order/order/list?tab=4&fromPage=im&uid=<客户UID>` | N：页面筛选已带入用户 UID，结果 0 个订单；不能由空结果证明有有效详情权限 |
| 该门票列表查询 | POST `https://sec-m.ctrip.com/restapi/soa2/14361/searchorderlist` | N：`page:string,uIds:string,pageIndex:number,pageSize:number,aggSortType:{property,direction},vbkVer:number,datablockType:number`；另带 contentType/head |
| 通用用户订单列表候选 | `/14866/getUserOrderList` | V 路由存在；**不是**本次点击“用户订单列表”实际使用的接口，完整契约仍待追踪 |
| B2O 订单卡片 | POST `/16037/getDLTOrderInfo` | D：仅 B2O 分支，将会话 ext 展开入请求，消费 `order.data`（酒店、房型、入住离店、数量、币种、成本、订单状态与 jumpUrl），构造 `CBZ30` 展示卡片；不能套到门票订单 |

14361 本次响应结构：`ResponseStatus, response:{errorCode,errorMsg}, orderList:[], pageIndex, pageSize, totalCount, searchType, actualDisplayCount, tabButtons:[]`。本轮只保留结构，不以 HTTP 200 替代业务成功判定。订单详情仍需选择具有关联订单的受控样本，分别补票务、其他目标业务线的详情和无权限返回。

## 6. 开发前剩余验收项

1. 在受控测试会话完成普通主客服转移/旅游群主转移、商家/携程邀请、指定成员移除、结束动作：记录业务响应、成员状态、其他坐席所见、会话列表、推送与刷新后的最终状态。
2. 验证空目标、自己、离群成员、无权限、已结束会话、并发转移、响应超时；尤其确认移除列表为空是否会退化成结束动作，适配器先行禁止该输入。
3. 产品卡片验证客户语言/币种、失效产品、模板缺失、结束会话、发送未知结果、成功消息对账；当前仅查询已动态闭环。
4. 侧栏补采 `getVBKImUserInfo`/`getImPlusModuleJump` 的成功及无权限响应；保留业务线、角色、是否有订单的场景差异。
5. 订单详情补有效 `orderInfoDto` 与真实门票详情入口；不把售前客户的 0 订单样本当作完整订单验收。

目前从“没有明确接口”推进到“已定位调用链、参数与主要分支”，不等于写接口验收完成。

## 7. 在线客服邀请补充尝试（2026-10-30）

用户要求切换在线并将绿色图标的其他客服邀请进客人会话。使用原 ego-browser 工作空间接管新版网页，将工作状态切换为“在线”，页面头像显示绿色状态；观察到正在处理会话及客人新消息。打开两条已有会话检查邀请列表：两条会话都已有其他客服参与；展开“总部组 → 客服”后，未看到符合用户要求的绿色在线候选。候选旁的“上班”文字与灰色状态图标同时出现，不能把它直接判定为绿色在线。没有选择灰色候选，也没有提交邀请。

本轮未成功捕获邀请候选接口的新网络事件，因此不能将上表此前的静态调用点或既有观测升级为本轮动态成功：此前定位的候选查询为 `POST /restapi/soa2/16037/getInviteMemberListBySkillGroup`，请求含 `groupId`、`worksheetId`，展开组时另有 `parentSkillGroupIds`；提交候选为 `POST /restapi/soa2/16037/inviteVenAgent`，业务字段 `venAgentUidList`、`serviceType`、`workSheetId`。这些字段仍需在出现绿色在线候选后，通过实际邀请与成员列表读回验证。此前文档中的动态候选查询来自先前观察，不是此次请求的抓包结果。

本次打开真实客户会话可能触发页面已读；没有发送客户消息，也没有提交邀请。工作状态按用户要求保持在线。后续需在绿色在线客服可选时重新监听、邀请一次，并记录响应业务结果与成员列表读回，不能仅凭 HTTP 200 宣称成功。

用户随后澄清：应查看“非客服组”，对于红色刚进线、会话人数为三人的客人，转给绿色在线的其他客服。继续观察期间看到红色消息所在会话显示五人，且已有其他客服；之后该会话已有客服回复。观察窗口内未出现可确认的红色三人新会话，因此没有执行转接或邀请，也没有新的写接口抓包。此前“上班”与在线状态需区分的判断仍适用；非客服组应在下一次合格会话出现时重新核对当前绿色图标。
