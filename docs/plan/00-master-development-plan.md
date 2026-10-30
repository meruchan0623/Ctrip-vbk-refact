<<<<<<< Updated upstream
# 当前开发计划：网页 IM 与独立强提醒

2026-10-30。状态：设计收敛完成，原型与业务验收未完成。范围以[决定](../decisions/2026-10-30-web-only-scope.md)为准。

## 1. 交付目标

网页已有的消息、通知、对应客服设置与“订单详情 → IM 联系 → 网页会话”，加上一个独立回复超时强提醒窗口。旧全面桌面重构工作包与工期失效，不按旧编号恢复任务。

## 2. 开发顺序

**G0 接口契约准入先于下面全部实现任务**：遵循用户 2026-10-30 的最新要求，拿到所有必要接口请求要素后才开始开发。先补齐并核对 [Header、Authentication、HTTP 方法、Query、完整嵌套 Body 与动态字段来源](../api/README.md)，未闭环项见 [准入清单](../api/readiness.md)。本轮只允许采集、契约整理与最小验证工具，不以文档或抓包计数替代通过，也不提前进入客户端业务实现。

| 任务 | 交付物 | 验收关口 |
| --- | --- | --- |
| P0 网页接入原型 | 最小宿主、官方登录与 Web 消息适配 | 当前身份、实时/历史/补偿事件可区分；后台接入可运行，无通用本机权限暴露 |
| P1 消息事实 | 去重、回执、会话/角色、unknown 状态与恢复 | 受控收发、断网补偿、迟到回调、重复与乱序不丢失不串身份 |
| P2 独立强提醒 | Rust 等待轮次与期限队列、单例 alarm、点击导航 | 满 30 秒可见且不抢焦点，连续客户消息不重置起点，确认回复才清除 |
| P3 网页必要操作 | 通知与设置、订单“详情 → IM 联系”、已开放 IM 控件 | 具体入口/角色/字段/业务结果及 UI 读回；无权限与失败可辨识 |
| P5 自有能力 | 多账号隔离、托盘/任务栏、商家助手、截图/OCR、更新与诊断 | 按各模块设计与归档验收项 |
| P4 故障与交付验证 | 脱敏证据与可运行候选包 | 隐藏/最小化、睡眠、重启、登录失效、恢复对账和窗口位置/焦点通过 |

独立窗口不等待所有网页边际控件完成；P0/P1 是其必须的数据基础。网页路线原型失败则记录具体阻塞，不扩大成另一套桌面移植。

## 3. 明确不排期

只取消携程业务模块：首页、工作台、事件、公告、商服、产品、数据、点评、完整订单管理（确认、退款、核销、导出）。桌面 SDK sidecar 与原生协议重写也不排期。

本项目自有功能保留并排期：多账号（P5）、托盘与任务栏（P5）、商家助手与截图/OCR（见[分计划 04](04-media-and-assistant.md)）、客户端更新与诊断（P5）。网页静态代码中有接口但目标 UI 未开放的携程功能不自动排期。

## 4. 分计划

- [01 身份与最小基础](01-foundation-account-data.md)
- [02 网页 IM 与必要业务](02-im-and-service-operations.md)
- [03 独立强提醒](03-shell-business-notification.md)
- [04 媒体工具与商家助手](04-media-and-assistant.md)
- [05 当前验收](05-release-validation.md)
- [前端原型删减清单](2026-10-30-frontend-prototype-pruning.md)

任务完成须有代码、具体网页版本、受控样本和实际结果，不能把本计划或既有自然流量观测当成验收。调度由执行时决定，不要求创建固定数量代理。

旧主计划与原始细分工作包保留在[历史归档](../archive/desktop-baseline/plan/00-master-development-plan.md)，不进入当前验收或工作量承诺。
=======
# 携程旅游商家客户端重构：总和开发计划

2026-10-30 · Asia/Singapore · 文档版本 1.0 · 基线提交 `7b6b202`

**用途：作为多子代理并行开发的统一派工入口。** 本文包含范围、架构约束、共享契约、文件归属、依赖调度、完整任务包、验收关口和审查记录。任务细节已汇入正文，无需在五份分片之间来回拼接。交付格式为仓库 Markdown。

**当前状态：计划已编制，产品尚未实现；G1–G5 尚未通过运行验收。** 所有开发任务初始为 `planned`。本轮只编制与审查计划，不运行生产写接口，不发送客户消息，不部署，不提交或推送 Git。

## 阅读与执行入口

1. 主代理先读第 1–8 节，冻结本次开发批次和文件租约；不要一次启动所有模块。
2. 开发子代理读取自己的任务正文、公共契约和源证据；只消费已合入的接口版本。
3. 独立审查代理使用第 8 节和第五部分 QA 矩阵提出可复现反例；主代理修正后再复核。
4. 五个详细部分依次为：基础／账号／数据／网络；IM／客服操作／界面；桌面壳／业务页／提醒；媒体／助手；发布／验证／macOS。

| 原始依据 | 用途 |
| --- | --- |
| [开发总纲](../dev/00-architecture.md)及其 01–10 模块文档 | 技术设计与现有公共约束 |
| [开发前最终审查](../reviews/2026-10-30-final-adversarial-review.md) | 已知设计反例、证据边界和 G1–G5 |
| [IM 传输决策](../decisions/2026-10-30-im-transport.md) | Web B1 / Node C 的可替换路线 |
| [边际接口调查](../research/2026-10-30-im-peripheral-apis.md)、[客服状态与设置](../research/2026-10-30-agent-status-and-settings.md) | 转接、成员、结束、侧栏、推荐、订单、状态与个人设置 |
| [网页观测](../research/2026-10-30-web-im-observation.md)、[桌面观测](../observations/2026-10-30-desktop-runtime.md) | 已观测事实及尚未证明的能力 |

本文是**执行计划**：任务和调度以本文为准；源调查仍决定事实的证据强度。第 7 节列明的消歧取代旧条款；未列出的新冲突先提交契约变更，不由任一代理私下择取有利版本。五份 `01`–`05` 分片保留为编制材料，后续派工与审查以本汇总稿为准，避免维护两套任务真相。

## 1. 目标与范围

从客服真实工作出发，交付目标是：账号不会串用、消息结果可信、异常后可恢复、待回复不会被误清、业务操作有明确反馈、本地唯一数据不丢失。在这些条件成立后，再验证资源占用和操作效率收益。

首选候选为 **Tauri 2 + Rust，Windows 先行，macOS 后续独立验收**。前端采用总纲的 Vite 多入口与共享 UI/IPC 包；FND-01 锁定具体依赖版本，实施者届时查官方支持文档并留下版本证据。本计划不把当前未运行的框架或 SDK 组合写成已兼容。

| 范围 | 本计划承接的内容 | 完成边界 |
| --- | --- | --- |
| 基础能力 | 工程、命令权限、身份生命周期、Profile、Cookie、凭据、存储、HTTP、多栈代理、时间源 | 多账号与迟到回调正确，持久状态可恢复 |
| IM 核心 | 文本、附件、引用、撤回、回执、已读、输入状态、历史、草稿、入站翻译、同步和 outbox | 发送确认与 unknown 分明；分页完整性有证据 |
| 客服操作 | 上下线等状态、个人设置、快捷回复、转主客服、邀请/移除成员、结束/退出会话、侧栏、推荐与订单 | 每个方法独立有权限、成功/失败、回读与超时语义 |
| 桌面能力 | 壳、托盘、窗口、八业务入口（规范入口data，bi为同一入口别名）、桥、通知、强提醒、截图、下载、预览 | 安全模式下逐入口验证；脏页和后台身份受保护 |
| 商家助手 | 官方出站翻译、语言建议、TSim 身份/权限、翻译、套餐速览与订单面板 | 身份分域；旧结果不能覆盖草稿或发送到错误会话 |
| 交付能力 | 偏好、多语言、诊断、签名更新、安装、迁移/备份/恢复、性能、macOS | 固定产物与平台的实际证据支撑所声明范围 |

不在本次承诺中：Rust 原生 XMPP、跨设备草稿同步、未定义的总结服务、自动并入 `tsim_cs`、替用户发送业务消息、未经验证的热更新。整合进 `tsim_cs` 属于后续适配决策；本次保留领域与宿主分离的边界，不同时建设第二套产品。

OCR、ONNX 纠错和 TSim 自动免登录属于条件能力；失败时可关闭，但必须在版本范围清单显式说明。完整需求不能由执行代理为了消除阻塞而自行删减。

## 2. 第一性原理与禁止破坏的不变量

1. **身份不可随界面漂移。** 持久身份是 `(environment, account_id)`；短期授权是 `session_generation`，另有登录 attempt、凭据 revision 和视图 generation。它们分别管理不同竞争，不能合并为“当前账号”。
2. **外发不是普通函数重试。** 先持久化意图再提交；超时可能已生效。消息、转接、成员操作、设置与结束均保留 confirmed/rejected/unknown，不以 HTTP200 或 UI 乐观展示作为业务成功。
3. **可见最新不等于完整。** 每页断点与整轮完整水位分离；只有已证实整轮终止条件才推进完整水位；入库失败不发布成功或推进水位。
4. **提醒消费事实。** core-im 持有待回复轮次和首次 T1；core-net 提供时钟；core-notify 决定表现。打开、已读、收起、回复、责任转移、结束各自建模。
5. **持久化先于成功事件。** Store 显式事务返回提交事实；订阅先建立并缓冲，再获取同流快照重放。越权或旧代次的数据不能靠广播过滤补救。
6. **资源访问与资源保留分开。** 登出撤销访问，不能因此删除仍被草稿或 unknown outbox 引用的附件。恢复旧库不能触发自动重发。
7. **兼容不能换走边界。** 不关闭 TLS、CSP、站点隔离；远程页面无通用 IPC；特殊桥逐来源、文档代次、命令、对象授权。
8. **平台结论以目标产物为准。** 浏览器已有登录和自然入站只支持对应观测；不能替代 WebView2、正式安装、后台恢复和受控写入验证。

## 3. 公共契约与统一名称

FND-02 先合入最小 v0 接口，稳定的领域部分与模拟服务可先实现；未决平台适配器按关口逐项冻结。主代理发布版本及消费者列表，代理不得复制私有 DTO 或手改生成类型。

| 契约 | 权威 owner | 关键约束与消费者 |
| --- | --- | --- |
| AccountContext / ConversationRef / ViewContext | 集成定义；Account/Shell 提供事实 | 来源由核心推导；所有网络、存储、UI、媒体和助手消费 |
| LoginAttemptHandle / ProfileLease / ViewLease | Account + Shell，集成定类型 | account 管身份/撤销，shell 管控制器与视图；未验证 attempt 只调用身份验证端点 |
| EventEnvelope / Snapshot | 集成 | scope/stream/epoch/seq；定向订阅、原子快照、有界重放、缺口重建 |
| EndpointPolicy / AppError | Net + 业务 owner | 方法级认证/响应/副作用/重试；retryable 不能授权未知写操作重发 |
| ImTransport / SendIntent / SendDisposition | IM，集成定类型 | 本地意图不可变并冻结回复轮次/客户消息覆盖边界；稳定 localId；confirmed/rejected/unknown；传输连接与领域 Ready 分开 |
| BusinessOperation | OPS + Store | 操作意图、对象/权限快照、读回证据、未知状态均持久；不伪造上游幂等支持 |
| MediaHandle / AttachmentLease | Media + Store + IM | 临时访问句柄和持久附件引用分开；统一使用 AttachmentLease，不再并行定义 MediaLease/AttachmentRef 三套业务类型 |
| DraftSnapshot / CAS | IM | UI/翻译/截图提交 expected_version；旧结果不覆盖新输入；持久事务通过 Store |
| ClockService / ReconcileComplete | Net / IM | 时钟质量与对账代次分开；Notify 不能自行宣布恢复完成 |
| MaintenanceBarrier / StoreDrainBarrier | 集成协议 / Store参与者 | 前者覆盖 Account、IM、Store、Media、Biz、Shell；后者仅数据库停写与排空，不能单独批准安装 |
| BuildIdentity / SchemaCompatibility / ValidationRecord | 集成 / Store / QA | 产物、数据兼容和证据同版本绑定；已编译不等于已验收 |

`DrainBarrier` 在基础分片中统一理解为 `StoreDrainBarrier`。退出与更新共用唯一MaintenanceBarrier协调器：冻结新业务意图→允许同maintenance generation最终保存草稿/已接收动作/unknown→封闭Store写入口并排空→备份/checkpoint与关闭句柄→释放运行资源→批准退出或安装。并发退出/更新合并到同一代次；超时/取消后由协调器显式恢复正常或停在可诊断受限状态，不由各模块独立重开。未知发送可持久保留后随恢复核对，不要求等到外部系统永远给出确定答复才退出；但屏障不得丢弃它，也不得在未落盘时放行安装。脏业务页无法安全关闭时拒绝维护并提示处理，不能强制销毁来满足时限。

## 4. 所有权、并发预算和交接协议

**最多 7 个活跃代理：1 个主代理/集成 owner + 6 个工作槽位。** 模块角色多于槽位，按任务轮换。每个槽位一次认领一个可检查任务包；不可递归增加并发。审查代理也计入该上限。

| 范围 | 唯一写入责任 | 其他代理的协作方式 |
| --- | --- | --- |
| workspace、清单/锁文件、CI、src-tauri、capabilities、contracts、公共 platform-win、共享 ipc/ui-kit | 主代理/集成 owner | 提交依赖/权限/接口变更提案，由主代理串行接入 |
| core-account、core-store、core-net | 对应模块 owner | 只通过注入服务与仓储契约协作，不跨模块写 SQL 或读凭据 |
| core-im/domain+sync+messaging、adapters/web_sdk、adapters/node、operations | IM 核心、Web、Node、OPS 四个独占 owner | 父 lib.rs/mod.rs 归集成；各自子目录注册可由自身维护 |
| core-shell 的 registry/lifecycle/host 等与 business/bridge | DesktopShell / BusinessHost 分区 | 所有原生窗口由 shell 创建，业务只提交策略 |
| ui/apps/shell、setting 框架、ui/apps/im | ShellUI / IMUI | 提供设置/助手/媒体插槽；模块组件交 owner 挂载 |
| core-notify 与 alarm/notifier/tooltip | NotificationCore / NotificationUI | 不改 IM 首次 T1 或 Net 时钟 |
| core-media 的 handles/capture/image/ocr/spell/platform 与 download/viewer | MEDIA-CORE / MEDIA-IO | 下载/截图/预览 UI 均归 MEDIA-UI；MED-05 不越界改 media-ui |
| core-assistant 与 assistant-ui | ASSISTANT-CORE / ASSISTANT-UI | 携程/TSim 凭据分域；不自行实现发送账本 |
| core-update、release、update UI；core-telemetry、i18n | Release / Telemetry | 更新跨模块排空走公共协议，偏好通过统一服务 |
| 跨模块 tests/scenarios、tests/performance、validation 工具 | QA | 不直接修被审实现；IM 验证独占 tests/im-acceptance 与 fixtures/im |

路径规则：共享文件清单优先于目录租约，crate根lib.rs及跨owner父级mod.rs由集成owner单写，owner只写自有子目录内部mod.rs。所有产品路径以 `vbk/` 为根；模块内 `src/platform/` 等缩写相对于该行指定 crate，绝非仓库根。执行前在派工单展开为完整路径。`src-tauri/` 始终指 `vbk/src-tauri/`。同一文件仅一份有效写租约；文档中的角色表不授权同时修改父文件和子文件。

同一工作区可按目录租约工作；需要 worktree 时由主代理创建并固定基线，代理不要自行 checkout/reset/stash 其他人的改动。合并按“契约→生产者→消费者→集成→审查修正”小批次执行。Git 提交/推送/部署留给实际开发指令，本次计划不执行。

派工时使用如下模板；未填就不启动依赖该项的实现：

```text
任务 ID / 本次目标：
基线提交 / contracts 版本：
允许写入的完整路径 / 租约持有人：
已就绪的输入产物 / 仅 mock 的依赖：
本次交付的接口、状态机与文件：
正常路径和关键反例 / 验证命令或目标机步骤：
不得触碰的共享文件和生产操作：
完成后返回：改动清单、证据、限制、契约变更请求、后继可做事项。
```

状态流：`planned → ready → implementing → local_verified → target_verified → reviewed → accepted`；缺环境为 `blocked`，真实检查失败为 `failed`，不适用仅在批准的版本范围内标 `out_of_scope`。纯契约任务在记录“不要求目标机”的理由后可由 local_verified 进入 reviewed；含平台/上游能力任务不得跳过 target_verified。任务 accepted 不等于整个 G 关口 passed。

## 5. 分批调度与关键路径

下面是**资源受限调度建议**，不是按自然日排期。每行至多六个子代理工作包；同一格内按依赖串行推进。有任务阻塞即让出槽位，主代理从已有接口支持的队列补位，不等待整波所有任务完成。

| 批次 | 槽位 1 | 槽位 2 | 槽位 3 | 槽位 4 | 槽位 5 | 槽位 6 | 主代理与退出条件 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A 契约准备 | Account 提案 | Store 提案 | Net 提案 | IM/OPS 提案 | Shell/Profile 提案 | QA-01夹具/证据提案 | FND-01→02；冻结最小v0 |
| B 可执行核心 | ACC-01 | DAT-01→02 | NET-01→02a | IM-01→04/05 mock | SHL-01最小宿主 | REL-01 + QA 协议轮换 | FND-03/04；首个双账号故障切片可运行 |
| C 平台与状态 | ACC-02→03→04→05 | NET-02b联合→03a→04 | SHL-02→03→04→05→06 | IM-06 + OPS-01轮换 | UIIM-01→02 mock | DAT-03/04→REL-08a轮换 | Profile/凭据接缝产出；安装原型可用 |
| D 传输对照 | IM-02 Web | IM-03 Node | MED-01→02 | BIZ-01→02/03 | NTF-01→02 mock | REL-02/03 + UI集成轮换 | 多栈结果交F批网络槽汇总NET-03b；不要求失败候选可运行 |
| E 工作台闭环 | IM-07/09 | OPS-02～08分组 | BIZ-04～07 | NTF-03～06 | MED-03～06 | UIIM-03/04 + AST-01/02轮换 | 按依赖启用各入口；补齐G1/G2/G3证据 |
| F 发布与扩展 | REL-04～09 | DAT-05→NET-03b→NET-05轮换 | MED-07/08条件项 | AST-03～08 | QA-02～06 + IM-08轮换 | UIIM-05/QA-07基线 | REL-08b；逐关补证，冻结范围 |
| G 候选与复审 | QA-07 RC长稳 | QA-08独立复核 | 身份/数据反例复审 | IM/副作用反例复审 | 页面/发布反例复审 | 缺陷修复专属槽位 | REL-10a→验证→REL-10b；固定产物一致 |
| H macOS | MAC-01身份/传输 | MAC-02系统能力 | MAC-03安装准备 | 平台QA | 模块修复 | 保留空槽 | 接缝稳定后提前做可行性，RC仍独立验收 |

`REL-01 + QA` 等表示一个槽位先后交接角色，绝非作者独立验收自己的实现。批次 E 的真实提醒、BIZ-04下载、UI附件入口分别等待其具体产物；可先用 mock 做不受阻的部分。媒体/助手大任务允许在 owner 独占子目录下继续拆包，但不改变总并发和父文件归属。

核心关键路径：FND-01/02 → 身份/Store/Net最小接口 → ACC-02与SHL-02联合原型 → ACC-04 → 选定传输+IM-04/05/06 → IM-08/G3 → 范围对应G1–G5 → 固定RC → QA-07/08 → 发布就绪。另一条同样可能成为最长路径的是业务页兼容与安装/恢复；不得只按 IM 代码完成率估算全产品进度。

必须分开以下“原型产物”和“最终验收”，解除循环：

| 原任务 | 前半产物 | 后半完成条件 |
| --- | --- | --- |
| NET-02 | NET-02a：attempt/Jar/异步Cookie mock接口 | NET-02b：与ACC-02/SHL-02联合验证原生Cookie/Profile；ACC-04和G1依赖02b |
| NET-03 | NET-03a：Rust TLS/代理策略与WebView/SDK测试约定 | NET-03b：取得ACC/IM原型后完成各栈同场验证；IM-02/03启动只需03a |
| REL-08 | REL-08a：BuildIdentity、测试安装/通知身份原型，OCR-disabled默认，可另测身份候选 | REL-08b：选定传输、OCR决策或显式禁用、签名产物与完整安装矩阵 |
| QA-07 | QA-07a：基线、短时压力与度量方法 | QA-07b：REL-10a固定RC后执行完整工作班次长稳 |
| REL-10 | REL-10a：适用REL任务、QA-02～06与QA-07a通过后冻结候选 | REL-10b：QA-07b、QA-08及所有适用关口通过后关闭；不自动发布 |

这些 a/b 是原任务内部检查点，不是重复计数的额外功能。MED-07消费REL-08a，不等待最终安装选型；REL-08b再消费MED-07决策。失败或缺证据明确标注，不以扩大权限、取消验证或隐藏需求解环。

## 6. 里程碑、范围和完成判据

| 交付点 | 必须能演示的结果 | 放行依据 |
| --- | --- | --- |
| R0 可开发基线 | mock双账号、权限入口、订阅/快照、失败提交可复算 | FND与QA-01；不接真实写能力 |
| R1 身份与宿主可行 | 目标机登录、隔离、窗口/页面最小承载；两传输均有研究终态 | G1适用项与G2/G3原型记录；未通过部分保持blocked |
| R2 最小客服闭环 | 可靠查看/回复、附件最小集、草稿、unknown核对、未读与提醒、重连恢复 | 选定G3核心矩阵、身份与本地数据保护、受控会话证据 |
| R3 完整范围候选 | 八入口、客服边际能力、媒体、约定助手、设置诊断、安装恢复 | 每项任务→用例→产物可追溯；全范围G1–G5 |
| R4 Windows发布就绪 | 固定安装物、长稳、升级恢复、独立复核、已知限制与退出手册 | REL-10b；实际发布是后续执行动作 |
| R5 macOS发布就绪 | 对Mac目标架构/系统独立验证同等核心正确性与平台行为 | MAC-01～03及平台证据；不继承Windows passed |

R 编号用于本总计划交付点，详细任务提及的旧 M 编号仍是源设计里程碑，不能按数字互换。有限试用须先明确功能/角色/业务线范围；只能在该范围内报告通过，不能称完整替代。

工期在G0取证后按实际吞吐、剩余不确定性和关键路径重估。旧模块294.5/295人日不覆盖本计划全部联调与恢复工作；不能除以代理数推导工期。S/M/L仅表示规模和验证负担。任务进度、可交付能力比例、关口通过状态分别汇报，禁止用已写接口数代表上线完成度。

## 7. 汇总时的冲突裁决与补项

| 项目 | 本计划的执行规则 |
| --- | --- |
| 后台账号页面销毁 | 切账号先隐藏；dirty/unknown/inflight禁止自动回收；保留与登出分别处理 |
| 登录验证与凭据发布 | attempt隔离验证后才发布账号；凭据提交采用PREPARED→SECRET_STAGED→INDEX_COMMITTED，ready只是提交后事件 |
| 关键凭据崩溃恢复 | 先写非秘密journal及暂存项引用，再写新revision秘密；原子切换索引后才清旧项；重启以提交事实裁定，不能以ready是否发出裁定 |
| 附件名称与清理 | 持久引用统一AttachmentLease；孤儿暂存文件可清理，有持久引用者不得TTL删除 |
| 业务操作账本缺口 | DAT-02提供BusinessOperation事务仓储；OPS不自建数据库和SQL旁路 |
| 入站翻译任务缺口 | 新增IM-09；与助手出站翻译分开，保留原文且部分失败不阻塞消息 |
| 迟到回复证据 | SendIntent冻结回复轮次和客户消息边界；迟到ACK不能清除之后新到的待回复消息，顺序不明保留待核对 |
| IM分页措辞 | 页完成只保存断点，整轮终止证明后推进complete_watermark |
| 两传输比较前置 | 两候选都有可复算终态；胜出者全矩阵通过，失败/阻塞候选不要求伪造可运行产物；未测候选不称备用已就绪 |
| 保留账号数据与重认领 | forget保留非秘密稳定索引，重新认证同环境/buid后关联旧数据；不生成新ID把旧草稿变孤儿 |
| 通知冷启动 | DAT-02持久action映射，Notify写token，Shell重新认证后仅导航 |
| 本地搜索 | IM-05服务+DAT-02有界缓存查询+UIIM-03展示；FTS5后置，不缺核心查询实现 |
| 维护顺序 | 唯一协调器先冻结新意图，允许最终落盘，再Store排空关闭；退出/更新共享代次 |
| 下载UI路径 | MED-05核心归MEDIA-IO，media-ui/downloads归MEDIA-UI |
| 协议/窗口形态 | 新客户端独立scheme；本地独立IM是可替换默认，宿主原型后冻结；不抢占官方vbookingChat协议 |
| 更新“稍后” | remind_later不安装；只有明确install_on_exit且维护屏障完成才在真退出时安装 |
| 远程遥测/总结 | 首发需要本地诊断；远程上报和未确定总结服务不凭空新增后台依赖 |
| 存活视图数量 | 一份预算配置、实测后冻结；脏页安全优先，不并用4/8与6两套阈值 |

以上裁决已在本总稿相关任务中落地；历史调查和分片不因此获得新的运行验证结论。

## 任务总索引

共 **97 个工作包**；a/b是原任务内检查点，不重复计数。按任务ID定位正文；初始状态全部为planned，尚无产品开发进度百分比。

| ID 范围 | 数量 | 交付内容 | 验收主关联 |
| --- | --- | --- | --- |
| FND-01～04 | 4 | 工程、公共契约、事件快照、权限 | 全关口前置 |
| ACC-01～05 | 5 | 身份、Profile、凭据、登录退出、UI | G1 |
| DAT-01～05 | 5 | 分库、事务仓储、操作账本、导入、恢复、清理 | G1/G3/G5 |
| NET-01～05 | 5 | 端点、Cookie、多栈TLS代理、时间、受限请求 | G1/G3 |
| IM-01～09 | 9 | 两传输、outbox、同步、事实、消息能力、选型、入站翻译 | G3 |
| OPS-01～08 | 8 | 业务端点、状态、设置、成员、结束、侧栏、推荐、订单 | G3 |
| UIIM-01～05 | 5 | 会话列表、编辑器、媒体搜索、业务操作、性能 | G3/QA-07 |
| SHL-01～06 | 6 | 视图注册、宿主、主壳、激活、恢复、系统集成 | G1/G2/G4 |
| BIZ-01～07 | 7 | 入口、桥、导航、上传下载、保活、业务UI、兼容 | G2 |
| NTF-01～06 | 6 | 提醒事实、升级、轻窗、声音、Toast、反例验收 | G3/G4 |
| MED-01～08 | 8 | 媒体租约、附件、截图、标注、下载、预览、OCR、纠错 | G3/G4/G5 |
| AST-01～08 | 8 | 插槽、翻译、TSim身份与服务、语言、套餐、订单、策略 | G1/G3及助手范围 |
| REL-01～10 | 10 | 日志、偏好、语言、崩溃、诊断、更新、安装、RC | G4/G5 |
| QA-01～08 | 8 | 证据、五关口、性能、独立复核 | G1–G5 |
| MAC-01～03 | 3 | Mac身份传输、系统能力、签名安装 | Mac独立关口 |

任务派工看详细前置，不把本索引中同组任务误当全部可以同时开始。

## 8. 对抗性审查与后续使用

本轮采用异步子代理审查：身份/数据/依赖、IM/业务副作用/媒体、桌面/通知/发布三个方向并行，主代理汇总修正，再将总稿交回复核。审查只评价计划是否可执行与自洽，不替产品验收。

后续开发每次审查至少问：是否存在错账号/旧代次结果？外发已生效但本地未知怎么办？断点与备份会否丢唯一数据或重发？权限和源视图能否伪造？隐藏/睡眠/崩溃后是否恢复错误状态？性能证据是否同条件？是否有依赖循环或双写文件？

P1：错投、越权、重复副作用、数据丢失或不可交付核心能力；修正并复验前阻断相关集成。P2：契约不明确、验收缺口、平台兼容或调度冲突；冻结相关适配器前解决。审查记录必须含任务/段落、反例、影响、修正、复核状态，不能仅写“已加强”。

文末记录本轮实际审查结果；实现阶段仍需独立 reviewer 验证真实代码和证据。接下来五个部分是完整任务正文，局部“第几节”指各自所属部分。


## 第一部分：公共契约、账号、存储与网络

2026-10-30 · Asia/Singapore。状态：开发任务设计，尚未实现或运行验收。

本分片把[开发总纲](../dev/00-architecture.md)、[账号登录](../dev/02-account-login.md)、[本地存储](../dev/05-store.md)、[网络](../dev/06-net.md)转成可分派任务。证据边界以[最终审查](../reviews/2026-10-30-final-adversarial-review.md)和[网页调查](../research/2026-10-30-web-im-observation.md)为准。它不把浏览器中已登录、接口返回 HTTP 200 或源码存在当成目标客户端验收通过。

### 1. 从不变量划分任务

1. 身份先于请求：账号与环境在任务创建时固定；会话代次、凭据版本、登录 attempt、视图代次分别解决不同竞争条件，不能合并成一个全局“当前账号”。
2. 状态先于通知：成功事件只能对应已经提交的状态；快照与增量必须来自同一提交序列。关键写入不能依靠可能丢失的广播完成。
3. 持久意图先于外发：outbox、草稿和完整同步水位是业务数据；存储失败就停止依赖它的发送或水位推进。超时不等于上游未执行。
4. 边界独立失败：Profile、系统凭据库和 SQLite 不共享事务；HTTP、WebView 与 SDK 不共享网络实现。必须分别证明一致性和故障处理。
5. 未证实的能力先留接缝：Profile 与数据目录、两种 IM 传输、企业代理兜底、旧凭据恢复都在接口后验证，不让整组代理等待所有 G0 工作结束。

S/M/L 是相对实现规模：S 为单一边界、M 为单模块多状态、L 为跨系统或需目标环境取证；不是人日、交付日期或可按代理数直接相除的工期。每个任务完成都提交变更清单、契约版本、验证命令/场景、脱敏结果、剩余限制和回退办法。模拟验证与真实目标环境验证分别记录。

### 2. 单写者与对外接缝

| owner 角色 | 独占代码范围（均为未来路径） | 不得直接修改 | 必须交出的接缝 |
| --- | --- | --- | --- |
| 集成 owner | `vbk/crates/contracts/`、`vbk/ui/packages/ipc/`、根工程/锁文件、`vbk/src-tauri/` 组装与 capabilities；共享 `vbk/crates/platform-win/` | 不替模块随意改变业务语义 | 版本化 Rust/TS 类型、命令权限表、来源授权、快照协议、服务 trait、模拟实现 |
| 账号 owner | `vbk/crates/core-account/`、`vbk/ui/apps/login/`；账号局部测试/夹具 | shared contracts、shell 账号区、store schema、net 传输实现 | `AccountService`、`AccountLifecycle`、`ProfileLease`、`LoginAttempt`、无凭据账号 DTO |
| 存储 owner | `vbk/crates/core-store/`，包括 migrations、import、backup、局部夹具 | 其他模块直接 SQL、共享 manifest、通用 UI | `AccountIndex`、类型化 KV、消息/outbox/游标显式事务仓储、维护/排空接口 |
| 网络 owner | `vbk/crates/core-net/`，包括端点目录和局部夹具 | 业务模块状态机、共享平台封装、登录 UI、settings 页面 | `NetService`、`EndpointPolicy`、`ClockService`、脱敏诊断、代理策略 |

模块可提交共享文件变更建议，但仅集成 owner 合入根 manifest、Cargo/前端锁文件、workspace 注册、capability、类型生成及 `platform-win` 共用封装；模块内部新增依赖也先申报，由集成 owner 统一解析。并行代理不能各自运行依赖升级后相互覆盖锁文件。

以下是需要在 FND-02 冻结的**拟议内部接口**，不是既有上游 API：

| 接缝 | 生产者 → 消费者 | 必须确定的语义 |
| --- | --- | --- |
| `AccountContext / ConversationRef / ViewContext` | contracts → 全部模块 | 核心认定来源；账号环境、会话、视图、草稿版本校验；view label 复用不能复用旧权限 |
| `ProfileLease` | account → shell、net、IM 传输 | 带账号/环境/代次、随机 profile_id、撤销状态；account 分配映射，shell 持有控制器；旧控制器释放前禁止重新分配 |
| `LoginAttemptHandle` | account → net、shell | 未登录阶段的受限、不可伪造内部句柄；只允许该 attempt 的身份验证端点，不能从 JS 带 Cookie 发任意请求 |
| `AccountIndex / CredentialCommitJournal` | store ↔ account | SQLite 只记非秘密元数据和恢复阶段；暂存秘密只在系统凭据库；提交完成才发布 ready |
| `CommitIncomingBatch / CommitOutboxIntent / ApplySendEvidence / CommitSyncPage` | im → store | 原子更新所属业务集合；提交结果显式返回；只有终止条件已证实的整轮补拉才推进完整水位 |
| `EndpointPolicy` | net → 业务适配器 | 精确 URL/方法/身份模板/schema/解析器/读写分类/重试策略；业务 DTO 与 raw response 分离 |
| `MediaHandle / AttachmentLease` | media ↔ im、store | UI 临时句柄不能作为持久附件地址；转入草稿/outbox 时持久化账号隔离引用；unknown 和未完成草稿存在引用时不得由 TTL/登出清理 |
| `ClockSnapshot` | net → im、notify | 每环境时间锚点、单调时间、误差、有效期、quality；失效会通知消费者；不负责推断会话已回复 |
| `StoreDrainBarrier / StoreHealth` | store → update、im | 维护代次先允许已接收任务的最终落盘，再封闭写入口、排空事务；向MaintenanceBarrier报告备份/未决发送状态，不能独自授权安装 |

**拆开编译依赖与运行期协作。** net 先以匿名策略启动；account 后注入凭据提供器与失效回报接口。登录用户尚未 Active 时使用 attempt 句柄验证，不能要求先登录才能调用验证接口。account/net 均依赖 contracts，互不引用对方实现 crate。store 通过注入的身份验证接口/撤销快照检查请求；不反向依赖 account 实现，也不持有 actor 锁等待外部请求。shell 与 account 使用 Profile lease 和控制器生命周期接口联动，不相互等待“完整模块完成”。

### 3. 第一批：公共契约与可替换夹具

#### FND-01 工程与集成骨架（M）

- owner/独占路径：集成 owner；`vbk/` 根清单、`vbk/src-tauri/` 启动组装、contracts/ipc 空骨架；初始模块目录创建后移交对应 owner。
- 前置：无；先确认仓库仍为规划阶段，记录基线提交及已有修改。未执行前不把本文的 `vbk/` 路径当作实际存在。
- 输入/输出：输入已定模块地图；输出可构建的 Rust workspace、Vite 多入口、mock 默认模式、模块注册清单与固定依赖版本。依赖/平台 API 的当前支持性由原型执行者查官方文档并记录版本。
- 实现：分离普通启动与内部 crash-monitor 分流；本地基础日志先于 store；匿名 net 先于账号验证；所有生产网络与凭据能力默认显式配置，夹具不得碰真实用户目录。
- 验收证据：Windows 构建、类型检查、最小本地窗口启动记录；模拟账号可启动壳且没有外发请求；记录目标 OS/Runtime 与工具链。macOS 仅能报告其实际做过的检查。
- 失败/回退：构建或运行时不成立时先修骨架，停止依赖其运行时结论的任务；独立领域模块和文档取证可继续，不以换到 Electron 作为未审查的自动回退。

#### FND-02 身份、服务接口与错误契约 v0（M）

- owner/独占路径：集成 owner；`vbk/crates/contracts/` 与生成的 TS 类型。
- 前置：FND-01。
- 输入/输出：输入各模块接口提案；输出 AccountContext、ConversationRef、ViewContext、AggregateScope、LoginAttemptHandle、ProfileLease、EndpointPolicy、仓储事务/ClockService trait，以及脱敏 `AppError`。
- 实现：定义 `retryable` 仅为提示，写操作另有 `confirmed/rejected/unknown`；为生命周期撤销、磁盘满、scope 失效、快照缺口、业务拒绝定义稳定错误。持久账号身份与短期 session_generation 分开：数据库/outbox 以环境+账号归属，重启重新验证后建立新运行上下文；不因旧 generation 不再有效而删除草稿或 unknown 记录。
- 验收证据：Rust 生成 TS 无手写重复类型；账号、net、store、IM 的最小模拟消费者同时编译；同名 gid/localId 在不同账号夹具中不混淆；无秘密类型可序列化到前端 DTO。
- 失败/回退：契约争议形成变更提案及受影响消费者列表；使用版本化 mock 继续不依赖争议字段的部分，禁止各模块自行加兼容字段掩盖冲突。

#### FND-03 订阅—快照—重放与模拟服务（M）

- owner/独占路径：集成 owner；`vbk/ui/packages/ipc/`、contracts 的事件/测试夹具。
- 前置：FND-02。
- 输入/输出：输入 `EventEnvelope{scope,stream,epoch,seq,payload}`；输出有界订阅器、原子快照协议、mock account/store/net/transport 时间与故障注入接口。
- 实现：等待订阅建立再缓存，再取同 actor 提交序列快照，丢弃旧 seq 后连续重放；缺口、epoch 改变、缓冲溢出、来源代次失效全部重建。AggregateScope 权限集合变化递增 authorization_revision。模拟服务支持定点暂停/释放回调、重复/乱序消息、提交失败，不能只提供永远成功 happy path。
- 验收证据：在订阅与快照之间插入事件不丢失；旧账号/旧快照迟到不覆盖新视图；缓冲溢出明确重同步；撤销订阅和 Channel 后无旧客户数据继续下发。
- 失败/回退：事件协议不通过则禁止发布实时 UI 集成版本；领域状态机可用直接服务夹具继续验证，不临时全局广播补洞。

#### FND-04 授权入口与并发契约验证（M）

- owner/独占路径：集成 owner；`vbk/src-tauri/capabilities/`、组装授权入口与 contracts/ipc 契约验证夹具。
- 前置：FND-02、FND-03；生产视图注册接入时消费 shell 提供的真实来源注册表。
- 输入/输出：输入每模块命令/视图/scope 矩阵；输出单命令授权与核心对象授权的可复算矩阵。
- 实现：区分本地壳、远程登录、远程业务桥、第三方订单页；登录远程页与第三方页无 IPC。内核从真实来源推导 ViewContext；事件下发和活 Channel 每次核验；禁止 JS 自发事件改变核心业务状态。
- 验收证据：合法本地账号读取通过；跨账号、旧代次、伪造 label、capability 合并误授、子 iframe 借桥均拒绝；权限增加必须对应声明用途和反例测试。
- 失败/回退：撤回新增 capability 或命令注册，保留 mock 开发；拒绝以禁用 webSecurity、站点隔离或扩大域名后缀完成联调。

### 4. 账号 owner 任务包

#### ACC-01 身份 actor、attempt 与撤销（M）

- owner/独占路径：账号 owner；`vbk/crates/core-account/src/` 的领域状态与局部夹具。
- 前置：FND-02；快照/UI 联调再依赖 FND-03。
- 输入/输出：AccountService、AccountLifecycle、ProfileLease 模拟实现；状态包括 Validating、Active、Background、Expired、Cached、SignedOut。
- 实现：账号 ID 随机生成，唯一映射 `(environment,buid)`；attempt、session_generation、credential_revision 独立。先撤销旧代次并停发，再取消/清理资源。active/background 是导航关系，切账号不能改变在途任务 scope；忘记账号与仅登出保留记录分开。
- 验收证据：A 请求挂起切到 B、退出重登 A、取消登录后返回用户信息、旧鉴权错误晚到，均不污染新会话；进程重启/恢复旧备份后代次不复用。
- 失败/回退：拒绝相关操作并保留可诊断状态；不把清理失败报告为退出完成，不通过全局 current_account 补字段。

#### ACC-02 WebView2 登录与 Profile 路线原型（L；G1）

- owner/独占路径：账号 owner；`core-account/platform/` 与局部原型；共享 platform-win patch 仅以提案交集成 owner。
- 前置：ACC-01、NET-02a；依赖 FND-02 的 ProfileFactory/控制器接口，用最小 shell 原型提供控制器即可，不能等待完整业务页。
- 输入/输出：输入锁定的 Tauri/wry/WebView2 版本与登录入口；输出 A1 同环境多 Profile、A2 独立数据目录对比记录、最小 Cookie 恢复证据和明确路线决策。
- 实现：随机待定 Profile；异步 Cookie API；禁密码自动保存；精确导航策略；同时覆盖页面导航与 SPA/XHR 登录完成。验证密码/短信/滑块等实际支持方式，不能仅以出现 Cookie 判成功。比较两个账号及同一账号重新登录、控制器关闭、Service Worker 迟到写入、浏览器进程崩溃。
- 验收证据：目标 Windows 中完成登录、`getCurrentUserInfo` 身份验证、两账号 Cookie 隔离、旧 Profile 不复用；记录 Runtime/SDK、进程组、资源增量、失败分支。三 Cookie 独立恢复若未通过，明确禁止凭三项导入自动快登。
- 失败/回退：A1 不成立或不接受 fork 时测试 A2；A2 也失败则 G1 blocked，保留 mock 核心。做法 B 自研登录只有在 A 失败且接口/风控范围明确后重新立项，不能默默启用。

#### ACC-03 凭据提交、续期比较与启动补偿（L）

- owner/独占路径：账号 owner；`core-account` 凭据/提交/清理模块。
- 前置：ACC-01、DAT-01、NET-02a；原生实现复用 ACC-02 产出的 Profile 接缝，可先用夹具实现。
- 输入/输出：系统凭据库、AccountIndex、CredentialCommitJournal、ProfileLease → 完整 ready 或明确失败及恢复标记。
- 实现：采用 journal-first：先持久化非秘密 PREPARED（operation_id、account_id、profile_id、新旧凭据引用），再写独立 revision 的受保护条目并标 SECRET_STAGED；验证后在 SQLite 同一事务提交账号映射、凭据引用和 INDEX_COMMITTED，随后发布 ready。重启以持久提交事实决定继续或回收，不以 ready 是否发出决定；新映射提交前不得覆盖/删除旧有效秘密。缺少目标条目进入待验证或重新认证，不能 Active。序列化字节超凭据库限制时拒绝，不能截断/落明文。凭据版本比较后才吸收候选 Set-Cookie；保留 Domain/Path/HttpOnly/Secure/SameSite/Expiry，删除语义同步。重新登录返回其他身份不覆盖目标账号，进入明确的身份不匹配/添加账号流程。
- 验收证据：在每一步故障点中断进程，重启不出现半登录或孤儿秘密；测试凭据库不可用、超大快照、SQLite 提交失败、Profile 被占用、旧 Set-Cookie；普通库/日志/导出无密码和 ticket。
- 失败/回退：只回收尚未INDEX_COMMITTED且无有效引用的暂存项，已提交项进入恢复验证；保留可恢复标记；失败 Profile 隔离且不分配新会话；凭据能力不可用时提示重新登录或阻止持久快登，不降级明文存储。

#### ACC-04 登录、快登、失效与退出闭环（L；G1）

- owner/独占路径：账号 owner；`core-account` 生命周期编排。
- 前置：ACC-02、ACC-03、NET-02b、FND-03。
- 输入/输出：受限登录 attempt、可信用户身份响应、业务鉴权失败报告 → ready/expired/logged-out 与授权账号快照。
- 实现：网页登录验证严格解析 `response.user`；当前证据中的 `11000` 分支仅按该端点处理，不能复制到所有 API。启动先 Validating；纯断网不清凭据。Cached 快登与 SignedOut 登出分开；确认失效才停重连。退出隔离旧 Profile、撤销 net Jar/IM/下载/助手任务，等资源释放后清理；保留免密也必须停稳旧控制器。
- 验收证据：两个账号并存、背景账号 IM、失效后重登、断网冷启动、凭据库与 Profile 不一致、退出清理失败后重启；每个结果包含上游身份/业务成功判据与脱敏证据。
- 失败/回退：账号维持 Validating/Expired/清理待完成等真实状态；不可先放开业务写入再等待验证。G1 不通过不冻结生产账号适配器。

- 保留数据的忘记账号：`forget(delete_local_records=false)`移除活动入口、凭据与Profile，但保留非秘密稳定身份索引并隔离数据。重新登录验证相同`(environment,buid)`后才能重新关联原account_id/db_id，不凭文件夹名或前端参数认领；草稿、unknown和附件继续可恢复。真删除按可恢复清单覆盖库、备份、staging、quarantine与媒体。验证忘记后重新添加同一身份及同名不同环境，均不串库、不自动重发。

#### ACC-05 登录外壳与账号联调（M）

- owner/独占路径：账号 owner；`vbk/ui/apps/login/`；shell 账号区由 shell owner 按同契约接入。
- 前置：ACC-01、FND-03 可启动 mock UI；真实闭环依赖 ACC-04、FND-04。
- 输入/输出：login/account 快照与命令 → 登录进度、取消、失败恢复、重新登录界面；只返回展示 DTO。
- 实现：本地外壳与远程页权限分离；等待用户与网络错误分开；旧 attempt 回调不更新新窗口；清楚区分退出在线保留免密、退出登录、删除本地记录。网络设置以 NET-05 提供的组件/契约接入，窗口路由由 shell owner 组装。
- 验收证据：双账号切换、登录取消、窗口重建、离线冷启动下界面可操作；记录壳可见/账号验证/业务可用/IM连通四个独立时间，不合并成 2 秒登录承诺。
- 失败/回退：保持可重试的本地壳和明确状态，不让远程页直接向前端暴露 ticket 或绕过核心宣布成功。

### 5. 存储 owner 任务包

#### DAT-01 分库、schema 与类型化仓储骨架（M）

- owner/独占路径：存储 owner；`vbk/crates/core-store/` 的连接、迁移、身份、AccountIndex、KV。
- 前置：FND-02；应用 identifier、Local 数据目录从集成/shell 决策输入，原型用隔离临时目录。
- 输入/输出：固定数据库身份句柄、迁移版本、KV schema → 每环境 app.db、每账号 im.db、有界写 actor/读连接与健康状态。
- 实现：库内校验 environment/account_id/buid/db_id；WAL + FULL；按全应用预算分配队列字节、读连接和页缓存；拒绝新于二进制的 schema；每库事务化迁移；跨库仅以恢复标记协调。账号元数据严格字段白名单，不序列化原始上游对象。
- 验收证据：错环境/错账号/新 schema 拒绝；多账号并发、SQLite BUSY、磁盘满明确失败；已提交 KV 版本与 watch 一致；测试目录中没有秘密；启动初始化测量单列。
- 失败/回退：迁移回滚且保留原库；单库降级不影响其他账号；禁止删库重建和降低 user_version。

#### DAT-02 消息、发送意图与同步水位事务（L）

- **汇总补充约束**：追加验收：BusinessOperation在每个提交边界强杀后不自动重复写上游；通知token重启可解析但需重新授权；搜索参数注入、跨账号、撤回/删除与有界截断验证。

- owner/独占路径：存储 owner；core-store 业务仓储、迁移及故障夹具。
- 前置：DAT-01；与 IM owner 在 FND-02 接缝上共同冻结事务语义，由集成 owner 修改 contracts。
- 输入/输出：`CommitIncomingBatch`、`CommitOutboxIntent`、`ApplySendEvidence`、`CommitSyncPage`、草稿版本比较 → 持久提交结果与提交后通知。
- 实现：消息幂等键按账号库内 `(gid,msg_id)`；localId 绑定原发送意图。入站消息、必要会话摘要及相关事实同一事务；ack/回推与 outbox 归并保持原子性。完整水位与最新已见分离；页面消息/断点一起提交，整轮结束有证据才推进完整水位。原子条件由 IM 提交计划表达，store 不猜上游分页终点。草稿 CAS 防止旧译文覆盖新草稿；UI 当前编辑缓冲由 IM 提交持久草稿 CAS，生成不可变发送意图后助手不能另建发送账本。附件从临时 MediaHandle 转入草稿/outbox 时，事务记录账号隔离 AttachmentLease、持久资源身份与引用；downloads/附件表迁移由 store owner 落实，media 只提交 schema 提案。keyset 翻页包含稳定排序键。新增 BusinessOperation 仓储：外发前提交不可变意图、对象与权限快照、阶段；原子应用读回证据，unknown跨重启保留，OPS只用类型化接口。另提供 NotificationActionRepository，持久存储token到environment/account_id/conversation/展示版本/expiry的最小映射，不含凭据或正文；恢复后不能据旧session_generation授予权限。提供参数化、账号/会话受限且可取消的本地缓存文本搜索与keyset分页，不依赖FTS5；页大小/扫描预算在FND-02登记，截断必须标注。
- 验收证据：逐故障点测试“意图提交前/后、外发前、Ack 前/后、页面中断、最后页提交”；重复入站/迟到回执不重复计未读；磁盘满不返回保存成功；窗口关闭不会撤销已被核心接收的持久意图；临时句柄过期/登出后 outbox unknown 或持久草稿的附件仍可找回，错账号引用拒绝。
- 失败/回退：事务整体失败、无成功事件、水位不推进；outbox 重启后 unknown 仍待核对。不得以客户端重发替代恢复丢失的确认状态。

#### DAT-03 旧版只读导入与受限隔离区（L；G5）

- owner/独占路径：存储 owner；core-store legacy import；账号凭据候选交 ACC-03。
- 前置：DAT-01、DAT-02、ACC-03；旧数据目录、环境和字段归属取证属于本任务，不假定路径推断已经成立。
- 输入/输出：停止写者后的主库/WAL/SHM 一致副本、源指纹、脱敏配置字段 → staging、batch_id、已归属/孤儿/多义计数及增量合并报告。
- 实现：先确认源文件集合稳定，复制前后指纹一致；仅 staging 可恢复/转换，旧文件只读。password 解析边界丢弃，原 config 不复制到 staging。消息经 gid 对账号归属，不明确就隔离；groupMember 和无归属 customEmoji 不猜账号。按源快照+环境+导入器版本记录进度，新版草稿/outbox/已读/星标优先。
- 验收证据：测试旧库带已提交 WAL；源记录=归属+隔离计数；中断/重复导入不新增重复、不覆盖新版同时产生的数据；只有密码的旧配置只导入账号名；未证明 Cookie 最小集则不承诺快登。
- 失败/回退：只清当前 batch staging 后重试，不清正式库；源持续写入则暂停等待；禁止自动关闭/删除旧客户端数据。

#### DAT-04 备份、损坏恢复与更新屏障（L；G5）

- owner/独占路径：存储 owner；core-store backup/recovery/drain。
- 前置：DAT-01、DAT-02；与 update owner 在 FND-02 定义 StoreDrainBarrier/schema 兼容接口。
- 输入/输出：固定库身份、backup generation、升级原因 → `.tmp` 校验后原子发布备份、恢复完整性报告、写入排空结果。
- 实现：按环境/账号/db_id 分目录；backup API 完成且身份/schema/完整性检查通过才发布；升级保护备份独立保留。坏库连 WAL/SHM 留证，恢复候选先 staging 校验。旧 outbox 进入核对屏障；恢复水位回退后补拉。备份清单包含持久附件引用及资源归属/完整性信息，附件副本随一致性策略保存；缺件必须显式报告并阻止依赖该附件的发送，不能伪造恢复完整。安装屏障遵循MaintenanceBarrier阶段：先冻结新业务意图，仍允许同维护代次的最终持久化；再关闭写入口、排空事务、备份/checkpoint和关闭句柄，不能先停库再要求保存草稿。
- 验收证据：同日两账号备份不碰撞；错账号/错环境/新 schema 拒绝；截断库、保留 WAL、只移除可重建 SHM 的反例；恢复旧备份后不重复发送；升级失败能启动兼容版本或明确阻止不可读写的旧版。
- 失败/回退：备份失败不发布，不淘汰上一份有效备份；恢复失败保留受损资料和限制状态，不宣称空库完整恢复；更新排空失败中止安装。

#### DAT-05 维护命令、容量与耐久故障验收（M；G5）

- owner/独占路径：存储 owner；core-store maintenance/metrics/本模块验证。
- 前置：DAT-02、DAT-03、DAT-04；维护 IPC 接入依赖 FND-04。
- 输入/输出：保留策略、健康/占用快照、删除本地记录明确意图 → 分批清理、待清理记录、容量诊断；设置 UI 由 shell owner 接入。
- 实现：cache、历史记录、草稿/outbox 分类；`status=4` 未取证前不启用自动删除；排除活动会话/未决发送/同步引用；附件仅在没有 outbox/草稿/有效下载引用且保留策略满足时删除，TTL 与普通登出不能越过引用。账号删除覆盖主库、备份、quarantine、staging、媒体关联，失败可恢复。限定维护批次、WAL checkpoint 等待；FULL/磁盘满不无限重试。FTS 默认后置，产品确认需要后另派扩展，不把其完成设为 IM 上线前置。
- 验收证据：三账号收消息时维护不阻塞其他账号；中文路径/Defender、磁盘满、长读事务、崩溃重启；旧文档性能目标按同机夹具报告 P95，任何不达标须保留实测，不以改持久性换数字。
- 失败/回退：停止可选维护或该库写入并提示；绝不为降低体积删除 unknown/草稿/尚未同步事实。

### 6. 网络 owner 任务包

#### NET-01 端点注册、类型化响应与副作用分类（M）

- owner/独占路径：网络 owner；`vbk/crates/core-net/` 的策略/端点/错误/匿名客户端。
- 前置：FND-02。
- 输入/输出：业务 owner 提交的方法级字段、认证、证据等级 → `EndpointPolicy`、类型化 response/outcome、脱敏日志；上游业务语义由对应业务 owner确认。
- 实现：精确 HTTPS host/port/path/method；参数/解压后响应限额；禁止任意 URL/header。匿名更新/CDN/TSim 与携程身份隔离。逐端点解析 HTTP、Ack、完整 Errors、success/isSuccess/status 与必需字段；已登记幂等查询才按错误分类有界重试，写操作默认零自动重试、断连可能已执行则 unknown。
- 验收证据：HTTP200+业务失败、Ack Success+缺字段、鉴权错误/网络错误区别、压缩炸弹、未登记跳转、端口/HTTP 降级；服务端接受写后断连仅执行一次；日志中无正文/凭据。
- 失败/回退：未知方法保守拒绝或标 unsupported，保留响应结构脱敏证据；不能把所有错误映射登录过期。

#### NET-02 Cookie 镜像与登录验证通道（L；G1）

- owner/独占路径：网络 owner；core-net credentials/jar/identity endpoints；平台 Cookie 封装由集成 owner 合入。
- 前置：NET-01、ACC-01。NET-02a仅要求已冻结接口与模拟实现，不依赖ACC-04；NET-02b与ACC-02/SHL-02联合完成真实Cookie/Profile验收。登录顺序为待定Profile→受限attempt Jar→身份/attempt验证→ACC-03提交→正式账号Jar→ready。
- 输入/输出：AccountContext 或 LoginAttemptHandle、凭据 revision、ProfileLease → 每代次内存 Jar、候选 Set-Cookie/鉴权报告、身份验证 DTO。
- 实现：初始化账号以前的登录验证使用专门 attempt 策略；正常请求冻结 scope/revision，精确 URL 过滤 Cookie；异步读 Profile，未知站点 Cookie 只按明确端点需要读取。对凭据候选只向 account 提交、不自行持久化；响应回到新代次时拒绝。Jar 不落盘，跨环境/第三方/更新不借用携程 Cookie。
- 验收证据：挂起请求后 logout/relogin 释放旧 Set-Cookie；不同 path/host-only/expiry/SameSite、Cookie 删除、Profile/keyring 不一致；原子提交前不能访问普通业务端点；三 Cookie 依赖与其他风控 Cookie 有区分证据。
- 失败/回退：候选变化进入待验证或拒绝；无法异步读取 Cookie 时报告平台限制，不用 JS document.cookie 降低 HttpOnly。

#### NET-03 TLS、代理、PAC 与多栈一致性（L；G1/G3）

- owner/独占路径：网络 owner；core-net platform adapter/策略；WinHTTP 共用封装提交集成 owner。
- 前置：NET-01。NET-03a完成Rust路由与跨栈测试接口；NET-03b消费ACC-02及IM原型结果后完成各栈验证。IM原型启动不等待NET-03b。
- 输入/输出：EnvProfile、代理模式与网络/配置代次 → 精确 URL 代理解析、客户端策略、各栈能力矩阵。
- 实现：PAC 在有界阻塞任务处理，按完整 URL 与代次缓存；代理失败不静默直连。系统 CA、测试域专用 CA 与主机名校验分离；生产不加载测试根。新用户跟随系统、旧 useSystemProxy=false 保留 Direct。代理模式变更 pending 后受控重启；网关选择只声明 Rust 侧生效。SDK HTTP/WSS 分别接收策略，不能只设置环境变量就判支持。
- 验收证据：Rust HTTP、WebView HTTP/WSS、Node HTTP/WSS 各列证书拒绝、系统根、PAC 同 host 不同 path、代理失效、认证、断网恢复结果；目标低版本 Windows 实测。
- 失败/回退：NTLM/Kerberos 等能力不成立时明确不支持的部署条件或另评 WinHTTP 适配；不关闭证书校验，不自动将未经同等验收的传输当兜底。

#### NET-04 ClockService 与恢复信号（M）

- owner/独占路径：网络 owner；core-net clock/connectivity。
- 前置：NET-01、FND-02；IM/notify 可先消费可控 mock clock。
- 输入/输出：已登记可信时间响应、往返耗时、单调时间、睡眠/网络事件 → 每环境 `{server_epoch_ms,monotonic_anchor,uncertainty_ms,valid_until,quality}` 与恢复信号。
- 实现：确认时间字段单位/时区/服务适用性，未知则 quality 不可用；墙钟跳变/睡眠/来源变化后锚点失效；离线只保留估计，不继续承诺强提醒精度。NLM 是提示，主动探测有界，误判离线仍允许用户探测。重连后会话对账屏障由 IM owner 负责，net 不宣布业务已恢复。
- 验收证据：墙钟 ±5 分钟、睡眠跨 T1、过期锚点、同一环境时间源冲突、网络抖动；过期信号到达 IM/notify 后不得补响已结束会话；目标时间误差与质量一起记录。
- 失败/回退：降级 stale/unknown 并显示等待对账，不用 Date.now 加旧 offset 伪造准确倒计时。

#### NET-05 受限 fetch、设置与联调（M）

- owner/独占路径：网络 owner；core-net 命令与局部集成夹具；设置/登录 UI 接入建议交对应 owner，不直接改其他代理文件。
- 前置：NET-02、NET-03、NET-04、FND-03/04；真实双账号闭环依赖 ACC-04。
- 输入/输出：`endpoint_id + scope + params`、代理/网关配置 → 有限 DTO、状态快照、pending/restart_required。
- 实现：只读 fetch 仅可信本地视图；状态修改由业务专用命令；prod 不注册 set_env。status snapshot 和事件共享同流序号；探测限制并发。检查日志脱敏发生在日志写入前，字段白名单不包含客户正文、票据片段或可关联的凭据哈希。
- 验收证据：未登记端点、伪造 scope、过期 view_generation、远程调用均拒绝；正常本地读可用；切账号不改变 in-flight；代理 pending 与旧生效策略显示准确；请求数/重试数与可复算轨迹一致。
- 失败/回退：删除未证明安全的端点登记或 capability，保持明确不可用状态；不开放临时任意 fetch 方便联调。

### 7. 并行调度与交接

| 波次 | 可并行工作 | 必须先收到的产物 | 禁止误读 |
| --- | --- | --- | --- |
| A | FND-01/02 顺序完成；其他 owner 读源、写端点/仓储提案和合成夹具 | 基线提交、文件锁表 | 读源准备不需要等待 G1–G5 全通过 |
| B | FND-03、ACC-01、DAT-01、NET-01 | FND-02 v0 | mock 可用不代表原生登录/生产接口可用 |
| C | FND-04、DAT-02、NET-02a、NET-03a、NET-04 | 各前置接口已固定；shell 提供最小控制器夹具 | net/account 不应互相等待完整实现 |
| D | ACC-02/SHL-02/NET-02b联合，ACC-03；DAT-03/04按依赖；IM/提醒/业务UI用夹具 | NET-02a、DAT-01/02、Profile/事务接缝 | 全套功能可以先写，但对应真实适配器未通过前不能冻结或放行发布 |
| E | ACC-04/05、DAT-05、NET-05、跨模块故障验证 | 对应前置任务与原型证据 | 代码完成、mock 通过、G1/G5 通过是三个不同状态 |

任何共享契约变更提交 `原因 → 反例 → 旧/新字段与语义 → 受影响任务 → 迁移或回退 → 验证` 给集成 owner。合入后发布契约版本，消费者逐一确认；旧生成类型与锁文件不能由模块代理手改。依赖方只应等待自己消费的接口版本，不能等待整个 owner 所有任务结束。

### 8. 阻断与证据清单

| 尚未证明的事项 | owner / 对应任务 | 阻断什么 | 仍可推进什么 |
| --- | --- | --- | --- |
| WebView2 内嵌风控/登录、Profile 方案 | 账号 / ACC-02 | 生产账号适配器冻结，G1 | 账号状态机、mock UI、存储、窄权限 |
| 登录失败契约、最小 Cookie 集、续期/轮换 | 账号+网络 / ACC-04、NET-02 | 快登/凭据导入、自动失效策略 | 端点解析夹具、重新登录流程 |
| 身份与库的持久提交恢复 | 账号+存储 / ACC-03、DAT-01 | G1/G5 通过 | 失败补偿夹具、其他独立功能 |
| 旧数据目录、孤儿归属、结束状态枚举 | 存储+IM / DAT-03/05 | 自动导入与自动历史清理 | 新数据仓储、隔离报告、手工确认后的恢复流程 |
| 真实上游分页终止与 localId 幂等 | IM+存储 / DAT-02 | 完整水位推进条件、unknown 自动重试 | 原子事务与反例夹具；默认不自动重发 |
| 各网络栈 PAC/TLS/代理认证 | 网络+IM+账号 / NET-03 | 对应部署环境的 G1/G3 | 已支持环境模拟与核心实现；明确标 unsupported |
| 可信时间源与误差 | 网络 / NET-04 | 精确强提醒验收 | 不确定质量显示、持久等待轮次 |
| 落盘加密是否必需、数据保留和发布对象 | 集成协调存储 / DAT-01/05 | 最终数据政策与发布 | 不含真实数据的仓储、SQLCipher 接缝评估 |

验收记录至少保存：任务/关口 ID、代码提交与契约版本、OS/SDK/Runtime、测试身份类别与合成数据来源、动作/故障点、期望、实际、passed/failed/blocked、脱敏证据路径、下一步决策。只需为上述高影响状态边界编写有效反例验证；简单样式或纯透传不增加机械单测。G1/G5 是跨模块共同关口，本分片完成仅提供其部分证据，不能由某一个 owner 单独宣布整关通过。


## 第二部分：IM、客服操作与会话界面

2026-10-30 · Asia/Singapore。本文只制定开发与验证任务，没有实现产品代码、操作真实客户会话或新增运行时验收结论。

### 1. 目标、事实和不可倒置的依赖

IM 的交付目标是：客服能辨认当前身份、连接和工作状态，可靠地查看消息、提交回复、处理会话，并在结果不确定时知道哪些动作需要核对。语言、运行时、SDK 和页面结构都服务于这个目标。连接成功不能证明业务可用，页面显示“已发”不能证明服务器已接受，超时也不能证明未发送。

依据：[公共契约](../dev/00-architecture.md)、[IM 设计](../dev/10-im.md)、[传输决策](../decisions/2026-10-30-im-transport.md)、[最终审查](../reviews/2026-10-30-final-adversarial-review.md)、[网页观测](../research/2026-10-30-web-im-observation.md)、[客户端静态证据](../research/2026-10-30-client-im-static-evidence.md)、[成员／侧栏／推荐／订单调查](../research/2026-10-30-im-peripheral-apis.md)、[状态与设置调查](../research/2026-10-30-agent-status-and-settings.md)。

| 现有证据 | 可直接据此开始的工作 | 仍不能据此冻结的事项 |
| --- | --- | --- |
| 官方网页有登录、XMPP 认证和自然入站样本 | 定义适配器、录制格式、解析夹具和隔离原型 | 本地 WebView 可独立初始化、后台长期收发、两连接职责 |
| Web SDK 3.0.0 与 Node SDK 1.0.24 的静态调用链 | 比较认证、回执和内部重试；写 MockTransport | SDK 可再分发、SEA 可运行、服务端幂等键及窗口 |
| 部分身份、会话、排班、推荐查询及邀请候选已有真实读取 | 为已知结构编写类型化解码器和 UI 夹具 | 同名写接口可用、全部账号有权限、详情和分页完整 |
| 成员操作、产品卡片与设置写入的静态分支 | 建立独立命令、输入校验和结果核对状态机 | 写入成功、状态收敛、超时可重放及跨业务线一致性 |

范围包括普通文本、图片／文件、引用、撤回、已读、输入状态、历史与 IQ 通知、草稿、搜索、客服状态、个人业务设置、成员管理、结束动作、侧栏资料、订单和产品推荐。跨设备草稿同步及 Rust 原生 XMPP 不属于一期承诺；Rust 原生路线只在 B1/C 证据成熟后另立决策。

现有文档有两处执行时必须消歧：`dev/10` 联动表仍提到官方 `vbookingChat://`，本计划遵循总纲的新客户端独立 scheme；`dev/10` 末节称独立 IM 窗口已冻结，总纲仍要求 G0 决策。本计划以独立本地 IM 窗口作为可替换的实现默认值，最终形态由壳原型记录冻结，不能据旧条款抢占官方协议或扩大父窗口权限。

### 2. 所有权与并行边界

下表目录均为**拟建路径**，当前仓库没有对应产品实现。每个任务只在自己的子目录工作；根模块声明、插件注册、workspace、依赖版本、锁文件、公共生成类型与 capability 文件由集成 owner 串行合入。模块代理提交契约变更请求和补丁清单，不自行修改这些公共文件。

| 角色 | 独占实现路径（相对于仓库根） | 向其他角色交付 |
| --- | --- | --- |
| IM 核心 owner | `vbk/crates/core-im/src/domain/`、`vbk/crates/core-im/src/sync/`、`vbk/crates/core-im/src/messaging/`、`vbk/crates/core-im/tests/domain/` | 账号 actor、发送意图、同步、草稿、未读、回复事实与领域命令 |
| Web 传输 owner | `vbk/crates/core-im/src/adapters/web_sdk/`、`vbk/transport/web-sdk/`、`vbk/crates/core-im/tests/web_sdk/` | B1 适配器、可重复原型、网络与生命周期例外清单 |
| Node 传输 owner | `vbk/crates/core-im/src/adapters/node/`、`vbk/sidecar/im-node/`、`vbk/crates/core-im/tests/node/` | C 适配器、管道与子进程回收、TLS／日志修正记录 |
| 客服操作 owner | `vbk/crates/core-im/src/operations/`、`vbk/crates/core-im/tests/operations/` | 类型化业务命令、端点策略提案、权限／回读／unknown 处理 |
| IM 界面 owner | `vbk/ui/apps/im/src/`、`vbk/ui/apps/im/tests/` | 本地会话界面、操作入口、助手／媒体插槽、性能证据 |
| IM 验证 owner | `vbk/fixtures/im/`、`vbk/tests/im-acceptance/`、`docs/validation/im/` | 共同故障矩阵、脱敏结果、候选对比与 G3 证据索引 |

这六种角色是可分派的工作包，不要求同时占用六名开发代理。总调度遵循主计划并发上限；先运行核心、两条原型和 UI，待契约稳定后把空闲槽位给业务操作和独立验证。验证 owner 不改待验证实现；发现缺陷交回代码 owner。

跨模块任务引用：[基础／账号／存储／网络计划](01-foundation-account-data.md)的 FND-01～04、ACC-01～05、DAT-01～05、NET-01～05。壳任务 SHL-01 为视图注册与代次，SHL-02 为目标 Windows 宿主原型；准确交接以主计划登记为准。

### 3. 先冻结接缝，再按模块实现

#### 3.1 交接契约

以下是 FND-02 的契约提案，字段最终由集成 owner 合并到 `contracts`；不是新增上游参数。

| 接缝 | 必须具有的语义 | 接收方 |
| --- | --- | --- |
| `ImTransport` | 账号／环境／session_generation 固定；connect、send、typing、read_receipt、shutdown 与有界事件流；健康连接、领域 Ready 分开 | 两传输与核心 |
| `SendIntent` | `send_intent_id`、稳定 `localId`、durable account identity、ConversationRef、冻结正文 hash、引用／@／附件租约、草稿版本、reply_round_id/pending_version与当时已知客户消息水位；同标识不得换正文或回复覆盖集合 | 核心／store／UI／助手 |
| `SendDisposition` | 服务器已接受、明确拒绝、未知三类；未开始提交的本地校验失败单独表示。`AppError.retryable` 不能授权写重试 | 传输／业务命令／UI |
| `AttachmentLease` | core-media 提供账号隔离的持久附件租约，outbox 原子记引用；临时句柄 TTL 和登出撤权不能删除未决发送所需附件 | 媒体／core-im／store |
| `DraftSnapshot` 与 CAS | core-im 持久保存文档和版本；UI 只持编辑缓冲；替换／发送检查 expected_version，译文迟到不覆盖新草稿 | UI／assistant／store |
| Store 显式事务 | 去重插入、会话摘要、outbox 回执归并及相关完整水位按一次提交边界更新；UI 事件在提交后发出 | DAT-02／核心 |
| `SyncProgress` | latest_seen 与 complete_watermark 分开，分页进度与未完成区间持久化；游标是内部不透明类型 | store／历史 UI |
| `BusinessOperation` | 操作 ID、账号／会话／对象版本、提交状态、读回证据、明确拒绝／已确认／未知；不伪造上游 localId 支持 | 客服操作／store |
| 回复事实事件 | MessageNew、UnreadChanged、ReplyTimeout、ReplyCleared、ReconcileComplete；包含等待轮次、pending_version、reconcile_epoch／可信度与 ConversationRef | core-notify |

`AccountContext` 是运行会话授权，持久记录另有稳定账号身份；重启时不得因 session_generation 改变而丢弃 outbox，也不得将旧会话记录自动重新发送。重新认证后先核验稳定账号和环境，再把未决记录带入对账。

#### 3.2 发送与业务操作的共同约束

1. 先持久化不可变意图，再提交外部动作。进程在“服务端接受、本地未记账”处崩溃，重启后状态为待核对。
2. 普通消息以稳定 `localId` 关联回执、回推和历史；`status.code=3` 的静态处理只作为待验证样本，不能推出服务端去重作用域与保留时长。
3. SDK 自身会 HTTP 回退；适配器必须记录并约束实际尝试，不能在外层再以“换通道”掩盖未知结果。若 SDK 的内部重试不可控制且同场景证明有重复风险，该候选不能通过 G3。
4. 产品卡片、转接、移除、结束和设置保存不假定接受普通消息 localId；只在本地操作账本中跟踪。它们超时先回读，不自动重发。无法关联卡片回执时保留 unknown 和人工核对入口。
5. 查询失败不能把 unknown 改成 rejected；查询暂时没找到也不能证明未执行。只有有证据的否定结果或已验证幂等策略才允许原意图重试。
6. 已确认仅表示服务器接受；送达、已读、会话结束和责任转移分别表达。发送按钮、UI 乐观项、已读及提醒收起不清除待回复事实。

### 4. IM 核心与两条传输任务包

规模 S/M/L 表示相对复杂度与验证负担，不是日历工期；L 任务进入实现时应再切成可独立检查的提交。

#### IM-01：领域契约与可控 MockTransport（M）

- **Owner／路径**：IM 核心 owner；`domain/transport.rs`、`domain/intent.rs`、`tests/domain/transport_contract.rs`；共享类型只提交提案给 FND-02。
- **前置**：FND-01、FND-02；事件测试接 FND-03。输入为现有证据与上节接缝；输出为可替换 trait、能力矩阵和 mock 故障控制协议。
- **步骤**：分开 transport Connected 与领域 Ready；定义事件大小／队列上限、溢出后的 resync；定义 unknown、撤销、generation 失效及请求关联；mock 支持丢 ACK、回推先于 ACK、重复／乱序、断开、限流、过期和入库失败。
- **验收／证据**：同一领域用例能替换两传输 stub；不能由旧 generation 发布事件；unknown 不触发第二次 send。保留合成夹具和机器可读结果，无客户正文。
- **失败处理**：契约不完整先修契约，不让 UI 或某适配器自行增加旁路。可继续 mock UI；不得冻结真实传输。

#### IM-02：B1 独立 Web SDK 传输原型（L）

- **Owner／路径**：Web 传输 owner，使用第 2 节 Web 独占目录。
- **前置**：IM-01、ACC-02、SHL-01、SHL-02、NET-02a、NET-03a；正式联测还需 ACC-04。输入是经核验的账号 Profile、视图生命周期及 SDK 版本／来源；输出是 B1 实现和可行性记录。
- **步骤**：在账号专用传输 WebView 验证真实 Cookie／Origin 依赖，不读取密码；确认 `100067816` 为网页 SDK appId，业务 head 的 `900004` 单独处理；关联两条 WS 的初始化者和消息类别；验证本地页面能否独立加载，若只能依赖远程页面私有对象则单列漂移风险与替代成本。
- **验收／证据**：在目标 Windows 运行时验证文本／回执、隐藏／最小化／锁屏、聊天窗关闭、浏览器进程崩溃、断网／睡眠、过期／被踢和双账号；验证传输 WebView 只具有受限传输通道，不能访问数据库、通用 IPC 或另一账号数据。G3 按 IM-08 统一样本复验。
- **失败处理**：标 failed 或 blocked 并保存失败动作；保留 MockTransport 与 C 的独立比较，不删除一条未知职责连接，不关闭站点安全来换取“通过”。

#### IM-03：C Node sidecar 原型（L）

- **Owner／路径**：Node 传输 owner，使用第 2 节 Node 独占目录。
- **前置**：IM-01、ACC-03、NET-01、NET-03a；真实联测依赖 ACC-04。输入是凭据 broker、账号生命周期和固定 SDK 来源；输出是 SidecarTransport、候选 SEA 产物及网络边界记录。
- **步骤**：按账号独立 SDK 实例；长度前缀 JSON 管道须有最大帧长、背压、请求 ID、握手超时；Windows 管道限制当前用户、首实例创建和本机连接，凭据不进命令行；Job Object 管子进程，健康检查和重启退避有界；验证候选 Node 运行时及全局 WebSocket 分支；删除 TLS 校验降级，裁剪敏感 SDK 日志和外层重复兜底。
- **验收／证据**：伪造／超大／截断管道帧受控拒绝；父进程崩溃不留孤儿；中文路径、签名后产物、代理／PAC／证书错误逐项记录；同 IM-08 测收发及恢复。SDK HTTP 自带客户端若保留，必须列为 NET-03 的独立受测网络栈。
- **失败处理**：不关闭证书验证、不静默切换 SDK 运行时；不以“官方也使用该 SDK”为交付证据。C 失败不阻断 mock 核心，但不能作为 B1 的自动上线备用。

#### IM-04：不可变发送意图、outbox 与 unknown 核对（L）

- **回复覆盖约束**：SendIntent冻结reply_round_id、pending_version及当时已知客户消息水位；发送确认、历史核对或其他坐席回复，只能解除有证据被该回复覆盖的客户消息集合，不能以ACK到达时间作为回复业务顺序。较新消息保留或建立新等待轮次；同时间戳或顺序不明时保持待核对，不清空当前待回复。重启回放、unknown对账、迟到回推均遵守该规则。验证C1→S1→C2→ACK(S1)、ACK/回推倒序、同时间戳、重启后旧回复到达。

- **Owner／路径**：IM 核心 owner；`messaging/outbox.rs`、`messaging/reconcile_send.rs`、`tests/domain/outbox_*`。
- **前置**：IM-01、DAT-02、FND-04；输入为 SendIntent、AttachmentLease、Store 显式事务和传输能力声明；输出为唯一发送编排服务。
- **步骤**：CAS 冻结草稿和附件引用；原子写本地消息／outbox；按 queued、sending、confirmed、rejected、unknown 迁移；合并 ACK／回推／历史并校验内容与作用域；未决操作重启后先核对；只对有证明的可重试条件复用原意图；提供待核对列表和诊断原因。
- **验收／证据**：发送前、提交后、ACK 前、ACK 后但落库前分别崩溃；HTTP200 但业务失败；ACK 迟到／重复、回推先到；同 localId 改正文；两账号同 gid；旧备份恢复；磁盘不足；附件临时 TTL 到期。每个意图可追到稳定状态或显式 unknown，无静默二发、错会话归并或丢附件。
- **失败处理**：持久化失败不提交；身份／附件归属不明拒绝；恢复查询缺证据保留 unknown，UI 不提供无条件“重试全部”。unknown 核对只由本任务拥有，助手不建第二发送账本。

#### IM-05：入站、分页、历史与完整同步水位（L）

- **Owner／路径**：IM 核心 owner；`sync/ingest.rs`、`sync/history.rs`、`sync/reconcile.rs`、对应领域测试。
- **前置**：IM-01、DAT-02、NET-01；输入为脱敏消息／控制帧和分页响应；输出为已提交消息、内部游标、缺口／完整度与恢复屏障。
- **步骤**：按账号／环境／会话及经核验消息标识去重，分离业务消息、控制帧、邀请和 IQ；证明同消息跨连接关联方式；前后向历史分别适配 `beginTime/endTime/direction`，不伪造 `after=msgId`；验证排序、时间单位、边界包含性、同时间戳满页与 `haveRest` 终止；每页消息与分页断点原子提交；只有整轮终止条件已有证据且不存在未处理缺口，才推进 complete_watermark。提供本地缓存范围的受限搜索服务，消费DAT-02仓储，不调用未知上游全文检索；查询可取消，范围/结果预算明确，撤回与删除同步影响可见结果。
- **验收／证据**：M3 先到而 M2 后到、满页同毫秒、重复页、空页但 haveRest、翻页中断、SDK 先确认而数据库写失败、离线消息超出补偿范围。若上游不能证明完整性，展示有缺口并阻止以完整状态解除恢复屏障。
- **失败处理**：有界重叠补拉、限速和退避；不可无限循环或以最新已见时间冒充完整。保存失败区间与待对账状态，不能仅靠 UI 去重掩盖数据库重复。

#### IM-06：AccountSession、草稿、未读与回复责任事实（L）

- **回复覆盖约束**：SendIntent冻结reply_round_id、pending_version及当时已知客户消息水位；发送确认、历史核对或其他坐席回复，只能解除有证据被该回复覆盖的客户消息集合，不能以ACK到达时间作为回复业务顺序。较新消息保留或建立新等待轮次；同时间戳或顺序不明时保持待核对，不清空当前待回复。重启回放、unknown对账、迟到回推均遵守该规则。验证C1→S1→C2→ACK(S1)、ACK/回推倒序、同时间戳、重启后旧回复到达。

- **Owner／路径**：IM 核心 owner；`domain/session.rs`、`domain/draft.rs`、`domain/reply_pending.rs`、`domain/unread.rs`。
- **前置**：IM-04、IM-05、ACC-01、NET-04、FND-03；mock 即可实现。真实联测再接 ACC-04 和 IM-02／03，IM-08 是交付门槛而非本任务实现前置。
- **步骤**：账号认证、传输连接、客服工作状态、会话责任分别建模；按唯一 ClockService 建立首条未回复等待轮次；确认有效回复／结束／责任转移后清除，连续追问不延后；已读基线与去重增量合并；持久草稿 CAS；恢复时串行 reconcile，完成后发送新 reconcile_epoch 的事实事件。
- **验收／证据**：先读后订阅丢事件的反例、旧快照覆盖、账号切换时迟到翻译／草稿、只读未回复、发送 unknown、责任转移、墙钟跳变和睡眠期间已被他人回复。NTF 接收带 pending_version 的事实，不自行计算首次 T1；恢复前不发旧超时噪声。
- **失败处理**：时间锚点过期标 stale；对账失败保留“待核对”并给出显式状态，不能静默当已回复。IQ／系统通知的事实进入 shell 的 notice 路由，不能把客户未读和系统待办混算。

#### IM-07：附件、引用、撤回、已读及其他消息能力（L）

- **Owner／路径**：IM 核心 owner；`messaging/attachments.rs`、`messaging/receipts.rs`、`messaging/recall.rs`、`messaging/typing.rs`。
- **前置**：IM-04～06、NET-01、媒体 AttachmentLease 接口；真实上传须待媒体链路与相关端点契约通过。输出为类型化消息能力命令及支持状态。
- **步骤**：核对 `uploadTokenCreate` 到实际对象上传及消息提交的完整链路，令牌／对象权限不进 UI；引用／@ 校验同会话成员和目标；撤回单独跟踪业务结果；已读只覆盖实际可见且已展示水位；输入状态有界节流并超时清除；未识别消息类型安全展示为不支持，不丢弃完整度信息。
- **验收／证据**：上传成功但发信 unknown、取消上传、令牌过期、超限类型、跨账号 media_id、撤回权限／时限失败、已读响应丢失、引用消息未缓存、成员已退出。与产品卡片发送分开验收，不能以文本通过代替附件或撤回通过。
- **失败处理**：保留已取得持久租约，按 outbox 终态和保留策略释放；能力缺少业务证据时入口明确不可用并说明原因，不调用未验证接口假装完成。

#### IM-08：B1/C 共同故障矩阵、G3 证据与传输决策（L）

- **Owner／路径**：独立 IM 验证 owner；`vbk/tests/im-acceptance/`、`vbk/fixtures/im/`、`docs/validation/im/`。
- **前置**：IM-02／03均有可复算终态记录（passed/failed/blocked），胜出候选可运行；IM-04～07及已启用IM-09、ACC-04、NET-03b／04；所有功能启用还要通过对应 OPS 验收。输入为候选产物或失败/阻塞证据及相同夹具；输出为逐场景 passed／failed／blocked 记录和 D-IM 决策提案。
- **步骤**：固定测试身份类别、客户端／SDK／页面／运行时版本及签名来源；用相同文本、图片、文件、引用、撤回、已读、双账号及故障点比较；分别记录 SDK 自动 ACK 与本地 durable commit 的先后；每条外部副作用核对服务端和另一测试端最终所见。
- **验收／证据**：正常前台、最小化、隐藏、锁屏、聊天窗销毁、断网、睡眠、token 过期、踢线、传输崩溃、数据库失败、双连接重复、分页缺口和代理差异全部有结果。目标 10 秒恢复只在网络／凭据有效前提下测；未达到要记录分布和残留缺口，不能隐藏 unknown。
- **失败处理**：B1通过后才建议优先B1；B1不可行或阻塞但C全矩阵通过时可选择C并记录原因；未完成验证的候选不能称已就绪备用；都未通过保持原型，不自动改用官方整页或 Rust XMPP。SDK 来源可信性、使用／再分发安排和版本固定为发布准备项，缺证据标 blocked，不把拆包可读当许可证明。

#### IM-09：入站批量与 IQ 翻译（M）

- **Owner／路径**：IM核心；`vbk/crates/core-im/src/messaging/inbound_translation/`；UIIM owner消费结果。
- **前置**：IM-05消息归属、NET-01端点策略、DAT-02仓储、REL-02偏好契约；mock可先运行，真实能力单独取证。
- **输入／输出**：账号/会话/msgId集合及目标语言→逐条译文、失败或不支持状态；原文始终可见。
- **步骤**：核验`11679/batchTranslateByMsgIds`与必要IQ路径，核对方法级成功/权限/部分失败结构；合并批次但有界并发，缓存键含环境/账号/会话/消息/目标语言和内容版本；用户切语言、删除/撤回、登出及旧generation回包均复核。助手出站翻译总开关不控制本能力；不实现自动回译发送。
- **验收／证据**：部分成功、重复响应、同msgId跨账号、原文迟到、无权限、撤回后返回、目标语言快速切换、无网与取消；一条失败不阻塞原文或整批其他结果。UIIM-03接入显示/重试入口，QA-04按启用范围验证。
- **失败／回退**：显示原文及明确翻译状态；未确认端点不启用。查询重试按Net有界策略，不把译文写成用户草稿或发送消息。

### 5. 客服业务操作任务包

#### 5.1 端点级契约登记规则

OPS-01 维护的每个方法记录至少包括：精确 host/service/path/大小写／后缀、请求字段类型、认证方式、业务成功条件、权限／无数据／异常结构、读回方法、超时行为、证据等级和版本指纹。`Ack Success`、`bizResponseStatus`、`status.code`、`response.errorCode` 必须按实际方法解释；缺少已确认成功判据时返回 `unsupported_response` 或待核对，不能因为 HTTP200 就更新为成功。

写操作先读取当前对象版本和权限，只能降低本地权限、不能绕过服务端授权。权限 UI 是提示，不是鉴权来源。没有成功、业务拒绝、无权限和超时读回样本的写能力可实现 mock 和适配骨架，真实入口仍保持 blocked。

| 任务 | 工作对象与接口家族 | 当前证据等级／关键待验证 |
| --- | --- | --- |
| OPS-02 | `16037/setVenAgentStatus`；role14 的 `20016` 实名链路 | 工作状态读取有动态；写入及分配规则未验收 |
| OPS-03 | `16037` 排班、话术、自动答复／翻译；`15529` 自服务设置 | 部分读取动态，其余静态；权限、保存、自动发送归属待证 |
| OPS-04 | `transferVenMaster`／`15529/updateGroupOwner`，邀请／候选，`finishConversation` | 候选读取动态；写入及多坐席收敛待证 |
| OPS-05 | `finishConversation` 无目标列表分支与结束前置流程 | 静态；退出当前坐席与全体会话终结不能等同 |
| OPS-06 | `15529/getVBKImUserInfo`／`getImPlusModuleJump` 与侧栏桥 | 静态映射及部分入口动态；完整响应／无权限待补 |
| OPS-07 | `queryRecommendProductList`／`sendCardMessageForOffline`／推荐 URL | 查询有动态；卡片发送、客户语言／币种与回执未证 |
| OPS-08 | `14735` 摘要、`14361` 门票列表、`16037/getDLTOrderInfo` 等 | 票务列表空结果动态；有效详情和其他业务线未证 |

#### OPS-01：类型化业务命令与端点证据账（M）

- **Owner／路径**：客服操作 owner；`operations/contracts.rs`、`operations/registry.rs`、`tests/operations/fixtures_*`；证据索引交 IM 验证 owner 写入其目录。
- **前置**：FND-02／04、NET-01、IM-01、DAT-02。输入为研究中的方法分支；输出为端点策略提案、各业务命令和本地操作记录接口。
- **步骤**：明确查询／写入性质，按动作建命令而非 `{op,payload}` 透传；字符串／数字 ID 按方法编码；未知枚举保留原结构摘要但不泄露响应正文；注册读回与并发控制策略。
- **验收／证据**：空业务体、Ack成功但显式失败、数字／字符串状态差异、未知响应、账号代次失效及恶意泛用 op 均不会落成成功；脱敏契约夹具可独立回放。
- **失败处理**：单端点不确定只阻断该能力，不阻断基础 IM；全局解析器不得以宽松兜底把未知返回变为成功。

#### OPS-02：客服工作状态与实名前置（L）

- **Owner／路径**：客服操作 owner；`operations/work_status.rs`、`operations/real_name.rs`。
- **前置**：OPS-01、ACC-04、IM-06、NET-01。输入为当前身份、角色和服务端 currentStatus；输出为串行状态操作及已确认状态事实。
- **步骤**：保留 IDLE=0、HANGUP=1、LEAVING=2、GETOFF=3；网络 offline 与工作状态不同；roleId14 从 GETOFF 上线前走已验证的实名检查／二维码任务／轮询，未知结果不得按成功跳过；提交后回读 currentStatus；操作版本抵御快速切换和双端竞争。
- **验收／证据**：四种状态、需要实名／取消／过期／异常、无权限、超时但服务端已生效、另一端覆盖、退出与崩溃均有案例。记录是否影响新会话分配、已有责任、自动恢复；没有观察到的分配语义保持未知。
- **失败处理**：超时显示待核对并回读，不切 Socket 伪装下班，不回滚 UI 后静默重写；登录成功不自动写 IDLE。

#### OPS-03：个人业务设置与快捷回复（L）

- **Owner／路径**：客服操作 owner；`operations/settings/`、`operations/scripts/`。
- **前置**：OPS-01、IM-06；设置 UI 接入 UIIM-04，桌面 prefs 仍由其原 owner 管理。输出为分类查询、版本化修改和保存后回读。
- **步骤**：拆为排班／时区、话术分类与条目／排序、自动答复、自动翻译、自服务通知五组子提交；严格区分 VAGENT、VSKILLGROUP 和 providerId；团队 LEADER／灰度菜单只作为 UI 条件，服务端仍判权；排班校验重复特殊日／休假和不完整时段；自动翻译等写成功后再确认展示。
- **验收／证据**：每组至少成功、拒绝、无权限、超时读回；错供应商范围、排序并发、夏令时／时区、修改失败不覆盖旧值；验证自动答复由谁发送，未知时不另造客户端自动发送器。话术只插草稿，点击条目不自动发客户消息。
- **失败处理**：保存不确定保留提交快照及待核对提示；头像／昵称仅发现读取，未补写接口前保持只读；桌面声音／快捷键／缩放不误写 SOA。

#### OPS-04：主客服转移、邀请与指定成员移除（L）

- **Owner／路径**：客服操作 owner；`operations/members.rs`、对应业务测试。
- **前置**：OPS-01、IM-06；输入为已回读会话类型、责任、成员与业务配置；输出为分支明确的成员命令及刷新后事实。
- **步骤**：普通转移调用 `16037/transferVenMaster`，旅游群主分支先查 `15529/getGroupOwner` 再按条件用 `updateGroupOwner`；商家邀请与携程技能组邀请分开；候选展开／搜索分别处理数组 `results[0]` 和对象 `results`；外部保留 `worksheetId` 与 `workSheetId` 的准确拼写和类型；移除必须有非空目标，不可默认成结束。
- **验收／证据**：恰好一个转移目标、排除自己／已在群成员、无权限、B2MC不适用、角色变化、并发转移、已离群、空目标和超时；通过 `checkMemberStatus`／成员／会话回读与另一测试坐席核对。拒绝复制旧 `some(p=>"1")` 恒真判断。
- **失败处理**：写结果不明先回读，不能对 `finishConversation` 自动删掉目标重试；上游缺少乐观锁时串行本地操作并在提交前后核对，跨端竞争仍需显式冲突处理。

#### OPS-05：结束／退出会话及责任收敛（L）

- **Owner／路径**：客服操作 owner；`operations/finish.rs`。
- **前置**：OPS-01、OPS-04、IM-06。输入为当前会话角色、业务配置和待回复事实；输出为类型化结束操作和服务端确认后的责任变更。
- **步骤**：保留 BC 特定配置下“先回复／先转主客服”、评价弹层、`finishTourChat` 等分支为待验收流程；调用不含 `venAgentUids` 的独立结束适配器；成功后读取实际状态，不能按一秒定时器直接宣布全体会话终结。
- **验收／证据**：当前坐席退出、其他成员继续、已结束、主客服未转移、超时、结束与新消息并发、后续重新进入会话；核对其他坐席所见和列表。只有明确终结或本账号责任转移才清相应回复轮次。
- **失败处理**：保留原等待事实并标待核对；不把窗口关闭、UI FINISH 或本地成功 Toast 当结束证据，不允许侧栏消息隐式重开已结束会话。

#### OPS-06：右侧栏资料、权限与受限桥（L）

- **Owner／路径**：客服操作 owner；`operations/sidebar.rs`；侧栏 UI 由 UIIM-04，远程承载／桥实现交业务页 owner。
- **前置**：OPS-01、IM-06、FND-04、SHL-01；输入为 ConversationRef／locale／服务端权限；输出为类型化资料和受限动作提案。
- **步骤**：映射用户／语言／标签、咨询来源、来源轨迹、历史订单、浏览记录、底部跳转；不将 `lastSourceTrace.msg` 当可信 HTML，解析 JSON 设大小／深度限制；分别表达未授权、无数据、失败和未知；冻结自研侧栏或官方远程侧栏路线，二者不同时拥有发送状态。
- **验收／证据**：补采 `getVBKImUserInfo`、`getImPlusModuleJump` 成功／无权限；伪造 `IMCustomAreaInfo`、旧会话 `sendTextMessage`、恶意 JumpUrl、未授权最近五条消息请求均拒绝。远程 `quetoTextEdit` 只能转为经用户确认的草稿操作，发送必须走 core-im 意图与授权。
- **失败处理**：桥无法可信识别来源／文档代次则禁用该动作，保留安全只读内容或受控导航；不沿用 `postMessage("*")` 或只按 eventCategory 授权。

#### OPS-07：产品推荐查询、卡片与客户版本（L）

- **Owner／路径**：客服操作 owner；`operations/recommendation.rs`、`operations/card_send.rs`。
- **前置**：OPS-01、OPS-06、IM-04 的操作结果／核对约束（卡片另有端点适配器，不伪装 SDK 文本）。输入为推荐权限、产品响应及会话；输出为分页推荐和卡片提交结果。
- **步骤**：实现 `15529/queryRecommendProductList` 和城市建议，末页按响应与业务分支判断，不能固定十条；保留客户版本列表、币种／客户语言、templateId、groupIdentity 业务分支；卡片使用 `sendCardMessageForOffline`，其 `inSession:true` 不因方法名改成离线逻辑；区分 15529 和 11419 的同名 session URL。
- **验收／证据**：权限缺失、模板缺失、失效产品、特殊五条分页、业务1513／2384客户价格语言、2508／2510身份分支、结束会话、超时、重复点击；取得卡片业务成功、消息关联及最终客户所见，`Ack Success + data非空` 只作为静态候选判据。
- **失败处理**：未知结果进入本地操作账本，不能重发卡片或改发普通文本；无法证明关联与安全核对时禁用真实发送，查询可独立交付。

#### OPS-08：按业务线接入订单与条件能力（L）

- **Owner／路径**：客服操作 owner；`operations/orders.rs`、`operations/optional_features.rs`。
- **前置**：OPS-01、OPS-06；受控页面导航接业务页 owner。输出为明确来源的摘要／列表／详情入口和能力状态。
- **步骤**：14735 的关联订单摘要、15529 的历史订单卡片、14361 门票用户订单列表、16037 的 B2O 酒店订单卡片分别适配；14866 只列待取证候选，不能当已观察入口；queryType／requestType／decryptType按现有调用点验证，不扩大数据范围。
- **验收／证据**：选择有有效订单的测试会话，逐业务线记录摘要、列表、详情、无权限／无数据；验证同订单跨账号不可访问、URL来源与身份绑定。售前零订单样本不能证明详情通过。
- **失败处理**：未支持业务线显示能力边界并进入受控已验证页面，不用一个错误接口兜底全部订单。`modifyRemark`、`startChatB2C`／`createChatB2O`、优惠券／线路推荐列为条件子能力：各自补契约后才能启用；`receivePromotion` 等缺证据写入不纳入已完成范围。

### 6. 本地 IM 界面任务包

#### UIIM-01：分区状态与会话／消息虚拟列表（M）

- **Owner／路径**：IM 界面 owner；`ui/apps/im/src/conversations/`、`messages/`、`state/`。
- **前置**：FND-02／03、IM-01；IM-05／06 交付前用同契约 mock。输出为可运行的本地界面及快照／增量接入。
- **步骤**：会话列表、消息分页与编辑缓冲独立；按 ConversationRef 局部更新；先订阅缓冲再取原子快照，跳号／epoch变化重同步；滚动历史保持锚点，离开底部不强制拉回；重连和历史缺口有明确展示。
- **验收／证据**：一万条消息、快速切号切会话、迟到快照、重复事件、窗口关闭重开、订阅溢出；输入不触发整列表重算，消息不能跨账号闪现。
- **失败处理**：停止应用不连续增量并取快照；不把本地 store 当业务真相，不用刷新整个窗口掩盖状态错乱。

#### UIIM-02：编辑器、草稿 CAS 与发送结果（L）

- **Owner／路径**：IM 界面 owner；`editor/`、`send-state/`。
- **前置**：UIIM-01、IM-04／06 的契约；未完成核心时使用 mock。输出为正文／引用／@／附件意图与结果视图。
- **步骤**：非受控编辑器与列表分离；中文 IME composing 时 Enter不发送；debounce仅用于持久草稿，切换／关闭前刷写并处理失败；发送快照绑定 expected_draft_version，保存后再次修改的草稿不被旧发送清空；助手译文先预览，CAS替换后按同一发送链路提交。
- **验收／证据**：一万字、连续中英输入、重复点击、用户改稿后翻译返回、发送unknown、草稿保存失败、两窗口改同会话；同 localId 不能以新正文重试。
- **失败处理**：草稿冲突保留双方内容及提示，不能覆盖新版本；未知发送结果清晰显示“待核对”，不以红色失败按钮诱导盲重发。

#### UIIM-03：附件、引用、搜索与辅助输入（M）

- **汇总补充约束**：本地关键词搜索由IM-05与DAT-02实现参数化、有界、可取消的缓存查询；界面标缓存范围和截断。FTS5属于后续明确扩展，不在本次静默新增硬依赖。接入IM-09逐条入站翻译状态与原文展示。

- **Owner／路径**：IM 界面 owner；`media/`、`search/`、`composer-tools/`。
- **前置**：UIIM-02、IM-07、媒体／助手已冻结插槽接口。输出为进度／错误／预览／定位交互。
- **步骤**：粘贴／拖拽／截图只取得绑定上下文的 media_id，不传 base64；显示上传和发送两个阶段；表情懒加载、@候选来自成员快照；搜索注明仅已缓存范围；引用缺失时显示待加载而不引用另一会话同ID消息。
- **验收／证据**：上传结束时切号／登出、窗口销毁、中文文件名、离线、撤回引用、跨账号句柄、搜索定位分页缺口。
- **失败处理**：失败保留可恢复草稿和持久附件引用，释放由媒体／outbox协议决定；UI不得自行删除未知发送的附件。

#### UIIM-04：业务操作入口、侧栏与设置（L）

- **Owner／路径**：IM 界面 owner；`service-operations/`、`sidebar/`、`personal-settings/`。
- **前置**：UIIM-01／02 与 OPS-01契约；各真实入口按 OPS-02～08 单独启用。输出为分权操作 UI、操作进度和结果核对入口。
- **步骤**：登录、连接、工作状态分别呈现；转接／邀请／移除／结束分别设计，提交前展示实际对象；侧栏分离无权限／无数据／失败；客户产品版本在发送前可核对；桌面偏好跳至本地设置；总结消息侧窗只读取经授权历史，未知的总结服务不在本任务中凭空实现。
- **验收／证据**：操作中切会话、权限被撤、成员刷新、空选择、双端状态覆盖、产品语言币种变化、结束结果未知；隐藏菜单后伪造命令仍被核心拒绝。
- **失败处理**：按能力禁用单入口并标原因，主会话继续可用；未验收写入不能靠 UI 确认框替代服务端证据。

#### UIIM-05：性能、可用性与跨模块联合验收（M）

- **Owner／路径**：IM 界面 owner 负责性能修正；独立验证 owner 负责 `tests/im-acceptance/ui/` 和证据。
- **前置**：UIIM-01～04、IM-06／08可运行部分；与通知／媒体／助手各 owner 共同完成集成，不能以 stub 当最终通过。
- **步骤**：沿用总纲同机、同账号／页面／功能对照；分别记录纯官方、官方+助手、新原型；相同输入／滚动场景测试10分钟；记录 P50/P95/P99、样本数、运行时和所有关联进程资源。
- **验收／证据**：按键P95≤50ms、一万条列表帧耗时P95≤16ms、本地缓存切会话≤150ms；IPC P95≤20ms与含最多50ms批次等待的落库上屏≤100ms分开测；新消息到横幅≤300ms由通知链路联测。目标未达要列瓶颈与范围，不宣称已省半内存。
- **失败处理**：以测量定位编辑器／列表／IPC／入库瓶颈；编辑器替换须保留草稿格式迁移与可回退契约。发布能力不因性能测试通过而绕过G1/G3/G5。

### 7. 执行波次与交接检查

| 波次 | 可并行工作 | 等待项／交接条件 |
| --- | --- | --- |
| A：契约与原型准备 | IM-01、OPS-01；UIIM-01结构与合成数据 | FND-02先交最小类型，未定字段以契约提案处理 |
| B：独立原型与核心 | IM-02、IM-03、IM-04／05、UIIM-01／02 | B1等ACC-02/壳；C等凭据broker；核心可用Mock与DAT接口 |
| C：业务事实与消息能力 | IM-06／07、OPS-02～08分组、UIIM-03／04 | 同一owner子任务串行提交；写路径先有独立操作契约 |
| D：同场景对抗验证 | IM-08、UIIM-05及各OPS真实受控验收 | 真实测试身份／会话、目标Windows产物、可恢复试验环境到位 |
| E：冻结与交付 | 合入通过候选、关闭未通过入口、形成G3范围清单 | 不能把未通过功能写成“已支持”；与G1/G2/G4/G5联合放行 |

每次交接必须给出：任务ID／提交范围、使用的契约版本、公开接口／样例、前置已完成状态、测试命令与摘要、未解决风险、尚为mock或静态证据的部分、后继代理可立即执行的动作。公共类型变化需要列全部消费者并先合契约，再由owner更新各自实现。

真实验证依赖专用测试会话与测试身份，不使用真实客户来填消息／转接／结束／状态变更样本。若环境未提供，对应记录为 blocked，继续合成故障与本地核心工作；不得用自然入站观测替代受控写入验收。

### 8. 完成标准与明确不作的承诺

只有相应任务代码通过其验收、对应端点具备方法级证据、传输完成共同矩阵，功能才可标为可交付。G3记录应逐项列出已启用／明确禁用／blocked的消息种类、客服操作、业务线和角色范围；不能用一句“IM整体通过”掩盖产品卡片、订单详情或结束会话仍未验收。

本计划不承诺 exactly-once、不把 SDK 源码注释当服务端契约、不宣称130秒自然帧证明长期可靠、不保证隐藏WebView与后台进程等价、不把 HTTP200／Ack／连接成功当业务完成。它要求每一次有外部副作用的动作都能追到已确认、明确拒绝或可见的待核对状态；每一个无法证明的完整区间和权限条件都被保留，而不是被界面掩盖。


## 第三部分：桌面外壳、业务页与提醒

2026-10-30 · Asia/Singapore

本文把 [壳与窗口](../dev/01-shell.md)、[业务页承载](../dev/04-business-pages.md)、[强提醒](../dev/03-strong-alert.md) 拆成可分派任务。公共身份、事件和权限以 [开发总纲](../dev/00-architecture.md) 为准；取证边界以 [最终审查](../reviews/2026-10-30-final-adversarial-review.md) 为准。本文是计划，没有执行目标 Windows 运行时验收；全部任务初始为 `planned`，不能把所列验收条件当作通过记录。

### 1. 从不能丢失的事实划分责任

1. 窗口只是事实的展示入口。隐藏、关闭或重建窗口不能改变账号归属、待回复事实和在途操作。
2. 同一系统资源只能有一个管理者。core-shell 创建和销毁原生窗口、登记视图；业务页模块提供配置与策略；core-notify 决定提醒表现；core-im 决定首条未回复、首次 T1 和责任变化；core-net 提供唯一 ClockService。
3. 远程页面可以失败或被篡改。保留 CSP、站点隔离和 TLS 校验；兼容失败用明确降级处理，不能通过开放通用 IPC 获得“兼容”。
4. 业务页中的未保存内容不等于缓存。确认可恢复之前不得为满足内存配额自动销毁；账号切换与资源回收是两项不同操作。
5. 提醒点击不是回复成功。已读、本地收起、本地确认、有效商家回复、结束、责任转移分别建模，任何一种前端交互都不能伪造服务端事实。
6. 并行开发依赖接口，而不依赖别的模块先写完整产品。共享 trait、合成事件、假时钟和宿主夹具先行；目标平台证据决定适配器是否进入生产组装。

### 2. 文件归属与可并行接缝

下列均为**拟建**路径，位于 `vbk/`。一个文件同一时刻只有一个写入 owner；角色是可复用的任务席位，不要求同时启动全部角色。共享文件由集成 owner 修改，其他代理提交契约变更清单。

| owner 角色 | 独占实现范围 | 不得直接修改 | 输出给谁 |
| --- | --- | --- | --- |
| DesktopShell | `vbk/crates/core-shell/src/{registry,lifecycle,host,tray,shortcuts,activation,recovery,shutdown}/`；`vbk/crates/core-shell/src/platform/win/{window,host,tray,activation,recovery}.rs` | `vbk/crates/core-shell/src/business/`、`vbk/crates/core-shell/src/bridge/`、`vbk/crates/core-shell/src/platform/win/biz.rs`、共享入口 | WindowService、注册表租约、焦点/电源事件，供业务、IM、提醒、媒体使用 |
| ShellUI | `ui/apps/shell/`；`ui/apps/setting/` 的框架及通用/快捷键分区；`ui/packages/shell/` | 其他模块的设置分区实现、IPC 生成类型 | 账号导航、宿主矩形、设置分区插槽 |
| BusinessHost | `vbk/crates/core-shell/src/business/`、`vbk/crates/core-shell/src/bridge/`、`vbk/crates/core-shell/src/platform/win/biz.rs`、`ui/packages/business/`、`ui/packages/notice/`、`ui/apps/web/` | 壳注册表、账号 Profile 工厂、下载执行器 | 8 入口与工作台、远程桥、通知中心展示 |
| NotificationCore | `vbk/crates/core-notify/src/{actor,policy,queue,presenter,attention,sound,toast,env}/`、`vbk/crates/core-notify/src/platform/` | 首次 T1 判定、ClockService、原生窗口创建 | 提醒队列、版本化动作、表现请求、声音/Toast |
| NotificationUI | `ui/apps/alarm/`、`ui/apps/notifier/`、`ui/apps/tooltip/`、`ui/packages/notify-settings/` | 提醒业务状态机、setting 根路由 | 三个轻量展示入口与可插入的设置分区 |
| 集成 owner | `src-tauri/` 注册和 capabilities；各 crate `lib.rs`/`mod.rs` 组装；Cargo/前端 workspace、依赖和 lock；`crates/contracts/`；`crates/platform-win/`；共享 ui-kit/ipc | — | 合并模块清单与接口，生成 Rust/TS 一致类型 |

目录模块新增的 `mod.rs` 仅限 owner 自有子目录；跨 owner 的父级模块注册由集成 owner 合入。平台复用函数先在归属模块内验证，确有两方使用时才提取到 `platform-win`，避免多人同时改公共 Win32 封装。

| 交付接缝 | 提供方 | 消费方与规则 |
| --- | --- | --- |
| `ProfileLease` / ProfileFactory | ACC-01/ACC-02，接口 FND-02 | SHL-02、BIZ-01 只使用租约，不解析 Cookie 或另建身份映射；account 撤销后宿主销毁对应控制器 |
| `WindowService` / ViewLease | SHL-01 | 业务/提醒/媒体提交 WindowKind、账号、规格和参数；只由 shell 创建原生窗口；异步结果携带视图与环境代次 |
| 原子快照与有界增量 | FND-03 | 壳、业务、提醒 UI 共用 IPC 包，不能各写一套“先快照后订阅” |
| `ReconcileComplete` 与待回复事实 | IM-06 | NTF-01/NTF-02 只消费已提交事实，恢复时须同时匹配 AccountContext、pending_version、reconcile_epoch |
| ClockService | NET-04 | IM-06 生成首次 T1，NTF-02 安排后续表现；前端不另算服务器时差 |
| 下载任务注册 / 受限媒体句柄 | 媒体模块 | BIZ-04 交出执行来源和上下文；一次下载只有 WebView 或 Rust 中的一个执行者 |
| 偏好快照 / 更新排空协调 | 发布与偏好模块 | SHL-06、NTF-04/NTF-05 提交 typed 配置及资源排空接口；不自行写第二套偏好文件 |

### 3. 公共前置与排程

FND-01 是工程骨架；FND-02 是身份/服务 trait/DTO；FND-03 是事件、快照与 mock；FND-04 是授权和并发反例验证。编号详见 [基础分计划](01-foundation-account-data.md)。IM 事件任务见 [IM 分计划](02-im-and-service-operations.md)。

`依赖` 表示开始对应实现所需的最小产物，不表示整个模块或 G1–G5 都必须完成。标注“真实联调”的前置只阻止生产组装，mock 开发可以继续。S/M/L 是任务相对复杂度，L 必须按下列检查点逐段交付，不换算成固定日期。

| 波次 | 可开始的任务 | 完成条件 |
| --- | --- | --- |
| A：接口后立即并行 | SHL-01、SHL-02 最小宿主原型；BIZ-01 入口解析；NTF-01 队列；SHL-03/NTF-03 的 mock UI | 使用同版 FND 契约；Profile/WindowService/事实流可用替身 |
| B：实现与取证分开推进 | SHL-04/SHL-05/SHL-06；BIZ-02/03/04；NTF-02/04 | 先完成可复算本地反例，再在隔离安装包和测试账号上取证 |
| C：联合验收 | BIZ-05/06/07；NTF-05/06；跨模块恢复与退出 | 接入真实模块，记录 G2/G4 证据；未过入口和能力显式禁用 |

SHL-02 与 ACC-02 是同一 Profile/宿主原型的两个工作包，使用 FND-02 的 ProfileFactory 最小控制器夹具并行；禁止写成“壳等完整账号模块，账号等完整壳模块”的循环。正式宿主组装须同时引用两方证据。

### 4. 壳与系统集成任务

#### SHL-01：窗口与视图注册表（M）

- **owner / 路径**：DesktopShell；`core-shell/src/registry/`、`lifecycle/`。依赖 FND-01、FND-02；事件联调依赖 FND-03。
- **输入 → 输出**：受授权 WindowKind + AccountContext + 创建参数 → ViewLease、WindowService、窗口快照、定向就绪/失败事件；登记实际调用 WebView，拒绝 JS 自报身份。
- **实现步骤**：①明确 Absent/Creating/ReadyHidden/ReadyVisible/Failed/Destroying 转移；②`window_ready` 绑定当前 view_generation；③创建请求合并且有界，5 秒就绪超时进入可恢复失败；④预热排在主外壳可交互之后；⑤单例跨账号复用前撤销旧任务、清空旧内容和资源句柄。
- **验收 / 证据**：A 请求 viewer 后切 B，A 的迟到 ready 不能显示到 B；重复 ensure 只有一个控制器；就绪超时后可重建；销毁途中旧回调不能复活窗口。保存事件时序、注册表快照和资源计数，不能只截“窗口已打开”。
- **失败 / 回退**：保留失败占位与重试入口；禁止绕开注册表直接 new 窗口，禁止无限等待和无限 reload。

#### SHL-02：Windows 宿主、Profile、焦点与 DPI 原型（L；G1/G2 部分）

- **owner / 路径**：DesktopShell；`core-shell/src/host/`、`platform/win/host.rs`，原型夹具放 `vbk/prototypes/desktop-host/`。依赖 FND-02、SHL-01；与 ACC-02 并行。
- **输入 → 输出**：ProfileLease、业务视口、测试 URL → 子 WebView 或独立窗口适配器、Profile/环境拓扑证据、锁定版本和决策记录。
- **实现步骤**：①先用两个合成身份/测试页验证创建、隐藏、重建；②再用受控账号验证实际身份及 Cookie/localStorage/IndexedDB/service worker 隔离；③两个账号各三个页面切换 100 次；④125%/150% 缩放、多屏负坐标、最大化、IME 输入、Ctrl+F、F5、系统快捷键；⑤对照独立窗口路线，记录内存与焦点成本。
- **验收 / 证据**：保存 OS/Tauri/wry/WebView2/SDK 版本、构建哈希、测试身份类型、屏幕参数、切换耗时和错误；不能仅因 `document.cookie` 不同宣布隔离。已存活视图切换目标 ≤100 ms，冷页面加载单独统计。
- **失败 / 回退**：多子 WebView 不可靠则选每页显式独立窗口；Profile 接入失败可选每账号独立数据目录并重测资源。两路线都失败则 G2 blocked；不得贴附无边框窗口伪装原型通过。

#### SHL-03：主外壳、设置框架与多账号导航（M）

- **owner / 路径**：ShellUI；`ui/apps/shell/`、`ui/apps/setting/`、`ui/packages/shell/`。依赖 FND-03、SHL-01；可用 ACC-01 与业务入口 mock；真实联调接 ACC-04、BIZ-01。
- **输入 → 输出**：账号聚合快照、可见菜单、窗口状态 → 导航请求、宿主逻辑矩形、加载/失败视图、设置分区插槽；当前账号只用于新导航意图。
- **实现步骤**：①账号切换/排序/昵称走账号命令；②导航按后台返回的权限交集展示；③独立 im 是当前默认，设置单例；④主外壳只报逻辑视口，Rust 处理 resize/DPI；⑤通用、快捷键、提醒、网络、助手、更新分区以组件插槽合入。
- **验收 / 证据**：快照晚于新账号响应不会覆盖新画面；权限撤销后菜单和订阅同步撤销；慢接口不阻塞本地壳可交互；弹出设置不复制会话状态。记录订阅水位、账号切换事件与长任务。
- **失败 / 回退**：菜单无权限/加载失败用明确状态，不猜测旧菜单权限；独立 im 与内嵌 im 的产品选择若改变，先由集成 owner 更新契约与 capability 后再改实现。

#### SHL-04：单实例、深链与通知激活（M；G4 部分）

- **汇总补充约束**：通知冷启动使用DAT-02的NotificationActionRepository解析持久token；重新验证稳定账号身份后仅导航，不按旧session_generation授权，不确认新消息；未知/过期token安全回主界面。

- **owner / 路径**：DesktopShell；`core-shell/src/activation/`、`platform/win/activation.rs`。依赖 FND-02、SHL-01；真实导航接 IM-06/UIIM-01；安装注册由发布 owner 合入。
- **输入 → 输出**：启动 argv、第二实例参数、专属 scheme、短效 action token → 经重新授权的导航意图或结构化拒绝。
- **实现步骤**：①普通应用启动先接单实例，内部 crash-monitor 模式在此前完成受约束分流；②冷/热启动共用解析器；③限制 URL 长度、参数和协议，禁用未证实的 `action=auth`；④未登录目标有界排队且绑定目标身份，不在后来另一账号执行；⑤通知 token 只映射已展示对象与版本，URL 不含票据和正文；⑥前台激活被系统拒绝时只显示/闪烁。
- **验收 / 证据**：未运行、隐藏、最小化、后台四场景；过期/篡改 token；A 登出后点击旧 Toast；官方客户端共存及卸载后关联；第二实例只转发一次。保存安装产物版本与激活时间线。
- **失败 / 回退**：普通打开应用仍可用；通知跳转未过安装验收时显式标记不支持，不能以进程内 click 回调代替冷启动协议验收。

#### SHL-05：环境级崩溃恢复与资源回收协调（L）

- **owner / 路径**：DesktopShell；`core-shell/src/recovery/`、`platform/win/recovery.rs`。依赖 SHL-01/02；与 BIZ-05 共享受限资源策略接口。
- **输入 → 输出**：ProcessFailed、BrowserProcessExited、账号撤销、电源/屏幕事件 → 环境代次失效、恢复计划与审计事件。
- **实现步骤**：①按浏览器环境识别受影响的全部控制器，包含隐藏 popup/viewer/capture/可选传输；②同一崩溃只执行一次失效；③先撤销旧句柄和订阅，再按依赖重建；④可见视图优先，隐藏视图下次使用重新 ready；⑤有失败次数/时间窗和退避预算；⑥把 suspend/resume/lock/unlock/display-changed 作为内部事件发布。
- **验收 / 证据**：先隐藏三个预热窗，再结束隔离测试环境的浏览器进程，重新使用均重建；旧 OCR/下载回调不写新视图；共享环境崩溃不遗漏后台传输；多次崩溃不会形成重启风暴。记录环境→控制器映射、代次与恢复次序。
- **失败 / 回退**：耗尽恢复预算后显示手动恢复入口；业务提交结果不明进入核对状态，不因重载重复提交；如选 B1 传输，其恢复必须交给 IM 会话协调器，壳只恢复运行资源。

#### SHL-06：托盘、任务栏、快捷键、退出与偏好（L；G4 部分）

- **汇总补充约束**：真实退出同更新共用MaintenanceBarrier及同一维护代次；最终草稿/unknown落盘完成前Store仍开放受限最终写入，不能各自触发第二套排空。

- **owner / 路径**：DesktopShell；`core-shell/src/tray/`、`shortcuts/`、`shutdown/` 及对应 platform 文件；ShellUI 仅设置通用分区。依赖 SHL-01/03/04、偏好服务接口；与更新 owner 对接排空协议。
- **输入 → 输出**：提醒表现指令、用户偏好、退出原因 → 唯一托盘/任务栏执行器、快捷键注册结果、退出屏障。
- **实现步骤**：①shell 执行闪烁/角标，不重复 notify 策略；②Explorer 重启后恢复托盘；③快捷键先成功注册再持久化，默认唤起 Ctrl+Alt+V，截图 Esc/Enter 仅遮罩内处理；④默认关闭到托盘且首次提示，真实退出独立可达；⑤自启仅安装版且可关闭；⑥窗口坐标恢复夹紧可用屏幕；⑦退出阻止新写、持久草稿/outbox、取消或核对在途动作，再释放传输与窗口。
- **验收 / 证据**：未读 0/1/99/120；托盘恢复、折叠区操作；冲突快捷键无抢占；副屏拔出后仍可见；正常退出目标 3 秒内资源消失。异常未排空必须保留恢复证据并显示状态，不能为满足时延删除未知发送。
- **失败 / 回退**：托盘不可用时保留可见退出/返回入口；无法激活窗口时闪任务栏；不把“隐藏后内存必须下降”作为无条件正确性标准，先保持 dirty 视图与数据完整。

### 5. 业务页承载任务

#### BIZ-01：入口目录、菜单与受限业务查询（M）

- **owner / 路径**：BusinessHost；`core-shell/src/business/entries/`、`ui/packages/business/entries/`。依赖 FND-02/03；可用账号/网络 mock，真实接 ACC-04 与 NET 的端点注册表。
- **输入 → 输出**：账号角色、业务线、语言、环境、菜单/配置 → 可见入口和已校验 URL、typed 查询响应。home/order/product/comment/bulletin/course/event/data 共 8 个入口，bi 是 data 别名。
- **实现步骤**：①逐入口保留来源参数，home 不无条件追加 micro=1；②度假/租车/merchant 分支显式表达；③菜单由服务端权限与本地支持范围取交集；④`biz_api` 仅固定只读 endpoint_id，不接任意 URL/header/body；⑤`saveDoorCommonTool` 独立 typed 写命令，超时结果不明需回读，不盲重试。
- **验收 / 证据**：各身份对应入口数量、URL 与权限夹具；伪造业务线/绝对恶意 URL/环境串用拒绝；菜单配置不可用不扩权。每个端点记录动态/静态/待验证及成功判据。
- **失败 / 回退**：缺证据入口标 `unsupported/needs_verification`；禁止用默认菜单开放未授权功能，菜单常用项写入失败保留本地编辑而不虚报成功。

#### BIZ-02：窄 bridge、来源鉴别与 data microApp（L；G2 部分）

- **owner / 路径**：BusinessHost；`core-shell/src/bridge/`、`business/compat/`。依赖 FND-04、SHL-01、BIZ-01；运行取证接 SHL-02。
- **输入 → 输出**：宿主可验证的 WebView/frame/文档来源 + 已知事件 schema → 最小本地能力或拒绝；data 输出字段最小化的 microApp 回调。
- **实现步骤**：①只逐项实现既有 10 个事件对应候选命令；②精确 HTTPS origin、路径/端口与导航代次校验；③按实际 WebView 授权，验证同窗 capabilities 合并结果；④远程 logout/全局语言变更由本地外壳确认；⑤OCR 仅受限图片字节/句柄；⑥data 的业务线/user 展示字段按证据白名单给出；⑦异步结果回送时再次核对来源，禁止带敏感数据的通配 postMessage。
- **验收 / 证据**：同源/跨域 iframe、恶意后缀、userinfo、重定向、旧文档回调、同窗本地/远程权限合并；合法命令通过与越权命令拒绝都要测；data 逐业务线与官方受控样本比对。
- **失败 / 回退**：无法可信区分 frame 就关闭影响账号/窗口的远程命令，转本地壳；data 不兼容则该入口 blocked，不扩大 IPC、不删 CSP/XFO。不注入新的通用 appBridge，也不开放未观测 download 命令。

#### BIZ-03：导航、新标签与 POST 新窗口（L；G2 部分）

- **owner / 路径**：BusinessHost；`business/navigation/`、`platform/win/biz.rs` 的导航适配。依赖 SHL-01/02、BIZ-01/02；IM 跳转可先 mock。
- **输入 → 输出**：浏览器原导航、新窗口意图、来源 ProfileLease → 同账号目标视图、受限外链提示或拒绝。
- **实现步骤**：①导航与 IPC 白名单分开；②每次导航失效旧文档代次；③IM URL 转为经授权的 ConversationRef 跳转；④目标新窗口由浏览器完成原请求，保留 POST/opener/Cookie；⑤不从回调猜 POST 体并重发；⑥未知协议拒绝，系统外开只接受可验证的用户操作和限流策略。
- **验收 / 证据**：`window.open`、`target=_blank`、POST form、新窗口下载、跨账号错误 Profile、302 到非白名单、恶意外链连续弹窗。保存请求方法、脱敏结构与动作关联，正文不留存。
- **失败 / 回退**：不能保留原请求语义时阻断并解释；不悄悄改 GET，不重复提交；确需外部浏览器时明确登录上下文可能不同。

#### BIZ-04：下载、上传、打印、右键与查找（M；G2 部分）

- **owner / 路径**：BusinessHost；`business/browser_actions/` 和 Windows 业务适配；下载执行/文件策略归媒体 owner。依赖 BIZ-03、媒体任务注册与受限句柄接口。
- **输入 → 输出**：绑定账号/文档的原生浏览器回调 → task_id、保存/取消结果、媒体句柄或浏览器操作。
- **实现步骤**：①HTTP/blob/data 下载逐类型取证；②浏览器上下文导出由 WebView 唯一执行，media 只登记状态，Rust 不补发第二次；③保存对话框使用平台 deferral 或已确认目录，同步回调不能阻塞等异步；④上传选择器、打印、图片预览、Ctrl+F、复制/粘贴保持来源上下文；⑤仅关闭该下载自己创建且仍空白的临时窗口。
- **验收 / 证据**：取消保存、磁盘不足、目标重名、A 导出后切 B、导航后下载完成、blob 超限、用户撤销上传；一个动作只生成一任务/一次外部请求。
- **失败 / 回退**：能力不支持时禁用该动作并说明；不使用任意本机路径、不自动打开可执行文件、不把未确认下载当成功。

#### BIZ-05：业务视图保活、脏状态与回收（M）

- **owner / 路径**：BusinessHost；`business/lifecycle/`，销毁通过 SHL-01。依赖 BIZ-01/03/04、SHL-05。
- **输入 → 输出**：可见性、keep_alive、已知 dirty/unknown、上传/下载/提交任务、资源预算 → 保留/挂起/回收候选与理由。
- **实现步骤**：①dirty/unknown/inflight/pinned 默认禁止自动销毁；②账号切换只隐藏，不等同登出；③60 秒/5 分钟只是可评估阈值，挂起也不能中断进行中的业务任务；④用户确认关闭与自动回收分开；⑤无安全候选时拒绝/延迟新开并显示资源占用，而不偷删旧页。
- **验收 / 证据**：打开编辑表单后切账号、未能判断脏状态、提交结果不明、上传中、所有页面被 pin、内存压力和休眠恢复。记录每次保留/销毁的判据及任务状态；beforeunload 不能作为唯一 dirty 证明。
- **失败 / 回退**：资源目标未达到可以降低并发页面上限或显式独立窗口方案，不能牺牲唯一数据；不得把 Profile 目录直接当可清缓存。

#### BIZ-06：导航 UI、工作台、extra 与通知中心（M）

- **owner / 路径**：BusinessHost；`ui/packages/business/`、`ui/apps/web/`、`ui/packages/notice/`。依赖 FND-03、BIZ-01、SHL-03；notice 真实数据依赖 IM-06。
- **输入 → 输出**：入口、标签、业务线、IQ 通知快照与增量 → 菜单墙/二级标签/工作台工具栏、通知中心、受限导航请求。
- **实现步骤**：①独立 web 窗口每账号一个；②extra 绑定账号和新视图代次，尺寸夹紧目标屏工作区；③notice 是主外壳中的通知中心视图，不新增强制确认弹窗；④通知分类/已读/optStatus 未核验时只显示可证明的状态；⑤总结消息归 ui-im，不新建 biz-ai；⑥空态、加载失败和会话过期各有动作。
- **验收 / 证据**：标签关闭其他不跨账号；切换账号不带出旧标题/摘要；notice 未读与 IM-06 一致；未核验 optStatus 不触发强制确认；用户权限变化后快照与菜单同步。
- **失败 / 回退**：通知协议未验证时中心保留不可用说明与诊断状态，不伪造空列表；未实现的入口不能以占位页面计算“8入口齐”。

#### BIZ-07：8 入口兼容矩阵与 G2 汇总（L）

- **owner / 路径**：BusinessHost 产证据；独立 reviewer 判定。依赖 SHL-02/05、BIZ-01 至 BIZ-06、G1 相应身份取证。
- **输入 → 输出**：锁定构建 + 平台版本 + 测试身份/业务线 → 每入口/动作 `passed/failed/blocked/not_applicable` 矩阵与 G2 决策。
- **实现步骤**：逐入口覆盖加载、搜索、详情、新标签、microApp、上传、导出、打印、焦点、DPI、账号隔离、旧回调、崩溃恢复；将官方对照中的现有错误与新引入错误区分；未授权业务线记录不适用理由。
- **验收 / 证据**：八入口全有记录，每个失败都有能力禁用/回退/修复任务；资源统计包括所有浏览器和传输进程，同账号数/页面数/版本/负载对照。内存目标是实测目标，不能把旧“官方 50%”推断当已达收益。
- **失败 / 回退**：任何必需入口或安全边界失败，G2 不能整体 passed；可按入口交付受限预览，但不得宣称完整客户端已替代原程序。

### 6. 提醒任务

#### NTF-01：提醒队列、事实消费与版本化动作（M）

- **owner / 路径**：NotificationCore；`core-notify/src/actor/`、`queue/`。依赖 FND-02/03；IM-06 先提供合成事实，生产接提交后的 IM 事件。
- **输入 → 输出**：去重后的 MessageNew/NoticeNew/UnreadChanged/ReplyTimeout/ReplyCleared → 按账号作用域的提醒队列、AggregateScope 快照与增量。
- **实现步骤**：①按环境/账号/kind/key 合并；②保存 item_version、last_msg_id、pending_version、reconcile_epoch；③ack/dismiss/jump/read 分开；④ack_all 只确认用户见到的 epoch/seq；⑤账号授权变化推进 authorization_revision；⑥Lagged/事件缺口先重同步，不猜补事件。
- **验收 / 证据**：旧卡片 click 不确认新消息；ack_all 期间新增条目仍保留；补拉不逐条响铃；账号移除撤回该账号 Toast；队列断流恢复没有跨账号泄露。保存合成时序与期望快照。
- **失败 / 回退**：核心事实不完整显示待同步；保留计数但不创造 ReplyTimeout；持久本地 ack 经 store 服务，不能用 24 小时 TTL 让仍未回复旧消息重新响铃。

#### NTF-02：升级、假时钟与恢复对账屏障（L）

- **owner / 路径**：NotificationCore；`core-notify/src/policy/`、`env/`。依赖 NTF-01、NET-04；真实接 IM-06、SHL-05。
- **输入 → 输出**：core-im 首次 T1、ClockService 锚点质量、环境/偏好、ReconcileComplete → L0–L4 表现计划与有限定时器。
- **实现步骤**：①L1/L2 新消息与 L3/L4 待回复分开；②连续追问不改变 IM 定义的本轮起点；③L4 默认关闭；④resume/unlock/reconnect 使旧表现任务失效，先校时及对账；⑤只有当前账号/对账代次 complete 才合并补一次提醒；⑥锚点过期或对账超时显示估计/待同步，不补发陈旧 L3/L4；⑦snooze 到期仍需核对。
- **验收 / 证据**：假时钟推进、墙钟回拨、睡眠期间其他坐席已回复/转出/结束、对账失败、重复 complete、旧 epoch complete 迟到、连续追问、关闭 L2 后不凭空进入 L3。只看当前期望状态与播放次数，不等真实 10 分钟跑定时测试。
- **失败 / 回退**：保留 L0 和待同步提示；不得用离线墙钟估算冒充准确服务器 SLA。首次 T1 只能在 IM-06 实现，本任务不得建立第二个待回复判断器。

#### NTF-03：三个轻量提醒界面与无焦点展示（M）

- **owner / 路径**：NotificationUI；`ui/apps/alarm/`、`notifier/`、`tooltip/`；NotificationCore 提供 presenter 接口。依赖 FND-03、NTF-01、SHL-01。
- **输入 → 输出**：授权队列、present、alarm-tick → 合并卡片、等待秒数、版本化动作与布局报告。
- **实现步骤**：①notifier 最多 3 张，其余汇总；②alarm 虚拟列表与上限工作区 60%；③tooltip 按账号分组；④前端只渲染核心给出的秒数，6 秒收起由核心计时；⑤CSS 动画不逐帧移动原生窗口；⑥ready/快照完成前不显示旧卡片。
- **验收 / 证据**：千条合成提醒滚动不卡住输入；悬停暂停、旧版本按钮、授权撤销；多屏和任务栏四边；中文 IME 正在其他应用输入时弹出与点击非跳转按钮不抢焦点。单入口包体目标 <100 KB，注明压缩口径与共享依赖。
- **失败 / 回退**：透明失败可用不透明背景；Windows 非激活行为未验证不得声称“不会抢焦点”；按钮无法在非激活窗口可靠交互时改显式打开主界面处理。

#### NTF-04：托盘表现、声音、勿扰与设置（M）

- **owner / 路径**：NotificationCore；`attention/`、`sound/`、`env/`；NotificationUI 的 `ui/packages/notify-settings/`。依赖 NTF-02、SHL-06、偏好服务。
- **输入 → 输出**：提醒表现计划、前台会话、环境、偏好 → shell 托盘指令、有限声音任务、设置反馈。
- **实现步骤**：①声音单线程有界队列，1.5 秒新消息限频；②L4 开启后循环默认 15 秒且最多 10 分钟；③没有音频设备显示可理解状态而不中断 IM；④导入声音只接受本地选择器句柄并校验大小/时长/解码；⑤全屏、演示、锁屏、应用勿扰分开，系统查询失败默认不暴露摘要且静音；⑥用户“跟随系统勿扰”时 L2 用系统通知，不声称自绘窗天然遵守专注助手。
- **验收 / 证据**：插拔耳机、远程桌面无音频、恶意/损坏音频、连续消息洪峰、关闭总开关、重新登录后旧循环、系统返回未知状态；记录播放计数、线程/队列上限和资源释放。
- **失败 / 回退**：失败只降级声音/视觉通道，不清除待回复事实；自定义音失效回内置音或静音并提示，不从消息 URL 无限制下载音频。

#### NTF-05：系统 Toast、隐私与安装激活（L；G4 部分）

- **汇总补充约束**：发通知前通过DAT-02持久写入最小action-token映射；token无正文或凭据，绑定稳定账号/会话/展示版本/有效期。应用退出、机器重启后仍可经SHL-04重新认证并导航；旧点击不能清新提醒。

- **owner / 路径**：NotificationCore；`core-notify/src/toast/`、`platform/win/`。依赖 SHL-04、NTF-01/02，安装元数据由发布 owner 提供。
- **输入 → 输出**：可展示提醒版本 → Toast tag/group、短效本地 action token、撤回/点击结果。
- **实现步骤**：①显式 protocol 激活，绑定专属 scheme；②安装 AUMID/快捷方式/必要注册与运行时一致；③锁屏默认不显示正文，头像不泄露凭据；④登出与版本失效撤回；⑤token未知或过期只打开安全入口，不恢复其目标；token仍有效但展示版本过期时，可重新验证账号/会话权限后只导航，不确认后来消息；⑥默认诊断只记 token 的不可反向识别关联，不记正文。
- **验收 / 证据**：干净普通用户安装、重启、应用完全退出后点击、A 登出重登/切 B、过期 token、官方客户端共存、卸载；保存安装类型/身份/版本以及通知激活日志。
- **失败 / 回退**：系统通知被策略抑制不视为业务失败；缺少冷启动能力则关闭该交付能力并保留自绘提醒。不能用开发机已存在快捷方式证明 NSIS 产物通过。

#### NTF-06：提醒端到端反例与 M3 验收（L）

- **回复覆盖约束**：SendIntent冻结reply_round_id、pending_version及当时已知客户消息水位；发送确认、历史核对或其他坐席回复，只能解除有证据被该回复覆盖的客户消息集合，不能以ACK到达时间作为回复业务顺序。较新消息保留或建立新等待轮次；同时间戳或顺序不明时保持待核对，不清空当前待回复。重启回放、unknown对账、迟到回推均遵守该规则。验证C1→S1→C2→ACK(S1)、ACK/回推倒序、同时间戳、重启后旧回复到达。

- **owner / 路径**：NotificationCore 组织；独立 reviewer 复核；证据写 `docs/validation/notify/`。依赖 NTF-01 至 NTF-05、IM-06 真实对账、SHL-05。
- **输入 → 输出**：受控消息/责任变化 + 故障注入 → 消息事实、待回复事实、表现三条时间线与验收结论。
- **实现步骤**：覆盖后台/最小化/隐藏、双账号、锁屏/睡眠、断网/失效、窗口崩溃、连续客户追问、商家发送 unknown、已读、其他坐席确认回复、转出/结束、旧点击、恢复后合并提醒。真实业务动作仅在专用测试账号/会话进行。
- **验收 / 证据**：已读不清待回复；unknown 发送不清提醒；只有有效事实清除；恢复前不补陈旧声；mock 通过与实机通过分列。性能口径从事实提交到展示/声音开始分别统计，不用 UI 动画结束时间混代消息到达时间。
- **失败 / 回退**：任何误清、跨账号展示或恢复误响都阻止 M3 验收；关闭 L4 不能掩盖 L3 正确性问题；样本通过只能支持已测场景，不能声称所有系统一定提醒送达。

### 7. 需要统一的旧文档差异与产品默认

| 差异 / 决策 | 本计划的执行方式 | 冻结 owner / 证据 |
| --- | --- | --- |
| 壳文档的单账号 4/总 8 与业务文档的存活 >6 回收阈值 | 都视为旧原型初值；建立一份预算配置，dirty/unknown/inflight 优先于数量阈值；无安全候选时阻止继续扩张 | SHL-02 + BIZ-05 实测后由集成 owner 冻结 |
| 部分旧图画 im 为子 WebView、ai 为 biz-ai | 本地独立 im 为当前开发默认；总结消息归 ui-im；不额外开发 biz-ai | G0 窗口形态决策；变化先提契约请求 |
| “后台账号不保留业务页”与未保存内容保护 | 切换后隐藏，只有证明可恢复且无在途任务才回收 | BIZ-05；不以账号切换当销毁授权 |
| Profile 与窗口生命周期的交叉 | account 管身份、Profile 映射/撤销；shell 管控制器/视图/环境代次；业务模块只用租约 | ACC-02 + SHL-02 共同证据 |
| 通知中心与强提醒混淆 | notice 是主外壳中一个业务视图，协议事实归 IM-06，展示归 BIZ-06；未核验 optStatus 不产生强制确认 | IM-06 + BIZ-06 |
| 30 秒 T1、90 秒视觉标红与携程 SLA | 前两项是本地配置/视觉规则；不得在界面或验收报告声称等同携程考核 | IM-06 + NTF-02 |
| 跨平台兑现范围 | 本分计划先验 Windows；macOS 单独验证 WKWebView 隔离、非激活面板、Dock、权限与激活，不复制 Windows 的 passed | 第二阶段独立平台矩阵 |

### 8. 交接与审查要求

每次模块交接附：任务 ID、使用的 contracts 版本、独占文件列表、输入/输出与错误样本、可运行 mock 入口、未验证能力、验收命令/步骤和脱敏证据、已提的共享文件变更请求。安全反例由独立 reviewer 用相同夹具复算；正常路径与拒绝路径都必须覆盖，避免“全面禁止”假装完成集成。

最低审查交叉：DesktopShell 由基础/身份 reviewer 审视图与 Profile 失效；BusinessHost 由安全 reviewer 审真实调用来源、POST/下载唯一执行者与 dirty 保护；NotificationCore 由 IM reviewer 审首次 T1、unknown 发送、对账屏障与本地 ack 边界。原作者不得将自己写的计划或 mock 通过直接标记为 G2/G4 passed。


## 第四部分：媒体工具与商家助手

2026-10-30 · Asia/Singapore · 状态：开发任务计划，未执行产品验收。

本分片把媒体和助手拆成可以由不同代理独立提交的工作包。输入依据为[公共契约](../dev/00-architecture.md)、[媒体设计](../dev/07-media.md)、[助手设计](../dev/09-assistant.md)、[边际接口调查](../research/2026-10-30-im-peripheral-apis.md)及[开发前审查](../reviews/2026-10-30-final-adversarial-review.md)。其中源码发现、网页请求和业务动作成功仍是不同证据，不因进入任务表而升级为已验证。

### 1. 第一性原理与范围

媒体服务负责把不可信文件、远程资源和屏幕像素变成有来源、有大小限制、有生命周期的资源；它不决定消息是否发送成功。助手负责提供建议、译文和查询结果；它不获得独立发送通道，也不决定当前账号的权限。

必须守住五条边界：

1. 截图、预览、下载、翻译、订单查询均绑定操作创建时的身份、环境、会话和视图代次。用户切换账号不改变在途操作归属。
2. `MediaHandle` 只是短期访问能力，不能代表永久持有文件。发送与持久草稿引用的附件需要持久引用，不能被截图缓存过期清理删除。
3. 译文预览不等于发送意图。替换草稿使用版本比较；发送只能委托 core-im 的唯一 outbox，译文失败不自动发原文。
4. 远程资源、模型、订单页面不因来源“看起来熟悉”获得本机权限。精确来源、对象授权、资源限额和真实执行者分别校验。
5. OCR、ONNX 纠错、TSim 自动登录交接是可选能力；不能让它们的可用性阻塞基本 IM 收发，也不能在未验收时显示为可用。

交付分层如下；“可延期”是计划建议，具体版本清单由总计划冻结，不能悄悄从完整需求中删除。

| 层次 | 必须完成的能力 | 对核心 IM 的影响 |
| --- | --- | --- |
| IM 媒体最小集 | 文件选择/拖放、受限读取、大小与类型校验、附件持久引用、图片预处理、接收图片预览、明确下载入口；上传和发送由 IM 编排 | IM 附件关口依赖本层，纯文本原型可先完成 |
| 桌面媒体完整集 | 多屏截图及标注、下载列表/可支持的续传、视频预览、中文规则纠错、适用平台的剪贴板 | 独立验收，可在附件最小集后并行 |
| 有条件媒体 | OCR 后端、ONNX 纠错、DXGI 性能替代、macOS 平台适配 | 未通过相应门槛时关闭对应入口，保留基本媒体功能 |
| 助手基础集 | 槽位、官方出站翻译、版本保护、语言建议、独立关闭与错误隔离 | 助手失败不影响输入、普通发送、入站翻译和历史 |
| TSim 集 | TSim 身份/权限、选择后使用的出站翻译、套餐速览、完整订单面板 | 与携程凭据完全分域；远程面板交接不成立时保留独立登录 |

携程右侧栏的用户资料、历史订单、产品推荐、`14735/getOrderDetailsForVbk` 与分业务线订单页归 IM/业务模块。TSim `package-query` 是另一套服务。两者可以展示在相邻标签，但不得共享凭据、成功判据或默认把一个订单标识解释为另一系统的订单。

### 2. 并行写入范围和公共接缝

下列均为未来工程路径，不表示当前仓库已存在实现。仅指定目录 owner 可修改；共享文件由集成 owner 串行合入。模块导出列表、插件注册、模块依赖清单、锁文件与迁移注册表同样属于共享边界，不允许代理顺手修改。

| 开发角色 | 独占实现路径 | 不得直接修改 |
| --- | --- | --- |
| MEDIA-CORE | `vbk/crates/core-media/src/handles/`、`capture/`、`image/`、`ocr/`、`spell/`、`platform/`、对应模块内测试 | core-im outbox、数据库迁移、公共 platform-win、壳窗口注册 |
| MEDIA-IO | `vbk/crates/core-media/src/download/`、`viewer/`、对应模块内测试 | MEDIA-CORE 子目录、HTTP/Cookie 底层、bridge、shell 下载钩子 |
| MEDIA-UI | `vbk/ui/apps/capture/`、`vbk/ui/apps/viewer/`、`vbk/ui/packages/media-ui/` | IM 输入框、主设置页、shell/capability |
| ASSISTANT-CORE | `vbk/crates/core-assistant/src/session/`、`translate/`、`language/`、`orders/`、`policy/`、对应模块内测试 | core-account 携程凭据、core-im 发送/草稿账本、TSim 服务端 |
| ASSISTANT-UI | `vbk/ui/packages/assistant-ui/` | `ui/apps/im/` 的槽位实现、设置页路由、主窗口最大化逻辑 |
| 集成 owner | `vbk/crates/contracts/`、`vbk/crates/platform-win/`、所有 workspace/依赖/锁文件、`src-tauri/` 注册与 capability、共享 UI 导出、fixture 注册 | 通过任务变更请求合入各模块契约；不在集成时绕过故障验收 |
| STORE/IM/SHELL owner | 各自模块的数据迁移、outbox/草稿、窗口/下载事件适配 | 媒体和助手代理只提交所需接口变更说明 |

这些角色是工作队列，不要求同时占用五个代理。总计划按并发预算调度；同一个 crate 内多个代理必须独占上述子目录，模块根 `lib.rs` 和导出注册由集成 owner 更新。

#### 2.1 必须先冻结的最小契约

| 接缝 | 产生方 → 消费方 | 冻结内容与验证方式 |
| --- | --- | --- |
| 身份/来源 | account + shell → 所有媒体/助手任务 | `AccountContext`、`ConversationRef`、真实来源 `ViewContext`、撤销信号；迟到结果与旧 Channel 再授权 |
| 媒体句柄 | media → IM/UI/bridge | 不透明句柄、资源种类、大小、所有者、到期、访问目的；任何 API 都不接受任意本地路径替代句柄 |
| 附件持久引用 | media + store → core-im | `AttachmentLease` 为拟定统一名：由 IM 持久提交草稿/SendIntent 时建立引用；租约与短期访问授权分开；准备阶段短期pin防清理；pin释放且无持久引用后才可回收；重启/恢复缺件显式阻止附件发送 |
| 发送交接 | core-im → assistant/media | 唯一 `SendIntent`、稳定 `localId`、不可变正文/附件引用/引用消息、`confirmed/rejected/unknown`；助手 request_id 只关联翻译请求，不再建发送账本 |
| 草稿槽位 | ui-im/core-im → assistant-ui | `DraftSnapshot`、composer_id、draft_version、文本 hash、组字状态、CAS 替换和提交；输入缓冲与持久草稿的职责分离 |
| 网络策略 | core-net → media/assistant | 固定 typed endpoint、Cookie/TSim Bearer 互斥域、逐跳重定向策略、响应大小/总超时、取消、读写重试分类；UI 不注入 Authorization |
| 窗口服务 | core-shell → media/assistant | 按真实来源申请遮罩/预览/订单面板，返回视图代次；显示器稳定标识+配置代次；浏览器故障与面板撤销通知 |
| 下载登记 | shell/bridge → media | 来源 WebView、请求上下文、唯一执行者、可用进度与控制能力、最终结果；WebView POST/blob 下载不重放成 Rust GET |
| 偏好与策略 | telemetry/prefs → media/assistant | 用户关闭与权限/受信策略取交集；策略修订立即失效旧结果，不靠 UI 隐藏控制权限 |

附件持久引用的顺序必须明确：先在账号隔离区域用短期pin保护准备中的文件，完成持久落盘、校验与原子发布，再由 store 事务把 `SendIntent`/草稿与引用共同提交；事务失败的文件须在pin释放且确认无持久引用后清理；重启扫描根据准备记录与引用表回收孤儿，不靠文件年龄猜测提交状态。事务已提交后文件不可被普通缓存清理删除。登出撤销访问与网络任务，但保留仍被草稿或未决 outbox 引用的本地资源；主动清除账号数据走受控的数据维护流程。旧备份缺少附件时恢复为“附件缺失待处理”，不自动以空附件或重新下载的另一资源代发。

#### 2.2 Mock 起步与任务就绪条件

跨模块前置使用产物契约，不把“整个账号模块完成”作为泛化依赖。可在以下 fake 已由集成 owner 合入后并行：两账号相同 gid 的上下文、可撤销媒体句柄仓库、固定帧采集器、窗口注册器、typed HTTP 响应序列、可控延迟/取消、假 TSim 权限、草稿 CAS 适配器、下载事件源。Fake 不读真实 Cookie/文件/客户正文，不发真实消息。

对接真实实现前，每个 fake 对应的同一组边界用例必须在生产适配器上运行；fake 通过只代表局部逻辑通过。目标运行时、正式安装包、接口使用范围或受控测试账号缺失时标记 `blocked`，同时继续不依赖该项的任务。

### 3. 媒体工作包

工作量只表示相对复杂度：S 为局部、有明确契约的任务；M 涉及数个状态或一个外部边界；L 涉及系统/多个故障域，需要拆分提交。它们不折算承诺日期。每个包的证据由 QA 按主计划目录归档，至少记录版本、平台、步骤、期望、实际和脱敏日志。

#### MED-01 · 媒体边界与资源策略（M）

- **Owner / 路径**：MEDIA-CORE，`handles/`；公共 DTO、插件命令与 capability 由集成 owner 合入。
- **前置**：公共上下文/授权/错误契约可用；不依赖目标 OCR 或真实上传接口。
- **输入 → 输出**：可信文件选择/拖放、受批准远程资源、有限字节 → `MediaHandle` 与可撤销授权；输出媒体资源限额配置和 `AttachmentLease` 提案。
- **步骤**：建立句柄所有者与用途校验；区分内存帧、短期缓存和持久附件；定义总像素、单文件字节、解码帧、并发数、队列长度、任务时限、总缓存硬上限；拒绝溢出/越界/资源炸弹；与 store 定义引用提交和清理顺序。
- **验收/证据**：A 的句柄被 B、远程 iframe、过期视图使用均拒绝；同路径替换/重解析点不能绕过打开时对象校验；磁盘不足或进程中断不产生“已有附件但文件未落定”的发送意图。留存句柄状态转换和引用核对报告，不留真实路径/客户文件。
- **失败/回退**：无法验证真实调用源的资源协议关闭，采用绑定调用方的受控字节 Channel；不以随机 URL 本身充当来源鉴权。资源超预算返回明确错误，不能静默截断附件。

#### MED-02 · 上传前文件准备与持久附件交接（M）

- **Owner / 路径**：MEDIA-CORE，`handles/`、`image/`；IM owner 实现上传与发送编排。
- **前置**：MED-01；IM 的草稿/SendIntent 引用契约和 store 原子引用提交接口。
- **输入 → 输出**：文件选择/拖放/截图句柄 → 有界分片、摘要、规范化图片/缩略图、可持久引用；MD5 仅按上游上传协议需要计算，不能代替安全校验哈希。
- **步骤**：文件选择器与拖放路径只在核心登记；分片上限沿用设计 4 MB，校验 offset/len/溢出；解码图片后应用方向、生成缩略图；上传所需请求参数和远端凭据留给 IM typed adapter；把“准备附件”和“发送附件”分成不同操作。
- **验收/证据**：超大/损坏图片、文件中途改变、句柄撤销、上传准备中切账号、创建租约后杀进程；恢复可读到同一附件，未确认发送不会丢资源。以合成文件 SHA-256 验证内容连续一致。
- **失败/回退**：准备失败保留原草稿；拒绝超限或要求用户重新选择；未得到有效 lease 不创建可派发 outbox。不能因上传失败将文件名当正文发送。

#### MED-03 · Windows 采集与多屏生命周期原型（L）

- **Owner / 路径**：MEDIA-CORE，`capture/`、`platform/win/`；共用 Win32 封装以变更请求交集成 owner。
- **前置**：MED-01；shell 窗口服务、显示器配置代次和受控临时快捷键接口；可先用 fake frame。
- **输入 → 输出**：截图请求与原窗口状态 → 每屏物理像素帧、会话状态和清理结果。
- **步骤**：用候选 xcap 做采集接口；枚举负坐标/竖屏/混合 DPI；采集完成后才显示遮罩；检查自身窗口排除能力并保存/恢复原 affinity；失败路径回退隐藏再恢复原可见/最小化/最大化状态；不要把框架默认 DPI 行为当作验收结果。
- **验收/证据**：1080p、2K+4K、三屏各 50 次，报告 P50/P95/P99 与全进程资源；双屏采集 P95 目标 ≤120 ms。覆盖拔屏、锁屏、采集后端失败、窗口销毁、切账号、超时、两次热键竞争；所有路径释放帧与还原窗口。
- **失败/回退**：xcap 不达预算时另开 DXGI 对照，不同时维护两套默认实现；自身排除不成立则明确使用隐藏模式。任何屏失败或 2 秒 ready 超时取消整次截图；不输出旧帧。

#### MED-04 · 遮罩、标注与插入草稿（L）

- **Owner / 路径**：MEDIA-UI，`ui/apps/capture/`；MEDIA-CORE 的对应会话变更通过独立小提交协作，不跨目录抢写。
- **前置**：MED-01、MED-03 的帧/会话契约；shell 注册器；IM 的带版本附件插入命令。UI 可先使用 fake 多屏数据。
- **输入 → 输出**：本屏受授权帧、选区/标注 → 有限 PNG 字节和结果句柄；插入目标固定为发起会话/输入框。
- **步骤**：CSS 与每屏物理像素显式换算；一屏内框选，切屏即切目标；矩形/椭圆/箭头/文字/画笔/马赛克、撤销重做；ready 屏障统一显示；Esc/Enter/Ctrl+C 仅遮罩内处理；确认和取消统一终态清理，确认最多一次。
- **验收/证据**：100%/125%/150% 混合屏与负坐标逐像素核对；20 次连续截图内存增量目标 ≤20 MB；快捷键到显示、确认到插图各目标 ≤300 ms；拔屏、旧遮罩迟到确认、截图中 A→B、输入框重建均不插入错误草稿。遮罩崩溃后主界面仍可操作。
- **失败/回退**：草稿版本不匹配时保留结果供原会话明确插入或保存，不自动插入后来当前会话；不为抢回焦点注册全局 Enter。图像保存失败不发布虚假的成功事件。

#### MED-05 · 两类下载执行者与持久任务（L）

- **Owner / 路径**：MEDIA-IO只写`vbk/crates/core-media/src/download/`；MEDIA-UI独占`vbk/ui/packages/media-ui/downloads/`，分两个交接产物；shell 实现 WebView 下载事件适配，store owner 添加下载迁移。
- **前置**：MED-01；net 的媒体 URL/逐跳凭据策略、store 下载任务仓储、shell 下载登记接口。
- **输入 → 输出**：来源 WebView 下载事件或已批准直接 GET → 任务、进度、受控文件与结果；每任务明确唯一执行者和是否支持续传。
- **步骤**：WebView 保留 POST、blob、Cookie 原上下文；Rust 仅执行授权 GET；异步保存框/deferral 路线在锁定版本原型确认；净化文件名/设备名/ADS/尾点，验证授权目录及重解析点，重名不覆盖；`.vbkpart` 完成后原子发布；GET 续传绑定资源校验器，分别处理206/200/416；下载列表先订阅再快照。
- **验收/证据**：300 MB 合成文件断网/杀进程后恢复哈希一致；POST 下载只出现一次原请求，无额外 GET；未知协议、跨域302凭据、路径穿越、ADS、软链接逃逸拒绝；登出撤销授权，重启不自动续发凭据；记录可取消/可恢复能力矩阵。
- **失败/回退**：WebView 缺少可靠控制能力时标明不可续传，回原页由用户重新操作；无强资源标识不续接旧部分文件。MOTW 按正式产物/文件系统验证，不能视为杀毒或自动打开许可；完成仅提示列表，用户明确打开才执行受限 opener。

#### MED-06 · 图片与视频预览（M）

- **Owner / 路径**：MEDIA-IO，`viewer/`；MEDIA-UI，`ui/apps/viewer/`，以核心/界面不同提交串接。
- **前置**：MED-01、MED-05；net 受批准媒体读取、shell 单例换绑接口。
- **输入 → 输出**：绑定账号的媒体集合 → 安全位图/有限视频流、复制/保存动作；协议 URI 不携带原始远程 token。
- **步骤**：预览切账号先撤销旧请求并清像素/文字层；缓存键含环境/账号和资源身份；禁止 SVG/HTML/脚本原样在本地可信 origin 渲染；视频 range 同样授权；缩放旋转切图和键盘交互独立于 IM 列表；隐藏释放解码资源。
- **验收/证据**：同 URL 不同账号缓存不串用，旧图迟到不能覆盖新图；损坏/多帧大图不阻塞 UI；H.264/AAC、HEVC、VP9 与 Windows N 按实际支持记录；剪贴板复制在目标应用验证 PNG/透明区；远程页猜测媒体 URL 被拒绝。
- **失败/回退**：不支持视频时显示原因与用户触发的受控降级；外部打开前验证资源类型/URL且不传长期凭据。不因解码失败把原始 HTML/未知文件交本地 WebView 执行。

#### MED-07 · OCR 后端与安装身份决策（L，条件任务）

- **Owner / 路径**：MEDIA-CORE，`ocr/`、`platform/win/ocr/`；安装 owner 提供正式产物，集成 owner 维护依赖。
- **前置**：MED-01、MED-06 的安全图像输入；REL-08a安装身份原型可运行，不等待REL-08b最终选型。Mock OCR不等待真实后端。
- **输入 → 输出**：受限图像、语言 → `text/words/bbox/imageSize/lang/degraded`；后端能力清单和部署决策证据。
- **步骤**：同场比较“受支持身份+OCR”与“不依赖身份的本地引擎”；Windows.Media.Ocr 只在身份路线证据成立后进入实现；清晰区分引擎不可用与语言包缺失；坐标还原、CJK 空格处理、取消、任务有界；模型来源/签名/体积由发布 owner 核验。
- **验收/证据**：干净普通用户机器安装/更新/卸载；100 张有授权脱敏样本对照，准确率差距目标 ≤5 个百分点、单张目标 ≤800 ms；缺语言包、离线、取消晚回、压缩炸弹、模型损坏和更新途中故障。只记录统计与必要脱敏输出。
- **失败/回退**：OCR 保持禁用，不以开发机可调用或英文降级掩盖包身份不成立；不自动执行管理员语言包安装，不回传远程 OCR 服务作为隐式替代。

#### MED-08 · 中文规则纠错与可选模型（M；模型部分 L）

- **Owner / 路径**：MEDIA-CORE，`spell/`；MEDIA-UI 在 `media-ui/spell/` 输出组件，IM owner 挂载输入槽位。
- **前置**：MED-01；草稿版本/组字状态接口；可选模型另依赖受信制品清单与发布校验。
- **输入 → 输出**：有限草稿文本+版本 → 带原文区间的建议；返回建议不自动改写或发送。
- **步骤**：一期本地规则引擎；英文交 WebView 内置能力；统一字符索引和 UTF-16/Unicode 边界，明确异步结果适用版本；ONNX 为单独 feature，限制线程/内存/队列，按需下载且校验已信任清单中的哈希、解压大小与路径。
- **验收/证据**：来源规则样例和200条脱敏客服语句；中英混合、emoji、组合字符、组字、快速编辑、过期范围；模型开启时单句目标 ≤50 ms 且输入 P95 目标 ≤50 ms；坏签名/模型更新中断不破坏规则模式。
- **失败/回退**：关闭模型仍保留规则；关闭全部纠错不影响发送。未确认规则/模型授权或制品源时不打包；绝不关闭 TLS 校验。

### 4. 助手工作包

#### AST-01 · 插件骨架、槽位和草稿契约（M）

- **Owner / 路径**：ASSISTANT-CORE，模块内部骨架与 `policy/`；ASSISTANT-UI，`assistant-ui/slots/`；共享注册由集成 owner 合入。
- **前置**：上下文/事件契约；IM 提供 DraftSnapshot、CAS 与唯一 SendIntent 接口。对应 IM 计划的 IM-01/IM-04/IM-06、UIIM-02 产物。
- **输入 → 输出**：账号/会话/输入框快照 → 可插拔 `composer.addon/keymap/message.decorator/sidebar.panel`；无助手时返回空槽位。
- **步骤**：UI 持有当前编辑缓冲，core-im 持有持久草稿；替换必须比较账号、gid、composer_id、draft_version 和文本 hash；提交译文冻结正文并交 core-im 持久 SendIntent。助手翻译 request_id 与发送 localId 分开；重复回车沿用同一已提交意图，不能新建发送账本。
- **验收/证据**：挂载/卸载助手、组件异常、核心助手 actor 停止时，IM 基本输入/收发照常；草稿变化、会话切换、输入框重建、连续回车只产生预期的一个不可变发送意图；组字回车不发信。
- **失败/回退**：契约未统一仅交付 mock 槽位；不通过 DOM 查找、CDP 注入或直接点击发送按钮完成集成。需要跨模块改动时提出契约修订，不把状态复制到助手维持第二套真相。

#### AST-02 · 官方出站翻译、缓存和作废（M）

- **Owner / 路径**：ASSISTANT-CORE，`translate/ctrip/`、`translate/pipeline/`；ASSISTANT-UI，`assistant-ui/translation/`。
- **前置**：AST-01；net 的固定 SOA endpoint 和方法级成功判据、携程账号授权；真实适配器启用前需该调用路径使用范围和请求契约核对。
- **输入 → 输出**：当前草稿与目标语言 → `TranslationPreview`；`/11679/batchTranslateByMsgIds` 入站批量翻译仍归 core-im。
- **步骤**：UI 单次去抖默认500ms、组字不触发；core 取消旧请求并在返回/入缓存前再核对代次；按 Ack、status、translate 状态与非空文本逐层判断；缓存仅存译文，不存旧 request_id 回显；缓存键包含账号/环境/代次/提供方配置/语言/文本hash/官方会话上下文，内存上限500条、TTL10分钟。
- **验收/证据**：两账号相同 gid/相同文本、同账号不同会话、切语言/提供方、旧请求迟到、HTTP200业务失败、空译文、超大响应、429；旧译文不能覆盖新草稿，缓存命中重建当前回执并重验权限。测缓存命中目标 ≤100ms，服务耗时与本地开销分开报告。
- **失败/回退**：保留原草稿与普通发送；失败不自动发原文或切 TSim。真实契约缺证据时只运行 fixture 并禁用在线功能。不要把连接超时统一显示为登录失效。

#### AST-03 · TSim 身份、刷新和权限（L）

- **Owner / 路径**：ASSISTANT-CORE，`session/`、`policy/`；UI 登录面板在 `assistant-ui/session/`，主设置路由由其 owner 挂载。
- **前置**：AST-01；独立凭据存储服务、typed TSim 网络策略、偏好仓储与退出事件。
- **输入 → 输出**：用户登录表单 → TSim 身份/会话代次/权限快照；与携程账号绑定关系显式记录。
- **步骤**：按 `/agent/login`、`profile`、`auth/refresh`、`logout` 分别定义业务成功与失败；密码只在一次登录调用中使用；刷新串行化、credential revision 防旧 token 回写，权限变化使旧任务无效；不得读取其他浏览器 Profile 登录态；长 token 使用系统保护密钥+加密存储，不假设单条凭据能放下全部 token。
- **验收/证据**：401/403/423/429、刷新竞争、登出后迟到成功、重新登录后旧失败、TSim A→B、携程账号切换、不同 OS 用户无法解密；离线不伪造“Ready”，没有 TSim 权限不影响携程 IM。
- **失败/回退**：本地先撤销会话/访问再尽力通知服务端；服务端登出失败显示可诊断状态，不恢复旧 token。真实身份或权限 schema 未确认保持关闭，不凭按钮显示推断权限。

#### AST-04 · TSim 出站翻译与明确选择（M）

- **Owner / 路径**：ASSISTANT-CORE，`translate/tsim/`；ASSISTANT-UI 复用 AST-02 翻译条的提供方状态。
- **前置**：AST-02、AST-03；TSim 翻译权限、用户选定提供方、发送范围/接收方说明和账号绑定同意记录。
- **输入 → 输出**：商家当前中文草稿（≤20000字）及翻译请求版本 → 经回显核对的译文预览；仅上传草稿，不附客户原文或整段会话。
- **步骤**：调用固定 `/agent/translate`，映射 `purpose=outbound`、`source_lang=zh`、draft_request_id/composer_content_version；禁止重定向、响应≤2MB、30s总超时；非中文或超限明确拒绝，不截断/偷换供应商；回显不一致拒绝，输出非空且≤50000字；沿用官方管线的上下文作废。
- **验收/证据**：权限撤销后缓存命中仍拒绝、同文本不同版本不复用上游回显、刷新中返回、429 Retry-After、提供方切换、错误回显/超长译文；日志只有字数/语言/耗时/结果，无草稿/token。
- **失败/回退**：保留原文、预览失败与“重试/发送原文”的明确用户动作；默认不发送原文。没有可确认的当前接收方/服务配置时不启用 TSim，不能由旧供应商枚举推断实际使用方。

#### AST-05 · 语言建议与订单标识识别（M）

- **Owner / 路径**：ASSISTANT-CORE，`language/`、`orders/identifiers/`；ASSISTANT-UI，`assistant-ui/decorators/`。
- **前置**：AST-01；core-im 提供授权后的消息/会话快照与增量；可从有限脱敏夹具开始。
- **输入 → 输出**：本地已授权消息/明确会话字段 → 带来源、时间、置信度的语言/标识候选；订单号/ICCID/eICCID 分类型。
- **步骤**：本地识别，手动目标语言优先于识别；短消息低置信度回退到明确默认并标示；标识识别限制候选数，沿用最多12个可点击候选的目标；会话字段与正则命中分来源，多候选由用户选择，不把识别结果当所有权证明。
- **验收/证据**：17种语言各50条≤20字的有授权短消息，目标准确率≥90%、单条≤2ms，报告真实混淆而非只报总体；覆盖纯数字、emoji、中英混合、相同订单标识跨账号、旧消息、混合ICCID/eICCID；低置信度不覆盖手动语言。
- **失败/回退**：保留用户手选目标语言/手输标识，识别器异常不拖慢消息入库；无需加载历史全量文本，也不自动向 TSim 查询每个正则命中。

#### AST-06 · TSim 套餐速览与部分失败（L）

- **Owner / 路径**：ASSISTANT-CORE，`orders/summary/`；ASSISTANT-UI，`assistant-ui/package-summary/`。
- **前置**：AST-03、AST-05；TSim `complaint_records` 权限和分步 endpoint 契约；查询默认由用户选定标识/打开面板触发。
- **输入 → 输出**：已选标识+账号绑定 → 最多5个套餐、每套餐最多10条用量、来源/更新时间/部分失败状态。
- **步骤**：实现 `perform → dataplan-list → detail/live-detail/cdr-more`；每步核对 HTTP与业务结果，有限并发/总时限/响应大小；`perform` 是否有副作用及幂等性列为取证项，未证实前不自动重试；unknown不能伪装“无套餐”；字段裁剪，完整运营操作不在本任务复刻。
- **验收/证据**：有套餐/0套餐/无权限、单套餐部分失败、超时、过期数据、查询中切账号/TSim身份、重复打开与取消；记录每一步状态和最终完整度，故障不会形成无界扇出；订单标识不能越权访问。
- **失败/回退**：保留已成功字段并明确缺失/过期，或显示整次失败；不能把携程的空订单列表作为 TSim 查询成功证明。上游 `perform` 结果未知时等待核对/用户处理，不新建无限查询链。

#### AST-07 · 完整订单面板、隔离与登录交接（L，条件任务）

- **Owner / 路径**：ASSISTANT-CORE，`orders/panel/`；ASSISTANT-UI，`assistant-ui/order-panel/`；实际 WebView/Profile 由 shell/account 对应服务创建。
- **前置**：AST-03、AST-06；shell 子WebView/独立窗能力、Profile隔离、可信导航策略；自动交接另需 TSim 已确认的一次性正式协议。
- **输入 → 输出**：ConversationRef、TSim 身份、标识和容器尺寸 → 独立 panel_id、无 IPC 权限的订单页或明确外部登录入口。
- **步骤**：按环境/TSim身份分隔Profile，视图同时绑定携程上下文；只接受已确认HTTPS来源；两条可选登录路线为面板内独立登录、一次性短时且绑定目标 origin/会话的交换码；长期 Bearer 不进 URL、初始化脚本、localStorage 或通配 postMessage；切换/退出遮蔽旧内容并撤销旧面板；脏状态未知不因5分钟隐藏销毁。
- **验收/证据**：100%/150%双屏拖动定位、两TSim身份隔离、window.open/重定向不复用错Profile、过期/复用/错误origin交接拒绝、旧面板迟到加载、在途上传/未保存表单隐藏；正式安装产物无IPC权限、关闭后资源回落。
- **失败/回退**：自动交接未确认就禁用免登录，使用独立登录；子WebView不成立可使用隔离独立窗口，不降低CSP/站点隔离。无法安全保留用户表单时显式由用户完成/关闭，不能自动丢弃。

#### AST-08 · 有效策略、日志与异常隔离（M）

- **Owner / 路径**：ASSISTANT-CORE，`policy/`；ASSISTANT-UI，`assistant-ui/settings/`、`assistant-ui/logs/`；telemetry/prefs owner 接入日志与持久设置。
- **前置**：AST-01、AST-03 的权限模型；受信策略读取接口；无需等待远程配置服务建成。
- **输入 → 输出**：构建支持、受信策略、权限、同意、用户开关 → 有效 FeatureSet及不可用原因；脱敏日志快照。
- **步骤**：有效开关取五者交集；远程策略缺失时使用明确构建默认/账号权限/用户选择，不接受任意URL配置；kill switch立即取消任务、清缓存、遮蔽/关闭面板、移除槽位；遥测只记类别/耗时；最多1000条助手日志、导出走统一诊断；最大化与滚动行为交shell/ui-im执行。
- **验收/证据**：用户开关不能覆盖403/kill switch；策略过期/签名失败/旧revision重放拒绝；切开关时旧译文/订单返回被丢弃；导出包含故意植入的token/正文测试标记时验证白名单裁剪；助手故障后IM继续收发。
- **失败/回退**：外部遥测/策略服务不可用不影响本地日志与IM；默认不向未授权收集端上报。单项错误关闭该能力，助手总开关关闭无需重启。

### 5. 跨模块联调顺序与证据关口

以下顺序是局部依赖，不是要求同列全部完成才启动下一列。合同稳定后，UI和核心可分别使用fake推进。

| 联调轮次 | 参与任务与输入 | 通过后的产物 | 未通过时的界限 |
| --- | --- | --- | --- |
| 资源与草稿接缝 | MED-01/02、AST-01 + IM草稿/outbox、store事务 | 账号分域句柄、持久引用、CAS、发送唯一归属；两账号反例通过 | 不接真实附件/翻译发送，继续无副作用UI与夹具 |
| 媒体端到端 | MED-03/04/05/06 + shell/net/IM上传 | 截图入指定草稿、附件准备→上传→唯一outbox、接收预览/下载 | 某类型不支持则显式拒绝，不能降为正文或盲目重试 |
| 助手基础 | AST-02/05/08 + IM槽位/typed Ctrip端点 | 翻译预览/替换/明确发送、语言建议、关闭隔离 | 官方翻译缺证据可继续mock，不把发送按钮可点击当业务成功 |
| TSim身份与查询 | AST-03/04/06 + 独立凭据/net | 权限交集、正确回显、选定标识查询和部分失败 | 无TSim授权或接口契约未确认则blocked，不影响携程IM |
| 平台与可选能力 | MED-07/08、AST-07 + G4安装/发布、G2视图 | OCR真实部署结果、签名模型、隔离订单面板 | OCR/模型/自动交接分别按能力关闭，无自动放宽安全边界 |

关键故障联调必须有独立于实现代理的验收者复查，优先检查“外部操作已发生、客户端不知道”的情形：上传响应丢失、发送确认丢失、TSim查询前置动作超时、下载中断但文件已完成。媒体/助手不得自行将 unknown 改成失败并重放动作。

关口归属：账号与凭据隔离纳入 G1；订单面板/下载桥/来源鉴别纳入 G2；附件发送与译文送入唯一 outbox 纳入 G3；截图/OCR/媒体格式/安装身份纳入 G4；附件租约备份恢复、磁盘不足、任务持久性/模型更新纳入 G5。一个可选功能被排除须在版本范围显式登记，不得把“关闭入口”记为该功能验收通过。

### 6. 完成定义、尚待冻结与交接

每个任务交付实现、必要的边界夹具、实际执行的验收记录、已知缺陷和契约变更。无需为低风险样式写镜像单测；必须验证身份错配、迟到结果、资源撤销、发送副作用、进程中断和数据恢复这些会产生实质损失的边界。无真实环境的项目写 `blocked`，不能用mock通过补成`passed`。

| 待冻结项 | 负责人/证据 | 默认处理 |
| --- | --- | --- |
| 媒体协议是否能可靠获得调用源 | MEDIA-CORE + shell/集成，锁定版本原型 | 不成立时采用绑定调用者的受控字节通道 |
| AttachmentLease 与备份格式 | MEDIA-CORE + IM + STORE，原子提交/重启/缺件恢复证据 | 不清理仍被草稿或未决outbox引用的附件 |
| 下载hook、保存deferral和取消能力 | SHELL + MEDIA-IO，目标WebView2/wry原型 | 保留唯一执行者，能力缺失明确展示 |
| OCR路线与模型制品源 | MEDIA-CORE + 发布owner，G4正式安装验证 | OCR/模型默认禁用，截图/规则纠错照常 |
| TSim账号绑定、API schema与接口使用范围 | ASSISTANT-CORE + 集成，受控测试样本 | 未确认的功能关闭，不复用携程凭据 |
| 正式免登录交换协议 | ASSISTANT-CORE + TSim服务维护方，origin/一次性/有效期测试 | 独立登录；不沿用插件长期token交接 |
| 发布给哪些商家及TSim入口 | 产品范围记录 + 账号权限 | 普通商家不展示未获授权TSim能力 |
| 翻译失败、同时发送原文译文 | 产品范围记录 + IM发送契约 | 默认替换模式；不自动发送原文，仅发送用户明确选定内容 |

代理交接必须说明：使用的公共契约版本、独占改动路径、可运行夹具/命令、真实验收与mock验收的区别、依赖的其他任务产物、哪些入口仍关闭。下游只消费已合入的契约，不从另一代理尚未合入的私有类型复制定义。


## 第五部分：发布、验证与 macOS

2026-10-30 · Asia/Singapore · **计划状态：未实施，所有运行验收均待执行。**

本文把 [开发总纲](../dev/00-architecture.md)、[更新诊断设计](../dev/08-update-telemetry.md)、[最终审查](../reviews/2026-10-30-final-adversarial-review.md) 转成可分派任务。历史 [Windows 审查](../reviews/2026-10-30-windows-adversarial-review.md) 仅用于保留故障反例，不覆盖当前公共契约。任务规模 S/M/L 表示局部、跨接口、含平台或故障验证的不确定性，不折算为固定人日或交付日期。

### 1. 发布必须保证的事实

1. 发布的是一组相互兼容的应用、传输适配器、运行时约束和数据 schema。单个安装包验签成功，不能证明这一组合可用。
2. 更新会结束进程，必须先让本地唯一数据可恢复；未知发送结果必须保留为 unknown。重启后不能用自动补发掩盖不确定性。
3. 安装包签名证明产物来源；策略签名证明此时允许执行的升级或回滚。两种信任不可互相替代。
4. 日志、诊断和测试证据同样可能泄露客户数据。默认只保留明确列出的结构化字段；dump 不属于默认诊断包，也不默认上传。
5. Windows 普通用户安装的实际结果才是 Windows 交付证据；开发机已有 Runtime、证书、注册信息或管理员权限都不能作为替代。
6. 性能是整机进程树在同条件下的测量结果，不能由 Rust、Tauri、去掉 Electron 等选型直接推导。

### 2. Owner 与独占路径

以下均是未来工程路径，当前任务不创建产品代码。角色是可重复使用的工作槽位，不意味着同时增加代理数量。单代理同一时间只认领一个角色的一个任务包。

| 角色 | 独占写入范围 | 交付给其他角色 |
| --- | --- | --- |
| Release | `vbk/crates/core-update/`、`vbk/ui/apps/update/`、`vbk/release/` | 更新状态机、策略校验、安装物清单、维护屏障调用方、安装脚本 |
| Telemetry | `vbk/crates/core-telemetry/`、`vbk/ui/packages/i18n/` | 启动日志、偏好与词条服务、诊断、隐私状态、崩溃事件归一化 |
| QA | `vbk/tests/scenarios/`、`vbk/tests/fixtures/`、`vbk/tests/performance/`、`vbk/tools/validation/` | 可复放的跨模块反例、目标机执行记录、门槛矩阵 |
| macOS 平台 | 获得对应模块 owner 移交后的 `vbk/crates/<模块>/src/platform/macos/`；跨模块封装提案交集成 owner | WKWebView、Keychain、通知、截图、签名安装的实际差异 |
| 集成 owner | 根清单/锁文件、`vbk/src-tauri/`、公共 `contracts`、`platform-win`、CI workflow、共享 ipc 包和设置页入口注册 | 依赖和能力注册、启动顺序、构建接线、公共契约版本 |

Release 不直接改 IM、Store、Shell 的内部状态。Telemetry 不直接改 `ui/apps/setting`；先交设置分区的字段 schema、校验和组件需求，由该页面 owner 接入。QA 不覆盖模块内部测试；模块作者负责最小语义测试，QA 独立验证跨模块和平台边界。模块根文件与平台子目录同时需要改动时，先通过集成 owner 分出无重叠文件所有权。

### 3. 先冻结的交付契约

| 契约 | 提供者 / 消费者 | 最小约束与冻结时机 |
| --- | --- | --- |
| `BuildIdentity` | 集成 → 全部 | product、identifier、channel、platform、arch、版本、commit、依赖锁指纹；首个安装原型前冻结 |
| `ReleasePolicy` | Release → Shell/Update | 独立签名信封，固定编码；产品/渠道/平台、seq、有效期、版本、manifest/包哈希；不能执行未签字段 |
| `MaintenanceBarrier` | 集成定义；Account/IM/Store/Media/Biz/Shell 实现；Update 调用 | 明确进入、排空、持久化、释放资源、安装允许/拒绝状态；每参与者报告同一 maintenance generation，限时失败不可假报完成 |
| `SchemaCompatibility` | Store → Release | 当前/目标应用可读取与写入的 schema 范围、迁移顺序、恢复条件、本地唯一数据保护；升级/回滚分别判定 |
| `ScopedPreference` | Telemetry → 各模块 | device 或 `(environment, account_id)`，schema_version、revision、可写字段和策略上限；不能用全局设置覆盖账号权限 |
| `DiagnosticSnapshot` | 各模块 → Telemetry | 只含枚举、计数、版本、错误码和耗时；不含正文、账号名、凭据、完整 URL、客户资料 |
| `ValidationRecord` | QA → 全部 | case_id、build/SDK/页面/Runtime版本、平台、身份类别、前置条件、故障点、期望/实际、结果、脱敏证据、复核人 |

契约名称是计划提案，由集成 owner 加入 `contracts` 后才成为实现依赖。其他代理不得自行建立同名但不同字段的 DTO。跨模块前置以表中**输出契约已合入且版本固定**为准，不能以“另一个代理正在做”视为依赖就绪。

### 4. 发布与诊断任务包

#### REL-01 · 早期日志与安全诊断接口 · M

- **Owner / 路径：** Telemetry；`core-telemetry/logging/`、`diagnostic_schema/`。前置：基础工程和 contracts 的错误/trace 定义；不依赖 Store 或登录完成。
- **输入 / 输出：** 各模块错误码与任务号 → 有界结构化日志、滚动策略、启动期降级日志接口。字段白名单先于格式化；本地 UI 仅接受裁剪后的错误栈位置，不接收任意 console 对象或远程页正文。
- **实施：** 接入 tracing，按日和体积轮转；按窗口限流；sidecar 只接受约定的结构化诊断，stdout 协议数据不直接落盘；DEBUG 自动到期。将 ipc 日志接线请求交集成 owner。
- **验收 / 证据：** 合成 token、Cookie、姓名、正文、完整 URL 和个人路径进入各入口时均不能出现在最终日志；日志队列饱和、目录不可写、磁盘满不能阻塞业务 actor；提交字段白名单、脱敏夹具结果和延迟分布。
- **失败 / 回退：** 启动日志不可用时降级为有界内存摘要并提示诊断不可持久化，不能改为输出原始请求；崩溃/强杀时明确允许末尾日志丢失。

#### REL-02 · 偏好、scope 与启动依赖拆分 · M

- **Owner / 路径：** Telemetry；`core-telemetry/prefs/`。前置：REL-01、Store 的 KV 原子提交接口、Account 的账号标识/代次、契约生成；设置页接入由 Shell/UI owner 完成。
- **输入 / 输出：** 设备/账号偏好与服务端策略 → 带 revision 的有效快照、定向事件、各核心模块的只读 watch。
- **实施：** 日志先启动；Store 就绪后再读偏好、词条和遥测队列。为 general/shortcut/notify/im/network/update/privacy/diag 明确 scope、默认值和重启需求；旧值只作迁移候选；写入持久成功后才发变更，未知字段保留但不得自动执行。
- **验收 / 证据：** 双账号翻译目标、隐私同意和通知策略互不覆盖；非法字段/旧 revision/无权 scope 拒绝；快捷键注册失败可见；全局默认迁移不能改写账号已保存设置；提交字段矩阵和 Store 故障记录。
- **失败 / 回退：** 无有效值使用内置安全默认并显示未持久化状态；不得因偏好损坏关闭权限校验、TLS 校验或跨账号隔离。

#### REL-03 · 多语言缓存与切换 · M

- **Owner / 路径：** Telemetry；`core-telemetry/i18n/`、`ui/packages/i18n/`。前置：REL-02、Net 端点注册、Store 词条仓储；远程语言 Cookie 更新由 Account 提供受限操作。
- **输入 / 输出：** locale、经确认的 Shark 响应 → 本地词条快照、内置 zh-CN/en-US 兜底、语言变更事件；远程页重载只由 Biz 判断。
- **实施：** 缓存优先启动，后台刷新；限定响应体积和词条格式；渲染为文本而非执行 HTML；将语言变更绑定环境和目标账号上下文，拒绝旧请求覆盖新 locale。
- **验收 / 证据：** 无网/无缓存仍有界面；快速切换语言不会被迟到响应覆盖；本地切换目标为 300 ms 内且不重载；脏业务页不被强制重载；词条缺失使用稳定 fallback。
- **失败 / 回退：** Shark 读取或分发条件未确认时保留项目自有兜底词条，不依赖动态远程脚本补救；不承诺远程页立即切换。

#### REL-04 · 崩溃观察、监视器与进程恢复协调 · L

- **Owner / 路径：** Telemetry；`core-telemetry/crash/`、`process_failure/`。前置：REL-01、Shell 的窗口/环境 generation 与恢复接口；入口分流和 Windows COM 封装由集成 owner 接入。
- **输入 / 输出：** panic、renderer/browser/GPU/传输故障 → 有界诊断记录、去重后的恢复请求、本地 dump 清单。监视器实现本身仍需目标平台原型证据。
- **实施：** `--crash-monitor` 在普通单实例路径之前分流，校验父进程握手/一次性句柄；单 renderer 与整个 browser 环境分别处理；同故障多回调只计一次；共享环境死亡使所有隐藏控制器失效，Shell 负责重新创建和授权握手。
- **验收 / 证据：** 隔离测试包触发访问违例，监视器仍存活并生成可读 dump；正常退出/更新无残留；可见与隐藏提醒、预览、传输视图均能恢复；超限崩溃进入本地错误页而非无限循环。
- **失败 / 回退：** dump 原型未通过时保留本地错误标记和有界日志，发布清单明确诊断限制；核心窗口/传输恢复未通过则阻断对应可交付范围，不能以记录了崩溃代替恢复正确。

#### REL-05 · 诊断包与可选遥测 · M

- **Owner / 路径：** Telemetry；`core-telemetry/diagnostics/`、`analytics/`。分REL-05a本地诊断（默认交付）：依赖REL-01/02/04、脱敏快照和本地文件能力；REL-05b可选遥测：另依赖Store有界队列、Net授权接收端和具体同意。不以05b阻塞05a。
- **输入 / 输出：** DiagnosticSnapshot + 裁剪日志 → 本地诊断 zip、清单和裁剪报告；明确同意后才启用已获授权的遥测路径。
- **实施：** 默认排除 dump、Profile、数据库、凭据、账号绑定与个人路径；20 MB 上限；只枚举本应用确定目录。analytics/crash_upload 默认关闭；关闭递增采集代次，清队列，发送前复核；dump 单独选择和单独说明，不混进常规 zip。
- **验收 / 证据：** 用合成敏感信息验证默认 zip 白名单；超量裁剪有记录；关闭开关后旧回调不回填队列；未经授权接收端无出站；已发出的请求不宣称可撤回。若实现遥测，验证满 5000 条/过期丢弃计数、ACK 丢失的可能重复语义。
- **失败 / 回退：** 无授权 UBT/Sentry 接收端时保持本地模式；远程上报不是 Windows 首发硬依赖。诊断导出失败不能转而收集全目录或整库。

#### REL-06 · 可信更新策略与签名供应链 · L

- **Owner / 路径：** Release；`core-update/policy/`、`release/metadata/`。前置：BuildIdentity、Store 的防重放状态仓储、Net 固定更新源/TLS/代理契约；可以先用测试钥和本地假源完成纯逻辑夹具。
- **输入 / 输出：** 签名策略、标准 updater manifest、产物 → VerifiedRelease（绑定产品/渠道/平台/版本/hash/seq/有效期）。无签名或校验失败返回可解释拒绝。
- **实施：** 固定编码信封验签后解析，绑定 manifest 与包哈希；持久化最高 policy_seq 和最低安全版本，Store 恢复旧 app.db 不能静默降低这两项安全水位；恢复时保留当前安装的安全状态，缺乏可信状态则先取得可信策略再授权回滚。策略不能扩大源域、重定向和权限；普通升级拒绝降级，紧急回滚另用签名授权且检查 schema 兼容。记录密钥生成、CI 密钥库、离线备份、轮换和泄漏恢复的职责，不把私钥写入文档或仓库。
- **验收 / 证据：** 篡改字节、历史有效签名包+伪造回滚、跨产品/渠道/架构、过期和重放、检查后产物被替换、时钟不可信全部拒绝；合法测试升级可接受。提交测试公钥标识、产物哈希和拒绝原因，禁止保存私钥。
- **失败 / 回退：** 不能确认策略时禁止新的回滚授权；不降为 HTTP、不跳过验签。受信版本仍按已有有效门禁运行，禁止版只开放更新/诊断；新修复版本优先于降低版本。

#### REL-07 · 下载状态、维护排空与重启安装 · L

- **Owner / 路径：** Release；`core-update/download/`、`maintenance/`、`installer/`。前置：REL-06、MaintenanceBarrier 各参与者实现、SchemaCompatibility、Shell 真退出接口。
- **输入 / 输出：** VerifiedRelease + 用户动作 → 持久下载记录、可恢复更新状态、安装授权结果。下载完成不等于允许安装。
- **实施：** 临时文件写入，验签/哈希后原子登记；重启重新验证。运行中强更与普通退出共用唯一MaintenanceBarrier，合并并发请求；冻结新业务意图后，允许同维护代次的最终保存草稿和已接收动作，将不可确定外发持久为unknown；然后封闭Store写入口并排空、备份/checkpoint。关闭 DB 前完成持久化和恢复记录；只停本应用持有的传输/浏览器/监视器资源。远程业务页有未提交内容或活动操作时，不能强制清除；等待用户处理或有证据的安全退出。
- **验收 / 证据：** 每阶段进程终止、磁盘不足、安装器拒绝、文件占用、代理断开；A/B 两账号草稿、unknown、游标完整；关闭到托盘不触发安装；`remind_later` 不触发退出安装，仅 `install_on_exit` 允许；一个参与者未排空时安装必须拒绝或保持待处理。
- **失败 / 回退：** 保留当前可启动且策略允许的版本与诊断；不运行不兼容旧 schema 的程序，不删除未知 outbox 来“解锁”升级。升级失败后的重试仍须重新校验产物和维护代次。

#### REL-08 · Windows 安装、身份与系统登记 · L

- **Owner / 路径：** Release；`release/windows/`。分检查点：REL-08a在BuildIdentity、测试签名能力和最小Shell登记接口就绪后提供普通用户安装原型，默认OCR-disabled，可另测身份候选，传输允许stub/候选；REL-08b再依赖REL-06签名产物、最终OCR决策或显式禁用、选定传输清单及完整系统登记。
- **输入 / 输出：** 固定版本构建和运行时需求 → 每用户安装包、离线安装路径、卸载/共存方案、SBOM/许可证及源指纹清单。
- **实施：** Windows 最低版本仍为产品候选，先记录 OS/Runtime/依赖支持矩阵再冻结；验证 NSIS 普通用户路径、WebView2 有/无/离线、独立 scheme 与 AUMID、中文用户名。OCR 若选系统身份路线必须包含身份注册/更新/卸载；否则使用已经验收的替代引擎或保持 OCR 禁用。SDK/模型分发来源和范围未解决则相应产物不得发布。
- **验收 / 证据：** 干净普通用户机器安装、通知显示和冷启动点击、独立深链、监视器、卸载重装；记录实际 package identity 和 Runtime 版本。测试新旧客户端共存，不抢占官方协议；卸载明确保留/删除本应用数据范围，不影响其他 Node/WebView 应用。
- **失败 / 回退：** Runtime 安装失败提供可执行的离线/修复入口；不以管理员权限常驻补救每用户路线。OCR 未通过可以显式移出首发范围，基础通知/账号/传输未通过不能按完整工作台发布。

#### REL-09 · 更新 UI、设置接入与门禁可解释性 · M

- **Owner / 路径：** Release；`ui/apps/update/`，设置页及主壳菜单由其 owner 接入。前置：REL-02/06/07 的状态、错误与动作契约、共享 ipc 快照订阅协议。
- **输入 / 输出：** UpdateState + 有效策略 → 检查、下载、维护中、待安装、失败、禁止业务等可区分状态；UI 不能自判安全或越过维护屏障。
- **实施：** 首次未知策略允许显示本地壳并标未知；有效缓存明确禁止时不进入业务；更新说明按安全文本呈现；Channel 进度和 EventEnvelope 状态分开，epoch/seq 缺口重同步。交付设置分区接入说明及最小权限申请。
- **验收 / 证据：** 首次离线、策略过期、已下载文件缺失、重启后状态恢复、运行中强更、取消和退出到托盘；“稍后提醒”“退出时安装”文案与状态分别验证。包体目标与小窗依赖一起测量。
- **失败 / 回退：** UI 断开不撤销已安全持久化的下载，但不可自动启动未授权安装；错误页仍能打开诊断。

#### REL-10 · 发布候选与可恢复交付演练 · L

- **Owner / 路径：** Release；`release/runbooks/`、`release/manifests/`。REL-10a候选冻结前置：REL-01～09适用输出、QA-02～06与QA-07a早期性能验证通过，具备对应关口证据；产出固定RC及清单。随后QA-07b执行RC长稳，QA-08做独立复核。二者和全部适用关口通过后，REL-10b才关闭；不要求RC产生前完成RC长稳。
- **输入 / 输出：** 固定 commit/锁文件/签名产物和证据 → 可复核 RC 清单、已知限制、安装更新恢复手册、分批发布与停止条件。
- **实施：** 区分可复现源码构建与签名/时间戳导致的字节差异；绑定 SBOM、SDK与页面版本、schema矩阵、签名公钥标识；测试 N→N+1、N+1 启动失败、兼容与不兼容回退。演练在可丢弃测试库上进行，生产库不作故障注入对象。
- **验收 / 证据：** 从干净目标机安装 RC，走最小工作台闭环、更新、重启、恢复；回滚无法满足 schema 条件时被拒绝且可导出诊断/升级修复。每个安装物都能追溯对应报告，签名产物替换后必须重验相关检查。
- **失败 / 回退：** RC 不通过即停止发布该候选；保留失败证据并回到对应 owner。计划完成、代码合并和文档审查都不能代替发布验收。

### 5. 跨模块 QA 任务包

QA 从公共契约阶段开始工作，不在所有模块完成后才启动。只对业务安全、恢复、边界与关键性能设计独立反例；不为低风险文案或简单样式增加机械测试。

#### QA-01 · 证据格式、夹具与持续验证入口 · M

- **Owner / 路径：** QA；`tests/fixtures/`、`tools/validation/`。前置：contracts 草案即可启动；CI workflow 接线归集成 owner。
- **输入 / 输出：** 本文 ValidationRecord 和已有脱敏调查 → 合成账号/消息/分页/响应夹具、用例登记表、可运行命令清单。真实 Cookie、密码、客户正文不得复制进夹具。
- **实施：** 每条用例标 local-contract / target-runtime / controlled-upstream；CI 分格式构建、语义夹具和目标机验收。模块任务提交时携带已跑命令及证据，不以空测试桩返回 passed。
- **验收 / 回退：** 同 seed 可复放关键乱序/故障场景；空证据、版本缺失、未执行步骤不能登记 passed；不可自动执行的目标机项保持 blocked，注明所缺机器、测试身份或权限。

#### QA-02 · G1 身份、登录与迟到结果 · L

- **Owner / 路径：** QA；`tests/scenarios/g1_identity/`。前置：Account/Net/Store 的登录和生命周期契约、目标 WebView2 原型；模拟部分先于真实登录执行。
- **实施 / 输出：** 两账号相同 gid、同 URL 不同账号内容；在登录验证、Set-Cookie、翻译、下载和发送回调挂起时登出重登，再释放旧回调；分别验证保留免密退出与清除凭据登出；绑定实际网页业务成功判据。
- **验收 / 证据 / 回退：** 旧结果不复活凭据、不废除新会话、不更新另一账号；目标 Runtime 登录/Profile/Cookie恢复有独立证据。模拟通过但真实登录缺条件仍为 blocked；Profile 路线失败回到账号原型决定，不取消隔离。

#### QA-03 · G2 页面、窄桥与生命周期 · L

- **Owner / 路径：** QA；`tests/scenarios/g2_business/`。前置：Shell/Biz 窗口注册和桥、账号隔离；可先用恶意测试页验证边界。
- **实施 / 输出：** 逐个记录 home/order/product/comment/bulletin/course/event/bi 八入口、microApp、POST 新窗口、上传下载和焦点；伪造来源、iframe、跳转后旧文档、越权对象/任意 URL 请求必须失败；渲染器与整个 browser 崩溃分开注入。
- **验收 / 证据 / 回退：** 安全配置开启的实际页面可完成已声明功能；脏页、上传/提交中不被 LRU/语言切换/更新销毁；隐藏控制器恢复有记录。子视图失败可验证独立窗口路线，不能关闭安全设置换取 passed。

#### QA-04 · G3 IM 与业务副作用 · L

- **Owner / 路径：** QA；`tests/scenarios/g3_im/`。前置：IM/OPS 的传输能力、outbox、同步游标和任务状态契约；模拟传输夹具与 Web B1/Node C 原型共享同一用例。
- **实施 / 输出：** 提交前/服务端已收/回推前/ACK前终止；ACK/回推倒序；同时间戳、超页、迟到、多连接重复和翻页中重启；隐到托盘、锁屏、睡眠、网络切换与被踢下线；逐项覆盖文本/媒体/引用/撤回/已读、工作状态与成员/结束等写动作。
- **验收 / 证据 / 回退：** 本地不误报成功，unknown 不自动换 localId 重发，完整同步水位不越过缺口；对有明确定义的模拟消息集合证明集合一致，对真实上游仅报告受控场景结果。没有受控测试会话的写动作保持 blocked；未通过同等矩阵的 sidecar 不算已就绪备用。

#### QA-05 · G4 Windows 系统与安装矩阵 · L

- **Owner / 路径：** QA；`tests/scenarios/g4_windows/`。前置：REL-08 的实际安装物及 Shell/Media 原型；只读检查可提前做。
- **实施 / 输出：** 普通用户、最低候选 OS 与主目标 OS、中文用户名、Runtime 有/无、在线/离线、代理/PAC/企业证书；100/125/150/200% 混合 DPI、负坐标、副屏拔插、RDP；IME 组合 Enter、粘贴拖放、非 BMP 文本；Toast 冷启动、Explorer 重启、独立深链、监视器。
- **验收 / 证据 / 回退：** 必须写安装包哈希、Runtime和OS版本、身份状态、步骤与实际结果；开发态窗口截图不能代替安装验收。OCR 条件未满足则只允许显式 OCR-disabled 构建通过相应范围；其他失败回到所属模块，不笼统标全 G4 passed。

#### QA-06 · G5 数据与更新破坏性反例 · L

- **Owner / 路径：** QA；`tests/scenarios/g5_recovery/`。前置：Store 备份/导入/恢复接口与 REL-06/07；仅使用可重建测试数据库。
- **实施 / 输出：** 双账号同日备份、故意错配备份、WAL与损坏库、导入中断同时持续新写、磁盘满/写提交失败、旧备份恢复含 unknown；篡改策略/包、旧回滚授权重放、跨渠道、升级断电/失败/被占用；按 schema兼容矩阵验证恢复。
- **验收 / 证据 / 回退：** 本地唯一数据不被误清，账号身份错配拒绝，提交失败不发成功事件；无法核对的发送保留，不能自动重发；升级排空失败不安装。恢复失败保留隔离库和诊断，不删库重建后宣称修好。

#### QA-07 · 性能、资源与长期驻留 · L

- **Owner / 路径：** QA；`tests/performance/`。前置：可操作的工作台切片；REL-01 的指标接口、进程角色清单。QA-07a基线与短时压力可早于功能完整；QA-07b班次长稳必须使用REL-10a固定的候选产物。
- **实施 / 输出：** 同机、同账号数/数据量/页面/助手功能/预热程度，分别记录纯官方、官方+助手、新客户端；记录 OS、WebView2、SDK版本，全部 Rust/WebView/传输/计算进程。各组至少重复三轮；记录 P50/P95/P99、样本数、采样窗口和异常值，不只留平均数。
- **验收 / 证据：** 见下表；先跑 30–60 分钟驻留与压力场景，再对 RC 运行一个预先固定时长的工作班次模拟（建议 8 小时，实际时间写入报告）。检查断线恢复、队列/缓存/句柄上限，不能把短采样外推为长稳。记录空闲 CPU 和增长趋势，不擅自补造旧文档未定义的 SLA。
- **失败 / 回退：** 基线不等价则只报告绝对值，不计算“省内存百分比”；性能未达标回到 Profile、视图数量、传输与计算模块定位。预算调整须记录实际测量及产品决定，不临时改变统计口径。

| 指标 | 目标与口径 | 处理 |
| --- | --- | --- |
| 冷启动 | 有效凭据时，本地壳可交互 ≤2 s；另报身份验证/业务可操作/IM连通 | 不用壳显示替代业务就绪 |
| 内存 | 单账号主壳+IM空闲 ≤纯官方同条件50%，含全部进程 | 目标尚未证实；报告 Private Bytes 与工作集共享页口径 |
| 输入 | 按键到字符上屏 P95≤50 ms，100 ms 为既有上限；10分钟 >50 ms 长任务≤5次 | 中文 IME 与历史长列表均覆盖 |
| 消息/提醒 | 传输事件到横幅可见≤300 ms；允许提醒且在线正常负载 | 不包含未知上游网络时间；另列IPC与入库/批次等待 |
| 回复时钟 | 有效 ClockService 锚点且系统运行时误差≤1 s | stale/睡眠不承诺实时；恢复先对账 |
| 安装物 | 一期安装包≤45 MB；二期≤30 MB仅在对应路线实现后复测 | 含选定Node等交付依赖；另列WebView2离线包、OCR/纠错模型、安装占用与首次总下载 |
| 小窗/诊断 | 小窗页面资源目标≤100 KB；默认诊断≤20 MB/≤5 s；日志调用 P99≤50 µs | 固定压缩/资源统计口径；不能裁掉必需依赖满足预算 |

#### QA-08 · 独立 RC 复核与证据缺口关闭 · M

- **Owner / 路径：** QA；`tests/scenarios/release/`。前置：REL-10a的固定RC输出（不要求REL-10b已关闭）与全部适用关口报告；由未写对应实现的代理复核。
- **实施 / 输出：** 核对功能清单→任务→测试→证据→构建版本的映射；抽查危险边界的完整执行记录，重跑受代码/依赖/Runtime变更影响的用例；列 passed/failed/blocked/不在此次交付范围，不用“基本完成”。
- **验收 / 回退：** 不存在被隐藏的 blocked 核心功能；产物/证据一致，已知限制可解释；发现 P1 数据、副作用或越权问题，候选返回对应 owner 修复并复验，不能以另一个测试通过抵消。

### 6. G1–G5 的组合与发布范围

G0 是早期可行性工作阶段，G1–G5 是其后持续补证的能力关口；原型局部 passed 不表示整个关口 passed。每个关口可记录分项状态。M0基础工程与安全夹具不必等待所有关口通过，但真实适配器冻结和发布依赖相应目标运行时证据。

| 关口 | 共同 owner | 最早并行产物 | 冻结 / 交付时必须具备 |
| --- | --- | --- | --- |
| G1 | Account + Net + Store + QA | 登录状态机、迟到回调夹具、隔离目录提案 | 目标Runtime登录/两账号隔离/恢复和失效实际证据 |
| G2 | Shell + Biz + QA | 注册表、窄桥、恶意页夹具 | 本次声明入口、安全配置、导航/下载/崩溃恢复/脏页保护 |
| G3 | IM + OPS + QA | ImTransport、outbox、水位、模拟故障 | 选定路线实际收发/确认/后台恢复/受控业务写入矩阵 |
| G4 | Release + Shell + Media + QA | 安装清单、系统能力原型、OCR备选决策 | 正式目标产物、普通用户、Runtime/通知/深链/监视器及启用OCR路线 |
| G5 | Store + Release + QA | staging/备份/签名策略夹具 | 跨账号数据保护、磁盘故障、升级排空、签名/防重放/schema兼容与恢复 |

| 交付层级 | 必含范围 | 可以明确禁用 / 延后 | 不能宣称 |
| --- | --- | --- | --- |
| Windows 内部隔离原型 | 构建、日志、契约、模拟数据、对应单项原型 | 尚未通过的真实操作全部关闭 | 不能宣称可替换现有客服工作台 |
| Windows 有限工作台试用 | G1、选定 G3核心闭环、提醒/草稿/媒体最小集、声明入口的G2、G4基础系统能力、G5保护；明确使用范围与退出路线 | OCR未闭环、可选模型、远程遥测、TSim/高级能力可按能力清单禁用 | 不是全部旧客户端功能平替；成员/订单等禁用项必须可见 |
| Windows 完整范围 RC | 八入口与全部约定IM/边际能力、提醒/媒体/已承诺助手功能，以及全范围G1–G5 | 只允许先前明确未纳入范围的可选项 | 不得把缺少业务写入证据记成兼容完成 |
| macOS RC | 下列MAC任务及同等核心正确性矩阵，独立安装证据 | 未承诺的Windows专有交互 | 不能继承Windows passed作为平台验收 |

缩小试用范围是显式产品决策，不是代理遇到阻塞后静默删掉需求。此前 294.5/295 人日为旧模块估计，不适用于这里的完整原型、联调、对抗与发布工作；在 G0 结果明确后按关键路径与实际吞吐重估，不除以并发代理数当作工期。

### 7. macOS 后续任务包

#### MAC-01 · WKWebView、凭据和传输可行性 · L

- **Owner / 路径：** macOS 平台；按单个模块 owner 移交的 `vbk/crates/<模块>/src/platform/macos/` 实现；公共接线仍归集成 owner。前置：稳定 contracts、Windows 对照结果和明确支持的 Mac 架构/系统版本。
- **实施 / 输出：** 验证网页登录、WebView数据隔离、Keychain生命周期、Cookie同步、后台传输/睡眠恢复、业务页安全桥；逐项比较Web B1/Node C适用性，不能默认 Windows选定路线在Mac成立。
- **验收 / 证据 / 回退：** 在实际 arm64/x64交付目标上跑 G1/G2/G3关键矩阵；记录缺失的SDK/架构依赖。任一核心能力不成立则保持Mac原型，不能以UI能启动当完成。

#### MAC-02 · 窗口、提醒、截图和权限 · L

- **Owner / 路径：** macOS 平台；Shell/Notify/Media移交的 Mac 子目录。前置：MAC-01、已固定跨平台抽象；权限和窗口文案由对应UI owner实现。
- **实施 / 输出：** Dock/托盘、通知点击与冷启动、全屏/Spaces、Retina多屏/热插拔、屏幕录制拒绝/授予/撤销、快捷键冲突、WKWebView崩溃恢复；保持core-im计时事实不变。
- **验收 / 证据 / 回退：** 权限拒绝不重复弹窗或崩溃，不显示未经确认截图；睡眠恢复先对账；通知无法抢前台时提供系统允许的降级。所有已承诺能力有目标系统证据，否则在范围清单标blocked。

#### MAC-03 · 签名、公证、安装与更新 · L

- **Owner / 路径：** Release + macOS 平台；Release独占 `release/macos/`，平台代理只交所需配置提案。前置：MAC-01/02、REL-06/07/10以及Store兼容矩阵。
- **实施 / 输出：** 根据依赖实测选择universal或分架构产物；核对签名、公证、隔离属性、Keychain访问、卸载保留策略、更新中断与架构匹配；生产与开发identifier/scheme/数据隔离。
- **验收 / 证据 / 回退：** 干净普通用户目标Mac完整安装/启动/更新/恢复；签名与产物身份绑定、未知发送与schema约束不减弱。构建成功不等于公证与实际安装通过；不删除隔离属性或关闭系统保护来获得passed。

### 8. 本分片的源文档冲突裁决

| 源文档残留 | 本计划执行规则 | 理由 / 后续处理 |
| --- | --- | --- |
| dev/08 §9“选择稍后后正常退出，安装器被拉起” | 仅 `install_on_exit` 才在真退出安装；`remind_later` 不安装 | 以同文§4.2明确分离语义为准；公共测试必须覆盖二者 |
| 总纲M7“崩溃可上报”与dev/08默认不上报 | 首发要求可本地诊断；授权接收端+具体同意后的上传是可选能力 | 无可用接收端不阻塞本地诊断；禁止静默上传 |
| 旧Windows审查G3只列SEA+Node | Web B1/Node C统一G3矩阵后选择 | 以更新后的IM决策与最终审查为准 |
| 总纲首句“先执行G0再冻结全部契约”易被理解为全部串行 | 确定的核心契约/模拟夹具先冻结最小版本，未知适配器分项等待证据 | G0不等待所有功能实现；避免为了并行把未验证接口锁死 |

上述裁决已在本总稿对应任务落实；历史源文档保留其编制状态。派工使用本总稿，任何进一步源文档同步须保留证据边界。

>>>>>>> Stashed changes
