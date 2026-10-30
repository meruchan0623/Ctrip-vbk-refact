> 历史归档：本篇为范围收敛前的设计快照，全部旧任务、工期和验收要求已停止生效。当前依据为[范围决定](../../../decisions/2026-10-30-web-only-scope.md)与[总计划](../../../plan/00-master-development-plan.md)。

# 并行开发分计划：桌面外壳、业务页与提醒

2026-10-30 · Asia/Singapore

本文把 [壳与窗口](../dev/01-shell.md)、[业务页承载](../dev/04-business-pages.md)、[强提醒](../dev/03-strong-alert.md) 拆成可分派任务。公共身份、事件和权限以 [开发总纲](../dev/00-architecture.md) 为准；取证边界以 [最终审查](../../../reviews/2026-10-30-final-adversarial-review.md) 为准。本文是计划，没有执行目标 Windows 运行时验收；全部任务初始为 `planned`，不能把所列验收条件当作通过记录。

## 1. 从不能丢失的事实划分责任

1. 窗口只是事实的展示入口。隐藏、关闭或重建窗口不能改变账号归属、待回复事实和在途操作。
2. 同一系统资源只能有一个管理者。core-shell 创建和销毁原生窗口、登记视图；业务页模块提供配置与策略；core-notify 决定提醒表现；core-im 决定首条未回复、首次 T1 和责任变化；core-net 提供唯一 ClockService。
3. 远程页面可以失败或被篡改。保留 CSP、站点隔离和 TLS 校验；兼容失败用明确降级处理，不能通过开放通用 IPC 获得“兼容”。
4. 业务页中的未保存内容不等于缓存。确认可恢复之前不得为满足内存配额自动销毁；账号切换与资源回收是两项不同操作。
5. 提醒点击不是回复成功。已读、本地收起、本地确认、有效商家回复、结束、责任转移分别建模，任何一种前端交互都不能伪造服务端事实。
6. 并行开发依赖接口，而不依赖别的模块先写完整产品。共享 trait、合成事件、假时钟和宿主夹具先行；目标平台证据决定适配器是否进入生产组装。

## 2. 文件归属与可并行接缝

下列均为**拟建**路径，位于 `vbk/`。一个文件同一时刻只有一个写入 owner；角色是可复用的任务席位，不要求同时启动全部角色。共享文件由集成 owner 修改，其他代理提交契约变更清单。

| owner 角色 | 独占实现范围 | 不得直接修改 | 输出给谁 |
| --- | --- | --- | --- |
| DesktopShell | `crates/core-shell/src/{registry,lifecycle,host,tray,shortcuts,activation,recovery,shutdown}/`；`src/platform/win/{window,host,tray,activation,recovery}.rs` | `src/business/`、`src/bridge/`、`src/platform/win/biz.rs`、共享入口 | WindowService、注册表租约、焦点/电源事件，供业务、IM、提醒、媒体使用 |
| ShellUI | `ui/apps/shell/`；`ui/apps/setting/` 的框架及通用/快捷键分区；`ui/packages/shell/` | 其他模块的设置分区实现、IPC 生成类型 | 账号导航、宿主矩形、设置分区插槽 |
| BusinessHost | `crates/core-shell/src/business/`、`src/bridge/`、`src/platform/win/biz.rs`、`ui/packages/business/`、`ui/packages/notice/`、`ui/apps/web/` | 壳注册表、账号 Profile 工厂、下载执行器 | 8 入口与工作台、远程桥、通知中心展示 |
| NotificationCore | `crates/core-notify/src/{actor,policy,queue,presenter,attention,sound,toast,env}/`、`src/platform/` | 首次 T1 判定、ClockService、原生窗口创建 | 提醒队列、版本化动作、表现请求、声音/Toast |
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

## 3. 公共前置与排程

FND-01 是工程骨架；FND-02 是身份/服务 trait/DTO；FND-03 是事件、快照与 mock；FND-04 是授权和并发反例验证。编号详见 [基础分计划](01-foundation-account-data.md)。IM 事件任务见 [IM 分计划](02-im-and-service-operations.md)。

`依赖` 表示开始对应实现所需的最小产物，不表示整个模块或 G1–G5 都必须完成。标注“真实联调”的前置只阻止生产组装，mock 开发可以继续。S/M/L 是任务相对复杂度，L 必须按下列检查点逐段交付，不换算成固定日期。

| 波次 | 可开始的任务 | 完成条件 |
| --- | --- | --- |
| A：接口后立即并行 | SHL-01、SHL-02 最小宿主原型；BIZ-01 入口解析；NTF-01 队列；SHL-03/NTF-03 的 mock UI | 使用同版 FND 契约；Profile/WindowService/事实流可用替身 |
| B：实现与取证分开推进 | SHL-04/SHL-05/SHL-06；BIZ-02/03/04；NTF-02/04 | 先完成可复算本地反例，再在隔离安装包和测试账号上取证 |
| C：联合验收 | BIZ-05/06/07；NTF-05/06；跨模块恢复与退出 | 接入真实模块，记录 G2/G4 证据；未过入口和能力显式禁用 |

SHL-02 与 ACC-02 是同一 Profile/宿主原型的两个工作包，使用 FND-02 的 ProfileFactory 最小控制器夹具并行；禁止写成“壳等完整账号模块，账号等完整壳模块”的循环。正式宿主组装须同时引用两方证据。

## 4. 壳与系统集成任务

### SHL-01：窗口与视图注册表（M）

- **owner / 路径**：DesktopShell；`core-shell/src/registry/`、`lifecycle/`。依赖 FND-01、FND-02；事件联调依赖 FND-03。
- **输入 → 输出**：受授权 WindowKind + AccountContext + 创建参数 → ViewLease、WindowService、窗口快照、定向就绪/失败事件；登记实际调用 WebView，拒绝 JS 自报身份。
- **实现步骤**：①明确 Absent/Creating/ReadyHidden/ReadyVisible/Failed/Destroying 转移；②`window_ready` 绑定当前 view_generation；③创建请求合并且有界，5 秒就绪超时进入可恢复失败；④预热排在主外壳可交互之后；⑤单例跨账号复用前撤销旧任务、清空旧内容和资源句柄。
- **验收 / 证据**：A 请求 viewer 后切 B，A 的迟到 ready 不能显示到 B；重复 ensure 只有一个控制器；就绪超时后可重建；销毁途中旧回调不能复活窗口。保存事件时序、注册表快照和资源计数，不能只截“窗口已打开”。
- **失败 / 回退**：保留失败占位与重试入口；禁止绕开注册表直接 new 窗口，禁止无限等待和无限 reload。

### SHL-02：Windows 宿主、Profile、焦点与 DPI 原型（L；G1/G2 部分）

- **owner / 路径**：DesktopShell；`core-shell/src/host/`、`platform/win/host.rs`，原型夹具放 `vbk/prototypes/desktop-host/`。依赖 FND-02、SHL-01；与 ACC-02 并行。
- **输入 → 输出**：ProfileLease、业务视口、测试 URL → 子 WebView 或独立窗口适配器、Profile/环境拓扑证据、锁定版本和决策记录。
- **实现步骤**：①先用两个合成身份/测试页验证创建、隐藏、重建；②再用受控账号验证实际身份及 Cookie/localStorage/IndexedDB/service worker 隔离；③两个账号各三个页面切换 100 次；④125%/150% 缩放、多屏负坐标、最大化、IME 输入、Ctrl+F、F5、系统快捷键；⑤对照独立窗口路线，记录内存与焦点成本。
- **验收 / 证据**：保存 OS/Tauri/wry/WebView2/SDK 版本、构建哈希、测试身份类型、屏幕参数、切换耗时和错误；不能仅因 `document.cookie` 不同宣布隔离。已存活视图切换目标 ≤100 ms，冷页面加载单独统计。
- **失败 / 回退**：多子 WebView 不可靠则选每页显式独立窗口；Profile 接入失败可选每账号独立数据目录并重测资源。两路线都失败则 G2 blocked；不得贴附无边框窗口伪装原型通过。

### SHL-03：主外壳、设置框架与多账号导航（M）

- **owner / 路径**：ShellUI；`ui/apps/shell/`、`ui/apps/setting/`、`ui/packages/shell/`。依赖 FND-03、SHL-01；可用 ACC-01 与业务入口 mock；真实联调接 ACC-04、BIZ-01。
- **输入 → 输出**：账号聚合快照、可见菜单、窗口状态 → 导航请求、宿主逻辑矩形、加载/失败视图、设置分区插槽；当前账号只用于新导航意图。
- **实现步骤**：①账号切换/排序/昵称走账号命令；②导航按后台返回的权限交集展示；③独立 im 是当前默认，设置单例；④主外壳只报逻辑视口，Rust 处理 resize/DPI；⑤通用、快捷键、提醒、网络、助手、更新分区以组件插槽合入。
- **验收 / 证据**：快照晚于新账号响应不会覆盖新画面；权限撤销后菜单和订阅同步撤销；慢接口不阻塞本地壳可交互；弹出设置不复制会话状态。记录订阅水位、账号切换事件与长任务。
- **失败 / 回退**：菜单无权限/加载失败用明确状态，不猜测旧菜单权限；独立 im 与内嵌 im 的产品选择若改变，先由集成 owner 更新契约与 capability 后再改实现。

### SHL-04：单实例、深链与通知激活（M；G4 部分）

- **owner / 路径**：DesktopShell；`core-shell/src/activation/`、`platform/win/activation.rs`。依赖 FND-02、SHL-01；真实导航接 IM-06/UIIM-01；安装注册由发布 owner 合入。
- **输入 → 输出**：启动 argv、第二实例参数、专属 scheme、短效 action token → 经重新授权的导航意图或结构化拒绝。
- **实现步骤**：①普通应用启动先接单实例，内部 crash-monitor 模式在此前完成受约束分流；②冷/热启动共用解析器；③限制 URL 长度、参数和协议，禁用未证实的 `action=auth`；④未登录目标有界排队且绑定目标身份，不在后来另一账号执行；⑤通知 token 只映射已展示对象与版本，URL 不含票据和正文；⑥前台激活被系统拒绝时只显示/闪烁。
- **验收 / 证据**：未运行、隐藏、最小化、后台四场景；过期/篡改 token；A 登出后点击旧 Toast；官方客户端共存及卸载后关联；第二实例只转发一次。保存安装产物版本与激活时间线。
- **失败 / 回退**：普通打开应用仍可用；通知跳转未过安装验收时显式标记不支持，不能以进程内 click 回调代替冷启动协议验收。

### SHL-05：环境级崩溃恢复与资源回收协调（L）

- **owner / 路径**：DesktopShell；`core-shell/src/recovery/`、`platform/win/recovery.rs`。依赖 SHL-01/02；与 BIZ-05 共享受限资源策略接口。
- **输入 → 输出**：ProcessFailed、BrowserProcessExited、账号撤销、电源/屏幕事件 → 环境代次失效、恢复计划与审计事件。
- **实现步骤**：①按浏览器环境识别受影响的全部控制器，包含隐藏 popup/viewer/capture/可选传输；②同一崩溃只执行一次失效；③先撤销旧句柄和订阅，再按依赖重建；④可见视图优先，隐藏视图下次使用重新 ready；⑤有失败次数/时间窗和退避预算；⑥把 suspend/resume/lock/unlock/display-changed 作为内部事件发布。
- **验收 / 证据**：先隐藏三个预热窗，再结束隔离测试环境的浏览器进程，重新使用均重建；旧 OCR/下载回调不写新视图；共享环境崩溃不遗漏后台传输；多次崩溃不会形成重启风暴。记录环境→控制器映射、代次与恢复次序。
- **失败 / 回退**：耗尽恢复预算后显示手动恢复入口；业务提交结果不明进入核对状态，不因重载重复提交；如选 B1 传输，其恢复必须交给 IM 会话协调器，壳只恢复运行资源。

### SHL-06：托盘、任务栏、快捷键、退出与偏好（L；G4 部分）

- **owner / 路径**：DesktopShell；`core-shell/src/tray/`、`shortcuts/`、`shutdown/` 及对应 platform 文件；ShellUI 仅设置通用分区。依赖 SHL-01/03/04、偏好服务接口；与更新 owner 对接排空协议。
- **输入 → 输出**：提醒表现指令、用户偏好、退出原因 → 唯一托盘/任务栏执行器、快捷键注册结果、退出屏障。
- **实现步骤**：①shell 执行闪烁/角标，不重复 notify 策略；②Explorer 重启后恢复托盘；③快捷键先成功注册再持久化，默认唤起 Ctrl+Alt+V，截图 Esc/Enter 仅遮罩内处理；④默认关闭到托盘且首次提示，真实退出独立可达；⑤自启仅安装版且可关闭；⑥窗口坐标恢复夹紧可用屏幕；⑦退出阻止新写、持久草稿/outbox、取消或核对在途动作，再释放传输与窗口。
- **验收 / 证据**：未读 0/1/99/120；托盘恢复、折叠区操作；冲突快捷键无抢占；副屏拔出后仍可见；正常退出目标 3 秒内资源消失。异常未排空必须保留恢复证据并显示状态，不能为满足时延删除未知发送。
- **失败 / 回退**：托盘不可用时保留可见退出/返回入口；无法激活窗口时闪任务栏；不把“隐藏后内存必须下降”作为无条件正确性标准，先保持 dirty 视图与数据完整。

## 5. 业务页承载任务

### BIZ-01：入口目录、菜单与受限业务查询（M）

- **owner / 路径**：BusinessHost；`core-shell/src/business/entries/`、`ui/packages/business/entries/`。依赖 FND-02/03；可用账号/网络 mock，真实接 ACC-04 与 NET 的端点注册表。
- **输入 → 输出**：账号角色、业务线、语言、环境、菜单/配置 → 可见入口和已校验 URL、typed 查询响应。home/order/product/comment/bulletin/course/event/data 共 8 个入口，bi 是 data 别名。
- **实现步骤**：①逐入口保留来源参数，home 不无条件追加 micro=1；②度假/租车/merchant 分支显式表达；③菜单由服务端权限与本地支持范围取交集；④`biz_api` 仅固定只读 endpoint_id，不接任意 URL/header/body；⑤`saveDoorCommonTool` 独立 typed 写命令，超时结果不明需回读，不盲重试。
- **验收 / 证据**：各身份对应入口数量、URL 与权限夹具；伪造业务线/绝对恶意 URL/环境串用拒绝；菜单配置不可用不扩权。每个端点记录动态/静态/待验证及成功判据。
- **失败 / 回退**：缺证据入口标 `unsupported/needs_verification`；禁止用默认菜单开放未授权功能，菜单常用项写入失败保留本地编辑而不虚报成功。

### BIZ-02：窄 bridge、来源鉴别与 data microApp（L；G2 部分）

- **owner / 路径**：BusinessHost；`core-shell/src/bridge/`、`business/compat/`。依赖 FND-04、SHL-01、BIZ-01；运行取证接 SHL-02。
- **输入 → 输出**：宿主可验证的 WebView/frame/文档来源 + 已知事件 schema → 最小本地能力或拒绝；data 输出字段最小化的 microApp 回调。
- **实现步骤**：①只逐项实现既有 10 个事件对应候选命令；②精确 HTTPS origin、路径/端口与导航代次校验；③按实际 WebView 授权，验证同窗 capabilities 合并结果；④远程 logout/全局语言变更由本地外壳确认；⑤OCR 仅受限图片字节/句柄；⑥data 的业务线/user 展示字段按证据白名单给出；⑦异步结果回送时再次核对来源，禁止带敏感数据的通配 postMessage。
- **验收 / 证据**：同源/跨域 iframe、恶意后缀、userinfo、重定向、旧文档回调、同窗本地/远程权限合并；合法命令通过与越权命令拒绝都要测；data 逐业务线与官方受控样本比对。
- **失败 / 回退**：无法可信区分 frame 就关闭影响账号/窗口的远程命令，转本地壳；data 不兼容则该入口 blocked，不扩大 IPC、不删 CSP/XFO。不注入新的通用 appBridge，也不开放未观测 download 命令。

### BIZ-03：导航、新标签与 POST 新窗口（L；G2 部分）

- **owner / 路径**：BusinessHost；`business/navigation/`、`platform/win/biz.rs` 的导航适配。依赖 SHL-01/02、BIZ-01/02；IM 跳转可先 mock。
- **输入 → 输出**：浏览器原导航、新窗口意图、来源 ProfileLease → 同账号目标视图、受限外链提示或拒绝。
- **实现步骤**：①导航与 IPC 白名单分开；②每次导航失效旧文档代次；③IM URL 转为经授权的 ConversationRef 跳转；④目标新窗口由浏览器完成原请求，保留 POST/opener/Cookie；⑤不从回调猜 POST 体并重发；⑥未知协议拒绝，系统外开只接受可验证的用户操作和限流策略。
- **验收 / 证据**：`window.open`、`target=_blank`、POST form、新窗口下载、跨账号错误 Profile、302 到非白名单、恶意外链连续弹窗。保存请求方法、脱敏结构与动作关联，正文不留存。
- **失败 / 回退**：不能保留原请求语义时阻断并解释；不悄悄改 GET，不重复提交；确需外部浏览器时明确登录上下文可能不同。

### BIZ-04：下载、上传、打印、右键与查找（M；G2 部分）

- **owner / 路径**：BusinessHost；`business/browser_actions/` 和 Windows 业务适配；下载执行/文件策略归媒体 owner。依赖 BIZ-03、媒体任务注册与受限句柄接口。
- **输入 → 输出**：绑定账号/文档的原生浏览器回调 → task_id、保存/取消结果、媒体句柄或浏览器操作。
- **实现步骤**：①HTTP/blob/data 下载逐类型取证；②浏览器上下文导出由 WebView 唯一执行，media 只登记状态，Rust 不补发第二次；③保存对话框使用平台 deferral 或已确认目录，同步回调不能阻塞等异步；④上传选择器、打印、图片预览、Ctrl+F、复制/粘贴保持来源上下文；⑤仅关闭该下载自己创建且仍空白的临时窗口。
- **验收 / 证据**：取消保存、磁盘不足、目标重名、A 导出后切 B、导航后下载完成、blob 超限、用户撤销上传；一个动作只生成一任务/一次外部请求。
- **失败 / 回退**：能力不支持时禁用该动作并说明；不使用任意本机路径、不自动打开可执行文件、不把未确认下载当成功。

### BIZ-05：业务视图保活、脏状态与回收（M）

- **owner / 路径**：BusinessHost；`business/lifecycle/`，销毁通过 SHL-01。依赖 BIZ-01/03/04、SHL-05。
- **输入 → 输出**：可见性、keep_alive、已知 dirty/unknown、上传/下载/提交任务、资源预算 → 保留/挂起/回收候选与理由。
- **实现步骤**：①dirty/unknown/inflight/pinned 默认禁止自动销毁；②账号切换只隐藏，不等同登出；③60 秒/5 分钟只是可评估阈值，挂起也不能中断进行中的业务任务；④用户确认关闭与自动回收分开；⑤无安全候选时拒绝/延迟新开并显示资源占用，而不偷删旧页。
- **验收 / 证据**：打开编辑表单后切账号、未能判断脏状态、提交结果不明、上传中、所有页面被 pin、内存压力和休眠恢复。记录每次保留/销毁的判据及任务状态；beforeunload 不能作为唯一 dirty 证明。
- **失败 / 回退**：资源目标未达到可以降低并发页面上限或显式独立窗口方案，不能牺牲唯一数据；不得把 Profile 目录直接当可清缓存。

### BIZ-06：导航 UI、工作台、extra 与通知中心（M）

- **owner / 路径**：BusinessHost；`ui/packages/business/`、`ui/apps/web/`、`ui/packages/notice/`。依赖 FND-03、BIZ-01、SHL-03；notice 真实数据依赖 IM-06。
- **输入 → 输出**：入口、标签、业务线、IQ 通知快照与增量 → 菜单墙/二级标签/工作台工具栏、通知中心、受限导航请求。
- **实现步骤**：①独立 web 窗口每账号一个；②extra 绑定账号和新视图代次，尺寸夹紧目标屏工作区；③notice 是主外壳中的通知中心视图，不新增强制确认弹窗；④通知分类/已读/optStatus 未核验时只显示可证明的状态；⑤总结消息归 ui-im，不新建 biz-ai；⑥空态、加载失败和会话过期各有动作。
- **验收 / 证据**：标签关闭其他不跨账号；切换账号不带出旧标题/摘要；notice 未读与 IM-06 一致；未核验 optStatus 不触发强制确认；用户权限变化后快照与菜单同步。
- **失败 / 回退**：通知协议未验证时中心保留不可用说明与诊断状态，不伪造空列表；未实现的入口不能以占位页面计算“8入口齐”。

### BIZ-07：8 入口兼容矩阵与 G2 汇总（L）

- **owner / 路径**：BusinessHost 产证据；独立 reviewer 判定。依赖 SHL-02/05、BIZ-01 至 BIZ-06、G1 相应身份取证。
- **输入 → 输出**：锁定构建 + 平台版本 + 测试身份/业务线 → 每入口/动作 `passed/failed/blocked/not_applicable` 矩阵与 G2 决策。
- **实现步骤**：逐入口覆盖加载、搜索、详情、新标签、microApp、上传、导出、打印、焦点、DPI、账号隔离、旧回调、崩溃恢复；将官方对照中的现有错误与新引入错误区分；未授权业务线记录不适用理由。
- **验收 / 证据**：八入口全有记录，每个失败都有能力禁用/回退/修复任务；资源统计包括所有浏览器和传输进程，同账号数/页面数/版本/负载对照。内存目标是实测目标，不能把旧“官方 50%”推断当已达收益。
- **失败 / 回退**：任何必需入口或安全边界失败，G2 不能整体 passed；可按入口交付受限预览，但不得宣称完整客户端已替代原程序。

## 6. 提醒任务

### NTF-01：提醒队列、事实消费与版本化动作（M）

- **owner / 路径**：NotificationCore；`core-notify/src/actor/`、`queue/`。依赖 FND-02/03；IM-06 先提供合成事实，生产接提交后的 IM 事件。
- **输入 → 输出**：去重后的 MessageNew/NoticeNew/UnreadChanged/ReplyTimeout/ReplyCleared → 按账号作用域的提醒队列、AggregateScope 快照与增量。
- **实现步骤**：①按环境/账号/kind/key 合并；②保存 item_version、last_msg_id、pending_version、reconcile_epoch；③ack/dismiss/jump/read 分开；④ack_all 只确认用户见到的 epoch/seq；⑤账号授权变化推进 authorization_revision；⑥Lagged/事件缺口先重同步，不猜补事件。
- **验收 / 证据**：旧卡片 click 不确认新消息；ack_all 期间新增条目仍保留；补拉不逐条响铃；账号移除撤回该账号 Toast；队列断流恢复没有跨账号泄露。保存合成时序与期望快照。
- **失败 / 回退**：核心事实不完整显示待同步；保留计数但不创造 ReplyTimeout；持久本地 ack 经 store 服务，不能用 24 小时 TTL 让仍未回复旧消息重新响铃。

### NTF-02：升级、假时钟与恢复对账屏障（L）

- **owner / 路径**：NotificationCore；`core-notify/src/policy/`、`env/`。依赖 NTF-01、NET-04；真实接 IM-06、SHL-05。
- **输入 → 输出**：core-im 首次 T1、ClockService 锚点质量、环境/偏好、ReconcileComplete → L0–L4 表现计划与有限定时器。
- **实现步骤**：①L1/L2 新消息与 L3/L4 待回复分开；②连续追问不改变 IM 定义的本轮起点；③L4 默认关闭；④resume/unlock/reconnect 使旧表现任务失效，先校时及对账；⑤只有当前账号/对账代次 complete 才合并补一次提醒；⑥锚点过期或对账超时显示估计/待同步，不补发陈旧 L3/L4；⑦snooze 到期仍需核对。
- **验收 / 证据**：假时钟推进、墙钟回拨、睡眠期间其他坐席已回复/转出/结束、对账失败、重复 complete、旧 epoch complete 迟到、连续追问、关闭 L2 后不凭空进入 L3。只看当前期望状态与播放次数，不等真实 10 分钟跑定时测试。
- **失败 / 回退**：保留 L0 和待同步提示；不得用离线墙钟估算冒充准确服务器 SLA。首次 T1 只能在 IM-06 实现，本任务不得建立第二个待回复判断器。

### NTF-03：三个轻量提醒界面与无焦点展示（M）

- **owner / 路径**：NotificationUI；`ui/apps/alarm/`、`notifier/`、`tooltip/`；NotificationCore 提供 presenter 接口。依赖 FND-03、NTF-01、SHL-01。
- **输入 → 输出**：授权队列、present、alarm-tick → 合并卡片、等待秒数、版本化动作与布局报告。
- **实现步骤**：①notifier 最多 3 张，其余汇总；②alarm 虚拟列表与上限工作区 60%；③tooltip 按账号分组；④前端只渲染核心给出的秒数，6 秒收起由核心计时；⑤CSS 动画不逐帧移动原生窗口；⑥ready/快照完成前不显示旧卡片。
- **验收 / 证据**：千条合成提醒滚动不卡住输入；悬停暂停、旧版本按钮、授权撤销；多屏和任务栏四边；中文 IME 正在其他应用输入时弹出与点击非跳转按钮不抢焦点。单入口包体目标 <100 KB，注明压缩口径与共享依赖。
- **失败 / 回退**：透明失败可用不透明背景；Windows 非激活行为未验证不得声称“不会抢焦点”；按钮无法在非激活窗口可靠交互时改显式打开主界面处理。

### NTF-04：托盘表现、声音、勿扰与设置（M）

- **owner / 路径**：NotificationCore；`attention/`、`sound/`、`env/`；NotificationUI 的 `ui/packages/notify-settings/`。依赖 NTF-02、SHL-06、偏好服务。
- **输入 → 输出**：提醒表现计划、前台会话、环境、偏好 → shell 托盘指令、有限声音任务、设置反馈。
- **实现步骤**：①声音单线程有界队列，1.5 秒新消息限频；②L4 开启后循环默认 15 秒且最多 10 分钟；③没有音频设备显示可理解状态而不中断 IM；④导入声音只接受本地选择器句柄并校验大小/时长/解码；⑤全屏、演示、锁屏、应用勿扰分开，系统查询失败默认不暴露摘要且静音；⑥用户“跟随系统勿扰”时 L2 用系统通知，不声称自绘窗天然遵守专注助手。
- **验收 / 证据**：插拔耳机、远程桌面无音频、恶意/损坏音频、连续消息洪峰、关闭总开关、重新登录后旧循环、系统返回未知状态；记录播放计数、线程/队列上限和资源释放。
- **失败 / 回退**：失败只降级声音/视觉通道，不清除待回复事实；自定义音失效回内置音或静音并提示，不从消息 URL 无限制下载音频。

### NTF-05：系统 Toast、隐私与安装激活（L；G4 部分）

- **owner / 路径**：NotificationCore；`core-notify/src/toast/`、`platform/win/`。依赖 SHL-04、NTF-01/02，安装元数据由发布 owner 提供。
- **输入 → 输出**：可展示提醒版本 → Toast tag/group、短效本地 action token、撤回/点击结果。
- **实现步骤**：①显式 protocol 激活，绑定专属 scheme；②安装 AUMID/快捷方式/必要注册与运行时一致；③锁屏默认不显示正文，头像不泄露凭据；④登出与版本失效撤回；⑤过期点击可在重新授权后打开当前会话，但不能确认后来消息；⑥默认诊断只记 token 的不可反向识别关联，不记正文。
- **验收 / 证据**：干净普通用户安装、重启、应用完全退出后点击、A 登出重登/切 B、过期 token、官方客户端共存、卸载；保存安装类型/身份/版本以及通知激活日志。
- **失败 / 回退**：系统通知被策略抑制不视为业务失败；缺少冷启动能力则关闭该交付能力并保留自绘提醒。不能用开发机已存在快捷方式证明 NSIS 产物通过。

### NTF-06：提醒端到端反例与 M3 验收（L）

- **owner / 路径**：NotificationCore 组织；独立 reviewer 复核；证据写 `docs/validation/notify/`。依赖 NTF-01 至 NTF-05、IM-06 真实对账、SHL-05。
- **输入 → 输出**：受控消息/责任变化 + 故障注入 → 消息事实、待回复事实、表现三条时间线与验收结论。
- **实现步骤**：覆盖后台/最小化/隐藏、双账号、锁屏/睡眠、断网/失效、窗口崩溃、连续客户追问、商家发送 unknown、已读、其他坐席确认回复、转出/结束、旧点击、恢复后合并提醒。真实业务动作仅在专用测试账号/会话进行。
- **验收 / 证据**：已读不清待回复；unknown 发送不清提醒；只有有效事实清除；恢复前不补陈旧声；mock 通过与实机通过分列。性能口径从事实提交到展示/声音开始分别统计，不用 UI 动画结束时间混代消息到达时间。
- **失败 / 回退**：任何误清、跨账号展示或恢复误响都阻止 M3 验收；关闭 L4 不能掩盖 L3 正确性问题；样本通过只能支持已测场景，不能声称所有系统一定提醒送达。

## 7. 需要统一的旧文档差异与产品默认

| 差异 / 决策 | 本计划的执行方式 | 冻结 owner / 证据 |
| --- | --- | --- |
| 壳文档的单账号 4/总 8 与业务文档的存活 >6 回收阈值 | 都视为旧原型初值；建立一份预算配置，dirty/unknown/inflight 优先于数量阈值；无安全候选时阻止继续扩张 | SHL-02 + BIZ-05 实测后由集成 owner 冻结 |
| 部分旧图画 im 为子 WebView、ai 为 biz-ai | 本地独立 im 为当前开发默认；总结消息归 ui-im；不额外开发 biz-ai | G0 窗口形态决策；变化先提契约请求 |
| “后台账号不保留业务页”与未保存内容保护 | 切换后隐藏，只有证明可恢复且无在途任务才回收 | BIZ-05；不以账号切换当销毁授权 |
| Profile 与窗口生命周期的交叉 | account 管身份、Profile 映射/撤销；shell 管控制器/视图/环境代次；业务模块只用租约 | ACC-02 + SHL-02 共同证据 |
| 通知中心与强提醒混淆 | notice 是主外壳中一个业务视图，协议事实归 IM-06，展示归 BIZ-06；未核验 optStatus 不产生强制确认 | IM-06 + BIZ-06 |
| 30 秒 T1、90 秒视觉标红与携程 SLA | 前两项是本地配置/视觉规则；不得在界面或验收报告声称等同携程考核 | IM-06 + NTF-02 |
| 跨平台兑现范围 | 本分计划先验 Windows；macOS 单独验证 WKWebView 隔离、非激活面板、Dock、权限与激活，不复制 Windows 的 passed | 第二阶段独立平台矩阵 |

## 8. 交接与审查要求

每次模块交接附：任务 ID、使用的 contracts 版本、独占文件列表、输入/输出与错误样本、可运行 mock 入口、未验证能力、验收命令/步骤和脱敏证据、已提的共享文件变更请求。安全反例由独立 reviewer 用相同夹具复算；正常路径与拒绝路径都必须覆盖，避免“全面禁止”假装完成集成。

最低审查交叉：DesktopShell 由基础/身份 reviewer 审视图与 Profile 失效；BusinessHost 由安全 reviewer 审真实调用来源、POST/下载唯一执行者与 dirty 保护；NotificationCore 由 IM reviewer 审首次 T1、unknown 发送、对账屏障与本地 ack 边界。原作者不得将自己写的计划或 mock 通过直接标记为 G2/G4 passed。
