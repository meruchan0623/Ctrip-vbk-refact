# 不做截图与截图标注

2026-11-05，Asia/Singapore。状态：用户已明确决定。

- **决定**：删除截图采集、截图全局热键和截图标注编辑器，不再排期。
- **来源**：用户 2026-11-04“截图功能不做了”、2026-11-05“删掉截图功能”。标注编辑器只服务于截图，用户从未要求过。代码是被旧快照合并（`bf0ce12`、`aea2fbc`、`ed2601c` 等）误恢复回来的。
- **删除范围**：`media_screenshot`、`media_annotation_source`、`media_annotation_apply`、只服务标注的 `media_save_attachment` 及其权限；`keys.screenshot` 偏好与设置行；主窗截图按钮、附件条“标注”入口；`crates/core-media`、`media_annotation.rs`、`ui/apps/main/annotation-*`、`ipc/annotation.ts`、`ui-kit/annotation/`。
- **保留**：普通图片/文件发送、粘贴与拖拽、附件草稿持久化、`media-viewer` 及其 `media_save_image`、`attachment_leases`、`keys.toggle_main` 全局热键。老用户 `prefs.json` 里残留的 `keys.screenshot` 读取时忽略，下次保存时消失。
- **OCR**：代码里不存在，本决定不改变其排期；当前也不能算作已有能力。
- **旧文档**：`docs/plan/`、`docs/reverse/`、`docs/api/`、`docs/design/` 中未逐条改写的截图或 `core-media` 内容不再代表待办；`docs/research/`、`docs/archive/`、`docs/reviews/` 是历史，不改。
