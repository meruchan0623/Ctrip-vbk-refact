> 历史归档：本篇为范围收敛前的设计快照，全部旧任务、工期和验收要求已停止生效。当前依据为[范围决定](../../../decisions/2026-10-30-web-only-scope.md)与[总计划](../../../plan/00-master-development-plan.md)。

# 并行开发分片 01：公共契约、账号、存储与网络

2026-10-30 · Asia/Singapore。状态：开发任务设计，尚未实现或运行验收。

本分片把[开发总纲](../dev/00-architecture.md)、[账号登录](../dev/02-account-login.md)、[本地存储](../dev/05-store.md)、[网络](../dev/06-net.md)转成可分派任务。证据边界以[最终审查](../../../reviews/2026-10-30-final-adversarial-review.md)和[网页调查](../../../research/2026-10-30-web-im-observation.md)为准。它不把浏览器中已登录、接口返回 HTTP 200 或源码存在当成目标客户端验收通过。

## 1. 从不变量划分任务

1. 身份先于请求：账号与环境在任务创建时固定；会话代次、凭据版本、登录 attempt、视图代次分别解决不同竞争条件，不能合并成一个全局“当前账号”。
2. 状态先于通知：成功事件只能对应已经提交的状态；快照与增量必须来自同一提交序列。关键写入不能依靠可能丢失的广播完成。
3. 持久意图先于外发：outbox、草稿和完整同步水位是业务数据；存储失败就停止依赖它的发送或水位推进。超时不等于上游未执行。
4. 边界独立失败：Profile、系统凭据库和 SQLite 不共享事务；HTTP、WebView 与 SDK 不共享网络实现。必须分别证明一致性和故障处理。
5. 未证实的能力先留接缝：Profile 与数据目录、两种 IM 传输、企业代理兜底、旧凭据恢复都在接口后验证，不让整组代理等待所有 G0 工作结束。

S/M/L 是相对实现规模：S 为单一边界、M 为单模块多状态、L 为跨系统或需目标环境取证；不是人日、交付日期或可按代理数直接相除的工期。每个任务完成都提交变更清单、契约版本、验证命令/场景、脱敏结果、剩余限制和回退办法。模拟验证与真实目标环境验证分别记录。

## 2. 单写者与对外接缝

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
| `MediaLease / AttachmentRef` | media ↔ im、store | UI 临时句柄不能作为持久附件地址；转入草稿/outbox 时持久化账号隔离引用；unknown 和未完成草稿存在引用时不得由 TTL/登出清理 |
| `ClockSnapshot` | net → im、notify | 每环境时间锚点、单调时间、误差、有效期、quality；失效会通知消费者；不负责推断会话已回复 |
| `DrainBarrier / StoreHealth` | store → update、im | 停新写、完成或失败现有事务、备份状态、未决发送存在性；完成屏障后才允许安装/替换数据库 |

**拆开编译依赖与运行期协作。** net 先以匿名策略启动；account 后注入凭据提供器与失效回报接口。登录用户尚未 Active 时使用 attempt 句柄验证，不能要求先登录才能调用验证接口。account/net 均依赖 contracts，互不引用对方实现 crate。store 通过注入的身份验证接口/撤销快照检查请求；不反向依赖 account 实现，也不持有 actor 锁等待外部请求。shell 与 account 使用 Profile lease 和控制器生命周期接口联动，不相互等待“完整模块完成”。

## 3. 第一批：公共契约与可替换夹具

### FND-01 工程与集成骨架（M）

- owner/独占路径：集成 owner；`vbk/` 根清单、`vbk/src-tauri/` 启动组装、contracts/ipc 空骨架；初始模块目录创建后移交对应 owner。
- 前置：无；先确认仓库仍为规划阶段，记录基线提交及已有修改。未执行前不把本文的 `vbk/` 路径当作实际存在。
- 输入/输出：输入已定模块地图；输出可构建的 Rust workspace、Vite 多入口、mock 默认模式、模块注册清单与固定依赖版本。依赖/平台 API 的当前支持性由原型执行者查官方文档并记录版本。
- 实现：分离普通启动与内部 crash-monitor 分流；本地基础日志先于 store；匿名 net 先于账号验证；所有生产网络与凭据能力默认显式配置，夹具不得碰真实用户目录。
- 验收证据：Windows 构建、类型检查、最小本地窗口启动记录；模拟账号可启动壳且没有外发请求；记录目标 OS/Runtime 与工具链。macOS 仅能报告其实际做过的检查。
- 失败/回退：构建或运行时不成立时先修骨架，停止依赖其运行时结论的任务；独立领域模块和文档取证可继续，不以换到 Electron 作为未审查的自动回退。

### FND-02 身份、服务接口与错误契约 v0（M）

- owner/独占路径：集成 owner；`vbk/crates/contracts/` 与生成的 TS 类型。
- 前置：FND-01。
- 输入/输出：输入各模块接口提案；输出 AccountContext、ConversationRef、ViewContext、AggregateScope、LoginAttemptHandle、ProfileLease、EndpointPolicy、仓储事务/ClockService trait，以及脱敏 `AppError`。
- 实现：定义 `retryable` 仅为提示，写操作另有 `confirmed/rejected/unknown`；为生命周期撤销、磁盘满、scope 失效、快照缺口、业务拒绝定义稳定错误。持久账号身份与短期 session_generation 分开：数据库/outbox 以环境+账号归属，重启重新验证后建立新运行上下文；不因旧 generation 不再有效而删除草稿或 unknown 记录。
- 验收证据：Rust 生成 TS 无手写重复类型；账号、net、store、IM 的最小模拟消费者同时编译；同名 gid/localId 在不同账号夹具中不混淆；无秘密类型可序列化到前端 DTO。
- 失败/回退：契约争议形成变更提案及受影响消费者列表；使用版本化 mock 继续不依赖争议字段的部分，禁止各模块自行加兼容字段掩盖冲突。

### FND-03 订阅—快照—重放与模拟服务（M）

- owner/独占路径：集成 owner；`vbk/ui/packages/ipc/`、contracts 的事件/测试夹具。
- 前置：FND-02。
- 输入/输出：输入 `EventEnvelope{scope,stream,epoch,seq,payload}`；输出有界订阅器、原子快照协议、mock account/store/net/transport 时间与故障注入接口。
- 实现：等待订阅建立再缓存，再取同 actor 提交序列快照，丢弃旧 seq 后连续重放；缺口、epoch 改变、缓冲溢出、来源代次失效全部重建。AggregateScope 权限集合变化递增 authorization_revision。模拟服务支持定点暂停/释放回调、重复/乱序消息、提交失败，不能只提供永远成功 happy path。
- 验收证据：在订阅与快照之间插入事件不丢失；旧账号/旧快照迟到不覆盖新视图；缓冲溢出明确重同步；撤销订阅和 Channel 后无旧客户数据继续下发。
- 失败/回退：事件协议不通过则禁止发布实时 UI 集成版本；领域状态机可用直接服务夹具继续验证，不临时全局广播补洞。

### FND-04 授权入口与并发契约验证（M）

- owner/独占路径：集成 owner；`vbk/src-tauri/capabilities/`、组装授权入口与 contracts/ipc 契约验证夹具。
- 前置：FND-02、FND-03；生产视图注册接入时消费 shell 提供的真实来源注册表。
- 输入/输出：输入每模块命令/视图/scope 矩阵；输出单命令授权与核心对象授权的可复算矩阵。
- 实现：区分本地壳、远程登录、远程业务桥、第三方订单页；登录远程页与第三方页无 IPC。内核从真实来源推导 ViewContext；事件下发和活 Channel 每次核验；禁止 JS 自发事件改变核心业务状态。
- 验收证据：合法本地账号读取通过；跨账号、旧代次、伪造 label、capability 合并误授、子 iframe 借桥均拒绝；权限增加必须对应声明用途和反例测试。
- 失败/回退：撤回新增 capability 或命令注册，保留 mock 开发；拒绝以禁用 webSecurity、站点隔离或扩大域名后缀完成联调。

## 4. 账号 owner 任务包

### ACC-01 身份 actor、attempt 与撤销（M）

- owner/独占路径：账号 owner；`vbk/crates/core-account/src/` 的领域状态与局部夹具。
- 前置：FND-02；快照/UI 联调再依赖 FND-03。
- 输入/输出：AccountService、AccountLifecycle、ProfileLease 模拟实现；状态包括 Validating、Active、Background、Expired、Cached、SignedOut。
- 实现：账号 ID 随机生成，唯一映射 `(environment,buid)`；attempt、session_generation、credential_revision 独立。先撤销旧代次并停发，再取消/清理资源。active/background 是导航关系，切账号不能改变在途任务 scope；忘记账号与仅登出保留记录分开。
- 验收证据：A 请求挂起切到 B、退出重登 A、取消登录后返回用户信息、旧鉴权错误晚到，均不污染新会话；进程重启/恢复旧备份后代次不复用。
- 失败/回退：拒绝相关操作并保留可诊断状态；不把清理失败报告为退出完成，不通过全局 current_account 补字段。

### ACC-02 WebView2 登录与 Profile 路线原型（L；G1）

- owner/独占路径：账号 owner；`core-account/platform/` 与局部原型；共享 platform-win patch 仅以提案交集成 owner。
- 前置：ACC-01、NET-02；依赖 FND-02 的 ProfileFactory/控制器接口，用最小 shell 原型提供控制器即可，不能等待完整业务页。
- 输入/输出：输入锁定的 Tauri/wry/WebView2 版本与登录入口；输出 A1 同环境多 Profile、A2 独立数据目录对比记录、最小 Cookie 恢复证据和明确路线决策。
- 实现：随机待定 Profile；异步 Cookie API；禁密码自动保存；精确导航策略；同时覆盖页面导航与 SPA/XHR 登录完成。验证密码/短信/滑块等实际支持方式，不能仅以出现 Cookie 判成功。比较两个账号及同一账号重新登录、控制器关闭、Service Worker 迟到写入、浏览器进程崩溃。
- 验收证据：目标 Windows 中完成登录、`getCurrentUserInfo` 身份验证、两账号 Cookie 隔离、旧 Profile 不复用；记录 Runtime/SDK、进程组、资源增量、失败分支。三 Cookie 独立恢复若未通过，明确禁止凭三项导入自动快登。
- 失败/回退：A1 不成立或不接受 fork 时测试 A2；A2 也失败则 G1 blocked，保留 mock 核心。做法 B 自研登录只有在 A 失败且接口/风控范围明确后重新立项，不能默默启用。

### ACC-03 凭据提交、续期比较与启动补偿（L）

- owner/独占路径：账号 owner；`core-account` 凭据/提交/清理模块。
- 前置：ACC-01、DAT-01、NET-02；原生实现复用 ACC-02 产出的 Profile 接缝，可先用夹具实现。
- 输入/输出：系统凭据库、AccountIndex、CredentialCommitJournal、ProfileLease → 完整 ready 或明确失败及恢复标记。
- 实现：受保护暂存凭据 → 非秘密恢复标记 → SQLite 账号映射提交 → ready 发布；重启恢复或回收未发布项。序列化字节超凭据库限制时拒绝，不能截断/落明文。凭据版本比较后才吸收候选 Set-Cookie；保留 Domain/Path/HttpOnly/Secure/SameSite/Expiry，删除语义同步。重新登录返回其他身份不覆盖目标账号，进入明确的身份不匹配/添加账号流程。
- 验收证据：在每一步故障点中断进程，重启不出现半登录或孤儿秘密；测试凭据库不可用、超大快照、SQLite 提交失败、Profile 被占用、旧 Set-Cookie；普通库/日志/导出无密码和 ticket。
- 失败/回退：回收暂存项并保留可恢复标记；失败 Profile 隔离且不分配新会话；凭据能力不可用时提示重新登录或阻止持久快登，不降级明文存储。

### ACC-04 登录、快登、失效与退出闭环（L；G1）

- owner/独占路径：账号 owner；`core-account` 生命周期编排。
- 前置：ACC-02、ACC-03、NET-02、FND-03。
- 输入/输出：受限登录 attempt、可信用户身份响应、业务鉴权失败报告 → ready/expired/logged-out 与授权账号快照。
- 实现：网页登录验证严格解析 `response.user`；当前证据中的 `11000` 分支仅按该端点处理，不能复制到所有 API。启动先 Validating；纯断网不清凭据。Cached 快登与 SignedOut 登出分开；确认失效才停重连。退出隔离旧 Profile、撤销 net Jar/IM/下载/助手任务，等资源释放后清理；保留免密也必须停稳旧控制器。
- 验收证据：两个账号并存、背景账号 IM、失效后重登、断网冷启动、凭据库与 Profile 不一致、退出清理失败后重启；每个结果包含上游身份/业务成功判据与脱敏证据。
- 失败/回退：账号维持 Validating/Expired/清理待完成等真实状态；不可先放开业务写入再等待验证。G1 不通过不冻结生产账号适配器。

### ACC-05 登录外壳与账号联调（M）

- owner/独占路径：账号 owner；`vbk/ui/apps/login/`；shell 账号区由 shell owner 按同契约接入。
- 前置：ACC-01、FND-03 可启动 mock UI；真实闭环依赖 ACC-04、FND-04。
- 输入/输出：login/account 快照与命令 → 登录进度、取消、失败恢复、重新登录界面；只返回展示 DTO。
- 实现：本地外壳与远程页权限分离；等待用户与网络错误分开；旧 attempt 回调不更新新窗口；清楚区分退出在线保留免密、退出登录、删除本地记录。网络设置以 NET-05 提供的组件/契约接入，窗口路由由 shell owner 组装。
- 验收证据：双账号切换、登录取消、窗口重建、离线冷启动下界面可操作；记录壳可见/账号验证/业务可用/IM连通四个独立时间，不合并成 2 秒登录承诺。
- 失败/回退：保持可重试的本地壳和明确状态，不让远程页直接向前端暴露 ticket 或绕过核心宣布成功。

## 5. 存储 owner 任务包

### DAT-01 分库、schema 与类型化仓储骨架（M）

- owner/独占路径：存储 owner；`vbk/crates/core-store/` 的连接、迁移、身份、AccountIndex、KV。
- 前置：FND-02；应用 identifier、Local 数据目录从集成/shell 决策输入，原型用隔离临时目录。
- 输入/输出：固定数据库身份句柄、迁移版本、KV schema → 每环境 app.db、每账号 im.db、有界写 actor/读连接与健康状态。
- 实现：库内校验 environment/account_id/buid/db_id；WAL + FULL；按全应用预算分配队列字节、读连接和页缓存；拒绝新于二进制的 schema；每库事务化迁移；跨库仅以恢复标记协调。账号元数据严格字段白名单，不序列化原始上游对象。
- 验收证据：错环境/错账号/新 schema 拒绝；多账号并发、SQLite BUSY、磁盘满明确失败；已提交 KV 版本与 watch 一致；测试目录中没有秘密；启动初始化测量单列。
- 失败/回退：迁移回滚且保留原库；单库降级不影响其他账号；禁止删库重建和降低 user_version。

### DAT-02 消息、发送意图与同步水位事务（L）

- owner/独占路径：存储 owner；core-store 业务仓储、迁移及故障夹具。
- 前置：DAT-01；与 IM owner 在 FND-02 接缝上共同冻结事务语义，由集成 owner 修改 contracts。
- 输入/输出：`CommitIncomingBatch`、`CommitOutboxIntent`、`ApplySendEvidence`、`CommitSyncPage`、草稿版本比较 → 持久提交结果与提交后通知。
- 实现：消息幂等键按账号库内 `(gid,msg_id)`；localId 绑定原发送意图。入站消息、必要会话摘要及相关事实同一事务；ack/回推与 outbox 归并保持原子性。完整水位与最新已见分离；页面消息/断点一起提交，整轮结束有证据才推进完整水位。原子条件由 IM 提交计划表达，store 不猜上游分页终点。草稿 CAS 防止旧译文覆盖新草稿；UI 当前编辑缓冲由 IM 提交持久草稿 CAS，生成不可变发送意图后助手不能另建发送账本。附件从临时 MediaLease 转入草稿/outbox 时，事务记录账号隔离 AttachmentRef、持久资源身份与引用；downloads/附件表迁移由 store owner 落实，media 只提交 schema 提案。keyset 翻页包含稳定排序键。
- 验收证据：逐故障点测试“意图提交前/后、外发前、Ack 前/后、页面中断、最后页提交”；重复入站/迟到回执不重复计未读；磁盘满不返回保存成功；窗口关闭不会撤销已被核心接收的持久意图；临时句柄过期/登出后 outbox unknown 或持久草稿的附件仍可找回，错账号引用拒绝。
- 失败/回退：事务整体失败、无成功事件、水位不推进；outbox 重启后 unknown 仍待核对。不得以客户端重发替代恢复丢失的确认状态。

### DAT-03 旧版只读导入与受限隔离区（L；G5）

- owner/独占路径：存储 owner；core-store legacy import；账号凭据候选交 ACC-03。
- 前置：DAT-01、DAT-02、ACC-03；旧数据目录、环境和字段归属取证属于本任务，不假定路径推断已经成立。
- 输入/输出：停止写者后的主库/WAL/SHM 一致副本、源指纹、脱敏配置字段 → staging、batch_id、已归属/孤儿/多义计数及增量合并报告。
- 实现：先确认源文件集合稳定，复制前后指纹一致；仅 staging 可恢复/转换，旧文件只读。password 解析边界丢弃，原 config 不复制到 staging。消息经 gid 对账号归属，不明确就隔离；groupMember 和无归属 customEmoji 不猜账号。按源快照+环境+导入器版本记录进度，新版草稿/outbox/已读/星标优先。
- 验收证据：测试旧库带已提交 WAL；源记录=归属+隔离计数；中断/重复导入不新增重复、不覆盖新版同时产生的数据；只有密码的旧配置只导入账号名；未证明 Cookie 最小集则不承诺快登。
- 失败/回退：只清当前 batch staging 后重试，不清正式库；源持续写入则暂停等待；禁止自动关闭/删除旧客户端数据。

### DAT-04 备份、损坏恢复与更新屏障（L；G5）

- owner/独占路径：存储 owner；core-store backup/recovery/drain。
- 前置：DAT-01、DAT-02；与 update owner 在 FND-02 定义 DrainBarrier/schema 兼容接口。
- 输入/输出：固定库身份、backup generation、升级原因 → `.tmp` 校验后原子发布备份、恢复完整性报告、写入排空结果。
- 实现：按环境/账号/db_id 分目录；backup API 完成且身份/schema/完整性检查通过才发布；升级保护备份独立保留。坏库连 WAL/SHM 留证，恢复候选先 staging 校验。旧 outbox 进入核对屏障；恢复水位回退后补拉。备份清单包含持久附件引用及资源归属/完整性信息，附件副本随一致性策略保存；缺件必须显式报告并阻止依赖该附件的发送，不能伪造恢复完整。安装屏障阻止新写、排空现有写并处理未知外发，不能仅等待队列空。
- 验收证据：同日两账号备份不碰撞；错账号/错环境/新 schema 拒绝；截断库、保留 WAL、只移除可重建 SHM 的反例；恢复旧备份后不重复发送；升级失败能启动兼容版本或明确阻止不可读写的旧版。
- 失败/回退：备份失败不发布，不淘汰上一份有效备份；恢复失败保留受损资料和限制状态，不宣称空库完整恢复；更新排空失败中止安装。

### DAT-05 维护命令、容量与耐久故障验收（M；G5）

- owner/独占路径：存储 owner；core-store maintenance/metrics/本模块验证。
- 前置：DAT-02、DAT-03、DAT-04；维护 IPC 接入依赖 FND-04。
- 输入/输出：保留策略、健康/占用快照、删除本地记录明确意图 → 分批清理、待清理记录、容量诊断；设置 UI 由 shell owner 接入。
- 实现：cache、历史记录、草稿/outbox 分类；`status=4` 未取证前不启用自动删除；排除活动会话/未决发送/同步引用；附件仅在没有 outbox/草稿/有效下载引用且保留策略满足时删除，TTL 与普通登出不能越过引用。账号删除覆盖主库、备份、quarantine、staging、媒体关联，失败可恢复。限定维护批次、WAL checkpoint 等待；FULL/磁盘满不无限重试。FTS 默认后置，产品确认需要后另派扩展，不把其完成设为 IM 上线前置。
- 验收证据：三账号收消息时维护不阻塞其他账号；中文路径/Defender、磁盘满、长读事务、崩溃重启；旧文档性能目标按同机夹具报告 P95，任何不达标须保留实测，不以改持久性换数字。
- 失败/回退：停止可选维护或该库写入并提示；绝不为降低体积删除 unknown/草稿/尚未同步事实。

## 6. 网络 owner 任务包

### NET-01 端点注册、类型化响应与副作用分类（M）

- owner/独占路径：网络 owner；`vbk/crates/core-net/` 的策略/端点/错误/匿名客户端。
- 前置：FND-02。
- 输入/输出：业务 owner 提交的方法级字段、认证、证据等级 → `EndpointPolicy`、类型化 response/outcome、脱敏日志；上游业务语义由对应业务 owner确认。
- 实现：精确 HTTPS host/port/path/method；参数/解压后响应限额；禁止任意 URL/header。匿名更新/CDN/TSim 与携程身份隔离。逐端点解析 HTTP、Ack、完整 Errors、success/isSuccess/status 与必需字段；已登记幂等查询才按错误分类有界重试，写操作默认零自动重试、断连可能已执行则 unknown。
- 验收证据：HTTP200+业务失败、Ack Success+缺字段、鉴权错误/网络错误区别、压缩炸弹、未登记跳转、端口/HTTP 降级；服务端接受写后断连仅执行一次；日志中无正文/凭据。
- 失败/回退：未知方法保守拒绝或标 unsupported，保留响应结构脱敏证据；不能把所有错误映射登录过期。

### NET-02 Cookie 镜像与登录验证通道（L；G1）

- owner/独占路径：网络 owner；core-net credentials/jar/identity endpoints；平台 Cookie 封装由集成 owner 合入。
- 前置：NET-01、ACC-01（只需已冻结接口与模拟实现，不依赖 ACC-04 完整登录）。
- 输入/输出：AccountContext 或 LoginAttemptHandle、凭据 revision、ProfileLease → 每代次内存 Jar、候选 Set-Cookie/鉴权报告、身份验证 DTO。
- 实现：初始化账号以前的登录验证使用专门 attempt 策略；正常请求冻结 scope/revision，精确 URL 过滤 Cookie；异步读 Profile，未知站点 Cookie 只按明确端点需要读取。对凭据候选只向 account 提交、不自行持久化；响应回到新代次时拒绝。Jar 不落盘，跨环境/第三方/更新不借用携程 Cookie。
- 验收证据：挂起请求后 logout/relogin 释放旧 Set-Cookie；不同 path/host-only/expiry/SameSite、Cookie 删除、Profile/keyring 不一致；原子提交前不能访问普通业务端点；三 Cookie 依赖与其他风控 Cookie 有区分证据。
- 失败/回退：候选变化进入待验证或拒绝；无法异步读取 Cookie 时报告平台限制，不用 JS document.cookie 降低 HttpOnly。

### NET-03 TLS、代理、PAC 与多栈一致性（L；G1/G3）

- owner/独占路径：网络 owner；core-net platform adapter/策略；WinHTTP 共用封装提交集成 owner。
- 前置：NET-01；WebView/SDK 对比消费 ACC-02 与 IM 原型结果，不阻塞 Rust 路由实现。
- 输入/输出：EnvProfile、代理模式与网络/配置代次 → 精确 URL 代理解析、客户端策略、各栈能力矩阵。
- 实现：PAC 在有界阻塞任务处理，按完整 URL 与代次缓存；代理失败不静默直连。系统 CA、测试域专用 CA 与主机名校验分离；生产不加载测试根。新用户跟随系统、旧 useSystemProxy=false 保留 Direct。代理模式变更 pending 后受控重启；网关选择只声明 Rust 侧生效。SDK HTTP/WSS 分别接收策略，不能只设置环境变量就判支持。
- 验收证据：Rust HTTP、WebView HTTP/WSS、Node HTTP/WSS 各列证书拒绝、系统根、PAC 同 host 不同 path、代理失效、认证、断网恢复结果；目标低版本 Windows 实测。
- 失败/回退：NTLM/Kerberos 等能力不成立时明确不支持的部署条件或另评 WinHTTP 适配；不关闭证书校验，不自动将未经同等验收的传输当兜底。

### NET-04 ClockService 与恢复信号（M）

- owner/独占路径：网络 owner；core-net clock/connectivity。
- 前置：NET-01、FND-02；IM/notify 可先消费可控 mock clock。
- 输入/输出：已登记可信时间响应、往返耗时、单调时间、睡眠/网络事件 → 每环境 `{server_epoch_ms,monotonic_anchor,uncertainty_ms,valid_until,quality}` 与恢复信号。
- 实现：确认时间字段单位/时区/服务适用性，未知则 quality 不可用；墙钟跳变/睡眠/来源变化后锚点失效；离线只保留估计，不继续承诺强提醒精度。NLM 是提示，主动探测有界，误判离线仍允许用户探测。重连后会话对账屏障由 IM owner 负责，net 不宣布业务已恢复。
- 验收证据：墙钟 ±5 分钟、睡眠跨 T1、过期锚点、同一环境时间源冲突、网络抖动；过期信号到达 IM/notify 后不得补响已结束会话；目标时间误差与质量一起记录。
- 失败/回退：降级 stale/unknown 并显示等待对账，不用 Date.now 加旧 offset 伪造准确倒计时。

### NET-05 受限 fetch、设置与联调（M）

- owner/独占路径：网络 owner；core-net 命令与局部集成夹具；设置/登录 UI 接入建议交对应 owner，不直接改其他代理文件。
- 前置：NET-02、NET-03、NET-04、FND-03/04；真实双账号闭环依赖 ACC-04。
- 输入/输出：`endpoint_id + scope + params`、代理/网关配置 → 有限 DTO、状态快照、pending/restart_required。
- 实现：只读 fetch 仅可信本地视图；状态修改由业务专用命令；prod 不注册 set_env。status snapshot 和事件共享同流序号；探测限制并发。检查日志脱敏发生在日志写入前，字段白名单不包含客户正文、票据片段或可关联的凭据哈希。
- 验收证据：未登记端点、伪造 scope、过期 view_generation、远程调用均拒绝；正常本地读可用；切账号不改变 in-flight；代理 pending 与旧生效策略显示准确；请求数/重试数与可复算轨迹一致。
- 失败/回退：删除未证明安全的端点登记或 capability，保持明确不可用状态；不开放临时任意 fetch 方便联调。

## 7. 并行调度与交接

| 波次 | 可并行工作 | 必须先收到的产物 | 禁止误读 |
| --- | --- | --- | --- |
| A | FND-01/02 顺序完成；其他 owner 读源、写端点/仓储提案和合成夹具 | 基线提交、文件锁表 | 读源准备不需要等待 G1–G5 全通过 |
| B | FND-03、ACC-01、DAT-01、NET-01 | FND-02 v0 | mock 可用不代表原生登录/生产接口可用 |
| C | FND-04、DAT-02、NET-02、NET-03、NET-04 | 各前置接口已固定；shell 提供最小控制器夹具 | net/account 不应互相等待完整实现 |
| D | ACC-02 与 ACC-03；DAT-03/04 按具体依赖；IM/提醒/业务 UI 持续用同契约夹具 | NET-02、DAT-01/02、Profile/事务接缝 | 全套功能可以先写，但对应真实适配器未通过前不能冻结或放行发布 |
| E | ACC-04/05、DAT-05、NET-05、跨模块故障验证 | 对应前置任务与原型证据 | 代码完成、mock 通过、G1/G5 通过是三个不同状态 |

任何共享契约变更提交 `原因 → 反例 → 旧/新字段与语义 → 受影响任务 → 迁移或回退 → 验证` 给集成 owner。合入后发布契约版本，消费者逐一确认；旧生成类型与锁文件不能由模块代理手改。依赖方只应等待自己消费的接口版本，不能等待整个 owner 所有任务结束。

## 8. 阻断与证据清单

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
