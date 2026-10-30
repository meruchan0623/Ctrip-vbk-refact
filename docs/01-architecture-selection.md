# 当前架构选择

2026-10-30。产品范围为网页 IM、通知与订单联系入口，唯一额外能力为独立强提醒窗口。

Tauri 2 + Rust 是宿主候选；Windows/WebView2 先做最小原型，验证网页身份、Web SDK 消息、主窗口隐藏后的事件连续性和独立窗口不抢焦点显示。macOS 没有完成同样验证前不承诺支持。

不继续进行全面桌面客户端移植、桌面 SDK sidecar 对照或原生协议重写。先验证网页消息是否可靠提供结构化事实，再决定页面直接承载与本地界面的接入方式。

当前设计：[开发总纲](dev/00-architecture.md)、[独立强提醒](dev/03-strong-alert.md)、[开发计划](plan/00-master-development-plan.md)。旧选型比较见[历史归档](archive/desktop-baseline/01-architecture-selection.md)，不作为功能清单或工期承诺。
