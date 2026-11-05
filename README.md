# 旅游商家IM

旅游商家IM（仓库名 Ctrip-vbk-refact，工程代号 VBooking / vbk）是面向商家的携程网页版 IM 桌面客户端。它把携程商家网页中的消息与通知接入本地应用，并在此基础上提供多账号、独立强提醒和商家助手等本地能力。

工程结构：宿主为 Tauri 2（Rust），核心逻辑为仅依赖 `std` 的 Rust crate，界面与网页适配器为无运行时依赖的 TypeScript。

## 主要功能

- **携程消息与通知**：在本地窗口中打开携程商家 IM 会话，接收消息并显示未读。
- **订单联系入口**：订单详情 → IM 联系 → 网页会话，直接进入对应客人的会话。
- **强提醒**：会话长时间未回复时，以独立提醒窗口逐级升级（L0–L4）；只有服务端确认的商家回复、会话结束或转出才会清除。
- **多账号**：多个商家账号各自隔离身份、登录态与提醒。
- **托盘与未读提示**：托盘、Dock、窗口标题显示未读状态；支持稍后提醒与勿扰。
- **商家助手**：TSim 查询、出站消息翻译、套餐速览。
- **Chrome 登录态复用**：复用 Chrome 中已有的登录态，接入说明见 [Chrome 登录接入](docs/integrations/2026-11-03-chrome-login.md)。
- **更新与诊断**：客户端更新与诊断能力仍在补齐，当前进度见 [PROGRESS.md](PROGRESS.md)。

## 范围说明

- 携程业务只保留消息、通知和订单联系入口。左侧栏的首页、工作台、事件、公告、商服、产品、数据、点评、完整订单管理等模块不提供，见 [范围决定](docs/decisions/2026-10-30-web-only-scope.md)。
- 截图与标注已删除，见 [决定记录](docs/decisions/2026-11-05-no-screenshot.md)；OCR 目前没有实现。

## 当前状态

代码落盘不等于验收。G1–G5 运行验收尚未通过：Windows 候选包通过了本机离线检查，但整体验收未通过；macOS 包为未签名、未公证的构建，仅供内部冒烟。当前断点见 [PROGRESS.md](PROGRESS.md) 与 [BLOCKED.md](BLOCKED.md)。

## 安装与构建

两个平台都先在 `vbk/` 下执行 `npm ci`。

- **macOS**（Apple Silicon）：`npx tauri build --target aarch64-apple-darwin`；Intel 用 `x86_64-apple-darwin`。产物为 `.app` 与 `.dmg`。
- **Windows**：在 Windows 机器上执行 `cargo tauri build`，生成 NSIS 安装包（当前用户安装，WebView2 随包引导安装）。

给测试人员的 macOS 包须用共用测试签名打包，否则换包后钥匙串登录会失效，见 [vbk/README.md](vbk/README.md)。

## 工程结构

```
vbk/
├─ crates/          Rust 核心 crate（std-only）：账号、存储、网络策略、IM 去重与发送队列、提醒升级
├─ src-tauri/       Tauri 2 宿主：窗口、托盘、调度、HTTP、钥匙串等平台能力
└─ ui/              TypeScript 界面与网页适配器（packages/、apps/）
browser-extension/  Chrome 登录态复用扩展
docs/               设计文档、决定记录、接口与调查资料
```

设计总纲见 [开发总纲](docs/dev/00-architecture.md)，工程说明与本地检查命令见 [vbk/README.md](vbk/README.md)。

## 开发资料

**工程入口：[`vbk/`](vbk/README.md)**。按开发文档落盘的 Tauri 2 宿主、std-only Rust 核心 crate 与无依赖 TypeScript 适配器/界面；`cargo test` 与 `npm run check` 在仓库内可直接运行。代码落盘不等于 G1–G5 运行验收通过；`vbk-electron/` 是调查样本，不是本项目新客户端实现。

**并行开发派工入口：[总和开发计划](docs/plan/00-master-development-plan.md)**。汇总全部模块任务、公共契约、文件归属、最多 7 个代理的分批调度、验收关口与对抗审查修订；完整任务正文在同一份 Markdown 中。计划完成不代表产品实现或 G1–G5 验收完成。

**开发入口：[开发前最终对抗性审查](docs/reviews/2026-10-30-final-adversarial-review.md)**。本轮已将账号隔离、发送未知结果、同步水位、提醒语义、迁移恢复、远程桥与更新安全规则回写全部相关模块。可以进入基础工程和 G0 关键路径原型；G1–G5 尚未运行验收，不应把接口观测当成全功能方案冻结。

## 当前开发入口

2026-10-31 Windows接续已到原第6轮上限并停止，整体验收未通过。已生成并运行本机Windows候选包，完整离线检查通过；历史分页视觉失败、官方网页登录和真实双向/媒体等缺口仍保留。当前断点见[PROGRESS](PROGRESS.md)、[BLOCKED](BLOCKED.md)与[第6轮产物及运行记录](docs/research/2026-10-31-round6-windows-runtime.md)。这不是正式发布或TSim整体接入。

| 文档 | 用途 |
| --- | --- |
| [逐接口请求契约与开发准入](docs/api/README.md) | 完整 Header、Authentication、方法、嵌套参数、脱敏样本与未闭环项；全部必要要素齐备后才开发 |
| [范围决定](docs/decisions/2026-10-30-web-only-scope.md) | 携程业务以网页为基准、只删左侧栏业务模块；自有功能保留 |
| [开发总纲](docs/dev/00-architecture.md) | 当前架构、职责与实现边界 |
| [原型还原与端到端接线计划](docs/plan/2026-10-30-prototype-restoration-plan.md) | 当前执行顺序：macOS 外观、契约统一、登录、IM 数据接线 |
| [收敛后的开发计划](docs/plan/00-master-development-plan.md) | 范围、不变量与任务正文 |
| [rea 逆向分析与 Tauri 实施计划](docs/reverse/2026-11-01-rea/00-README.md) | 官方 Mac 1.2.13 / Win 1.2.12 的功能清单、架构、44+ 项缺陷；vbk 差距；30 个模块的依赖、波次、验收标准与风险 |
| [基于逆向结论的改进开发计划](docs/plan/2026-11-02-reverse-driven-improvement-plan.md) | 34 个工作项 I-00~I-30（I-28/I-30 已拆子项）、12 条改造决定、禁止事项、B0–B4 批次与退出条件、需用户拍板的 X1–X22；已按两份官方客户端实物验证、两轮 Codex 对抗性审查与六轮官方桌面实机接口截获共五次修订（持久化出主线程的锁内写路径清单、分阶段 DOM 门禁、文件级 owner 表、基线指标与硬门槛分离） |
| [改进计划的实物验证](docs/reviews/2026-11-02-reverse-plan-verification.md) | 用官方 Mac 1.2.13（x86_64）与 Win 1.2.12 实物五路并行验证逆向结论、传输路线可行性、vbk 前后端稳固性；修正 7 条逆向结论，列出 P0/P1 缺陷与 14 项漏列功能 |
| [官方桌面版实机接口截获验证](docs/reviews/2026-11-02-desktop-live-capture-verification.md) | 对运行中的官方 Mac 1.2.13 被动截获六轮（轮询、开会话、出站、已读、撤回、星标/转接/结束），只记字段结构；修正 rea 的全量轮询与 3 秒坐席轮询结论，确认文本走 XMPP、已读由 IM 子进程发、置顶不上行 |
| [首轮落盘与对抗性审查记录](docs/reviews/2026-11-02-implementation-adversarial-review.md) | 2026-11-02 按改进计划并行落盘 A/B 类部分（cargo test 516、npm test 932、门禁 178 夹具 0 违规）与 6 路对抗性审查的发现/修复/未修清单；宿主未编译、C 类未做、8 项待拍板 |
| 改进计划的 Codex 对抗性审查（[第一轮](docs/reviews/2026-11-02-codex-adversarial-review-01.md)、[第二轮](docs/reviews/2026-11-02-codex-adversarial-review-02.md)） | Codex 输出原文存档：第一轮 13 条、第二轮 17 条发现及 §9 闭环复核；两轮结论均为「须先修订再开工」，计划 §9 逐条回应 |
| [独立强提醒窗口](docs/dev/03-strong-alert.md) | 消息来源、等待轮次、独立窗口、恢复和验收 |
| [订单联系客人](docs/research/2026-10-30-web-order-conversation.md) | 已实测的订单详情与 IM 联系流程 |
| [网页提醒调查](docs/research/2026-10-30-web-reminders.md) | 网页实际行为，区别于新扩展 |
| [网页 IM 调查](docs/research/2026-10-30-web-im-observation.md) | 消息、鉴权与传输证据及其边界 |
| [长连接与会话轮询](docs/research/2026-10-30-web-im-transport-and-polling.md) | XMPP/WSS 握手与心跳、两入口约 5 秒会话列表轮询、消息补偿与版本边界 |
| [接口复查](docs/research/2026-10-30-missing-apis.md) | 网页必要契约的已知项与剩余验证 |
| [后端接口支持对照](docs/research/2026-10-30-backend-support-matrix.md) | 区分受控验证、观测缺口、静态候选及外部能力 |
| [浏览器接口实测](docs/research/2026-10-30-browser-api-validation.md) | 受控会话真实调试、接口修正、业务失败及剩余验证项 |
| [并入 TSim_CS 的架构研究](docs/05-tsim-cs-merge-research.md) | KKday 工作台并入模式、方案对比、请求路由与 CORS 教训、M0–M6 阶段计划与待决问题 |

## 文档状态

`docs/dev/`、`docs/plan/` 为收敛后的当前设计。`docs/research/` 和 `docs/observations/` 保留调查事实；其中发现的接口不自动成为功能要求。`docs/reviews/` 是对应历史快照的审查记录。

旧的全面桌面重构正文移到 [docs/archive/desktop-baseline](docs/archive/desktop-baseline/README.md)，只用于追溯，不作为任务、工期或验收依据。其中完整业务页不再进入计划；多账号、托盘、商家助手、截图/OCR、更新等自有模块仍以归档正文为详细设计依据。
