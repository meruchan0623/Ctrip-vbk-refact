# 2026-10-31 官方桌面版与旅游商家助手静态对照

本记录来自本机只读文件、进程和脱敏日志检查；没有操作官方窗口、连接 CDP、改变登录态、修改安装或重新注入。主代理的界面取证另行记录。静态实现、部署完整性、实际界面运行分别判断。

## 当前官方安装与连接诊断

- 安装：`/Applications/旅游商家桌面版.app`；`CFBundleIdentifier=com.ctrip.vbooking`，`CFBundleExecutable=旅游商家桌面版`。可执行文件权限为 `-rwxr-xr-x`，架构为 x86_64。
- `codesign --verify --deep --strict --verbose=2` 返回成功，主程序及嵌套组件通过校验；存在 `com.apple.quarantine` 属性，未修改。现有证据不支持“缺执行权限或签名损坏”。
- `app.asar/package.json` 为 1.2.13；`~/Library/Application Support/vbk-electron/dist/packageVersion.json` 为 pkgVersion 1.2.6、aresVersion 1.2.5。包版本与用户目录热更新资源不能直接合并成一个版本结论。
- 观察期间主进程从 PID 14143 变为 15111，后者存在 GPU、Renderer 和 utility 子进程，进程状态 S。本调查未执行重启；进程存在不能证明消息窗口可交互。
- 主代理按准确应用路径和显示名称连接均遇到 `timeoutReached`；按 bundle ID 选择存在三份副本歧义。以上检查不能确定 AppleEvent/辅助功能连接超时根因，也没有证明卡在登录页或消息页。
- 最新官方日志：`~/Library/Logs/vbk-electron/main.log`。2026-10-31 02:02:51 记录 `update window initUpdateInfo {}`；`[ArchGuide] prefetch pkg url failed Unexpected non-whitespace character after JSON at position 1089`；LaunchWindow 控制台记录 `blocked require in renderer (no nodeIntegration): @ctrip/xtaro-h5/api/xCollectModuleInfo`。最近 120 行未发现当前 unresponsive 或崩溃证据；这些错误与 CUA 超时之间没有因果闭环。

安全启动方式是用准确路径 `open '/Applications/旅游商家桌面版.app'`，避免 bundle ID 多副本歧义。原客户端单实例锁会影响已有进程时的启动行为；若需重启，应先正常退出并确认退出完成，再用准确路径启动。不要为连接问题移除 quarantine、修改签名、杀掉所有同名副本或运行注入安装器。本调查未执行这些动作。直接可执行文件路径也已核实，但通过应用包启动更符合现有客户端入口。

## 插件部署证据与可用静态样本

- 回执：`/Applications/.tsim-injector-11bb1c77bbb67e858eae/receipt.json` 标记 `kind=trip-vendor-macos-injector-v1`、`state=installed`、`version=0.6.0`。
- 当前官方包缺少 `Contents/MacOS/TripVendorLauncher` 与 `Resources/companion/旅游商家助手.app`；主入口仍为官方可执行文件。相关进程列表中没有旅游商家助手、WindowHelper 或 companion。
- 插件安装脚本 `../trip_vendor_im_companion/scripts/lib/mac-pkg-installer.mjs:192–200` 会复制助手 App、Launcher、修改 asar 入口，并将 `CFBundleExecutable` 改为 `TripVendorLauncher`。因此现存回执不足以证明当前插件完整或正在运行；可能是官方覆盖安装后的残留，未推断具体覆盖历史。
- 可用样本：`/Users/tashima_meru/Develop/trip_vendor_im_companion/work/mac-inject/旅游商家桌面版.app`，其 MacOS 目录确有 `TripVendorLauncher`，Resources/companion 内有助手 App，plist 的 executable 为 Launcher。仅用作静态对照，未启动该副本。
- 源码：`/Users/tashima_meru/Develop/trip_vendor_im_companion`。该仓库 `AGENTS.md` 禁止代理直接修复、替换或重新注入官方安装；本调查遵守该限制。

## 插件行为与当前实现差距

证据入口：插件 `README.md`、`runtime/page/outbound-panel.ts`、`runtime/native-composer.ts`、`runtime/page/operator-overlay.ts`、`runtime/cdp-policy.ts`。当前项目入口：`vbk/ui/apps/main/main.ts`、`vbk/src-tauri/src/assistant.rs`、`vbk/src-tauri/src/assistant/service.rs`。

| 能力 | 插件静态实现 | 当前项目核查与对齐要求 |
| --- | --- | --- |
| 面板位置 | `#tsim-outbound-panel` 位于 `.im_detail.inform-con > .chat_area` 输入区上方；跟随当前会话 | 当前是自有消息界面与翻译栏；应对照官方消息面板完成布局和功能核查 |
| 自动翻译 | 停笔约 500ms；组合输入不请求；账号、会话、草稿变化使旧结果失效 | 已有翻译预览、版本绑定和发送状态机；真实输入法与会话切换仍需运行验证 |
| 语言 | 根据客户原文本地识别；16 种可选目标；手动选择和可持久化兜底，明确标注兜底 | 已有目标语言与语言建议；未找到等价的用户兜底语言设置与来源提示，需补齐 |
| 发送模式 | 默认普通 Enter 翻译后替换、读回、发送；替换模式保持原客户端 Enter 行为 | 已有替换/直接发送两模式；完整对齐应按已核实行为接入，保持可配置与可撤销，不另设方向审批 |
| 替换与撤销 | 按钮或 Mac `⌘⌥Enter` 替换；可撤销助手最近一次替换 | 已有替换；未找到等价撤销入口与快捷键完整链路，需补齐并绑定账号/会话/草稿 |
| 翻译控制 | 暂停/恢复、重试、复制、目标语言菜单、登录/退出 | 部分已有；仍需逐项检查可见入口及对应真实服务行为 |
| TSim 登录 | macOS 助手自己的受保护会话，不读取其它应用 Cookie | 当前宿主已实现真实 HTTP、系统钥匙串、会话恢复和刷新；不是仅 mock，也不是仍未接 HTTP |
| 订单查询 | 识别会话与右侧订单号，或手输标识；在客服页内打开 TSim 官方查询卡片；换客户/失效/退出即关闭 | 当前主要是 ICCID 套餐速览，不等于此官方查询浮层；未找到等价 operator/embed 接线，属明确功能差距 |
| 草稿安全 | 核验编辑器和上下文，旧结果不能写入新会话；直接发送有读回 | 当前有账号代次、草稿版本校验；撤销和新增查询能力也必须延续这些边界 |

没有把“源码里有”或历史 README 描述记为本机真实界面验收通过。插件当前部署不完整时，先用静态样本形成实现清单，再由主代理通过获准的 ego-browser/应用取证补齐动态证据。

## 本项目当前运行入口

- 已有包：`vbk/release/macos/VBooking 商家客户端.app`；只读检查时其 `vbk-host` 进程 PID 7441 正在运行。
- 已有调试二进制：`vbk/src-tauri/target/debug/vbk-host`；本地 `vbk/node_modules/.bin/tauri` 存在。
- 开发：在 `vbk/` 下运行 `npx tauri dev`。构建：`npx tauri build --target aarch64-apple-darwin --config src-tauri/tauri.macos.conf.json`。前置命令运行 `npm run bundle:ui`。
- `assistant::init` 已由 `src-tauri/src/lib.rs` 调用，注册登录、退出、翻译、套餐查询命令；宿主使用 reqwest 和系统凭据库。旧文档中“HTTP 尚未接线”的描述应由后续维护修正，不能沿用为当前代码事实。

本次仅新增本记录，未重新构建、启动或更改官方及插件安装。

## 同日实现补充：消息周边适配

`vbk/ui/packages/web-adapter/src/peripheral.ts` 新增 `getCustomerScripts`、`getInviteMemberListBySkillGroup`、`finishConversation`、`inviteVenAgent`、`transferVenMaster`。函数仅在显式调用时走注入的 SoaClient，测试使用 fake fetch，没有主动访问线上服务。RPC 注册与界面由集成任务负责；适配函数存在不等于已接到可见菜单。

- 候选请求使用真实会话 `gid` 和数值 `worksheetId`，可传上一层响应的数值 `parentSkillGroupIds`；无会话字段即 `unsupported`。
- finish 的 `conversationKey` 必须取自原始会话同名字段，不能用 gid 代替。旧 ConversationRowView 缺该字段时明确拒绝。
- invite 按实测提交字符串 `workSheetId` 与真实 `serviceType`；transfer 使用真实 `sessionId`、字符串 `groupId` 和明确选中的目标 uid。
- 写入成功只表示 `accepted` 且 `requiresReadBack=true`，不发出本地已结束/已转交事实。业务失败、传输未知结果分开，未知结果不重放。目标选择和身份代次校验留给宿主。
- 快捷话术文档只有空 `customerScripts` 响应，返回保留的 `unknown[]`，未编造可发送的 text/id 映射。非空响应的字段仍需补证。
- 5 项单元测试覆盖请求形状、缺字段零请求、业务失败、Ack 不足以成功及未知写入不重放；`npm run typecheck` 通过。本机 Node 22.14 需用 `node --experimental-strip-types --test ui/packages/web-adapter/src/peripheral.test.ts` 执行。
# 本文为重新布置环境前的历史调查；当前事实以 [环境重勘](2026-10-31-environment-resurvey.md) 为准，旧“载荷缺失”结论已经失效。
