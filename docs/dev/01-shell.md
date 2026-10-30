# 01 宿主与窗口

2026-10-30。范围见[范围决定](../decisions/2026-10-30-web-only-scope.md)：只删除携程业务模块，本项目宿主能力保留。

- `main`：左侧栏只有消息、通知、订单联系，底部设置与账号菜单；多账号标签在标题栏。
- `alarm`：独立回复超时强提醒，单例复用、置顶不抢焦点，详见[强提醒](03-strong-alert.md)。
- 托盘：图标、左键显示主窗口、右键菜单（显示主窗口、设置、勿扰、退出）、悬停未读预览；任务栏未读数字与新消息闪烁。
- 单实例、关闭到托盘、开机自启、全局快捷键（截图、显示/隐藏主窗口）、深链唤起保留。
- 截图遮罩、图片查看、订单联系打开的网页会话标签按各模块设计创建。
- 不再承载首页、工作台、事件、公告、商服、产品、数据、点评等业务页，也没有业务菜单墙与通用业务窗口池。

Tauri/WebView2 的置顶、不激活显示、托盘、焦点与 DPI 需先做原型。详细设计沿用[归档正文](../archive/desktop-baseline/dev/01-shell.md)，去掉其中业务页部分。

2026-10-30 落盘：`vbk/src-tauri/src/{windows,tray,views}.rs` 与 `capabilities/*.json` 已写出 main（关闭即隐藏）、alarm（单例、`always_on_top`、`focused(false)`、关闭即隐藏、工作区右下定位并夹到可见范围，纯函数 `place_alarm` 有测试）、setting/update 单例、托盘菜单（显示主窗口/设置/勿扰 1 小时/直到明天/退出）、未读提示与 500 ms 闪烁相位、单实例插件。界面在 `vbk/ui/apps/main`（标题栏账号标签，左侧栏只有消息/通知/订单联系）。全局快捷键、开机自启、深链、任务栏数字（`set_badge_count`）仅留接口或占位；以上均未在 Windows 目标机构建与验证。macOS 兼容（同日补）：菜单栏图标不做隐/显闪烁，改为 Dock 弹跳；Dock 角标；alarm 在所有桌面空间可见；点击 Dock 图标找回隐藏的主窗口；`tauri.macos.conf.json` 打 `.app`/`.dmg`；构建步骤与差异表见 `vbk/README.md`。同时修正两处跨平台问题：配置与代码重复创建托盘图标、`frontendDist` 指向只含 JS 的目录（改为 `ui/tools/bundle.mjs` 组装的 `ui/bundle`）。macOS 下 alarm 不夺焦点仍待实机验证。
