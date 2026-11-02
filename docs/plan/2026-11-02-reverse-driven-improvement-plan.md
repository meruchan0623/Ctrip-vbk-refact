# 基于 rea 逆向结论的 vbk 改进开发计划

2026-11-02。状态：计划，未开始实施（第五次修订版）。输入：[rea 逆向总览](../reverse/2026-11-01-rea/00-README.md) 及其 01–06 分报告、[PROGRESS](../../PROGRESS.md)、[BLOCKED](../../BLOCKED.md)、[实物验证报告](../reviews/2026-11-02-reverse-plan-verification.md)、[Codex 第一轮对抗性审查](../reviews/2026-11-02-codex-adversarial-review-01.md)、[Codex 第二轮对抗性审查](../reviews/2026-11-02-codex-adversarial-review-02.md)、[官方桌面版实机接口截获（六轮）](../reviews/2026-11-02-desktop-live-capture-verification.md)，以及对 `vbk/` 工作树（`main@d578872`）的只读核对（第四轮 file:line 均为本轮 grep/sed 复核结果）。范围仍以[网页版范围决定](../decisions/2026-10-30-web-only-scope.md)为准。

本文与既有文档的关系：

| 文档 | 角色 | 本文如何使用 |
| --- | --- | --- |
| [06 Tauri + Rust 实施计划](../reverse/2026-11-01-rea/06-tauri-rust-implementation-plan.md) | 30 个模块的职责、依赖、波次与验收标准（模块视角） | 沿用其模块编号（M/H/U/R）、不变量（G-SEC/G-STA/G-ID/G-IM）、风险（R1–R11）与决策点（X1–X8），不重复定义 |
| [总和开发计划](00-master-development-plan.md) | 公共契约、不变量、单写者规则（第 4 节）、任务编号 | 沿用其契约与所有权规则；本文的工作项标注对应的旧任务编号 |
| [原型还原计划](2026-10-30-prototype-restoration-plan.md) | 2026-10-30 起的接线顺序 | 其 M0–M2 已大部分落盘；本文接替其后的执行顺序 |
| [官方桌面版实机接口截获](../reviews/2026-11-02-desktop-live-capture-verification.md) | 对运行中的官方 Mac 1.2.13 被动截获六轮（轮询、开会话、出站、已读、撤回、星标/转接/结束），只记字段结构 | 作为 C 类证据的**官方桌面基线**；本文 C1/C7/C10、I-06、I-11、I-14、I-15、I-23、I-24、I-30a/b 据此修订（§8.5） |
| 本文 | **改造视角**：把逆向得到的「官方哪里坏、vbk 现在怎样、要改什么、怎么证明改好了」压成可派工的工作项清单，并给出批次与退出条件 | — |

> 本文是计划，不是验收结论。所有「现状」均为 2026-11-02 的只读核对或 04 报告的盘点；实施时以最新 PROGRESS/BLOCKED 为准。证据类型与「目标机」定义见 §3 开头与 §5 末尾：离线测试全绿只算代码落盘，C 类工作项必须有目标机读回证据。修订历史与审查闭环见 §8、§9。

---

## 1. 现状基线（2026-11-02 核对）

### 1.1 离线门禁与产物

| 项 | 事实 | 来源 |
| --- | --- | --- |
| 核心 crate | `cargo test --workspace` 321/321；**`cargo clippy --all-targets -D warnings` 13 错**（`core-notify/src/engine.rs:857` needless_borrows，`core-assistant` 测试代码 12 处 `unwrap_used`）；**`cargo fmt --check` 有差异**（`core-account/src/credential.rs:486` 等） | 本日实跑 |
| UI | `tsc` 0 错误（需先 `npm ci`；`tsconfig.base.json:20` 含失效的 `/opt/node-tools` typeRoots）；`node --test` 751/751，无 skip；**Playwright smoke 失败**（`84016ec` 取消启动自动打开会话，`ui/tests/smoke/run.mjs:213` 仍等 `.msg`） | 本日实跑 |
| 宿主 | macOS 上 192/195，3 个失败是 `browser_storage` 测试夹具用了经符号链接的 `TMPDIR`；**离线不可构建**（registry 未缓存 `keyring`） | 本日实跑 |
| CI | `.github/workflows/vbk-check.yml`：核心 fmt/clippy/test、UI tsc/test/smoke、宿主 **只做 `cargo check`**（Win/Mac）、macOS 未签名 bundle；**main 最近一次（a34a007）失败**，上一次成功 | 本日核对 `gh run list` |
| 日志 | 宿主未安装任何 logger（无 env_logger / tauri-plugin-log），`log::*` 全为空操作 | 本日核对 |
| 产物 | macOS `.app` 19 MB / `.dmg` 7.0 MiB，arm64，adhoc 签名、无 hardened runtime、无 `cargo-auditable` 元数据；Windows NSIS 生成过未执行安装 | 04 §4 |
| 插件 | `Cargo.toml` 声明 `global-shortcut`、`autostart`，`lib.rs:48-49` 只注册 `dialog` + `single-instance`；无 updater/deep-link/notification | 本日核对 |
| 偏好 | `prefs.rs:90` `autostart` 默认 `true`，但没有任何接线 | 本日核对 |
| 传输监督 | `adapter.rs` 中没有 reload、backoff、heartbeat 类逻辑；适配器源码没有 `visibilitychange` 处理；`conversationList.ts:133` 轮询间隔 5000 ms（镜像官方） | 本日核对 |
| 渲染安全 | `tauri.conf.json` CSP 严格（`frame-src 'none'`，无 `unsafe-eval`）；非测试源码中 `innerHTML` 仅 1 处（`ui/apps/main/companion-card.ts:70`，拼 SVG 字符串） | 本日核对 |
| 状态锁 | `state.rs` 用单个 `Mutex<Cores>` 聚合全部核心 | 本日核对 |

### 1.2 实机状态（关口 G1–G5 均未整体通过）

| 已有实机读回 | 零实机或未通过 |
| --- | --- |
| 账号恢复（Win/Mac）、双账号同进程、受控文本单条收发、服务端校时、TSim 订单套餐与详情（Windows）、历史分页位置保持（2 次样本） | 自然实时可靠性（曾 49 秒未到达）、会话计数一致性、独立强提醒、媒体发送、出站翻译、托盘/Dock/任务栏、安装升级、更新器、截图标注、OCR、纠错、快捷键、自启、深链、诊断包、崩溃恢复 |

### 1.3 外部阻塞（不是代码能单独解决的）

沿用 04 §5.1 的 E1–E8：忙账号禁止出站（E1）、服务端无幂等（E2）、通知/多角色契约未采（E3）、TSim 线上兼容（E4）、官方 Mac 桌面无法自动化对比（E5）、签名证书缺失（E7）、旧版订单入口重载异常（E8）。这些项对应 06 的决策点 X1–X8，实施前需用户拍板，见 §6。

---

## 2. 逆向结论 → 改造决定

每条写明：官方客户端的问题、vbk 当前状态、改造动作、自动化门禁。编号沿用 03/01/05 报告；门禁的数字口径以 §3 对应工作项为准。

| # | 官方问题（证据编号） | vbk 现状 | 改造决定 | 门禁 |
| --- | --- | --- | --- | --- |
| C1 | 渲染层热更新 http、不验签、特权加载（SUP-01/N-01，唯一 P0） | 前端内嵌二进制，无热更新路径 | **保持**：永不引入运行时替换前端；整包更新走 `tauri-plugin-updater` + minisign（I-19）。**待复核**：2026-11-02 实机显示当前运行的渲染脚本来自安装目录 `app.asar.unpacked/dist/`，而非 `Application Support/vbk-electron/dist/` 缓存，SUP-01「热更新目录特权加载」是否仍在生效需单独验证；不影响本决定 | CI grep：`app_data_dir` 下不出现可加载的 HTML/JS；更新端点为 https 常量 |
| C2 | 桥接层暴露通用 SQL、全账号 cookie、代发请求、任意下载；70 个处理器中 12 个有 sender 校验（9 处 `Rt` 放行 26 个本地页、3 处 `Ri` 只放行 login/launch/main），`downloadFile` 无校验，`executeDB` 的 `run` 仍可任意写（SEC-07/F-01/F-02） | 69 条窄命令，按窗口 capability 授权；远程页只有 adapter 7 条 | **保持并加门禁**：能力清单与授权矩阵、四方一致性测试、远程页渗透用例（I-02） | `contract-consistency.test.ts` 扩展；远程 capability 只含 7 条 adapter 命令 |
| C3 | 8 处关 `webSecurity`、关站点隔离、CSP 全通配、剥离服务端安全头、`eval`；imWindow `dangerouslySetInnerHTML` 30 处（Win 29），靠自写转义与 URL 白名单，无净化库（SEC-01~03/F-03/F-12） | CSP 严格；无响应头改写；正文全部文本节点渲染 | **保持并加快照测试**（I-02）；消除最后 1 处 `innerHTML`（I-29） | CSP 快照测试；DOM sink 门禁分阶段：B0「允许清单外零命中」，B1 I-29 移除后「允许清单清空 + 严格零命中」 |
| C4 | fuses 默认、生产可开 DevTools、插件开 CDP 端口（SEC-04/SEC-12/PLG-01） | `devtools` 为非默认 feature | **保持并加门禁**：release feature 检查、启动参数白名单（I-02） | release 包按 F12 不可开 DevTools（R02 实机断言） |
| C5 | 凭据明文、Cookie 不加密、日志打印整份配置（PRI-01/02/05） | `keyring` 存凭据；无统一脱敏器 | 新建 `core-diag` 脱敏器（I-10a）；数据目录与诊断包扫描（I-22） | 脱敏测试集 100% 掩码；数据目录扫描零命中 |
| C6 | 非 PROD 忽略证书、OCR 下载关 TLS、测试域名进生产包（SEC-06/SUP-02/PRI-04/F-07） | reqwest + rustls 默认；端点表含测试环境条目 | 发布构建只含生产端点；TLS 开关在类型层不可关；02 报告 32 个未收录域名逐个判定（I-24） | 产物字符串扫描不含 `fat/uat/fws/qa.nt` |
| C7 | IM 子进程崩溃守护计数为局部变量，每秒无限重启；四条重连路径叠加（SDK 5–10 秒随机无指数、imsdk.js 强制重连绕过延迟、渲染端 10 秒探测、30 秒状态重连）无统一状态机；会话列表 5 秒**增量**轮询（`startTime=lastUpdateTime`）不随可见性暂停（STA-01/02、F-06） | 无传输监督状态机；适配器 5 秒 poller 与官方页自身 loop 对同一端点双倍请求；无 `visibilitychange` | 新建**传输监督状态机**四级升级 + 指数退避 + 熔断，熔断计数在实例外部，被踢与鉴权失败为终态（I-05a/I-05b）；适配器**不在官方页节奏之外加轮询**，UI 层禁止自带重连触发器（I-06） | 属性测试：故障序列下重试间隔单调不减；请求频率口径见 I-06 验收 |
| C8 | 主进程同步 IO、两套 SQLite、迁移 SQL 可被替换（STA-04/STA-07） | JSON 文档 + 原子写；无 schema 版本；每条入站事实在全局锁内且在主线程 fsync | 持久化出主线程与合并写（I-04a）；加 `schema_version` 与内嵌迁移、B2 末 SQLite 决策门（I-25） | 故障注入按 I-25 故障模型 0 不可读文档；I-04a「锁内同步写路径清单」逐条断言（Cores 锁内路径全部移入持久化线程，主线程 fsync 计数 0） |
| C9 | Windows 全无签名、Mac entitlements 放宽、17 处 rpath 可抢占、仅 x86_64（SUP-03/SEC-05/N-05/N-07） | adhoc 签名，无 entitlements 文件 | 两平台全量签名、最小 entitlements、`cargo auditable`、体积记录（I-18） | `codesign --verify --deep --strict`、`spctl`、`signtool verify /pa`；`rea trace-dylib-resolution` 无可抢占路径 |
| C10 | 反自动化输入检测在客户端（FE-29/F-11）：评分规则存在（阈值 50），但官方桌面发送点**只埋点 `vbk_electron_rpa_content_blocked`，不拦截**；只覆盖编辑器 DOM 事件，程序化 `setContent` 不计入 | 适配器程序化发送直接走 SDK，绕过编辑器；出站翻译可回填草稿 | **不做任何规避**；B1 先在官方**网页版** bundle 中 grep 同类埋点并确认是否拦截；风险在服务端对埋点的风控统计而非前端拦截，出站翻译仍默认回填草稿由人确认（I-15，R11/X7）。**新证据（2026-11-02 实机）**：官方页另会 `POST 28967/reportInjectFnInfo {buildVersion,fnInfo}`，服务端回 `data.injectSwitch`，疑似上报页面被注入的函数；B1 须在受控账号上对比「注入前后」的 `fnInfo`，结论前不扩大注入面 | 代码门禁：不出现伪造 `isTrusted`、隐藏 `webdriver` 等逻辑（I-02 语法级检查） |
| C11 | 官方功能面（01 报告 88 个功能点，保留范围内约 60 个） | 文本/列表/历史/订单联系有代码；媒体、查看器、标注、OCR、纠错、快捷回复、服务端搜索为 C/D | 按 01 §3 清单逐项标注实现状态并进入 B2–B4（I-14、I-21、I-23、I-26、I-30） | 功能清单表每项都有测试与实机截图链接 |
| C12 | 官方客户端 744 MB、x86_64、Chromium 118 | 19 MB、arm64、系统 WebView | **保持优势**：release 工作流记录体积并对比上一次（I-18）；体积预算为**基线指标**，首轮实测后定；universal 合并列 B4（I-27） | release 工作流体积记录 |

---

## 3. 工作项清单

字段：每个工作项有且只有**改动位置**（遵守总计划第 4 节单写者规则，一项只归一个 owner；交叉文件以 §5.1 为准）、**现状**（可选）、**做法**、**验收**、**对应**（06 模块 / 旧任务编号 / 缺陷编号）。规模：S ≤ 1 人日、M 2–4 人日、L ≥ 5 人日，只用于排程，不是承诺。

**证据类型**（标题括号内标注，一项可多于一种）：**A** 代码门禁（CI 测试、lint，反例必红）；**B** 本地基准（指定机器、数据量与统计方法的可复跑脚本）；**C** 目标机读回（安装包在用户环境运行，对照官方网页或官方客户端读回）。**数字口径**：标「基线指标」的数字只记录不设门槛，实测两轮后再决定是否升为硬门槛；未标的为硬门槛，须写明测量对象、环境、采样窗口与统计方法，并注明来源。

### 批次 B0：门禁与夹具（先于一切实现）

#### I-00 门禁先绿（S，A）
- **改动位置**：`vbk/crates/core-notify/src/engine.rs:857`；`vbk/crates/core-assistant/src/{order.rs,session_import.rs}` 测试代码；`vbk/crates/core-account/src/credential.rs` 等 fmt 差异文件；`vbk/tsconfig.base.json:20`；`vbk/ui/tests/smoke/run.mjs:213,235-241`。不改 CI 工作流（归 I-02）。
- **做法**：修 clippy 13 错（测试代码的 `unwrap` 改 `expect` 或在测试目标放宽 lint）；`cargo fmt --all`；删除失效的 `/opt/node-tools` typeRoots；smoke 改为加载后显式点击 `.conv[data-gid="g-demo-1"]` 再等 `.msg`，并把 alarm/setting/login 用例改为互不阻塞。
- **验收**：本机与 CI 两平台 `vbk check` 全部 job 绿；此后任何 PR 以 CI 绿为前置。
- **对应**：R01 / QA。

#### I-01 修复 macOS 宿主测试夹具（S，A）
- **改动位置**：`vbk/src-tauri/src/assistant/browser_storage.rs` 测试模块；`Cargo.toml` 若需 `tempfile` 则向集成负责人提依赖变更。
- **做法**：测试夹具对临时目录先 `canonicalize()`，或改用 `/private/tmp` 下的专用目录；生产逻辑「拒绝符号链接祖先」不变。同时消除 `profile_name` dead_code 警告（非 Windows 分支明确 `#[cfg]`）。
- **验收**：macOS `cargo test --manifest-path src-tauri/Cargo.toml` 195/195；`cargo check` 0 警告。
- **对应**：R01 / D8。

#### I-02 源码级安全门禁（M，A）
- **改动位置**：`.github/workflows/vbk-check.yml`（开发 CI）；新增 `vbk/tools/gates/*.mjs`（Node 脚本，**只允许依赖已是 devDependency 的 `typescript`**，`vbk/package.json:21` 为 `6.0.3`）；新增 `vbk/tools/gates/dom-sinks.allowlist.json`；新增 `vbk/tools/gates/fixtures/`（正反例夹具）；`vbk/ui/apps/_shared/contract-consistency.test.ts`；新建 `vbk/src-tauri/tests/`。**不**改 `companion-card.ts`（归 I-29），**不**含产物阶段检查（体积、签名、架构归 I-18，mock 出包归 I-29，都只在 release 工作流执行）。
- **做法**：
  1. TLS 与调试开关门禁：扫描 `vbk/crates`、`vbk/src-tauri/src`、`vbk/ui/packages`、`vbk/ui/apps` 的**生产源码**（排除 `*.test.ts`、`*_tests.rs`、`#[cfg(test)]` 模块、`tools/gates/`、`docs/`）。**扫描方式**：TS/JS 一律用 `typescript` 编译器 API（`ts.createSourceFile` + `forEachChild`）做 AST 级扫描，命中以节点种类判定（属性赋值 `PropertyAccessExpression` 的左值、`CallExpression` 的被调用者、`ObjectLiteral` 的属性名），**注释与字符串字面量天然不命中**；Rust 侧无 AST 依赖，用词法扫描：先剥离 `//`、`/* */`、`///` 注释与字符串/原始字符串字面量，再按标识符边界匹配，并要求 `#[cfg(test)]` 块整体跳过（按大括号配对）。目标：`danger_accept_invalid_certs`、`ignore-certificate-errors`、`rejectUnauthorized`、`remote-debugging-port` 零命中；R11 相关的 `isTrusted` 伪造、`navigator.webdriver` 改写以**语法级**检查（对 `isTrusted`/`webdriver` 的赋值、`Object.defineProperty` 第二参数为这两个名字）而非字面量 grep（G-SEC-2、R11）。
  2. CSP 快照测试：读取 `tauri.conf.json`，断言无 `*`、无 `unsafe-eval`、`frame-src 'none'`（G-SEC-4）。
  3. 四方一致性与能力矩阵：`ui/packages/ipc/src/commands.ts` ↔ `src-tauri/commands.txt`（本日 73 条非空行）↔ `lib.rs generate_handler!` ↔ `capabilities/*.json` ↔ `views.rs`。**矩阵来源**：构建期由 `tools/gates/capability-matrix.mjs` 直接解析 `vbk/src-tauri/capabilities/{adapter,login,main,package-detail,popups,setting,update}.json` 生成「命令 × 窗口 label/webview 通配 × remote.urls」矩阵，写入 `src-tauri/gen/capability-matrix.json`（构建产物，不手写）；与 `views.rs` 的 label 清单（`MAIN`/`LOGIN` 常量 `views.rs:13,17`，`acct-*` 远程 webview）做**双向比对**：矩阵中每个 label 必须在 `views.rs` 注册，`views.rs` 每个 label 必须至少出现在一个 capability 中；再断言 `adapter.json` 的 `remote.urls` 只含两个官方 https 源且 `permissions` 只含 5 条 `allow-adapter-*` + 2 条 event（本日核对 `capabilities/adapter.json`），即远程面不超过 7 条；且没有命令同时具备「任意路径/任意 URL/任意 SQL」参数形态（G-SEC-5）。词根黑名单只作提示，不作失败条件。
  4. DOM sink 门禁（**分阶段**）：`tools/gates/dom-sinks.mjs` 以第 1 条的 AST 方式检查 `innerHTML|outerHTML|insertAdjacentHTML|document.write|srcdoc|eval(|new Function|javascript:`（`javascript:` 只在字符串字面量作为 `href`/`src` 属性值或 `location` 赋值时判定）；测试文件中的 `new Function`（如 `ui/apps/main/conversation-business.test.ts:27`）因范围排除天然不命中。**B0 阶段**：读取显式允许清单 `tools/gates/dom-sinks.allowlist.json`，每条记录 `{file, line, sink, expires: "B1/I-29"}`，初始**唯一**条目为 `ui/apps/main/companion-card.ts:70`（`element.innerHTML = <svg …>`，本日核对为生产源码中唯一 DOM sink）；门禁规则为「允许清单外零命中」，且允许清单条目若在源码中已不存在则门禁**失败**（防止清单腐化）。**B1 阶段**：I-29 改掉 `:70` 后由 I-29 提交把允许清单清空，门禁自动进入「严格零命中」，并断言允许清单为空数组。CJK 字面量门禁归 I-29。
  5. DevTools 与启动参数：断言 release profile 不含 `devtools` feature（读 `Cargo.toml` 与构建命令），并在 release 构建的实机冒烟中尝试 F12 与右键（归 R02 证据 C）；启动参数白名单单元测试（G-SEC-6）。
  6. CI 宿主 job 从 `cargo check` 升级为 `cargo test`（双平台）。
  7. 口令类门禁：store schema 测试断言无口令字段；任何「记住密码」类功能不得把口令落盘（官方 PRI-01 根因是 `rememberPassword` 默认开）。
- **验收**：①每类门禁各有 `tools/gates/fixtures/<gate>/{must-fail,must-pass}/` 夹具：**故意漏报（must-fail）≥ 3 个**（如 `el["inner"+"HTML"]` 计算属性、`Object.defineProperty(navigator,"webdriver",…)`、Rust 中跨行的 `danger_accept_invalid_certs(\n true)`）与**故意误报（must-pass）≥ 3 个**（注释中的 `innerHTML`、字符串 `"use innerHTML sparingly"`、`#[cfg(test)]` 内的 `rejectUnauthorized`），门禁对前者必红、对后者必绿，夹具本身在 CI 中作为门禁自测运行；②故意在生产源码引入每一类反例，开发 CI 必须失败；③全部通过后两平台绿；④对现有测试代码与文档零误报；⑤B0 退出时 DOM sink 门禁状态 =「允许清单 1 条、清单外零命中」，B1 I-29 合入后 =「清单空、严格零命中」。
- **对应**：H01、M02、R01 / FND-04 / SEC-01~07、F-03、F-12、PLG-01。

#### I-03 契约版本握手（S，A）
- **改动位置**：`vbk/crates/contracts/src/lib.rs`；`vbk/ui/packages/ipc/src/contracts.ts`；`vbk/src-tauri/src/commands.rs`。
- **做法**：`CONTRACT_VERSION` 常量两侧镜像；窗口首次调用携带版本，不一致时宿主拒绝该窗口全部命令并写诊断；补齐审查遗留（`HideAll` 账号字段、`unread_count` 占位）。
- **验收**：`cargo test -p contracts` 每个公开类型有 JSON 往返；版本不一致的集成测试被拒绝。
- **对应**：M01 / FND-02。

#### I-04a 持久化出主线程与合并写（M，B）
- **改动位置**：`vbk/src-tauri/src/state.rs`（`push_fact` `:172-241`、`persist_compensation` `:246-268`、`pump_rounds` `:285-310`、`persist_rounds` `:315-343`、`resync_complete` `:401-424`、`logout` `:506-531`、`restore_rounds_for` `:354`）、`vbk/crates/core-store/src/`（新增 `queue.rs`：快照序号、写队列、状态通道；`file.rs` 加测试用 fsync 计数钩子与 fail point）。**不改 `adapter.rs`、`login.rs` 的任何命令签名**（本轮核实后撤回第三轮「三条命令改 async 属性」的做法，理由见做法第 4 条）。
- **现状（本轮按调用链核实）**：`adapter_push_fact`（`adapter.rs:1069-1070`，同步 `#[tauri::command] pub fn`，在 Tauri 主线程执行）→ `HostState::push_fact`（`state.rs:172`，`:176` 起持 `Mutex<Cores>` 直到函数返回）→ 锁内两处同步写：`persist_compensation`（`:203` 调用，仅 `CompensationSync` 事实）与 `pump_rounds→persist_rounds`（`:240→:309→:315`，每条事实）。两者都经 `FileStore::commit`（`core-store/src/file.rs:202-211`：load→apply→`save` `:178`→`write_atomic` `:249-272`，每次 commit `sync_all` `:259` + `sync_directory` `:264` = **2 次 fsync**）。**fsync 数量按清单核实**：普通消息事实 = `persist_rounds` 对每个有可持久化 round 的 namespace 各 1 次 commit，双账号 2 × 2 = 4 次；`CompensationSync` 事实再加 1 次 commit = 6 次；首次创建目录另有 `create_durable_dir_all`（`file.rs:318-330`）的目录 fsync。第三轮「约 6 次」只对补偿事实成立，已改为上述口径。这与官方 STA-04 同构，是 1 Hz 调度抖动的真实来源。
- **锁内同步写路径清单**（Cores 锁 = `state.rs:140-145` 的 `HostState::lock`；本清单是验收的逐条断言对象）：

  | # | 函数 | 文件:行 | 触发者（命令/路径） | 持哪把锁 | 当前线程 | 每次 fsync | 处置 |
  | --- | --- | --- | --- | --- | --- | --- | --- |
  | W1 | `persist_compensation` | `state.rs:246-268`，调用点 `:203` | `push_fact`（`:172`）← `adapter_push_fact`（`adapter.rs:1069`），仅 `CompensationSync` 且 `report.applied` | `Mutex<Cores>` | 主线程 | 2 | **移入队列**：锁内只取 `(Namespace, cursor_ms)` 快照 |
  | W2 | `persist_rounds` | `state.rs:315-343`，由 `pump_rounds` `:309` 调用 | `push_fact`（`:240`）、`resync_complete`（`:422`）、`logout`（`:529`）；对应 `adapter_push_fact`、resync 命令、退出登录 | `Mutex<Cores>` | 主线程（`logout` 视调用方可能为事件线程） | 每个 namespace 2 | **移入队列**：锁内只生成 `HashMap<Namespace, Vec<RoundRecord>>` 快照 |
  | W3 | `login::persist`（`write_atomic` `login.rs:196-204`，`fs::write`+`rename`，**无 fsync**） | `login.rs:167-194` | `persist_and_emit`（`:321`）← `account_set_remark`（`login.rs:1102-1103`；Cores 锁在 `:1115` 语句末即释放，写盘时不持 Cores 锁）、`:819,998,1059,1350,1397,1449` | 写盘时只持 `LoginState` 锁（`:183`），Cores 锁仅在 `:171` 只读快照 | 主线程或事件线程 | 0（I-25 换带 fsync 的公共 `write_atomic` 后为 2） | **不进 I-04a 范围**（当前不产生 fsync）；B3 I-25 换 `write_atomic` 时由 I-05b owner 同步改为向本队列提交 `AccountIndex` 作业，避免把 fsync 搬回主线程 |
  | W4 | `PrefsModule::save` | `prefs.rs:346-362` | `sync_reminder`（`:446-458`，每个调度 tick 由 `scheduler.rs:131` 调用，仅在变化时写）、`:488-497`、`:540-548` | prefs `Inner` 锁（`m.data()`） | 调度线程/命令线程 | 0 | 不进队列（低频、非 Cores 锁）；I-20 换 `write_atomic` |
  | W5 | `display.rs` 置顶表 `save` | `display.rs:1025-1030`→`write_atomic` `:1033-1043`（无 fsync） | 置顶变更 | display 自身锁 | 命令线程 | 0 | 不进队列；I-25 就地改 |
  | W6 | `OutboundJournal` 各 `commit` + `durability_barrier` | `outbound_journal.rs:148-150`（→`sync_namespace` `file.rs:66-78`） | `im_send_text`（`adapter.rs:1358`）、`im_send_media`（`:746`），均为 `pub async fn` | journal `Mutex` + `.writer.lock` 文件锁 | tauri 异步运行时工作线程 | commit 2 + barrier 2 | **保持同步，不进队列**：fail-closed 语义要求「写入落盘先于发送」；不在主线程 |

  `adapter_ready`（`adapter.rs:1023-1024`）**不涉及任何持久化写**：它只调用 `state.compensation_watermark`（`state.rs:270-283`，锁内对 store 做一次只读 `load`）与 `epoch.fetch_add`，因此从异步化列表删除；其锁内磁盘**读**记为基线测量项（每次 ready 1 次 `load`），不设门槛。
- **做法**：
  1. `core-store` 新增 `PersistQueue`（**std-only**：`std::thread::Builder::new().name("vbk-persist").spawn` 一个专用持久化线程 + `std::sync::mpsc::sync_channel`，有界，容量 256 作业）。作业 `PersistJob { ns, seq: u64, payload: Rounds(Vec<RoundRecord>) | Compensation(i64) }`，`seq` 由 `AtomicU64` 在锁内分配（单调）；线程按 namespace 保序，同 namespace 多个待写作业只写最新（合并写），到达时 `seq` 小于已写 `seq` 的作业丢弃；每个作业完成后向状态通道回执 `(ns, seq, Ok|Err)`。
  2. `persist_compensation`/`persist_rounds` 改为纯内存函数 `collect_compensation_snapshot(&Cores)`/`collect_round_snapshots(&Cores)`，返回作业；`push_fact`/`resync_complete`/`logout` 在 **`drop(cores)` 之后**调用 `queue.try_enqueue(jobs)`。`try_enqueue` 不阻塞：队列满时把作业合并进 `Cores.pending_persist: HashMap<Namespace, PersistJob>`（下一个调度 tick 在锁外重试），因此命令线程永不等待磁盘。
  3. 写失败（磁盘满、权限）由调度 tick 消费状态通道写入 `Cores.persist_failed`，UI 显示「本地保存失败」且发送屏障关闭（与 outbound journal 的 fail-closed 一致）；退出与崩溃路径：`on_exit` 先发送 `Flush` 作业并等待回执（上限 5 秒）再返回，panic hook 尽力 flush。
  4. **命令签名不变**：`adapter_push_fact` 改造后锁内无 IO、入队为 O(1) 非阻塞，无需 `async fn`；`account_set_remark` 的写盘本就在锁外且当前无 fsync（W3），其 fsync 化在 B3 随 I-25 走队列；`adapter_ready` 无写路径。若实现期间发现某命令仍需等待磁盘，必须改为 `async fn` 并通过 `tauri::async_runtime::spawn_blocking`（项目已在 `assistant.rs:168` 使用）执行，且在 §5.1 登记，不得静默改 `#[tauri::command(async)]`。
- **验收**（本机 Apple M 系列与一台 Windows 11，双账号各 500 会话的夹具数据）：
  1. 基线：`persist_rounds`/`persist_compensation` 单次耗时分布与每类事实的 fsync 次数（按清单 W1/W2 计数），写入 `docs/research/`。
  2. **逐条断言**（调试构建，`FileStore` 注入 fsync 计数钩子记录 `(线程名, 调用栈顶函数)`；`HostState::lock` 置线程局部标记「持 Cores 锁」）：W1、W2 的每个触发者（`CompensationSync` 事实、普通事实、`resync_complete`、`logout`）各构造一次，断言 commit 发生在 `vbk-persist` 线程、持锁标记为假、主线程 fsync 计数 0；W3–W6 断言 fsync 计数与改前**相同**（证明范围外路径未被意外改动）。
  3. 并发与故障注入（**故障模型写明**，同一套夹具供 I-25 复用）：
     - 并发条件：两个 namespace 各以 100 作业/秒交错提交共 1 万次，同 namespace 人为乱序（`seq` 倒序入队）；判据：每个 namespace 读回的 `seq` 单调且 = 最后一次成功回执的 `seq`，0 次旧快照覆盖新状态。
     - 故障模型 A「进程终止」：`SIGKILL`（macOS）/`TerminateProcess`（Windows），在 `file.rs` 的三个 fail point 处由测试钩子触发（`write_all` 后 `sync_all` 前、`rename` 前、`rename` 后 `sync_directory` 前），每点位每平台 ≥ 17 次，合计 ≥ 100 次，均在上述并发写入期间触发；重启读回判据：每个 namespace `load` 成功、读回 `seq` ∈ [最后成功回执 `seq`, 最后入队 `seq`]、残留 tmp 文件被 `save` 清理（`file.rs:181-184`）且不影响 `load`。
     - 故障模型 B「文件系统错误」：`ENOSPC`（小容量 ramdisk/VHD）、`EACCES`（目录只读）、`EROFS`（只读挂载），各 ≥ 20 次；判据：回执为 Err、`persist_failed` 置位、旧文档仍可读、错误解除后下一作业成功并清除标记。
     - 故障模型 C「断电/设备缓存丢失」：**不可用进程终止模拟，不以 `kill -9` 代称**；写成设计属性「write-temp + `sync_all` + rename + 目录 fsync」（`file.rs:249-272` 已具备），用属性测试覆盖：以模拟文件系统把写操作序列在任意前缀截断，断言读回要么是旧文档要么是新文档、绝不是部分文档；平台测试：Windows 目录 `FlushFileBuffers` 需 `GENERIC_WRITE` + `BACKUP_SEMANTICS`（`file.rs:274-286`）在 NTFS 与 ReFS 各实测一次成功。
     - 平台覆盖：A/B 在 macOS 14+（APFS）与 Windows 11（NTFS）各跑一遍；0 次不可读文档为硬门槛。
  4. 1000 条/分钟入站压力下 1 Hz 调度抖动 p99（**基线指标**；06 H01 的 ≤ 50 ms 待两轮实测后再定）。
- **对应**：H01、M03 / SHL-02 / STA-04、G-STA-2。

#### I-04b 锁拆分与锁外 emit（M，B1，A+B）
- **改动位置**：`vbk/src-tauri/src/state.rs`（锁结构）、`scheduler.rs`（只取 notify 锁，接口由 I-10 owner 接入）、`adapter.rs:517-535,550-566`（`apply_agent_status`、`expire_agent_statuses` 持锁 `emit_agent_status_event`，由 I-05b owner 在 supervisor 合入后执行）。
- **做法**：先解开持锁 emit；再按服务拆分 account / im / notify / prefs，调度器只取 notify 锁。
- **验收**：锁顺序文档化并有死锁检测测试（任意两把锁的获取顺序固定）；I-04a 的抖动基线指标在此项后复测。
- **对应**：H01 / SHL-02 / STA-04。

### 批次 B1：能替代日常客服（P0，关键路径）

#### I-05a 隐藏 WebView 节流原型（S，B1 关口 1，C）
- **改动位置**：新建 `vbk/tests/soak/throttle-probe/`（独立探针页与记录脚本），不改宿主生产代码。
- **做法**：在与生产相同的隐藏 WebView 配置下加载官方页，记录 SDK 5 秒 ping 的实际周期、`xmppClient.status` 变化与 `getRecentMessages` 调用间隔。
  - **测试矩阵**：平台 = macOS 14、macOS 15（WKWebView）、Windows 11 23H2（WebView2 Evergreen 当前版）；官方页变体 = `vbooking.ctrip.com` 与 `imvendor.ctrip.com`（`capabilities/adapter.json` 的两个远程源）**各跑一遍**；窗口状态 = 主窗前台、最小化、被遮挡、隐藏到托盘，各 30 分钟；每个（平台 × 变体 × 状态）格 ≥ 360 个 ping 样本；**每平台重复 2 轮**（不同日，取较差一轮）；探针账号在所有格中为同一账号（X4 提供）。
  - **在线真值**（判定「服务端在线」的独立来源，三者**同时成立**才算在线）：(a) 对照账号（与探针账号不同，避免 resource 互踢）在同机普通浏览器前台标签在线，其 SDK ping 在同一 30 秒窗口内成功；(b) 探针进程外的 Node 脚本用探针账号 cookie 调服务端 HTTP `getRecentMessages`，同窗口内返回 200 且 body 可解析；(c) 探针机到网关的 ICMP/TCP 探测成功。三者任一失败的窗口**剔除**不计样本（归因为服务端故障或网络中断，单独记数）；三者成立而探针 `xmppClient.status` 连续 ≥ 20 秒为断线，记 1 次「误判」（SDK 状态滞后归入误判，因为它正是 I-05b 要监督的对象）。若 X11 判定同账号并用为支持场景且 resource 冲突已解决，(a) 可改为同账号对照。
  - **异常注入**（每格各 3 次，样本单列，不计入 p95）：断网 60 秒（`pfctl`/`netsh` 丢包 100%）、附加 2 秒延迟 60 秒、对 ping 请求在 fetch 钩子注入超时（模拟服务端无应答）。
  - **统计口径**：样本 = 相邻两次 ping 发出时刻之差（`performance.now()`），p95 用 nearest-rank；最大值 = 剔除睡眠窗口与注入窗口后的最大样本；睡眠样本（睡眠 10 分钟唤醒 3 次）只用于「唤醒后 60 秒内恢复节奏」判定，**不并入** p95/最大值。
- **验收**（分两层）：
  - **试验目标**（记录、对比，不阻断）：ping 周期 p95 ≤ 7 秒、单次最大 ≤ 15 秒、误判每 30 分钟 ≤ 1 次、唤醒后 60 秒内恢复 3/3。这些数值来自 SDK 标称 ping 5 秒与「3 次无应答」看门狗的推算，**没有产品依据**，是否升为硬门槛由 X15 决定。
  - **停止条件**（唯一硬门槛）：任一格出现 p95 > 15 秒，或误判 ≥ 3 次/30 分钟，或唤醒恢复 0/3。触发后先试 I-05b 做法第 4 条的保活实验分支复测一次；仍触发则**停止 I-05b 的实现**，触发 X3，由用户在「范围外评估 sidecar」与「接受有限实时性并明示用户」之间决策，计划不自动切换。
  - 产出：每格的 p50/p95/max、误判次数、剔除窗口数与归因，写入 `docs/research/` 并作为 X15 的输入。
- **对应**：H03 / R1。

#### I-05b 传输监督状态机（L，C，整个计划的第一风险点）
- **前置**（三条都可机检）：①I-05a 未触发停止条件；②**X11 已决**（路线决策门，见 §6）；③**服务端 resource 冲突确认记录已存在**：文件 `docs/decisions/2026-11-xx-sdk-resource-conflict.md`，内容为 X11 的判定与（若判定支持）服务端对 resource 策略的确认或冲突可解决的证明，（若判定不支持）产品明示限制的文案；文件不存在则 I-05b 不得开始。SDK resource 为 `clientSource|pc-<appId>-<ver>_1.3.1`，隐藏页与用户自己开的网页标签 resource 相同，服务端会 `Replaced by new connection` 踢掉其一且 SDK 不再重连。
- **改动位置**：`vbk/src-tauri/src/adapter.rs`（拆出 `adapter/supervisor.rs`）、`login.rs`（WebView 重建，`:494-547` `on_login_candidate`、`:548` `open_account_webview`）、`profiles.rs`（`:165-199` `open_profile_window`）、`ui/packages/web-adapter/src/boot.ts`。健康度字段通过契约变更由 I-04a/I-04b owner 加进 `state.rs`；「消息通道异常」提示的 UI 由 I-28 owner 在 `ui/apps/main/` 接入。
- **现状**：`adapter.rs` 全文没有心跳、最后事实时间阈值、reload 或重建；唯一超时是登录期 45 秒与 agent 状态租约。内容进程被杀或 SDK 挂死后，`request()` 15/20 秒超时，事实停止流入，账号仍显示 online，直到用户手动重登。
- **做法**：
  1. 核心层产出健康度信号：最后事件时间、补偿次数、跳号次数、SDK 状态。一级信号订阅 `window.xmppClient.status` 与连接事件（`sdkGlue.ts` 已轮询重绑），不只靠自建计时器。
  2. 宿主四级升级：心跳超时 → 页内补偿 → 重载官方页 → 重建 WebView；阈值对齐官方 SDK（ping 5 秒、3 次无应答约 20 秒、未连接 60 秒）；每级指数退避 + 抖动 + 熔断计数，**熔断计数在实例外部**（对照官方 STA-01 局部变量清零的反例）；熔断后 UI 显示「消息通道异常」并保留手动重试。最小可行版本先交付「`last_fact` 超时 → reload → 重建」闭环，再做四级与节流对策。
  3. **终态不重连**：KICKED_OFFLINE_BY_OTHER_CLIENT（`Replaced by new connection`）、XMPP_AUTH_FAILED、CURRENT_TOKEN_UNAVAILABLE、HTTP `AccountsMobileRequestFilterException` 交 I-13 的账号状态机，不计熔断；`navigator.onLine=false` 时暂停计数。
  4. 后台保活（**实验分支，不是默认做法**）：WebView2 对官方页 WebView 传 `--disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows`（需先确认 Tauri 2 的 `additional_browser_args` 只作用于该 WebView 的环境，并记录实际生效证据）；macOS 官方页 WebView 挂在不可见但不 occluded 的窗口，评估 `NSProcessInfo.beginActivity`。每个开关须有：对照组数据、资源观测（隐藏态 CPU 均值与 RSS 对比对照组，同机同窗口 30 分钟均值，测量脚本 `tests/soak/throttle-probe/resource.mjs` 每 5 秒采样 `ps`/`Get-Process`，误差预算 = 对照组自身两轮之差）、失败回退（开关可由偏好关闭）。「CPU ≤ 对照 + 2%、RSS ≤ +50 MB」改为**基线指标**（第三轮数值无产品依据且在低 CPU 基线下受噪声支配），门槛由 X22 在首轮观测后定；在 X22 决定前，仅「开关可关闭且关闭后与对照组行为一致」为合入条件。
  5. 补偿闭环：重连、唤醒、网络恢复、页面重建后，按官方口径补偿起点 = now − 2 分钟并切 5 秒频率，会话列表 `startTime` 置空全量拉一次；HTTP 补偿连上 5 分钟自停后，页内补偿需自行调用 `getRecentMessages` 并按 msgId 去重。
  6. 官方页版本指纹：记录构建 hash 与 SDK 版本（网页 1.0.70 ≠ 桌面 1.0.24，行为以网页实测为准）；依赖对象缺失进入降级模式并上报。
  7. **恢复边界**（重载官方页 / 重建 WebView 前后的用户操作保护，与 I-14 的 `unknown` 态接口对齐）：
     - 重建前：监督器先把该账号置为 `draining`，宿主拒绝新的 `im_send_*`/上传命令（返回 `im.channel_recovering`，UI 显示「消息通道恢复中」并禁用发送按钮），等待 outbound journal 中处于 `started`/`uploading` 的记录完成或超时（上限 10 秒）。
     - 进行中的发送/上传：超时未完成的一律按 I-14 的规则转 `unknown`（不重放），恢复后在 `unknown-outbound.ts` 面板要求用户核对后手动决定重发；草稿按 I-09 已持久化，不受重建影响。
     - 恢复期间**禁止自动重放**：补偿闭环（第 5 条）只拉取入站，不触碰 outbound journal；`replay_media`/文本重发只能由用户在核对面板触发。
     - 状态机测试：`draining → rebuilding → compensating → online` 每条边有单测；`draining` 期间收到发送命令必须被拒。
- **验收**（R02 报表，测量平台见 I-11；I-10a 的日志先落盘以便取证）：
  1. 长稳：双账号 72 小时，受控对端对**每个账号**每 2 分钟 1 条（每账号约 2160 条，有效样本 ≥ 2000 条/账号，排除对端自身发送失败）；**丢失** = 72 小时结束后仍未出现在 vbk 的消息；**迟到** = 到达延迟 > 60 秒但最终到达，单列不计丢失；要求丢失 0。
  2. 延迟：端到端到达延迟 = vbk 事实时间戳 − 对端发送时间戳（两端用 I-11 的校时）。官方基线由 R02 在**同一台机器、同一批账号、同一时段**用官方网页版采集；硬门槛 p99 ≤ 10 秒（来源：06 R1 触发条件）；「p95 ≤ 官方 p95 + 1 秒」为基线指标。
  3. 窗口状态：最小化、被遮挡、隐藏到托盘各 1 小时，与前台 1 小时的 p95 差 ≤ 1 秒。
  4. 恢复（**故障模型写明**）：睡眠 10 分钟唤醒 30 秒内补齐；断网 5 分钟恢复 60 秒内补齐；**人为崩溃官方页**的故障模型 = (i) 杀死该 WebView 的内容进程（macOS `kill -9` WebContent 子进程、Windows 结束 `msedgewebview2.exe` 对应渲染进程），(ii) 页内 `window.stop()` + 注入 SDK 挂死（`xmppClient` 方法替换为永不返回），(iii) 宿主侧 `webview.close()` 模拟进程失败回调，各 ≥ 7 次合计 20 次，每次在有一条 `started` 出站记录时触发；判据：20/20 在 90 秒内重新收到事实，重试间隔单调不减至上限，进行中的出站记录 20/20 转 `unknown` 且 **0 次自动重放**（读 journal）。这 20 次是**抽样验证**，不替代下一条属性测试。
  5. **状态机属性测试（A 类，始终执行，不依赖 X11）**：对监督器状态机做属性测试——任意故障序列下重试间隔单调不减且不超过上限；熔断计数跨实例保留；`KICKED_OFFLINE_BY_OTHER_CLIENT`、`XMPP_AUTH_FAILED`、`CURRENT_TOKEN_UNAVAILABLE`、`AccountsMobileRequestFilterException` 四种终态进入后重连尝试恒为 0，且不计熔断；`navigator.onLine=false` 期间计数冻结。**此条进 B1 退出条件**。
  6. 互踢实机（两个独立结论，**仅在 X11 判定「支持」时执行**；X11 判定「不支持」时以第 5 条的终态属性测试 + 1 次被踢提示文案的实机截图替代）：同账号同时在浏览器打开官方网页 1 小时，(a) **无重连风暴**：被踢后 1 分钟内 UI 提示、监督器进入终态、1 小时内重连尝试 0 次；(b) **业务连续可用**：只在 resource 冲突已解决时要求。
  未达标触发 X3。
- **对应**：H03、U02、M06 / IM-02、IM-05、IM-08 / STA-01、STA-02、D3、V3、V9。

#### I-06 适配器请求节奏与可见性（M，A+C）
- **改动位置**：`ui/packages/web-adapter/src/{conversationList.ts:132-198,compensation.ts:63-64,boot.ts,pageContext.ts}`、`docs/api/transports.md`。
- **现状**：适配器 5000 ms 会话列表 poller + 5000 ms 补偿循环（300 s 后停止），只在 `boot.ts:371` 的 `pagehide` 停止；官方页自身 `startLoopConvList`（5 秒增量，`startTime=lastUpdateTime`，有返回时再拉 `getRemarkList` 与 `getConversationInfoByGidList`）同时在跑，对 `16037/getConversationList` 双倍请求，多账号线性放大。
- **做法**：boot 阶段用 fetch 钩子统计官方页对 16037 的调用频率；官方 loop 活跃时适配器 poller 退化为「仅消费官方响应」（`pageContext` 钩子已能看到 body）；否则自跑并加 `document.visibilityState` 门控与指数退避。补偿循环「300 s 后停止」改为可配置并做故障注入后定默认值。「坐席 3 秒轮询」只在排队消息 `NBZ11` 出现时存在，不作为全局节奏（2026-11-02 实机证实）；另有已选中且未结束会话每 3 秒一次的 `getSessionEmpathyPhraseInfo`，计数类别需加入下方口径。**六轮实机补充**：每次打开会话官方页自动调用 `batchTranslateByMsgIds`（第二轮 31 次开会话 31 次）与 `getRemarkList`/`queryToken`/`getOrderDetailsForVbk` 一组；`s.c-ctrip.com/bee/collect` 埋点约每 1–2 秒一次，计数时归为 `telemetry` 类单列不计入业务节奏。**已读回执节奏**（第五轮）：官方由 IM 子进程以 Node HTTPS 发 `11679/PutAdviceOfReadByMsgId`，按会话只带**最后一条**对方消息的 `msgId`（游标式，非逐条），且同一次打开会话重复发 2 次；vbk 的 `web-adapter/src/markRead.ts` 经页面 SDK 发同一接口，须保持「按会话取最后一条对方消息」且对同一 `msgId` 去重，不得逐条补发。**IM 帧回传**（第三轮）：官方 IM 进程对服务端每条随 `chat` 推来的 `iq set` 回一条约 1 KB、携带整条消息体的 `iq error service-unavailable`（173 次/10 分钟），属无意义上行；vbk 使用的网页 SDK 是否同样回传需在 I-05a 原型期用帧日志确认，若是则在适配器层记录为缺陷并提给集成负责人，不自行改 SDK 协议。
- **验收**（R02 抓包 + 页内 fetch 钩子双记录；**计数口径**：按「账号 × 请求路径 × 1 分钟时间桶」计数，路径分 `getConversationList`、`getRemarkList`+`getConversationInfoByGidList`、`getRecentMessages`、`getSessionEmpathyPhraseInfo`、`batchTranslateByMsgIds`+`queryToken`+`getOrderDetailsForVbk`（开会话组）五类，`PutAdviceOfReadByMsgId` 与 `bee/collect` 另列不计入总量，重试计入，发起者由 fetch 钩子标记为 `official`（官方页调用栈）或 `adapter`（适配器调用栈）并与抓包按时间戳对齐）：
  1. **硬指标（独立）**：官方 loop 活跃的每个时间桶内，`adapter` 发起的 `getConversationList` 计数 = 0（30 分钟 30 个桶全部为 0）。
  2. 官方 loop 不活跃时（如 `startLoopConvList` 被官方页自身停止），`adapter` 请求的最小间隔 ≥ 5 秒（硬，来源官方标称间隔）。
  3. 隐藏态 10 分钟内 `adapter` 自发请求数 ≤ 前台 10 分钟的 20%（仅当 ② 生效时适用；硬，来源为可见性门控的设计意图）。
  4. **基线指标（替代第三轮的总量 ±5%）**：对照配对采用 A–B–A：同机同账号「官方网页独立运行 30 分钟 → 带适配器 30 分钟 → 官方网页独立运行 30 分钟」，对照值 = 两段官方段同一分钟序号桶的均值；差值 = 带适配器段每桶计数 − 对照值，报告中位数与最大值。它额外验证的目标是「仅消费官方响应」没有诱发官方页自身的连带请求增加（如 `getRemarkList` 因适配器触碰状态而多发）；是否设门槛待两轮数据后定。
  5. 代码审查（A）：不存在官方节奏之外的定时器；已读回执单测：同一会话同一 `msgId` 只发一次、按最后一条对方消息发送；fetch 钩子的可观测性测试：对官方页三类路径各构造一次调用，钩子 100% 捕获请求与响应顺序（否则「仅消费官方响应」不可实现，需回退为自跑 + 门控）。
- **对应**：U02 / F-06、STA-03、R7。

#### I-07 会话计数口径与聚合（M，C，需 X1）
- **改动位置**：新增 `docs/decisions/2026-11-xx-conversation-count-semantics.md`；`vbk/crates/core-im/src/im_core.rs`；`ui/apps/main/viewmodel.ts`；新增 `vbk/tools/count-compare.mjs`。
- **做法**：先写口径文档，由用户确认采用哪个口径；再按口径实现聚合；提供每小时采样对比工具。差异来源已从官方代码定位：官方桌面初始化列表 = 服务端全量 ∪ 本地 `conversationInfo`（不在服务端列表但 `lastUpdateTime` 30 天内的保留并置 `inGroup=0`，否则连消息一起删），之后按 `startTime=lastUpdateTime` 增量；主进程每日清理 `status=4` 且超过 `chatCacheDays`（默认 180）的会话。这解释了官方桌面 11/24 与官方网页 11/9 的差异；官方后台 AX 20/1959 是另一入口（BC/BOP 分栏），未读数聚合公式仍待追。
- **验收**：同一时刻同一账号，vbk 与所选口径的官方入口计数差为 0，连续 24 小时每小时采样。
- **对应**：M06、U03 / IM-06 / D2。

#### I-08 历史分页阅读位置保持（M，C，**并入 I-28 同一 owner 同一工作流**：先虚拟化接口，再接入锚点）
- **改动位置**：`vbk/crates/core-im/src/`（历史页合并后的行身份，由核心 owner 先行交付接口）、`ui/apps/main/{main.ts:1548-1612,history-layout.ts,history-diagnostics.ts}`（I-28 owner）；`ui/packages/web-adapter/src/history.ts` 只是 `getMessageList` 分页器，不在此项范围。
- **现状**：锚点是纯像素补偿（捕获可见行 `getBoundingClientRect` → 重绘 → 5 元组模糊匹配找行 → `scrollTop += delta`），状态只在 DOM dataset，依赖 `data-history-key` 唯一与同步布局读写；切会话或窗口重建即丢。
- **做法**：分层。核心层保证历史页合并后行身份（`message_id`/`local_id` + 页内序号）单调且唯一，去掉 UI 侧的模糊匹配；UI 把锚点 `{scope, key, offset}` 从 dataset 搬进 store，像素偏移留在 UI（只有 UI 知道行高）。官方实现可作参考：游标 `rangeMessage.lastMessageTime`、`direction:"prev"`、`pageSize:50`，锚点「首个可见 li + offset」在 `ResizeObserver` 回调恢复。保留 8192 容量滚动诊断。
- **验收**（二选一已定：**首轮为基线采样，不进 B1 退出条件**）：上翻 20 页，记录阅读位置偏移（偏移定义：原阅读行顶部与视口顶部的距离变化，以消息行计），每平台 ≥ 3 个会话各 10 次共 30 次为**首轮基线采样**，产出偏移分布（0 条 / 1 条 / >1 条各多少次）与失败场景描述；由用户在 **X13** 定允许失败率与偏移门槛后，本项才升为硬门槛并进入退出条件。I-28a 落地前的「像素补偿」旧实现同样跑一次 30 次采样作为对照。1 万条会话上翻 20 页的单帧耗时为基线指标（I-28a 定义）。
- **对应**：M06、U03 / IM-05 / D1。

#### I-09 草稿与未关闭缺陷回归（S，A+C）
- **改动位置**：`vbk/src-tauri/src/adapter.rs` 中的草稿命令（函数体改动排在 I-05b supervisor 合入后，由 I-05b owner 代为合入）、`core-store` draft 仓储（只用已有接口）、`ui/apps/main/viewmodel.ts`。
- **做法**：草稿按 `(account, conversation)` 持久化，进程切换不丢（D10）；核实 D4（机器人名 raw key）与 D5（server_id/local_id 合并重复、订单卡跨会话）是否已由后续提交修复，未修则补红→绿用例。
- **验收**：重启后草稿恢复 10/10；D4/D5 各有回归测试与实机截图。
- **对应**：U03、M03 / IM-06 / D4、D5、D10。

#### I-10 独立强提醒实机验收（M，C）
- **改动位置**：`vbk/src-tauri/src/{windows,scheduler}.rs`、`ui/apps/alarm/`、新增 `vbk/tests/soak/alarm/`（实机脚本与前台窗口断言）；`rodio` 依赖向集成负责人提变更。
- **做法**：提示音改为 Rust 侧播放（`rodio`），不依赖主窗 WebView（主窗隐藏时可能被节流）；Windows alarm 窗 `WS_EX_NOACTIVATE`，macOS `NSPanel` + `nonactivatingPanel`；多显示器定位主屏右下；前台窗口 API 自动断言不抢焦点；alarm 窗无发送入口（UI 测试）。顺带修 `scheduler.rs:135-141`（Windows 闪烁期间实际约 0.5 Hz）与 `state.rs:483-495`（`set_dnd_until_tomorrow` 按 UTC 日界 + 8 h，北京时间 16:00 解除）。
- **验收**（Windows 与 macOS 各 20 次；行为类为硬门槛，时间类为基线指标）：
  - **硬门槛（行为，二值可判）**：前台应用不变（前台窗口 API 读回）、连续客户消息不重置、只有确认回复才清除、点击后定位到正确会话、主窗隐藏时提示音 20/20 可听见（录音电平断言）。
  - **基线指标（时间，首轮只记录，门槛由 X22 定）**：「客户消息到 alarm 窗可见」的时延（第三轮的 30 ± 1 s 只有 03 分计划 A2 的 round 规则来源，没有说明消息到达时钟误差）、「睡眠 10 分钟唤醒后重算完成」的时延（第三轮的 5 s 无来源）。**测量脚本与误差预算**：`tests/soak/alarm/run.mjs` 记录消息服务端时间戳（I-11 校时）、宿主收到事实的单调时钟、alarm 窗可见的时刻（前台窗口 API 轮询 100 ms + 屏幕录制帧号交叉）；误差预算 = 1 Hz 调度 tick（≤ 1 s）+ 校时误差（I-11 报告值）+ 轮询 100 ms；睡眠场景以 `state.rs` 的 `ClockReading`（墙钟 + 单调钟双读）判定真实时长，报告中单列「唤醒后首个 tick 距唤醒事件」的时延。
- **对应**：M07、H05、U04 / NTF-03、NTF-06 / V4、V6。

#### I-10a 文件日志与脱敏器（S，A）
- **改动位置**：新建 `vbk/crates/core-diag/`（最小版）；`lib.rs`、`Cargo.toml` 的接线由集成负责人合入。
- **做法**：接入带轮转的文件日志（`tauri-plugin-log` 或 `log` + 自研输出），所有 `log::*` 经脱敏器。**脱敏策略为字段白名单 + 未知字段默认掩码**：日志统一走结构化宏 `diag_log!(level, event, { k = v, … })`，只有白名单键（事件名、账号 **哈希后 8 位**、gid 掩码形式、消息 ID、时间戳、错误码、数字计数、线程名、模块路径）按原值输出，其余键一律掩码为 `<redacted:类型>`；自由文本 `log::*` 仍可用，但整条经正则掩码器（ticket、cookie、手机号、订单号、邮箱、身份证号）并截断到 512 字符。**逐类策略**：账号标识（`buid`/`account_id`）→ 稳定哈希前 8 位（可跨日志关联、不可逆）；客户姓名 → 永不输出（白名单外）；消息正文 → 永不输出，只输出长度与 msgId；URL → 只保留 scheme+host+path，**查询参数整体剥离**（官方接口把 ticket 放在 query）；文件路径 → 只保留文件名与扩展名，目录以 `<dir>` 代替（用户名出现在家目录路径中）；堆栈 → 保留。
  - 容量：**上限 = 按 I-05b 72 小时实测日志量 × 1.5 定**，初始值 200 MB 为基线（I-05b 第一次 72 小时跑完后回写此处）；轮转为按大小 20 MB 一片、保留片数由上限推出；长稳期间若轮转掉故障前上下文视为 I-10a 失败并上调上限。
- **验收**：①脱敏测试集（每类敏感字段 ≥ 10 个样本，含 URL query 与家目录路径）100% 掩码；②未知键默认掩码有反例测试（新增一个未登记键必须被掩码）；③**敏感扫描覆盖轮转后的实际日志产物**：I-05b 72 小时结束后对数据目录内全部日志片（含已轮转、已压缩片）跑 I-22 同一套扫描器，零命中；④I-05b 的 72 小时长稳与「人为崩溃 20 次」能从日志取证（每次崩溃前 5 分钟的上下文仍在）。
- **对应**：M10、H11 / REL-01 / PRI-05。

#### I-11 R02 长稳与证据平台（M，B+C 的基础设施，依赖 X4）
- **改动位置**：新增 `vbk/tests/soak/`（受控对端机器人、延迟统计、报表）、`docs/research/` 证据包模板、`PROGRESS.md`/`BLOCKED.md` 同步规则。
- **做法**：用用户提供的测试账号做受控对端，按计划发送并记录发送时间；报表按账号、平台、窗口状态切分延迟分布与丢失；每批结束产出证据包（版本、hash、样本、读回截图，已脱敏）；同一机器测官方网页版基线（内存、冷启动、到达延迟）。官方**桌面版**基线复用 [tools/desktop-capture/capture.mjs](../../tools/desktop-capture/capture.mjs)（被动 CDP + IM 子进程 Node HTTP 钩子，只记字段结构与协议枚举，见实机截获报告「方法与边界」）；该工具卸载时曾误调 `app.removeAllListeners('web-contents-created')`，纳入 I-11 前须先修为只拆自己的监听。
- **验收**：每个工作项验收里的数字都能从报表或证据包追溯；PROGRESS/BLOCKED 与证据包同步。
- **对应**：R02 / QA-02~07 / 04 §7 风险 2。

### 批次 B2：有限试用（P1）

#### I-12 Windows 任务栏数字与系统 Toast（M，C）
- **改动位置**：`vbk/src-tauri/src/{scheduler,tray}.rs`，新增 `src-tauri/src/platform/{win_taskbar,toast}.rs`。
- **做法**：`ITaskbarList3::SetOverlayIcon` 渲染未读数字；Windows 注册 AppUserModelID、macOS `UNUserNotificationCenter`；Toast 点击定位到会话；关闭主窗时隐藏还是退出改为可配置（对照官方 STA-09）。
- **验收**：任务栏数字与未读总数一致；Toast 点击定位 10/10；托盘菜单与勿扰实机读回。
- **对应**：H05 / NTF-05、SHL-06 / V6。

#### I-13 账号 WebView 上限与登录异常态（M，A+C）
- **改动位置**：`vbk/crates/core-account/src/`、`state.rs` 账号状态机接口；`login.rs`/`profiles.rs` 的改动通过 I-05b owner 合入（§5.1）。
- **做法**：活跃账号 WebView 上限（默认 4，可配置）与非活跃回收（对照官方 STA-05 无上限）；登录失效、验证码、风控三类状态进入状态机，UI 在宿主收到失效事件后 60 s 内呈现「需要重新登录」，期间不提醒不发送；macOS 账号隔离用 `WKWebsiteDataStore(forIdentifier:)`（需 X2 最低版本决定）。
- **验收**：双账号重启免交互恢复 10/10；三类异常各 ≥ 1 个实机样本；任意交错登录/退出/失效/重启序列下旧代次事件 100% 被拒（场景测试）。
- **对应**：M05、H02 / ACC-04 / PRI-01、STA-05、G-ID-1。

#### I-14 媒体发送链路（L，A+C）
- **改动位置**：`vbk/src-tauri/src/{media_outbound,outbound_journal}.rs`、`ui/packages/web-adapter/src/{media,upload}.ts`、`ui/apps/main/composer-input.ts`。
- **做法**：图片 10 MiB、文件 30 MiB、视频 300 MiB 且 ≤ 3 分钟、单次 ≤ 10 文件的上传 → 发送 → 读回链路（限额来自官方实物）；视频分片 5 MiB、直传阈值 30 MiB；超限本地拒绝；`unknown` 不重放并提供人工核对入口（服务端无幂等，E2）；重发必须复用 `localId`（官方 socket → HTTP 回退同 localId）。**官方桌面实测（第三轮）**：文本主链路为 XMPP over WSS（`im3.ctrip.com:443`）`<message type="send">` → 约 0.15–0.21 秒收到同 id `send_result`，10 分钟窗口内未出现 `SendMessage.json`，与 `docs/api/send-ack.md`「XMPP 为主、HTTP 兜底」一致，发送不改传输；图片 = `16037/uploadTokenCreate {channel:"im_business",type:"img"}` → `nephele.ctrip.com/image/v2/api/upload`（头含 `Authorization`、`Content-MD5`）→ XMPP `send`；文件 = `nephele.ctrip.com/file/v1/api/upload?channel&public`，**无** `uploadTokenCreate`、无 `Authorization`。附件登记契约必须把图片与文件两种上传鉴权分别建模，不得共用一个 token 流程；撤回走 HTTP `11679/recallMessage {messageId,partnerId}`（19 位字符串），广播为入站 `groupchat`（带 `ext`），归 I-30b。顺手修 `outbound_journal.rs`：已完成记录加保留上限或时间窗（保留 unknown），`:274-279` commit 成功后 barrier 失败返回独立错误码而非 Unknown。**附件登记契约冻结**：本项第一个交付物是 `docs/api/media-attachment-contract.md`（含 `ATTACHMENT_CONTRACT_VERSION = 1`，`media_outbound` 的登记接口签名、`MediaAttachmentDto` 字段、错误码、`unknown` 态语义），冻结后用契约测试锁定；此后任何字段变更必须升版本号并通知 I-17 与 I-05b（恢复边界）。
- **验收**：①契约文件与契约测试先于其他验收交付（I-17 的前置）；②图片、文件、视频各 20 条（含边界值）20/20 发送并在官方网页读回；③发送中途杀进程 20 次 0 次重放；④文本 200 条 `confirmed` 服务端 ID 与官方一致；⑤`send_result` 到达时延分布记为基线指标，与官方桌面第三轮单样本（0.15–0.21 秒）并列呈现，不设门槛。
- **对应**：H04、U03 / IM-07、MED-01/02 / V1、V2、D6。

#### I-15 出站翻译真实调用与反自动化确认（M，C，R11 优先）
- **改动位置**：`ui/packages/web-adapter/src/send.ts`、`vbk/crates/core-assistant/src/translate.rs`、`vbk/src-tauri/src/assistant/`；`docs/api/inventory.json` 条目向集成负责人提变更。
- **现状**：官方桌面的反自动化检测只埋点不拦截（验证报告 §1）；vbk 程序化发送直接走 SDK，不经编辑器，不触发任何前端检测。风险在服务端对埋点的风控统计，不在前端拦截。
- **做法**：**第一步**在官方网页版 bundle 中 grep `rpa_content_blocked`/`instantInputSpikeCount` 同类埋点并确认是否拦截（只读）；无论结果，出站翻译默认「替换草稿、由客服本人确认发送」，不伪造输入事件。**第二步**（C10 新证据）：在受控账号上对比「注入适配器前/后」官方页 `28967/reportInjectFnInfo` 的 `fnInfo` 结构与 `injectSwitch` 返回，并记录入 `docs/research/`；若 `fnInfo` 因适配器注入而变化，X7 提前触发，结论前 I-30 各子项不得扩大注入面。该接口 `docs/api` 与 rea 均未收录，由 I-24 补录。官方边写边译接口为 `POST /11679/getMessageTranslate`，请求 `{sessionId,groupId,messageTxt,source:"AUTO",target,appId:"900004",bizType,timeoutInSeconds:10}`，防抖 500 ms，补进 inventory 作为候选；vbk 现用 `batchTranslateByMsgIds` 与之不同。
- **验收**：50 条受控样本两种模式与 TSim 返回 50/50 一致，0 次被官方拦截提示；翻译失败草稿不丢；翻译 p95 延迟为**基线指标**（同机 TSim 实测后定）；无规避逻辑由 I-02 门禁保证。
- **对应**：M08、H08、U02 / AST-03 / V5、F-11、X7。

#### I-16 macOS TSim 浏览器会话导入（M，C）
- **改动位置**：`vbk/src-tauri/src/assistant/browser_storage.rs`（macOS 分支）、`ui/apps/setting/`。
- **做法**：实现 Safari/Chrome 的 Cookie 读取（需用户授权）或提供手动导入路径；失败时引导手动导入；同时实机验证 `1f01e84` 的 CDR 卡片。
- **验收**：TSim 会话在 macOS 与 Windows 都能导入并重启恢复；套餐速览双平台各 10 个订单读回名称、供应商、APN 与 TSim 一致。
- **对应**：H08、M08 / AST-02、AST-06 / D7。

#### I-17 Windows 截图（M，C）
- **前置**：I-14 已交付并冻结附件登记契约（`docs/api/media-attachment-contract.md` 存在且 `ATTACHMENT_CONTRACT_VERSION` 已定）；契约未冻结前 I-17 只能做选区与遮罩部分，不得接入登记调用。
- **改动位置**：`vbk/src-tauri/src/shell.rs` 截图部分迁出到 `src-tauri/src/media/{capture_win,capture_mac}.rs`。
- **做法**：Windows 用 Windows.Graphics.Capture 或 `xcap`，每屏一个遮罩窗；macOS 保留 `screencapture -i` 作为过渡，后续评估 ScreenCaptureKit。**本项止于产出附件快照**（调用 I-14 已冻结的 `media_outbound` 接口登记附件），发送链路全部归 I-14，不改 `media_outbound.rs`、`upload.ts`、`media.ts`。
- **验收**：2 台显示器、100% 与 150% 缩放组合下选区像素误差 ≤ 1 px；快捷键到遮罩出现的时延为基线指标。
- **对应**：H07 / MED-03 / D6。

#### I-18 签名、公证、安装器与可追溯构建（L，C，依赖 X6 证书）
- **改动位置**：`.github/workflows/`（新增 release 工作流）、`vbk/src-tauri/tauri.{macos,windows}.conf.json`、新增 `vbk/src-tauri/entitlements.plist`、`Info.plist` 补充项。
- **现状**：本项拥有 **release 工作流**（与开发 CI 分离，只在打 tag 或手动触发时运行），产物阶段检查（体积记录与对比、`lipo -archs`、`codesign -d --entitlements` 为空、SBOM、I-29 的 mock 不出包）都在这里，不进 B0 的开发 CI；x86_64 构建支持归本项（I-27 只保留 universal 合并）。
- **做法**：macOS Developer ID + hardened runtime + 公证装订，**entitlements 默认为空**（Tauri 2 + WKWebView 的 JIT 在系统 WebContent XPC 进程，宿主不需要 `allow-jit`，更不需要 `disable-library-validation`、`allow-dyld-environment-variables`；只在 Keychain 共享等有实测需求时加对应项）；Windows Authenticode 覆盖 exe、NSIS 安装器与卸载器并加时间戳；`cargo auditable build`；二进制嵌入 commit；SBOM；`LSMinimumSystemVersion` 跟随 X2；只声明实际用到的 TCC 权限并用中文写用途（截图需屏幕录制权限，macOS 15 起周期性重授权）；**Intel 包**（官方只发 x86_64，用户群恰为 Intel 机，vbk 当前仅 arm64）；写明安装模式（官方 per-machine，vbk currentUser）与共存、企业分发策略；安装、升级、卸载在干净虚拟机脚本化。
- **验收**：`codesign --verify --deep --strict`、`spctl -a -vv`、`signtool verify /pa` 通过；`codesign -d --entitlements` 为空；`rea inspect-signature` 显示 Team ID 与 hardened runtime；`rea inspect-rust-binary` 能读出依赖；`lipo -archs` 含 arm64 与 x86_64（或分别出包）；干净机安装→升级→卸载通过且卸载后不残留凭据（需用户确认清除）。**基线指标**：正式签名包连续升级钥匙串弹授权次数（前提：签名身份一致）；安装包体积（WebView2 Evergreen 前提，`embedBootstrapper` 约 +1.8 MB；离线/LTSC 的 `offlineInstaller` 约 +130 MB 另出单独包，见 X12），首轮实测后定预算。
- **对应**：R01、H02 / REL-07、MAC-01~03 / SUP-03、SEC-05、N-03、N-05、N-07、N-13、E7、R4。

#### I-19 签名更新器（M，A+C，依赖 I-18）
- **改动位置**：新增 `vbk/src-tauri/src/update.rs`、`ui/apps/update/`、`capabilities/update.json`、`tauri.conf.json` plugins.updater；release 工作流步骤由 I-18 owner 合入。
- **做法**：`tauri-plugin-updater`，minisign 公钥编译进二进制；更新端点为 https 常量，不接受远端改写（对照官方 N-02 的动态 feedUrl）；失败保留旧版本；渠道 stable/beta。**信任链**：下载完成 → minisign 验签 → **平台签名校验在解包与执行任何安装脚本之前**（Windows `WinVerifyTrust` 校验 NSIS 安装器，macOS `codesign --verify --deep --strict` 校验解压后的 .app 再移动替换；任一失败即删除下载文件并记录诊断，不启动安装器；updater 本身只验 minisign，此步需自行实现）；minisign 公钥支持**双公钥期**轮换（二进制内嵌当前与下一把公钥，更新清单声明使用哪一把）与内嵌撤销清单（已吊销密钥指纹，命中即拒绝）。**当前方案的局限（明示）**：内嵌撤销表只能让**新版本**拒绝旧密钥，**不能撤销已发布旧客户端对泄露密钥的信任**——旧客户端在拿到新版本之前，仍会接受用泄露密钥签的更新。因此新增**在线签名的密钥状态文件** `key-status.json`：由离线保管的**根密钥**（与日常签更新的密钥分离）签名，字段 `{version: 单调递增整数, issued_at, expires_at, active_keys[], revoked_keys[], min_client_version}`；客户端每次检查更新先拉取并验签该文件，缓存最后一次通过验签的 `version`，**拒绝 `version` 回退**（防回滚）、拒绝过期文件（`expires_at` 已过则只允许继续使用缓存至多 7 天，之后提示「无法确认更新密钥状态」并拒绝任何更新）、拒绝低于 `min_client_version` 的旧客户端继续用旧密钥（只提示手动下载）。**离线更新行为**：无网络时不更新；离线安装包（用户手动下载）在安装前仍执行平台签名校验，但不能校验 `key-status.json`，产品文案明示。无 Authenticode 时 Defender 云信誉仍可能拦截静默安装，故依赖 I-18。**安装前钩子未核实**：`vbk/src-tauri/Cargo.toml` 与 `tauri.conf.json` 本日均未引入 `tauri-plugin-updater`，本轮无法从代码确认该插件是否提供「下载完成、安装前」的钩子（已知其公开 API 为 `download` 与 `install` 两步，可在两步之间自行校验，但 Windows 侧 `install` 对 NSIS 是直接启动安装器）；列为 **X14**：若钩子不足，vbk 只用插件做清单获取与下载，安装步骤自研。
- **验收**：①**第一步验收（最小原型，先于其他任何功能）**：在 macOS 与 Windows 各做一个只含「下载 → minisign 验签 → 平台签名校验 → 才调起安装」的原型，证明平台签名校验**确实发生在解包与执行任何安装脚本之前**（Windows 用 Procmon 证明 NSIS 安装器在校验失败时从未被创建进程；macOS 证明 `.app` 校验失败时未被移动到 `/Applications`），原型通过前不进入功能实现；②篡改更新包 1 字节 100% 拒绝；③清单改为 http 地址拒绝下载；④平台签名无效的包在两个平台上均不启动安装器（各 10 次）；⑤用吊销密钥签的包被拒（新版本内嵌表与在线状态文件各测一次）；⑥`key-status.json` 的 `version` 回退、过期、根签名错误各被拒；⑦N-2、N-1 → N 升级保留数据与登录态（与 I-25 迁移测试联动）；⑧断网/断电中断后旧版可启动。
- **对应**：H10、U06 / REL-06 / SUP-01、SUP-03、N-01、N-02、PLG-02。

#### I-23 通知中心、快捷回复读取、服务端搜索与外围操作读回（M，C；B2 部分 / B3 部分）
- **改动位置**：`ui/packages/web-adapter/src/{notice,peripheral,settings,order}.ts`、`vbk/src-tauri/src/peripheral_journal.rs`、`ui/apps/main/{main.ts,peripheralPanel.ts}` 与新建 `ui/apps/main/features/registry.ts`（**B2/B3 期间 I-23 是 `main.ts`、`features/registry.ts`、`web-adapter/src/index.ts` 的唯一 owner**，并负责在 B2 开始时定义并冻结 `FeatureContext`；I-29 B2 部分与 I-30 各子项对这些文件的改动都由 I-23 合入，见 I-30 接入规则与 §5.1）；`docs/api/inventory.json` 条目向集成负责人提变更。
- **做法**：**B2 部分**（字段已从官方渲染层取得）：通知中心 `11679/getIQConversations {head,lastMsgTime:0}→categoryList`、`getIQMessages {categoryId,categorySubId,lastMsgTime,pageSize:100}`、`putAdviceofreadIQMessage`、`translateIQMessage`；快捷回复读取 `16037/getCategories {typeList,categoryType:"CUSTOMSCRIPT",status:"ACTIVE"}`、`getCustomerScripts`（联想 200 ms 防抖），CRUD 归 I-26；服务端会话搜索 `16037/searchConversation {searchType,searchValue,pageNo,startTime,endTime}`，`searchType` 枚举待实机取样。**B3 部分**：星标、转接、结束、邀请各做受控样本读回；多角色账号由 X4 提供。**第六轮实机**：星标 `16037/setWorkSheetStar {sessionId:str,groupId:number,worksheetId:number,action:number}`、转接 `16037/transferVenMaster {sessionId,groupId:str,targetVenAgentUid}`、结束 `16037/finishConversation {conversationKey,conversationType:"B2C",sessionId,workSheetId}` 均由渲染进程发起，成功判定为 `bizResponseStatus.resultCode === "SUCCESS"` 而非 `ResponseStatus.Ack`（`web-adapter/src/worksheetStar.ts` 已如此，转接/结束沿用）；`groupId` 在星标为数字、在转接为字符串，适配器按端点各自建模不得统一转换。**置顶不上行服务端**（渲染进程 HTTP、IM 进程 Node HTTP、XMPP 三路均无请求），是本地状态；vbk 的 `display.rs` 置顶表（I-04a W5）即正确形态，不设计服务端契约，不期望跨设备同步（待复核：实测时置顶操作是否真正生效）。
- **验收**：B2：通知中心、快捷回复列表、搜索结果与官方网页读回一致各 ≥ 3 个样本；B3：转接、结束、邀请各 ≥ 3 个受控样本读回正确，星标写入后官方网页读回一致；置顶为本地偏好，验收改为重启后保持且不产生任何出站请求（fetch 钩子 + 抓包为零）。
- **对应**：U03、H04 / OPS-01~08 / E3。

### 批次 B3：正式发布（P2）

#### I-20 系统集成插件接线（S，A+C）
- **改动位置**：新增 `src-tauri/src/integration.rs`、`prefs.rs`（含 `:90` 默认值与 `:352-360` 保存路径改用 I-25 的 fsync 原子写）、`ui/apps/setting/`；`lib.rs` 插件注册由集成负责人合入。
- **做法**：注册 `tauri-plugin-global-shortcut`（截图、显示/隐藏主窗，冲突时提示并允许改键）、`tauri-plugin-autostart`（**默认 false**）、`tauri-plugin-deep-link`（自有 scheme，**不抢占** `vbookingChat`，参数白名单，不写持久配置，对照官方 SEC-14）；第二实例参数转交并聚焦主窗。
- **验收**：自启开关双平台 5/5 生效且关闭后确实不再启动；深链模糊测试 1 万随机输入 0 崩溃 0 越权；设置页不再出现任何「只存储、不生效」的开关。
- **对应**：H06、H09 / SHL-04、REL-02 / D9、SEC-14。

#### I-21 截图标注与媒体查看器（L，A+C）
- **改动位置**：新建 `vbk/crates/core-media/`、`vbk/ui/apps/{capture-overlay,image-viewer,video-player}/`、`src-tauri/src/media/viewer.rs`。
- **做法**：平台无关的标注模型（矩形、箭头、文字、马赛克、撤销栈）与导出参数放核心 crate；查看器支持缩放、旋转、另存为；排查 D12（历史视频 Invalid）的 WebView 媒体格式差异。
- **验收**：标注模型单测覆盖全部工具与撤销/重做；查看器播放 R02 收集的官方支持格式样本；遮罩在双平台实机截图。
- **对应**：M09、H07、U07 / MED-04~06 / D12。

#### I-22 诊断包与崩溃恢复（M，A+C；日志与脱敏已由 I-10a 先行）
- **改动位置**：`vbk/crates/core-diag/`（扩展）、新增 `vbk/src-tauri/src/diag.rs`、`ui/apps/setting/`（导出入口）、`ui/apps/main/` 诊断面板。
- **做法**：诊断包只在用户主动导出时生成并先展示清单；默认不远程上传（对照官方 PRI-03 自动上传）；panic hook 写崩溃标记；WebView 进程崩溃只重建对应视图、不永久降级（对照官方 STA-06；需先在 Tauri 2 中确认 WebView2 `ProcessFailed` / WKWebView `webViewWebContentProcessDidTerminate` 可挂回调）。
- **验收**：任意导出的诊断包扫描零敏感命中；每类 WebView 人为崩溃 10 次只重建该视图；数据目录扫描无凭据（G-SEC-3）。
- **对应**：M10、H11 / REL-01、REL-04、REL-05 / PRI-03、PRI-05、PRI-06、STA-06。

#### I-24 端点表与发布端点收敛（M，A+C）
- **改动位置**：`vbk/crates/core-net/src/endpoint.rs`、构建脚本；`docs/api/inventory.json` 条目向集成负责人提变更。
- **做法**：02 报告发现的 32 个未收录域名逐个判定（范围内补进 inventory 并标证据，范围外列为禁止）；实机截获补录到 `docs/api`：`12405/getCurrentUserInfo`、`28967/reportInjectFnInfo`（未收录）、`batchTranslateByMsgIds` 新增 `chatType` 且 `bizType` 为数字、`getRemarkList`/`queryToken` 响应多出字段、`ivbk/accountV2/restapi/ab`、`tour/im/ex-area/qconfig/json`、`getMessageList.conversationType` 同一会话可为 `B2C` 或 `C2B`（`web-adapter/src/history.ts` 已按字段透传，不得写死）；端点表按构建配置生成，发布构建只含生产域名；系统代理读取（WinINet / SCDynamicStore）；PAC 列 B4。
- **验收**：发布产物字符串扫描不含测试域名；自签证书本地 HTTPS 被拒绝（集成测试）；系统代理环境下登录与收发成功（实机）。
- **对应**：M04 / NET-02、NET-03 / SEC-06、SEC-10、SUP-02、PRI-04、F-07、F-09。

#### I-25 存储 schema 版本与 SQLite 决策门（M，B）
- **改动位置**：`vbk/crates/core-store/src/`（含 `store.rs:136-147` `Txn::into_parts`、`file.rs:204-213` `commit`）、`src-tauri/src/display.rs:1033-1043`、`vbk/crates/core-im/src/dedup.rs:242-248`、新增 `docs/decisions/2026-xx-xx-store-engine.md`。`login.rs:196-204` 与 `prefs.rs:352-360` 的同类修复分别由 I-05b、I-20 owner 调用本项提供的公共 `write_atomic` 完成。
- **做法**：每个文档带 `schema_version`，迁移函数编译进二进制（对照官方迁移 SQL 可被热更新替换）；写入走 I-04a 的持久化线程；B2 结束时按基准数据决定是否引入 `rusqlite`（bundled，唯一引擎，迁移 `include_str!` 内嵌）。同批修：`FileStore::commit` 校验 `Txn.base_revision`（不等返回 `store.cas_conflict`）或加命名空间级写锁；在 `core-store` 提供带 fsync 的公共 `write_atomic`，`display.rs` 的「只 rename 不 fsync」就地改用；`MessageIndex`/`by_gid` 加上限。
- **验收**：
  1. 迁移与回滚：从 N-1 数据目录升级自动迁移；「回滚不丢数据」的**比较基准** = 升级前对数据目录逐文档取 SHA-256 清单，降级回 N-1 二进制后：N-1 对带有更高 `schema_version` 的文档必须**拒绝加载并保留原文件**（不得覆盖），用户可见提示；重新升级到 N 后文档哈希与首次升级后一致。
  2. 故障注入（**复用 I-04a 验收 ③ 的故障模型与夹具**，三种模型分别计数，不以 `kill -9` 代称掉电）：模型 A 进程终止在 `file.rs` 三个 fail point（`sync_all` 前、`rename` 前、`sync_directory` 前）各 ≥ 300 次、合计 ≥ 1000 次，期间两个 namespace 并发写入，读回判据同 I-04a；模型 B 文件系统错误（`ENOSPC`/`EACCES`/`EROFS`）各 ≥ 50 次，损坏或不可写文件被隔离到 `quarantine/` 且业务继续；模型 C 断电作为设计属性由属性测试覆盖（任意写前缀截断后读回为旧或新文档），平台测试覆盖 APFS、NTFS、ReFS。硬门槛：0 次不可读文档。
  3. 双账号文档互不可见（`leakage.rs`）。
  4. 单写延迟 p99（SSD，1 万条草稿或水位记录）为**基线指标**（06 M03 的 ≤ 20 ms 待实测后定）。
- **对应**：M03 / DAT-03~05 / STA-04、STA-07、PRI-02、F-14、N-11。

#### I-28 消息区性能（总称；拆为 I-28a 必要 / I-28b 增量 / I-28c 可选，B，与 I-08 同一 owner）
- **现状**：a34a007 的视口渲染只覆盖会话列表（96 px 定高、≤ 22 行）；消息区仅做「deps 不变时复用节点」。任意一条新消息到达触发 `mergeHistory(10k,1)` 全量重建分组（Node 微基准 6.8 ms）、整个消息子树重建、`captureMessageAnchor` 对每个可见行 `JSON.parse`（20 可见行 × 10k 约 73 ms，同为微基准）；整个 app 树每帧全部重建，无 diff（`ui-kit/src/h.ts`：`mount` `:116-118` 为 `root.replaceChildren(node)`，`rerender` `:125-163` 在 `:143` 调 `mount` 整树替换，本轮复核）。
- **共同验收环境**：Playwright 在 Chromium 与真实 WKWebView/WebView2 各测一次，1 万条消息夹具；每个子项**改前必先记录基线**（新消息到达单帧耗时、滚动帧 p95、`mergeHistory` 单次耗时），数据进 `docs/research/`。

##### I-28a 消息区虚拟化 + 稳定行身份/阅读锚点（M，B1，**必要**）
- **改动位置**：`ui/apps/main/main.ts:1899-1911`（`messagePane`）、`ui/apps/main/{history-layout,history-diagnostics}.ts`、`vbk/crates/core-im/src/`（行身份接口，I-08 已列）。
- **做法**：消息区引入与会话列表同样的窗口化（测量高度 + 哨兵占位）；行身份由核心层保证（`message_id`/`local_id` + 页内序号）；锚点匹配改用预解析 key 结构体并把 `{scope,key,offset}` 搬进 store（即 I-08 的 UI 侧实现）。
- **验收**：「新消息到达单帧 ≤ 16 ms、滚动帧 p95 ≤ 16 ms」为**基线指标**，实测两轮后决定是否升为硬门槛；I-08 的 30 次基线采样在本项之后跑。
- **对应**：U01、U03 / UIIM-05 / F-04、F-05 的反面。

##### I-28b `mergeHistory` 增量化（S，B1 末或 B2，依赖 I-28a 基线）
- **改动位置**：`ui/apps/main/viewmodel.ts`（`mergeHistory`）。
- **做法**：单条插入走二分定位的增量路径，批量页合并保留全量路径；分组缓存按 `(gid, 行身份)` 失效。
- **验收**：Node 微基准 `mergeHistory(10k,1)` 相对基线的倍数（基线指标）；等价性属性测试：增量结果 == 全量结果。
- **对应**：U03 / UIIM-05。

##### I-28c 全局 `rerender` patch 化（M，**可选**，B2 以后）
- **立项条件**：I-28a 合入后，在同一夹具上重新测量，**只有当**「app 整树重建」仍是新消息到达单帧耗时的首要项（Performance profile 中占比 ≥ 50%）才立项；否则关闭。
- **改动位置**：`ui/packages/ui-kit/src/h.ts:116-118,125-163`。
- **做法**：`rerender` 从整树替换改为按区域分治（每个顶层区域有稳定 key，deps 不变区域不重建），不引入第三方 vdom。
- **验收**：改后同一测量的占比下降；焦点/滚动保持的既有测试不回退。
- **对应**：U01 / F-04 的反面。

#### I-29 焦点、i18n、错误态与发布包卫生（M，A+C；B1 部分 / B2 部分）
- **改动位置**：`ui/apps/main/main.ts`（焦点：`:1397,1811,2359` 键盘处理；错误态：`:464-511` `loadForActiveAccount` 经 `invokeQuiet` 静默为空，`:1457` 显示 `list.empty`）、`companion-card.ts`（`:70` 改 `createElementNS`；改完后**同一提交**把 `tools/gates/dom-sinks.allowlist.json` 清空，使 I-02 第 4 条门禁进入严格零命中）、`viewmodel.ts`、`ui/packages/web-adapter/src/bridge.ts:82`、`ui/apps/_shared/ipc.ts:14`、`ui/tools/bundle.mjs`、`styles.css`、新增 `tools/gates/cjk-literals.mjs`。与 I-28a 都改 `main.ts`：I-29 的 B1 部分只改焦点相关函数，且提交顺序 I-28a 先合入。
- **做法**：**B1 部分**：焦点恢复推广到任何带 `data-fid` 的元素并给会话行与按钮加 fid；根节点 `aria-live` 与 toast 的 `role=status` 补齐；`companion-card.ts:70` 改 DOM API 并清空 DOM sink 允许清单（允许清单文件本身归 I-02，此次清空是 I-29 唯一一次对它的改动，由 I-02 owner 评审）。**B2 部分**：97 行硬编码中文与整张套餐卡走 `t()`，随后启用 CJK 字面量门禁（白名单 `i18n.ts`、`*/strings.ts`、测试文件）；`im_conversations` 失败显示错误态与重试而非「暂无会话」；`bridge.ts` 的 `#queue` 加长度上限与丢弃计数；bundle 剔除 `mock.js`（53 KB 假账号数据随发布包分发，检查放 I-18 的 release 工作流）；评估去掉 `style-src 'unsafe-inline'`；发布包保留外置 source map 便于崩溃符号化。
- **验收**：键盘用户在收消息期间焦点不丢（UI 测试）；CJK 门禁零命中；release 工作流断言发布包不含 mock；错误态有截图证据。
- **对应**：U01、U03 / F-15、F-16 的反面。

#### I-30 官方保留范围内、vbk 尚无代码的功能（总称；拆为 I-30a–I-30n 独立子项，按 01 报告编号；A+C）
- **接入规则（所有子项共用，解决 B2/B3 的文件归属）**：
  1. **`main.ts` 在 B2/B3 期间只有一个 owner：I-23**（见 §5.1）。任何 I-30 子项**不得改 `main.ts`**；每个子项只新建 `ui/apps/main/features/<feature>.ts`，导出 `FeatureModule { id, mount(ctx: FeatureContext), onFact?(fact), dispose() }`；**单一注册点** `ui/apps/main/features/registry.ts`（新建，I-23 owner）维护 `FEATURES` 数组，子项提交只新增一行 import + 一个数组元素，该改动由 I-23 owner 合入；`FeatureContext`（store 读取、`invoke` 包装、面板挂载槽位、`t()`）由 I-23 在 B2 开始时先定义并冻结。
  2. 适配器侧同理：每个子项只新建 `ui/packages/web-adapter/src/<feature>.ts`，在 `web-adapter/src/index.ts`（B2/B3 owner I-23）单点注册；不改 `boot.ts`、`sdkGlue.ts`、`conversationList.ts`、`send.ts` 等既有文件。
  3. 宿主侧：子项**不改 `adapter.rs`**；新命令放 `src-tauri/src/features/<feature>.rs`（新建），`features/mod.rs`、`lib.rs generate_handler!`、`commands.txt`、`capabilities/*.json`、契约类型（`contracts`/`ipc`）与 `inventory.json` 条目由**集成负责人**按变更请求合入（I-02 的四方一致性门禁会强制这些同时更新）。
  4. 出站类子项（转发、评价邀请、自动答复、群操作）一律经 outbound journal（`unknown` 不重放），依赖 I-14 冻结的契约；不得绕过。
  5. **高风险子项**（敏感信息拦截、打码解码、自动答复、评价邀请、群操作、Excel 表情导入）各自标注范围决策点（X16–X21），**决策前不得立项**，且**默认不进任一批次的退出条件**；立项条件 = 决策通过 + 子项派工单附「数据流图（哪些字段离开本机、去哪个端点）、权限矩阵（谁能触发、是否需二次确认）、误操作回退验收（误触后如何撤销或为何不可撤销并如何提示）」三件。

| 子项 | 功能（01 编号） | 批次 | 文件级范围（均为新建，除注明） | owner | 依赖 | 接口（契约变更请求） | 风险 / 决策 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| I-30a | FE-30 正在输入状态（`sendInputState`，3 秒节流；第三轮实证走 XMPP `<message type="input_state">`，不走 HTTP） | B2 | `web-adapter/src/typingState.ts`；`ui/apps/main/features/typing-indicator.ts`；`src-tauri/src/features/typing.rs`（`im_send_input_state`） | 功能补齐 owner（B2 通道 ③） | I-06（节流不得叠加轮询） | 新 adapter 事实 `TypingState{gid,from,until_ms}`；新命令 1 条 | 低 |
| I-30b | FE-34 主动撤回与重新编辑（`11679/recallMessage`，2 分钟窗口；第四轮实证：HTTP 体 `{messageId,partnerId}` 19 位字符串，响应 `status.code`，撤回广播为入站 `groupchat` 带 `ext`，无出站 XMPP） | B2 | `web-adapter/src/recall.ts`；`ui/apps/main/features/recall.ts`；`src-tauri/src/features/recall.rs`（`im_recall_message`） | 同上 | I-09（D5 `server_id/local_id` 合并修复）、I-11 校时（2 分钟窗口按服务端时间） | 新命令 1 条；消息行新增 `recalled` 状态字段 | 低（撤回本身不可逆，需二次确认） |
| I-30c | FE-12 语音消息播放 | B2 | `web-adapter/src/voice.ts`（语音 URL/格式）；`ui/apps/main/features/voice-player.ts` | 同上 | D12 媒体格式排查（I-21 现状） | 无新命令；渲染表新增语音类型 | 低 |
| I-30d | FE-44 排队状态展示（`NBZ11`、`checkManualAgentStatus`、`dropOutManual`） | B2 | `web-adapter/src/queueStatus.ts`；`ui/apps/main/features/queue-banner.ts`；`src-tauri/src/features/queue.rs`（`im_queue_drop_out`） | 同上 | I-06（3 秒轮询只在 `NBZ11` 出现时） | 新 adapter 事实 `QueueStatus`；新命令 1 条 | 低 |
| I-30e | FE-28 敏感信息拦截提示 | B2 候选 | `web-adapter/src/sensitiveHint.ts`；`ui/apps/main/features/sensitive-hint.ts` | 同上 | 官方规则来源与是否本地匹配待 X16 | 只提示不拦截（除非 X16 另定）；无新命令 | **高：X16**（客户正文在本地做规则匹配的数据流） |
| I-30f | FE-33 转发 | B3 | `web-adapter/src/forward.ts`；`ui/apps/main/features/forward-dialog.ts`；`src-tauri/src/features/forward.rs`（`im_forward`，经 journal） | 功能补齐 owner（B3 通道 ③） | I-14 契约 v1 | 新命令 1 条；journal 新 payload 类型 `Forward` | 中（出站，不可幂等） |
| I-30g | FE-45 邀请评价与评价消息 | B3 候选 | `web-adapter/src/evaluation.ts`；`ui/apps/main/features/evaluation.ts`；`src-tauri/src/features/evaluation.rs` | 同上 | I-14 契约 v1、X4 多角色账号 | 新命令 1 条；渲染表新增评价消息类型 | **高：X19**（向客户发起评价为业务动作） |
| I-30h | FE-42 改群名/群欢迎语/复制新建群 | B3 候选 | `web-adapter/src/groupAdmin.ts`；`ui/apps/main/features/group-admin.ts`；`src-tauri/src/features/group_admin.rs` | 同上 | X4 多角色账号 | 新命令 ≤ 3 条 | **高：X20**（群操作影响其他坐席） |
| I-30i | FE-40 多选/按部门/业务线邀请 | B3 候选 | `web-adapter/src/inviteDepartments.ts`；`ui/apps/main/features/invite-picker.ts`；对既有 `im_invite_candidates`（`adapter.rs:1534`）/`im_invite`（`:1608`）的参数扩展**由 I-23 B3 owner 合入** | 同上 | I-23 B3 部分（邀请读回） | 既有命令参数扩展 | **高：X20** |
| I-30j | FE-60 浏览器网页登录授权确认 | B3 | `web-adapter/src/loginAuthorize.ts`；`ui/apps/main/features/login-authorize.ts` | 同上 | I-13 账号状态机 | 新 adapter 事实 `LoginAuthorizeRequest`；用户必须显式点击确认 | 中（安全相关确认框，不得自动确认） |
| I-30k | FE-76 自动答复（`getWordsAboves/saveWordsAboves`） | B3 候选 | `web-adapter/src/autoReply.ts`；`ui/apps/main/features/auto-reply.ts`；`src-tauri/src/features/auto_reply.rs` | 同上 | I-14 契约 v1、I-15（反自动化结论） | 新命令 2 条 | **高：X18**（自动出站） |
| I-30l | FE-53 自定义表情（含 Excel 导入导出） | B4 候选 | `ui/apps/main/features/custom-emoji.ts`；`web-adapter/src/customEmoji.ts`；`src-tauri/src/features/emoji_import.rs`（Excel 解析依赖需向集成负责人提变更） | B4 按需 | X9 素材授权、I-14 契约 | 新命令 2 条 | **高：X21**（解析用户提供的 Excel 文件） |
| I-30m | FE-56 推荐回复「助小游」（`35240/shoppingGuide` SSE） | B4 候选 | `web-adapter/src/shoppingGuide.ts`；`ui/apps/main/features/shopping-guide.ts` | B4 按需 | X8 | 新 adapter 事实流；无新命令 | 中：**X8** 一并拍板 |
| I-30n | FE-39 打码解码（`15408/messageDecodeRecord`，实名校验） | B4 候选 | `web-adapter/src/decode.ts`；`ui/apps/main/features/decode.ts`；`src-tauri/src/features/decode_audit.rs`（本地审计记录） | B4 按需 | I-10a 脱敏（解码结果不得进日志） | 新命令 1 条 | **高：X17**（解码客户隐私字段） |

- **验收**：每个子项有 UI 测试与实机截图；高风险子项另需上表第 5 条的三件文档与「误操作回退」实机演示；官方消息类型枚举（`TextMessage:0 … GroupHasRead:1022, OtherHasRead:1023`，messageType 7 按 `actionCode` CBZ03/09/04/59/95 分支）在 U03 渲染表中逐项标注实现状态。
- **对应**：U03、U02、H04 / 01 报告 §3。

### 批次 B4：增强（P3）

#### I-26 OCR、中文纠错、快捷回复 CRUD（L，A+C，依赖 X5）
- **改动位置**：`vbk/crates/core-media/`（OCR 接口与纠错规则）、`src-tauri/src/media/ocr.rs`、`ui/apps/main/`。
- **做法**：OCR 优先系统能力（macOS Vision、Windows.Media.Ocr），ONNX + PP-OCR 只作可选下载，模型随包或从签名源下载并 SHA-256 校验，默认关闭（对照官方 SUP-02 从个人 GitHub 仓库下载且关 TLS）；纠错为本地规则引擎，只提示不改写；快捷回复 CRUD（读取已在 I-23 的 B2 部分）。
- **验收**：①OCR 质量：「不低于官方 PaddleOCR」**只有在取得官方客户端实际使用的同一模型版本与同一预处理（官方从个人 GitHub 仓库下载的模型文件哈希与 `det/rec/cls` 组合，02/04 报告可追）并在同一测试集上跑出基线时才可比**；若不能取得（默认假设不能），改为**自建指标**：「中文订单截图测试集 ≥ 200 张（X4 提供脱敏样本或由 R02 合成）上的字段召回率」（字段 = 订单号、手机号、姓名、日期、金额，按字段级精确匹配），首轮只记录为基线指标，门槛由 X22 定；②模型哈希不符拒绝加载；③未开启 OCR 时包内不含模型；④体积与内存不突破 I-18 实测后定的预算。
- **对应**：M09、H07、U03、U02 / MED-07、MED-08 / SUP-02、STA-10、N-10。

#### I-27 官方页快照回放与 universal 合并（M，A）
- **改动位置**：`ui/packages/web-adapter/` 测试夹具（复用 `boot.ts` 的 `BootWindow` 注入点与 `testing.ts`）；release 工作流中的 `lipo -create` 步骤由 I-18 owner 合入。
- **做法**：录制至少 2 个官方构建版本的 `xmppClient` 事件序列与 16037/11679 响应体（脱敏），适配器在快照上回放并断言 `BootResult` 与事实序列；把 `sdkGlue` 的 `global_state`/`health` 指纹上报到宿主诊断；macOS universal 由 I-18 已产出的 arm64 与 x86_64 两个产物合并。
- **验收**：快照回放测试全过；依赖点缺失进入降级并上报指纹不抛未捕获异常；`lipo -archs` 含两种架构。
- **对应**：U02、R01 / R2、STA-08。

---

## 4. 禁止事项（来自逆向反例，任何工作项不得引入）

1. 不做运行时替换本地前端或迁移 SQL（SUP-01）。
2. 不出现任何关闭 TLS 校验的代码路径或构建开关（SEC-06、SUP-02）。
3. 不向 WebView 暴露通用查询、通用网络、通用文件、全账号 cookie 类命令；远程页只保留 adapter 7 条（SEC-07）。
4. 不放开同源策略、站点隔离、CSP，不剥离服务端安全头（SEC-01~03）。
5. 发布包不含 DevTools、调试端口、测试域名、环境切换与调试工具页（SEC-12、PLG-01、F-07、F-08）。
6. 凭据不进配置、日志、诊断包、提醒数据（PRI-01、PRI-05）。
7. 重连、重启、轮询不得绕开单一状态机，不得出现无退避重试（STA-01、STA-02）。
8. 适配器不在官方页节奏之外增加轮询，不伪造输入事件、不隐藏自动化特征（F-06、F-11、R7、R11）。
9. 不随包分发无用的可执行文件，不同时存在两套存储引擎（SUP-05、STA-07）。
10. 不抢占 `vbookingChat://`；深链参数必须白名单（SEC-14）。
11. 自有资源替代携程提示音与表情素材后才可分发（01 §7.1 第 7 条授权问题，X9）。

---

## 5. 批次、并行通道与退出条件

单写者规则沿用总计划第 4 节：同一批内每个文件只属于一个工作项的 owner；契约（`contracts`、`ui/packages/ipc`）、`src-tauri/src/lib.rs`、`Cargo.toml`、`docs/api/inventory.json` 由集成负责人单写，其他项需要新类型、新依赖、新插件或新端点条目先提交变更请求。

### 5.1 文件级 owner 表（交叉文件的唯一归属与顺序）

| 文件 | 唯一 owner | 其他想改它的项怎么办 |
| --- | --- | --- |
| `src-tauri/src/adapter.rs`、`login.rs`、`profiles.rs` | B0–B1：I-05b（传输 owner）；B2：I-14（`adapter.rs` 的出站命令 `im_send_media` `:746`、`im_send_text` `:1358`；`login.rs`/`profiles.rs` 在 B2 归 I-13）；B3：I-23 B3 部分 | **I-04a 不改这三份文件**（本轮撤回「三条命令改 async」）；I-04b 的锁外 emit、I-09 的草稿命令函数体由 I-05b owner 在 supervisor 合入后执行；`login.rs:196-204` 的 fsync 原子写在 B3 随 I-25 由当时 owner 改为提交 I-04a 队列的 `AccountIndex` 作业；I-13 的账号状态机通过 `state.rs` 接口接入；**I-30 任何子项不改 `adapter.rs`**，新命令放 `src-tauri/src/features/*.rs`；I-30i 对 `im_invite_candidates`（`:1534`）/`im_invite`（`:1608`）的扩展由 I-23 B3 owner 合入 |
| `src-tauri/src/state.rs` | I-04a（B0）→ I-04b（B1）→ I-13（B2，账号状态机接口） | I-05b 需要的健康度字段先提契约变更（M01），由 I-04a/I-04b owner 加字段；I-10 的 `set_dnd_until_tomorrow` 修复由 I-04b owner 顺带合入 |
| `crates/core-store/src/queue.rs`（新建）与 `file.rs` 的 fsync 计数钩子 / fail point | I-04a（B0） | I-25（B3）复用同一夹具，不改钩子语义 |
| `src-tauri/src/features/*.rs`（新建，每子项一个文件）、`features/mod.rs` | 每个文件归对应 I-30 子项；`mod.rs`、`generate_handler!`、`commands.txt`、`capabilities/*.json` 归集成负责人 | 子项只提变更请求 |
| `ui/apps/main/main.ts` | B1：I-28a（含 I-08）；**B2/B3/B4：I-23（唯一 owner）** | B1：I-29 的 B1 部分只改焦点相关函数，排在 I-28a 合入之后；I-05b 的「消息通道异常」提示由 I-28a owner 接入。B2 起：I-29 B2 部分（`t()` 替换、错误态）按函数提交由 I-23 合入；I-30a–n **禁止改本文件**，只经 `features/registry.ts` 注册；I-28c 若立项只改 `h.ts` |
| `ui/apps/main/features/registry.ts`（新建）与 `FeatureContext` 定义 | I-23（B2 开始时冻结） | I-30 子项每次只新增一行注册，由 I-23 合入 |
| `ui/apps/main/features/<feature>.ts`（新建） | 对应 I-30 子项（文件名见 I-30 表） | 一文件一子项，不互相 import |
| `ui/apps/main/{history-layout,history-diagnostics}.ts` | I-28a（含 I-08） | — |
| `ui/apps/main/viewmodel.ts` | B1 通道 ②（I-07、I-08/I-28a、I-09 同一 owner）→ B2：I-28b（`mergeHistory`）先合入，再 I-29 的 i18n 改动 | — |
| `ui/apps/main/unknown-outbound.ts` | I-14（B2） | I-05b 的恢复边界（做法 7）通过 `unknown` 态契约对接，不直接改此文件 |
| `ui/apps/main/companion-card.ts` | I-29（B1 部分） | I-02 的 DOM sink 门禁在 B0 以允许清单放行 `:70`，I-29 改完同一提交清空清单 |
| `ui/packages/ui-kit/src/h.ts` | I-28c（**仅在立项条件满足后**） | 其他项不得改 |
| `tools/gates/*.mjs`、`tools/gates/fixtures/`、`tools/gates/dom-sinks.allowlist.json` | I-02 | I-29 新增 `cjk-literals.mjs` 单独文件；I-29 对允许清单只做一次「清空」提交，由 I-02 owner 评审 |
| `ui/packages/web-adapter/src/{boot,conversationList,compensation,pageContext}.ts` | B1 通道 ①（I-05a/I-05b/I-06 同一传输 owner；I-05b 只改 `boot.ts`，I-06 改其余三份 + `boot.ts` 的可见性门控，提交顺序 I-06 先） | B2 起冻结，I-30 子项不改 |
| `ui/packages/web-adapter/src/index.ts` | B1：I-06；B2/B3/B4：I-23 | I-30 子项的 `web-adapter/src/<feature>.ts` 新文件由 I-23 在此单点注册 |
| `ui/packages/web-adapter/src/<feature>.ts`（新建） | 对应 I-30 子项 | 不改 `sdkGlue.ts`、`send.ts`、`history.ts` 等既有文件 |
| `src-tauri/src/{media_outbound,outbound_journal}.rs`、`web-adapter/src/{media,upload}.ts`、`docs/api/media-attachment-contract.md` | I-14 | I-17 只在契约冻结后调用冻结接口，不改这些文件；I-30f/g/k 的 journal 新 payload 类型向 I-14 提变更 |
| `src-tauri/src/shell.rs` 截图部分 → `src-tauri/src/media/capture_*.rs` | I-17 | — |
| `src-tauri/src/scheduler.rs`、`windows.rs`、`tray.rs` | I-10（B1）→ I-12（B2） | I-04b 的 notify 锁改动先提接口，由 I-10 owner 接入 |
| `src-tauri/src/prefs.rs` | I-20（B3） | I-25 只提供公共 `write_atomic`，由 I-20 换用 |
| `src-tauri/src/display.rs` | I-25（B3） | — |
| `.github/workflows/vbk-check.yml`（开发 CI） | I-02 | I-00 只改被门禁指出的源码，不改工作流 |
| release 工作流（新建） | I-18 | I-19、I-27、I-29 的产物检查步骤由 I-18 owner 合入 |
| `crates/core-store/`（`queue.rs` 以外） | I-04a（写队列接口，B0）→ I-25（B3） | I-09 草稿仓储只用已有接口 |
| `crates/core-im/` | I-07（计数）与 I-08/I-28a 行身份由同一核心 owner 持有（B1）→ I-25 的 `dedup.rs` 上限（B3） | I-05b 的健康度信号通过契约加字段 |
| `crates/core-diag/` | I-10a（B1）→ I-22（B3） | — |
| `ui/apps/setting/` | I-16（B2）→ I-20、I-22（B3，I-20 先合入） | — |

### 5.2 批次表

| 批次 | 工作项 | 可并行的通道（建议 ≤ 4 个 owner） | 退出条件 |
| --- | --- | --- | --- |
| **B0 门禁与夹具** | I-00、I-01、I-02、I-03、I-04a | ①I-00+I-01+I-04a（宿主与核心）②I-02（开发 CI 与源码门禁）③I-03（契约） | 开发 CI 两平台全绿（clippy、fmt、smoke 在内），宿主测试 195/195；I-02 每类门禁的正反例夹具（漏报/误报各 ≥ 3）通过、对现有代码零误报，**DOM sink 门禁状态 =「允许清单恰 1 条（`companion-card.ts:70`）、清单外零命中」**（不要求严格零命中，解除对 B1 I-29 的循环依赖）；I-03 版本不一致被拒；I-04a 验收 ①②③ 通过（**锁内写路径清单 W1/W2 逐条断言在持久化线程、W3–W6 fsync 计数不变、故障模型 A/B 通过、模型 C 属性测试通过**）；X1、X2、X4、X6、**X11** 已有答复且 I-05b 前置 ③ 的 resource 冲突确认记录文件已存在。**不**要求锁拆分（I-04b）、**不**要求产物阶段检查（I-18） |
| **B1 替代日常客服** | I-05a → I-05b、I-04b、I-06、I-07、I-08+I-28a（I-28b 可选）、I-09、I-10、I-10a、I-11、I-29 的 B1 部分 | ①I-05a→I-05b+I-04b+I-06（传输 owner）②I-07+I-08+I-28a(+I-28b)+I-09+I-29 B1 部分（IM 核心与主窗 owner）③I-10+I-10a（提醒与日志 owner，I-10a 先于长稳）④I-11（验收 owner，贯穿） | **关口 1**：I-05a **未触发停止条件**（试验目标只记录，供 X15），否则停止 I-05b 并触发 X3。**关口 2**：R02 72 小时双账号长稳按 I-05b 验收 ①②③④ 达标；**I-05b 验收 ⑤ 状态机属性测试通过（始终要求）**；互踢实机 ⑥ 仅 X11 判定支持时要求 (a)，(b) 按 resource 冲突是否解决；I-06 验收 ①②③⑤ 通过（④ 为基线）；强提醒**行为类**硬门槛双平台 20/20、时间类基线已记录；计数按口径差 0；**I-08 的 30 次基线采样已记录（不设门槛，待 X13）**；I-04a 与 I-28a 基线指标已记录两轮；I-29 B1 部分合入后 **DOM sink 门禁为「清单空、严格零命中」**；I-10a 的日志实际产物敏感扫描零命中；证据包与 PROGRESS/BLOCKED 同步 |
| **B2 有限试用** | I-12 ~ I-19、I-23 的 B2 部分、I-29 的 B2 部分、I-28b（若 B1 未做）、I-30a–d（I-30e 需 X16 通过后才可立项） | ①I-13+I-14（账号与出站；**I-14 的第一个交付物是附件登记契约 v1 冻结**）②I-15+I-16+I-23 B2 部分（助手与读取；I-23 同时是 `main.ts`/`registry.ts`/`web-adapter/index.ts` 的唯一 owner）③I-12+I-17（**I-17 的登记接入在 I-14 契约冻结后开始**）+I-29 B2 部分+I-30a–d（系统、媒体宿主、功能补齐）④I-18+I-19（release 工作流与发布，B0 即申请证书；**I-19 第一步是安装前校验最小原型**） | 签名安装包（arm64 与 x86_64 两种，由 I-18 产出）在干净机器安装、升级、卸载通过；release 工作流的产物检查全绿（含不出 mock）；I-14 契约 v1 已冻结且有契约测试；I-19 最小原型两平台通过；媒体与翻译受控样本通过；I-30a–d 各有 UI 测试与实机截图；**高风险 I-30 子项默认不进本退出条件**；有限试用名单由用户确认（X10） |
| **B3 正式发布** | I-20 ~ I-25、I-23 的 B3 部分、I-30f、I-30j（I-30g/h/i/k 分别需 X19/X20/X20/X18 通过后才可立项） | ①I-20+I-22 ②I-21 ③I-23 B3 部分+I-30f+I-30j（+经决策的高风险子项）④I-24+I-25 | 发布候选检查清单全部通过（含第 4 节禁止事项复查、I-18 实测后定的体积预算、SBOM）；I-25 的 SQLite 决策已记录；I-25 故障模型 A/B/C 通过；**高风险 I-30 子项默认不进本退出条件** |
| **B4 增强** | I-26、I-27、I-28c（仅立项条件满足时）、I-30l–n（分别需 X21/X8/X17） | 按需 | 各功能受控样本通过且不突破体积与内存预算；I-26 的 OCR 指标按 X22 决定的门槛 |

每批结束必须交付（按证据类型）：A 类项交付 CI 运行链接与反例记录；B 类项交付基准脚本、运行环境描述与结果文件；C 类项交付目标机版本号与 hash、受控样本、读回结果、证据包链接。「目标机」指安装包在用户实际使用的 Windows 或 macOS 机器上运行，对照对象为官方网页版（或可用时的官方客户端）。全部批次结束时更新 06 第 4 节各模块的「当前」字段。

---

## 6. 需要用户拍板的事项（计划不替用户决定）

| 编号 | 决策 | 阻塞的工作项 | 需在何时决定 |
| --- | --- | --- | --- |
| X1 | 会话计数口径（官方后台 / 官方网页 / 官方桌面含缓存，三选一或自定义） | I-07 | B0 结束前 |
| X2 | macOS 最低版本（是否要求 14+ 以使用 `WKWebsiteDataStore(forIdentifier:)`） | I-13、I-18 | B0 结束前 |
| X3 | 若 I-05a 未通过或 I-05b 在 B1 末未达标，是否在范围外评估其他传输路线 | — | I-05a 不通过时，或 B1 结束时 |
| X4 | 测试账号、多角色账号、受控对端的提供方式（忙账号禁止出站的约束不变） | I-11、I-14、I-23 | B0 结束前 |
| X5 | OCR 方案（系统 OCR 还是 ONNX 模型） | I-26 | B3 开始前 |
| X6 | 签名证书主体（个人或公司 Developer ID / Authenticode） | I-18、I-19 | **B0 即开始申请** |
| X7 | 若目标网页反自动化检测拦截适配器发送，是否调整产品形态（发送都由客服在官方输入框确认） | I-15 | B1 中，R11 触发时 |
| X8 | AI 会话总结窗口是否保留（FE-56「助小游」一并） | I-30 | B3 开始前 |
| X9（新增） | 提示音与表情是否替换为自有素材（分发授权） | I-18 | B2 开始前 |
| X10（新增） | 有限试用的账号范围与平台（Windows 先行还是双平台同步） | B2 退出条件 | B2 开始前 |
| X11（新增，**B1 路线决策门**） | 同账号「客户端 + 浏览器网页」并用是否为支持场景。SDK resource 相同会互踢且 SDK 不再重连：若判定支持，必须先与服务端确认 resource 策略或证明冲突可解决，否则暂停隐藏 WebView 路线；若判定不支持，产品明示限制并给被踢提示文案 | I-05b、B1 退出条件 | **B0 结束前** |
| X12（新增） | 是否支持 WebView2 离线安装场景（LTSC/内网，单独 +130 MB 包） | I-18 | B2 开始前 |

第四轮新增决策点（每条写明谁决定、何时前、默认值）：

| 编号 | 决策 | 谁决定 | 需在何时决定 | 默认值（未决时计划如何执行） |
| --- | --- | --- | --- | --- |
| X13 | I-08 阅读位置保持的允许失败率与偏移门槛（输入：I-08 首轮 30 次基线采样的偏移分布） | 用户（产品） | B1 中，I-08 首轮采样产出后 2 周内 | 未决：I-08 只记录基线，不进 B1 退出条件；不阻塞 B1 |
| X14 | I-19 更新器安装路径：若 `tauri-plugin-updater` 不能在「下载完成、执行安装前」介入校验，是否接受「插件只做清单与下载，安装步骤自研」 | 用户 + 集成负责人 | B2 开始前（I-19 最小原型前） | 默认采用「自研安装步骤」；原型若证明插件两步 API 之间可校验则改回插件 |
| X15 | I-05a 的四个试验目标（p95 ≤ 7 s、max ≤ 15 s、误判 ≤ 1/30 min、唤醒 3/3）是否升为硬门槛，及其数值 | 用户（产品） | B1 中，I-05a 矩阵第一轮产出后 | 未决：只有停止条件为硬门槛；试验目标只记录 |
| X16 | I-30e 敏感信息拦截提示是否纳入范围；若纳入，规则来源（官方下发 / 本地）与是提示还是拦截 | 用户（产品 + 合规） | B2 开始前 | 默认不纳入 |
| X17 | I-30n 打码解码是否纳入范围；解码结果的本地留存与审计策略 | 用户（产品 + 合规） | B4 开始前 | 默认不纳入 |
| X18 | I-30k 自动答复是否纳入范围；与 I-15 反自动化结论的关系（自动出站是否被服务端风控） | 用户（产品） | B3 开始前，I-15 结论之后 | 默认不纳入 |
| X19 | I-30g 邀请评价是否纳入范围；触发需不需要二次确认 | 用户（产品） | B3 开始前 | 默认不纳入 |
| X20 | I-30h/I-30i 群操作（改群名、欢迎语、复制新建群、多选/按部门邀请）是否纳入范围；哪些角色可触发 | 用户（产品） + X4 多角色账号提供方 | B3 开始前 | 默认不纳入；I-23 B3 的「邀请读回」不受影响 |
| X21 | I-30l 自定义表情 Excel 导入导出是否纳入范围（含 X9 素材授权与解析用户文件的安全边界） | 用户（产品） | B4 开始前 | 默认不纳入 |
| X22 | 基线指标升为产品门槛的一次性决策：I-05b 保活分支的 CPU/RSS 上限、I-10 的「消息到可见」与「唤醒后重算」时延、I-26 的 OCR 字段召回率 | 用户（产品） | B1 结束时（I-05b/I-10 数据齐）；I-26 部分在 B4 开始前 | 未决：全部只记录；I-05b 保活分支以「可关闭且关闭后与对照一致」为合入条件 |

---

## 7. 计划维护

- 工作项状态写回本文第 3 节（在标题后追加「状态：B / C / A，证据链接」），不另开进度文件；实机断点仍记 PROGRESS/BLOCKED。
- 新发现的缺陷先进入 03 报告编号体系（或 04 的 D/V/E），再挂到对应工作项。
- 本文与 06 冲突时：模块职责、验收标准以 06 为准；执行顺序、批次与退出条件以本文为准；与总计划冲突时，公共契约与不变量以总计划为准。冲突本身需在两份文档中同步修正。

---

## 8. 修订记录

### 8.1 2026-11-02 第一轮：实物验证后

依据[实物验证报告](../reviews/2026-11-02-reverse-plan-verification.md)。

| 改了什么 | 为什么 |
| --- | --- |
| §1.1 基线改为实测（clippy 13 错、fmt 差异、smoke 失败、CI main 红、宿主离线不可构建）；新增 I-00 列 B0 首项 | 原文「全绿」不成立，门禁红着无法谈 I-02 |
| 新增 I-04a/I-04b 的前身「持久化出锁、出主线程」并提前到 B0 | 真实瓶颈是 `persist_rounds` 在全局锁内、主线程 fsync，不是锁粒度 |
| I-05b 增加终态（被踢、鉴权失败、token 失效）、阈值对齐官方 SDK、补偿起点 now−2 min、互踢用例；B1 前加节流原型（后拆为 I-05a） | 官方 SDK 对这些状态是登出不重连；隐藏页与浏览器 resource 相同会互踢 |
| I-06 升级为 M，处理官方页 `startLoopConvList` 与适配器 poller 叠加 | 代码已双倍请求 |
| I-07 写明口径来源；I-08 改动位置修正到 `main.ts`/`history-layout.ts` 并与 I-28 同做；I-14 补官方上传限额；I-15 前提改为「只埋点不拦截」 | 实物核对 |
| I-18 entitlements 默认空、Intel 包提前、安装模式与 TCC 文案；I-19 注明平台签名校验需自行实现 | 原生层核对 |
| 日志与脱敏从 I-22 拆出为 I-10a 提前到 B1；I-23 的通知中心、快捷回复读取、服务端搜索提前到 B2 | 没有 logger 长稳无法取证；字段已从渲染层取得 |
| 新增 I-28、I-29、I-30；I-25 并入 revision 校验与非 fsync 原子写；I-14 并入 journal 上限；C2/C3/C7/C10 文案修正 | 前端与后端审查 |

### 8.2 2026-11-02 第二轮：Codex 对抗性审查后

依据 [Codex 第一轮审查](../reviews/2026-11-02-codex-adversarial-review-01.md)（结论「需先修订再开工」）。

| 改了什么 | 为什么（审查项） |
| --- | --- |
| I-04 拆为 I-04a（B0）与 I-04b（B1）；B0 退出条件只引用 I-04a；I-04a 补快照序号、合并写、写失败反馈与关机 flush 及对应测试 | P0-1、P1-10 |
| X11 提升为 B1 路线决策门，B0 结束前决定；互踢拆为「无重连风暴」与「业务连续可用」 | P0-2 |
| 节流原型拆为独立关口 I-05a（矩阵、样本量、阈值、停止条件）；完整监督器为 I-05b | P0-3 |
| 新增 §5.1 文件级 owner 表；I-08 并入 I-28 同一 owner | P0-4 |
| 关键数字补测量对象、环境、窗口与统计方法；无来源的降为基线指标 | P1-5、P2-13 |
| I-02 缩小为源码门禁：生产源码范围、测试辅助显式例外、能力矩阵替代词根黑名单、DevTools 改为 feature 配置 + 运行时尝试；产物检查移到 I-18/I-29 的 release 工作流 | P1-6、P1-7、P2-12 |
| x86_64 构建从 I-27 移到 I-18 | P1-7 |
| 每个工作项标注证据类型 A/B/C，§5 交付物按类型要求 | P1-8 |
| I-05b 的 WebView2 保活参数降为实验分支 | P1-9 |
| I-19 补信任链、公钥轮换与撤销 | P1-11 |

### 8.3 2026-11-02 第三轮：一致性收口

合并两份修订记录；统一 I-04a/b、I-05a/b 编号与批次表、owner 表、决策表口径；补齐 I-23/I-29 的分批次部分、I-25 与 `write_atomic` 调用点的归属、`lib.rs`/`Cargo.toml`/`inventory.json` 的集成单写；用 grep 复核全部 file:line（修正见 §9 备注）；补 §9 审查闭环表。

### 8.4 2026-11-02 第四轮：Codex 第二轮对抗性审查后

依据 [Codex 第二轮审查](../reviews/2026-11-02-codex-adversarial-review-02.md)（结论「不可按当前版本整体开工」）。本轮所有 file:line 均重新 grep/sed 复核（`main@d578872`）。

| 改了什么 | 为什么（审查项） |
| --- | --- |
| I-02 第 4 条 DOM sink 门禁改为分阶段：B0 用显式允许清单 `tools/gates/dom-sinks.allowlist.json`（唯一条目 `companion-card.ts:70`，含到期批次，条目消失即门禁失败）、退出条件为「清单外零命中」；I-29 B1 移除后清空清单、启用严格零命中；§5.2 B0/B1 退出条件、§2 C3 门禁、§5.1 同步改写 | P0-1 |
| I-04a 重写：撤回「三条命令改 `#[tauri::command(async)]`」；按代码核实 `adapter_ready`（`adapter.rs:1023-1024`）不涉及持久化写并从列表删除；`adapter_push_fact`（`:1069-1070`）改造后锁内无 IO、入队非阻塞、签名不变；`account_set_remark`（`login.rs:1102-1103`）写盘本在锁外且无 fsync；给出 std-only 专用持久化线程 + `mpsc::sync_channel` 的具体设计（锁内生成带序号快照、`drop(cores)` 后入队、满队列回退到 `pending_persist`、状态通道、flush） | P0-2 |
| I-04a 新增「锁内同步写路径清单」W1–W6（含 `persist_compensation` `state.rs:203/:246-268`、`persist_rounds` `:315-343` 及其三个触发者 `:240/:422/:529`、`login::persist`、`PrefsModule::save`、`display.rs` 置顶表、`OutboundJournal`），每条写明触发者、锁、线程、fsync 次数与处置；fsync 数量改为按清单核实的口径（普通事实 4 次、补偿事实 6 次，双账号）；验收改为对每条路径逐条断言 | P0-3 |
| I-30 拆为 I-30a–I-30n，每项给文件级范围（全部新建文件）、owner、依赖、接口与风险；`main.ts`/`features/registry.ts`/`web-adapter/src/index.ts` 在 B2–B4 只归 I-23，子项只能经新文件 + 单一注册点接入；宿主侧子项不改 `adapter.rs`，新命令放 `src-tauri/src/features/*.rs`；§5.1 owner 表扩到文件级（含 `adapter.rs` 的 B2/B3 owner、`h.ts`、`unknown-outbound.ts`、`web-adapter` 各文件） | P0-4 |
| I-30 高风险子项（敏感信息拦截 X16、打码解码 X17、自动答复 X18、评价邀请 X19、群操作 X20、Excel 表情导入 X21）决策前不得立项，立项需数据流/权限/误操作回退三件，默认不进任一批次退出条件 | P2-16 |
| I-05a 定义在线真值（对照账号在线 + 进程外 HTTP `getRecentMessages` 可达 + 网关探测三者同时成立）、异常注入、p95/最大值算法、每平台 2 轮、两种官方页变体、睡眠样本不并入；原阈值降为试验目标（X15），只保留停止条件为硬门槛 | P1-5 |
| I-06 验收改为「账号 × 路径 × 1 分钟桶」计数，A–B–A 对照配对与差值定义，「适配器自发 `getConversationList` 为 0」为独立硬指标，总量 ±5% 改为基线指标并写明其额外验证目标，加 fetch 钩子可观测性测试 | P1-6 |
| I-04a ③、I-25 ②、I-05b ④ 分别写明故障模型（A 进程终止在三个 fail point、B 文件系统错误注入、C 断电写成设计属性 + 属性测试 + 平台测试）、并发写入条件、重启读回判据与平台覆盖；不再用 `kill -9` 代称掉电；I-05b 的 20/20 标明为抽样并新增状态机属性测试 ⑤ | P1-7 |
| I-08 改为首轮 30 次基线采样、不进 B1 退出条件，由 X13 定门槛后再升级；§5.2 B1、§9 P2-13 同步 | P1-8 |
| I-02 规定 TS 用 `typescript` 编译器 API 做 AST 扫描（`typescript@6.0.3` 已是 devDependency）、Rust 用剥离注释/字符串的词法扫描；能力矩阵从 `capabilities/*.json` 构建期生成并与 `views.rs` label 双向比对；加入漏报/误报各 ≥ 3 的夹具 | P1-9 |
| I-19 明示内嵌撤销表的局限，新增根密钥签名的在线 `key-status.json`（版本单调、过期、防回滚、`min_client_version`）、离线更新行为；安装前钩子未能从代码核实（项目尚未引入 `tauri-plugin-updater`）→ X14；两平台安装前校验最小原型列为第一步验收 | P1-10 |
| I-10a 改为字段白名单 + 未知字段默认掩码，逐类写明账号标识、客户姓名、消息正文、URL 查询参数、文件路径的策略；上限改为 72 小时实测 × 1.5（200 MB 为基线）；敏感扫描覆盖轮转后的实际日志产物 | P1-11 |
| I-05b 新增做法 7「恢复边界」：重建前 `draining` 拒绝新写、进行中发送/上传超时转 `unknown` 由用户核对、恢复期间禁止自动重放、状态机边测试；与 I-14 `unknown` 态接口对齐 | P1-12 |
| I-14 第一个交付物为附件登记契约 v1（`docs/api/media-attachment-contract.md` + 版本号 + 契约测试）；I-17 新增前置「契约已冻结」；§5.2 B2 通道与退出条件写入依赖边 | P1-13 |
| I-05b「终态不重连」改为独立状态机属性测试（始终执行，进 B1 退出条件）；同账号浏览器并用 1 小时测试仅 X11 判定支持时执行；I-05b 硬前置新增「resource 冲突确认记录文件已存在」并进 B0 退出条件 | P1-14 |
| I-28 拆为 I-28a（虚拟化 + 行身份/锚点，必要）、I-28b（`mergeHistory` 增量化）、I-28c（全局 rerender patch 化，可选，须先有 I-28a 后测量证明仍是瓶颈）；owner 表与批次表更新 | P2-15 |
| I-05b CPU/RSS、I-10 的 30±1 s / 5 s、I-26 OCR 改为基线指标并补测量脚本与误差预算；I-26 写明只有取得同一模型版本与预处理才可与 PaddleOCR 比，否则改为中文订单截图测试集 ≥ 200 张的字段召回率；统一由 X22 定门槛 | P2-17 |
| §6 新增 X13–X22（谁决定、何时前、默认值）；§9 新增第二轮逐条闭环表，并按 Codex 复核结论改写第一轮 13 条状态 | 审查结构 |

### 8.5 2026-11-02 第五轮：官方桌面版实机接口截获（六轮）并入

依据 [实机接口截获验证](../reviews/2026-11-02-desktop-live-capture-verification.md)（被动 CDP + IM 子进程 Node HTTP 钩子，只记字段结构）。第一轮的三条（C7 会话列表为增量、C10 的 `reportInjectFnInfo`、I-06 的 3 秒话术轮询）此前已写入，本轮并入第二至六轮。

| 改动 | 来源 |
| --- | --- |
| C1 注明 SUP-01「热更新目录特权加载」现行生效状态待复核（当前运行脚本来自 `app.asar.unpacked/dist/`） | 第二轮 |
| I-06 计数口径增加「开会话组」与 `telemetry` 类；新增已读回执节奏（游标式、同 `msgId` 去重、官方重复发 2 次）与验收单测；新增网页 SDK 对 `iq set` 回传整条消息体的确认项 | 第二、三、五轮 |
| I-11 官方桌面基线复用 `tools/desktop-capture/capture.mjs`，并要求先修其卸载时误删应用监听的缺陷 | 方法与操作留痕 |
| I-14 写入文本主链路 XMPP `send`/`send_result`（约 0.15–0.21 秒）、图片与文件两种上传鉴权必须分别建模、撤回走 HTTP；验收新增 `send_result` 时延基线 | 第三、四轮 |
| I-15 新增「注入前/后 `fnInfo` 对比」为第二步，结论前不扩大注入面 | 第二轮 |
| I-23 B3 写入星标/转接/结束的实测体、`bizResponseStatus.resultCode` 成功判定、`groupId` 类型差异；置顶不上行改为本地偏好验收 | 第六轮 |
| I-24 补录清单：`getCurrentUserInfo`、`reportInjectFnInfo`、`batchTranslateByMsgIds.chatType`、`ab`、`qconfig/json`、`conversationType` B2C/C2B | 第二、四轮 |
| I-30a/I-30b 加入实证传输与字段 | 第三、四轮 |

仍未验证（沿用报告）：IM WebSocket 的 URL path 与子协议、图片/文件在 XMPP `send` 中的 `msgtype` 与 body 结构、置顶操作是否真正生效。桌面端已读请求不带 `x-ctx-*`/`w-payload-source` 头也被接受，但 vbk 在官方网页内发起，仍沿用网页行为，不据此裁剪请求头。

---

## 9. 审查闭环表

### 9.1 Codex 第一轮 13 条（状态按第二轮复核结论改写，第四轮补充后的落点）

| 发现 | 正文落点 | 第二轮复核结论 | 第四轮后状态 |
| --- | --- | --- | --- |
| P0-1 B0 退出条件要求 B1 重构 | I-04a、I-04b、§5.2 B0 行 | 基本解决，异步方案需补实现路径 | 已解决：I-04a 给出 std 线程 + mpsc 的具体设计与命令签名结论（本轮补充） |
| P0-2 互踢既是风险又要求通过 | I-05b 前置 ③、验收 ⑤⑥、X11、§5.2 B0/B1 行 | 部分解决：启动条件与不支持场景范围含糊 | 已解决（本轮补充）：resource 冲突确认记录文件为硬前置并进 B0 退出；终态属性测试始终执行；并用实机仅 X11 支持时执行 |
| P0-3 节流原型无阈值 | I-05a、X15 | 部分解决：误判真值与阈值依据不足 | 已解决（本轮补充）：在线真值三要素、注入、算法、重复次数、变体；阈值降为试验目标，只保留停止条件为硬门槛 |
| P0-4 单写者规则被违反 | §5.1、I-30 接入规则、I-23 | 未完全解决：B2 的 I-30 与 `main.ts` 目录级归属不可派工 | 已解决（本轮补充）：I-30a–n 文件级拆分；`main.ts` B2–B4 唯一 owner I-23；单一注册点 |
| P1-5 数字缺定义 | I-04a ④、I-05a、I-05b 验收 1–6、I-06、I-08、I-10、I-25、I-26、I-28a、X22 | 部分解决：百分位算法、基线配对、故障模型、产品来源仍缺 | 大部分解决（本轮补充）：算法、配对、故障模型已写明；产品来源归 X13/X15/X22，决策前相关数字只作基线 |
| P1-6 门禁误报与对象错配 | I-02 做法 1、3、4、验收 ① | 部分解决：未定义解析方式与矩阵来源 | 已解决（本轮补充）：AST/词法扫描规定、矩阵构建期生成与双向比对、正反例夹具 |
| P1-7 B2/B3 顺序与依赖 | I-18、I-27、I-02 改动位置、I-14/I-17、§5.2 | 基本解决，实现时验证产物链 | 已解决；I-14→I-17 依赖边本轮补入 |
| P1-8 目标机证据与批次不一致 | §3 开头、各工作项标题、§5.2 末段 | 基本解决，部分「目标机」执行条件待细化 | 基本解决：I-05a/I-05b/I-06/I-10 的执行条件本轮细化；其余项在派工时按 §5 交付物要求细化 |
| P1-9 保活参数扩大攻击面 | I-05b 做法 4、X22 | 基本解决，活动策略与资源阈值需实测 | 基本解决：资源阈值降为基线指标，合入条件改为可关闭且与对照一致 |
| P1-10 持久化并发与崩溃语义 | I-04a 清单 W1–W6、做法 1–4、验收 ②③ | 部分解决：未覆盖所有同步写路径；强杀不能证明掉电 | 已解决（本轮补充）：写路径清单全覆盖；断电写成设计属性 + 属性测试 |
| P1-11 更新器信任链 | I-19、X14 | 部分解决：旧版撤销与平台安装器钩子未证明 | 部分解决→有意保留为 X14：在线密钥状态文件与局限已写明；安装前钩子能力只能由最小原型证明，列为 I-19 第一步验收 |
| P2-12 I-02 塞进发布治理 | I-02 改动位置、做法 4、I-18、I-29 | 部分解决：DOM 门禁前置与 B0/B1 顺序冲突 | 已解决（本轮补充）：分阶段允许清单 |
| P2-13 指标过度优化 | I-28a/b/c、I-18、I-08、X13、C12 | 未闭环：30/30 仍是隐含硬门槛且与「用户决定」冲突 | 已解决（本轮补充）：I-08 首轮为基线采样、不进 B1 退出条件，门槛由 X13 定 |

### 9.2 Codex 第二轮 17 条

| 发现 | 正文落点 | 状态 |
| --- | --- | --- |
| P0-1 I-02 DOM 门禁与 I-29 循环依赖 | I-02 做法 4、验收 ⑤；I-29 改动位置；§5.1；§5.2 B0/B1 | 已解决：允许清单分阶段 |
| P0-2 I-04a 异步设计不完整 | I-04a 现状、做法 1–4 | 已解决：撤回 async 属性做法；`adapter_ready` 删除；队列设计具体化；命令签名保持并写明例外流程 |
| P0-3 锁内写路径未全覆盖 | I-04a 清单 W1–W6、验收 ② | 已解决：清单含 `persist_compensation` 两处（调用 `:203`、定义 `:246-268`）与 `persist_rounds`；fsync 口径重述；逐条断言 |
| P0-4 I-30 与 B2 owner 粒度 | I-30 接入规则与子项表、I-23 改动位置、§5.1、§5.2 | 已解决：14 个子项文件级拆分、单一 owner、单一注册点 |
| P1-5 I-05a 误判真值与阈值 | I-05a 做法/验收、X15 | 已解决：真值、注入、算法、重复、变体、睡眠规则；试验目标 vs 停止条件 |
| P1-6 I-06 ±5% 不可复现 | I-06 验收 1–5 | 已解决：时间桶计数、A–B–A 配对、独立硬指标、总量降为基线 |
| P1-7 零失败门槛缺故障模型 | I-04a 验收 ③、I-25 验收 ②、I-05b 验收 ④⑤ | 已解决：故障模型 A/B/C、并发条件、读回判据、平台覆盖；20/20 标为抽样并加属性测试 |
| P1-8 I-08 30/30 自相矛盾 | I-08 验收、X13、§5.2 B1 | 已解决：采用「基线采样 + X13 定门槛」 |
| P1-9 I-02 扫描方式与矩阵来源 | I-02 做法 1、3、验收 ① | 已解决：AST/词法、构建期矩阵、双向比对、正反例夹具 |
| P1-10 I-19 撤销无法覆盖旧客户端 | I-19 做法/验收 ①⑥、X14 | 部分解决（有意保留）：局限明示、在线密钥状态文件、防回滚、离线行为已写；安装前钩子能力留 X14 与最小原型 |
| P1-11 I-10a 脱敏范围与容量 | I-10a 做法/验收 | 已解决：白名单 + 默认掩码、逐类策略、容量由实测定、扫描实际产物 |
| P1-12 I-05b 恢复边界 | I-05b 做法 7、验收 ④ | 已解决 |
| P1-13 I-14→I-17 依赖边 | I-14 做法/验收 ①、I-17 前置、§5.1、§5.2 B2 | 已解决 |
| P1-14 X11 与互踢默认必测 | I-05b 前置 ③、验收 ⑤⑥、§5.2 B0/B1 | 已解决 |
| P2-15 I-28 范围过大 | I-28a/b/c、§5.1、§5.2 | 已解决：拆分，I-28c 有立项条件 |
| P2-16 I-30 范围与安全评估 | I-30 接入规则第 5 条、子项表风险列、X16–X21 | 已解决：高风险子项决策前不立项、三件文档、默认不进退出条件 |
| P2-17 数字来源 | I-05b 做法 4、I-10 验收、I-26 验收、X22 | 已解决：降为基线并补测量脚本/数据集/误差预算；OCR 可比性条件写明 |

### 9.3 file:line 复核备注（`main@d578872`，第四轮全部重新核对）

第三轮备注仍成立：`adapter.rs:517-535,550-566` 为持锁调用 `emit_agent_status_event`（`emit_to` 在 `:594`）；`store.rs` `Txn::into_parts`（`:136-147`）；`display.rs` `write_atomic`（`:1033-1043`）；`prefs.rs` 保存（`:352-360`，函数 `save` 为 `:346-362`）；`state.rs` `set_dnd_until_tomorrow`（`:483-495`）；`conversationList.ts` poller（`:132-198`），`pagehide`（`boot.ts:371`）；smoke 断言（`run.mjs:213,235-241`）；`main.ts` `list.empty` 渲染点 `:1457`，加载路径 `:464-511`。

第四轮新增/修正：`adapter_ready` 为 `adapter.rs:1023-1024`（`#[tauri::command]` + `pub fn`，同步），`adapter_push_fact` 为 `:1069-1070`（同），`account_set_remark` 为 `login.rs:1102-1103`（同，第三轮未给行号）；`state.rs`：`lock` `:140-145`，`push_fact` `:172-241`（持锁自 `:176`），`persist_compensation` 调用 `:203`、定义 `:246-268`，`compensation_watermark` `:270-283`，`pump_rounds` `:285-310`（`:309` 调 `persist_rounds`），`persist_rounds` `:315-343`，`restore_rounds_for` `:354`，`resync_complete` `:401-424`（`:422` 调 `pump_rounds`），`logout` `:506-531`（`:529`）；`core-store/src/file.rs`：`sync_namespace` `:66-78`，`save` `:178-186`，`commit` `:202-211`（第三轮写 `:204-213`，以本轮为准），`write_atomic` `:249-272`（`sync_all` `:259`、`sync_directory` 调用 `:264`），`sync_directory` `:274-286`，`create_durable_dir_all` 的目录 fsync `:318-330`；`login.rs`：`persist` `:167-194`，`write_atomic` `:196-204`（无 fsync），`persist_and_emit` `:321`，其调用点 `:819,998,1059,1116,1350,1397,1449`；`prefs.rs`：`sync_reminder` `:446-458`，另两处保存 `:488-497`、`:540-548`，`scheduler.rs:131` 每 tick 调用；`outbound_journal.rs` `durability_barrier` `:148-150`；`adapter.rs` 异步命令 `im_send_media` `:746`、`im_send_text` `:1358`、`im_invite_candidates` `:1534`、`im_invite` `:1608`；`assistant.rs:168` 已用 `tauri::async_runtime::spawn_blocking`；`src-tauri/Cargo.toml:40` tokio 只开 `time`/`sync`，未引入 `tauri-plugin-updater`；`companion-card.ts:70` 仍是 `ui/apps`、`ui/packages` 非测试源码中唯一 `innerHTML|outerHTML|insertAdjacentHTML|document.write|srcdoc` 命中；`ui-kit/src/h.ts` `mount` `:116-118`、`rerender` `:125-163`（`:143` 调 `mount`）；`vbk/package.json:21` `typescript` `6.0.3`；`src-tauri/capabilities/` 共 7 个文件（`adapter,login,main,package-detail,popups,setting,update`），`adapter.json` 远程源 2 个、`allow-adapter-*` 5 条；`src-tauri/commands.txt` 73 条非空行；`ui/apps/main/` 非测试 `.ts` 共 19 个文件（`main.ts` 2454 行）。
