# 会话删除的账号级失效通知

基线：`7b7cbb6`，仅在 `%TEMP%\vbk-windows-20261031\r7-conversation-invalidation-7b7cbb6` 独立源码快照修改。没有修改主工作树或共享暂存区，没有原生UI、真实网络、客户数据或消息发送。

## 缺口与最小修复

真实 adapter session 的同代次全量列表从 `[A,B]` 变成 `[A]` 时，display payload 带 `removed_gids=[B]`。Rust display cache 会移除 B，但旧 `adapter_push_display` 的 `DisplayDelta::Conversations` 分支只撤销套餐绑定、发 changed 行并同步未读；主界面只收到 A 的 upsert，普通同 owner 的账号通知不会重新加载，因而仍显示 B。独立评审的原反例是实际 TypeScript 入口加源码核对的宿主接缝，不是执行 Tauri 分发器。

增加 `im://conversations-invalidated`，Rust 与 TypeScript 常量分别位于 `events.rs`、`ipc/src/commands.ts`。宿主只有在 display cache 的 removed 非空时才向 main 定向发出完整 `AccountContextDto`，不携带待删 gid。账号来自已验证调用 webview 的 `bound_caller`，不是页面声称的任意账号。

主界面实际监听进入 `receiveConversationInvalidation`：先检查非空账号/环境字符串、非负安全整数代次，再以 `stillActive` 比较完整 account/environment/session generation。仅当前 scope 调用已有 `loadForActiveAccount` 重读当前缓存；后台账号、旧代次与畸形事件忽略。切换到后台账号时既有加载入口仍负责列表。

没有新增直接删 gid 的操作，因此延迟的失效通知只会读取最新列表，不会把旧删除重放到新的会话上；在途旧加载继续使用已提交的 ticket/journal 防护。本补丁不修改 load、render、已读或发送逻辑。选中会话在读回中不存在时，继续复用既有 activeGid 清理及精确附件 release；不自动打开替代会话、标已读或发送消息。

## 自动回归与限制

`conversation-invalidation.test.ts` 执行真实 page session 产生 full/removed payload，交给内存 cache/emission 接缝夹具，再执行从 main 提取的真实监听、handler、load、upsert 和附件 release 函数。**夹具没有执行 Rust/Tauri emitter**；它证明 UI 消费链与真实 adapter payload 的行为，不能代替宿主发射点的编译/独立审查。已有 `display.rs::full_snapshot_removes_missing_and_increment_reports_changes` 覆盖 Rust cache 的删除 delta，新增 emitter 接线仍需整体宿主门禁。

日志均在 `%TEMP%\vbk-windows-20261031`：

- `r7-conversation-invalidation-before.log`：原代码3失败/1通过、exit1；真实 full 删除后 UI 多留 B，选中行/附件未释放，旧视图未被新缓存替换。
- `r7-conversation-invalidation-after.log`：`node --test ui/apps/main/conversation-invalidation.test.ts`，4/4、exit0。覆盖 full 删除、空列表、当前选中移除释放附件、IPC命令白名单、后台/环境/旧代次/坏payload、晚事件与被取代的旧读回。
- `r7-conversation-invalidation-fault.log`：临时源文件移除 `stillActive` 调用门禁，后台/旧scope测试真红、exit1；生产源文件未被故障覆盖。
- `r7-conversation-invalidation-all-ui.log`：`npm test`，650/650、exit0，无skip/todo。
- `r7-conversation-invalidation-typecheck.log`：`npm run typecheck`，exit0。

此处未运行 cargo（当时目标由数据模块占用），不声称宿主已编译或 native 事件链已实机验收。也不将列表数字差额据此全部判为删除缺口。
