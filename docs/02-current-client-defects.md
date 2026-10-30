# 现有客户端缺陷分析与 Electron 去留

2026-10-30

## 结论：彻底弃用 Electron，且本地 IM 界面要重写，不能原样搬

决定彻底弃用 Electron，Tauri 2 + Rust 方案维持不变，但要修正复用范围：

- **远程加载的 vbooking 业务页**（订单、产品、点评、BI 等，在官方客户端里用 BrowserView 加载线上页面）：继续原样复用。
- **打包在本地的窗口**（IM、登录、首页、通知、AI、截图等，位于 `dist/` 下）：重写。其中 IM 是商家每天用得最多、也最卡的部分，必须优先重写。

卡顿来自三层叠加：Electron 运行时与启动参数、主进程架构、官方页面自身的长任务。前两层换掉 Electron 就会消失；第三层跟着页面走，页面不重写，问题就会原样带进新壳。

## 先更正：哪些是官方的，哪些是插件的

上传的两个安装包都已经装过「旅游商家助手」（[trip_vendor_im_companion](https://github.com/meruchan0623/trip_vendor_im_companion)）的注入包，下面这些属于插件，不属于携程官方：

| 组件 | 归属 |
| --- | --- |
| macOS `TripVendorLauncher`（Swift 启动器）、`Resources/companion/` | 插件的 Mac 注入安装器 |
| Windows `app.asar` 入口 `trip-vendor-bootstrap.cjs`、`companion-vendor-original-main.json` | 插件的 Windows 资源注入 |
| `--remote-debugging-port` 与 CDP 页面注入 | 插件用来挂翻译面板、套餐速览、订单查询 |

官方入口是 `dist-electron/main/index.js`。[01 架构选型](01-architecture-selection.md) 里把启动器和 CDP 当作官方架构的说法已经作废。

## 官方客户端的缺陷

证据来自两处：`vbk-electron/resources/app.asar`（Windows 版 1.2.12）主进程代码，以及插件仓库 [卡顿修复计划](https://github.com/meruchan0623/trip_vendor_im_companion/blob/main/docs/2026-10-28-tsim-client-performance-and-translation-fix-plan.md) 中的实测数据。

### 两端共有

| 缺陷 | 证据 | 影响 |
| --- | --- | --- |
| 关闭站点隔离 | 无条件 `disable-site-isolation-trials` | 所有页面和 iframe 挤在同一个渲染进程，任一页面的长任务都会拖住整个界面；插件文档也记录了 TSim 查询页与客服页共享渲染进程 |
| 关闭 HTTP/2 | 无条件 `disable-http2`，再加 `ignore-connections-limit` 放开携程域名的连接数 | 资源加载退回 HTTP/1.1，页面打开慢 |
| 关闭 Web 安全 | 7 处 `webSecurity:false`（BrowserView 等） | 跨域与混合内容不受限，属于安全隐患 |
| 每个账号一套 BrowserView + 持久分区 | `new BrowserView({partition:"persist:"+账号})` | 多账号登录时内存成倍增长 |
| 主进程负担重 | IM SDK、better-sqlite3、OCR（paddleocr + onnxruntime）、拼写检查、截图都在 Node 侧 | 主进程忙时窗口与 IPC 响应变慢 |
| 包体臃肿 | `app.asar` 约 351 MB，内含 617 个 node_modules 包（约 479 MB 解开后），生产依赖里带着 `heapdump` | 安装、更新、冷启动都慢 |
| 官方页面自身长任务 | 实测 123 秒内 130 个长任务，合计约 26.9 秒，最长 1.8 秒；按键事件最长约 3.08 秒；React 提交约 1.47 秒；官方 `bn-pf` 单次约 2.59 秒 | 输入、复制、滚动、切会话卡顿；这一层换壳解决不了，必须重写页面 |
| 运行时过旧 | Electron 27.3.11 / Chromium 118 | 已停止安全更新 |

### Windows 特有

| 缺陷 | 证据 | 影响 |
| --- | --- | --- |
| NUL 设备检测失败就进入"降级模式" | 启动时打开 `NUL`、检查 `null.sys` 与注册表；失败则 `disableHardwareAcceleration` + `disable-gpu` + `disable-software-rasterizer` | 部分装了安全软件或被策略收紧的机器会全程 CPU 渲染，极卡 |
| Windows 7 或用户设置关闭硬件加速 | `os.release().startsWith("6.1")` 或 `disableGPUAcceleration` | 同上；该设置一旦打开不会自动恢复 |
| 托盘与提示窗轮询 | 托盘闪烁 500ms 定时器、提示窗每秒检查鼠标离开 | 常驻开销小，但说明大量用轮询代替事件 |
| 关窗只是隐藏 | 插件 README：关闭窗口可能只是隐藏到后台 | 用户以为退出，进程仍占内存 |

### macOS 特有

| 缺陷 | 证据 | 影响 |
| --- | --- | --- |
| x64 经 Rosetta 运行 | 插件实测：官方 1.2.12 为 x64 + Rosetta；官方代码里另有「架构引导窗口」(ArchGuideWindow) 引导用户下载其他架构渠道包 | Apple Silicon 上 CPU 开销与启动时间明显变差，且需用户手动换包 |
| 内存压力 | 实测约 8–9 GB 压缩内存、2.2–2.8 GB swap，交互时目标渲染进程 CPU 峰值约 120% | 多账号、多 BrowserView 叠加后整机变慢 |
| BrowserView 挂载与后台节流问题 | 插件曾为 Mac 单独修补 IM 启动节流和 BrowserView 重挂载，后来按用户决定撤除 | 窗口切换、后台恢复时出现白屏或延迟 |

## 重构时怎么处理

| 现状 | 新客户端 |
| --- | --- |
| 站点隔离关闭、HTTP/2 关闭 | 使用系统 WebView 默认设置，不关任何隔离与协议 |
| GPU 降级模式 | WebView2 / WKWebView 由系统管理硬件加速，不在启动时做 NUL 检测这类判断 |
| 每账号一个 BrowserView | 账号切换复用一个 WebView，按需创建并设上限，后台账号只保留长连接 |
| IM SDK、sqlite、OCR 在 Node 主进程 | 放进 Rust 核心的独立任务；OCR 视需要作为可选组件 |
| 本地 IM 页面（长任务严重） | 重写，消息列表虚拟化，输入框与列表渲染解耦，以"按键响应低于 100 ms"作为验收线 |
| 插件功能（翻译、套餐速览、订单查询）经 CDP 注入 | 作为新客户端的内置功能，经 IPC 调用，不再需要调试端口 |
| x64 / Rosetta | 原生 arm64 与 x64 双架构构建 |

## 仍待确认

- `dist/` 中本地页面的完整清单，以及哪些窗口加载远程页面、哪些是本地页面。上传的 `app.asar.unpacked` 只有 13 MB，可能尚未传完。
- 页面对 Electron 预加载脚本（`preload/web.js`、`preload/im.js`）暴露 API 的依赖程度，这决定远程业务页搬进 Tauri 时要实现多少兼容接口。
- 是否需要支持 Windows 7。官方代码仍有 Win7 分支，但 Electron 27 和 Tauri 2 都已不支持。
