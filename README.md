# Ctrip-vbk-refact

以携程网页版 IM 为业务基准的客户端重构规划。携程业务只保留消息、通知，以及订单“详情 → IM 联系 → 网页会话”的联系入口；左侧栏其他携程业务模块（首页、工作台、事件、公告、商服、产品、数据、点评、完整订单管理）删除。

本项目自有能力保留：多账号、托盘与任务栏、独立回复超时强提醒窗口、商家助手（TSim、出站翻译、套餐速览）、截图/OCR、客户端更新与诊断。

仓库当前为调查与设计阶段，尚无本项目可运行的客户端工程。`vbk-electron/` 是调查样本，不是本项目新客户端实现；文档完成不代表功能实现或验收通过。

## 当前开发入口

| 文档 | 用途 |
| --- | --- |
| [范围决定](docs/decisions/2026-10-30-web-only-scope.md) | 携程业务以网页为基准、只删左侧栏业务模块；自有功能保留 |
| [开发总纲](docs/dev/00-architecture.md) | 当前架构、职责与实现边界 |
| [收敛后的开发计划](docs/plan/00-master-development-plan.md) | 当前任务与验收顺序 |
| [独立强提醒窗口](docs/dev/03-strong-alert.md) | 消息来源、等待轮次、独立窗口、恢复和验收 |
| [订单联系客人](docs/research/2026-10-30-web-order-conversation.md) | 已实测的订单详情与 IM 联系流程 |
| [网页提醒调查](docs/research/2026-10-30-web-reminders.md) | 网页实际行为，区别于新扩展 |
| [网页 IM 调查](docs/research/2026-10-30-web-im-observation.md) | 消息、鉴权与传输证据及其边界 |
| [接口复查](docs/research/2026-10-30-missing-apis.md) | 网页必要契约的已知项与剩余验证 |

## 文档状态

`docs/dev/`、`docs/plan/` 为收敛后的当前设计。`docs/research/` 和 `docs/observations/` 保留调查事实；其中发现的接口不自动成为功能要求。`docs/reviews/` 是对应历史快照的审查记录。

旧的全面桌面重构正文移到 [docs/archive/desktop-baseline](docs/archive/desktop-baseline/README.md)，只用于追溯，不作为任务、工期或验收依据。其中完整业务页不再进入计划；多账号、托盘、商家助手、截图/OCR、更新等自有模块仍以归档正文为详细设计依据。
