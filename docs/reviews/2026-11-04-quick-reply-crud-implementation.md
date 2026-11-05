# I-26 个人快捷回复 CRUD：契约与实现准备

## 决策摘要

范围限定为已实际操作过的个人 VAGENT 快捷回复：新增个人根分类、在现有个人分类中新增话术、编辑/删除话术、删除空分类。团队 VSKILLGROUP 写入、分类改名/移动/排序、话术排序不纳入本轮。

现有证据足以实现新增/编辑/删除话术及删除空分类的**受限个人流程**，前提是数值 ID 可无损安全转换，并且写后必须用 getCategories 读回。新增根分类目前不能完整实现：抓取只留下 type:string 和 status:string，没有实际取值，不能从现有 QUICK_REPLY_STATUS='ACTIVE' 推导创建接口的 status，也不能猜 type。另一个接线缺口是 web adapter 已解析分类 code，但当前 IPC DTO 丢弃了它；新增话术需要 categoryCode。

本地契约目录仍标记全项目 implementationReady=false；以下只说明 I-26 这几个个人端点的现有证据边界，不改变项目级准入结论。[readiness](../api/readiness.md)

## 已观测契约

五个写端点都是 POST https://m.ctrip.com/restapi/soa2/16037/{method}。下表的 head 必须继续由当前账号页面上下文生成；不得从 UI 传入、固定保存或记录真实认证字段。字段和类型来自[浏览器验证摘要](../research/2026-10-30-browser-api-validation.md#L66)及[脱敏接口结构](../research/evidence/browser-api-validation-20261030.json)；结构文件中的值是类型占位符，不含真实 payload 值。

| 操作 | 已观测业务字段（另加动态 head） | 捕获响应结构 | 已验证读回 | 限制 |
| --- | --- | --- | --- | --- |
| 创建根分类 createRootCategory | name:string, type:string, status:string, ownerType:"VAGENT", vSkillGroupIds:[] | ResponseStatus.Ack="Success"; category 含 id:number, code:string, name, type, status, ownerType:number 等 | 刷新 getCategories 后临时个人分类出现 | **阻塞**：type、status 的实值未记录；不得猜测 |
| 新增话术 addCustomerScript | content:string, ownerType:3, categoryCode:string | Ack="Success"; 顶层 id:number 与 customerScript{id:number,content,type,sortNo} | 数量 0→1，展开分类能读到正文 | 当前 UI IPC 分类 DTO 缺 code，需补字段 |
| 编辑话术 updateCustomerScript | content:string, id:string | Ack="Success"，没有其他业务字段 | getCategories 中同一 ID 的正文更新 | request schema 将 ID 标为 string；保留字符串，不转 number |
| 删除话术 deleteCustomerScript | id:number | Ack="Success" | 数量 1→0 | 现有 UI ID 是 decimal string；仅在无损 Number.isSafeInteger 时允许转换，否则拒绝并要求补证 |
| 删除分类 deleteCategory | id:number, ownerType:3 | Ack="Success" | getCategories 不再有该分类 | 仅允许空分类；分类 ID 同样需要安全整数检查 |

> 备注（2026-11-05 追加，原文不改）：上表 createRootCategory 的 type、status 阻塞已由 2026-11-05 对官方桌面客户端渲染层的静态逆向补齐，值为 `type:"CUSTOMSCRIPT"`、`status:"ACTIVE"`（`ownerType` 传字符串 type）。证据级别为静态调用点，无实机样本；其余改名、移动、排序、团队写等见[快捷回复分组管理决定](../decisions/2026-11-05-quick-reply-manage.md)与[端点契约](../api/quick-reply-manage.md)。

已验证 ownerType 的接口差异：创建根分类传字符串 "VAGENT"；新增话术和删分类传数字 3；编辑/删话术请求不含该字段。不要统一成单一表示。getCategories 的读请求为 typeList:["VAGENT"], categoryType:"CUSTOMSCRIPT", status:"ACTIVE"；该查询常量不能代替创建请求的 status。

### 成功、失败与权限证据

- 五个端点的脱敏 response schema 都记录 ResponseStatus.Ack="Success"。没有这些 CRUD 端点的 Ack Failure、业务拒绝、超时或权限失败样本；该结构也没有 bizResponseStatus。因此 Ack 只能说明收到成功 ACK，完成状态仍须以读回为准。
- 正向实际读回已覆盖：临时分类创建后出现、话术新增后计数和正文出现、编辑后正文变化、删除话术后数量下降、删除空分类后分类消失。一次完整个人流程最后恢复到原有默认八条。证据在[浏览器验证摘要](../research/2026-10-30-browser-api-validation.md#L15)和该文件 §2.3。
- 当前 SoaClient 将写请求 timeout/network error 归为 unknown 且不重试；读请求才允许 transport retry。[soa.ts](../../vbk/ui/packages/web-adapter/src/soa.ts#L193) 实现端还应把已提交后收到的 malformed/HTTP 非 2xx 当作**结果不确定**处理，先读回、绝不自动补发；当前 outcomeError 对 http_error 标成 retryable，不能原样透传给 CRUD UI 形成重试按钮。
- 已有材料只证明一个已登录个人账号完成上述流程。静态设置调查记载个人 VAGENT、团队 VSKILLGROUP，并记载团队编辑入口要求 jobPosition == "LEADER"；这不是个人写权限的服务端证明，也不能据此开放团队写入。[agent-status-and-settings](../research/2026-10-30-agent-status-and-settings.md#L56)
- I-26 固定为个人模式：UI 写操作只针对 VAGENT，适配器/host 固定请求类型与 ownerType，不接受调用方指定 VSKILLGROUP/任意 ownerType。保留上游拒绝结果并显示；当前没有权限错误的已知字段/映射，不能伪装为已支持的权限模型。

## 可直接采用的端到端方案

1. **IPC DTO 补齐数据。** UiQuickReplyCategory 增加 code:string|null，rpc.ts 的 categoryToUi 传出 web-adapter 已解析的 code。保持 id 以 decimal string 跨 IPC；按端点序列化时再执行各自类型检查。请求 addCustomerScript 必须从分类 code 取 categoryCode，不能拿分类 id 替代。
2. **建立窄的个人写操作。** 暴露五个有固定操作名的 commands/adapter ops；UI 不传 URL、head、type/status、ownerType 或任意 method。参数只含必要的 account、分类/话术 ID、目标文本。创建分类在 type/status 实值补齐前保持禁用。
3. **适配器写后读回。** endpoint 规格标记 write，body 由当前页面的 businessHead 构造。ACK 后执行 getCategories(typeList:["VAGENT"])：新增分类凭响应 category.code 与读回分类核对；新增/编辑凭脚本 ID 与正文核对；删除凭目标 ID 缺席核对。若 ACK 缺字段或无法唯一核对，报告 unknown，不按名称猜测或再写一次。
4. **不确定结果不重放。** timeout、network error、malformed response、HTTP error 都转成 UI 可表达的 unknown，自动只读刷新。读回能唯一证明目标状态时显示已应用；读回失败或仍无法判定时保持 unknown，提供用户查看/刷新路径，不提供“自动重试”。明确业务 Ack Failure 作为已拒绝失败返回，不重试。host generation/account 校验失败也不继续处理旧账号结果。
5. **删除保护。** 删除话术前展示内容与分类；删除分类前展示名称，并且只有读回分类确为空（无 scripts、无子分类）才允许继续。执行按钮需二次确认；删除后再读回确认缺席。UI 锁住当前账号下正在执行的操作，阻止双击并发。
6. **快捷回复面板隔离 scope。** 当前 ReplyScope 含 gid/revision，但个人快捷回复是账号设置。管理状态按 {environment, account_id, session_generation} 绑定；切账号/登录代次变化立即丢弃未完成 UI 状态。不要把当前会话 GID 冒充设置写的业务标识。

### peripheral_journal 是否复用

可复用的是原则与安全组件：发请求前登记 intent、写期间不持锁等待、account namespace、持久化前后阶段、uncertain 形成不可自动重放的 tombstone。当前 PeripheralJournal 的 Intent 强绑定 gid + Action + targets + selection_token，barrier 又按房间/动作设计，不能直接拿来写快捷回复，也不能伪造 GID/token 规避结构。[peripheral_journal.rs](../../vbk/src-tauri/src/peripheral_journal.rs#L20)

若 I-26 只要求**本次运行内** timeout 不自动重发，可沿用 SoaClient 的 write no-retry，加账号级 in-flight guard、unknown 后只读核对；这不提供崩溃/重启后的 at-most-once 保障。若要与 peripheral_journal 一样跨重启防重放，应另建 account-scoped settings journal（不含 GID；以动作、decimal ID/categoryCode 和目标内容摘要形成 intent，持久化敏感内容前还要做数据最小化审查），而不是扩造现有房间 journal。是否要求这一级持久化是实现前唯一的架构取舍之一。

## 接线位置与独占文件划分建议

为了下轮可并行，实现前由 root 先冻结 command/op/DTO 名称；每组只改自己一组文件，避免共享接线文件。

| Owner | 独占文件/责任 |
| --- | --- |
| A. IPC + Tauri host | vbk/ui/packages/ipc/src/client.ts, adapterProtocol.ts; vbk/src-tauri/src/adapter.rs, lib.rs, views.rs; vbk/src-tauri/commands.txt, capabilities/main.json。添加五个窄 command/op、DTO、固定个人 scope、guard/ui_account、写 timeout、await 后账号代次复核；只授权 main window。不要接收或暴露任意 SOA 地址/body。 |
| B. web adapter | vbk/ui/packages/web-adapter/src/endpoints.ts, settings.ts, rpc.ts 及其 quick-reply adapter tests。定义五个独立 endpoint 与精确 payload；保留 ID 端点类型；执行 ACK + getCategories 读回分类；unknown 不自动重试。只实现个人 VAGENT。 |
| C. UI + mock | vbk/ui/apps/main/quick-replies.ts, main.ts, quick-replies.test.ts, styles.css; vbk/ui/packages/ipc/src/mock.ts, quick-replies.test.ts; vbk/ui/packages/ui-kit/src/replies-recommend/strings.ts。新增个人管理 UI、创建/编辑表单、删操作确认、unknown 刷新提示、mock 读写与状态测试；不出现团队写按钮。 |

这套拆分把 IPC DTO 与 host registrations 放在一个 owner，adapter 只依赖冻结的 operation contract，UI/mock 独立。contract-consistency.test.ts 已要求 commands.txt、Tauri handler、IPC command maps、role lists 与 capability 权限一致；新增写命令还应纳入 views.rs 的 main-only 测试。它是必要接线门禁，不代替上述 payload/读回测试。

## 开始实现前的最少待决项

1. **补取值（阻断根分类创建）：** 从已归档的实际 createRootCategory request 取出 type 和 status 的精确值；若归档无值，再经授权的契约采集补齐。不得暂时填 "VAGENT"、"ACTIVE" 或其他猜测值。
2. **安全 ID 范围：** 是否接受只操作 Number.isSafeInteger 的删除 ID，并对范围外 ID fail closed？如需支持任意长度 decimal ID，需补获数字 ID 的安全线/官方字符串接受证据，不能经 JS number 静默舍入。编辑按已记录的 string ID 编码。
3. **持久化边界：** 第一版是否要求 timeout/崩溃后仍由 durable journal 阻止同一业务意图自动重放？建议本轮至少做到当前运行 unknown + 只读核对；如果要求跨重启，需要单独设计 account-scoped settings journal 后再分工。

权限失败字段/错误映射、服务端字段长度限制、成功以外的每个错误分支都没有可靠样本；实现需 fail closed，不凭空定义服务端限制或用 Ack/HTTP 200 单独宣称完成。
