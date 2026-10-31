# 官方会话列表计数与缓存口径只读核对

日期：2026-10-31，Asia/Shanghai。本次只读本机已安装的静态 JavaScript 及仓库代码，没有访问官方 API、UI、数据库、浏览器存储或登录凭据，没有读取客户会话内容或修改安装文件。下述规则不能直接解释任意一次现场计数差额，也不能证明差额都是漏会话、业务分类或缓存导致。

## 来源与定位方法

当前静态资源目录：`C:\Users\tashi\AppData\Roaming\vbk-electron\dist\js`。以下 SHA-256 本次重新计算，均与已有 [Windows 重核](2026-10-31-windows-resurvey.md) / [第5轮记录](2026-10-31-round5-windows-runtime.md) 相符。安装目录另有旧的 `app.asar.unpacked/dist/js`；本表使用当前 roaming dist 的指定字节，不混用旧文件的函数别名。

| 文件 | SHA-256 |
| --- | --- |
| `imWindow-C3Pt24cG.js` | `c4fedb4f97bb8755946c326e228b947b8078dd91e994fde3e76ddc2180737f35` |
| `index-CpM_cEEe.js` | `791902faae01b3aa66dc57f1523cf34717f0e81b78f13b0cbd2865969cc837f6` |
| `BaseController-P4oncDAK.js` | `54f29fb93e0ea5f1db906033e2bd70697a0dc555f640bd3065f635b53ecc183f` |

资源为压缩单行文件，下列偏移均为从零开始的 UTF-16 code unit 偏移，可用 JavaScript `slice` 定位；不是文件 byte offset。

## 状态、业务分栏与计数

`index-CpM_cEEe.js`：

- 偏移 1501 的 `_`：`autoActive=1`、`manualActive=2`、`finish=4`。
- 偏移 1542 的 `I`（在 imWindow 中以 `qe` 导入）：`ACTIVE.values=[1,2]`，`FINISH.values=[4]`。
- 偏移 364 的 `f(conversationType, serviceType, currentTab)`（以 `IF` 导入）：客户 `BC` 接受 `B2C/C2B/B2MC`；企业 `BOP` 接受 `B2O/O2B/B2B`。特例：类型 `O2B` 且 `serviceType='2573'` 时只归入 `BC`。

`imWindow-C3Pt24cG.js`：

| 函数 / UTF-16 偏移 | 实际条件 |
| --- | --- |
| `QOt` / 2625425 | 先对全部 `conversationList` 应用 `IF` 业务过滤，再分别对 `ACTIVE/FINISH.values` 做 `includes(row.status)`。每行计数 `a++`，未读数另累加。没有 `inGroup` 或 `isOwner` 排除条件。 |
| `QOt` 同一循环 | `inGroup==0` 的 gid 另收集用于清理按钮；这些行仍已计入状态数量。不能把清理提示解读成过滤掉会话。 |
| `$ve` / 2597847 | 实际可见列表同样先按 `IF` 业务，再按当前状态 values 过滤；`currentStar` 非零时另按 `row.star==currentStar` 过滤。置顶优先，其后按 `lastUpdateTime` 倒序。`QOt` 状态数量没有这一星标条件。 |
| `NCe` / 34174 | `INIT_CONVERSATION_LIST` 合并后只保留状态在 `[1,2,4]` 中的行。`BCe` 则是后续增量合并入口。 |

因此，这份官方桌面资源的“处理中”不是“仅 status=2 且 inGroup=1/isOwner=true”；状态 1 也计入，计数不按这两个身份字段排除。本次资源搜索未发现名为 `suppliedcache` 的列表过滤。`needTodoList:1` 出现在列表请求中；其它 `queryTodoListCount/updateToDoListCount` 仅见于通用 API 名表，不能据此推断它们参与 `QOt/$ve`。

## 官方本地历史来源与30日合并

- `imWindow-C3Pt24cG.js::getConversationList` / 2751435：首次（`latestLoopTime===undefined`）先调用 `_x.read` 读取本地列表，并通过初始化 action 展示；随后请求服务端 `getConversationList`，参数含数字 `needTodoList:1`，增量游标为 `startTime`。服务端列表非空时先写本地，再在首次路径调用 `yCe` 合并处理并重新读本地。
- `BaseController-P4oncDAK.js::yy.read` / 213673：按 `buid` 读取本地 conversation 表，并读取该 buid 的 currentStatus/lastUpdateTime 元数据。该读函数没有 LIMIT，也没有状态、`inGroup`、`isOwner` 条件；没有列表或元数据时直接返回。
- `imWindow-C3Pt24cG.js::yCe` / 26158：本地行若服务端也返回，跳过清理；服务端未返回的本地行若 `lastUpdateTime > Date.now()-30*24*60*60*1000`，保留该行，原 `inGroup==1` 时把本地该字段更新为 0；更旧的行删除。处理后再 `_x.read`，失败/无结果时才后备使用服务端结果。这里 `lastUpdateTime` 缺失默认取当前时间，不是严格保证所有保留行都有有效的近30日时间证据。

上述是缓存合并代码的条件，不是本机实际缓存行数统计。本次未读取缓存或客户资料，不能断言现场多出的完成会话具体有多少来自这一来源；也不能将它等同为“官方最多只有30天历史”。

## 当前新包对照

- [conversationList.ts](../../vbk/ui/packages/web-adapter/src/conversationList.ts) 的状态表当前只有数字 `2→active`、`4→finished`，其它状态（包括数字1）映射 `unknown`。`inGroup===1` 和 `isOwner===true` 是独立事实字段。
- [viewmodel.ts](../../vbk/ui/apps/main/viewmodel.ts) 的 `isDone` 只判断 `finished/transferred_out`；`tabCounts` 与 `filterConversations` 将其它全部状态算作处理中。因此数字1现在虽也进入处理中，但只是通过 unknown 后备，不能说已正确识别 autoActive；其它未知状态也被混入。
- 新包现有计数/列表没有官方的 BC/BOP 类型分栏；`UiConversation` 有 `service_type`，却没有可供 UI 分类的 `conversation_type`。适配器内部 `rowView` 已保存真实 `conversationType`，但展示 DTO 尚未带出。
- 新包的当轮列表与官方包含本地历史的合并列表不是已证实相同的数据集合。即使补齐业务与状态口径，也不能承诺计数立即一致。

## `ui_dropped` 的限定含义

[session.ts](../../vbk/ui/packages/web-adapter/src/session.ts) 的 SDK 入站处理每次增加 received；`sdkMessageToUi` 返回 null 时增加 `ui_dropped`。它没有原因分项。

[display.ts](../../vbk/ui/packages/web-adapter/src/display.ts) 的 `sdkMessageToUi` 会拒绝：非 `chat/groupchat`、未知/不支持的 msgtype、正文显式 `isPresent:false`、无法解析的地址、无有效消息时间。`uiKindOf` 支持 0/1/3/5/2/7/1007/1009；例如音频4、位置6以及其它控制/已读类型不在此展示集合。因此 dropped 可能包含协议过滤，也可能包含不支持的业务消息或畸形数据，不能全部称为协议帧或漏消息。本次不新增诊断功能。

## 业务口径 UI 实现（独立9731e00快照）

以上“当前新包对照”记录修复前的调查状态。本 UI 补丁加入客人、企业、类型待核对三个业务分栏，按上述官方类型条件分流；业务内单独显示处理中、已完成、待核对数量及列表。缺失/null/未知类型的行进入类型待核对，即使状态 active/finished 也不混入客人或企业计数；已知类型的 unknown 状态只进入待核对。保留既有 transferred_out 的完成分类与 `isDone` 操作边界，不猜测其上游数字状态。

切业务只修改本地 business/tab，保留当前会话、编辑内容和逐会话草稿，文案明确“仅筛选列表，当前会话和草稿保留”；用户仍须明确点击其它行才打开会话。同 owner 的账号元数据广播不重置分栏，真实 owner 切换按既有账号隔离入口复位客人/处理中。搜索只影响行，不改变该业务的状态数量。没有改动加载合并、已读保护、时钟或消息发送逻辑。

展示契约固定为 `conversation_type?: string | null`，旧 DTO 仍合法但不猜为客人。UI guard 接受缺失/null/未知短字符串；提供的字符串必须非空非纯空白、UTF-16长度不超过64且无U+0000..001F/U+007F..009F控制字符。有效值不trim或改大小写，因此 ` B2C ` 仍为未知类型。新 adapter producer/host 透传及数字1的 active 映射由独立数据补丁完成，不能仅凭本 UI 补丁声称链路整体部署。mock 新会话明确使用合成 B2C 类型与1513业务号。

独立目录：`%TEMP%\vbk-windows-20261031\r7-conversation-business-ui-9731e00`；日志位于该 TEMP 根目录：

- `r7-conversation-business-ui-before.log`：原代码4项实际入口/guard回归真红，exit1，包括处理中7被误当作预期2及缺少业务入口。
- `r7-conversation-business-ui-after.log`：新增6项加原guard/viewmodel，共32/32、exit0；覆盖类型矩阵/2573特例、状态/unknown、搜索、实际业务按钮与账号快照回调、草稿保留及无IPC/自动开会话。
- `r7-conversation-business-ui-fault.log`：临时源文件仅注入“切业务清空草稿”，真实按钮回归再次失败、exit1；生产源未被故障覆盖。
- `r7-conversation-business-ui-all.log`：完整UI628/628、exit0，无skip/todo；`r7-conversation-business-ui-typecheck.log`：exit0。联合应用数据侧 `r7-business-ts-seam.patch` 三源字段/状态补丁后，真实producer数字1/2/4/99 → guard → scoped counts 回归通过；`r7-conversation-business-ui-joint-all.log` 完整629/629、exit0，`r7-conversation-business-ui-joint-typecheck.log` exit0。联合范围仅TypeScript接缝，host验证由数据侧另记。

没有读取真实客户数据、调用真实API、原生UI或发送消息；未实现或重放官方本地缓存。修正分类口径不能证明现场计数差额已经消除。
