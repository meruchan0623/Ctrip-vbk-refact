# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目定位

VBooking（携程）商家网页 IM 的桌面客户端重构，工程在 `vbk/`：Tauri 2 宿主 + 仅依赖 `std` 的 Rust 核心 crate + 运行时零依赖的 TypeScript 界面与适配器。

- **范围**：携程业务只保留消息、通知、订单“详情 → IM 联系 → 网页会话”入口；左侧栏其他业务模块不做（见 `docs/decisions/2026-10-30-web-only-scope.md`）。自有能力保留：多账号、托盘、独立强提醒窗、商家助手（TSim/出站翻译/套餐速览）、截图/OCR、更新与诊断。
- **`vbk-electron/`** 是被 git 忽略的官方客户端调查样本，不是实现，不要修改或当作代码基准。
- **代码落盘不等于验收**：G1–G5 运行验收是独立关口。汇报时不要把单测通过说成功能已验收，当前断点见 `PROGRESS.md`、`BLOCKED.md`。

## 常用命令

以下命令除特别说明外都在 `vbk/` 下执行。需要 Node ≥ 22.18，首次先 `npm ci`。

```bash
npm run typecheck                 # tsc
npm test                          # ui/**/*.test.ts + 门禁自测（node --test 直接运行 .ts）
npm run gates                     # 源码安全门禁：夹具自测 + 真实源码树（--self-test / --tree 只跑一半）
cargo test --workspace            # std-only 核心 crate + tests/scenarios
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all --check
npm run check                     # typecheck + npm test + cargo test
npm run smoke:ui                  # Playwright 冒烟；playwright 不在 devDependencies，需另行提供（npm i --no-save playwright@1）
npm run bundle:ui                 # 编译 TS 并组装 ui/bundle（Tauri 的 frontendDist）
```

`npm run check` 不含门禁、冒烟、clippy、fmt 和宿主测试，CI（`.github/workflows/vbk-check.yml`）这些都会跑。提交前按改动范围补跑。

宿主 `src-tauri/` 不在 workspace 内，有独立的 `Cargo.toml` 和 lockfile，只能在 macOS / Windows 上编译。`generate_context!` 会嵌入 `ui/bundle`，因此要先组装：

```bash
npm run bundle:ui && (cd src-tauri && cargo test)
```

```bash
npx tauri build --target aarch64-apple-darwin
```

给测试人员的 macOS 包要用共用测试签名打包，否则换包后钥匙串登录会失效（`tools/mac-dev-signing.sh`，用法见 `vbk/README.md`）。

单个测试：

```bash
node --test ui/apps/main/draft-book.test.ts
```

```bash
node --test --test-name-pattern="关键字" ui/apps/main/draft-book.test.ts
```

```bash
cargo test -p core-im --test strong_alert
```

```bash
cargo test -p core-im unknown_send
```

`npm test` 的 glob 不覆盖 `browser-extension/*.test.mjs` 和 `tools/release-scan.test.mjs`，改到这些文件时要单独用 `node --test` 运行。

## 架构

```
官方网页（acct-* WebView）+ 注入的 web-adapter
        │ 仅 adapter_* 窄命令，推送有界结构化事实
        ▼
src-tauri 宿主：校验来源/身份/代次 → crates/core-* 纯逻辑 → 持久化 → 事件
        │ 按窗口授权的 IPC
        ▼
本地窗口 ui/apps/{main,alarm,setting,login,update,package-detail}
```

- **`crates/`**：不碰 UI、网络库和第三方依赖，所以离线可测。`contracts` 定义身份、事件信封、错误、IM 事实与 DTO；`core-im` 负责去重、同步水位、outbox、等待轮次；`core-notify` 负责 L0–L4 升级、alarm 快照；其余见 `vbk/README.md`。需要跨 crate 串联的反例放 `tests/scenarios`。
- **`src-tauri/src/`**：窗口、托盘、调度、HTTP（`reqwest`）、钥匙串等平台能力。`adapter.rs` 是网页适配器的入口，`views.rs` 定义各窗口角色的命令表，`assistant/` 是 TSim 相关，`features/` 是草稿、队列、撤回、正在输入。
- **`ui/packages/web-adapter`**：注入官方页面运行，由 `ui/tools/bundle-adapter.mjs` 打成单文件 `bundle/adapter/boot.js`。业务字段的大小写、鉴权和权限语义要与网页保持一致，依据是 `docs/api/`。
- **`ui/packages/ipc`**：`contracts.ts` 是 Rust 契约的 TS 镜像，`mock.ts` 供测试和冒烟使用（发布包不含 mock）。
- **`browser-extension/` + `src-tauri/src/bin/vbk-browser-bridge.rs`**：Chrome 登录态复用，见 `docs/integrations/2026-11-03-chrome-login.md`。

### 跨文件必须同步的改动

- **新增或修改宿主命令**要同时改：`src-tauri/commands.txt`、`src/lib.rs` 的 `generate_handler!`、`src/views.rs` 的角色命令表、`capabilities/*.json`、`ui/packages/ipc/src/{commands,client,adapterProtocol}.ts` 中对应的一处。`ui/apps/_shared/contract-consistency.test.ts` 和 `tools/gates/capability-matrix.mjs` 会检查一致性。
- **共享结构不兼容变更**：同时修改 `crates/contracts` 和 `contracts.ts`，并在两边递增 `CONTRACT_VERSION`（`crates/contracts/src/version.rs`）。版本不一致时，宿主会拒绝该窗口的全部命令。
- **CSP、DOM sink、启动参数、TLS/调试开关**受 `tools/gates/` 约束，其中的快照和 allowlist 是有意的安全决定。门禁报错时先修代码，不要直接放宽清单。

## 不变量

违反这些规则的改动即使测试通过也是错的：

1. 身份不随界面漂移：回调必须带 `AccountContext{account_id,environment,session_generation}`，旧代次一律拒绝。
2. 外发不是普通重试：`confirmed/rejected/unknown` 分开处理；`unknown` 持久保留并对账，绝不盲目重发。
3. 可见最新不等于完整：页断点和完整水位分离，只有证实终止条件才推进完整水位。
4. 提醒消费事实：已读、打开会话、点击发送、发送中、结果未知都不结束等待轮次；只有服务端确认的有效商家回复、会话结束或转出才清除。
5. 持久化先于成功事件；先订阅缓冲再取快照重放；跳号或换 epoch 必须重新握手。
6. 远程页面没有通用本机权限：官方登录页、订单页、TSim 查询窗都不进 capability；`acct-*` 只有窄 `adapter_*` 命令，且宿主按 WebView 标签核对身份，不信任页面自报。日志和提醒数据不含凭据与客户正文；例外是 `alarm`、`notice` 窗的消息预览，由宿主从内存展示缓存附加并定向发给这两个本地窗口，不进 `core-notify`、持久化和日志（见 `docs/dev/03-strong-alert.md` 第 6 节）。
7. 界面文案不得以中文字面量写在逻辑代码里：所有展示文案必须进字符串目录，文件名只能是 `strings.ts`（窗口或模块本地目录）或 `ui-kit/src/i18n.ts`（共享目录），经 `t()` 或目录常量引用。`cjk-literals` 门禁（`node tools/gates/run.mjs`，`npm run gates:cjk` 只跑树扫描）默认强制，测试里的 `expectNoCjkLiterals` 同样强制；协议字段名等例外只能登记在 `tools/gates/cjk-protocols.mjs`。目录条目必须被引用，无用条目要删除而不是放宽测试。

## 文档与证据

中文文档是设计依据，改行为前先读对应模块：`docs/dev/00-architecture.md` 是总纲，`docs/dev/01`–`10` 按模块分工。

- `docs/dev/`、`docs/plan/` 是当前设计；`docs/research/`、`docs/observations/` 是调查事实，其中发现的接口不自动成为需求；`docs/reviews/` 是历史快照；`docs/archive/` 只用于追溯。
- `vbk/README.md` 中的测试数量和“落盘状态”是当时的快照，以实际运行结果为准。
- `tools/contracts/`（在仓库根目录运行）用于接口证据的脱敏与目录生成，不批量重放业务写请求。入库证据只保留脱敏结构，不得包含 Cookie、票据、客户标识或消息正文。
- 涉及真实账号的实机验证遵守 `PROGRESS.md` / `BLOCKED.md` 记录的授权边界；忙账号禁止代理执行任何出站操作，包括发送、上传、转交、结束会话和触发已读。

## 提交约定

提交信息用 Conventional Commits 前缀，描述写中文，常见 scope 有 `host`、`ui`、`adapter`、`gates`，例如 `fix(host): 升级时保留账号索引、偏好与 WebView 登录态`。
