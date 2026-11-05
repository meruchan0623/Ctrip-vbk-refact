# 08 更新、偏好与诊断

2026-10-30。本项目自有能力，保留。

- 客户端更新：签名校验的更新包与更新策略，本项目受控发布源；下载、校验、重启/退出时安装。
- 偏好：设置窗口 6 个分区，依次为快捷回复（`quick_replies`，账号业务，走网页接口并回读）、通用（`general`，含界面缩放）、通知与提醒（`notify`，含强提醒开关/阈值/声音）、快捷键（`keys`）、商家助手（`assistant`）、关于（`about`，版本与更新、IM 连接与代理、数据目录、诊断包导出）。网页已有的其他个人业务设置（个人资料、上班时间、自动答复、自动翻译）仍走网页接口，不与本地偏好混用。设计见[快捷回复分组管理决定](../decisions/2026-11-05-quick-reply-manage.md)。
- 本地诊断包：脱敏日志与环境信息，默认不含聊天正文与凭据；云端崩溃/埋点上报须确认接收端授权后再开启。

2026-10-30 落盘、2026-11-05 重构：设置窗口 `vbk/ui/apps/setting` 为单页长滚动，左侧导航分“账号业务”（快捷回复）与“桌面偏好”（其余 5 个分区）。偏好中只存储不生效的项已删除：`general.start_hidden`、`general.spell_check`、`display.gpu`，以及整个 storage、privacy 分区（含埋点/崩溃上传只读行）；旧 `prefs.json` 中的这些键读取时被忽略，下次保存时消失。当前没有任何埋点或崩溃上传，设置里也不提供对应开关。深链旧分区名归一化：`display`→`general`，`network`/`storage`/`privacy`→`about`。客户端更新、诊断包、崩溃观察的实现状态以 `PROGRESS.md` 为准；`update` 窗口只有最小 capability。

详细设计沿用[归档正文](../archive/desktop-baseline/dev/08-update-telemetry.md)。
