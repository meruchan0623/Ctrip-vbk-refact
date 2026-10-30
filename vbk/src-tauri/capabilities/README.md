# 窗口权限（capability）

每类本地窗口一个文件；只授予该窗口用到的单个命令（`allow-<command>`），不给整组插件或父窗口宽泛权限（总纲 §5）。远程网页（官方登录页、订单“IM 联系”标签、订单详情页）不出现在任何 capability 里：它们没有 IPC 权限，运行在账号隔离的 WebView2 Profile 中。

| 文件 | 窗口 | 范围 |
| --- | --- | --- |
| `main.json` | `main` | 账号、IM 事实推送与快照、订单 URL 校验、偏好快照、提醒设置命令 |
| `popups.json` | `alarm` | 仅 `notify_snapshot / open_conversation / hide_round / hide_all / snooze` + 偏好快照 |
| `setting.json` | `setting` | 偏好快照、提醒设置命令、账号快照 |
| `update.json` | `update` | 仅偏好快照（更新状态命令在 REL 任务接入时另加，不继承业务权限） |
| `login.json` | `login` | 账号快照、开始/取消登录 |

2026-10-30 起：各文件由 `views.rs` 中的角色命令表生成，三处必须一致（`ui/apps/_shared/contract-consistency.test.ts` 检查）。新增 `adapter.json`：只授予官方 HTTPS 来源上、标签为 `acct-*` 的账号网页 WebView 五条 `adapter_*` 窄命令和事件监听；宿主再按 WebView 标签核对账号与代次，不信任页面自报身份。官方登录页（`login-remote-*`）仍无任何权限。

2026-10-31：`tauri.conf.json` 的 `freezePrototype` 改为 false。它会作用于所有 WebView，包括官方登录页和账号 IM 页；冻结 `Object.prototype` 后官方页面脚本启动即抛 “Attempted to assign to readonly property”，导致登录按钮、协议勾选和二维码全部失效。本地窗口仍靠严格 CSP、无远程内容和按窗口命令白名单约束。
