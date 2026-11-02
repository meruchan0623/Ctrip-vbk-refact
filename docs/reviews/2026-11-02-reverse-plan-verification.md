# 改进开发计划的实物验证（2026-11-02）

对象：[基于 rea 逆向结论的改进开发计划](../plan/2026-11-02-reverse-driven-improvement-plan.md)。方法：用用户提供的两份官方客户端实物（`~/Downloads/旅游商家桌面版.app`、`~/Downloads/vbk-electron/`）与本仓库 `vbk/`，由 5 个并行只读子代理分别验证：官方渲染层、官方主进程与 IM SDK、原生层与签名、vbk 后端稳固性、vbk 前端质量。全程未执行目标包内任何脚本或二进制，未修改 `vbk/` 源码。asar 以只读脚本解包到会话临时目录，不入库。

## 0. 结论

| 问题 | 结论 |
| --- | --- |
| 两份实物是什么 | Mac 1.2.13.2712559，**仅 x86_64**，与 `/Applications` 同一构建（主程序、asar、Electron Framework 三者 SHA-256 一致）；全包无 arm64 切片，唯一含 arm64 的是依赖里预编译的 `fsevents.node`。用户所说「ARM64 版」不成立，Apple Silicon 上经 Rosetta 运行。Windows 1.2.12 x64，被第三方插件注入 |
| 逆向报告结论 | 01/02/03/05 四份报告的论断绝大多数成立；6 处需要修正数字或措辞（见 §1），其中 2 处会改变计划前提：**官方反自动化检测只埋点、不拦截发送**；**IPC sender 校验是 12/70 而非 3/70** |
| 计划可行性 | **有条件可行**。传输路线（隐藏 WebView 跑 Web SDK）成立的前提是定时器节流可控与同账号互踢可处理；签名、更新、体积预算可行但有前提；功能覆盖有 14 项漏列 |
| 前端是否足够好 | 安全面干净（文本节点渲染、CSP 严格、仅 1 处无注入面的 innerHTML），适配器降级设计到位；但**消息列表未虚拟化且整树重建**、阅读位置锚点纯像素补偿且状态只在 DOM、焦点与 i18n 不完整、唯一 DOM 级门禁 smoke 已坏 3 天 |
| 后端是否足够稳固 | 代次校验与凭据隔离审查无问题；但**官方页 WebView 零监督**、**每条入站事实在全局锁内且在主线程 fsync**（与官方 STA-04 同构）、无 logger、journal 无界、store 提交不校验 revision、三处原子写无 fsync |
| 门禁现状 | 计划 §1.1 写的「全绿」不成立：`cargo clippy -D warnings` 13 错、`cargo fmt --check` 有差异、Playwright smoke 失败、CI main 最近一次红；宿主测试离线不可构建 |

## 1. 逆向结论的修正

| 原结论 | 实物核对 | 影响 |
| --- | --- | --- |
| 70 个 IPC 处理器只有 3 个按 sender 拒绝 | `Rt()` 9 处 + `Ri()` 3 处 = **12/70**；preload 另有 6+2 通道黑名单与 `netFetch` 域名白名单；`executeDB` 有 SQL 关键字过滤但 `run` 仍可任意写 | C2 文案修正；门禁设计对照真实基线 |
| imWindow `dangerouslySetInnerHTML` 25 处 | Mac **30**、Win 29；无第三方净化库，几乎都先过自写转义 `tf()` 与 URL 白名单；3 处来源未回溯 | C3 文案修正 |
| 会话列表 5 秒**全量**轮询；坐席 3 秒轮询 | `getConversationList` 带 `startTime=lastUpdateTime`，是**增量**，首轮读本地 30 日缓存；每轮有返回再拉 `getRemarkList`+`getConversationInfoByGidList`；无 visibility 判断。「坐席 3 秒」实为排队消息 `NBZ11` 出现时才轮询 `checkManualAgentStatus` | C7、I-06 修正 |
| 反自动化检测会拦截发送（FE-29/F-11） | 评分规则存在（阈值 50，`isTrusted===false` +35 等），但发送点只 `devTraceLog("vbk_electron_rpa_content_blocked")` 后照常发送，提示文案无处展示。**只埋点不拦截**；且只覆盖 tiptap 编辑器事件，程序化 `setContent` 不计入 | C10、I-15 前提改写 |
| xmpp.js 重连固定 1 秒 | 被 SDK 覆盖：Node 5–10 秒随机、Web 20 秒×(0.8–1.2)、超 6 次 60 秒；无指数增长。另 imsdk.js 收到 DISCONNECTED 强制重连绕过延迟；渲染端还有第 4 条重连路径 | C7 文案修正 |
| 边写边译 3 秒防抖 | 防抖 **500 ms**；3 秒是「正在输入」节流 | I-15 参数 |
| 快捷回复、服务端搜索、通知中心「无字段证据」 | 渲染层 BaseController 共 173 个端点，三者字段完整可得（`16037/getCategories`、`16037/searchConversation`、`11679/getIQConversations|getIQMessages|putAdviceofreadIQMessage`） | I-23、I-26 排期理由失效 |
| 17 处 rpath 可抢占 | `otool -l` 只见 2 条 LC_RPATH，无法复现 | 保留为 rea 工具结论，不作为验收依据 |

其余核对一致：SUP-01（https→http、adm-zip 无校验）、PRI-01（electron-store 无 encryptionKey，`rememberPassword` 默认开）、STA-01（守护计数为局部变量）、SEC-06（环境判定读 unpacked JSON）、fuses 全默认、entitlements 四项套用全部 Helper、Windows 全无 Authenticode、插件改写 5 个 unpacked 文件、体积与更新链、上传限额（另补：单次 ≤ 10 文件、视频 ≤ 3 分钟、分片 5 MiB、直传 ≤ 30 MiB）、历史分页（`16037/getMessageList`，`pageSize:50`、`direction:"prev"`、游标 `rangeMessage.lastMessageTime`）、25 个页面、CSP 24 页通配。

## 2. 传输路线：有条件可行

官方桌面把 socket 放在不受渲染节流影响的 utilityProcess；桌面 SDK `@ctrip/s-node-imclient-core@1.0.24` 与网页 `nodesdk/1.0.70/imsdk.js` 是同一 SDK 的两种构建（补偿间隔、5 分钟自停、`notify_ack` 等逐句对应）。SDK 本身不监听 `visibilitychange`，不会主动因隐藏降频；但 ping（5 秒）、看门狗（3 次无应答或 60 秒未连接重建）、补偿循环全部依赖定时器。

成立条件：

1. **节流原型先行**：B1 前测隐藏 WebView 下 ping 周期漂移与误判率（WKWebView 离屏挂起、WebView2 intensive throttling）。
2. **互踢是终态**：SDK resource 为 `clientSource|pc-<appId>-<ver>_1.3.1`，隐藏页与用户自己开的网页 resource 相同，服务端 `Replaced by new connection` 会踢掉其一且 SDK 不再重连。监督器必须把 KICKED_OFFLINE、XMPP_AUTH_FAILED、CURRENT_TOKEN_UNAVAILABLE 当终态交账号状态机，不能当心跳超时去重连。
3. **健康信号可达**：SDK 实例挂在 `window.xmppClient`，`status==='online'` 可作一级信号，前提是适配器与页面同一 JS world（当前 `sdkGlue.ts` 已轮询重绑）。
4. **补偿自停**：HTTP 补偿连上 5 分钟后自停，之后只靠 socket；页内补偿需按官方口径自行调用 `getRecentMessages`（起点 now−2 分钟）并按 msgId 去重。

会话计数差异来源已定位：初始化 = 服务端全量 ∪ 本地 `conversationInfo`（不在服务端列表但 `lastUpdateTime` 30 天内的保留并置 `inGroup=0`），之后增量；主进程每日清理超过 `chatCacheDays`（默认 180）的会话。这就是官方桌面 11/24 与网页 11/9 的差异，X1 口径文档可据此写。

## 3. vbk 后端发现（按严重度）

| 级别 | 位置 | 问题 |
| --- | --- | --- |
| P0 | `src-tauri/src/adapter.rs` 全文、`profiles.rs:165-197`、`login.rs:494-544` | 官方页 WebView 零监督：无心跳、无最后事实时间阈值、无 reload/重建。内容进程被杀或 SDK 挂死后，`request()` 15/20 秒超时，事实停止流入，账号仍显示 online |
| P0 | `state.rs:285-343`（`pump_rounds→persist_rounds`）、`adapter.rs:1070`（同步命令） | 每条入站事实在持 `Mutex<Cores>` 期间对所有账号命名空间 load→写 tmp→`sync_all`→rename→`sync_directory`，且在 Tauri 主线程；双账号约每条消息 6 次 fsync 在 UI 线程 + 全局锁内。与官方 STA-04 同构 |
| P1 | `lib.rs`、`Cargo.toml` | 没有安装任何 logger，所有 `log::*` 为空操作；长稳与崩溃取证无本地证据 |
| P1 | `core-store/store.rs:133-144`、`file.rs:202-211` | `Txn.base_revision` 在 commit 时不校验；`FileStore` 无写锁。拆锁或 UI 直写草稿后会丢更新 |
| P1 | `outbound_journal.rs` | `outbound_attempts` 从不清理；每次发送整份读写 + fsync，随时间线性变慢 |
| P1 | `outbound_journal.rs:274-279` | commit 成功后 barrier 失败返回 Unknown，与「unknown 只来自真实发送」口径不符 |
| P1 | `scheduler.rs:135-141` | Windows 闪烁期间调度器实际约 0.5 Hz |
| P1 | `state.rs:466-476` | 「勿扰到明天」按 UTC 日界 + 8 h，北京时间 16:00 解除 |
| P2 | `adapter.rs:517-535,550-566` | 持锁时 `emit_to`，与文件头约定冲突 |
| P2 | `core-im/src/dedup.rs:242-248` | `MessageIndex`/`by_gid` 无上限 |
| P2 | `state.rs:36-45`、`core-net/clock.rs:118-150` | macOS 睡眠期间 `Instant` 不走，唤醒后最长 60 秒内等待时长低估 |
| P2 | `login.rs:196-204`、`prefs.rs:355-360`、`display.rs:1037-1048` | 三处 `write_atomic` 只 rename 不 fsync，断电可得 0 字节 `accounts.json` |

审查无问题：代次校验覆盖全部 `adapter_*` 命令与事件；凭据只在 keychain，store 有 `looks_secret_like` 守卫；`block_on` 仅在专用线程；无 std Mutex 跨 await。

## 4. vbk 前端发现（按严重度）

| 级别 | 位置 | 问题 |
| --- | --- | --- |
| P0 | `ui/tests/smoke/run.mjs:213,236-238` | 唯一 DOM 级门禁已坏：`84016ec` 取消启动自动打开会话，smoke 仍等 `.msg`；CI main 自 a34a007 起红。751 单测中只有 3 个文件触碰 DOM，`main.ts` 2454 行渲染逻辑零自动化覆盖 |
| P1 | `main.ts:1900-1912`、`ui-kit/h.ts:132` | 消息列表未虚拟化：a34a007 的视口渲染只覆盖会话列表；每条新消息触发 `mergeHistory` 全量重建 + 整树 `replaceChildren`；10k 行时 `captureMessageAnchor` 约 73 ms，单帧 > 200 ms |
| P1 | `main.ts:1548-1600`、`history-layout.ts` | 阅读位置锚点是纯像素补偿，状态只在 DOM dataset，依赖同步布局读写；切会话或重建即丢 |
| P1 | `web-adapter/src/conversationList.ts:134-172`、`compensation.ts:63` | 5000 ms poller + 5000 ms 补偿循环，无 `visibilitychange`；与官方页自身 `startLoopConvList` 对同一端点双倍请求 |
| P1 | `main.ts:1397,1811,2359`、`ui-kit/h.ts:132-160` | 焦点只对 `data-fid` 的 input/textarea 恢复，按钮与会话行每帧重建后焦点回 body；无 `aria-live` |
| P1 | `main.ts`（97 行中文字面量）、`companion-card.ts`、`viewmodel.ts` | i18n 绕过 `t()` |
| P2 | `companion-card.ts:70` | 唯一 `innerHTML`，插值全为数字，无注入面，但挡 lint 门禁 |
| P2 | `web-adapter/src/bridge.ts:82` | `#queue` 无上限 Promise 链 |
| P2 | `_shared/ipc.ts:14`、bundle | mock IPC（含假账号数据，53 KB）随发布包分发 |
| P2 | `main.ts:491-511` | `im_conversations` 失败时显示「暂无会话」，与真实失败不可区分 |
| P2 | `ui/tools/bundle.mjs` | 无 source map、无压缩；`style-src 'unsafe-inline'` 可能可去 |

正面结论：正文、昵称、订单字段全部文本节点渲染；`href` 仅两处且经 `safeMediaUrl`；适配器对官方页全局依赖集中且有存在性检查与降级；SDK 监听器异常被捕获不会抛到官方页；mock 覆盖 63/64 条 UI 命令。

## 5. 官方有、vbk 无、计划漏列的功能

FE-30 正在输入状态、FE-33 转发、FE-34 主动撤回与重新编辑、FE-45 邀请评价、FE-28 敏感信息拦截提示、FE-53 自定义表情（含 Excel 导入导出）、FE-56 推荐回复「助小游」（`35240/shoppingGuide` SSE）、FE-39 打码解码、FE-42 改群名/欢迎语/复制新建群、FE-76 自动答复、FE-60 浏览器网页登录授权确认、FE-12 语音消息播放、FE-44 排队状态展示、FE-40 多选/按部门邀请（部分）。

## 6. 原生层与发布

- Tauri 2 + WKWebView 的宿主 .app **不需要** `allow-jit`（JIT 在系统 WebContent XPC 进程）；可用空 entitlements。
- Windows 体积预算以 WebView2 Evergreen 为前提；离线/LTSC 场景 `offlineInstaller` 约 +130 MB，需单独包。
- `tauri-plugin-updater` 只验 minisign，不校验 Authenticode/codesign；「安装前校验平台签名」需自行实现。
- 官方只发 x86_64，用户群恰为 Intel 机；vbk 当前仅 arm64，Intel 包应提前。
- 官方用 `CFBundleURLTypes` 注册 `vbookingChat`，同名注册会劫持官方页「打开桌面端」跳转，「不抢占」必要。
- 截图需屏幕录制 TCC，macOS 15 起周期性重授权；Info.plist 文案与 `bundle.macOS` 未规划。
- 官方 per-machine 安装，vbk currentUser，共存与企业分发策略需写明。

## 7. 对计划的修订（已回写）

见计划文件顶部「2026-11-02 验证后修订」一节。要点：新增 I-00 门禁先绿；I-04 改为「持久化出锁出主线程」并提前；I-05 增加终态、阈值对齐与互踢用例；I-06 升级为 M；I-07 口径来源写明；I-08 改动位置与分层修正；I-15 前提改写；I-18/I-19 前提补充；I-22 日志部分提前到 B1；新增 I-28 消息列表虚拟化、I-29 焦点/i18n/错误态、I-30 漏列功能；C2/C3/C7/C10 文案修正；§1.1 基线改为实测值。

## 8. 未能验证

- 官方**网页版** bundle 不在材料内：网页版是否有反自动化检测、SDK 1.0.70 行为差异、服务端对同 resource 的踢人策略，均需实机。
- 隐藏 WebView 的实际节流与挂起行为、适配器能否稳定触达 `window.xmppClient`。
- 3 处 `__html` 来源回溯、`searchType` 枚举值。
- Windows 侧未在 Windows 上实跑（Authenticode 判定基于 PE Security Directory=0）。
- vbk 真实 FPS 与内存（复杂度结论来自源码与 Node 微基准）。
