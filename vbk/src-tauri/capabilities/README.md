# 窗口权限（capability）

每类本地窗口一个文件；只授予该窗口用到的单个命令（`allow-<command>`），不给整组插件或父窗口宽泛权限（总纲 §5）。远程网页（官方登录页、订单“IM 联系”标签、订单详情页）不出现在任何 capability 里：它们没有 IPC 权限，运行在账号隔离的 WebView2 Profile 中。

| 文件 | 窗口 | 范围 |
| --- | --- | --- |
| `main.json` | `main` | 账号、IM 事实推送与快照、订单 URL 校验、偏好快照、提醒设置命令 |
| `popups.json` | `alarm` | 仅 `notify_snapshot / open_conversation / hide_round / hide_all / snooze` + 偏好快照 |
| `setting.json` | `setting` | 偏好快照、提醒设置命令、账号快照 |
| `update.json` | `update` | 仅偏好快照（更新状态命令在 REL 任务接入时另加，不继承业务权限） |
| `login.json` | `login` | 账号快照、开始/取消登录 |
