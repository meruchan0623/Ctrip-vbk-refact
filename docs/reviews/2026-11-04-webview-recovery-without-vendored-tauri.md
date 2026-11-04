# WebView 恢复：不引入 vendored Tauri 后的裁剪

状态：代码已按上游 `tauri 2.12.5` 公开 API 编译通过；原生 macOS / Windows 崩溃路径未做实机验收。

## 背景

`final-audit` 快照的 `webview_recovery.rs` 依赖本地改过的 `tauri`（`vbk/vendor/tauri-2.12.5`，`[patch.crates-io]`）。该分支给每次 WebView 创建分配独立资源表，并提供 `Webview::vbk_is_current_instance()` 与 `VBK_TERMINATION_HOOK_INSTANCE_SAFE`。本分支决定不带入该 fork，也不固定 `=2.12.5`。

## 保留

- 恢复监督器本身：每个 WebView 的崩溃预算（5 分钟内 3 次，指数退避）、`recovery://` 状态事件、手动重试命令、`ready()` 之前的待处理标记。
- macOS：改用上游 `Builder::on_web_content_process_terminate`。
- Windows：`ProcessFailed` 订阅仍由宿主经 `with_webview` 安装；事件处理器捕获自己的 incarnation，旧实例的迟到事件解析到后继实例时 incarnation 不符而被丢弃，这一条在不依赖 fork 的情况下仍成立。
- 实例身份记录：宿主在 `on_webview_ready` 时往该 WebView 的资源表放一个 `Registration`，所有"是不是同一次创建"的判断都比较它的 incarnation。

## 裁剪（做不到，不假装安全）

1. **macOS 终止回调不能证明来自哪一次创建。** 上游钩子按可复用的标签解析 WebView。标签被销毁后重建、而旧实例的终止通知迟到时，回调会落在后继实例上。公开 API 无法区分。现在的 `is_current_instance` 只证明"该标签现在仍有 WebView"。
   后果：极少数时序下会对一个健康的后继页面多触发一次恢复（重载）。受崩溃预算约束，3 次后进入手动状态，不会无限循环；恢复不重试任何业务写操作。
2. **删除编译期围栏** `VBK_TERMINATION_HOOK_INSTANCE_SAFE`（该常量只存在于 fork）。
3. **未带入** fork 里的文档回复关联（IPC 回复 token）与 Channel 数据有界化。`docs/reviews/2026-11-03-document-*` 两份文档描述的是这部分设计，在本分支不成立，仅作历史记录。
4. **跨平台**：Linux/BSD 仍不支持（与之前一致）。

## 如需恢复强保证

需要上游提供按创建实例派发的终止回调（或在回调里携带原生 WebView 指针），再把 `is_current_instance` 换成指针/资源表同一性比较。回归点：`webview_recovery` 的单元测试（预算、监听状态机、就绪竞态）不依赖该 API，应继续通过。
