# 现有客户端缺陷分析与 Electron 去留

> 历史调查/审查材料：事实与证据保留，本文原有实施建议、旧功能范围和验收工作包不作为当前要求。当前只做网页 IM 范围及唯一扩展“独立强提醒窗口”，以[当前范围决定](decisions/2026-10-30-web-only-scope.md)为准。新方案尚未因此获得原型或发布验收。

> **范围已变更（2026-10-30）**：以[网页版范围决定](decisions/2026-10-30-web-only-scope.md)为准。只做目标网页已有的消息、通知和订单联系入口；网页没有的功能不做。本文超出该范围的桌面对齐、扩展功能与验收要求均作为历史参考，不再执行。

2026-10-30 · 最终文档审查修订

## 结论：重写本地 IM 与特权边界，Tauri 收益通过原型验证

以 Tauri 2 + Rust 作为替代 Electron 的首选候选，正式冻结前通过总纲 G0。复用范围如下：

- **远程 vbooking 内容**：官方多为本地 React 外壳 + iframe，重构改成顶层子 WebView，并逐入口验证兼容桥和登录；不保证原样运行。
- **打包在本地的窗口**（IM、登录、首页、通知、AI、截图等，位于 `dist/` 下）：重写。其中 IM 是商家每天用得最多、也最卡的部分，必须优先重写。

静态代码与既有样本提示三个待拆分因素：运行时与启动参数、任务/窗口组织、页面自身长任务。换框架不会自动消除过量页面、阻塞任务或低效数据流；Rust 核心同样可能被无界队列与阻塞操作拖住。应以隔离对照确认因果，不能将当前卡顿全部归因于 Electron。

## 先更正：哪些是官方的，哪些是插件的

上传的两个安装包都已经装过「旅游商家助手」（[trip_vendor_im_companion](https://github.com/meruchan0623/trip_vendor_im_companion)）的注入包，下面这些属于插件，不属于携程官方：

| 组件 | 归属 |
| --- | --- |
| macOS `TripVendorLauncher`（Swift 启动器）、`Resources/companion/` | 插件的 Mac 注入安装器 |
| Windows `app.asar` 入口 `trip-vendor-bootstrap.cjs`、`companion-vendor-original-main.json` | 插件的 Windows 资源注入 |
| `--remote-debugging-port` 与 CDP 页面注入 | 插件用来挂翻译面板、套餐速览、订单查询 |

官方入口是 `dist-electron/main/index.js`。[01 架构选型](01-architecture-selection.md) 里把启动器和 CDP 当作官方架构的说法已经作废。

## 官方客户端的缺陷

以下静态发现与引用的历史实测分开使用；历史性能数据不是本轮重复测量，且插件安装环境不能当作纯官方基线。证据来自两处：`vbk-electron/resources/app.asar`（Windows 版 1.2.12）主进程代码，以及插件仓库 [卡顿修复计划](https://github.com/meruchan0623/trip_vendor_im_companion/blob/main/docs/2026-10-28-tsim-client-performance-and-translation-fix-plan.md) 中的实测数据。

### 两端共有

| 缺陷 | 证据 | 影响 |
| --- | --- | --- |
| 关闭站点隔离 | 无条件 `disable-site-isolation-trials` | 弱化站点隔离；部分页面/iframe可能共享renderer而相互影响，但该开关不能证明所有窗口都在同一进程；历史插件样本记录了TSim查询页与客服页共享renderer |
| 关闭 HTTP/2 | 无条件 `disable-http2`，再加 `ignore-connections-limit` 放开携程域名的连接数 | 改变协议协商与并发行为，可能影响加载；是否回退HTTP/1.1及延迟代价须按请求实测 |
| 关闭 Web 安全 | 7 处 `webSecurity:false`（BrowserView 等） | 跨域与混合内容不受限，属于安全隐患 |
| 每个账号一套 BrowserView + 持久分区 | `new BrowserView({partition:"persist:"+账号})` | 账号与页面增加会增加资源；增长幅度需按实际页面/进程对照，不能断言线性倍增 |
| 主进程负担重 | better-sqlite3 与窗口/IPC在主进程；IM、OCR、拼写检查有 utilityProcess；截图另有平台调用 | 存在同步数据库和IPC调度压力；不能把全部计算归为主进程执行 |
| 包体臃肿 | `app.asar` 约 351 MB，内含 617 个 node_modules 包（约 479 MB 解开后），生产依赖里带着 `heapdump` | 确定增加分发和解压体积；启动是否变慢还取决于实际加载依赖与I/O，需测量 |
| 官方页面自身长任务 | 实测 123 秒内 130 个长任务，合计约 26.9 秒，最长 1.8 秒；按键事件最长约 3.08 秒；React 提交约 1.47 秒；官方 `bn-pf` 单次约 2.59 秒 | 说明页面执行可影响输入/复制/滚动；换壳不能消除页面长任务，新UI需重做数据流并验证，而非仅加虚拟列表 |
| 运行时过旧 | Electron 27.3.11 / Chromium 118 | 已停止安全更新 |

### Windows 特有

| 缺陷 | 证据 | 影响 |
| --- | --- | --- |
| NUL 设备检测失败就进入"降级模式" | 启动时打开 `NUL`、检查 `null.sys` 与注册表；失败则 `disableHardwareAcceleration` + `disable-gpu` + `disable-software-rasterizer` | 可能关闭硬件加速或导致渲染能力降级；不能仅凭参数推断所有机器均为CPU渲染或确定严重度 |
| Windows 7 或用户设置关闭硬件加速 | `os.release().startsWith("6.1")` 或 `disableGPUAcceleration` | 影响重启后的渲染配置，性能与恢复行为需实测 |
| 托盘与提示窗轮询 | 托盘闪烁 500ms 定时器、提示窗每秒检查鼠标离开 | 常驻开销小，但说明大量用轮询代替事件 |
| 关窗只是隐藏 | 插件 README：关闭窗口可能只是隐藏到后台 | 用户以为退出，进程仍占内存 |

### macOS 特有

| 缺陷 | 证据 | 影响 |
| --- | --- | --- |
| x64 经 Rosetta 运行 | 插件实测：官方 1.2.12 为 x64 + Rosetta；官方代码里另有「架构引导窗口」(ArchGuideWindow) 引导用户下载其他架构渠道包 | 该x64样本在Apple Silicon上需转译；开销需与同版本arm64对照，不能外推所有发行渠道 |
| 内存压力 | 实测约 8–9 GB 压缩内存、2.2–2.8 GB swap，交互时目标渲染进程 CPU 峰值约 120% | 这是整机内存压力与目标renderer样本，不等于客户端独占8–9 GB压缩内存或证明泄漏 |
| BrowserView 挂载与后台节流问题 | 插件曾为 Mac 单独修补 IM 启动节流和 BrowserView 重挂载，后来按用户决定撤除 | 窗口切换、后台恢复时出现白屏或延迟 |

## 重构时怎么处理

| 现状 | 新客户端 |
| --- | --- |
| 站点隔离关闭、HTTP/2 关闭 | 使用系统 WebView 默认设置，不关任何隔离与协议 |
| GPU 降级模式 | WebView2 / WKWebView 由系统管理硬件加速，不在启动时做 NUL 检测这类判断 |
| 每账号一个 BrowserView | 按账号Profile创建/复用绑定视图，不能给一个存活WebView直接换Profile；按需上限/LRU，后台传输与UI独立 |
| Node侧IM/数据库/OCR职责分散且依赖重 | 按任务分工和有界队列隔离；IM传输WebView/Node仍在比较；OCR须先解决引擎与安装身份前提 |
| 本地 IM 页面（长任务严重） | 重写，消息列表虚拟化，输入框与列表渲染解耦，以"按键响应低于 100 ms"作为验收线 |
| 插件功能（翻译、套餐速览、订单查询）经 CDP 注入 | 作为新客户端的内置功能，经 IPC 调用，不再需要调试端口 |
| x64 / Rosetta | 原生 arm64 与 x64 双架构构建 |

## 后续证据与尚未完成的验证

- Windows页面、预加载与IM调用链已在模块文档补齐，不再以“尚无app.asar”作为开发前置；动态使用范围与Mac差异仍需验证。
- [Windows实机审查](reviews/2026-10-30-windows-adversarial-review.md)的27个客户端进程、双账号样本直接反驳“所有页面同一renderer”的绝对说法；样本也不证明泄漏或纯官方基线。
- 本项目不支持Windows 7/8.1；这是产品支持范围，不能泛称Tauri 2无兼容路径。见[Tauri安装文档](https://v2.tauri.app/distribute/windows-installer/)。
- 纯官方、官方+助手、新原型须在同机同负载、同页面/账号/预热条件对照，包含所有子进程；G0前不宣称性能收益已成立。
