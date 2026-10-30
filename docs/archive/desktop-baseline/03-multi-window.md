> 历史归档：本篇为范围收敛前的设计快照，全部旧任务、工期和验收要求已停止生效。当前依据为[范围决定](../../decisions/2026-10-30-web-only-scope.md)与[总计划](../../plan/00-master-development-plan.md)。

# 副窗口清单与 Tauri 实现边界

> **范围已变更（2026-10-30）**：以[网页版范围决定](../../decisions/2026-10-30-web-only-scope.md)为准。只做目标网页已有的消息、通知和订单联系入口；网页没有的功能不做。本文超出该范围的桌面对齐、扩展功能与验收要求均作为历史参考，不再执行。

2026-10-30 · 最终文档审查修订

## 结论：有实现路径，平台细节必须验证

普通多窗口、无边框、置顶、托盘和系统通知有 Tauri 或原生接口可用。**不能据此承诺所有原客户端行为等价可用，也不能把全屏覆盖、非激活面板、多屏 DPI 写成“补几行调用即可”。** 独占全屏、安全桌面、系统锁屏、RDP、macOS Spaces 与权限都有独立约束；失败时应明确降级而非抢焦点或绕过系统限制。

## 官方窗口与页面清单

来源为 Windows 1.2.12 的静态页面和主进程代码；页面不等于独立顶层窗口。

| 页面 / 类型 | 官方承载与用途 | 新方案 |
| --- | --- | --- |
| main、launch、login | 主外壳、启动页、本地登录页 | main 与登录外壳重写；登录远程页独立无权限 WebView；删除独立 launch |
| home、order、product、comment、bulletin、course、event、data（bi） | 8 个业务入口；本地外壳，部分本地内容、部分远程 iframe | 重写外壳，远程内容用顶层子 WebView；兼容性逐入口验证 |
| imPlus（imWindow bundle） | 主窗口中的 IM BrowserView | 本地 IM 重写；独立窗或嵌入模式须在 G0 冻结 |
| alarm、notifier | 倒计时与无边框横幅 | 可复用小窗；不抢输入焦点；本地提醒状态来自核心 |
| notice | 主窗口内预加载的系统通知中心页 | 通知中心归ui-shell内路由，不新增同名确认弹窗 |
| toolTip | 托盘悬浮提示 | 按平台事件实现；托盘重建、失焦与鼠标离开需验收 |
| screenshotsOverlay | 每屏透明截图遮罩，截图时显示 | 按预算懒建/预热；物理像素采集与逻辑坐标显示分开 |
| screenshots | 旧截图页面，V2后是否仍用未完全确认 | 不据文件存在直接承诺迁移 |
| image、video、web | 图片、视频、通用工作台 | 按明确窗口/标签上限复用；账号与来源视图绑定 |
| ai、setting、update、archGuide | IM总结侧窗、主窗口设置页、更新与架构引导 | ai形态待定；设置可独立；按目标架构发包，archGuide不照搬 |

## 能力对照与边界

| 需求 | 实现候选 | 必须验证 / 降级 |
| --- | --- | --- |
| 独立 WebView 窗口 | `WebviewWindowBuilder` | 生命周期、账号存储、焦点与崩溃重建 |
| 同窗多子 WebView | `Window::add_child` | 当前公开文档仍标 `unstable`；失败退回独立窗口 |
| 无边框、透明、置顶 | `decorations(false)`、`transparent(true)`、`always_on_top(true)` | 高对比度、RDP、GPU降级；透明失败用不透明样式 |
| 全屏场景截图遮罩 | Windows窗口样式/位置、macOS层级/Spaces原生适配 | 不承诺覆盖独占全屏、安全桌面或锁屏；不支持时退出截图并解释原因 |
| 显示不激活 | Tauri焦点设置 + Windows `WS_EX_NOACTIVATE` / macOS非激活面板候选 | `focused(false)` 不能独自证明后续show永不激活；测试中文IME、其他应用输入、关闭后焦点恢复 |
| 多桌面 | 按平台原生能力 | `visible_on_all_workspaces` 不代表Windows虚拟桌面全覆盖；macOS同样验证全屏Space |
| 鼠标穿透 | `set_ignore_cursor_events` | 整窗穿透不是按CSS透明区域自动命中；需要交互按钮时不能整窗穿透 |
| 边缘定位 | 监视器枚举 + 工作区API | 监视器尺寸不等于工作区；任务栏、负坐标、混合DPI、热插拔均测 |
| 托盘、闪烁、Toast | Tauri托盘/通知与平台适配 | Explorer重启、AUMID、冷启动激活、勿扰策略；提示不等于已读或已回复 |
| 隐藏预热 | 少量复用控制器 | 不把所有遮罩/副窗常驻作为默认；计入完整进程组，浏览器故障后隐藏窗口也须失效重建 |

依据：[Tauri WebviewBuilder](https://docs.rs/tauri/latest/tauri/webview/struct.WebviewBuilder.html)、[Microsoft WebView2 进程模型](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/process-model)。具体 API 以 G0 固定的依赖版本为准。

## 资源与隔离

一个新 WebView 控制器不等于一个固定大小的新进程，也不保证比 Electron 窗口增量更小。同一环境可共享浏览器进程，但不同域仍可能产生 renderer；独立用户数据目录各有进程组。同环境多账号 Profile 隔离是待验证优化，不得先假定所有窗口共用一个存储目录。

业务页、IM传输、截图与预览分别设数量和内存上限。窗口注册表记录账号上下文、视图代次、浏览器环境代次；窗口关闭/重建后拒绝旧回调，不能只按复用label发送数据。权限和事件规则见 [开发总纲](dev/00-architecture.md)。

## 开发前原型与验收

1. 非激活提醒：连续20条提醒，中文IME和其他应用输入不被打断；点击跳转与确认使用实际看到的消息版本。
2. 截图：双屏100%/125%/150%/200%、负坐标、主屏切换、副屏拔插、RDP；框选、标注、保存坐标一致，退出后无残留遮罩。
3. 生命周期：隐藏到托盘、WebView browser进程故障、锁屏/睡眠恢复；所有可见及隐藏控制器按环境代次重建，提醒先对账再恢复。
4. 性能：相同账号/页面/功能/预热条件测全进程组内存、CPU、句柄、输入P95及驻留变化；不把小窗页面尺寸当作低内存证据。

本轮为文档与证据审查，以上 Tauri 原型尚未执行。模块级步骤见 [壳](dev/01-shell.md)、[强提醒](dev/03-strong-alert.md)、[媒体工具](dev/07-media.md)。
