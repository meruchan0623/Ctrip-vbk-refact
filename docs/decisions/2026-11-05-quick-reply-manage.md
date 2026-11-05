# 快捷回复分组管理与设置窗口重构

2026-11-05，Asia/Singapore。状态：用户已确认取舍；代码落盘不等于验收，实机核对见“证据边界”。

## 背景

官方个人设置弹窗的快捷回复页有分组管理（新建、改名、删除、移动话术、拖拽排序），本项目以前只能读。对客选择时分组名只是卡片上的一个标签，没有分组入口。设置窗口原有 9 个分区，其中多项只存储不生效、只读展示，与 I-20 验收（设置页不得出现只存储不生效的开关）冲突。

静态依据来自官方桌面客户端渲染层，端点结构见[端点契约](../api/quick-reply-manage.md)。

## 决定

- 个人（VAGENT）和团队（VSKILLGROUP）快捷回复都可以管理。团队只有组长可写：`venAgent.jobPosition == "LEADER"`，否则 fail closed，拒绝为 `not_leader`，不发写请求。
- 删除分组时连同其中的话术一起删除，与官方行为一致；前端二次确认写明话术条数。
- 功能完整对齐官方：增删改、分组改名、话术移动到其他分组、分组排序、话术排序（两种拖拽排序）。
- 管理入口有两个，共用一份组件：对客快捷回复弹层的“设置”，以及设置窗口的“快捷回复”分区。
- 对客选择时弹层左侧新增分组列，只显示分组名，默认“全部”；搜索时回到“全部”。插入行为不变，只追加到草稿，不自动发送。

## 写入规则

- **写前读取**：每次写之前先读 `getCategories`。分组 `code`、`ownerType`、话术原内容都从这次读取得到，不接受 UI 传入。找不到目标时返回 `rejected('stale')`，不发写请求。head、type、status 同样由适配器从页面上下文与固定常量得到。
- **只对根分组新增、移动、话术排序**：管理组件只列出根分组，新增话术、移动目标、话术排序的分组 id 若指向子分组，按 `stale` 拒绝，不发请求。删除分组仍覆盖整棵子树。
- **团队检查**：团队类型的写前还要读 `getVenAgentByUid` 取 `jobPosition`。
- **一次一个写请求，不重试**。
- **写后读回**：写后再读 `getCategories`，按操作核对：
  - 改名、编辑：同一 id 的值已更新；
  - 移动：话术 id 出现在目标分组下；
  - 删除：id 已不存在；删除分组时其下子分组与全部话术也都不存在；
  - 排序：读回顺序与提交顺序一致；
  - 新增分组、新增话术：见下条；团队新建分组还要求读回的适用范围与提交一致。
  读回索引遇到无法解析或重复的 id、超出显示深度、扫描超过 5000 行时标记为不完整：不完整的读回无法证明删除的“缺席”和排序的“顺序”，一律判 `unknown`；不完整的写前读取无法判断哪个 id 是新出现的，新增也判 `unknown`；写前读取不完整时排序直接拒绝（`stale`），不发请求。
- **新增不读响应体**：createRootCategory 与 addCustomerScript 的响应体不读取，官方也不读。核对靠“写前写后新出现的 id，加名称或内容一致”。写请求已应答时至少一条匹配即可；写请求未应答（超时、网络、HTTP 错误）时必须恰好一条，出现两条以上无法区分是否被重放，判 `unknown`。
- **结果三态**：`applied` / `rejected` / `unknown`。
  - `rejected` 只有两种来源：Ack 为 `Failure`；或响应带非 `SUCCESS` 业务结果码，**且**读回证明目标与写前完全一致。“完全一致”按操作定义：新增要求写前写后都完整且没有新行；改名要求名称与适用范围都未变；删除要求目标与其子树全部仍在；排序要求读回完整且顺序与写前相同；移动要求读回完整且话术仍在原分组。读回不完整、或只改了一部分（例如改名生效而范围未变），都不算未改动。
  - Ack 既不是 `Success` 也不是 `Failure`（如 `Warning`）时不当作拒绝，进入读回核对。
  - 写请求 timeout、network、http_error、malformed，以及读回无法证实，都是 `unknown`。写请求发出后适配器内部异常，同样返回 `unknown`，不会变成页面错误。
  - `detail` 只携带短机器码（字母数字与 `_.:-`，最长 64），不带服务端文案。**`unknown` 持久提示、不重发**，UI 用读回列表覆盖并提示“结果未确认，请核对”，不提供重试按钮。写前阶段（读取、组长检查）超时说明尚未提交，返回 `rejected('not_submitted')`。
- **宿主对页面错误的处理**：宿主只在两种情况下把错误原样交给 UI（UI 会提供重试）：请求没有发给页面；或页面在分派处理函数之前就拒绝（`ADAPTER_NOT_READY`、`HOST_UNSUPPORTED`）。其余页面错误都可能发生在写之后，统一记为 `unknown('write_unknown')`。回复格式非法同样记为 `unknown`。
- **代次变化时保守处理**：请求在途期间账号会话代次变化，无论页面返回什么都改记为 `unknown`，不附带列表（`unknown` 保留原 reason），UI 重新读取。这个结果属于界面已不再显示的会话，不能当作终局。
- **并发**：每个账号页面同时只允许一个写操作，第二个请求返回 `rejected('busy')`。写请求超时后适配器虽已返回 `unknown`，原始 HTTP 请求可能仍在进行（`raceTimeout` 不会中止 fetch），因此写锁保持到原始请求结束，最长 60s；否则下一次写可能先于上一次落地。
- **时间预算**：前置读取（写前读取、组长检查、技能组）并行，各 3s；写 6s；读回 3s。读请求遇传输错误会重试一次，最坏 2×3 + 6 + 2×3 = 18s，在宿主等待上限 20s 之内。
- **适用范围原样保留**：编辑团队分组时，分组自身已有、但组长技能组列表未列出的范围项仍可保留，按写前读取到的原值发送；两边都没有的 id 判 `stale`。
- **删除确认的条数**：适配器在解析时为每个分组统计服务端原始话术行数 `script_total`（含空白行与超出 1000 条显示预算的行，深度上限 8、节点上限 5000），删除确认优先显示它；缺失或小于列表条数时退回列表条数。
- **ID 与边界**：转 number 前用 `Number.isSafeInteger`，超出直接返回 `rejected('stale')`，不发请求。宿主入口先校验：ID 为 1–19 位十进制数；分组名 trim 后 1–15 个 UTF-16 单元；话术非空且不超过 5000（按 UTF-16 计）；ID 列表不超过 1000；个人类型 `skill_group_ids` 必须为空，团队必须非空。
- 管理命令不写主窗口的焦点账号，设置窗口调用不会改动主窗口当前账号。

## 请求体

均在业务字段外另带由页面上下文生成的 `head`，UI 不传。完整说明见[端点契约](../api/quick-reply-manage.md)。

| 操作 | 端点 | 业务字段与类型 |
| --- | --- | --- |
| 新建分组 | createRootCategory | `name:string`，`type:"CUSTOMSCRIPT"`，`status:"ACTIVE"`，`ownerType:string`（类型名，`VAGENT` 或 `VSKILLGROUP`），`vSkillGroupIds:array`（个人为空） |
| 编辑分组 | updateCategory | `id:number`，`name:string`，`status:"ACTIVE"`，`vSkillGroupIds:array` |
| 删除分组 | deleteCategory | `id:number`，`ownerType`（原样回显写前读取值，行内没有时省略） |
| 分组排序 | updateCategorySortNo | `categorySortList:[{id:number, sortNo:number}]`，`sortNo` 取数组下标 |
| 新增话术 | addCustomerScript | `content:string`，`ownerType`（原样回显写前读取值，行内没有时省略），`categoryCode:string`（分组 `code`） |
| 编辑话术 | updateCustomerScript | `id:string`，`content:string` |
| 移动话术 | updateCustomerScript | `id:string`，`content:string`（读回原内容），`categoryCode:string`（目标分组 `code`） |
| 删除话术 | deleteCustomerScript | `id:number` |
| 话术排序 | updateCustomerScriptSort | `sortInfos:[{id:number, sortNo:number}]`，`sortNo` 取数组下标 |

另有只读 `getSkillGroupInfoByVenAgent`（`agentUid:string`，值为 buid 而非 IM uid），返回 `vskillGroupInfos[]{skillGroupId, skillGroupName}`，用于团队分组表单“适用范围”的必填多选。

两种 ownerType 表示不得合并：createRootCategory 用字符串，addCustomerScript 与 deleteCategory 原样回显读回分类的 `ownerType`（目前观测到的是数字）。官方写法是 `ownerType: category.ownerType`，适配器不做类型转换，这样服务端若改用其他表示也不会被本地改写。updateCustomerScript 的 `id` 用字符串，其余删除、编辑、排序接口的 ID 用 number。

## 证据边界

9 个端点全部只有静态证据（官方桌面客户端渲染层的静态调用点），没有实机样本。个人 VAGENT 的新建、新增话术、编辑话术、删除话术、删除空分组在 2026-10-30 有过实机读回（见 I-26 评审文档），但本次请求体仍以静态调用点为准。

以下行为只有静态证据，首次使用需要实机核对，**实机读回之前不能称为已验收**：

- 分组改名；
- 话术移动；
- 分组排序、话术排序（两种排序）；
- 团队写入；
- 非空分组删除（服务端是否连带删除话术，以及其读回）。

在真实账号上做写操作属于出站操作，需要用户另行授权，使用临时分组并在操作后恢复原状。忙账号禁止代理执行。本轮不包含实机核对。

## 设置窗口重构

设置窗口保留单页长滚动加 scroll-spy。左侧导航分两组：“账号业务”（只有快捷回复）与“桌面偏好”（其余各项）。

- **新分区**（顺序）：`quick_replies`、`general`、`notify`、`keys`、`assistant`、`about`。
  - `quick_replies`：账号选择器加共享管理组件，末尾是“其他个人设置（网页）”入口；
  - `general`：开机自启、关闭主窗口行为、显示消息时间、界面缩放（并入原 display）；
  - `notify`：超时提醒、勿扰、托盘与任务栏；
  - `keys`：发送键、显示/隐藏主窗口快捷键；
  - `assistant`：商家助手总开关、出站翻译、套餐速览、TSim 账号（`send_mode` 仍只在输入栏设置）；
  - `about`：版本与检查更新、IM 连接状态与系统代理（原 network）、数据目录（原 storage）、导出诊断包（原 privacy）。
- **删除的偏好字段**：`general.start_hidden`、`general.spell_check`、`display.gpu`，以及整个 `storage`、`privacy` 分区。这些项只存不用或只读展示。界面上对应的只读行（GPU、缓存、“不写入磁盘”、埋点/崩溃上传“未启用”）一并删除。
- **兼容**：沿用 `keys.screenshot` 删除时的做法。旧 `prefs.json` 里的这些键读取时静默忽略，不触发留底副本，下次保存时消失。
- **深链旧分区名归一化**：`display`→`general`；`network`、`storage`、`privacy`→`about`。解析与运行期分发共用同一个归一化函数。
- **不升 `CONTRACT_VERSION`**：PrefsSnapshot 只定义在 `ui/packages/ipc/src/client.ts` 与宿主 `prefs.rs`，不属于 `crates/contracts`，不影响跨窗口契约版本握手。此前删 `keys.screenshot` 时同样没有升版。TS 侧的 `isPrefsSnapshot` 守卫、类型与 mock 必须同步，否则设置页会拒绝新快照。
