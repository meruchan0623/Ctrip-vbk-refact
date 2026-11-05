# 性能与资源占用改进计划（2026-11-05）

起因：macOS 上主窗口不在前台时，后台仍有数个“旅游商家IM Web Content”进程，其中两个各占 300 多 MB。

本文记录调查结论、2026-11-05 已落盘的改动和后续待办。结论来自静态读码和一次 `ps` 采样，**没有做 profiling**；“确认”指代码路径已读通，“怀疑”指影响大小取决于运行时数据。已落盘的改动只有单测，**未做实机内存对比，不算验收**。

## 1. 现状

### 1.1 常驻的 WebView

1 个账号登录、主窗口隐藏到托盘时，以下 WebView 全部存活，隐藏不销毁：

| label | 内容 | 创建时机 | 说明 |
|---|---|---|---|
| `acct-<profile>` | 携程官方 IM 页 + 注入适配器 | 每个在线账号一个 | 消息收发通道，不能关；`profiles.rs` 对它关闭了后台节流 |
| `main` | 本地界面 | 启动 | 关闭即隐藏；还负责播放提示音 |
| `alarm`、`notice` | 本地强提醒页、新消息卡片 | 启动预建 | 隐藏常驻 |
| `webview-N` | 内置网页标签（官方页面） | 用过“网页高级操作”等入口后 | main 的子 WebView，隐藏时只 `hide()` |

没有“网页不生效”之类的开关：官方页常驻后台是设计常态。

### 1.2 实测基线

2026-11-05，macOS，应用运行约 1 小时，`ps` 的 RSS：WebContent 进程 153MB / 29MB / 6MB / 6MB，宿主 45MB。`ps` 无法把进程对应到 label。用户报告的 300MB+ 出现在更长的运行时间之后。

测量方法：

```bash
ps -axo pid,rss,etime,command | grep -E "vbk-host|WebKit.WebContent"
```

RSS 与活动监视器的“内存”列（含压缩内存）口径不同，对比时固定用一种。

## 2. 已落盘（2026-11-05）

| 改动 | 位置 | 适用平台 |
|---|---|---|
| main 消息缓存上限：当前会话 + 最近 12 个；隐藏超过 5 分钟只留当前会话。有本地未落定消息（`message_id` 为空或结果 unknown）或在途分页的会话不淘汰 | `ui/apps/main/message-cache.ts`、`main.ts` | 全部 |
| 适配器已读状态元数据上限：64 个会话、每会话 2000 行，按最近展示淘汰 | `ui/packages/web-adapter/src/read-status.ts` | 全部 |
| 内置网页标签回收：单账号 4 个、总计 8 个，超出时关闭最久未显示的隐藏标签；台上的标签不回收 | `src-tauri/src/browser_tabs.rs` | 全部 |
| `net://clock` 两个监听合并，信任级别不变时不更新状态（原先每秒一次） | `ui/apps/main/main.ts` | 全部 |
| 页面隐藏时跳过深链接 2 秒轮询与 500ms 时钟/横幅定时器，恢复可见时补跑 | `ui/apps/main/main.ts`、`ui/apps/setting/main.ts` | 取决于 `visibilityState`，见 5.3 |
| notice 窗 200ms 定时器只在有卡片时运行 | `ui/apps/notice/main.ts` | 全部 |
| TSim 浏览器会话：LevelDB 目录指纹未变时复用上次读取结果，最长 60 秒；原先每 4 秒及每次请求前全量读取 | `src-tauri/src/assistant/browser_storage.rs` | 全部，Windows 收益更大 |
| TSim 资料加载失败指数退避（4 秒起，上限 5 分钟） | `src-tauri/src/assistant/service.rs` | 全部 |
| 浏览器授权桥线程改为阻塞监听，过期清理改为每次尝试一个定时线程；原先首次使用后永久每 100ms 唤醒 | `src-tauri/src/browser_bridge.rs` | 全部 |
| “跟随系统勿扰”关闭时不读 `Assertions.json` | `src-tauri/src/attention.rs` | 仅 macOS |

行为变化需知会测试：

- 切换超过 13 个会话后，再回到早先的会话会重新读取首页，之前翻出的历史页需重新加载。
- 同一账号打开第 5 个网页标签时，最久未显示的那个会被自动关闭。

### 2.1 读码后决定不动的适配器集合

原计划修剪五个集合，读调用点后只动了 `read-status.ts`，其余四个保留：

- `rpc.ts` 的 `state.sends`：发送幂等备忘，注释写明只有证实的提交前失败才能释放。删除会让同一 `localId` 的重试变成重发，违反不变量 2。
- `stores.ts` 的 `ConversationStore`：`#orderScopes` 的 revision 参与助手上下文签名，删除后 gid 重现会从 1 重新计数。
- `session.ts` 的 `previewVersions`、`incomingVersions`：用于判定在途操作是否过期，删除等于把版本清零。
- `sdkGlue.ts` 的 `partnerJids`：每项只是两个短字符串，删除后发送路径要多一次查询。

这四个都按“见过的会话数”增长，单项很小。若实测证明它们是内存主因，需要单独设计（例如随会话结束事件清理），不能简单加 LRU。

## 3. 待办

### P0

1. **高频同步命令占主线程**（确认）。`adapter_push_fact`、`adapter_push_display`、`adapter_reply`（`src-tauri/src/adapter.rs`）、`im_draft_save`（`features/draft.rs`）、`prefs_set`（`prefs.rs`）都是同步命令，在主线程上反序列化、抢 `Cores` 锁；`im_draft_save` 还整份读写 state.json 并 fsync。改成 async 命令或把磁盘 IO 放进 `spawn_blocking`；持锁期间不写 warn 日志（warn 会 `sync_data`）。验收：输入和滚动时主线程无长任务。
2. **事实逐条 IPC、同一变更发两遍事件**（确认）。适配器每个事实一次 `invoke`（`bridge.ts`），全量快照 N 行就是 N 次；宿主在事实应用后和展示增量到达时各发一次 `emit_conversations`，消息逐条发 `IM_MESSAGE_NEW`。改为批量提交、事件去重合并。涉及适配器协议，需同步 `adapterProtocol.ts` 并评估 `CONTRACT_VERSION`。
3. **等待轮次持久化记录从不删除**（确认）。`core-store/src/queue.rs` 只 `put` 不 `delete`，`ReminderStateRepo::remove` 无调用方；已结束的轮次在下次登录被恢复为 `restored`。这既让 state.json 只增不减，也是“已结束轮次复活”的正确性问题。修复时补 `tests/scenarios` 反例。

### P1

4. **邀请成员对话框整表渲染**（确认，严重程度取决于组织规模）。目录上限 10,000，对话框打开期间每次非滚动渲染都重新排序和重建全表（`main.ts`、`peripheralPanel.ts`）。改用 `Intl.Collator`、缓存过滤结果、列表虚拟化或截断。
5. **套餐卡片每条新消息重建 Shadow DOM**（确认）。缓存键包含整个消息数组（`main.ts`、`companion-card.ts`）。键收窄到订单号和 ICCID 列表，样式改用 `adoptedStyleSheets`。
6. **非滚动帧重建整个界面外壳**（确认）。每次按键都重建标题栏、导航、状态栏等并整树 morph。给 `part()` 加依赖缓存，或让输入框非受控。
7. **`pump_rounds` 每个事实克隆全部轮次**（确认，`state.rs`）。改为有 `RoundEvent` 时才快照。
8. **FileStore 无缓存**（确认）。`get` 每次全量读盘解析，outbound journal 每阶段整文件重写。加内存缓存或改追加写。`compensation_watermark` 在持 `Cores` 锁时读盘，违反该文件自己的约定。
9. **引用解析与增量合并**（确认）。每条可见行做 O(n) 引用查找且在缓存命中判断之前；翻译回填、已读状态、本地发送产出的数组让下一条实时消息退化成全量合并（`viewmodel.ts`）。

### P2（需实机验收或故障注入后再定）

10. **隐藏官方页的调度**。`BackgroundThrottlingPolicy::Disabled`、`conversationHiddenIntervalMultiplier: 1`、`normalLoopStopAfterMs: null` 都是有意决定（15 秒状态租约、I-06）。可评估：socket 已连接后让补偿循环自动停止、页面不可见时把 1Hz SDK 探测降频。必须先做故障注入。
11. **空闲重载官方页**。`acct-*` 内存超阈值且空闲时由宿主重载并重新握手补偿，用来压住官方页自身的泄漏。重载期间的消息靠补偿追回（不变量 5）。
12. **托盘时销毁 main**。隐藏若干分钟后销毁、显示时重建。前提是把提示音从 main 迁到宿主或 alarm 窗。
13. **1Hz 调度器空闲降频**。无账号、告警窗未显示、未闪烁时降到 5–10 秒；`net://clock` 只在 main 可见时发。
14. **媒体外发**。整文件常驻内存并以 base64 分块推给页面；附件表过期清理是惰性的。改流式并主动过期。
15. 其他：图片下载每次新建 reqwest client 且未走 `net_policy`；首屏 JS 约 752KB 无延迟加载；日志每行一次 `write`、warn 每行一次 `sync_data`；通知中心列表无上限；失效头像 URL 反复请求（怀疑）。

## 4. 现有 clippy 报错

本机 clippy 1.95 对 `src-tauri` 报 5 处与本次改动无关的错误：`display.rs:946`（collapsible match）、`message_actions.rs:114`（`sort_by_key`）、`message_actions.rs:390`（`slice::from_ref`）、`webview_recovery.rs:329`/`:342`（needless borrow）。CI 的 clippy 版本若相同会失败，需单独修。

## 5. Windows 专项

打 Windows 包之前要处理，按风险排序：

1. **后台节流不受控**（怀疑，潜在正确性问题）。Tauri 的 `background_throttling` 只在 macOS 14+/iOS 17+ 生效。隐藏的 `acct-*` 在 WebView2 里按 Chromium 规则节流定时器，适配器的 5 秒循环和 15 秒状态租约可能被拉长。需实机验证：窗口隐藏 10 分钟以上，入站消息、状态租约、强提醒是否正常。启动参数受 `tools/gates/` 约束，对策要先过门禁评审。
2. **每账号一组 WebView2 进程**（确认机制，未实测数值）。Windows 用 `data_directory` 隔离 profile，每个账号是独立的浏览器进程组（浏览器、GPU、网络、渲染），固定开销高于 macOS 的单个内容进程。需实测 1、2、4 个账号时的内存基线，在任务管理器里按进程组记录。
3. **`visibilityState` 实测**。本次“隐藏时暂停轮询”和“隐藏 5 分钟收缩缓存”依赖 `document.visibilityState`；`hide()` 在 WebView2 上是否置为 hidden 未验证。不生效时只是不省，不会回归。main 里判断集中在 `pageHidden()`，需要时可换成宿主推送的窗口可见状态。
4. **Windows 专属减负手段**。对隐藏的 main/alarm/notice 设 `MemoryUsageTargetLevel::Low`，显示时恢复；评估对隐藏的 alarm/notice 用 `TrySuspend`。
5. **LevelDB 指纹**。指纹用已打开句柄的信息（`GetFileInformationByHandle`），不用目录枚举结果。需在 Chrome 运行、Defender 开启的机器上确认：Chrome 持有文件时句柄能打开；登录/退出 TSim 后 60 秒内会话状态跟上。

## 6. 验收

- 实机内存对比：同一账号、同样的使用方式，修复前后各运行 4 小时以上，按 1.2 的方法每小时记录一次各进程 RSS，结果补进本文。
- 涉及真实账号的验证遵守 `PROGRESS.md` / `BLOCKED.md` 的授权边界；忙账号不做任何出站操作。
