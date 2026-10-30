# 分计划 01：身份与最小基础

2026-10-30。对应[总计划](00-master-development-plan.md) P0/P1。

1. 建立最小宿主工程及 `main/alarm` 注册、加载与退出流程。
2. 跑通官方网页登录和当前身份读取；隔离凭据，建立登录/视图代次。
3. 验证 Web SDK/目标网页的结构化消息接入，区分初始化、实时、历史与补偿。
4. 定义网页事实到本地等待计算的有界事件契约，处理重复、跳号、乱序与旧身份回调。
5. 只持久化必要消息状态和提醒 round/version/隐藏记录；恢复先对账。

完成依据：[登录](../dev/02-account-login.md)、[最小存储](../dev/05-store.md)、[网络](../dev/06-net.md)。不建设多账号迁移、通用数据库/网络产品或旧 Electron 兼容层。原计划见[归档](../archive/desktop-baseline/plan/01-foundation-account-data.md)。
