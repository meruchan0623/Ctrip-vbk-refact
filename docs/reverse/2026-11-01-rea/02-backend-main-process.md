# 02 官方客户端后端架构：Electron 主进程 + preload + utility worker

> 对象：旅游商家桌面版 Mac 1.2.13（`/Applications/旅游商家桌面版.app`）/ Windows 1.2.12（`~/Downloads/vbk-electron`）。
> 依据：`~/tools/rea-work/facts/*`（rea 6.8.0 静态抽取）、对 `facts/{mac,win}-main-split.txt` 的定向 grep、解包目录 `{mac,win}/extracted/app/`。未执行目标中的任何代码。
> 标注：**[已验证]** 有行号或文件证据；**[推断]** 由命名或调用关系推出；**[未知]** 静态证据不足。归属：**官方** / **插件**（第三方「旅游商家助手」注入）。
> 行号约定：`S:1234` 表示 `facts/mac-main-split.txt` 第 1234 行（主进程 bundle 按 `;` 拆行，Windows 版行号不同但代码相同）；`index.js:51:11777` 这类为 rea 给出的原始 文件:行:列。

## 0. 结论速览

| 指标 | 数值 | 状态 |
|---|---|---|
| BrowserWindow / BrowserView | 14 / 2（`new f.BrowserWindow` 14 处，`new f.BrowserView` 2 处） | [已验证] |
| 主进程引用的页面 | 24 个 `pages/<name>`（渲染层共 25 个页面，另 1 个未被主进程直接引用） | [已验证] / 第 25 个 [未知] |
| utility 子进程 | 3 个：`imsdk.js`、`ocr-worker.js`、`spell-check-worker.js`，均为 `utilityProcess.fork`，不是 `child_process.fork` | [已验证] |
| rea 计数的局限 | rea 的 `electron` 统计把窗口记为 0、主进程处理器记为 5，原因是 bundle 把 `electron` 重命名为 `f.`/别名后 rea 识别不到；本文窗口与 IPC 数量一律以字节 grep 为准 | [已验证] |
| IPC 枚举 `y` | 93 个 channel 名（S:123） | [已验证] |
| 全局 ipcMain 注册 | 70 处（`handle` 33 + `on` 37；其中 `SCREENSHOTS:*` 5 处），另有 `webContents.ipc.*` 22 处按窗口注册 | [已验证] |
| contextBridge | 11 次暴露、9 个不同名字、45 个成员（appBridge 11 个成员 × 3 个 preload，加上 screenshots 的 12 个成员） | [已验证] |
| sender 校验 | 仅 3 处（`execute_db`、`toggle_baolei`、`change_env`，都通过 `Rt()` 实现） | [已验证] |
| 主进程模块 | 24 个（见 §3） | [已验证]/[推断] 混合 |
| 外部域名 | 36 个（主进程 21 个 + IM SDK 15 个），其中 32 个在 `docs/api/inventory.json` 中没有收录 | [已验证] |
| Mac 与 Win 的代码差异 | preload、worker、`main-DdiqF_NH.js` 字节完全一致；`index.js` 和 `imsdk.js` 只差 chunk 哈希名和压缩器生成的标识符 | [已验证] |

## 1. 技术栈与版本

### 1.1 运行时与构建 [已验证，来源 S:487 内联的 package.json]
- **Electron 27.3.11 / Chromium 118 / Node 18.x**（Node 版本由 Electron 27 推断）。包名 `vbk-electron`，版本 Mac `1.2.13`、Win `1.2.12`，`main = dist-electron/main/index.js`（官方）。
- **构建链**：`start: cross-env NODE_ENV=development vite`；`build: tsc && vite build && node ./scripts/build.js`；`rebuild: electron-rebuild`；`config.forge: ./forge.config.js`，`config.arch: arm64`；`env.VITE_DEV_SERVER_URL = http://127.0.0.1:7777/`；`lint: node-vampire-lint`；`test: jest`。
  - 产物目录 `dist-electron/{main,preload}` 加上 `VITE_DEV_SERVER_URL`，符合 **vite-plugin-electron** 的约定 [推断]；打包由 **Electron Forge** 完成 [推断，依据 `config.forge`]。
  - `config.arch: arm64`，但 Mac 主程序只有 x86_64（见 BRIEF），二者矛盾，原因 [未知]。
- **主要三方库**：`better-sqlite3 11.1.2` 和 `sqlite3 ^5.1.7`（两套 SQLite 驱动同时存在）、`drizzle-orm ^0.32.0`、`electron-store ^8.2.0`、`electron-log ^5.1.2`、`electron-updater ^6.1.1`、`node-screenshots ^0.2.8`、`onnxruntime-web ^1.24.3`、`paddleocr ^1.1.1`、`sharp ^0.34.5`、`jimp 0.22.12`、`adm-zip`、`axios ^0.28.1`、`request`、`node-fetch`、`heapdump`、`xlsx`。React、antd、tiptap、zustand 等渲染层依赖也写在同一个 `dependencies` 里。
- **原生 addon**（mac-main-facts.tsv 的 native-addon 段）：better_sqlite3.node、node_sqlite3.node、node-screenshots.darwin-x64.node、heapdump addon.node、@napi-rs/snappy、@napi-rs/nice、fsevents、@ctrip/node-vampire-cache-prebuild16、@ctrip/node-vampire-locker-prebuild，共 10 个（另含 better-sqlite3 的 test_extension）。

### 1.2 @ctrip 私有包（主进程相关）
| 包 | 版本 | 用途 | 主进程是否直接 require |
|---|---|---|---|
| `@ctrip/s-node-imclient-core` | 1.0.24 | IM 客户端（内置 xmpp.js，经 WebSocket 发送 XMPP） | 是，`imsdk.js` S:16 [已验证] |
| `@ctrip/electron-crashreport` | 2.0.1 | 崩溃上报 | 是，S:109 [已验证] |
| `@ctrip/node-electron-clientid` | 1.0.10 | 设备 clientId，供埋点使用 | 是，S:109、S:491 [已验证] |
| `@ctrip/node-electron-hotfix` | 1.0.16 | 热更新 SDK | 只出现在依赖表中，主进程没有 require；热更新逻辑由自研的 `UpdateManager` 实现（S:1514-1545）[推断：未使用或被内联] |
| `@ctrip/electron-notification` | 1.0.3 | 系统通知 | 只出现在依赖表中；实际使用自研的 notifier/alarm 窗口 [推断] |
| `@ctrip/ares-agent` | ^6.3.11 | ares 发布平台，提供 `aresVersion`/`aresName` | 由 packageVersion.json 体现 [推断] |
| `@ctrip/trip-component-ubt`、`@ctrip/ubt-web` | 4.1.4 / 1.4.5 | UBT 埋点 | 主要在渲染层；主进程通过 `initUbt` 取 clientId（S:491）[已验证] |
| `@ctrip/cargo-nodejs` | ^3.8.12 | 携程 Node 服务端框架 | [推断] 是 `node-vampire-*` 全家桶被带入包内的来源 |
| `@ctrip/node-vampire-dal` / `-p7zip` / `-cache` / `-locker` 等约 50 个 | – | 服务端 DAL、7z、缓存、锁、redis、qmq、thrift、soa | 主进程 grep `DalDecrypt`、`7za` 结果均为 0，属于传递依赖，打包了但没有用到 [已验证 grep 0] |
| `@ctrip/im-web-file-uploader`、`nfes-*`、`xtaro-*`、`shark-*` | – | 渲染层 IM 上传、基础库、跨端组件、多语言 | 否 |

## 2. 进程与窗口拓扑

### 2.1 窗口与页面对照 [已验证：构造行与 loadURL/loadFile 行相邻；preload 变量已解析]
所有短名 preload 变量（Zh、tp、np、sp、ko、Ep、Gp、Hp、Kp）都指向 `../preload/index.js`；`Hh()` 解析为 `preload/screenshots.js`。

| # | 类型/标题 | 页面 | 构造行 | preload | 关键 webPreferences/窗口属性 |
|---|---|---|---|---|---|
| W1 | BrowserWindow `screenshots-v2`（每块显示器一个，存在 `wins` Map 中） | `pages/screenshotsOverlay` | S:1473 | screenshots.js | `contextIsolation:true`、`nodeIntegration:false`、**`webSecurity:false`**、`additionalArguments:["--preloadName=screenshots"]`；透明、无边框、`alwaysOnTop("screen-saver")` |
| W2 | `Update window` | `pages/update` | S:1549 | index.js | 模态，挂在父窗口下，510×300 |
| W3 | `Message Dialog`（ToolTip） | `pages/toolTip` | S:1596 | index.js | `focusable:false`，无边框 |
| W4 | `Alarm Dialog` | `pages/alarm` | S:1626 | index.js | 置顶；Windows 放在左上角，Mac 放在右下角 |
| W5 | `Message Dialog`（Notifier） | `pages/notifier` | S:1647 | index.js | 自研的消息通知弹窗，从右下角滑入 |
| W6 | 图片查看器 | `pages/image#…` | S:1877 | index.js | `titleBarStyle:hidden` |
| W7 | 视频播放器 | `pages/video` | S:1880 | index.js | **`backgroundThrottling:false`** |
| W8 | Web 容器窗口 | `pages/web#buid=` | S:1946 | index.js | 1280×960，作为 V1 的宿主 |
| V1 | BrowserView（Web 标签页） | 外部 URL `loadURL(t,n)` | S:1974 | **web.js** | **`partition:"persist:"+buid`**、**`webSecurity:false`** |
| W9 | `extraWin` 外部窗口 | 外部 URL，可带 `postData` 和 `extraHeaders` | S:2014（loadURL 见 S:1997/2018） | web.js | `persist:<当前 buid>`、`webSecurity:false` |
| W10 | AI 窗口 | `pages/ai` | S:2047 | index.js | `persist:<buid>`、`webSecurity:false` |
| W11 | `版本切换提示`（架构引导） | `pages/archGuide` | S:2260 | index.js | `webSecurity:false`；内置下载器，引导用户下载 Intel 或 Apple 芯片版本 |
| W12 | `Main window` | `pages/main` | S:2342 | **main.js** | `webSecurity:false`、`frame:false`、标题栏覆盖层 |
| V2 | BrowserView（主窗口业务标签） | `pages/{imPlus,notice,home,setting,event,product,order,bi,bulletin,course,comment}`（映射表 `Wo` 见 S:2321） | S:2370 | 默认 index.js；imPlus 和 notice 用 **im.js**（S:2369） | `session: fromPartition("persist:"+buid)`；**只有 setting 页的 `webSecurity` 为 true**，其余页面都是 false |
| W13 | `Login window` | `pages/login` | S:2464 | index.js | `webSecurity:false` |
| W14 | `Launch window` | `pages/launch` | S:2480 | index.js | 无边框，初始隐藏 |

- 16 处 webPreferences 中 **7 处显式写了 `webSecurity:false`**（W1、W9、W10、W11、W12、W13、V1），另有 V2 按页面条件切换，合计 8 处，与 03-defects 的 SEC-01 一致。没有一处显式设置 `sandbox`；Electron 27 默认 `contextIsolation:true`，并且在 nodeIntegration 关闭时默认开启 sandbox [推断]。
- `setWindowOpenHandler` 统一返回 deny，然后用 `openWebWindow` 打开（S:2372）[已验证]。
- 开发环境或 `shouldOpenDevToolsOnStart()` 为真时会自动打开 DevTools（S:2371）[已验证]。

### 2.2 utility 进程与 MessagePort [已验证]
- **IM SDK 进程**：`utilityProcess.fork(path.join(__dirname,"../main/imsdk.js"))`，位于 S:1777 附近。子进程通过 `process.parentPort.on("message")` 处理 `PROCESS_MESSAGE_NAME = {init_im_sdk, append_port, remove_port, close_port, destroy}`（S:4、S:27-41）。
- **OCR 进程**：`OCRManager` 执行 `utilityProcess.fork(e,[],Xr())`（S:1820），进程退出后置空，下次请求时重新拉起。
- **拼写检查进程**：`SpellCheckManager` 执行 `utilityProcess.fork`（S:2518），机制同上。
- `MessageChannelMain` 共两处：S:1790 为 IM 通道，主进程创建 `port1/port2`，一端通过 `append_port` 交给 imsdk，另一端通过 `get_im_channel_port` 交给 imPlus/notice 视图；S:2383 为主通道，在主窗口和各 BrowserView 之间建立（`get_main_channel_port` / `send_main_channel_port`）。
- 渲染端 API：im.js 暴露 `postImMessage`、`setIMMessageHandler`、`reconnectImPort`、`getImPortStatus`、`postMainMessage`；main.js 暴露 `postPortMessage`、`setMainMessageHandler`。
- `child_process`：grep 中的 `exec(` 2 处实为 `RegExp.exec`（用 `[^.]exec\(` 复核结果为 0）[已验证]；`spawn(` 只在插件 bootstrap 中出现。

```mermaid
flowchart LR
  subgraph Main[主进程 index.js 官方]
    WM[WindowManager B] --- AM[Account/Session]
    DB[(DBManager better-sqlite3+drizzle)]
    UP[UpdateManager ares/electron-updater]
    TR[Tray/Dock]
    SS[Screenshots node-screenshots]
  end
  IM[[utility: imsdk.js<br/>s-node-imclient-core<br/>XMPP over WSS]]
  OCR[[utility: ocr-worker.js<br/>onnxruntime+paddleocr]]
  SP[[utility: spell-check-worker.js]]
  Main -- parentPort: init_im_sdk/append_port --> IM
  Main -- recognize_image --> OCR
  Main -- spell_check --> SP
  subgraph MW[W12 Main window preload/main.js]
    V2a[V2 imPlus/notice<br/>preload/im.js]
    V2b[V2 home/order/product/...<br/>preload/index.js]
  end
  IM <-. MessagePort IM通道 S:1790 .-> V2a
  MW <-. MessagePort 主通道 S:2383 .-> V2a
  MW <-. MessagePort 主通道 .-> V2b
  W8[W8 web 容器] --- V1[V1 BrowserView web.js<br/>persist:buid]
  W9[W9 extraWin web.js] 
  Others[W1 截图/W2 更新/W3-5 提示通知/W6 图片/W7 视频/W10 AI/W11 架构/W13 登录/W14 启动<br/>preload/index.js]
  Main --> MW & W8 & W9 & Others
  IM -- wss ws-xmpp --> IMS[(im.ctrip.com / im.trip.com / im3.*)]
  Plugin[[插件 Win: 旅游商家助手.exe]] -. CDP 127.0.0.1:随机端口 .-> MW
```

## 3. 主进程模块清单

| # | 模块 | 职责 | 入口位置 | IPC/桥接成员 | 原生能力 | 归属 |
|---|---|---|---|---|---|---|
| 1 | 启动与生命周期 | 单实例锁，Win7 关闭硬件加速，`setAppUserModelId`，GPU 偏好设置，打开启动窗后自动登录或先检查更新 | S:2544-2556 | `window_loaded`、`show_window` | app、session | 官方 [已验证] |
| 2 | 窗口管理（B/Oe/je 等单例） | 创建 14 个窗口和 2 个视图，切换标签，查找页面内容，打开外部窗口 | S:1946-2050、S:2321-2390 | `open_window`、`open_extra_window`、`close_extra_window`、`main_view_changed`、`web_view_changed`、`get_web_info_list`、`find_in_page`、`stop_find_in_page`、`found_in_page`、`open_finder_window`、`window_full_screen`、`window_height_change`、`force_focus` | BrowserWindow/BrowserView | 官方 [已验证] |
| 3 | 托盘/Dock/菜单（TrayManager `$t`） | 托盘图标与菜单，未读数，Mac 端 `tray.setTitle` 加 `dock.setBadge`，Win 端图标闪烁加 overlay | S:1566-1590；应用菜单 S:556 | `unread_message_count`、`flash_main_window` | Tray、Menu、dock、flashFrame | 官方 [已验证] |
| 4 | 通知（notifier/alarm/toolTip） | 新消息弹窗、回复超时告警、提示条；监听 powerMonitor | S:1596-1660 | `new_message`、`reply_timeout`、`notify_info`、`jump_to_conversation`、`clear_message_by_user` | powerMonitor | 官方 [已验证]；`@ctrip/electron-notification` 未使用 [推断] |
| 5 | IM SDK 宿主 | fork imsdk，分发 MessagePort，处理端口断开与重连 | S:1777-1800；imsdk.js S:15-110 | `get_im_channel_port`、`im_process_started`、`send_broadcast_event`、`get_current_messages`；桥接 `postImMessage`、`setIMMessageHandler`、`reconnectImPort`、`getImPortStatus` | utilityProcess、MessageChannelMain | 官方 [已验证] |
| 6 | IM 连接（SDK 内部） | xmpp.js 客户端：URL 为 `<prefix>//<websocketHost>/ws-xmpp/`，带 reconnect、websocket、tcp、tls 中间件；`Reconnect.delay=1000ms`；`startConnectionCheck` 用 setInterval 计数 ping，socket 未连接且超过 12 次时重连；收到 `Replaced by new connection` 时判定被挤下线；内网或证书错误时设置 `NODE_TLS_REJECT_UNAUTHORIZED='0'` | `node_modules/@ctrip/s-node-imclient-core/main.js` | – | ws、tls | 官方 [已验证] |
| 7 | 账号/Cookie/Session | 多账号以 `persist:<buid>` 分区隔离；登录成功或失败、切换账号、退出、缓存账号与密码、排序；`syncSessionProxy` 按偏好在 system 和 direct 代理之间切换 | S:1692、S:1761、S:2071、S:2092、S:2365 | `get_login_cookie`、`get_all_login_cookies`、`get_cache_account_list`、`remove_cache_password`、`sort_account_list`、`get_current_user_info`、`get_account_list`、`login_success`、`login_failure`、`add_account`、`change_account`、`logout`、`begin_to_login`、`refresh_data`；桥接 `getLoginCookie`、`getAllLoginCookies`、`getCacheAccountList` | session、cookies | 官方 [已验证]；密码与 ticket 明文存入 electron-store，见 PRI-01；safeStorage/keytar 的 grep 结果为 0 |
| 8 | 请求拦截 | `onBeforeRequest`：拦截 `file://` 页面和网关 URL，按 `preference.gateway` 改写；`onHeadersReceived`：对 `https://*/*` 按 hostname 处理响应头 | S:2095、S:2372 | – | webRequest | 官方 [已验证]；改写的具体内容（如去掉 X-Frame-Options/CSP 以配合 `IFRAME_WHITE_DOMAINS`）[推断] |
| 9 | 主进程网络代理 | 渲染端发起、由主进程代为执行的 fetch（不受 CORS 限制） | `ipcMain.handle(y.netFetch)` | `net_fetch`；桥接 `netFetch` | net/https | 官方 [已验证] |
| 10 | 本地数据库（DBManager） | better-sqlite3 加 drizzle 迁移（`openAndMigrate`，带损坏恢复）；`execute_db` 是通用 SQL 桥 | S:1124（migrate）、S:1728-1729 | `execute_db`（有 `Rt` 校验）；桥接 `dbQuery` | better_sqlite3.node | 官方 [已验证] |
| 11 | KV 存储 | electron-store：环境、堡垒、偏好、启动次数、停留时长、URL 列表、租车账号列表、各类时间戳 | S:487（常量），`z=new Fl` | `get_user_preferences`、`change_user_preferences`、`set_cache_data`、`get_cache_data`、`get_cache_url_list`、`clear_cache_url_list`、`clear_user_store`、`get_stay_duration`、`get_launch_count` | fs | 官方 [已验证] |
| 12 | 截图 | 用 node-screenshots 预热原生模块，按显示器创建透明窗；Mac 端检查屏幕录制权限；结果写入剪贴板或粘贴回主窗口 | S:1449-1500；处理器 index.js:51:8738-11932 | `SCREENSHOTS:{getAllSettings,ok,cancel,imageLoaded,updateToolSettings}`（ipcMain），`SCREENSHOTS:{ready,reset,save,selectionReady,captureWindow}`（渲染端发出）；`open_screen_shot_panel`、`paste_screen_shot`、`screen_shot_ready`；桥接 `screenshots.*` 共 12 个 | node-screenshots.node、clipboard、globalShortcut、systemPreferences | 官方 [已验证]；`Resources/plugin/captureTool`（70KB）在主进程中没有被引用，归属 [未知] |
| 13 | OCR | 从 raw.githubusercontent 下载 PP-OCRv5 det/rec onnx 模型和字典（`https.Agent({rejectUnauthorized:false})`），在 utility 进程中推理 | S:1808-1852 | `recognize_image`、`recognize_image_buffer`、`cancel_recognition` | onnxruntime-web(wasm)、sharp/jimp | 官方 [已验证] |
| 14 | 拼写检查 | 在 utility worker 中做拼写检查 | S:2518 | `spell_check` | – | 官方 [已验证] |
| 15 | 渲染层热更新（ares） | 读取 `app.asar.unpacked/dist/packageVersion.json`，比较 aresVersion，下载 `distUrl` 的 dist.zip，用 AdmZip 解压，原 dist 备份后执行 `moveSync` | S:1505-1545 | `get_cur_version_info`、`get_update_info`、`check_new_version`、`update_new_version`、`download_new_version`、`install_new_version`、`update_status_change` | fs、adm-zip | 官方 [已验证]；强制走 HTTP 且没有校验，见 SUP-01 |
| 16 | 安装包更新 | 比较 pkgVersion 和 minPkgVersion，用 electron-updater 的 `autoUpdater.quitAndInstall(true,true)` 安装 | S:1524-1534、S:1557；`app-update.yml`：`provider: generic`、`url: ''` | 同上 | Squirrel/NSIS | 官方 [已验证]；运行时通过 setFeedURL 指向 feedUrl [推断] |
| 17 | 架构引导 | 检测 Intel/Apple 芯片，弹出 W11 引导下载对应版本，并上报 UBT | S:2254-2270；`getArchGuideDownloadUrl` S:13 | `arch_detect_result`、`show_arch_guide`、`arch_guide_action`、`arch_guide_render`、`arch_guide_action_ubt`、`arch_guide_download_progress`、`arch_guide_download_done`、`request_arch_guide` | – | 官方 [已验证] |
| 18 | 崩溃与日志 | `@ctrip/electron-crashreport`；electron-log 的事件捕获（certificate-error、child-process-gone、render-process-gone、did-fail-load、preload-error、unresponsive） | S:109、S:2712-2713 | `video_player_log` | crashReporter | 官方 [已验证] |
| 19 | 埋点 UBT 与 clientid | `initUbt()` 中执行 `clientId = await clientid.get()`，结果放进 `get_app_config` 返回 | S:491、S:508 | `get_app_config` | – | 官方 [已验证] |
| 20 | 协议唤起 | 注册 `setAsDefaultProtocolClient(SCHEMA_MAP[nodeEnv])`，生产环境为 `vbookingChat://`；Mac 走 `open-url`，Win 走 `second-instance`，统一交给 `onProtocolOpen`；内部还有 `implus://` 跳转 | S:2569-2575、S:4 | – | protocol | 官方 [已验证] |
| 21 | 多语言 Shark 与 qconfig | 拉取 `getLangDump` 并切换语言；qconfig 以 jsonp 方式获取配置（壳窗口 `shellWin`） | S:1755-1765、S:2285 | `get_shark_info`、`change_shark_locale` | – | 官方 [已验证] |
| 22 | 环境切换与堡垒 | FAT/UAT/PROD 切换后 relaunch（只在非 production 构建中允许）；打堡垒标记 | `changeEnv`、`toggleBaolei` 两个处理器 | `change_env`、`toggle_baolei`（都有 `Rt` 校验） | – | 官方 [已验证] |
| 23 | 杂项系统能力 | 下载（`sender.downloadURL`）、打开安装目录或数据目录、用系统浏览器打开、右键菜单、图片操作、本地提示音、视频回退 | 若干 `ipcMain.on` | `download_file`、`open_install_dir`、`open_data_dir`、`open_with_system_browser`、`pop_context_menu`、`image_option`、`set_local_voice`、`video_player_fallback`、`common_web_option`、`open_ai_window`；桥接 `downloadFile`、`setLocalVoice`、`openExtraWindow` | shell、Menu | 官方 [已验证] |
| 24 | DAL 解密 / 7za | `node-vampire-dal/bin/DalDecrypt_{mac,linux,win.exe}`、`node-vampire-p7zip/bin/*/7za` | 主进程无引用 | – | 外部可执行文件 | 官方传递依赖，[已验证] 打包了但未使用；asar 完整性与实际字节不符（BRIEF） |
| P1 | 插件 bootstrap（仅 Win） | 见 §6.2 | `win/extracted/app/trip-vendor-bootstrap.cjs` | – | CDP、命名管道、spawn | **插件** [已验证] |

## 4. IPC 与桥接总表

### 4.1 contextBridge（11 次暴露 / 9 个名字 / 45 个成员）[已验证，来源 mac-main-facts.tsv 的 context-bridge-api 段]
| API | 所在 preload（位置） | 成员 | 底层 |
|---|---|---|---|
| `appBridge` ×3 | im.js:1:7705、index.js:1:7691、main.js:1:7706 | `dbQuery`→invoke `execute_db`；`downloadFile`→send `download_file`；`getAllLoginCookies`、`getLoginCookie`、`getCacheAccountList`→invoke；`netFetch`→invoke `net_fetch`；`openExtraWindow`→send；`setLocalVoice`→invoke；通用 `invoke`、`send`、`receive`（channel 由调用方传入，属于动态 channel） | ipcRenderer |
| `screenshots` | screenshots.js:1:51 | `cancel`、`captureWindow`、`getAllSettings`、`imageLoaded`、`off`、`ok`、`on`、`ready`、`reset`、`save`、`selectionReady`、`updateToolSettings` | 统一使用 `` `SCREENSHOTS:${e}` `` 前缀 |
| `postImMessage` / `setIMMessageHandler` / `reconnectImPort` / `getImPortStatus` / `postMainMessage` | im.js:1:8472-8936 | 函数本身，无子成员 | MessagePort |
| `postPortMessage` / `setMainMessageHandler` | main.js:1:8060-8145 | 函数本身 | MessagePort |

- `web.js`（22.6KB）没有调用 contextBridge，只用 `ipcRenderer.on/send` 处理 `open_finder_window`、`close_finder_window`、`found_in_page`（web.js:98:2547-2625）。它给远程页面注入了哪些全局对象 [未知]。
- 三个 preload 的 `appBridge` 结构相同，因此**每个使用 index.js 的窗口**都能读取全部账号的 Cookie 并执行 SQL。远程页面能否拿到 appBridge 见 SEC-07。

### 4.2 主进程 channel（93 项枚举 `y`，S:123）[已验证]
**ipcMain.handle（33 个）**：`SCREENSHOTS:getAllSettings`、`get_app_config`、`get_shark_info`、`change_env`*、`toggle_baolei`*、`get_user_preferences`、`get_login_cookie`、`get_all_login_cookies`、`get_cache_account_list`、`get_current_user_info`、`get_account_list`、`login_success`、`net_fetch`、`get_web_info_list`、`flash_main_window`、`request_arch_guide`、`get_stay_duration`、`get_launch_count`、`get_cache_data`、`set_local_voice`、`get_cache_url_list`、`common_web_option`、`get_cur_version_info`、`get_update_info`、`check_new_version`、`update_new_version`、`install_new_version`、`get_im_channel_port`、`get_main_channel_port`、`execute_db`*、`recognize_image`、`recognize_image_buffer`、`spell_check`。（标 * 的有 `Rt()` sender 校验。）

**ipcMain.on（37 个）**：`SCREENSHOTS:{cancel,imageLoaded,ok,updateToolSettings}`、`change_shark_locale`、`clear_user_store`、`change_user_preferences`、`remove_cache_password`、`sort_account_list`、`login_failure`、`add_account`、`change_account`、`logout`、`main_view_changed`、`open_with_system_browser`、`arch_guide_action`、`open_window`、`download_file`、`pop_context_menu`、`open_install_dir`、`open_data_dir`、`open_screen_shot_panel`、`set_cache_data`、`image_option`、`video_player_log`、`video_player_fallback`、`clear_cache_url_list`、`open_ai_window`、`open_extra_window`、`close_extra_window`、`download_new_version`、`send_broadcast_event`、`unread_message_count`、`reply_timeout`、`new_message`、`jump_to_conversation`、`cancel_recognition`。

**按窗口注册的 `webContents.ipc.on/handle`（22 处）**：例如 `force_focus`（S:2372），以及 `close_window`、`show_window`、`window_loaded`、`window_full_screen`、`find_in_page`、`stop_find_in_page`、`open_finder_window`、`close_finder_window`、`window_height_change`、`web_view_changed` 等 [推断：channel 名属于 `y` 枚举中未出现在全局注册里的那部分]。

**只从主进程发往渲染端的事件**：`paste_screen_shot`、`screen_shot_ready`、`update_status_change`、`arch_guide_*`、`notify_info`、`found_in_page`、`im_process_started`、`send_main_channel_port`、`clear_message_by_user`、`get_current_messages`、`begin_to_login`、`refresh_data` [推断]。

**动态 channel**：rea 统计到 36 次动态 channel 操作，来源有三处：① `appBridge.invoke/send/receive(e, ...)`，channel 来自渲染层参数，preload 先做白名单判断 `!(!C(o)||!y(e,o))`（im.js:1:5694），白名单具体内容 [未知]；② `` `SCREENSHOTS:${e}` ``；③ web.js 中的 `A`。rea 的其他计数：IPC 操作 106 次、字面量 channel 32 个、渲染端发送 89 次、未配对的字面量发送 53 次。未配对多半是因为主进程使用 `y.xxx` 枚举，rea 没能把枚举还原成字面量 [推断]。

### 4.3 utility 进程消息
- imsdk：`init_im_sdk`、`append_port`、`remove_port`、`close_port`、`destroy`（`PROCESS_MESSAGE_NAME`），另有 `PORT_MESSAGE_NAME`（constant 中的 `a`，内容 [未知]）。
- OCR、拼写检查：通过 `parentPort` 收发请求，worker 带 ready promise，退出后重新拉起（S:1820、S:2518）。

## 5. 后端接口与域名

> 对照结果：`docs/api/inventory.json` 中出现了 `m.ctrip.com`（46 次）、`imvendor.ctrip.com`（1 次）、`vbooking.ctrip.com`（2 次）、`webresource.c-ctrip.com`（2 次）；下表「inventory」列为 ✗ 的都是没有收录的。

### 5.1 生产环境（主进程，8 个）
| 域名 / 路径 | 用途 | 位置 | inventory |
|---|---|---|---|
| `m.ctrip.com/restapi/soa2` | SOA2 网关（国内），`Vo.PROD` | S:487 | ✓ |
| `cbooking.trip.com/restapi/soa2` | SOA2 网关（国际站），`ou.PROD` | S:487 | ✗ |
| `imvendor.ctrip.com/main` | IM 商家页及跳转判定（`Co.PROD`） | S:1777 | ✓ |
| `vbooking.ctrip.com`：`/qconfig/jsonp`、`/ivbk/accountV2/shark/getLangDump`、`/ivbk/accountV2/promotionalPage` | 配置、多语言、登录页推广 | S:2285、S:1755 | 域名 ✓，三个路径 ✗ |
| `static.tripcdn.com` | 静态资源 | grep URL 段 | ✗ |
| `file.tripcdn.com/files/8/tour_vbkadminuser/vbk-electron-v27/<ver>` | ares 的 feedUrl/distUrl（packageVersion.json） | 安装目录 dist | ✗ |
| `pic.c-ctrip.com/picaresonline/infosec/captcha/...` | 验证码 loading 图 | grep URL 段 | ✗ |
| `docs.c-ctrip.com/files/8/tour_vbkadminuser` | 下载或文档资源 | grep URL 段 | ✗ |

### 5.2 测试环境（主进程，11 个，全部 ✗）
`gateway.m.fws.qa.nt.ctripcorp.com`、`gateway.m.uat.qa.nt.ctripcorp.com`（SOA2 FAT/UAT），`www.fws.qa.nt.tripqate.com`、`www.uat.tripqate.com`（国际 SOA2），`imvendor.fat44.qa.nt.ctripcorp.com`、`imvendor.uat.qa.nt.ctripcorp.com`，`vbooking.ctrip.fat29/fat30/fws/uat.qa.nt.ctripcorp.com`（4 个），`static.fws.qa.nt.ctripcorp.com`。另外 `ignore-connections-limit` 的取值在测试环境中加上了 `.qa.nt.ctripcorp.com`，生产环境中加上了 `.trip.cn`（mac-main-grep）。详见 PRI-04。

### 5.3 IM SDK 内置（15 个）[已验证，来源 s-node-imclient-core/main.js]
- 生产（5 个）：`im.ctrip.com`、`im.trip.com`（`/ws-xmpp/`）、`im3.ctrip.com`、`m.trip.com`、`webresource.c-ctrip.com`（✓）。
- 测试或内网（10 个）：`im.fws/uat.qa.nt.ctripcorp.com`、`im3.fws/uat.qa.nt.ctripcorp.com`、`muc.im.fws.qa.nt.ctripcorp.com`、`ctriperim.ctripcorp.com`、`muc.ctriperim.ctripcorp.com`、`im3.ctripcorp.com`、`conf.ctripcorp.com`、`apigateway.ctripcorp.com`。
- 除 webresource 外，其余 14 个都不在 inventory 中，**WebSocket 地址 `wss://im*.…/ws-xmpp/` 也没有收录**，这是重构 IM 通道时必须补上的一项。

### 5.4 第三方与本地（2 个）
- `raw.githubusercontent.com/X3ZvaWQ/paddleocr.js/main/assets`（个人仓库）和 `raw.githubusercontent.com/PaddlePaddle/PaddleOCR/.../ppocrv5_dict.txt`：OCR 模型与字典，下载时关闭 TLS 校验（S:1808），见 SUP-02。✗
- `127.0.0.1:7777`：开发服务器（只在开发模式使用）。✗（不需要收录）
- 其余的 reactjs.org、github issues 都是库内置的报错链接，不计入。

**合计 36 个域名，inventory 收录 4 个，未收录 32 个**（主进程 17 个 + IM SDK 14 个 + raw.githubusercontent 1 个；127.0.0.1 不计入）。

## 6. Mac 与 Windows 的差异；插件 bootstrap

### 6.1 官方代码差异 [已验证]
- `diff facts/mac-main-grep.txt facts/win-main-grep.txt` 只多出 4 行，全部来自插件：`appendSwitch('remote-debugging-address','127.0.0.1')`、`appendSwitch('remote-debugging-port', String(port))`、`appendSwitch('site-per-process')`、`spawn(`。官方的 7 个开关、16 处 webPreferences、URL 列表在两端完全相同。
- 字节对比：`preload/*.js`（5 个）、`ocr-worker.js`、`spell-check-worker.js`、`main-DdiqF_NH.js` **完全一致**；`index.js` 为 276,969 B 对 275,546 B，`imsdk.js` 同为 6,413 B 但内容不同，差异只在 `constant-B2KHNj0H.js` 与 `constant-2w9sXoOv.js` 的 chunk 名以及压缩器生成的变量名（例如 `m.`/`w.`、`L`/`C`）。结论：**同一份源码按平台分别构建，平台差异全部在运行时判断**（MNT-03）。
- 运行时平台分支（S 行号）：
  - S:115：`ze={isWindows,isMacOS,isLinux}`。
  - S:1474：Mac 截图窗隐藏红绿灯 `setWindowButtonVisibility(false)`。
  - S:1493：Mac 检查屏幕录制权限，没有权限时提示。
  - S:1497：Mac 全屏时截图需要先退出全屏、隐藏主窗口并移到屏幕外（10000,10000）。
  - S:1566-1583：Mac 托盘用模板图并 `setTitle`，再加 `dock.setBadge`；Win 用托盘闪烁（500ms）加任务栏 overlay。
  - S:1626：Alarm 窗口位置，Win 在左上，Mac 在右下。
  - S:1768-1772：**仅 Win**，检测 `NUL` 设备是否健康（打开 `NUL`，查询 `HKLM\SYSTEM\CurrentControlSet\Services\Null` 注册表），供 utility 进程的 stdio 判断使用（`nul_check`/`reg_execSync`）。
  - S:2464：Win 登录窗不可调整大小。
  - S:2544：Win 调用 `setAppUserModelId`，Win7（6.1）或配置要求时关闭硬件加速。
  - S:2555：非 Mac 平台在所有窗口关闭后退出。
  - S:2556/2569：Win 的协议唤起走 `second-instance`，Mac 走 `open-url`。
  - S:2790：日志分隔符。
- Mac 独有资源：`Contents/Resources/plugin/captureTool`（70KB），主进程中找不到引用（[未知]，可能是旧版截图工具的残留）。Win 独有：`DalDecrypt_win.exe`、`7za.exe`、`elevate.exe`（SUP-06）。

### 6.2 插件 bootstrap（只出现在 Windows）[已验证，`win/extracted/app/trip-vendor-bootstrap.cjs` 共 488 行、51,550 B]
1. **入口劫持**：`package.json.main` 改成 `trip-vendor-bootstrap.cjs`；原入口保存在 `companion-vendor-original-main.json`（`{"main":"dist-electron/main/index.js"}`），最后执行 `require(path.resolve(__dirname, config.main))`，并检查路径不是绝对路径且不含 `..`（L482-487）。
2. **改 Chromium 开关**（L313-321）：追加 `site-per-process`，抵消官方的 `disable-site-isolation-trials`（注释写明原因：防止登录 iframe 被读取，并修正 Chromium 118 的 Origin 缺失问题）；先移除再追加 `remote-debugging-address=127.0.0.1` 与 `remote-debugging-port=0`，由操作系统分配随机端口。CDP 没有鉴权，见 PLG-01。
3. **伴随进程**（L425-457）：`app.whenReady()` 之后 `spawn(resources/TripVendorCompanion/旅游商家助手.exe, --vendor-owner=<pid> --vendor-debug-port=auto --vendor-progress=<pipe>)`，`shell:false`、`windowsHide`、`stdio:ignore`，并删除 `ELECTRON_RUN_AS_NODE`、`ELECTRON_NO_ASAR`、`NODE_OPTIONS`、`PSModulePath`；失败后按 1s/3s/10s 重试三次。
4. **进度通道**：命名管道 `\\.\pipe\tsim-companion-progress-<pid>-<16B 随机>`，阶段依次为 host-ready、start、files-verified、transport-ready、target-found、page-verified、native-ready、panel-mounted。
5. **UI 注入**：对 `file:` 页面调用 `executeJavaScriptInIsolatedWorld(7301, …)` 绘制加载指示器；`maximizeMainWindowOnOpen` 在 `browser-window-created` 时把标题为 `Main window` 的窗口最大化一次。
6. **能力边界**：`CDP_METHODS` 白名单包括 `Target.getTargets/attachToTarget/...`、`Page.enable/getFrameTree` 等；遥测字段包括 translation、composer、draft、tokens（input/output/cached/reasoning），说明伴随程序通过 CDP 操作 IM 输入框，提供 AI 翻译和代发功能 [推断]。遥测有 sanitize 白名单（L124-195）。
7. 注释提到另有一份 `macos-vendor-bootstrap.cjs`，但**当前 Mac 1.2.13 包的 main 是官方入口，签名与公证校验都通过，没有被注入**（PLG-04）。

## 7. 结构性架构问题 Top 10
（只写架构层面的判断；安全与稳定性细节引用 03-defects 的编号，不重复展开。）

| # | 问题 | 证据 | 关联缺陷 |
|---|---|---|---|
| 1 | **安全边界由页面自己承担**：8 处 webPreferences 关闭 webSecurity，加上全局 `disable-site-isolation-trials`，再剥离服务端安全头，同源策略基本失效 | §2.1 表；mac-main-grep 的 appendSwitch；S:2372 `onHeadersReceived` | SEC-01/02/03 |
| 2 | **IPC 是一个特权大桥，缺少授权模型**：70 个全局处理器中只有 3 个校验 sender；`appBridge` 在三个 preload 中暴露 `dbQuery`（SQL 透传）、`getAllLoginCookies`、`netFetch`（不受 CORS 限制）、`downloadFile`（`sender.downloadURL(任意 URL)`）；还有动态 `invoke/send/receive` | §4.1、§4.2；`toggleBaolei` 处理器后紧跟 `downloadFile` 处理器 | SEC-07 |
| 3 | **TLS 信任分散且多处关闭**：非 PROD 设置 `ignore-certificate-errors`（S:2546）；OCR 下载 `rejectUnauthorized:false`（S:1808）；IM SDK 在证书错误时把 `NODE_TLS_REJECT_UNAUTHORIZED` 设为 '0'，影响整个 utility 进程 | §3 #6、#13 | SEC-06、SUP-02 |
| 4 | **代码更新链没有完整性保护**：渲染层 dist.zip 由 ares 热替换到 asar 之外的 `app.asar.unpacked/dist`，强制 HTTP、不验签；安装包更新的 `app-update.yml` 中 `url:''`，运行时注入；asar 完整性不起作用 | S:1505-1545；app-update.yml | SUP-01/03/04 |
| 5 | **凭据与本地数据没有接入系统密钥库**：缓存密码和 ticket 写入 electron-store，SQLite 与 Cookie 都不加密；safeStorage/keytar 引用为 0 | §3 #7、#10、#11 | PRI-01/02 |
| 6 | **单体 bundle 加单例管理器**：主进程 `index.js` 277KB 单文件，内含约 20 个 `static get instance` 单例（窗口、托盘、更新、DB、OCR、拼写、Shark 等），通过 93 个蛇形命名的字符串 channel 互相耦合，没有运行时 schema；产物压缩且没有 source map | S:123 枚举；S:491/1566/1692/1820/2518 | MNT-01 |
| 7 | **IM 链路跳转三次、重连机制叠加**：网络连接在 utility 进程，消息通过 MessagePort 到渲染层，再由渲染层通过 `dbQuery` 回到主进程写 DB；重连由三方叠加（xmpp.js 的 `Reconnect` 固定 1s、SDK ping 计数到 12、渲染端 `reconnectImPort`），没有退避；守护失效后每秒重启 | §2.2、§3 #5/#6 | STA-01/02 |
| 8 | **多账号依赖持久分区的 BrowserView，没有上限**：每个 buid 一个 `persist:` 分区；V1、V2 动态创建；BrowserView 在后续 Electron 版本中已被弃用 | S:1974、S:2370；`syncSessionProxy` | STA-05、SEC-11 |
| 9 | **用全局开关绕过问题**：`disable-gpu`、`disable-gpu-sandbox`、`disable-software-rasterizer`、`disable-http2`、对携程域名 `ignore-connections-limit`，加上粘性的 GPU 降级和 Mac 仅 x86_64（`config.arch:arm64` 与实际不符，需要 archGuide 窗口补救） | mac-main-grep；S:2544/2554；§1.1 | SEC-10、STA-06/08 |
| 10 | **依赖边界失控**：服务端 `node-vampire-*` 约 50 个包（DAL、p7zip、redis、qmq、thrift）连同 DalDecrypt、7za 原生可执行文件一起打包却没有使用；同时存在 better-sqlite3 与 sqlite3 两套驱动；heapdump 进入生产包；渲染层依赖和主进程依赖写在同一个 package.json；asar 中有 45,959 个文件 | §1.2；rea summary `relevant_files` | SUP-05、STA-07、MNT-02/04 |

### 7.1 主进程模块与 Tauri/Rust 的对应关系（供重构参考）
| 官方模块 | Tauri 2 / Rust 对应实现 | 难度 |
|---|---|---|
| 窗口管理（14 个窗口） | `WebviewWindowBuilder`，用 `label` 区分；每个窗口配置 capability | 低 |
| BrowserView 业务标签（V2） | 多 webview：`Window::add_child` + `WebviewBuilder`（unstable 特性），或改成单 webview 加前端路由 | **高**（多 webview 的 API 尚不稳定） |
| `persist:<buid>` 多账号分区 | `WebviewBuilder::data_directory`（Win/Linux）；macOS 需要 `data_store_identifier`（macOS 14+） | **高**（各平台不一致，WKWebView 的 Cookie 隔离受系统版本限制） |
| 托盘、菜单、Dock 角标 | 内置 `tray-icon`、`menu`；`Window::set_badge_count` / `set_badge_label`（macOS）；Win overlay 使用 `set_overlay_icon` | 低 |
| 闪烁与 flashFrame | `request_user_attention` | 低 |
| 自研通知窗 notifier/alarm | 继续用透明置顶 webview 窗口，或 `tauri-plugin-notification` | 中 |
| IM SDK（XMPP over WSS，utility 进程） | Rust 的 `tokio-tungstenite` 加 XMPP 实现（`tokio-xmpp` 或自写 framing），或者保留 JS SDK 放在隐藏 webview / sidecar Node 中 | **高**（私有 XMPP 扩展、muc、重连语义需要逐项对齐） |
| MessagePort 通道 | Tauri `Channel<T>` / event，加上 Rust 侧的 `tokio::sync::broadcast` | 中 |
| better-sqlite3 + drizzle | `rusqlite`（bundled）或 `sqlx`；drizzle 的 SQL 迁移可以直接复用 `refinery` / `rusqlite_migration`；`execute_db` 透传接口应改成有类型的 command | 中 |
| electron-store | `tauri-plugin-store` | 低 |
| 账号密码与 ticket | `keyring` crate（Keychain、Credential Manager），对应 PRI-01 | 低 |
| Cookie 读取 `get_all_login_cookies` | `Webview::cookies()` / `cookies_for_url`（Tauri 2.x 新增） | 中 |
| `net_fetch` 主进程代理请求 | `reqwest` 或 `tauri-plugin-http`（带域名白名单 scope） | 低 |
| webRequest 拦截与改写响应头 | 没有直接等价物；可用自定义协议 `register_uri_scheme_protocol` 代理，或改由服务端/网关处理 | **高** |
| 截图 node-screenshots | `xcap` 或 `screenshots` crate，加透明覆盖窗；macOS 屏幕录制权限 | 中 |
| OCR paddleocr + onnxruntime | `ort` crate（ONNX Runtime）加 PP-OCRv5 模型；模型随包内置或自有 CDN 并做哈希校验 | 中高 |
| 拼写检查 worker | Rust 线程加 `hunspell-rs` / `zspell`，或使用系统拼写服务 | 中 |
| 热更新 ares dist.zip | 不建议沿用；改为 `tauri-plugin-updater` 整包更新（强制签名） | 中（属于流程变更） |
| electron-updater | `tauri-plugin-updater`（minisign 签名） | 低 |
| 崩溃上报 | `sentry` + `sentry-rust-minidump`，或接 Ctrip 自有上报 | 中 |
| UBT 与 clientid | `machine-uid` / 自生成 UUID 存入 store；UBT 继续在前端 | 低 |
| 协议唤起 `vbookingChat://` | `tauri-plugin-deep-link` 加 `tauri-plugin-single-instance` | 低 |
| 单实例锁 | `tauri-plugin-single-instance` | 低 |
| 全局快捷键 | `tauri-plugin-global-shortcut` | 低 |
| 打开系统浏览器与目录 | `tauri-plugin-opener` / `tauri-plugin-shell` | 低 |
| 下载 | `reqwest` 流式下载加进度事件 | 低 |
| 日志 | `tauri-plugin-log` | 低 |
| Shark 多语言与 qconfig | `reqwest` 拉取后缓存到 store | 低 |
| DalDecrypt / 7za | 去掉；确实需要时用 `sevenz-rust` | 低 |

### 7.2 已验证 / 推断 / 未知 汇总

**已验证**
- 14 个 BrowserWindow、2 个 BrowserView 及它们各自的页面和 preload；3 个 utilityProcess 与 2 组 MessageChannelMain。
- 93 项 channel 枚举，70 个全局 ipcMain 处理器，22 处按窗口注册的 ipc；11 次 contextBridge 暴露共 45 个成员；3 处 `Rt()` sender 校验。
- 7 个官方 Chromium 开关在两端一致；Windows 多出的 3 个开关和 `spawn` 都来自插件 bootstrap。
- preload 与 worker 在两端字节一致；`index.js` 和 `imsdk.js` 的差异只在 chunk 哈希和压缩后的标识符。
- IM 通过 xmpp.js 以 WebSocket（`/ws-xmpp/`）连接；在某些条件下 SDK 会设置 `NODE_TLS_REJECT_UNAUTHORIZED='0'`。
- OCR 模型来自 raw.githubusercontent，下载时 `rejectUnauthorized:false`。
- 热更新信息来自 packageVersion.json（aresVersion 1.2.18，file.tripcdn.com）。
- DalDecrypt 与 7za 被打包，但主进程没有引用。

**推断**
- 构建使用 vite-plugin-electron 加 Electron Forge。
- `@ctrip/node-electron-hotfix` 和 `@ctrip/electron-notification` 没有被直接使用。
- `onHeadersReceived` 剥离 X-Frame-Options/CSP，用来配合 iframe 白名单（细节见 SEC-03）。
- electron-updater 在运行时通过 setFeedURL 指向 file.tripcdn。
- 按窗口注册的 ipc channel 就是 `y` 枚举中不在全局注册里的那部分。
- 插件伴随程序通过 CDP 操作 IM 输入框，提供 AI 翻译。

**未知**
- `appBridge.invoke/send/receive` 的 channel 白名单 `y(e,o)` 的具体内容。
- web.js 向远程页面注入了哪些全局对象。
- `PORT_MESSAGE_NAME` 的枚举值。
- 渲染层第 25 个页面由谁加载。
- Mac `Resources/plugin/captureTool` 的用途与归属。
- `config.arch:arm64` 与实际 x86_64 产物不一致的原因。

### 7.3 与既有结论的对照
| 既有结论（BRIEF / 历史文档） | 本次结果 | 标记 |
|---|---|---|
| 14 个 BrowserWindow 加 2 个 BrowserView | 逐个找到构造行，并对应到页面和 preload | 复核一致 |
| 多处 `webSecurity:false` | 精确统计为 7 处显式关闭、1 处条件关闭（只有 setting 页开启） | 复核一致，数量已细化 |
| `ignore-certificate-errors` 是 Mac 版开关 | 只在 `env!="PROD"` 时追加（S:2546），两端相同 | 冲突（需要修正为条件开关） |
| IM 通过 MessagePort 与主进程通信 | 实际是三方结构：IM 在 utilityProcess 中，主进程分发端口，渲染端直接连 IM；另有一条独立的主通道端口 | 复核一致，并补充了结构 |
| IM 子进程是 fork 出来的 | 用的是 `utilityProcess.fork`，不是 `child_process.fork`；`exec(` 实为 `RegExp.exec` | 新发现 |
| appBridge 暴露 dbQuery、getAllLoginCookies、downloadFile 等 | 共 11 个成员，分别出现在 3 个 preload 中；还有动态的 `invoke/send/receive` | 复核一致，并补全 |
| OCR 模型来自 raw.githubusercontent.com | 来自个人仓库 X3ZvaWQ/paddleocr.js，下载时还关闭了 TLS 校验 | 复核一致，并发现新问题 |
| 插件注入 remote-debugging 和 site-per-process | 来自 bootstrap L313-321，端口为 0（随机），并拉起伴随程序 exe | 复核一致 |
| 两端代码相同 | preload 和 worker 字节一致；index.js 只有构建产物层面的差异 | 新发现（有字节证据） |
| rea 统计的窗口和处理器数量 | rea 计为 0 和 5，原因是 electron 被重命名后识别失败 | 新发现（工具局限） |

## 8. 附录：用到的命令
```bash
# 事实文件
cat ~/tools/rea-work/facts/mac-main-grep.txt; diff facts/mac-main-grep.txt facts/win-main-grep.txt
python3 -I -c "import json;print(json.load(open('facts/mac-main-summary.json'))['electron'])"
awk -F'\t' '/^## /{s=$0;next} s~/context-bridge-api|ipc-handler/' facts/mac-main-facts.tsv
# 窗口、页面、preload
grep -nE 'new f\.Browser(Window|View)' facts/mac-main-split.txt
grep -noE 'pages/[a-zA-Z_-]+' facts/mac-main-split.txt | sort -t: -k2 -u
grep -oE '(Zh|tp|np|sp|ko|Ep|Gp|Hp|Kp)=D\.join\(__dirname,"[^"]+"' facts/mac-main-split.txt
# IPC
grep -oE '\.ipcMain\.[a-zA-Z]+\([^,)]{1,70}' facts/mac-main-split.txt | sort | uniq -c
sed -n '123p' facts/mac-main-split.txt        # channel 枚举 y（93 项）
# 模块标记（utilityProcess、MessageChannelMain、Tray、协议、更新、TLS）
grep -noE 'utilityProcess\.fork\(|MessageChannelMain|new f\.Tray|setAsDefaultProtocolClient|autoUpdater|rejectUnauthorized|session\.fromPartition' facts/mac-main-split.txt
# IM SDK
python3 -I arch/snip.py mac/extracted/app/node_modules/@ctrip/s-node-imclient-core/main.js 160 2 'ws-xmpp' 'TLS_REJECT_UNAUTHORIZED' 'pingInterval = setInterval'
# Mac/Win 字节对比
for f in main/*.js preload/*.js; do cmp -s mac/.../$f win/.../$f && echo same || echo DIFF; done
# 插件 bootstrap
grep -nE 'appendSwitch|spawn\(|createServer|executeJavaScript|require\(' win/extracted/app/trip-vendor-bootstrap.cjs
# 原生可执行文件与更新配置
find mac/extracted/app/node_modules -iname '*daldecrypt*' -o -iname '7za*'
cat "/Applications/旅游商家桌面版.app/Contents/Resources/app-update.yml"; python3 -I -c "...packageVersion.json"
# inventory 对照
python3 -I - <<< "s=open('docs/api/inventory.json').read(); print(s.count('cbooking.trip.com'), ...)"
```

> 说明：`S:` 行号只适用于 Mac 的 split 文本。Windows 中的同一段代码可以用相同的 grep 模式在 `facts/win-main-split.txt` 中找到（行号会偏移约 940 行，因为前面多了插件 bootstrap 的 488 行和 React 运行时的拆行差异）。原始 文件:列 锚点见 `~/tools/rea-work/defects/anchors.txt`。
> 范围：本文只写主进程、preload 和 worker；渲染层（25 个页面、46 个 chunk）的架构见同目录的其他报告。
