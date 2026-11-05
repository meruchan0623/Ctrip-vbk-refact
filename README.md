# 旅游商家IM

旅游商家IM（仓库名 Ctrip-vbk-refact，工程代号 VBooking / vbk）是携程 VBooking 商家网页 IM 的桌面客户端，运行在 macOS 和 Windows 上。

它面向用携程商家后台接待客人的客服和运营人员。程序在隔离的 WebView 中打开官方网页并注入适配器，把消息与通知事实送进本地窗口，再加上网页没有的本地能力。

工程组成：Tauri 2 宿主（Rust）、仅依赖 `std` 的 Rust 核心 crate、运行时零依赖的 TypeScript 界面与网页适配器。

## 能做什么

- **消息与通知**：在本地窗口收发携程商家 IM 消息，显示未读。
- **订单联系入口**：订单详情 → IM 联系 → 网页会话，进入对应客人的会话。
- **强提醒**：会话超时未回复时，在独立提醒窗中逐级升级（L0–L4）。已读、打开会话、点击发送都不会结束等待，只有服务端确认的商家回复、会话结束或转出才清除。
- **新消息通知**：程序用自己绘制的置顶卡片窗显示，主窗隐藏时也能弹出。
- **多账号**：各账号的身份、网页登录态和提醒相互隔离。
- **托盘与勿扰**：关闭主窗后驻留托盘，托盘菜单提供勿扰，设置里可配勿扰时段。
- **商家助手**：TSim 查询、出站消息翻译、套餐速览。
- **浏览器登录态复用**：通过扩展复用 Chrome / Edge 中已登录的携程账号，见[接入说明](docs/integrations/2026-11-03-browser-bridge-login.md)。
- **诊断**：脱敏日志和数据目录入口。

## 范围

- 携程业务只保留消息、通知和订单联系入口。左侧栏的首页、工作台、事件、公告、商服、产品、数据、点评、完整订单管理等模块不提供，见[范围决定](docs/decisions/2026-10-30-web-only-scope.md)。
- 截图与标注已删除，见[决定记录](docs/decisions/2026-11-05-no-screenshot.md)。OCR 没有代码。
- 应用内更新尚未接通：更新窗只显示版本号，“检查更新”固定提示更新服务未配置，不发起网络请求。
- `vbk-electron/` 是被 git 忽略的官方客户端调查样本，不是本项目的实现。

## 当前状态

**代码落盘不等于验收。** G1–G5 运行验收尚未通过，单元测试通过不代表功能可用，也没有正式发布版本。

- **macOS**：最近的候选包是未签名、未安装、未发布的双架构构建（2026-11-04）。
- **Windows**：最后一次有记录的构建和实机运行是 2026-10-31 的候选包，当时整体验收未通过。此后的 Windows 原生改动没有实机运行记录，自绘标题栏也未在 Windows 上验收。
- **真实业务**：真实双向收发、媒体发送、强提醒、断线与睡眠恢复、安装与升级都仍缺运行证据。

当前断点以 [PROGRESS.md](PROGRESS.md) 和 [BLOCKED.md](BLOCKED.md) 为准。

## macOS 与 Windows 的差异

下表按当前代码核对，**写在表里不代表跑过**。有运行记录的只有以下几项，其余差异都没有实机验收记录：

- macOS：开机自启、勿扰时段、全屏检测读数、无授权时拒绝开启“跟随系统勿扰”，以及钥匙串登录恢复。
- Windows：2026-10-31 候选包的 NSIS 构建与启动。这个版本早于下表中的大部分 Windows 窗口代码。

### 窗口与系统集成

| 项目 | macOS | Windows |
| --- | --- | --- |
| 窗口控件 | 原生红绿灯，叠加式标题栏，隐藏原生标题文字 | 无原生标题栏，页面自绘最小化、最大化/还原、关闭按钮 |
| 标题栏交互 | 系统原生行为 | 双击拖动区最大化；右键拖动区弹出系统菜单；未实现 Snap Layouts 悬停面板 |
| 更新窗 | 可调整大小 | 固定尺寸，没有最大化按钮 |
| 应用菜单 | 未自定义，使用 Tauri 默认菜单栏（含退出等标准项） | 没有应用菜单 |
| 托盘闪烁（L1） | 菜单栏图标不闪，Dock 图标弹跳一次 | 通知区图标每 500 ms 隐/显一次，同时闪烁任务栏按钮 |
| 未读角标（L0） | Dock 角标 + 窗口标题 `(n)` | 只有窗口标题 `(n)`，任务栏没有覆盖图标 |
| 关闭后找回主窗 | 托盘或点击 Dock 图标 | 托盘 |
| 强提醒窗 | 跨所有桌面空间和全屏应用可见 | 跨桌面设置不生效；不进任务栏；关闭窗口阴影以保持直角红框 |
| 跟随系统勿扰 | 读取 `~/Library/DoNotDisturb/DB/Assertions.json`，需“完全磁盘访问权限”，只识别手动开启的专注模式 | 调用 `SHQueryUserNotificationState`，无需授权；能否读到专注助手状态尚未实测 |
| 全屏/演示检测 | 自行枚举窗口判断全屏；演示状态恒为否 | 同一系统调用同时给出全屏和演示状态 |
| 开机自启 | LaunchAgent | 注册表启动项（当前用户） |
| Deep link（`vbkdesk`） | 系统 URL 事件 | 启动参数，或由第二实例转发 |
| 文件访问授权 | 访问桌面、文稿、下载等目录时系统弹权限说明 | 没有对应提示 |

两端相同的部分：关闭主窗默认都隐藏到托盘，都可改成“退出程序”；托盘左键都显示主窗，右键都弹菜单；提醒声音都由 WebAudio 生成；新消息通知都走自绘 `notice` 窗，**两端都不使用系统通知中心**。

### 快捷键

| 项目 | macOS | Windows |
| --- | --- | --- |
| 右键菜单的快捷键提示 | `⌘C` 等 | `Ctrl+C` 等 |
| 发送键设为组合键时 | `Control` 或 `⌘` + Enter 都发送，输入框提示 `Ctrl/⌘+Enter`，设置项写作 `Ctrl+Enter` | `Ctrl` + Enter 发送；代码同样接受 `Win` + Enter，提示文案相同 |
| 全局快捷键（显示/隐藏工作台） | 默认 `Ctrl+Alt+V`，即 `Control+Option+V`，不是 `⌘` | 默认 `Ctrl+Alt+V` |

### 数据、凭据与内核

| 项目 | macOS | Windows |
| --- | --- | --- |
| WebView 内核 | WKWebView（系统自带） | WebView2；安装包内嵌引导程序 |
| 账号登录态隔离 | 按账号的 WebsiteDataStore，**需 macOS 14+**；低版本依赖库回退到默认存储 | 每账号独立的 WebView2 数据目录 |
| User-Agent | 账号网页统一伪装成 Chrome，否则官方页面提示改用 Chrome | 不改写，使用 WebView2 自身的值 |
| WebView 崩溃恢复 | WebContent 进程终止回调 | WebView2 进程失败事件 |
| 凭据存储 | 登录钥匙串 | 凭据管理器 |
| 凭据探测 | 只查元数据，不读取内容 | 读取内容判断是否存在 |
| 应用数据 | `~/Library/Application Support/tech.tsim.vbk.client/` | `%APPDATA%\tech.tsim.vbk.client\` |
| 账号网页数据 | `~/Library/WebKit/tech.tsim.vbk.client/WebsiteDataStore/<uuid>/` | `%APPDATA%\tech.tsim.vbk.client\profiles\p_*\` |
| 文件权限 | 敏感文件和目录设为 `0600` / `0700`，并校验 | 崩溃标记等继承用户目录 ACL；只有浏览器桥接目录用 `icacls` 收紧 |
| 字体 | PingFang SC 优先，等宽 SF Mono | Segoe UI Variable 优先，中文微软雅黑，等宽 Consolas |

凭据条目的服务名两端相同：`tech.tsim.vbk.client`（快速登录标记）和 `tech.tsim.vbk.client.tsim`（TSim 助手登录）。

### 浏览器登录态复用

| 项目 | macOS | Windows |
| --- | --- | --- |
| 桥接数据目录 | `~/Library/Application Support/VBK/browser-bridge/` | `%LOCALAPPDATA%\VBK\browser-bridge\` |
| Native messaging 注册 | 在 Chrome、Edge 的 `NativeMessagingHosts` 目录写入清单 | 在 `HKCU` 下为 Chrome、Edge 写注册表，无需管理员权限 |
| TSim“从浏览器登录” | 只读取 Chrome 配置 | 读取 Chrome 和 Edge 配置 |

两端的注册都只由开发脚本 `tools/browser-bridge-install.mjs` 完成。安装包不会注册桥接，扩展也要在浏览器开发者模式下手动加载。Windows 分支尚未完成真实浏览器验收。

### 打包、签名与更新

| 项目 | macOS | Windows |
| --- | --- | --- |
| 产物 | `.app` + `.dmg` | NSIS 安装包 |
| 安装方式 | 拖入“应用程序”文件夹 | 当前用户安装，无需管理员权限 |
| 架构 | arm64、x86_64，另有本地通用包脚本 | 只构建 x86_64 |
| 正式签名 | Developer ID + 公证，启用 Hardened Runtime，权限清单为空 | Authenticode（SHA-256，带时间戳） |
| 测试包 | 用共用测试证书签名，否则换包后钥匙串登录失效；Gatekeeper 仍会拦截 | 未签名 |

两端的正式签名都只写在 `.github/workflows/release.yml` 里，该流程**从未执行过**，也缺少证书。更新两端都未接通，没有平台差异。

## 安装与构建

目前没有对外发布的安装包，需要从源码构建。依赖 Node ≥ 22.18 和 Rust。macOS 还需要 Xcode 命令行工具，Windows 还需要 MSVC 工具链。宿主只能在目标系统上编译，不能交叉构建。

以下命令都在 `vbk/` 下执行。首次先安装依赖。

```bash
npm ci
```

**macOS**（Apple Silicon，Intel 把目标换成 `x86_64-apple-darwin`）：

```bash
npx tauri build --target aarch64-apple-darwin
```

产物在 `src-tauri/target/aarch64-apple-darwin/release/bundle/{macos,dmg}/`，未正式签名，只用于内部冒烟。

给测试人员的包要用共用测试证书打包，证书的生成与保管见 [vbk/README.md](vbk/README.md)：

```bash
tools/mac-dev-signing.sh build ~/secure/vbk-dev-signing.p12 --target aarch64-apple-darwin
```

本地通用包（只产出 `.app`，不签名）：

```bash
npm run build:macos:universal
```

**Windows**（在 Windows 机器上执行）：

```bash
npx tauri build --target x86_64-pc-windows-msvc
```

产物在 `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/`。`tauri.windows.conf.json` 由 Tauri 自动合并，无需手动指定。发布流程用的 `cargo tauri build` 需要另外执行 `cargo install tauri-cli`，`npm ci` 不会安装它。

**浏览器登录态复用**（开发安装，两端相同）：

```bash
cargo build --manifest-path src-tauri/Cargo.toml --bin vbk-browser-bridge
```

```bash
node tools/browser-bridge-install.mjs
```

之后按脚本输出的目录，在 `chrome://extensions` 或 `edge://extensions` 加载扩展。详见[扩展说明](vbk/browser-extension/README.md)。

## 工程结构

```
.
├─ vbk/
│  ├─ crates/             std-only Rust 核心，离线可测
│  │  ├─ contracts/       身份、事件信封、错误、IM 事实与 DTO
│  │  ├─ core-account/    账号身份、登录尝试、代次
│  │  ├─ core-store/      按身份隔离的持久状态
│  │  ├─ core-net/        端点策略、响应分类
│  │  ├─ core-im/         去重、同步水位、outbox、等待轮次
│  │  ├─ core-notify/     L0–L4 升级、alarm 快照
│  │  ├─ core-assistant/  TSim 请求构造与响应解析
│  │  ├─ core-transport/  传输监督状态机（尚未接入宿主）
│  │  ├─ core-diag/       脱敏日志
│  │  └─ core-update/     更新信任逻辑与 deep link 解析（宿主目前只用后者）
│  ├─ src-tauri/          Tauri 2 宿主，不在 workspace 内，独立 Cargo.toml 和 lockfile
│  ├─ ui/
│  │  ├─ apps/            窗口：main、alarm、notice、setting、login、update、package-detail、media-viewer
│  │  ├─ packages/        ipc、ui-kit、web-adapter
│  │  ├─ tests/           Playwright 冒烟
│  │  └─ tools/           打包脚本
│  ├─ browser-extension/  Chrome / Edge 登录态复用扩展
│  ├─ tests/scenarios/    跨 crate 场景测试
│  └─ tools/              安全门禁、发布扫描、签名与桥接安装脚本
├─ docs/                  设计文档、决定记录、接口证据、调查资料
├─ tools/                 接口证据脱敏与目录生成、桌面抓取
└─ .github/workflows/     vbk-check.yml（开发检查）、release.yml（发布，未执行过）
```

## 开发与文档

提交前的检查命令、跨文件同步规则和不变量见 [CLAUDE.md](CLAUDE.md)，工程细节见 [vbk/README.md](vbk/README.md)。最常用的检查：

```bash
npm run check
```

```bash
npm run gates
```

```bash
npm run bundle:ui && (cd src-tauri && cargo test)
```

主要文档入口：

| 文档 | 用途 |
| --- | --- |
| [开发总纲](docs/dev/00-architecture.md) | 架构、职责与实现边界；各模块设计在 `docs/dev/01`–`10` |
| [窗口与外壳](docs/dev/01-shell.md) | 窗口要素、Windows 实机验收清单 |
| [独立强提醒](docs/dev/03-strong-alert.md) | 等待轮次、独立窗口、恢复与验收 |
| [接口契约](docs/api/README.md) | 逐接口请求契约与开发准入 |
| [发布验收](docs/plan/05-release-validation.md) | G1–G5 的定义与发布范围 |
| [改进开发计划](docs/plan/2026-11-02-reverse-driven-improvement-plan.md) | 基于逆向结论的工作项与批次 |
| [Windows 接续](docs/integration/windows-handoff.md) | 在 Windows 上恢复环境与继续开发（2026-10-31 的快照） |

文档状态：`docs/dev/`、`docs/plan/` 是当前设计；`docs/research/`、`docs/observations/` 是调查事实，其中发现的接口不自动成为需求；`docs/reviews/` 是历史快照；[docs/archive/desktop-baseline](docs/archive/desktop-baseline/README.md) 只用于追溯。
