# vbk — VBooking 网页 IM 桌面客户端工程

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
- TypeScript 不引第三方依赖；`tsc`（全局 6.x）做类型检查，`node --test` 直接运行 `.ts` 测试（Node ≥ 22.18 的类型擦除）。
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
npm install --no-save typescript@6 @types/node@22 @tauri-apps/cli@2
```

```bash
npx tauri build --target aarch64-apple-darwin
```

`tauri build` 会先执行 `npm run bundle:ui` 组装 `ui/bundle`（Tauri 的 `frontendDist`），产物在 `src-tauri/target/aarch64-apple-darwin/release/bundle/{macos,dmg}/`。Intel Mac 用 `x86_64-apple-darwin`。产物未签名、未公证，只能内部冒烟；对外分发需 Developer ID 签名与公证（REL 任务）。CI 的 `macos-bundle` 任务会产出同样的未签名 dmg。

平台差异（`cfg(target_os = "macos")`）：

| 行为 | Windows | macOS |
| --- | --- | --- |
| L1 闪烁 | 托盘图标 500 ms 隐/显 + 任务栏闪烁 | 不闪菜单栏图标（会挤动其他图标），Dock 图标弹跳一次（`Informational`） |
| L0 未读数 | 窗口标题 `(n)`（覆盖图标待 NTF-04） | Dock 角标 + 窗口标题 |
| alarm 窗 | 置顶、不激活、不进任务栏 | 置顶、不激活，并在所有桌面空间与全屏应用上可见 |
| 关闭主窗口后找回 | 托盘左键 | 托盘或点击 Dock 图标（`RunEvent::Reopen`） |
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
