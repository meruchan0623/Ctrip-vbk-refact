# 旅游商家桌面版 1.2.13 逆向 · 与 Tauri 重构版差距报告

日期：2026-11-01
目标：`/Applications/旅游商家桌面版.app`（官方 Electron 客户端）
对照：`/Users/tashima_meru/Develop/Ctrip-vbk-refact`（Tauri 2 + Rust 重构，分支 `main`，HEAD `a34a007`）

---

## 0. 取证对象与证据位置

| 项 | 值 |
| --- | --- |
| Bundle ID | `com.ctrip.vbooking` |
| 版本 | `1.2.13`（CFBundleVersion `1.2.13.2712559`） |
| 包名（产物） | `vbk-electron` 1.2.13 |
| 主进程入口 | `dist-electron/main/index.js`（277 KB 打包，含 drizzle-orm） |
| asar | `Resources/app.asar` 364 MB，53,222 文件，integrity SHA256 `3a266a8a…5c2a1` |
| 解包产物 | `/tmp/vbk-re/app2`（asar 本体）、`/tmp/vbk-re/pretty/`（格式化后的 preload/imsdk） |
| 本地前端 | `Resources/app.asar.unpacked/dist` 19 MB（**不在 asar 内**，见 §1.6） |
| 架构/环境 | `arm64`、macOS 13.3 SDK、Electron（LSMinimumSystemVersion 10.15）、最低 10.15 |

解包方式：自写 `/tmp/vbk-re/extract.mjs`（asar 头 4×uint32 + pickle，数据区基址 `13941940`，含 `.unpacked` 回填）；格式化 `/tmp/vbk-re/pretty.mjs`。

---

## 1. 官方端架构还原

### 1.1 进程与窗口模型

```
Electron Main (dist-electron/main/index.js)
├── 各业务窗口（24 个本地页面，见 §1.6）
├── BrowserView 池：主窗口内嵌 web 业务页（At.webWindowList，按 buid 隔离）
├── utilityProcess：dist-electron/main/imsdk.js  ← 原生 IM SDK 独立进程
├── worker：ocr-worker.js（paddleocr/onnxruntime-web）、spell-check-worker.js
└── 5 个 preload 桥：index / main / im / web / screenshots
```

主进程单例（逆向后识别，共 22 个 `_instance` 类）：

| 类 | 职责 | 证据 |
| --- | --- | --- |
| `Oe` | 主窗口 + `mainChilrenList` BrowserView 栈 | `openMainWindow/removeMainViewList` |
| `At` | Web 窗口列表（按 `buid`）+ extraWin + 右键菜单 | `webWindowList/ onWebViewContext` |
| `st` | 账号管理器（`accountList/currentAccount`） | `initAccount/getCurrentAccount` |
| `tn` | IM 进程表（`imProcessMap`，每 buid 一个 utilityProcess） | `createIMProcess` |
| `en` | **Alarm Dialog**（回复超时强提醒窗口） | `updateAlarm` |
| `nt` | 通知弹窗池（`winCache/queue/activeList` + powerMonitor 挂起/恢复） | `active` 静态开关 |
| `$t` | 托盘（`tray/countMap/flickerTimer/tray_icon`） | `unreadMessageCount` |
| `Ne` | ScreenShotManagerV2（`captureService + overlayWindow`） | `openScreenShot/finishScreenShot` |
| `Bt` | OCR Manager（worker + pendingRequests） | `recognizeImage/Buffer/cancelRecognition` |
| `at` | SpellCheck Manager（worker） | `spellCheck` |
| `We` | 更新管理（electron-updater） | `check/download/installNewVersion` |
| `Ye` | 安装包下载/安装监听（`downloader/installWatchTimer`） | ArchGuide 链路 |
| `jt` | ArchGuide 外壳窗口（x64/arm64 迁移引导 + pkg 下载） | `getArchGuideDownloadUrl` |
| `ct` | 登录窗口 | `openLoginWindow/refreshLoginWindow` |
| `lt` | 启动闪屏（LaunchWindow） | `openLaunchWindow` |
| `nn` | AI 窗口（375×?，`src/pages/ai/index.html`） | `openAiWindow` |
| `St` | 媒体窗口（图片查看器 / 视频播放器） | `openImageWindow/openVideoWindow` |
| `Je` | 偏好设置（`preference` 默认 `mr` + 快捷键注册 + 会话代理） | `getUserPreferences` |
| `bt` | Shark i18n（`getLangDump/qconfig`，locale+lang） | `getSharkInfo` |
| `Dt` | DBManager（better-sqlite3 + drizzle 迁移 + 崩溃恢复） | `executeDB` |
| `Zt` | UBT 上报（`ares-agent` appId/appName/env） | `setEnv/setUser` |
| `Ft` | Message Dialog 窗口 | `title:"Message Dialog"` |

### 1.2 IPC 契约（`appBridge`，**93 个通道**）

所有 5 个 preload 共享同一份通道表（`getAppConfig … cancelRecognition`），暴露为：

```js
window.appBridge = { send, invoke, receive, dbQuery, netFetch,
                     openExtraWindow, downloadFile, setLocalVoice,
                     getLoginCookie, getAllLoginCookies, getCacheAccountList }
```

另有 `im.js` 额外暴露：`postImMessage / postMainMessage / setIMMessageHandler / reconnectImPort / getImPortStatus`；`main.js` 暴露 `setMainMessageHandler / postPortMessage`；`screenshots.js` 暴露 `window.screenshots.*`。

通道分 8 组：

| 组 | 通道（摘） |
| --- | --- |
| 账号/登录 | `add_account` `change_account` `logout` `login_success/failure` `begin_to_login` `get_account_list` `get_cache_account_list` `remove_cache_password` `sort_account_list` `get_current_user_info` `refresh_data` |
| 窗口/壳 | `open_window`(image/video) `close_window` `show_window` `window_loaded` `window_full_screen` `window_height_change` `flash_main_window` `force_focus` `open_extra_window` `close_extra_window` `open_ai_window` `open_finder_window` `close_finder_window` `find_in_page` `stop_find_in_page` `found_in_page` |
| 网络/数据 | `net_fetch` `execute_db` `get_current_messages` `set/get_cache_data` `get/clear_cache_url_list` |
| IM | `get_im_channel_port` `get_main_channel_port` `im_process_started` `send_broadcast_event` `send_main_channel_port` `unread_message_count` `new_message` `notify_info` `reply_timeout` `clear_message_by_user` `jump_to_conversation` |
| 媒体 | `open_screen_shot_panel` `paste_screen_shot` `screen_shot_ready` `image_option` `download_file` `set_local_voice` `video_player_log` `video_player_fallback` |
| 智能 | `recognize_image` `recognize_image_buffer` `cancel_recognition` `spell_check` |
| 更新/架构 | `check/download/install/update_new_version` `get_update_info` `get_cur_version_info` `update_status_change` `arch_*`（8 个） |
| 杂项 | `get_app_config` `change_env` `toggle_baolei` `get/change_user_preferences` `clear_user_store` `get_shark_info` `change_shark_locale` `pop_context_menu` `open_with_system_browser` `open_install_dir` `open_data_dir` `get_stay_duration` `get_launch_count` `common_web_option` |

**安全闸门**（preload 内实现，值得重构端照抄/加强）：

- `dbQuery(sql, params, mode)`：禁 `;`、禁注释、首关键字必须在 `select|insert|update|delete|replace|with|begin|commit|rollback|savepoint|release`；`get/all` 模式必须 `select|with` 且字面量外不得含写操作；**`run` 模式允许写入**（详见 §4.1）。
- `netFetch(url)`：限 `http(s)` 且 host 命中 30 个域名白名单。
- 通道级 `send` 黑名单 `{download_file, open_extra_window}`、`invoke` 黑名单 `{execute_db, set_local_voice, net_fetch, get_login_cookie, get_all_login_cookies, get_cache_account_list}`。
- `window.postMessage` 入站仅放行 `login/logout/changeLocale/closeWindow/closeExtraWindow/openUrl/openExtraUrl/openUrlByBrowser`，且校验 origin。

### 1.3 IM 传输层（最重要的架构差异）

官方：**原生 XMPP SDK 跑在独立 utilityProcess**，不是网页 WebSocket。

```js
// dist-electron/main/imsdk.js（格式化后）
require("@ctrip/s-node-imclient-core")
e.IMClient.init({ env: FAT?1:UAT?2:3,
                  conversationType: ConversationList, initPageSize: 0,
                  appId: "900004", withoutExtra: true,
                  network: EXTERNAL, token })

// 发送：先 socket，失败再 HTTP 兜底
let i = await P(n);        // IMClient.sendMessageInSocket
i.res || (i = await I(n)); // IMClient.sendMessage
// 结果：ResponseStatus.Ack == "success" 才算成功
// 已读回执：IMClient.putAdviceOfReadByMsgId({partnerJid, msgId, conversationType})
// 输入态：IMClient.sendInputState(n)
```

- 与渲染层的桥是 **MessagePort**（`get_im_channel_port` / `get_main_channel_port`），每个 buid 一对端口；`reconnectImPort` 有 10s 节流。
- 连接态机：`CONNECTED / CONNECTING / DISCONNECTED / KICKED_OFFLINE_BY_OTHER_CLIENT / DOMAIN_INCORRECT / CURRENT_TOKEN_UNAVAILABLE / NETWORK_UNAVAILABLE`；`DISCONNECTED` 时自动 `reconnect(true)`。
- 消息类型 **16 种**（`MessageFactory`）：Text / Image / Card / Video / Audio / File / Location / CustomContent / Emoticon / Template / At / System / Status / InputState / Normal。
- 事件：`newMessage` / `newNotice`（统一回传 `receiveTime: Date.now()`）。

### 1.4 本地数据层

- 引擎：`better-sqlite3@11.1.2` + `drizzle-orm@0.32`（同步 API，主进程内）。
- 迁移：`dist/drizzle/0000…0012` 共 **13 个迁移**，`meta` 目录齐全。
- 表（**10 张**）：

| 表 | 用途 |
| --- | --- |
| `conversationInfo` | 会话主表（buid/uid/gid/threadId/skillGroupCode/relationOrderId/vendor*/status/groupTitle/…） |
| `messageInfo` | 消息表 |
| `IQConversationInfo` | 会话分类桶（categoryId/categoryName/unreadCount/lastMsg/lastMsgTime/localNextTime） |
| `IQMessageContent` | 分类消息内容（msgId/messageBody/msgType/bizType/messageCode） |
| `groupMember` | 群成员 |
| `venAgentInfo` | 商家客服 |
| `customEmoji` | 自定义表情 |
| `workingSchedule` | 排班 |
| `sharkInfo` | i18n 文案缓存 |
| `userInfo` | 用户资料 |

- 迁移 0012 名为 `message_cite_msg_id` → 引用/撤回消息 ID 有独立列。
- DB 崩溃恢复：`DBManager.init()` 捕获异常走 `recovery`（`recovery failed` 日志）。

### 1.5 前端栈

- Vue 3 + Vite（`UNPACKED_DIST` 路径 + `loadFile`，dev 用 `VITE_DEV_SERVER_URL=http://127.0.0.1:7777/`）。
- UI 组件：antd（`antd-vendor` 1.11 MB）、`@ant-design/icons*`、`@ctrip/nfes-antd` 4.9.5、`@ctrip/xtaro*`（SDUI）、`@ctrip/design-tokens*`。
- 富文本编辑器：`@tiptap/*` 2.6.6 + `prosemirror-state`（IM 输入区）。
- 虚拟列表：`@tanstack/react-virtual`（注意：**React** 虚拟库出现在 Vue 栈中，说明历史混用）。
- 状态：`zustand` + `redux@4.0.4` 并存。
- 其他：`xlsx`、`qrcode`、`viewerjs`、`jimp`、`sharp`、`spark-md5`、`@dnd-kit/*`、`node-fetch`、`axios@0.28.1`。

关键页面产物：`imWindow-BaGPtUvK.js` **2.78 MB**（IM 业务主体）、`loginWindow` 186 KB、`imageWindow` 50 KB、`alarmWindow` 8.3 KB、`aiWindow` 8.8 KB、`BaseController` 229 KB。

### 1.6 前端不是随包发布，而是**运行时热更下载**

`dist` 不在 asar 内，而放在 `app.asar.unpacked/dist`（随包基线）+ `USER_DIST`（用户目录热更副本）：

```js
// 比较 packageVersion.json（用户目录 vs app.asar.unpacked/dist）
// 不一致 → downloadBundleZip() → process.env.UNPACKED_DIST = process.env.USER_DIST
// replaceNewVersion(): USER_DIST → ../dist.back 备份后替换
```

`app.asar.unpacked/dist/packageVersion.json`：

```json
{ "pkgVersion":"1.2.13", "aresVersion":"1.2.18", "aresGroup":"vacation",
  "aresName":"vbk-electron-v27", "minPkgVersion":"0.0.1",
  "feedUrl":"https://file.tripcdn.com/files/8/tour_vbkadminuser/vbk-electron-v27/1.2.13",
  "distUrl":"https://file.tripcdn.com/files/8/tour_vbkadminuser/vbk-electron-v27/1.2.13/dist/1.2.18/dist.zip" }
```

**24 个本地页面**（`dist/src/pages`）：
`ai alarm archGuide bi bulletin comment course event home imPlus image launch login main notice notifier order product screenshots screenshotsOverlay setting toolTip update video web`

### 1.7 后端/服务端契约

- 业务网关：`https://cbooking.trip.com/restapi/soa2`（+ `m.ctrip.com/restapi/soa2`；QA/UAT 走 `*.qa.nt.ctripcorp.com`、`*.tripqate.com`）。
- IM 网关：`https://imvendor.ctrip.com/main`（+ fat44/uat 镜像）。
- 配置：`https://vbooking.ctrip.com/ivbk/accountV2/shark/getLangDump`、`/qconfig/jsonp`。
- 静态：`https://static.tripcdn.com`、`https://file.tripcdn.com`（更新/热更包）。

---

## 2. 重构端现状（用于对照的基线）

| 项 | 值 |
| --- | --- |
| 分支 / HEAD | `main` / `a34a007`，工作区干净 |
| Rust 核心 | 7 个 std-only crate，`contracts 1581 / core-account 2564 / core-assistant 4000 / core-im 3302 / core-net 3107 / core-notify 2245 / core-store 1816` ≈ **18.6k 行** |
| Tauri 宿主 | `src-tauri/src` 22 个模块 ≈ **19.2k 行**（含 `login.rs` 单文件 1194 行+） |
| 前端 | 188 个 `.ts` ≈ **25.9k 行**，零依赖 TS + `ui-kit`/`ipc`/`web-adapter` |
| 命令 | **69 个**（`src-tauri/commands.txt` 冻结清单，与 `lib.rs generate_handler!`/`views.rs`/capabilities/`ipc/src/{commands,client,adapterProtocol}.ts` 四方一致性受 `ui/apps/_shared/contract-consistency.test.ts` 校验） |
| UI 应用 | 8 个：`main login alarm setting update package-detail _shared`（+ `REVIEW` 文档） |
| 测试 | 最近记录 7b5d75a 包：UI 711 / 宿主 178 / 核心 312；round6 快照：TS 536 / core 304 / host 126，0 失败 |
| 持久化 | `core-store`（std-only，文件态）；**无 SQLite** |
| IM | **Web 路线**：`ui/packages/web-adapter` 在 WebView 内复用网页 Web IM SDK/XMPP + 会话列表 5s 轮询 + 补偿 |
| 验收 | 第 6 轮满轮停止，**整体验收未通过** |

---

## 3. 差距矩阵

图例：🔴 完全缺失 · 🟠 有雏形/未闭环 · 🟡 部分对齐 · 🟢 对齐 · ⚪ 有意裁剪（不算差距）

### 3.1 后端 / 宿主

| 能力 | 官方 1.2.13 | 重构端 | 差距 |
| --- | --- | --- | --- |
| IM 传输 | 原生 XMPP SDK（`s-node-imclient-core`）独立 utilityProcess，socket 优先 + HTTP 兜底 | WebView 内网页 SDK + 5s 会话轮询 + 补偿 | 🔴 **架构级差距** |
| 消息类型 | 16 种（含 Card/Template/At/Location/Emoticon/InputState） | 已映射 `sys_muc/sys_mam`，At/Template/Location/Emoticon 未见 | 🟠 |
| 输入态 | `sendInputState` | 无 | 🔴 |
| 已读回执 | `putAdviceOfReadByMsgId`（按 msgId + partnerJid） | `im_mark_read`（可见消息 + 当前服务身份绑定） | 🟡 |
| 本地 DB | better-sqlite3 + drizzle，10 表 13 迁移，崩溃恢复 | std-only 文件态（`core-store`） | 🔴 **架构级差距** |
| 历史分页 | 服务端 `haveRest` + 本地 `localNextTime` 水位 + `message_cite_msg_id` | 有 `im_message_page`，但分页后**视觉锚点丢失**未修 | 🟠 |
| 每账号 IM 实例 | `imProcessMap`（buid → utilityProcess） | 账号代次 + 单一 web 会话 | 🟠 |
| OCR | paddleocr + onnxruntime-web + worker（`recognize_image`/`_buffer`/`cancel_recognition`） | 无（`upload.ts` 仅提及） | 🔴 |
| 拼写检查 | `spell_check` + worker | 无 | 🔴 |
| 页内查找 | `open_finder_window` + DOM 浮层（`pre-web.js` 自建 UI，含输入法组字处理） | 无 | 🔴 |
| 文件下载 | `download_file`（支持 blob:/data:）+ 下载目录 | 无 | 🔴 |
| 截图 | 完整遮罩 + 工具条 + 设置 + 保存（`Ne`/`Jh`/`Ir`） | `media_screenshot`（Windows 下 `HOST_UNSUPPORTED`） | 🔴 |
| 更新 | electron-updater + `update` 页 + 8 个 update/arch 通道 | `ui/apps/update` 有 UI，**无 `update_*` 命令** | 🔴 |
| 热更 | `downloadBundleZip` + `dist.back` + `packageVersion.json` | 无 | 🔴 |
| 架构迁移引导 | 8 个 `arch_*` 通道 + 独立窗口 + pkg 下载/安装 | 无 | 🔴 |
| i18n | Shark `getLangDump`/`qconfig` 热拉 + `sharkInfo` 表 | `ui-kit/i18n.ts` 静态 | 🟡 |
| 遥测 | UBT/ares-agent + electron-crashreport | 无 | 🔴 |
| 托盘 + 未读 | 托盘闪烁 + `countMap` + `flickerTimer` | 有 `tray.rs` + `notify_*` | 🟡 |
| 强提醒 | `Alarm Dialog` + `reply_timeout` | `alarm` 应用 + `core-notify` + 1Hz 调度 | 🟢 |
| 多账号 | `st` 账号管理器 + 独立 IM 进程 + 缓存密码/排序 | `account_*`（6 命令）+ `login.rs` | 🟡 |
| 窗口清单 | 24 个本地页面 | 8 个应用（其中业务页 ⚪ 有意裁剪） | 🟠 |
| 通道/命令数 | 93 IPC 通道 | 69 Tauri 命令 | — |
| 业务动作 | 由远程/本地页面自行调用（宿主不感知） | `im_members/invite/transfer/finish/set_top/set_mark/customer_scripts` + `notice_*` + `order_*` 在宿主显式建模 | 🟢 **重构端更强** |
| 出站保护 | 无（直接 SDK 发送） | `confirmed/rejected/unknown` 三态 + 账本 + 持久屏障 + 不重发 | 🟢 **重构端更强** |
| 商家助手 | 外部独立程序（插件 `Resources/plugin/captureTool`） | `core-assistant` + `assistant_*` 10 命令（TSim/翻译/套餐速览/详情） | 🟢 **重构端独有** |

### 3.2 前端

| 页面/能力 | 官方 | 重构端 | 差距 |
| --- | --- | --- | --- |
| `main`（壳 + 左栏 + BrowserView 栈） | 有 | 有（单 WebView + 右栏） | 🟡 |
| `login` | 有（`loginWindow` 186KB + loading 遮罩） | 有 | 🟢 |
| `imPlus` / `notice` 分栏窗口 | 有（2.78MB IM 页） | 合并在 `main` | 🟡 |
| `alarm` | 有 | 有 | 🟢 |
| `setting` | 有 | 有 | 🟢 |
| `update` | 有 | 有 UI，无后端 | 🟠 |
| `image` 查看器 / `video` 播放器 | 有（`openWindow` image/video） | 无独立窗口 | 🔴 |
| `screenshots` + `screenshotsOverlay` | 有（工具条 + 设置 + 保存） | 无 | 🔴 |
| `notifier` 通知弹窗池 | 有（`nt` winCache/queue/activeList） | 无（仅 `alarm`） | 🔴 |
| `ai` 窗口 | 有（`open_ai_window`） | 改为右栏助手 | 🟡 |
| `toolTip` / `launch` 闪屏 | 有 | 无 | 🔴 |
| `web` 容器页 | 有（BrowserView 业务页） | 无（直接承载） | 🟡 |
| `archGuide` | 有 | 无 | 🔴 |
| `home/event/bulletin/product/bi/comment/course/order` | 有（完整业务） | 无 | ⚪ 有意裁剪 |

### 3.3 体积

| | 官方 | 重构端 |
| --- | --- | --- |
| 安装包/产物 | asar 364 MB（+ 19 MB dist + 原生模块） | round6 NSIS 6.6 MB / exe 20.5 MB |
| 前端 | 19 MB（含 antd-vendor 1.1MB + imWindow 2.78MB） | 25.9k 行零依赖 TS |

---

## 4. Bug 清单

### 4.1 官方端（逆向发现，均给出证据位置，未经运行时验证）

| # | 级别 | 问题 | 证据 |
| --- | --- | --- | --- |
| O1 | 高 | **`dbQuery(sql, params, 'run')` 允许远程页面写本地库**。`R()` 对 `run` 模式直接返回 `true`，仅禁 `;` 与注释；任意命中域名白名单的页面可执行 `insert/update/delete/replace` 到本地 SQLite | `pre-*.js` 的 `L()/R()/y()` 逻辑 |
| O2 | 高 | **域名白名单 30 个且含内网/测试/第三方域**（`*.ctripcorp.com`、`*.tripqate.com`、`qunar.com`、`tujia.com`、`regmerchant.occpay.com`…）。任一白名单页面 XSS 即可借 `netFetch` SSRF 内网、借 `getLoginCookie/getAllLoginCookies` 取全部登录态 | 白名单数组 `E/S/T/W` |
| O3 | 中 | `get_login_cookie` / `get_all_login_cookies` 虽在 `invoke` 黑名单里，但仍以包装方法 `getLoginCookie()` 直接暴露，白名单页面可一次性拿到全部账号 Cookie | `x()/O()/D()` 中三个 getter |
| O4 | 中 | **登录页 loading 遮罩的 `message` 监听无 origin 校验**：`window.onmessage = t => { t.data.payload === "removeLoading" && n() }`，任意 frame 可提前移除遮罩（配合 4.999s 超时兜底） | `pre-index.js` 末尾 |
| O5 | 中 | 发送结果判定脆弱：`P()`/`I()` 仅靠 `ResponseStatus.Ack.toLowerCase()==='success'`；HTTP 200 但业务失败时走 `a()` 记录 `error/errmsg`，**UI 侧仍需自行区分**，官方无本地 unknown 账本与重发屏障 | `main-imsdk.js` `P()/I()` |
| O6 | 中 | IM SDK 进程无心跳/探活：`im.js` 只有 10s 节流的 `reconnectImPort`，`imsdk.js` 侧连接态变化才广播；端口 `close` 事件只做清理，**无自动重连** | `main-imsdk.js` appendPort/close 分支 |
| O7 | 中 | `OCRManager` 用 `pendingRequests` Map 存请求，`cancelRecognition` 未清理整个 map；worker 崩溃时请求悬挂（有 `modelDirPromise/workerReadyPromise` 但无超时） | `Bt` 类 |
| O8 | 低 | `app-update.yml` 的 `url: ''` + `provider: generic` 为空，实际更新源依赖 `packageVersion.json` 里的 `feedUrl`；配置项与真实来源不一致 | `Resources/app-update.yml` |
| O9 | 低 | 技术栈混用：Vue 3 主栈里依赖 `@tanstack/react-virtual`、同时装 `zustand` 与 `redux@4.0.4`，`imWindow` 单包 2.78 MB | `package.json` |
| O10 | 低 | 共有 5 份 preload 各自内嵌同一份 93 项通道表与安全正则（4 份完全重复），维护成本高、易漂移 | 4 个 preload 文件 |

### 4.2 重构端（来自 `BLOCKED.md` / `PROGRESS.md` / round6 记录，**尚未闭合**）

| # | 级别 | 问题 | 现状 |
| --- | --- | --- | --- |
| R1 | P0 | **历史分页后视觉锚点丢失**：第 5、6 轮均实机复现（原 18:33 撤回行跳到 18:21 订单卡）；60c9479 修复未在忙账号现场闭合 | 未关闭 |
| R2 | P0 | **会话列表计数与官方不一致**：新包 11 处理中/9 完成 vs 官方 11/24；Nay 0/921 vs 官方 20/1959（官方含近 30 日缓存合并，差额构成未证明） | 未关闭 |
| R3 | P0 | **自然实时接收/双向未验**：官方发 W 后 49 秒原生仍无（第 2/3/4 轮连续），仅加载旧页后可见；服务端 ID 跨端核对未完成 | 未关闭 |
| R4 | P0 | **真实媒体上传/读回未验**：图片/文件/视频真实上传未读回；大视频分片未实现；Windows 截图 `HOST_UNSUPPORTED` | 未关闭 |
| R5 | P1 | 官方网页登录阻塞：Edge 专用页跳登录、二维码过期；桌面授权唤起失败 | 未关闭 |
| R6 | P1 | 默认 UI WebView 内存偏高（取证面板影响与持续增长未区分） | 未关闭 |
| R7 | P2 | 引用撤回原文残留（02d4125 已修待新包验） | 待验 |
| R8 | P2 | 历史按 `server_id` 合并未联合 `local_id` → unknown 本地回显与 confirmed 历史重复 | 未修 |
| R9 | P2 | 实时/补偿订单卡不更新会话订单摘要 | 未修 |
| R10 | P2 | 历史订单 A 卡「查看」按钮打开当前订单 B 侧栏 | 未修 |
| R11 | P2 | 机器人名称显示 raw 本地化 key（官方显示「游游机器人」） | 未修 |
| R12 | P2 | TSim 订单摘要只返回 ICCID，名称/using/供应商字段缺失 | 未修 |
| R13 | P2 | 服务端时钟锚点未在生产接线 | 未修 |
| R14 | P2 | 发送身份切换竞态（a0b4416 已修待验） | 待验 |

未实现项（对照 §3.1）：OCR、拼写检查、页内查找、文件下载、独立媒体窗口、截图遮罩、更新与热更、arch guide、遥测、通知弹窗池、SQLite 本地库。

---

## 5. 结论与重构路线建议

### 5.1 三条根因

1. **IM 传输选错了基准。** 官方的真实能力是「原生 XMPP SDK + 独立进程 + 每账号一实例 + 16 种消息类型 + 输入态/已读回执」。重构端选了「WebView 内网页 SDK + 5s 轮询」，这在延迟（5s 级）、消息类型覆盖、输入态、连接态机上都是结构性劣势，R1/R2/R3 三个 P0 都源于此。**建议：把 `s-node-imclient-core` 的协议契约（env=3/appId=900004/socket 优先 HTTP 兜底/Ack 判定/16 类型/putAdviceOfReadByMsgId/sendInputState）作为 G0 原型目标，用 Rust 写一个 std-only 的 XMPP 客户端 crate（`core-im-xmpp`），而不是继续在 WebView 里抓网页 SDK。** 官方 SDK 的 `main.js`/`parser.js` 就在解包目录里，可直接读协议。
2. **本地数据层缺位。** 官方用 SQLite + drizzle 支撑历史分页水位（`localNextTime`）、分类桶（`IQConversationInfo`）、引用消息 ID（`message_cite_msg_id`）、群成员/排班/自定义表情缓存。重构端 std-only 文件态撑不住这些，R1（分页锚点）与 R8（ID 合并）都与之相关。**建议：引入rusqlite（或 tauri-plugin-sql）并把官方 13 个迁移的表结构作为源头契约。**
3. **宿主能力清单不完整。** 重构端把力气花在了宿主侧业务建模（这块比官方更强），但宿主基础能力（截图/OCR/查找/下载/更新/热更/媒体窗口/通知池）几乎为零。

### 5.2 建议的落地顺序（在现有 69 命令之上增量）

| 阶段 | 内容 |
| --- | --- |
| G0 | IM 协议原型：Rust XMPP 客户端 + `im_xmpp_*` 命令组；先只做 connect/心跳/收发/newNotice；与现有 web-adapter 并行可切换 |
| G1 | `core-store` 换 SQLite，落官方 10 表结构 + `localNextTime` 水位 + `message_cite_msg_id`；闭环 R1/R8 |
| G2 | 分页视觉锚点（用真实行 ID，不是像素指纹）；闭环 R2 计数口径（明确「服务端列表」vs「官方 30 日缓存」） |
| G3 | 截图遮罩 + OCR（onnxruntime 目前只有 web 版，Rust 侧需换 ort 或复用 wasm worker） |
| G4 | 媒体窗口（image/video）+ 页内查找 + 文件下载 + 更新/热更 |
| G5 | 通知弹窗池 + 遥测 + i18n 热拉 |

### 5.3 直接可复用的官方资产

- `/tmp/vbk-re/app2/node_modules/@ctrip/s-node-imclient-core/{main.js,parser.js}` —— XMPP 协议与消息编解码的**一手参考**（注意：仅用于理解协议，运行时改用自研 Rust 实现）。
- `/Applications/旅游商家桌面版.app/Contents/Resources/app.asar.unpacked/dist/drizzle/*.sql` —— 10 张表的完整 DDL 与演进历史。
- 5 个 preload 的 93 项通道表 + 安全闸门正则 —— 若保留 WebView 承载网页，这套闸门应在 Tauri 侧以 capability/ACL 重写，而不是照搬到 JS。

### 5.4 纪律提醒

- 本报告为**静态逆向**，O1–O10 未经运行时验证，落地前需实机取证。
- R1–R14 引自仓库既有记录（第 6 轮满轮停止，整体验收未通过），非本次新增。
- 官方客户端及其内部 `@ctrip/*` 包为携程内部资产；逆向仅用于本项目的重构对照，不得分发或复用其专有代码。
