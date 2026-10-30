# IM 路线决定：以网页为准

2026-10-30。用户已决定以网页版接口和能力为基准，另保留[独立强提醒窗口](../dev/03-strong-alert.md)。本篇替换早先 Web/桌面双路线比较。

业务 API、鉴权和实时消息以目标网页的实际版本为依据；Web SDK 使用 XMPP over WSS 与 HTTP 补偿的现有证据，见[网页调查](../research/2026-10-30-web-im-observation.md)。不再安排桌面 Node SDK sidecar 或原生协议重写，也不把它们作为未验收的自动回退。

网页源码可读和已观测到入站，不代表可脱离原站运行或后台可靠。原型必须验证登录态、Origin、收发回执、断线补偿、失效、主窗口隐藏与独立提醒的数据接入。当前既不能声称 HTTP 调用可代替实时收消息，也不能声称新传输已达到全量收发验收。

当前方案见[总纲](../dev/00-architecture.md)与[计划](../plan/00-master-development-plan.md)。此前对比及样本差异保留在[历史归档](../archive/desktop-baseline/decisions/2026-10-30-im-transport.md)。
