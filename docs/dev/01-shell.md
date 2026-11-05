# 01 宿主与窗口

2026-10-30。范围见[范围决定](../decisions/2026-10-30-web-only-scope.md)：只删除携程业务模块，本项目宿主能力保留。

- `main`：左侧栏只有消息、通知、订单联系，底部设置；多账号标签在标题栏，退出入口在账号标签的关闭按钮，工作状态在会话列表顶部。
- `alarm`：独立回复超时强提醒，单例复用、置顶不抢焦点，详见[强提醒](03-strong-alert.md)。
- 托盘：图标、左键显示主窗口、右键菜单（显示主窗口、设置、勿扰、退出）、悬停未读预览；任务栏未读数字与新消息闪烁。
- 单实例、关闭到托盘、开机自启、全局快捷键（显示/隐藏主窗口）、深链唤起保留。
- 订单联系打开的网页会话标签按模块设计创建；图片/视频/文档查看器是独立系统窗口 `media-viewer`，见[媒体工具](07-media.md)。
- 不再承载首页、工作台、事件、公告、商服、产品、数据、点评等业务页，也没有业务菜单墙与通用业务窗口池。

Tauri/WebView2 的置顶、不激活显示、托盘、焦点与 DPI 需先做原型。详细设计沿用[归档正文](../archive/desktop-baseline/dev/01-shell.md)，去掉其中业务页部分。

2026-10-30 落盘：`vbk/src-tauri/src/{windows,tray,views}.rs` 与 `capabilities/*.json` 已写出 main（关闭即隐藏）、alarm（单例、`always_on_top`、`focused(false)`、关闭即隐藏、工作区右下定位并夹到可见范围，纯函数 `place_alarm` 有测试）、setting/update 单例、托盘菜单（显示主窗口/设置/勿扰 1 小时/直到明天/退出）、未读提示与 500 ms 闪烁相位、单实例插件。界面在 `vbk/ui/apps/main`（标题栏账号标签，左侧栏只有消息/通知/订单联系）。全局快捷键、开机自启、深链、任务栏数字（`set_badge_count`）仅留接口或占位；以上均未在 Windows 目标机构建与验证。macOS 兼容（同日补）：菜单栏图标不做隐/显闪烁，改为 Dock 弹跳；Dock 角标；alarm 在所有桌面空间可见；点击 Dock 图标找回隐藏的主窗口；`tauri.macos.conf.json` 打 `.app`/`.dmg`；构建步骤与差异表见 `vbk/README.md`。同时修正两处跨平台问题：配置与代码重复创建托盘图标、`frontendDist` 指向只含 JS 的目录（改为 `ui/tools/bundle.mjs` 组装的 `ui/bundle`）。macOS 下 alarm 不夺焦点仍待实机验证。

## Windows 窗口要素

2026-11-05 落盘，未经 Windows 实机验收。Windows 窗口无原生标题栏（`decorations: false`），以下要素由 `ui/apps/_shared/window-controls.ts` 与 `src-tauri/src/win_chrome.rs` 补齐；macOS 仍用红绿灯，不渲染这些控件。

| 窗口 | 标题栏按钮 | 说明 |
| --- | --- | --- |
| `main`、`setting`、`media-viewer`、`package-detail`、`login` | 最小化、最大化/还原、关闭 | 可调整大小 |
| `update` | 最小化、关闭 | Windows 上固定尺寸 |
| `alarm`、`notice` | 无 | 无标题栏；`alarm` 在 Windows 上关闭 DWM 阴影，保持直角红框 |

- 按钮宽 46px，紧贴右上角；最大化后图标与文案切换为还原，状态由 `shell_window` 的 `state` 动作返回。
- 窗口失去激活时按钮变淡；右键标题栏空白处弹出系统菜单，其中的“关闭”与按钮走同一关闭策略。
- 高对比度模式（`forced-colors`）下，选中态用系统色描边，不依赖背景色。
- 账号标签超出宽度时可横向滚动，“+”常驻可见；`.tb-drag` 始终保留 46px 拖动区。
- 宿主把窗口顶部约 4px 留作调整大小的边缘，标题栏的点击目标不能依赖这一条。

**暂未实现 Snap Layouts**：悬停最大化按钮弹出的布局面板要求原生标题栏对 `WM_NCHITTEST` 返回 `HTMAXBUTTON`，而按钮在 WebView2 内部。常见替代做法是模拟 Win+Z，需要实机验证后再决定。Win+Z 与拖到屏幕边缘的系统贴靠不受影响。

### 实机验收清单

macOS 上只能做到 Chromium 排布审计与 MinGW 目标类型检查，以下项需在 Windows 10、11 上确认：

1. 100%、125%、150% 缩放及跨不同 DPI 显示器时，强提醒与通知卡片的尺寸和位置正确。
2. 最大化不遮挡任务栏（含自动隐藏），按钮图标随 Win+方向键、双击标题栏同步。
3. 右键标题栏的系统菜单：项目置灰正确，点击外部可关闭，“关闭”遵守 `close_action`。
4. Windows 10 无边框窗口的 1px 浅色边，在主窗深色标题栏上是否可接受。
5. Segoe UI 与微软雅黑混排时，固定高度控件（标签、徽标、状态栏）无裁切。
6. 高对比度主题下选中态、开关可辨认；密码框无系统“显示密码”按钮。

