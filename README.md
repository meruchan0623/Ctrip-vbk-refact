# Ctrip-vbk-refact

以携程网页版 IM 为业务基准的客户端重构规划。携程业务只保留消息、通知，以及订单“详情 → IM 联系 → 网页会话”的联系入口；左侧栏其他携程业务模块（首页、工作台、事件、公告、商服、产品、数据、点评、完整订单管理）删除。

本项目自有能力保留：多账号、托盘与任务栏、独立回复超时强提醒窗口、商家助手（TSim、出站翻译、套餐速览）、截图/OCR、客户端更新与诊断。

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
