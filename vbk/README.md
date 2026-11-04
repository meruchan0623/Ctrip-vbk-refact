# vbk — VBooking 网页 IM 桌面客户端工程

Chrome 登录态复用见 [接入说明](../docs/integrations/2026-11-03-chrome-login.md)；订单 iframe、右下速览及 TSIM 配套发布依赖见 [查询接入](../docs/integrations/2026-11-03-tsim-iframe.md)。

按 [开发总纲](../docs/dev/00-architecture.md)、[总和开发计划](../docs/plan/00-master-development-plan.md) 与 [独立强提醒设计](../docs/dev/03-strong-alert.md) 落盘的工程。范围只含网页 IM（消息、通知、订单“详情 → IM 联系”）和本项目自有能力（多账号、托盘、独立 alarm 窗、商家助手、截图/OCR、更新与诊断）。

## 结构

```
vbk/
├─ Cargo.toml                 Rust workspace（std-only 核心 crate）
├─ crates/
│  ├─ contracts/              身份、事件信封、错误、IM 事实、alarm DTO、最小 JSON（单写者：集成 owner）
│  ├─ core-account/           身份 actor、登录 attempt、session_generation 与迟到回调拒绝
│  ├─ core-store/             按身份隔离的最小持久状态（提醒 round、发送意图、同步水位）
│  ├─ core-net/               端点策略登记、SOA 响应分类、ClockService、对账信号
│  ├─ core-im/                跨来源去重、同步水位、SendIntent/outbox、等待轮次
│  ├─ core-notify/            L0–L4 升级、稍后提醒、勿扰、alarm 快照
│  └─ core-assistant/         TSim 身份/出站翻译/套餐速览客户端（请求构造与响应解析）
├─ src-tauri/                 Tauri 2 宿主（独立包；需 Windows/WebView2 或 macOS/WKWebView + crate 注册表）
└─ ui/
   ├─ packages/ipc/           contracts.ts（Rust 镜像）、命令/事件名、invoke/listen 薄封装
   ├─ packages/web-adapter/   网页 Web IM SDK/HTTP 契约适配：有界事实事件、轮询、补偿、上传签名
   ├─ packages/ui-kit/        无依赖 DOM 渲染与状态工具
   └─ apps/{main,alarm,setting}/  各窗口入口
```

## 本地检查

本仓库的云检查环境没有 crate 注册表、npm 注册表与 WebView2，因此：

- Rust 核心 crate 只用 `std`；`cargo test` 在 `vbk/` 下直接可跑。
- 前端运行时代码不引第三方依赖；TypeScript、Node 类型和 Tauri CLI 是锁定版本的开发依赖。先在 `vbk/` 执行 `npm ci`，再用项目内 `tsc` 做类型检查；`node --test` 直接运行 `.ts` 测试（Node ≥ 22.18）。
- `src-tauri/` 被排除在 workspace 之外，在 Windows 目标机上用 `cargo tauri build` 构建。

```bash
cd vbk && cargo test
```

```bash
cd vbk && npm run typecheck && npm test
```

## macOS 构建

需要一台装有 Xcode 命令行工具、Node ≥ 22.18 与 Rust 的 Mac（Linux 云环境无法交叉构建：缺 macOS SDK 与 WKWebView）。在 `vbk/` 下：

```bash
npm ci
```

```bash
npx tauri build --target aarch64-apple-darwin
```

`tauri build` 会先执行 `npm run bundle:ui` 组装 `ui/bundle`（Tauri 的 `frontendDist`），产物在 `src-tauri/target/aarch64-apple-darwin/release/bundle/{macos,dmg}/`。Intel Mac 用 `x86_64-apple-darwin`。产物未签名、未公证，只能内部冒烟；对外分发需 Developer ID 签名与公证（REL 任务）。CI 的 `macos-bundle` 任务会产出同样的未签名 dmg。

给测试人员安装的包必须用组内共用的测试签名身份打包，否则每次构建的签名身份都会变（ad-hoc 签名的代码标识是 `vbk_host-<hash>`）。钥匙串里的快速登录标记和 TSim 助手登录绑定在签名上，签名一变，装完新包就会掉登录。证书全组只生成一次，保存在仓库之外，CI 通过 secret `MAC_DEV_CERTIFICATE` 和 `MAC_DEV_CERTIFICATE_PASSWORD` 使用同一张：

```bash
tools/mac-dev-signing.sh create ~/secure/vbk-dev-signing.p12
```

```bash
tools/mac-dev-signing.sh build ~/secure/vbk-dev-signing.p12 --target aarch64-apple-darwin
```

打包后用 `codesign -dr -` 检查，结果应为 `identifier "tech.tsim.vbk.client" and certificate leaf = H"…"`。

用户数据位置（只由 bundle identifier 决定，与版本号和安装位置无关）：

| 数据 | macOS | Windows |
| --- | --- | --- |
| 账号索引、偏好、状态、日志 | `~/Library/Application Support/tech.tsim.vbk.client/` | `%APPDATA%\tech.tsim.vbk.client\` |
| 各账号网页登录态（Cookie） | `~/Library/WebKit/tech.tsim.vbk.client/WebsiteDataStore/<uuid>/` | `%APPDATA%\tech.tsim.vbk.client\profiles\p_*\` |
| 快速登录标记 / TSim 助手登录 | 登录钥匙串 `tech.tsim.vbk.client` / `tech.tsim.vbk.client.tsim` | 凭据管理器，同名 |

启动日志 `logs/vbk.log` 会记录数据目录、账号索引的加载结果、每个账号的恢复结果（`resuming saved profile … (web data present|missing)`、`not resumed at startup (…)`、`quick-login marker missing`），以及保存的会话是被接受（`saved web session accepted`）还是被拒（`fell back to login`）。

平台差异（`cfg(target_os = "macos")`）：

| 行为 | Windows | macOS |
| --- | --- | --- |
| L1 闪烁 | 托盘图标 500 ms 隐/显 + 任务栏闪烁 | 不闪菜单栏图标（会挤动其他图标），Dock 图标弹跳一次（`Informational`） |
| L0 未读数 | 窗口标题 `(n)`（覆盖图标待 NTF-04） | Dock 角标 + 窗口标题 |
| alarm 窗 | 置顶、不激活、不进任务栏 | 置顶、不激活，并在所有桌面空间与全屏应用上可见 |
| 关闭主窗口后找回 | 托盘左键 | 托盘或点击 Dock 图标（`RunEvent::Reopen`） |
| 截图发送 | 暂未实现：输入框不显示截图按钮、设置页不显示截图快捷键，也不注册该全局热键（`shell::SCREENSHOT_SUPPORTED`） | 截图按钮 + 全局快捷键 |
| 打包 | NSIS（当前用户安装） | `.app` + `.dmg`（`tauri.macos.conf.json`，`icons/icon.icns`） |

macOS 上 alarm 显示时是否会夺走键盘焦点、锁屏/睡眠行为，仍需按[强提醒设计](../docs/dev/03-strong-alert.md) §7 在 Mac 上实测；未实测前不宣称 macOS 支持。

## 不变量（所有模块共同遵守）

1. 身份不随界面漂移：`AccountContext{account_id,environment,session_generation}`；旧代次回调一律拒绝。
2. 外发不是普通重试：`confirmed/rejected/unknown` 分开；`unknown` 持久保留并对账，不盲目重发。
3. 可见最新不等于完整：页断点与完整水位分离；只有证实终止条件才推进完整水位。
4. 提醒消费事实：已读、打开会话、点击发送、发送中、结果未知都不能结束等待轮次；只有服务端确认的有效商家回复、会话结束或转出才清除。
5. 持久化先于成功事件；先订阅缓冲再取快照重放；跳号/换 epoch 必须重新握手。
6. 远程页面无通用本机权限；日志与提醒数据不含凭据与客户正文。

## 2026-10-30 落盘状态

| 检查 | 结果 |
| --- | --- |
| `cargo test --workspace`（contracts、6 个核心 crate、tests/scenarios） | 297 通过，0 失败 |
| `cargo clippy --workspace --all-targets` | 0 警告 |
| `tsc -p tsconfig.json` | 无错误 |
| `node --test "ui/**/*.test.ts"`（ipc、ui-kit、web-adapter、apps 视图模型） | 148 通过 |
| `node ui/tests/smoke/run.mjs`（Playwright/Chromium，含截图） | 211 项通过 |
| `src-tauri`（Tauri 2 宿主） | 仅 `rustfmt` 语法级检查；`cargo check` 在 CI 的 Windows 与 macOS runner 上执行，本地需对应系统 + crate 注册表 |
| `node ui/tools/bundle.mjs`（Tauri 嵌入的 `ui/bundle`） | 4 个窗口入口的全部引用可解析；单独托管时 Chromium 渲染无 404/报错 |

对抗性审查记录（含已修正的 P1/P2 与未修正项）：

- Rust 核心与跨模块场景：[tests/scenarios/REVIEW-2026-10-30.md](tests/scenarios/REVIEW-2026-10-30.md)
- 网页适配器：[ui/packages/web-adapter/REVIEW-2026-10-30.md](ui/packages/web-adapter/REVIEW-2026-10-30.md)
- 界面：[ui/apps/REVIEW-2026-10-30.md](ui/apps/REVIEW-2026-10-30.md)

### 尚未完成 / 不作承诺

- 代码落盘不等于 G1–G5 运行验收：官方登录页在隔离 Profile 中的接入、Web IM SDK 在宿主内的事件连续性、受控收发/撤回、断线与睡眠恢复、安装与更新均未在目标机验证。
- 宿主侧占位：系统 Toast、音频播放、截图/OCR、更新与诊断包、维护屏障（退出/更新排空）仅留有接缝或事件，按 NTF-05 / MED / REL 任务补齐。
- 适配器中的未闭环项（U01–U10）与 UI 契约建议（C-01–C-05）见各自审查记录；`ConversationFact.unread_count` 在列表接口缺字段时为 0 占位。
- 前端以零依赖 TypeScript 落盘（云检查环境无 npm 注册表）；引入 Vite/React 时按 `tsconfig.build.json` 的 ES 模块输出迁移即可。
