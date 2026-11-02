# 目标定位 vs 当前 vbk/ 实现差距盘点（2026-11-01）

> 只读分析报告。基线：`main` @ `a34a007`。证据标注：**[事实]** 已用命令或文件验证；**[推断]** 由证据推出但未运行验证；**[未知]** 当前无证据。
> 原始日志：`~/tools/rea-work/gap/*.log`（cargo-test / npmtest / typecheck / tauri-check / tauri-test / rea-*）。

执行说明：本次全部命令均在 10 分钟内完成，无「未完成」项；未修改任何代码、未提交 git。唯一写入为本报告与 `~/tools/rea-work/gap/` 下的日志/JSON。

## 0. 结论摘要

- **代码规模** [事实]：Rust 核心 18.6k 行 + 场景测试 4.7k 行；Tauri 宿主 19.2k 行（69 条命令、7 个 capability）；TS UI 源码 15.5k 行 + 测试 10.4k 行。
- **离线门禁** [事实]：`cargo test --workspace` 321/321，`tsc` 0 错误，`node --test` 751/751；`src-tauri` `cargo check` 通过（1 条 dead_code 警告），**`src-tauri` 测试在 macOS 上 192/195**（3 个失败是 TMPDIR 符号链接导致的夹具问题，换 TMPDIR 后 12/12 通过）。
- **验收状态** [事实]：没有任何关口（G1–G5）整体通过。已有实机读回的只有：账号恢复、双账号同进程、受控文本单条收发、TSim 订单套餐/详情（Windows）、服务端校时、分页保持（2 次样本）。独立强提醒、媒体发送、出站翻译、托盘/Dock、安装升级均 **0 次实机**。
- **未实现** [事实]：客户端更新、截图标注、OCR、中文纠错、图片/视频查看器、全局快捷键、开机自启、深链、诊断包导出、崩溃恢复；Windows 截图；macOS TSim 浏览器会话复用。
- **产物** [事实]：最新 macOS `.app` 19 MB / `.dmg` 7.0 MiB（官方 Mac 744 MB，`app.asar` 364 MB），arm64、**adhoc 签名、无 hardened runtime、无 cargo-auditable 元数据**；官方为 Developer ID 签名 x86_64。
- **最大差距**：消息实时可靠性与列表计数一致性（P0）、强提醒零实机（P0）、历史分页仍需复验（P0）、发布链路（签名/更新/安装）整体缺失（P1）、媒体工具组整体未开始（P1–P3）。

## 1. 目标定位（从文档提炼）

### 1.1 范围三分法 [事实]

| 类别 | 内容 | 证据 |
| --- | --- | --- |
| 保留的携程业务（以网页为基准） | 消息（会话列表/历史/收发/已读/置顶/颜色标记/成员/转接/结束）、通知（分类/列表/标读、横幅/提示音/标题闪烁/浏览器通知）、订单最小入口（完整订单号查询 → 核对 → 「IM 联系」→ `14361/createimchat` → 网页会话），外加「网页高级操作」用内置 WebView 打开订单详情页 | `docs/decisions/2026-10-30-web-only-scope.md:9-12,20-21`；`docs/dev/04-business-pages.md:5-14` |
| 删除的携程业务 | 首页、工作台、事件、公告、商服、产品、数据(BI)、点评、完整订单管理（确认/退款/核销/导出），含菜单墙、角标、业务页承载与桥接；「特别关注」分类与右键分类声音不实现 | `web-only-scope.md:10,28-29`；`docs/plan/00-master-development-plan.md:24-26` |
| 本项目自有能力（不以网页是否有为前提） | 多账号（每账号独立 Profile/凭据，标题栏标签，三种退出）、托盘与任务栏未读/闪烁、独立回复超时强提醒 alarm 窗（L0–L4，T1 默认 30s，5/10/30 分钟稍后提醒）、商家助手（TSim 登录、出站翻译固定 TSim、入站翻译固定平台、套餐速览 60s 复用、订单查询面板）、截图/OCR/中文纠错、客户端更新（签名包）、本地诊断与偏好 | `web-only-scope.md:12`；`docs/dev/01-shell.md:5-9`；`docs/dev/02-account-login.md:7-12`；`docs/dev/03-strong-alert.md:13-31`；`docs/dev/07-media.md:5-7`；`docs/dev/08-update-telemetry.md:5-7`；`docs/dev/09-assistant.md:7-15` |
| 后端/运行必需 | 登录鉴权（直接复用官方 `ivbk/accountV2/login` 网页，不自建密码表单）、身份隔离与 `session_generation`、消息传输（官方页面内 Web SDK：XMPP over WSS + HTTP 补偿）与补偿、发送状态与 unknown 恢复、本地存储、网络与凭据 | `web-only-scope.md:13`；`docs/decisions/2026-10-30-im-transport.md:5-7`；`02-account-login.md:5` |
| 明确不排期 | 桌面 Node SDK sidecar、原生协议重写；旧 Electron 库导入、全文检索、全量备份/恢复产品流程 | `im-transport.md:5`；`docs/dev/05-store.md:11` |

关键架构约束 [事实]：IM 传输不自研，**跑在每账号隔离的官方页面 WebView 内**，通过 `adapter_*` 命令把事实推给 Rust 核心（`vbk/src-tauri/src/lib.rs:4-6`；`capabilities/adapter.json` 的 `remote.urls` 仅 `vbooking.ctrip.com`、`imvendor.ctrip.com`）。这意味着「消息可靠性」上限受官方网页 SDK 与页面生命周期约束。

### 1.2 G0–G5 验收关口 [事实]

来源：`docs/plan/00-master-development-plan.md:11,1511-1529`。

| 关口 | 含义 | 冻结/交付时必须具备 |
| --- | --- | --- |
| G0 | 接口契约准入：所有必要接口的 Header/Auth/方法/Query/嵌套 Body/动态字段来源齐备后才开发 | `docs/api/README.md` + `docs/api/readiness.md`；仍有 9 类未闭环边界（`readiness.md:29-35`） |
| G1 | 身份与账号（Account+Net+Store） | 目标 Runtime 登录、两账号隔离、恢复与失效的实际证据 |
| G2 | 宿主与入口安全（Shell+Biz） | 声明入口、安全配置、导航/下载/崩溃恢复/脏页保护 |
| G3 | IM 与客服操作（IM+OPS） | 选定路线的实际收发/确认/后台恢复/受控业务写入矩阵 |
| G4 | 发布与系统能力（Release+Shell+Media） | 正式产物、普通用户、Runtime/通知/深链/监视器、OCR 路线 |
| G5 | 数据安全与升级（Store+Release） | 跨账号数据保护、磁盘故障、升级排空、签名/防重放/schema 兼容与恢复 |

分阶段任务 P0–P5（`00-master-development-plan.md:13-20`）：P0 网页接入原型 → P1 消息事实 → P2 独立强提醒 → P3 网页必要操作 → P5 自有能力 → P4 故障与交付验证。总计划共 97 个工作包（FND/ACC/DAT/NET/IM/OPS/UIIM/SHL/BIZ/NTF/MED/AST/REL/QA/MAC，`:247-267`），其中 BIZ 整组与 IM-03(Node) 按范围决定不排期。

状态口径 [事实]：文档反复声明「代码落盘 ≠ G1–G5 运行验收」（`README.md:7`；`00-master-development-plan.md:44`：「没有任何一项达到 target_verified」）。截至 `BLOCKED.md:25`（第 6 轮满轮停止）与 `README.md:15`，**整体验收未通过**；之后用户追加授权的修复轮仍在进行（`PROGRESS.md:19-20`）。

### 1.3 各关口当前状态（本次汇总）

| 关口 | 当前判断 | 已有实机证据 | 主要缺口 |
| --- | --- | --- | --- |
| G0 | 部分 | 登录入口、会话列表/历史/发送/订单联系等主链路已有请求证据（`docs/api/README.md`） | 通知正文/标读、多角色、侧栏 SOA、TSim 线上、故障行为（`readiness.md:29-35`） |
| G1 | 部分 | Win/Mac 账号恢复、双账号同进程、钥匙串弹窗减少 | 登录失效/替换身份样本、跨账号实机反例、签名身份 |
| G2 | 部分（范围已缩小，BIZ 不排期） | CSP/ACL/远程能力只给官方两域；订单网页高级操作入口 | 导航/崩溃恢复/脏页保护未实测 |
| G3 | 未通过 | 受控单条文本双向、服务端 ID 一致、自然列表推进、分页 2 次样本 | 自然实时、媒体、unknown、已读、引用撤回、重连、写操作矩阵 |
| G4 | 未开始 | NSIS/DMG 可生成 | 安装执行、通知/深链/快捷键/自启、OCR 路线、更新 |
| G5 | 未开始 | 离线 hostile/损坏隔离/fsync 测试 | 升级排空、签名/防重放、schema 迁移、磁盘故障实机 |

## 2. 模块实现状态

状态口径：**A** = 已完成且有目标机实测读回；**B** = 代码落盘 + 离线测试通过，未做目标机验收；**C** = 部分实现/有占位；**D** = 未开始。行数用 `find … | xargs wc -l` 统计（`src` 不含 `tests/`；TS 拆分源码/测试）。测试数为本次实跑数（§3）。任务编号映射来自 `00-master-development-plan.md:58`，未在该行列出的为 **[推断]**。

### 2.1 Rust 核心 crate（std-only workspace，`vbk/Cargo.toml:3-17`，除 `contracts` 外均只依赖 `contracts`）

| crate | 职责 | src 行 / tests 行 | 本次测试 | 任务 | 状态 | 证据 |
| --- | --- | --- | --- | --- | --- | --- |
| `contracts` | 公共身份/IM/通知/事件/错误/时钟类型，自带 JSON 编解码 | 1581 / 0 | 13 单元 | FND-02/03 | B | `crates/contracts/src/{identity,im,json}.rs` |
| `core-account` | 登录 attempt 隔离、`(environment,buid)→AccountId` 稳定索引、`session_generation`、三种退出、凭据 Prepared→SecretStaged→IndexCommitted 账本与崩溃恢复 | 2564 / 826 | 26（6+7+13） | ACC-01/03 | B（登录恢复在实机有旁证，见 §5） | `src/registry.rs`(1455 行)、`src/credential.rs`(715)；`docs/dev/02-account-login.md:14` |
| `core-store` | 按 `(environment,account_id)` 命名空间 JSON 文档、tmp+rename 原子提交、损坏隔离 `*.corrupt-<ts>`；仓储 draft/pinned/reminder/send_intent/sync | 1816 / 630 | 16（5+11） | DAT-01/02 | B；DAT-03～05（操作账本/导入/恢复清理）D | `src/file.rs`、`src/repo/*.rs`；`docs/dev/05-store.md:13` |
| `core-net` | 端点目录、URL 精确来源校验、SOA 响应解析、MD5、服务器时钟锚点、网络状态 | 3107 / 0 | 37 单元 | NET-01/04 | B；NET-02/03（Cookie/多栈 TLS 代理）D | `src/endpoint.rs`(1172)、`src/clock.rs`(404) |
| `core-im` | 消息事实摄入、去重、outbox/unknown、同步水位、等待轮次 rounds | 3302 / 1479 | 53（19+34 strong_alert） | IM-01/04/05/06 | B | `src/im_core.rs`(833)、`src/rounds.rs`(757)、`tests/strong_alert.rs` |
| `core-notify` | 提醒引擎 L0–L4、升级、横幅、勿扰、未读聚合、命令 | 2245 / 1849 | 53（12+6+4+9+8+14） | NTF-01/02/04 | B | `src/engine.rs`(1012)、`tests/escalation.rs` |
| `core-assistant` | TSim 登录/刷新/登出请求与解析、出站翻译六字段校验、语言识别、套餐/订单/摘要、浏览器会话导入 wire | 4000 / 0 | 47 单元 | AST-02～06 | B（部分功能实机读回，见 §5） | `src/translate.rs`(818)、`src/session.rs`(693)、`src/package.rs`(622) |
| `tests/scenarios` | 跨 crate 故障场景：重复/乱序/迟到 ACK/旧代次/unknown/重启/泄漏/恶意持久化输入 | 4672（全为测试） | 76（14 个文件） | QA-01 | B | `tests/scenarios/tests/hostile_input.rs`(789) |

小计：核心 src 18,615 行 + 测试 4,784 行 + scenarios 4,672 行；`cargo test --workspace` 321 项全过。

### 2.2 Tauri 宿主 `vbk/src-tauri`（独立 package，`src-tauri/Cargo.toml:9-13`）

总计 19,203 行 Rust（含内嵌测试 ≈ 1,663 行 `*_tests.rs`），`#[test]` 195 个。74 行 `commands.txt` 冻结 69 条命令（`commands.txt:1-4`，与 `lib.rs generate_handler!`、`views.rs`、capabilities、`ui/packages/ipc` 一致性由 `ui/apps/_shared/contract-consistency.test.ts` 检查）。

| 子模块 | 职责 | 行数 | `#[test]` | 任务 | 状态 | 证据 |
| --- | --- | --- | --- | --- | --- | --- |
| `lib.rs` / `main.rs` | 启动顺序、插件注册（仅 dialog + single-instance）、主窗关闭即隐藏、Dock reopen | 189/14 | 0 | FND-01、SHL-02 | B | `lib.rs:45-105` |
| `views.rs` | 视图注册表：哪个 label 可以发哪条命令、`view_generation` 校验 | 308 | 6 | SHL-01 | B | `views.rs:1-3` |
| `commands.rs` | 应用级命令；每条命令二次校验窗口 label | 324 | 0 | FND-04 | B | `commands.rs:1-3` |
| `state.rs` | 单 mutex 聚合各核心并维持一致性 | 581 | 0 | SHL-02 [推断] | B | `state.rs:1-3` |
| `login.rs` | 登录窗（本地头 + 远程官方页）、每账号 profile WebView、身份发布、三种登出、钥匙串 | 1524 | 4 | ACC-02/04、SHL-02 | B→A 部分（Windows/macOS 账号恢复已实机，§5） | `login.rs:1-3` |
| `profiles.rs` | 每账号/每次登录尝试一个隔离 Web profile | 300 | 4 | ACC-02 | B | `profiles.rs:1-6` |
| `keychain.rs` | `keyring` 封装 macOS Keychain / Windows 凭据管理器；元数据探测减少弹窗 | 155 | 1 | ACC-03 | B（弹窗减少有旁证 `BLOCKED.md:60`） | `keychain.rs:1-3` |
| `adapter.rs` | 官方页 WebView 桥：`adapter_*`、显示缓存、host→page RPC、UI 侧 IM/通知/订单/客服状态/网络命令 | 2313 | 20 | IM-02(Web)、OPS-01～08、UIIM | C（文本收发有实机样本，自然实时/媒体未通过） | `adapter.rs:1-3`；`lib.rs:128-156` |
| `display.rs` | 显示缓存（标题/预览/正文），只在内存 | 1866 | 30 | D4 [推断 UIIM-01] | B | `display.rs:1-3` |
| `outbound_journal.rs` | 持久、无正文的出站 attempt 屏障；写前 fsync，重启不重放 | 1581 | 21 | IM-04/06 | B（Windows NTFS 句柄/重启已验，真实发送 unknown 未验 `BLOCKED.md:38`） | `outbound_journal.rs:1-3` |
| `peripheral_journal.rs` | 邀请/转接/结束的持久安全边界，非重试队列 | 959 | 13 | OPS-04/05 [推断] | B | `peripheral_journal.rs:1` |
| `media_outbound.rs` | 本地不可变附件快照，不持久化路径/字节 | 459 | 4 | MED-01/02 | C | `media_outbound.rs:1` |
| `clock_anchor.rs` | 已绑定账号页的只读服务端校时 | 160 | 5 | NET-04 | B→A 部分（9731e00 实机无锚点失效提示 `BLOCKED.md:5`） | `clock_anchor.rs:1-3` |
| `scheduler.rs` | 1 Hz 调度：执行 core-notify 效果（alarm 显隐、声音事件、Dock 弹跳/角标、标题未读） | 224 | 0 | NTF-03/04、SHL-06 | B | `scheduler.rs:176-224` |
| `windows.rs` | main/alarm/setting/update 生命周期；alarm 置顶、`focused(false)`、全空间可见、右下定位 | 373 | 5 | NTF-03、SHL-03 | B（alarm 实机强提醒未验 `round5-windows-runtime.md:52`） | `windows.rs:103-109,40-69` |
| `tray.rs` | 托盘菜单（显示/设置/勿扰 1h/明天/关闭/退出）、未读 tooltip、500ms 闪烁（macOS 改 Dock 弹跳） | 100 | 0 | SHL-06 | B | `tray.rs:21-31,93-98` |
| `shell.rs` | 窗口控制、打开本地窗口/外链（仅 https）、截图（仅 macOS `screencapture -i -x`）、文件选择 | 591 | 3 | SHL-03、MED-03 | C（Windows 截图 `HOST_UNSUPPORTED`） | `shell.rs:347-381,408-414` |
| `prefs.rs` | 完整 PrefsSnapshot 持久化 | 650 | 4 | REL-02 | C（`autostart` 字段默认 true 但无插件接线） | `prefs.rs:80,90` |
| `dto.rs` / `events.rs` | IPC DTO 与事件名（冻结） | 447/45 | 2/0 | FND-03 | B | `dto.rs:1-3` |
| `assistant.rs` + `assistant/`（12 文件） | TSim 服务：HTTP 执行、会话生命周期、出站翻译、套餐速览、订单查询与详情窗、浏览器会话导入、公开错误收敛 | 261 + 5,779 | 74 | AST-01～08 | C（订单套餐/详情 Windows 实机读回；真实翻译未执行；浏览器导入仅 Windows） | `assistant/browser_storage.rs:79-85`（非 Windows 直接 `Err(unavailable)`） |
| `examples/` | `tsim_browser_probe.rs`、`tsim_login_probe.rs` 探针 | — | — | — | 工具 | `src-tauri/examples/` |

配置面 [事实]：
- `capabilities/`：7 个文件（adapter/login/main/package-detail/popups(alarm)/setting/update）。`adapter.json` 是唯一 `remote` 能力，只给官方两域 7 个 adapter 权限；`main.json` 58 项、`setting.json` 21 项、`update.json` 仅 6 项（无任何更新命令）。
- `tauri.conf.json`：CSP 严格（`frame-src 'none'`，`img-src/media-src` 仅携程 CDN），默认 target 只有 `nsis`；`tauri.macos.conf.json` 增加 `app/dmg`、Overlay 标题栏与红绿灯 `(14,14)`；`tauri.windows.conf.json` 关闭系统装饰。
- `Cargo.toml` 声明了 `tauri-plugin-global-shortcut`、`tauri-plugin-autostart`，但 `lib.rs:48-51` 只注册 dialog 与 single-instance，构建产物字符串中也无这两个 crate（§4）。**全局快捷键、开机自启、深链实际未接线** [事实]。
- 无 updater 插件、无 OCR/拼写引擎依赖 [事实]。

### 2.3 TypeScript UI（`vbk/ui`，无运行时依赖，`node --test` 直接跑 `.ts`）

| package/app | 职责 | 源码行 / 测试行（测试文件数） | 本次测试 | 任务 | 状态 | 证据 |
| --- | --- | --- | --- | --- | --- | --- |
| `packages/ipc` | 命令/事件常量、契约类型、客户端、mock、适配器协议 | 1908 / 266（8） | 11 | FND-03 | B | `ui/packages/ipc/src/{commands,contracts,adapterProtocol}.ts` |
| `packages/ui-kit` | `h()` 渲染、store、i18n、格式化、tokens.css | 779 / 84（2）+ CSS 207 | 7 | UIIM 基础 | B | `ui/packages/ui-kit/src/` |
| `packages/web-adapter` | 注入官方页：SDK 胶水、事实/显示投影、历史/补偿/轮询、发送/已读/置顶/星标、成员/转接/结束、通知、订单、上传、校时、诊断 | 7007 / 5775（56） | 393 | IM-02、IM-07/09、OPS-01～08、MED-02 | C（最核心；实机部分读回） | `ui/packages/web-adapter/src/{sdkGlue,send,history,order,notice,media}.ts` |
| `apps/main` | 主窗：标题栏账号标签、左栏 消息/通知/订单联系、会话列表、聊天区、composer（翻译栏/附件/截图）、右栏客户/订单/套餐卡、诊断面板 | 4216 / 3603（34）+ HTML/CSS 330 | 289 | UIIM-01～05、SHL-03 | C | `ui/apps/main/main.ts`(2454)、`viewmodel.ts`(621) |
| `apps/alarm` | 强提醒窗视图：轮次列表、等待时长、稍后提醒/清除 | 370 / 136（1） | 8 | NTF-03 | B | `ui/apps/alarm/` |
| `apps/setting` | 设置：通知与提醒全分区、商家助手（TSim 登录/导入/浏览器会话）、其余分区为持久化占位开关 | 632 / 286（2） | 22 | REL-02、AST | C | `docs/dev/08-update-telemetry.md:9` |
| `apps/update` | 「软件更新」窗：只显示版本，检查更新报「更新服务尚未配置」 | 117 / 15（1） | 2 | REL-06 | D（壳） | `ui/apps/update/main.ts:1-6` |
| `apps/login` | 登录窗本地头部 | 115 / 23（1） | 3 | ACC-04 | B | `ui/apps/login/` |
| `apps/package-detail` | TSim 套餐详情窗 | 79 / 68（1） | 8 | AST-06/07 | B（Windows 实机读回真实数据 `BLOCKED.md:21`） | `ui/apps/package-detail/` |
| `apps/_shared` | 平台识别、IPC 选择、守卫、图标、契约一致性测试 | 282 / 157（2） | 8 | FND-04 | B | `ui/apps/_shared/contract-consistency.test.ts` |
| `ui/tests/smoke` | Playwright 冒烟（需外部 playwright/chromium） | — | 本次未跑 | QA | 未知 | `ui/tests/smoke/run.mjs:27-32` |

UI 合计：源码 15,505 行、测试 10,413 行，751 项测试全过。截图标注、图片/视频查看器、OCR、中文纠错在 UI 中**无实现代码**：`grep -rniE "\bocr\b"` 在 `ui/apps`、`ui/packages` 非测试源码中零命中；纠错只有设置开关 `general.spell_check`（`ui/apps/setting/main.ts:257`，文案「本地规则，仅提示不自动改写」`ui-kit/src/i18n.ts:349-350`），无规则引擎 [事实]；`docs/dev/07-media.md:9` 自述「只有入口按钮与宿主命令占位」。

### 2.4 按任务组的覆盖（97 个工作包，`00-master-development-plan.md:247-267`）

| 任务组 | 数量 | 有代码的任务 | 未开始/不排期 | 组状态 | 依据 |
| --- | --- | --- | --- | --- | --- |
| FND | 4 | FND-01～04 | — | B | `00-master-development-plan.md:58` |
| ACC | 5 | ACC-01/02/03/04、ACC-05（标题栏账号 UI） | — | B，部分 A | 同上 + §5 |
| DAT | 5 | DAT-01/02 | DAT-03 操作账本、DAT-04 导入（不排期）、DAT-05 恢复清理 | C | `05-store.md:11,13` |
| NET | 5 | NET-01/04、NET-05 部分（受限请求在适配器） | NET-02 Cookie Jar、NET-03 多栈 TLS/代理 | C | `00-master-development-plan.md:58` |
| IM | 9 | IM-01/02(Web)/04/05/06/07/09 | IM-03 Node（不排期）、IM-08 选型验收 | C | 同上 |
| OPS | 8 | OPS-01～08 均有适配器代码 | 写操作受控样本 | C | `web-adapter/src/{peripheral,settings,order}.ts` |
| UIIM | 5 | UIIM-01～05（a34a007 视口渲染属 UIIM-05） | — | C | `ui/apps/main` |
| SHL | 6 | SHL-01/02/03/06 | SHL-04 深链激活、SHL-05 恢复 | C | `lib.rs:46`；`01-shell.md:14` |
| BIZ | 7 | 仅订单联系最小入口 | 其余按范围决定不排期 | 不适用 | `web-only-scope.md:10` |
| NTF | 6 | NTF-01/02/03/04 | NTF-05 系统 Toast、NTF-06 反例实机验收 | B | `00-master-development-plan.md:49,58` |
| MED | 8 | MED-01/02（附件）、MED-03 部分（仅 macOS 系统截图） | MED-04 标注、05 下载、06 预览、07 OCR、08 纠错 | C/D | `07-media.md:9` |
| AST | 8 | AST-01～07 | AST-08 策略 [未知] | C | `09-assistant.md:19` |
| REL | 10 | REL-02 偏好 | REL-01 日志、03 语言、04 崩溃、05 诊断、06 更新、07 安装、08～10 RC | D 为主 | `08-update-telemetry.md:9` |
| QA | 8 | QA-01 场景夹具 | QA-02～08 | C | `tests/scenarios` |
| MAC | 3 | 部分 macOS 适配（Dock、红绿灯、dmg） | MAC-01～03 正式任务 | D | `00-master-development-plan.md:58`「REL、MAC 未开始」 |

## 3. 实际运行检查

环境：macOS (Darwin 27.2, arm64)，`main@a34a007`，工作树仅 1 个未跟踪文档。Node 用 `~/tools/node24/bin`（`package.json` 要求 `>=22.18`），未执行 `npm ci`（`node_modules` 已存在）。Cargo 全部 `--offline`。

| 命令 | 结果 | 耗时 | 日志 |
| --- | --- | --- | --- |
| `cargo test --workspace --offline`（vbk/） | **321 passed / 0 failed / 0 ignored**，39 个测试二进制（含 8 个 doc-test 空集）；EXIT=0 | 最慢为 `hostile_input` 9.1 s | `~/tools/rea-work/gap/cargo-test.log` |
| `npm run typecheck`（`tsc -p tsconfig.json`） | 0 错误；EXIT=0 | — | `typecheck.log` |
| `npm test`（`node --test "ui/**/*.test.ts"`） | **751 tests / 751 pass / 0 fail / 0 skipped**；EXIT=0 | 2.8 s | `npmtest.log` |
| `cargo check --manifest-path src-tauri/Cargo.toml --offline` | 通过；1 条警告：`browser_storage.rs:69 fn profile_name is never used`（因非 Windows 平台 `discover_profiles` 直接返回不可用）；EXIT=0 | 6.7 s（增量） | `tauri-check.log` |
| `cargo test --manifest-path src-tauri/Cargo.toml --offline`（额外执行） | **195 项：192 passed / 3 FAILED**；EXIT=101 | 2.6 s | `tauri-test.log` |
| 同上，仅 `browser_storage`，`TMPDIR=/private/tmp/...` | **12 passed / 0 failed** | — | 命令输出 |

**宿主 3 项失败分析 [事实]**：`assistant::browser_storage::tests::{stable_reread_rejects_replaced_or_changed_bytes, synthetic_store_latest_deletion_torn_tail_and_missing_wal, selected_sst_and_wal_never_fall_back_after_deletion_or_corruption}` 均 panic 于 `AppError{code:"assistant.browser_storage_unavailable"}`（`browser_storage.rs:1280,1309,1333`）。根因：测试夹具用 `std::env::temp_dir()`（`:1011`），macOS 下为 `/var/folders/...`，而 `/var` 是指向 `private/var` 的符号链接；`safe_directory` 对每个祖先要求「非链接目录」（`:60-66`），故在 macOS 上必然拒绝。把 `TMPDIR` 换成无符号链接的 `/private/tmp/...` 后 12/12 通过。结论：**生产逻辑符合设计（拒绝链接祖先），但测试仅在 Windows 上绿过**，macOS 上 `cargo test` 不是全绿；历史记录中的「host 178/0 失败」均来自 Windows 运行（`PROGRESS.md:5`）。

与历史门禁对比 [事实]：`PROGRESS.md:5` 记 7b5d75a 为 711 UI / 178 host / 312 core；本次 HEAD 为 751 UI / 195 host / 321 core（+8 个此后提交，如 `2bc814f`、`1f01e84`、`a34a007`，尚未写入 PROGRESS/BLOCKED，最后一次更新为 `Sat Oct 31 16:27`）。

未执行：`npm run smoke:ui`（需外部 Playwright/Chromium，不在本次要求内）、`clippy`、`cargo tauri build`。

离线门禁数量走势（历史值引自记录，本次值为实跑）：

| 节点 | UI(TS) | 核心 | 宿主 | 出处 |
| --- | --- | --- | --- | --- |
| 10-30 落盘 | 148 | 297 | 语法检查 | `00-master-development-plan.md:44` |
| 第 1 轮 | 242 | 300 | 63 | `BLOCKED.md:87` |
| 第 2 轮 | 323 | 300 | 63 | `BLOCKED.md:71` |
| 第 3 轮 | 387 | 301 | 95 | `BLOCKED.md:64` |
| 第 4 轮 | 399 | 301 | 101 | `BLOCKED.md:56` |
| 第 6 轮（Windows） | 536 | 304 | 126 | `BLOCKED.md:26` |
| 7b5d75a（Windows） | 711 | 312 | 178 | `PROGRESS.md:5` |
| **本次 a34a007（macOS）** | **751** | **321** | **192/195** | §3 |

观察 [推断]：测试数 5 倍增长，主要来自回归反例（每次实机失败后补红→绿用例）；这提高了离线防回归能力，但实机关口状态并未同步前进（§1.3）。

## 4. 构建产物检测（rea）

发现的产物 [事实]：

| 路径 | 时间 | 体积 | 备注 |
| --- | --- | --- | --- |
| `vbk/release/macos/VBooking 商家客户端.app` | 2026-10-31 01:13 | 17 MB（可执行 17,971,008 B） | 第 1 轮 Mac 旧包；`docs/research/2026-10-31-message-panel-matrix.md:43` 记其「仍有发送中及禁用控件」 |
| `vbk/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/VBooking 商家客户端.app` | 2026-11-01 17:45 | 19 MB（可执行 19,982,720 B） | 最新 Mac 构建；与 `target/.../release/vbk-host` SHA-256 相同 `a06597bb…b279` |
| `…/bundle/dmg/VBooking 商家客户端_0.1.0_aarch64.dmg` | 2026-11-01 17:45 | 7,391,279 B（≈7.0 MiB） | |
| Windows 包（`vbk/release/windows-*`） | — | — | 本机不存在，仅在 Windows 机器上（`PROGRESS.md:5`、round6 记录 NSIS 6.6 MB / exe 20.5 MB） |

最新 bundle 是否由 HEAD `a34a007`（提交时间 11-01 15:27）构建：**[推断] 可能是**（构建时间晚于提交），二进制内无 build-id/commit 字符串，不能证明。

rea 结果（原始 JSON：`~/tools/rea-work/gap/rea-*.json`）：

| 检查 | vbk 最新 bundle | vbk 旧 release 包 | 官方 旅游商家桌面版 1.2.13 |
| --- | --- | --- | --- |
| `inspect-rust-binary` | Mach-O arm64；**无 `.dep-v0`（未用 cargo-auditable）**；rustc commit 推断 `59807616…3860` | 同左，SHA-256 `d4f34198…a5fa` | — |
| `inspect-signature` | `signed:true` 但 **adhoc, linker-signed**；identifier `vbk_host-c4642c9c7402c04a`；无 Team ID、无证书链、无时间戳、`hardened_runtime:false`、无 entitlements | adhoc，identifier `vbk_host-0b0297acb849af91` | Developer ID（Team `F63YXXUDZP`，Xiecheng Tourism Network Technology (Shanghai)）、hardened runtime、带时间戳；entitlements 含 allow-jit / unsigned-executable-memory / disable-library-validation；**主程序是 x86_64 thin**（在 Apple Silicon 上走 Rosetta） |
| `inspect-plist` | `tech.tsim.vbk.client`，0.1.0，`LSMinimumSystemVersion 10.13`；无 URL scheme、无 `NSUserNotification`/用途声明 | — | `com.ctrip.vbooking` |
| `inspect-desktop-application` | 仅 3 个文件：`Info.plist`、`MacOS/vbk-host`、`Resources/icon.icns`；前端资源内嵌在二进制 | — | — |

依赖 crate（`.dep-v0` 缺失，改用 `strings` 抓 `index.crates.io-*/<crate>-<ver>` 路径，共 90 个，`crates-from-strings.txt`）[事实，版本来自路径字符串，非认证]：`tauri 2.12.5`、`tauri-runtime-wry 2.12.3`、`wry 0.57.1`、`tao 0.37.2`、`tauri-plugin-dialog 2.8.4`、`tauri-plugin-single-instance 2.5.5`、`reqwest 0.12.28`、`hyper 1.12.0`、`rustls 0.23.46`、`ring 0.17.14`、`keyring 3.6.3`、`security-framework 3.7.0`、`tokio 1.54.1`、`objc2-web-kit 0.3.2`。**未出现** `tauri-plugin-global-shortcut`、`tauri-plugin-autostart`、任何 updater/deep-link 插件，与 §2.2 的「声明未接线」一致。

体积对比 [事实]：

| | 官方 Mac 1.2.13 | 官方 Win 1.2.12 解包 | vbk Mac 最新 |
| --- | --- | --- | --- |
| 整包 | 744 MB（`du -sh`） | 1.5 GB（`~/Downloads/vbk-electron`） | 19 MB `.app` / 7.0 MiB `.dmg` |
| 主体 | `app.asar` 364,139,989 B（≈364 MB / 347 MiB） | — | `vbk-host` 19.98 MB（含 UI 资源） |

体积优势约 **39×（.app）**，但这是「不含 IM 原生 SDK、OCR 模型、Chromium」换来的；Tauri 依赖系统 WKWebView/WebView2，后者在 Windows 走 `embedBootstrapper`（`tauri.conf.json` bundle.windows），首次安装需联网获取 Runtime [推断]。

## 5. 未关闭阻塞与已知缺陷

来源以 `BLOCKED.md`（顶部为最新）与 `PROGRESS.md` 为准；「已解决」的只列一行备注。注意 PROGRESS/BLOCKED 最后更新于 10-31 16:27，其后 8 个提交的实机状态 **[未知]**。

### 5.1 外部依赖阻塞（非本仓代码能单独解决）

| # | 项 | 现状 | 证据 |
| --- | --- | --- | --- |
| E1 | 忙账号 Nay 禁止代理出站 → 真实双向只能在闲账号 Meru 少量样本 | 用户约束，持续有效 | `BLOCKED.md:8-9` |
| E2 | 服务端无已验证幂等保证，`local_id` 只是关联键 | 决定了 unknown 只能「不重放 + 人工核对」 | `docs/research/2026-10-31-message-panel-matrix.md:31` |
| E3 | 通知正文/标读完整契约、多角色/群主转移/评价权限、侧栏内部 SOA 未补采 | G0 未闭环 | `docs/api/readiness.md:29-32` |
| E4 | TSim 线上兼容（真实 token、套餐 scope）未动态核验；Mac 助手 0.3.2 曾认证失败、`timeoutReached` | Windows 侧已有订单/套餐真实读回，翻译未执行 | `readiness.md:33`；`BLOCKED.md:21,39,90-93` |
| E5 | 官方 macOS 桌面无法被 CUA 驱动（AppleEvent `-1712` timeout） | Mac 三端对比缺官方桌面证据 | `BLOCKED.md:92,98` |
| E6 | 官方网页登录 | **已解除**（Edge 专用页显示 11/9），但订单侧 iframe 未完整读回 | `BLOCKED.md:16` |
| E7 | 签名身份：无 Apple Developer ID / Windows 代码签名证书 [推断：仓库与产物中均无] | 产物 adhoc 签名，钥匙串 ACL 绑定 cdhash，每次构建可能重新弹窗 | §4；`BLOCKED.md:71` |
| E8 | 旧版订单联系入口重载 15 秒内未恢复受控标题 | 原因未确认 | `readiness.md:35` |

### 5.2 实现缺陷（代码层面已知问题）

| # | 缺陷 | 状态 | 证据 |
| --- | --- | --- | --- |
| D1 | **历史分页锚点跳位**（18:33 撤回行跳到 18:21 订单卡） | 第 5、6 轮失败；60c9479 后两次受控样本保持（视觉 2–4 px），**未做长期/多会话复验，不能关闭** | `BLOCKED.md:27,42`；`PROGRESS.md:14,16` |
| D2 | **会话列表计数与官方不一致**：Nay 新包 0 处理中/921 完成 vs 官方 20/1959；Meru 新包 11/9 = 官方网页 11/9 ≠ 官方桌面 11/24 | 根因未定（官方近 30 日缓存合并/BC-BOP 分栏口径） | `BLOCKED.md:4,7,12,29` |
| D3 | **自然实时到达不可靠**：第 2/3 轮官方发出 40–49 s 未自动出现，加载历史后才见 | 后台调度 d1d071d/持续补偿 34470c1 已入包；10-31 观察到自然列表推进，**丢漏/延迟未量化** | `BLOCKED.md:61,66,72,9`；`PROGRESS.md:12` |
| D4 | 机器人名称显示原始本地化 key（官方显示「游游机器人」） | 未见修复记录 [未知] | `BLOCKED.md:60,85` |
| D5 | 历史按 server_id 合并未联合 local_id 致 unknown 回显重复；实时/补偿订单卡不更新会话订单摘要；历史订单 A 卡打开当前订单 B 侧栏 | 第 4 轮记「尚未完成修复」，之后无关闭记录 [未知] | `BLOCKED.md:59` |
| D6 | Windows 截图 `HOST_UNSUPPORTED`；大视频分片未实现；推荐/完整来源轨迹缺口 | 代码确认 Windows 截图分支直接返回不支持 | `shell.rs:408-414`；`BLOCKED.md:30,41` |
| D7 | TSim 浏览器会话复用仅 Windows（`discover_profiles` 非 Windows 恒 `Err`） | macOS 上该功能不可用；产生 dead_code 警告 | `browser_storage.rs:79-85`；`tauri-check.log` |
| D8 | 宿主 `browser_storage` 3 个测试在 macOS 必失败（TMPDIR 符号链接） | 测试夹具问题，非生产缺陷 | §3 |
| D9 | 声明了但未接线：全局快捷键、开机自启（偏好 `autostart` 默认 true 却无效）、深链 | 代码确认 | `lib.rs:46-51`；`prefs.rs:80,90`；§4 |
| D10 | 草稿仅内存保存（进程切换时需用户人工保留） | 第 6 轮后记录；`core-store` 有 draft 仓储但宿主未用于此场景 [推断] | `BLOCKED.md:23` |
| D11 | 默认 UI WebView 内存偏高 | 新进程未重现，不排除长期问题 | `BLOCKED.md:12`；`PROGRESS.md:18` |
| D12 | 历史视频 `Invalid`（官方同资源可播） | ego 浏览器同资源已加载，原生 WebView 状态 [未知] | `BLOCKED.md:65,72`；matrix `:32` |

已解决（仅备注）：设置窗空白（24f6271 异步建窗）、钥匙串弹窗（e49ca90 元数据探测）、附件名伪文本出站（439d9de 阻断）、离线文案误称排队（24b10f2）、头像 CSP（3b0735a）、TSim 登录/退出竞态（c41db39）、服务端校时未接线（9731e00）。

### 5.3 验收未做（代码存在，缺目标机证据）

| # | 项 | 证据 |
| --- | --- | --- |
| V1 | 真实图片/文件/视频上传 → SDK 发送 → 三端读回；有效 MP4 解码 | `BLOCKED.md:30`（Windows 两轮附件上传 0 次） |
| V2 | 真实 unknown 跨重启恢复、硬件断电 | `BLOCKED.md:30,38` |
| V3 | 引用撤回、重连/切账号、客户已读回执 | `BLOCKED.md:28,30` |
| V4 | **独立强提醒 alarm 实机**（30 s 可见、不抢焦点、连续客户消息不重置、确认回复才清除、睡眠/重启） | `docs/research/2026-10-31-round5-windows-runtime.md:52`；`docs/dev/01-shell.md:14`（macOS 不夺焦点待验） |
| V5 | 出站翻译真实调用（替换草稿/直接发送两种模式） | `BLOCKED.md:39` |
| V6 | 托盘/Dock 角标/任务栏闪烁、勿扰在目标机的行为 | 无运行记录 [事实：research 中未检索到托盘实测] |
| V7 | macOS 新版（11-01 bundle）实机：登录、双账号、红绿灯位置、alarm | `BLOCKED.md:31`「Mac 没有新版构建」为 10-31 状态；新 bundle 运行记录 [未知] |
| V8 | 安装器（NSIS/DMG）执行、升级、卸载、普通用户 | `BLOCKED.md:31`「安装器仅生成未执行」 |
| V9 | P4 故障矩阵：隐藏/最小化、睡眠、登录失效、长稳（QA-07） | `00-master-development-plan.md:20,49` |
| V10 | 8 个 10-31 之后提交（套餐+CDR 卡、浏览器会话复用、视口渲染等）未入任何实机包记录 | `git log` vs `PROGRESS.md` |

## 6. 差距矩阵

「官方」列依据 `docs/research/2026-11-01-desktop-reverse-gap-report.md:28-65`（1.2.13 主进程 22 个单例的静态逆向）与 `docs/research/2026-10-31-message-panel-matrix.md`；**静态有 ≠ 官方运行可用**。vbk 状态用 §2 的 A/B/C/D。优先级：P0 = 阻断「可替代日常客服」；P1 = 有限试用前必须；P2 = 完整范围 RC 前；P3 = 可延后/可显式禁用。

### 6.1 身份与账号（G1）

| 能力点 | 官方 | vbk | 差距 | 阻塞原因 | 优先级 |
| --- | --- | --- | --- | --- | --- |
| 官方网页登录（隔离 Profile） | 有（登录窗 `ct`） | A 部分：Win/Mac 新包账号恢复已实机 | 登录失效/验证码/风控路径未系统验证 | E6 已解除；需失效样本 | P1 |
| 多账号标签、每账号隔离 | 有（`st`、按 buid 的 IM 进程） | A 部分：Meru+Nay 双账号同进程恢复 | 跨账号串扰反例只在离线场景（`tests/scenarios/leakage.rs`） | 忙账号不能出站（E1） | P1 |
| 三种退出（在线/登录/彻底移除） | 有 | B | 无实机记录 | — | P2 |
| 凭据存系统库 + 少弹窗 | 有（Developer ID 签名） | B/A 部分 | adhoc 签名 → 钥匙串 ACL 随 cdhash 变化 [推断] | E7 证书 | P1 |
| 客服工作状态（在线/挂起/离开/下班） | 有 | B（`account_set_agent_status`；65bc668 按状态控提醒） | 回读一致性无实机 | — | P2 |

### 6.2 消息 IM（G3）

| 能力点 | 官方 | vbk | 差距 | 阻塞原因 | 优先级 |
| --- | --- | --- | --- | --- | --- |
| 实时收消息（XMPP/WSS） | 有（独立 utilityProcess `imsdk.js`） | C：依赖官方页内 SDK；自然推进已见 | 丢漏/延迟未量化；曾 49 s 未到（D3） | 页面生命周期/后台节流 | **P0** |
| 断线补偿与同步水位 | 有 | B（core-im watermarks + web-adapter compensation） | 睡眠/重连/切账号无实机（V3/V9） | — | **P0** |
| 发送文本 + 回执 confirmed | 有 | A 部分：Meru 受控样本官方可见、服务端 ID 一致 | 样本量 1–2 条；双向矩阵未完 | E1 | **P0** |
| unknown 不重放、持久屏障 | 无同等设计（官方未见） | B（outbound_journal + send_intent） | 真实 unknown 重启未验（V2） | E2 | P1 |
| 会话列表与计数 | 有（含近 30 日本地 sqlite 缓存合并） | C | 与官方计数不一致（D2） | 口径未定 | **P0** |
| 历史分页与阅读位置保持 | 有 | C | D1 仅 2 次样本通过 | — | **P0** |
| 已读回执（可见才读、服务身份绑定） | 有 | B（7b5d75a） | 客户已读与上游回执未实机（V3） | E1 | P1 |
| 置顶 / 颜色星标 | 有 | B（`im_set_top`/`im_set_mark`，橙色读回已有接口证据） | 实机写入读回未记录 | — | P2 |
| 成员/邀请/转接/结束 | 有 | B（peripheral_journal 安全边界） | 写操作未做受控样本 | E3 多角色 | P2 |
| 引用、撤回显示 | 有 | B（02d4125 修引用残留） | 实机未验 | — | P2 |
| 图片/文件/视频发送 | 有（10 MiB/30 MiB/300 MiB） | C：上传链路代码在 `upload.ts`/`media.ts`；本地选择/拒绝已实机 | 真实上传→发送→读回 0 次（V1）；大视频分片缺（D6） | — | P1 |
| 收到的媒体显示/播放 | 有（`St` 图片查看器/视频播放器窗） | C：视频曾 Invalid（D12）；无独立查看器窗 | 查看器未实现 | — | P2 |
| 入站翻译（平台官方） | 有 | B（IM-09，适配器内） | 实机未验 | — | P2 |
| 快捷回复/客服话术 | 有 | C：`im_customer_scripts` 对非空响应无字段证据返回 unsupported | 无字段证据不能造话术 | E3 | P3 |
| 本地搜索/服务端会话搜索 | 有（`16037/searchConversation`） | C：仅本地筛选 | 服务端搜索未接 | — | P3 |
| 机器人/成员显示名本地化 | 有 | C（D4 raw key） | — | — | P2 |

### 6.3 通知与提醒（G3/G4）

| 能力点 | 官方 | vbk | 差距 | 阻塞原因 | 优先级 |
| --- | --- | --- | --- | --- | --- |
| 通知中心（分类/列表/标读） | 有 | C（`notice_*` 三命令 + UI） | 正文与标读契约未补采 | E3 | P2 |
| 横幅 L2 + 提示音 | 有（通知弹窗池 `nt`） | B（core-notify banner；声音由主窗播放 `scheduler.rs:176-186`） | 主窗隐藏时音频是否可播 [未知]；无系统 Toast（NTF-05） | — | P1 |
| 独立回复超时强提醒 L3/L4 + 稍后提醒 | 有（Alarm Dialog `en`；网页版未处理 `reply_timeout`） | B：核心 53 + 窗口 + alarm UI 8 测试 | **零实机验收**（V4） | — | **P0** |
| 勿扰（1h/到明天）与「勿扰仍提醒超时」 | 部分 | B | 实机未验 | — | P2 |
| 托盘未读、闪烁 / Dock 角标 / 任务栏数字 | 有（`$t`） | B：macOS Dock 角标+弹跳；Windows 只改标题，无 overlay 数字 | Windows 任务栏数字缺（`scheduler.rs:202-212`）；无实机（V6） | — | P1 |

### 6.4 订单联系（P3）

| 能力点 | 官方 | vbk | 差距 | 阻塞原因 | 优先级 |
| --- | --- | --- | --- | --- | --- |
| 完整订单号查询 → 唯一结果 → IM 联系 | 有（网页） | B/A 部分：受控订单/客户多轮核对 | `createimchat` 超时记 `unknown_may_have_created`，重复创建行为无样本 | E8 | P1 |
| 「网页高级操作」打开订单详情 WebView | 有（网页） | B（`shell_open_webview`） | 实机未记录 | — | P3 |

### 6.5 自有能力（P5）

| 能力点 | 官方 | vbk | 差距 | 阻塞原因 | 优先级 |
| --- | --- | --- | --- | --- | --- |
| TSim 登录（密码/导入/浏览器会话） | 有（外部助手插件） | C：Windows 已实机导入与恢复；macOS 浏览器会话不可用（D7） | Mac 平台缺口 | E4 | P1 |
| 出站翻译（替换草稿/直接发送） | 有（助手翻译栏） | B（core-assistant 六字段校验 + composer 翻译栏） | 真实翻译 0 次（V5） | E4 | P1 |
| 套餐速览 + 详情窗 + CDR | 有（助手） | A 部分：Windows 自动返回 1 套餐、详情读回名称/供应商/APN | 1f01e84（CDR 卡）未实机 | — | P2 |
| 截图（选区） | 有（`Ne` 多屏遮罩 overlay） | C：macOS 调系统 `screencapture -i`；Windows 不支持 | 无遮罩/标注/撤销/另存；Windows 缺 | — | P1 |
| 截图标注（矩形/箭头/文字/马赛克…） | 有 | D | 全缺 | — | P2 |
| OCR | 有（`Bt` paddleocr + onnxruntime-web worker） | D | 引擎与安装身份未选型（REL-08 要求 OCR-disabled 默认） | 选型 | P3 |
| 中文纠错 | 有（`at` spell-check worker） | D（只有偏好开关） | 规则引擎缺 | — | P3 |
| 全局快捷键（截图/显隐主窗） | 有（`Je` 注册） | D（插件声明未注册，D9） | — | — | P2 |
| 开机自启 | 有 | D（偏好无效，D9） | — | — | P2 |
| 深链唤起 | 有 | D（`lib.rs:46` 注释「later SHL-04」；plist 无 URL scheme） | — | 协议名不能抢占 `vbookingChat` | P3 |
| 客户端更新（签名包） | 有（`We` electron-updater + `Ye`/`jt` 安装引导） | D（update 窗口壳，无插件、无发布源） | 全缺 | 发布源/签名密钥 | P1 |
| 本地诊断包（脱敏） | 部分（UBT 远程上报 `Zt`） | C：只读接收诊断面板 + 滚动几何诊断；无导出包 | REL-05 未做 | — | P2 |
| 偏好设置 | 有 | C：通知与助手分区真实；其余为持久化占位 | 快捷键/网络/存储/隐私分区无行为 | — | P2 |
| 崩溃观察/恢复 | 有（DBManager 崩溃恢复） | D（REL-04） | — | — | P2 |

### 6.6 发布与平台（G4/G5、MAC）

| 能力点 | 官方 | vbk | 差距 | 阻塞原因 | 优先级 |
| --- | --- | --- | --- | --- | --- |
| macOS 签名 + 公证 + hardened runtime | 有（Developer ID） | D（adhoc linker-signed） | 无法分发给普通用户；Gatekeeper 拦截 [推断] | E7 | P1 |
| Apple Silicon 原生 | 无（x86_64，走 Rosetta） | 有（arm64） | vbk 领先；需补 x86_64/universal 构建 [推断] | — | P3 |
| Windows 安装/升级/卸载 | 有 | C：NSIS 已生成未执行 | V8 | — | P1 |
| 跨账号数据保护/磁盘故障/schema 兼容 | 有（sqlite + drizzle 迁移） | B：JSON 文档 + 损坏隔离 + hostile 输入测试 | 无 schema 版本迁移/升级排空实测 | — | P2 |
| 构建可追溯（commit 嵌入、cargo-auditable） | — | D：二进制无 build-id、无 `.dep-v0` | 无法从产物反查源码版本 | — | P2 |
| macOS 上全绿测试 | — | C：host 3 测试在 macOS 失败（D8） | 门禁平台相关 | — | P2 |

## 7. 重构计划风险点

1. **IM 可靠性依赖官方网页 SDK 跑在隐藏 WebView 里** [事实+推断]。官方客户端用独立 utilityProcess 跑原生 IM SDK，vbk 则把传输交给官方页面（`lib.rs:4-6`），且决定不做 sidecar（`im-transport.md:5`）。WebView 隐藏/后台节流/睡眠唤醒都会影响实时性（D3 已复现），而这是「替代日常客服」的 P0。计划需要为「后台页面保活 + 补偿轮询」设定可量化 SLO（漏消息率、P95 延迟）和长稳测试，否则核心价值无法验收。
2. **验收证据与代码前进脱节** [事实]。PROGRESS/BLOCKED 停在 10-31 16:27，此后 8 个提交无实机记录；测试数量持续增加（UI 711→751），但 V1–V10 中多数仍为 0 次实测，独立强提醒这一自有核心能力至今零实机。若继续以「离线门禁全绿」推进，会积累大量 B 状态而无 A。建议把每条 P0/P1 能力绑定一个可复跑的实机脚本与固定证据格式。
3. **平台不对称：Windows 证据多、macOS 证据少且有平台专属缺口** [事实]。Windows 截图不支持、任务栏数字缺；macOS 浏览器会话导入不可用、host 测试在 macOS 失败 3 项、官方 Mac 桌面无法自动化对比（E5）。计划要求 R5 不继承 Windows passed（`00-master-development-plan.md:216`），但目前 MAC-01～03 未开始，用户又在 macOS 验收。需尽早排 macOS 同等矩阵。
4. **发布链路整体缺失** [事实]。无更新器、无签名证书（adhoc）、无 build-id、安装器未执行、无崩溃/诊断包。与官方相比，体积优势（19 MB vs 744 MB）只有在可签名分发、可升级时才兑现；adhoc 签名还会让钥匙串授权随每次构建失效，直接影响多账号「免密恢复」体验（G1/G5 交叉风险）。
5. **数据口径与写操作无幂等保证** [事实]。会话计数与官方不一致且口径未定（D2），服务端无幂等（E2），忙账号禁止出站（E1），多角色/转接/评价等权限未采样（E3）。这意味着 G3「受控业务写入矩阵」在现有条件下很难完成；计划需要明确的测试账号/沙箱环境，或显式缩小有限试用范围（`00-master-development-plan.md:1524-1531` 允许显式禁用，但要求是产品决策而非静默删减）。

次要风险：媒体工具（截图标注/OCR/纠错/查看器）全部为 D，官方在这几项上已有完整实现，若用户把「功能对等」作为验收口径，这是最大的工作量缺口；`core-store` 用 JSON 文档而非数据库，随消息缓存/搜索需求增长可能需要重做存储层。

## 附录 A. 复现命令

```bash
cd vbk
export PATH=$HOME/tools/node24/bin:$PATH          # 需 node >= 22.18
cargo test --workspace --offline                  # 321 passed
npm run typecheck                                 # 0 error
npm test                                          # 751 pass
cargo check --manifest-path src-tauri/Cargo.toml --offline
cargo test  --manifest-path src-tauri/Cargo.toml --offline          # macOS: 192/195
TMPDIR=/private/tmp/x/ cargo test --manifest-path src-tauri/Cargo.toml --offline --lib browser_storage   # 12/12

B="src-tauri/target/aarch64-apple-darwin/release/bundle/macos/VBooking 商家客户端.app"
~/tools/rea/rea inspect-rust-binary "$B/Contents/MacOS/vbk-host" --format json
~/tools/rea/rea inspect-desktop-application "$B" --format json
~/tools/rea/rea inspect-plist "$B" --format json
~/tools/rea/rea inspect-signature "$B" --format json
~/tools/rea/rea inspect-signature /Applications/旅游商家桌面版.app --format json
strings -a "$B/Contents/MacOS/vbk-host" | grep -oE 'index\.crates\.io-[0-9a-f]+/[A-Za-z0-9_-]+-[0-9.]+' | sort -u
```

## 附录 B. 证据分级清单

**已验证事实**（本次命令或文件直接确认）：
- 三套离线测试结果与 macOS 宿主 3 项失败的根因（§3）。
- 全局快捷键/自启插件声明未注册、产物中无对应 crate；无 updater/OCR 依赖（§2.2、§4）。
- Windows 截图分支返回 `HOST_UNSUPPORTED`；非 Windows 浏览器会话发现恒失败（§5.2 D6/D7）。
- 产物 adhoc 签名、无 hardened runtime、无 `.dep-v0`；官方为 Developer ID + x86_64（§4）。
- 体积：官方 Mac 744 MB / app.asar 364,139,989 B；vbk `.app` 19 MB / `.dmg` 7,391,279 B（§4）。
- PROGRESS/BLOCKED 最后更新时间早于 8 个后续提交（§5）。

**推断**：
- 最新 bundle 由 HEAD 构建（时间先后，无 build-id 佐证）。
- adhoc 签名会使钥匙串授权随 cdhash 变化、导致重复弹窗。
- 主窗隐藏时依赖主窗 WebView 播放提示音可能受后台节流影响。
- `core-store` JSON 文档方案在消息缓存/搜索增长后可能需要重构。

**未知**：
- 10-31 之后提交（CDR 卡、浏览器会话复用、视口渲染、无进展历史页重试）的实机表现。
- D4（机器人名）、D5（server_id/local_id 合并、订单卡跨会话）是否已在后续提交中修复。
- 新 macOS bundle 是否已被用户运行验收；macOS alarm 不夺焦点行为。
- Playwright 冒烟测试当前是否通过。
