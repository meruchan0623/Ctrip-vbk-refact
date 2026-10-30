# 副窗口清单与 Tauri 实现方式

2026-10-30

## 结论：全部能实现

官方客户端的副窗口全部能用 Tauri 2 实现。大部分能力有现成 API，有 3 类需要在 Rust 里补几行平台原生调用：浮在全屏应用之上、macOS 不抢焦点的面板、截图遮罩的多屏 DPI。这些都是窗口层面的事，与是否使用 Electron 无关。

## 官方客户端的窗口清单

来源：Windows 版 1.2.12 的 `app.asar`（`dist/src/pages/` 目录与 `dist-electron/main/index.js` 中的窗口参数）。

| 窗口 | 用途（据页面名与参数推断） | 关键窗口特性 |
| --- | --- | --- |
| main、launch、login | 主窗口、启动页、登录 | 常规窗口；每个账号一套 BrowserView 加载远程业务页 |
| home、order、product、comment、bulletin、course、event、bi | 业务模块窗口 | 常规窗口，多为远程页面 |
| im、imPlus | IM 会话 | 常规窗口；重写的重点 |
| alarm | IM 倒计时 / 提醒 | 置顶、无边框 |
| notifier | 右下角横幅提醒 | 无边框、置顶、不抢焦点（`focusable:false`）、不进任务栏、从屏幕边缘滑入 |
| notice | 消息对话框 | 无边框、不抢焦点、不进任务栏、预创建后隐藏 |
| toolTip | 托盘悬浮提示 | `showInactive` 显示不激活、`pop-up-menu` 级置顶、每秒检查鼠标是否移开 |
| screenshots、screenshotsOverlay | 截图工具 | 每块屏幕一个透明无边框全屏窗口，`screen-saver` 级置顶，在所有桌面与全屏应用上可见，启动时预热 |
| image、video、web | 图片预览、视频播放、通用网页 | 常规窗口；视频窗口关闭后台节流 |
| ai、setting、update、archGuide | AI 助手、设置、更新、架构引导 | 常规窗口或小弹窗 |

## 能力对照

| 需要的能力 | Tauri 2 的实现 | 备注 |
| --- | --- | --- |
| 多窗口、每个窗口独立页面 | `WebviewWindowBuilder`，每个窗口加载自己的路由 | 窗口间通信走 Rust 事件，不再经主进程转发 |
| 无边框、圆角、透明 | `decorations(false)`、`transparent(true)` | Windows 上页面背景也要设为透明 |
| 置顶 | `always_on_top(true)` | 普通置顶足够横幅与倒计时使用 |
| 浮在全屏应用之上（截图） | Windows：置顶 + 全屏尺寸即可；macOS：通过 objc2 把 NSWindow 层级设到 screen-saver | Tauri 的 `visible_on_all_workspaces` 负责跨桌面 |
| 显示时不抢焦点（横幅、提示） | `focused(false)` 显示；Windows 再加 `WS_EX_NOACTIVATE`，macOS 用非激活 NSPanel | macOS 这一项最好做原型验证 |
| 不进任务栏 | `skip_taskbar(true)` | |
| 鼠标穿透 | `set_ignore_cursor_events(true)` | 官方未用到，横幅半透明区域可用 |
| 贴屏幕边缘定位、滑入动画 | `primary_monitor()` / `available_monitors()` 取工作区，Rust 设位置；动画在页面内做 | 要按 DPI 换算坐标 |
| 托盘、悬浮提示、闪烁 | 托盘插件；提示窗用托盘的鼠标进出事件代替每秒轮询 | |
| 任务栏闪烁提醒（倒计时到期） | `request_user_attention` | |
| 预热窗口 | 启动时创建隐藏窗口，用时 `show()` | 同官方做法 |

## Windows 端注意事项

- **内存**：每个窗口都是一个 WebView2 控制器。所有窗口共用同一个 WebView2 环境（同一个用户数据目录），可以共享浏览器进程与 GPU 进程，单个新窗口的增量远小于 Electron 一个 BrowserWindow。横幅、提示这类小窗口建议常驻一个、复用内容，不要每条消息新建一个。
- **焦点限制**：Windows 不允许后台程序随意抢前台。横幅只"显示不激活"，需要用户注意时用任务栏闪烁，不要强行 `SetForegroundWindow`。
- **多屏与 DPI**：截图遮罩要为每块屏幕各建一个窗口，并按各屏缩放比例换算坐标，否则 125%、150% 缩放的副屏会错位。
- **透明窗口**：WebView2 透明需要同时设置窗口透明和 WebView 默认背景透明；部分远程桌面与老显卡环境下透明可能失效，需要降级为不透明样式。
- **系统通知 vs 自绘横幅**：简单消息提醒可以直接用 Windows Toast（系统通知中心可回看）；需要倒计时、按钮、自定义样式的保留自绘横幅。

## 建议原型验证的三项

1. macOS 非激活面板：横幅出现时不打断用户正在输入的 IM 输入框。
2. 截图遮罩：双屏、不同缩放比例、全屏应用之上都能正确覆盖。
3. 横幅常驻复用：连续 20 条消息提醒时的内存与 CPU，对比官方客户端。
