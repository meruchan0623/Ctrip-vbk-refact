# Ctrip-vbk-refact

携程旅游商家桌面客户端（vbooking，当前为 Electron 27）的重构项目，覆盖 Windows 与 macOS，Windows 优先。

当前阶段只做重构规划与原型，不包含真实的后端代码或前端 TS/JS 组件代码。

**开发入口：[开发前最终对抗性审查](docs/reviews/2026-10-30-final-adversarial-review.md)**。本轮已将账号隔离、发送未知结果、同步水位、提醒语义、迁移恢复、远程桥与更新安全规则回写全部相关模块。可以进入基础工程和 G0 关键路径原型；G1–G5 尚未运行验收，不应把接口观测当成全功能方案冻结。

## 文档

| 文档 | 内容 |
| --- | --- |
| [01 架构选型](docs/01-architecture-selection.md) | 现有客户端拆包结果、Tauri 2 + Rust 与 C# + Swift 对比、目标架构、分阶段计划 |
| [02 现有客户端缺陷](docs/02-current-client-defects.md) | 官方客户端在 Windows / macOS 上的卡顿与安全缺陷，Electron 去留结论，复用范围修正 |
| [03 副窗口](docs/03-multi-window.md) | 官方副窗口清单（IM 倒计时、横幅、截图等）与 Tauri 实现方式 |
| [04 模块划分与联动](docs/04-modules-and-integration.md) | 全部组件盘点（含登录）、Rust 核心与前端模块划分、命令/事件联动、开发顺序 |
| [最终对抗性审查（2026-10-30）](docs/reviews/2026-10-30-final-adversarial-review.md) | 全文档审查、修正清单、网页复核与证据复算、开发准入和 G1–G5 验收关口 |
| [Windows 前轮审查（2026-10-30）](docs/reviews/2026-10-30-windows-adversarial-review.md) | 保留原基线的历史记录；当前契约以最终审查及已修订模块为准 |

新增调查：[IM 网页与客户端接口选型决策](docs/decisions/2026-10-30-im-transport.md)（已完成网页登录、XMPP 连接和130秒自然入站观测，含 SDK/鉴权/重试差异与替换条件）。

[旅游商家客户端实机观测（2026-10-30）](docs/observations/2026-10-30-desktop-runtime.md)：进程、网络连接、启动日志、接口核对及待决策项；已完成两轮 HTTP 应用层抓包，Node 长连接与完整收发链路待补。

[IM 边际功能接口补充](docs/research/2026-10-30-im-peripheral-apis.md)：成员转移/邀请/移除、结束动作、侧栏字段映射、产品推荐查询与卡片发送、分业务线订单入口；区分动态观测、静态契约和待验收项。

[未找到的接口清单](docs/research/2026-10-30-missing-apis.md)：汇总尚无后端接口或服务端规则未知的功能点（核对发送结果、置顶/星标、续期、角标、更新源、遥测接收端等）及补充探查建议。

### 各模块开发文档（docs/dev）

| 文档 | 内容 |
| --- | --- |
| [00 开发总纲](docs/dev/00-architecture.md) | 整体架构、Tauri（WebView 前端）与 Rust 核心的分工、工程结构、命令/事件/权限约定、窗口标签、性能预算、里程碑、新发现与工作量汇总 |
| [01 壳与窗口管理](docs/dev/01-shell.md) | 窗口注册表与预热、主外壳、托盘、单实例与深链、快捷键、自启 |
| [02 账号与登录](docs/dev/02-account-login.md) | 内嵌网页登录、多账号与 WebView2 Profile 隔离、凭据库、ticket 续期、旧数据迁移 |
| [03 强提醒](docs/dev/03-strong-alert.md) | 五级提醒升级、回复超时计时、横幅/倒计时/通知/托盘小窗、提示音、勿扰与全屏降级 |
| [04 业务页承载](docs/dev/04-business-pages.md) | 远程 vbooking 页承载、bridge 兼容层、导航与下载、保活回收 |
| [05 本地存储](docs/dev/05-store.md) | rusqlite、分库、迁移、KV、旧库导入、备份与清理 |
| [06 网络](docs/dev/06-net.md) | 统一 HTTP 客户端、代理与 PAC、Cookie 同步、环境切换、受限 fetch |
| [07 媒体工具](docs/dev/07-media.md) | 多屏截图、OCR、中文纠错、下载、图片与视频预览 |
| [08 更新、诊断与偏好](docs/dev/08-update-telemetry.md) | 签名更新、日志与崩溃、埋点、偏好、多语言、诊断包 |
| [09 商家助手](docs/dev/09-assistant.md) | 插件功能内置：翻译、TSim、订单查询、套餐速览 |
| [10 IM](docs/dev/10-im.md) | Web SDK / Node sidecar 候选、outbox 与未知结果、补拉水位、core-im 状态、ui-im 性能设计 |

## 当前结论

以 **Tauri 2 + Rust** 为首选候选，先验证 Windows（WebView2），macOS（WKWebView）第二阶段跟进。新外壳替代 Electron，本地 IM 界面重写，远程 vbooking 内容逐入口验证兼容；消息传输在 Web SDK 与 Node sidecar 完成同场景闭环后选择。内存、包体和性能收益以对照实测为准。

## 目录

```
docs/          设计文档
docs/images/   文档配图
```
