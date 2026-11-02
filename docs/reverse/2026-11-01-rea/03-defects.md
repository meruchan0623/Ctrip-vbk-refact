# 03 · 官方 Electron 客户端潜在缺陷专项检测（rea 静态证据）

> 2026-11-01 · 只读检测：没有执行目标里的任何脚本或二进制，也没有在目标目录下运行 node/npm；仓库代码未改动。
> 检测对象：macOS `/Applications/旅游商家桌面版.app`（1.2.13，`app.asar` sha256 `a2306de0…1dcb`）、Windows `~/Downloads/vbk-electron`（1.2.12，`app.asar` sha256 `f3f60007…614e`，已被插件改写）。
> 中间产物统一放在 `~/tools/rea-work/defects/`；rea 命令原文见附录 A。
> 标注约定：**[事实]** 表示已由 rea 输出或字节级检索验证；**[推断]** 表示根据代码语义推出、未经运行验证；**[未知]** 表示静态手段无法确认。
> 密钥类值只保留前 4 位，其余写成 `***`。

## 1. 概述与统计

### 1.1 结论速览

- 本次共登记 **44 个问题**：P0 1 个、P1 11 个、P2 18 个、P3 14 个。
- 唯一的 P0 是**渲染层热更新链路**（官方代码，两个平台都有）：
  - 下载地址被**强制从 https 改成 http**，用的是 `require("http")`；
  - zip 包没有任何签名或哈希校验，解压到 `userData/dist`；
  - 之后所有本地特权页面都从这个目录加载，drizzle 迁移 SQL 也从这里读取。这些页面带有能读取 ticket 和查询数据库的 preload 桥。
  - 后果：同一网络中的中间人可以持久地向客户端注入代码，并拿走所有账号的登录态。
- P1 集中在三类问题。
  - **安全基线全面放开**：
    - 7 处字面量 `webSecurity:false`，另有 1 处条件式；
    - 无条件关闭站点隔离；
    - 本地页面 CSP 形同虚设，并且客户端会剥掉白名单域名响应里的 CSP 和 XFO；
    - fuses 没有加固，Mac entitlements 允许注入动态库；
    - 运行时停在 Electron 27 / Chromium 118。
  - **完整性**：
    - OCR 和拼写模型下载时关闭了 TLS 校验，而且来源是个人 GitHub 仓库；
    - Windows 三个 PE 文件都没有签名，自动更新也不验签。
  - **数据与稳定性**：
    - 账号密码和 ticket 明文写在 `config.json` 里；
    - IM 子进程崩溃守护的计数器每次都会清零，结果会每秒无限重启。
  - 插件这一侧有 1 个 P1：本机 CDP 调试端口没有鉴权。
- 历史缺陷文档（`docs/02-current-client-defects.md`）共 18 条可核对结论，复核结果：
  - **一致 14 条**；
  - **冲突 1 条**：当前 Mac 包签名和公证都有效，**没有被插件注入**；
  - **静态无法复核 3 条**：都是运行时性能样本。
- 本报告另有 **30 个新发现**，历史文档没有覆盖。

### 1.2 严重度 × 维度计数

| 维度 | P0 | P1 | P2 | P3 | 合计 |
| --- | --- | --- | --- | --- | --- |
| 1 Electron 安全基线（SEC） | 0 | 6 | 5 | 3 | 14 |
| 2 供应链与完整性（SUP） | 1 | 2 | 2 | 1 | 6 |
| 3 敏感信息与隐私（PRI） | 0 | 1 | 2 | 3 | 6 |
| 4 稳定性、性能与资源（STA） | 0 | 1 | 6 | 3 | 10 |
| 5 可维护性（MNT） | 0 | 0 | 1 | 3 | 4 |
| 6 插件注入（PLG） | 0 | 1 | 2 | 1 | 4 |
| **合计** | **1** | **11** | **18** | **14** | **44** |

按归属统计：官方 40 个（含 SUP-04 对「篡改」一说的更正）、插件 4 个（PLG-01～04，其中 PLG-02 属于两者交互，PLG-04 是事实更正）。按平台统计：两端共有 34 个、仅 Mac 5 个、仅 Windows 5 个。

### 1.3 方法与边界

- 用到的 rea 能力：
  - 主进程证据：Mac `ev_0d0218b4…`、Win `ev_a689526a…`。这两份是此前用 `analyze-javascript-application --source-paths-json` 生成的 11 个主进程/preload 文件分析；
  - `inspect-analysis-view` 的 `javascript-facts` 投影：Mac `ev_09aad3be…`、Win `ev_e339a25b…`。覆盖 IPC 通道 106 个、处理器 17 个、contextBridge 11 个、native-addon 10 个；
  - 以及 `inspect-electron-fuses`、`inspect-signature`、`inspect-plist`、`inspect-macho`、`inspect-pe-certificates`、`inspect-pe-load-config`、`inspect-sqlite-database`。
- **rea 静态计数偏低，不能当作「不存在」的证据。**
  - rea summary 记录的是 `browser_windows: 0`、`main_handlers: 5`、`sender_validation_observations: 3`；
  - 对同一文件做字节检索的结果是：`new f.BrowserWindow` 14 处、`new f.BrowserView` 2 处、`ipcMain.on` 37 处、`ipcMain.handle` 33 处，另有 `webContents.ipc.*` 23 处；
  - 原因是 rea 没能把压缩后的别名 `f=require("electron")` 下的大部分调用识别为 Electron API，这与它自己写明的局限一致（「missing findings do not establish absence」）。
  - 所以本报告的 Electron 结论以「rea facts + 字节偏移检索」双重证据为准。
- 证据位置格式：`平台:相对路径 L行@字节偏移`。主进程和 preload 都压缩成了少数几行，所以以字节偏移为主（锚点表见 `~/tools/rea-work/defects/anchors.txt`）。Mac 与 Win 的 `index.js` 除压缩变量名外逻辑一致：preload 和 worker 共 9 个文件 0 差异。下文只给 Mac 偏移，Win 偏移见锚点表。
- 主机侧的验证（只读）：
  - `codesign --verify --deep --strict`；
  - `spctl -a -vv`；
  - 本机 `~/Library/Application Support/vbk-electron/` 下配置文件的**结构**和日志关键字**计数**。只看键名、类型和长度，没有读取或输出任何具体值。

## 2. 问题清单总表

「复核」列：一致 = 与历史文档一致；冲突 = 与已有结论冲突；新 = 新发现。

| ID | 标题 | 归属 | 平台 | 严重度 | 复核 | 主证据 |
| --- | --- | --- | --- | --- | --- | --- |
| SUP-01 | 渲染层热更新强制降级 HTTP、无签名/哈希校验，且解压后作为特权本地页面加载 | 官方 | 两端 | P0 | 新 | mac:main/index.js L51@162280、@163365、L87@272967 |
| SEC-01 | 7 处字面量 + 1 处条件式 `webSecurity:false`（含远程 BrowserView） | 官方 | 两端 | P1 | 一致（补 1 处） | index.js@148709…263391、@254551 |
| SEC-02 | 无条件 `disable-site-isolation-trials` | 官方（Win 被插件覆盖） | 两端 | P1 | 一致 | index.js L87@273818 |
| SEC-03 | 本地页面 CSP 全通配；对白名单域响应剥离 CSP/X-Frame-Options | 官方 | 两端 | P1 | 新 | dist/src/pages/*/index.html；index.js L87@255155/@255520 |
| SEC-04 | Electron fuses 未加固（RunAsNode/NODE_OPTIONS/--inspect 开，asar 完整性与 OnlyLoadAppFromAsar 关，Cookie 加密关） | 官方 | 两端 | P1 | 新 | ev_a4a3c4a6…、ev_c7820928… |
| SEC-05 | Mac 硬化运行时例外：允许 DYLD 环境变量、关闭库验证、允许未签名可执行内存 | 官方 | Mac | P1 | 新 | ev_530ea954… |
| SEC-11 | Electron 27.3.11 / Chromium 118.0.5993.159 过旧 | 官方 | 两端 | P1 | 一致 | Electron Framework / exe 内 UA 串 |
| SUP-02 | OCR/拼写模型下载 `rejectUnauthorized:false`，来源为个人 GitHub 仓库，无哈希校验 | 官方 | 两端 | P1 | 新 | index.js L51@195151/@195329、L87@267680 |
| SUP-03 | Windows 主程序、卸载程序、elevate.exe 均无 Authenticode；更新不验签 | 官方 | Win | P1 | 新 | ev_d43a0daa…、ev_8ef03f92…、ev_e0858474… |
| PRI-01 | 账号密码与 bticket 明文存储于 electron-store `config.json` | 官方 | 两端 | P1 | 新 | index.js L39@40910、L52@224146/@227736；本机结构实测 |
| STA-01 | IM utilityProcess 崩溃守护计数器每次重建都清零，变成每秒无限重启 | 官方 | 两端 | P1 | 新 | index.js L51@192302/@192685 |
| PLG-01 | 插件开启 `--remote-debugging-port`（127.0.0.1、无鉴权 CDP） | 插件 | Win（Mac 有历史痕迹） | P1 | 一致 | trip-vendor-bootstrap.cjs L313–321 |
| SEC-06 | 非 PROD 环境开启 `ignore-certificate-errors`，环境判定取自 asar 外的 JSON 和用户配置 | 官方 | 两端 | P2 | 新 | index.js L39@47881、L87@273710 |
| SEC-07 | 远程页面也注入 `preload/index.js`（appBridge）；70 个主进程 IPC 处理器中只有 15 个校验 sender | 官方 | 两端 | P2 | 新 | index.js L87@254133、L39@47208 |
| SEC-08 | 非白名单 URL 直接 `shell.openExternal`、不经确认；`open_with_system_browser` 无 sender 校验 | 官方 | 两端 | P2 | 新 | index.js L52@214331、L87@260461 |
| SEC-09 | 未设置 `setPermissionRequestHandler/CheckHandler` | 官方 | 两端 | P2 | 新 | index.js 检索 0 处 |
| SEC-10 | `disable-http2` + `ignore-connections-limit` | 官方 | 两端 | P2 | 一致 | index.js L87@273770/@273882 |
| SUP-04 | asar 完整性形同虚设；4 处 integrity 矛盾来自构建后的 codesign 改写，并非篡改 | 官方 | 两端 | P2 | 新（更正） | ev_9b907b37…；codesign 结果 |
| SUP-05 | 死依赖带入原生可执行文件（DalDecrypt_mac、7za），hotfix 包依赖 RunAsNode | 官方 | 两端 | P2 | 新 | node_modules/@ctrip/node-electron-hotfix/entry.js:50 |
| PRI-02 | 本地 SQLite（vbk.db）与 Cookie 存储未加密 | 官方 | 两端 | P2 | 新 | ev_a47d77ec…；EnableCookieEncryption=disabled |
| PRI-03 | 崩溃报告自动上传，附带 hostname、buid、clientId，无同意开关 | 官方 | 两端 | P2 | 新 | electron-crashreport/index.js:57–74；index.js L39@45647 |
| STA-02 | IM 重连多套机制叠加，没有指数退避 | 官方 | 两端 | P2 | 新 | s-node-imclient-core/main.js:1794、18195–18205、18255–18290 |
| STA-04 | 主进程同步 IO 和同步 SQLite 承担 IPC 查询 | 官方 | 两端 | P2 | 一致 | index.js L51@185582/@186041 |
| STA-05 | 每账号一套持久分区 BrowserView，未见上限或 LRU | 官方 | 两端 | P2 | 一致 | index.js L87@254133、L52@213804 |
| STA-06 | GPU 崩溃后永久禁用硬件加速；Win 有 NUL 降级 | 官方 | 两端/Win | P2 | 一致（补充） | index.js L87@276597、L51@190666 |
| STA-07 | 包体臃肿：多版本依赖、两套 SQLite 引擎、未引用的大依赖 | 官方 | 两端 | P2 | 一致（数值更新） | node_modules 统计 |
| STA-08 | Mac 仅有 x86_64，而 `package.json config.arch=arm64` | 官方 | Mac | P2 | 一致 | ev_8a2669b8…、fuses.json architecture |
| MNT-02 | 过时或已弃用的依赖（request、xlsx 0.18.5、axios 0.19/0.27 等） | 官方 | 两端 | P2 | 新 | node_modules 版本统计 |
| PLG-02 | 插件改写 app.asar，`rebaseOfficialUpdate=false`，与官方更新冲突 | 插件/交互 | Win | P2 | 新 | TripVendorCompanion.Install/receipt.json |
| PLG-03 | 伴随程序无签名，内置 Electron 44.7.2 使用默认 fuses，另带 default_app.asar | 插件 | Win | P2 | 新 | ev_9e8e3253…、ev_1c992daf… |
| SEC-12 | 生产环境 F12/菜单可直接打开 DevTools | 官方 | 两端 | P3 | 新 | index.js L52@215068 |
| SEC-13 | ATS `NSAllowsArbitraryLoads=true` | 官方 | Mac | P3 | 新 | ev_88f380cf… |
| SEC-14 | `vbookingChat://` 深链参数未校验，会写入持久配置并透传到 IM URL | 官方 | 两端 | P3 | 新 | index.js L87@249783、@275236 |
| SUP-06 | elevate.exe 为无签名 PE32，CFG 仅有链接器声明 | 官方 | Win | P3 | 新 | ev_e0858474…、ev_aa8d817b… |
| PRI-04 | 硬编码 15 个内网/测试域名；未发现密钥 | 官方 | 两端 | P3 | 新 | constant-*.js、index.js 检索 |
| PRI-05 | 启动时整份打印 config；拦截日志打印完整 URL（本机日志未见 ticket） | 官方 | 两端 | P3 | 新 | index.js L39@48479；main.log 计数 |
| PRI-06 | electron-log 把 preload 写进 userData，并注入所有 session | 官方 | 两端 | P3 | 新 | index.js L87@276943；electron-log/src/main/initialize.js:57–70 |
| STA-03 | 常驻/半常驻轮询定时器清单（500ms/1s/200ms/5s） | 官方 | 两端 | P3 | 一致（补充） | index.js L51@168051/@170353、L87@267003/@244312 |
| STA-09 | 关窗即隐藏，进程常驻 | 官方 | 两端 | P3 | 一致 | index.js L87@252451 |
| STA-10 | userData 残留旧版 dist（17 MB）与模型占用（157 MB） | 官方 | Mac 实测 | P3 | 新 | 本机目录统计 |
| MNT-01 | 主进程产物压缩、无 source map，而 node_modules 带了 4524 个 .map | 官方 | 两端 | P3 | 新 | dist-electron 无 .map |
| MNT-03 | 双平台版本与签名策略漂移（1.2.13 vs 1.2.12，公证 vs 无签名） | 官方 | 两端 | P3 | 新 | packageVersion.json；签名证据 |
| MNT-04 | 生产包内带调试依赖（heapdump、redux-devtools-extension） | 官方 | 两端 | P3 | 一致 | package.json；node_modules/heapdump |
| PLG-04 | 当前 Mac 包未被注入，只留下 TripVendorLauncher 崩溃记录与 DevToolsActivePort | 插件（更正） | Mac | P3 | 冲突 | `codesign`/`spctl` 结果 |

## 3. 各维度详述

### 3.1 Electron 安全基线

#### SEC-01 · webSecurity 在 8 个窗口/视图中被关闭（P1，官方，两端，复核一致并补 1 处）

- 证据 [事实]：Mac `dist-electron/main/index.js` 中有 7 处字面量 `webSecurity:!1`。

  | 字节偏移 | 窗口/视图 |
  | --- | --- |
  | L51@148709 | 截图 overlay |
  | L52@213902 | 远程 Web BrowserView，`partition:"persist:"+账号` |
  | L52@219020 | extra window |
  | L52@223238 | AI 窗口 |
  | L87@240698 | 架构切换窗口 |
  | L87@251357 | 主窗口 |
  | L87@263391 | 登录窗口 |

  另有 1 处条件式（L87@254551）：`webSecurity:c.includes("pages/setting/index")`。也就是说，主窗口里所有非设置页的 BrowserView，包括远程 vbooking 页面，都关闭了同源策略。Win 端偏移见锚点表，数量相同。
- 影响 [推断]：同源策略被关闭；按 Electron 文档语义，`allowRunningInsecureContent` 也会随之放开。远程页面一旦出现 XSS，就能跨源读取其他携程域（例如订单、IM）的响应。这一点与 SEC-02、SEC-03 叠加。
- 复现方法：`python3 -I ~/tools/rea-work/defects/scripts/anchors.py <index.js>`，查看 `webSecurity_false`、`webSecurity_cond` 两行。
- Tauri 重构：WebView 一律保留默认同源策略。跨域需求通过 Rust 侧白名单代理命令完成，不在 WebView 中关闭安全策略。

#### SEC-02 · 无条件关闭站点隔离（P1，官方，两端，复核一致）

- 证据 [事实]：`index.js L87@273818` `appendSwitch("disable-site-isolation-trials")`，前后没有任何条件判断。
- 两者交互 [事实]：Windows 插件 `trip-vendor-bootstrap.cjs L313` 会在官方 main 之前执行 `appendSwitch('site-per-process')`，注释说明这样做是为了抵消官方的关闭行为。所以**被插件改写过的 Win 包实际上恢复了站点隔离**；纯官方包和当前 Mac 包没有恢复。
- 影响 [推断]：跨站 iframe 可能共享 renderer，Spectre 类侧信道和渲染进程漏洞的影响范围会扩大到同进程的其他站点。
- Tauri 重构：不传任何关闭隔离的参数，完全依赖 WKWebView/WebView2 的默认进程模型。

#### SEC-03 · CSP 形同虚设，并主动剥离服务端安全头（P1，官方，两端，新发现）

- 证据 [事实]：
  1. Mac `app.asar.unpacked/dist/src/pages/*/index.html` 中 21 个页面（两端合计 48 个文件）的 `<meta http-equiv="Content-Security-Policy">` 都是 `default-src * …; script-src * 'self' 'unsafe-eval' 'unsafe-inline' blob: data: gap:; object-src * …`。这等于没有 CSP，`gap:` 还是 Cordova 遗留写法。
  2. `index.js L87@255155` 在每个主窗口 BrowserView 的 session 上注册了 `webRequest.onHeadersReceived({urls:["https://*/*"]})`。只要响应来自 `IFRAME_WHITE_DOMAINS`（`.ctrip.com`、`.qa.nt.ctripcorp.com`、`.trip.com`，见 `constant-B2KHNj0H.js@44730`），就删除 `X-Frame-Options` 和 `Content-Security-Policy`（L87@255520）。
- 影响 [推断]：服务端为 vbooking 配置的 CSP 和防点击劫持策略，在客户端里全部失效。再叠加 SEC-01，XSS 的利用难度会显著降低。
- 复现方法：`grep -h -o '<meta[^>]*Content-Security-Policy[^>]*>' …/dist/src/pages/*/index.html | sort | uniq -c`；锚点 `csp_strip`。
- Tauri 重构：本地页面使用严格 CSP（`script-src 'self'`，禁止 `unsafe-eval`），由 Tauri 的 `security.csp` 统一注入。如果确实需要嵌入远程页面，用独立的顶层 WebView 承载，不剥离服务端响应头。

#### SEC-04 · Electron fuses 未加固（P1，官方，两端，新发现）

- 证据 [事实]：
  - Mac `inspect-electron-fuses` 输出 `ev_a4a3c4a69d23…`，sentinel 位于 `Electron Framework`@131109072；
  - Win 输出 `ev_c7820928d68d…`，sentinel 位于 exe@144433152；
  - 两端结果相同：

  | Fuse | 状态 |
  | --- | --- |
  | RunAsNode | **enabled** |
  | EnableCookieEncryption | **disabled** |
  | EnableNodeOptionsEnvironmentVariable | **enabled** |
  | EnableNodeCliInspectArguments | **enabled** |
  | EnableEmbeddedAsarIntegrityValidation | **disabled** |
  | OnlyLoadAppFromAsar | **disabled** |
  | LoadBrowserProcessSpecificV8Snapshot | disabled |

- 影响 [推断]：
  - 任何本机进程都可以用 `ELECTRON_RUN_AS_NODE=1` 或 `NODE_OPTIONS=--require` 把官方签名的二进制当成 Node 解释器来运行；
  - 在 macOS 上，这类进程会继承本应用已经获得的 TCC 授权，例如摄像头、麦克风（Info.plist 中有对应声明）以及屏幕录制；
  - 也可以通过 `--inspect` 附加调试，或替换 asar 外的入口。
- 复现方法：`~/tools/rea/rea inspect-electron-fuses <app 或 exe> --format json`。
- Tauri 重构：不存在 Node 运行时，这一类风险直接消失。替代要求：发布构建关闭 devtools feature，不接受调试类启动参数。

#### SEC-05 · Mac 硬化运行时被大幅放宽（P1，官方，Mac，新发现）

- 证据 [事实]：`inspect-signature` 输出 `ev_530ea95461…`。
  - 已开启的 entitlements：`com.apple.security.cs.allow-dyld-environment-variables`、`disable-library-validation`、`allow-unsigned-executable-memory`、`allow-jit`；
  - 签名为 Developer ID（Team F63YXXUDZP），hardened_runtime=true。
- 影响 [推断]：
  - `allow-dyld-environment-variables` 加上 `disable-library-validation`，意味着 `DYLD_INSERT_LIBRARIES` 可以把未签名的 dylib 注入一个已公证的进程；
  - 叠加 SEC-04，hardened runtime 实际上失去了防护作用。
- Tauri 重构：宿主进程不需要这几项 cs 例外，包括 allow-jit；WKWebView 的 JIT 运行在系统 WebContent 进程中。签名后用 `codesign -d --entitlements :-` 做门禁检查。

#### SEC-06 · 非 PROD 环境全局忽略证书错误，且环境开关在可写位置（P2，官方，两端，新发现）

- 证据 [事实]：
  - `index.js L87@273710`：`ne.env!="PROD"&&appendSwitch("ignore-certificate-errors")`；
  - `L39@47881`：`NODE_ENV` 读自 `app.asar.unpacked/dist/packageVersion.json` 的 `nodeEnv` 字段；只要它不是 `production`，env 就从 electron-store 中取（默认 `FAT`）；
  - 本机 `config.json` 里确实存在 `USER_PREFERENCE.manualEnv`（str[4]）。
- 影响 [推断]：
  - 在 Windows 上，`app.asar.unpacked` 既不受签名也不受 asar 完整性保护（SUP-03、SUP-04），改一个 JSON 字段就能让客户端连到测试环境，同时全局关闭 TLS 校验；
  - Mac 上该文件处于 codesign 封印范围内，但签名校验只在 Gatekeeper 首次评估时进行。
- Tauri 重构：环境切换只在编译期决定（cargo feature 或构建变量），发布包中不存在「忽略证书」代码路径。

#### SEC-07 · 远程页面获得 appBridge，IPC sender 校验覆盖不全（P2，官方，两端，新发现）

- 证据 [事实]：
  1. `index.js L87@254133` `createBrowserView` 默认使用 `preload/index.js`，只有 imPlus/notice 页面用 `im.js`；同一函数遇到 `e.startsWith("http")` 时执行 `loadURL(e)`。所以远程 http(s) 菜单页也会得到 preload。
  2. rea facts（`ev_09aad3be…`）显示，`preload/index.js` line 1 col 7691 通过 `exposeInMainWorld("appBridge")` 暴露了 `dbQuery`、`downloadFile`、`getAllLoginCookies`、`getLoginCookie`、`invoke`、`netFetch`、`openExtraWindow`、`receive`、`send`、`setLocalVoice`。其中 `send`/`invoke` 对 93 个通道常量做白名单放行：`invoke` 只排除 6 个敏感通道，`send` 只排除 2 个。
  3. 主进程共有 `ipcMain.on` 37 个、`ipcMain.handle` 33 个，但只有 10 处 `Rt(...)` 和 5 处 `Ri(...)` 做了 sender 校验。校验函数 `Cu`（L39@47208）只看 `webContents.getURL()` 是否为 `file:` 且路径包含 `/pages/{main|login|launch}/`，不看 `senderFrame`。
  4. 没有校验的通道包括 `open_with_system_browser`、`download_file`（`i.sender.downloadURL(e)`，L52@230596）、`open_window`、`pop_context_menu`、`set_local_voice` 等。
- 影响 [推断]：远程页面一旦被 XSS，就能调用这些没有校验的通道，例如拉起任意外链、触发下载、打开窗口。好的一面是，读取 ticket 和执行数据库查询的通道有 `Ri/Rt` 校验，已经限制在本地特权页。
- Tauri 重构：
  - 远程 WebView 不注入任何 IPC 能力（Tauri capability 不授予 remote URL）；
  - 本地 WebView 的每个 command 都在 Rust 侧校验调用方窗口标签和来源；
  - 敏感命令（凭据、数据库）不暴露给 WebView，只在 Rust 内部消费。

#### SEC-08 · 外链无确认直接交给系统浏览器（P2，官方，两端，新发现）

- 证据 [事实]：
  - 检索到 21 处 `shell.openExternal`；
  - `will-navigate`（L52@214331）和 `will-redirect` 遇到非白名单的 http(s) URL 时直接 `openExternal(u)`；`implus://` 也直接外抛；
  - `open_with_system_browser`（L87@260461）只检查协议是否为 http(s)，不校验 sender；
  - `preload/web.js` 的 postMessage 桥接受来自 33 个白名单域任意页面的 `openUrlByBrowser`、`openExtraUrl` 事件（web.js@7505 附近）。
- 影响 [推断]：任一白名单域（含 qunar.com、tujia.com、toursforfun.com 等）上的页面或 iframe，都可以静默拉起系统浏览器打开任意网址，可用于钓鱼跳板。
- Tauri 重构：外链统一经过 `opener` 插件，并弹出一次性确认；只信任显式的域名清单，不按后缀批量放行。

#### SEC-09 · 未设置权限请求处理器（P2，官方，两端，新发现）

- 证据 [事实]：两端 `index.js` 中 `setPermissionRequestHandler` 和 `setPermissionCheckHandler` 的出现次数都是 0。
- 影响 [推断]：Electron 默认批准 renderer 的权限请求（通知、媒体、地理位置等），远程页面可以静默获得摄像头或麦克风。在 Mac 上，这还会继承本应用已获得的系统授权。
- Tauri 重构：WebView 权限请求由 Rust 侧逐项决策，默认拒绝。

#### SEC-10 · 关闭 HTTP/2 并解除连接数限制（P2，官方，两端，复核一致）

- 证据 [事实]：
  - L87@273770 `disable-http2`；
  - L87@273882 `ignore-connections-limit`，作用于 `.ctrip.com,.c-ctrip.com,.tripcdn.com,.trip.cn`（非 PROD 时为 `.qa.nt.ctripcorp.com`）。
  - 两者都是无条件设置。
- 影响 [推断]：所有连接被迫走 HTTP/1.1，并发连接数提高，可能加重服务端压力，也改变队头阻塞行为。实际延迟代价 [未知]，需要抓包实测。
- Tauri 重构：不修改系统 WebView 的网络栈参数。

#### SEC-11 · 运行时过旧（P1，官方，两端，复核一致）

- 证据 [事实]：
  - Mac `Electron Framework.framework/Resources/Info.plist` 的 `CFBundleVersion=27.3.11`；
  - 二进制内的 UA 串是 `Chrome/118.0.5993.159 Electron/27.3.11`；Win exe 中的 UA 串相同。
  - Mac 1.1.18 时期的日志里还能看到 `electronVersion:"22.3.27"`，说明历史上升级缓慢。
- 影响：该大版本早已不在 Electron 的支持窗口内，Chromium 118 之后的安全修复都没有并入（这里只按「版本过旧」判断，不列举具体 CVE）。
- Tauri 重构：使用系统 WebView（WKWebView 和 WebView2 Evergreen 随系统更新），Rust 依赖用 `cargo audit` 作为门禁。

#### SEC-12 · 生产环境可打开 DevTools（P3，官方，两端，新发现）

- 证据 [事实]：
  - Web 窗口的 `before-input-event` 在 L52@215068 处理 `F12`，直接 `openDevTools`，没有 `ke.dev` 判断；
  - `toggleDevTools`（L52@209766、L87@258527）由菜单触发；
  - `shouldOpenDevToolsOnStart` 在 production 下返回 false，这一处的处理是正确的。
- 影响 [推断]：任何拿到这台电脑的人都能直接查看 Cookie 和本地存储；也给「在控制台粘贴代码」类社工攻击留了入口。
- Tauri 重构：发布构建不启用 `devtools` feature。

#### SEC-13 · ATS 全局放开（P3，官方，Mac，新发现）

- 证据 [事实]：`inspect-plist` 输出 `ev_88f380cf…`：`NSAppTransportSecurity.NSAllowsArbitraryLoads=true`，另对 localhost/127.0.0.1 设置了例外。
- 影响 [推断]：Chromium 网络栈不受 ATS 约束，所以这一项只影响原生组件，例如 Squirrel.Mac 更新器所用的 NSURLSession。影响面有限，但与 SUP-01 的 HTTP 降级同属一种「默认放开」的配置倾向。
- Tauri 重构：保持 ATS 默认值，本地开发例外只放在 dev 配置中。

#### SEC-14 · 深链参数未校验（P3，官方，两端，新发现）

- 证据 [事实]：
  - `second-instance` 回调（L87@275236）取 argv 的最后一个元素并 `slice(0,-1)`，原样传给 `onProtocolOpen`（L87@249783）；
  - `account` 参数会被追加写入持久配置 `ZUCHE_ACCOUNT_LIST`；
  - `action=auth` 时，整串 query 会透传到 IM 页面 URL（`paramStr`）。
- 影响 [推断]：外部网页可以通过 `vbookingChat://` 链接（浏览器会弹出确认），向本地 IM 页面注入任意 query 参数，并污染持久配置。
- Tauri 重构：deep-link 插件接收后按 schema 严格解析，只允许列出的白名单键，不写入持久配置。

### 3.2 供应链与完整性

#### SUP-01 · 渲染层热更新：强制 HTTP、无校验、以特权身份加载（P0，官方，两端，新发现）

- 证据 [事实]，按 Mac `index.js` 的字节偏移排列，Win 偏移见锚点表：
  1. L51@157356 `initUpdateInfo`：从 `https://static.tripcdn.com/packages/{aresGroup}/{aresName}/*/packageVersion.json` 拉取远端版本信息，其中带有 `distUrl`。安装包自带的值是 `https://file.tripcdn.com/files/8/tour_vbkadminuser/vbk-electron-v27/1.2.13/dist/1.2.18/dist.zip`。
  2. L51@162280 `downloadBundleZip`：`e.startsWith("https://")&&(e=e.replace("https://","http://"))`，之后调用 `Bo.get(e,…)`，而 `Bo=require("http")`（L1@746）。**下载被强制降级为明文 HTTP**。
  3. L51@163365 `replaceNewVersion`：先把 `userData/dist` 改名为 `dist.back`，再用 `new AdmZip(userData/dist.zip).extractAllTo(userData/dist,true,true)` 解压。全程没有哈希、签名或大小校验。
  4. L51@157356 `isUserPath()`：只要 `userData/dist/packageVersion.json` 的 `aresVersion` 高于内置版本，L87@272967 就把 `UNPACKED_DIST` 和 `VITE_PUBLIC` 指向 `userData/dist`。
  5. 此后加载的所有本地页面（login/main/launch/imPlus 等）都来自这个目录，而 `Cu()`（L39@47208）恰恰把「`file:` 协议且路径含 `/pages/main|login|launch/`」当作可信 sender。于是这些页面可以调用 `getAllLoginCookies`（返回所有账号的 bticket）、`dbQuery`、`netFetch`（会自动带上目标域 Cookie）等能力。
  6. L51@186122：drizzle 迁移目录取自 `VITE_PUBLIC/drizzle`，也就是热更新后的 `userData/dist/drizzle`。迁移 SQL 由主进程中的 better-sqlite3 执行。
- 影响 [推断]：
  - 公共 Wi-Fi、代理或 DNS 被劫持时，攻击者只要替换一次 `dist.zip`，就能**持久**控制所有本地特权页面：窃取所有账号 ticket、读写本地 IM 数据库、伪造客服回复；
  - 由于版本号比较取「更高者」，被植入的包会一直保留，直到官方发布更高的 `aresVersion`。
  - 同一用户权限下的本地恶意程序也可以直接往 `userData/dist` 写文件，达到同样效果。
- 复现方法（只读）：用锚点 `hotfix_http_downgrade`、`hotfix_extract`、`hotfix_userdist`、`drizzle_migrations_from_public` 检索；需要动态复现时，在隔离网络中用 mitmproxy 拦截 `http://file.tripcdn.com/...dist.zip`，观察客户端是否接受替换包（本轮未执行）。
- 旁证 [事实]：本机 `userData/dist` 中残留着 1.2.6 / aresVersion 1.2.5（`vbk-electron-v22`）的旧包，说明该链路在真实环境中被使用过。
- Tauri 重构：
  - 前端资源只随签名安装包发布，不做运行时远程替换；
  - 如确需热更新：先用 HTTPS 加证书固定，再用 minisign/ed25519 验签，签名公钥编进二进制；
  - 解压到只读的版本化目录，信任判断不依赖路径；
  - 数据库迁移只来自二进制内嵌的资源。

#### SUP-02 · 模型下载关闭 TLS 校验，来源不可信（P1，官方，两端，新发现）

- 证据 [事实]：
  - L51@195151 OCR 模型基址为 `https://raw.githubusercontent.com/X3ZvaWQ/paddleocr.js/main/assets`。这是**个人 GitHub 仓库的 main 分支**，不是固定提交，也没有 release 摘要。字典来自 `raw.githubusercontent.com/PaddlePaddle/PaddleOCR/main/...`；
  - L51@195329 定义 `_p=new https.Agent({rejectUnauthorized:false})`，并用于 `node-fetch(n,{agent:_p})`；
  - L87@267680 拼写模型 `https://docs.c-ctrip.com/files/8/tour_vbkadminuser/model_quantized.onnx.gz` 同样使用 `rejectUnauthorized:false`；
  - 模型的「完整性」只看文件是否存在、字典行数是否达标、文件大小是否超过 1 MB 或 50 KB（`hasAllModelFiles`），没有哈希校验。
- 影响 [推断]：
  - 中间人或上游仓库被篡改时，可以替换 ONNX 模型和字典，让 OCR/纠错结果被操纵（例如把订单号、金额识别错）；
  - 恶意模型还会让 onnxruntime-web 解析不可信输入，至少可造成 DoS；
  - 证书校验被关闭，也违反了企业对 TLS 的基线要求。
- 本机实测 [事实]：`paddleocr-models` 20 MB、`csc-models` 114 MB 已经下载落盘。
- Tauri 重构：模型随安装包分发，或从自有 CDN 下载并做 sha256 白名单校验；禁止关闭证书校验（Rust `reqwest` 不开启 `danger_accept_invalid_certs`，并用 CI lint 拦截）。

#### SUP-03 · Windows 无代码签名，更新不验签（P1，官方，Win，新发现）

- 证据 [事实]：
  - `inspect-pe-certificates` 显示以下文件的 `IMAGE_DIRECTORY_ENTRY_SECURITY` 都不存在，`certificates: 0`：

    | 文件 | 证据 | sha256 | 大小 |
    | --- | --- | --- | --- |
    | `旅游商家桌面版.exe` | `ev_d43a0daa…` | `4fad3f96…` | 172 684 800 B |
    | `Uninstall 旅游商家桌面版.exe` | `ev_8ef03f92…` | — | — |
    | `resources/elevate.exe` | `ev_e0858474…` | — | — |

  - 主程序的 sha256 与插件 receipt 记录的 `executableSha256` 一致，说明它**就是官方原件**，没有签名并非插件改写所致；
  - `resources/app-update.yml` 只有 `provider: generic`、`url: ''` 和 `updaterCacheDirName`，**没有 `publisherName`**，`feedUrl` 在运行时由远端 `packageVersion.json` 提供（L51@159112、@161103 `setFeedURL`）。
- 影响 [推断]：
  - electron-updater 的 NSIS 更新器在没有 `publisherName` 时不做 Authenticode 校验，更新包的完整性只靠 HTTPS 和同源 `latest.yml` 里的 sha512；
  - 用户安装和更新时会触发 SmartScreen 警告，用户被训练成习惯点「仍要运行」；
  - 未签名的 exe 也无法在企业 WDAC/AppLocker 环境中按发布者放行。
- Tauri 重构：
  - Windows 用 EV 或 Azure Trusted Signing 签名所有 PE，包括安装器和卸载器；
  - updater 使用 Tauri 内置的 ed25519 签名校验，公钥编入二进制。

#### SUP-04 · asar 完整性形同虚设；4 处「完整性矛盾」是构建流程造成的（P2，官方，两端，新发现并更正）

- 证据 [事实]：
  1. Mac Info.plist 中有 `ElectronAsarIntegrity`（`Resources/app.asar` SHA256 `3a266a8a…`），但 fuse `EnableEmbeddedAsarIntegrityValidation=disabled`（SEC-04），所以运行时**不校验**。
  2. 主进程 summary（`ev_9b907b37…`）列出 4 个 integrity contradiction：`DalDecrypt_mac`、`7za`、`libvips-cpp.8.17.3.dylib`、`node-screenshots.darwin-x64.node`。逐个执行 `codesign -dv` 的结果是：4 个文件都带有 **TeamIdentifier F63YXXUDZP** 的签名，时间戳为 2026-10-30 13:38:12–13:38:51，早于主程序签名的 13:39:23。由此判断 [推断]：这是**打包成 asar 之后再对 unpacked 原生文件做 codesign**，改写了文件字节，导致与 asar 头里的哈希不一致，而不是被第三方篡改。
  3. `codesign --verify --deep --strict` 的结果是 `valid on disk / satisfies its Designated Requirement`；`spctl` 的结果是 `accepted, source=Notarized Developer ID`。
  4. Windows 没有对应的机制。插件已经改写 `app.asar`（sha256 `f3f60007…`，`package.json main` 改成 `trip-vendor-bootstrap.cjs`，见 rea facts `ev_e339a25b…` 的 electron-main 记录），官方程序照常运行。
- 影响：asar 头部的哈希既不被强制执行，又和实际文件不一致，客户端自身无法检测篡改；完整性在 Mac 上只能依赖 Gatekeeper 的首次评估，在 Windows 上没有任何保障。
- Tauri 重构：前端资源嵌入二进制（Tauri 默认会这样做），由整体代码签名覆盖；不维护第二套完整性清单。

#### SUP-05 · 死依赖带入原生可执行文件（P2，官方，两端，新发现）

- 证据 [事实]：
  - `@ctrip/node-electron-hotfix@1.0.16` 列在 dependencies 中，但主进程和 preload 的 11 个文件里**没有一处 require 它**（字节检索仅命中 package.json 内嵌字面量 L39@42316）；
  - 它通过依赖链带入 `@ctrip/node-vampire-dal`（含 `bin/DalDecrypt_mac`）和 `@ctrip/node-vampire-p7zip`（含 `bin/darwin/7za`）；
  - 主进程中也没有出现 `DalDecrypt`、`p7zip`、`7za`；
  - 该包的 `entry.js:50` 用 `spawnSync(process.execPath,[runSync.js, JSON.stringify(config)])` 运行，依赖 RunAsNode fuse。
- 影响 [推断]：签名过的可执行文件被白白分发，增加了攻击面和审计负担。一旦将来某段代码误用它们（例如参数拼接调用 7za 解压），就会带来命令/路径注入面。当前的调用参数注入面 [未知]，因为没有找到调用点。
- Tauri 重构：Cargo 和 pnpm 依赖做最小化审计；CI 用 `cargo udeps` 或 knip 拦截未使用的依赖；禁止分发不被调用的可执行文件。

#### SUP-06 · elevate.exe 为无签名 32 位 PE（P3，官方，Win，新发现）

- 证据 [事实]：
  - `ev_e0858474…` 显示无证书；`inspect-pe-load-config` `ev_aa8d817b…` 显示为 PE32 i386，`guard_flags=IMAGE_GUARD_CF_INSTRUMENTED`，但 `guard_cf_function_count=0`；rea 也注明这只是链接器声明。
  - 这是 electron-builder 的 NSIS 提权助手。
- 影响 [推断]：每次以管理员身份安装更新时都会经过一个没有签名的提权程序；在可写的安装目录下存在被替换的可能。
- Tauri 重构：使用 Tauri 的 NSIS/MSI 安装器，按用户安装（per-user），避免提权；所有随附的 PE 都要签名。

### 3.3 敏感信息与隐私

#### PRI-01 · 账号密码与 ticket 明文存储（P1，官方，两端，新发现）

- 证据 [事实]：
  - L39@40910 `z=new Fl`，即 `new ElectronStore()`，没有 `encryptionKey`；`safeStorage` 出现 0 次；
  - L52@224146 存储键为 `pwd_account_list`；
  - L52@227736 `loginSuccess`：只有在没勾选 `rememberPassword` 时才清空 `password`，然后把 `{account,password,bticket,bduid,userInfo…}` 写入 store；
  - 本机 `~/Library/Application Support/vbk-electron/config.json`（权限 0666；父目录 0700）的结构实测（只看形状）：`pwd_account_list` 共 3 条，每条包含 `password: str[13]`、`bduid: str[70]`、`buid`、`account`、`userInfo.email/name/positionCode` 等。13 个字符的长度符合明文口令特征，未见加密或编码前缀 [推断]。
- 影响：任何能读取用户目录的进程（同一用户的恶意软件、备份或同步工具、取证镜像）都能拿到商家账号密码和可直接复用的会话 ticket。
- Tauri 重构：口令不落盘，只保留刷新凭据；凭据放进 macOS Keychain 或 Windows Credential Manager（`keyring` crate）；配置文件中不出现任何机密。

#### PRI-02 · 本地数据库与 Cookie 未加密（P2，官方，两端，新发现）

- 证据 [事实]：
  - `inspect-sqlite-database` 结果 `ev_a47d77ec…`：rea 用普通 SQLite 3.53.4 就直接读出了 `vbk.db`（51 212 288 B）的完整 schema，共 11 张表：`messageInfo`、`IQMessageContent`、`conversationInfo`（47 列）、`groupMember`、`userInfo`、`venAgentInfo` 等；
  - `EnableCookieEncryption=disabled`（SEC-04），每个账号的持久分区 Cookie 都以明文 SQLite 存放（`Partitions/` 合计 476 MB）。
- 影响 [推断]：客户与商家之间的聊天记录、客人信息、登录 Cookie 都可以被离线读取。
- Tauri 重构：本地缓存最小化，并设置 TTL；必须持久化的数据用 SQLCipher，密钥放在系统密钥库；WebView 的 Cookie 交由系统存储管理。

#### PRI-03 · 崩溃报告自动上传，附带身份信息（P2，官方，两端，新发现）

- 证据 [事实]：
  - `@ctrip/electron-crashreport/index.js:57–74`：`crashReporter.start({submitURL:"https://sentrycollector.ctrip.com/collector/"+appId, uploadToServer:true, globalExtra:{sentry:{user:{username}, tags:{hostname: os.hostname()}}}})`；
  - 主进程在 L39@45647 初始化；`setUser(buid)` 在登录或切换账号时调用（L52@225409 等）；
  - `clientId` 作为 tag 上报（L39@46590）；
  - 用户名缓存在 `userData/username`；
  - 代码中没有同意开关。
- 影响 [推断]：minidump 可能包含进程内存里的 ticket 或消息片段。主机名和账号 ID 会被关联后上报，存在隐私合规风险。
- Tauri 重构：崩溃上报默认关闭或按需征得同意；上报前剥离 PII；只上传符号化后的栈。

#### PRI-04 · 内网与测试环境域名硬编码；未发现密钥（P3，官方，两端，新发现）

- 证据 [事实]：
  - 主进程和 constant 文件中有 15 个内网/测试域名，例如 `vbooking.ctrip.fat30.qa.nt.ctripcorp.com`、`imvendor.fat44.qa.nt.ctripcorp.com`、`static.fws.qa.nt.ctripcorp.com`、`gateway.m.uat.qa.nt.ctripcorp.com`；
  - 硬编码的 appId 为 `9000***`（公开 ID）。
- 负结果 [事实]：用正则扫描主进程、preload 和 Mac 渲染层 `dist/**/*.js`（AWS `AKIA…`、`sk-…`、32–64 位十六进制 key/secret、JWT、私钥头、明文 `http://` 携程域），**命中均为 0**。
- 影响：暴露内部环境的拓扑；该负结果不覆盖 node_modules 内的第三方包。
- Tauri 重构：测试环境配置只放在内部构建中，生产包不出现内网域名。

#### PRI-05 · 日志面（P3，官方，两端，新发现）

- 证据 [事实]：
  - L39@48479 启动时执行 `electronLog.info("config:", JSON.stringify(ne))`；
  - `[WebWindow] … blocked` 一类的拦截日志会打印完整 URL，包括 query；
  - 本机 `~/Library/Logs/vbk-electron/main.log`（858 KB）的计数结果：`bticket` 0、`ticket=` 0、`password` 0、`cookie` 0、`BDUID` 0；`token` 出现 39 次，全部是 `[SpellCheck Worker] Loaded vocab: 21128 tokens`。
- 结论：当前样本中**没有观察到**凭据落入日志。风险在于 URL query 中可能带有业务参数 [推断]。
- Tauri 重构：使用结构化日志，URL 在写入前统一去掉 query；对 secret 类型强制打码（`secrecy` crate）。

#### PRI-06 · electron-log 向所有 session 注入 preload（P3，官方，两端，新发现）

- 证据 [事实]：
  - L87@276943 调用 `electronLog.initialize()`；
  - `electron-log@5.2.3 src/main/initialize.js:57–70`：打包后找不到自带的 preload，于是在 `userData/electron-log-preload.js` 写入一个文件，并通过 `ElectronExternalApi.js:167` `session.setPreloads([...])` 注入**所有现有和未来的 session**，远程 vbooking 分区也在其中；
  - 本机已有该文件（807 B）。
- 影响 [推断]：远程页面会获得写主进程日志的通道（日志注入、磁盘填充）。该文件每次启动时会被重写，持久篡改的窗口期较小。
- Tauri 重构：日志只从 Rust 侧写入；前端日志通过受限 command 提交，并做限流。

### 3.4 稳定性、性能与资源

#### STA-01 · IM 子进程崩溃守护失效，会无限每秒重启（P1，官方，两端，新发现）

- 证据 [事实]：L51@192302 `createIMProcess(e){… r=utilityProcess.fork(imsdk.js); … let o=0; r.addListener("exit",c=>{… if(!(!l||c==0)){ o++; if(o>=10){ log("im process crash too many times"); return } setTimeout(()=>{this.createIMProcess(l)},1e3) } })`（L51@192685）。
- 分析 [推断]：计数器 `o` 是每次调用 `createIMProcess` 时新建的局部变量。重启后调用的是新的 `createIMProcess`，计数从 0 重新开始，所以「10 次上限」**永远不会触发**。如果 IM 子进程因 token 失效、原生依赖缺失或模型损坏等原因启动即崩，它会以固定 1 s 的间隔无限重启，而且每个账号各有一个这样的循环。每次重启都要重新初始化 SDK 并建立 WebSocket 连接。
- 复现方法：静态阅读即可确认；动态复现可以在隔离环境中把 `imsdk.js` 替换成 `process.exit(1)` 的副本，观察 `im process daemon` 日志的频率（本轮未执行）。
- Tauri 重构：子任务监管器采用指数退避（1s→2s→…，上限 5 min）、熔断计数放在实例外部，并把状态上报给 UI。

#### STA-02 · IM 重连多套机制叠加，没有指数退避（P2，官方，两端，新发现）

- 证据 [事实]，见 `node_modules/@ctrip/s-node-imclient-core/main.js`：

  | 层级 | 机制 | 位置 |
  | --- | --- | --- |
  | ① @xmpp/reconnect | 固定 `delay=1000` | :1794 |
  | ② SDK 的 Node 分支 | `reconnectTimeDelay()` 返回 5–10 s 随机常数，没有随失败次数增长；浏览器分支才有 20 s/60 s 阶梯 | :18195–18205 |
  | ③ ping 看门狗 | 每 5 s 一次；未连接时累计 12 次（约 60 s），已连接时 3 次 ping 无响应，就重新 `connectXMPP()` 创建 client | :18255–18290 |
  | ④ 主进程包装层 | `imsdk.js` 收到 DISCONNECTED 时立即 `IMClient.reconnect(!0)` | — |

- 影响 [推断]：网络抖动或服务端故障时，同一账号可能同时有多条重连路径；多账号成倍放大，恢复时容易形成连接风暴。
- Tauri 重构：单一连接状态机，带抖动的指数退避，全局并发上限；断线原因和重试次数在 UI 上可见。

#### STA-03 · 轮询定时器清单（P3，官方，两端，复核一致并补充）

- 证据 [事实]：

  | 定时器 | 周期 | 位置 | 终止条件 |
  | --- | --- | --- | --- |
  | 托盘闪烁 | 500 ms | L51@168051 | stopFlash |
  | 提示窗鼠标离开检测 | 1 s | L51@170353 | hide |
  | 启动窗 autoLogin 发送 beginToLogin | 200 ms | L87@267003 | 收到一次回执；**没有超时** |
  | ArchGuide 安装监测（每次 `readFileSync`） | 1 s | L87@244312 | 30 min 超时 |
  | IM ping（每账号） | 5 s | imclient main.js:18260 | 销毁 |

- Tauri 重构：用事件替代轮询（托盘闪烁改用系统 attention API；鼠标离开改用 `mouseleave`/窗口失焦事件）；必要的轮询都设上限和超时。

#### STA-04 · 主进程同步 IO 与同步数据库（P2，官方，两端，复核一致）

- 证据 [事实]：
  - `better-sqlite3`（同步 API）在主进程打开，`journal_mode = WAL`（L51@186041）；
  - `execute_db` 的 IPC handler（L51@185582）直接在主进程同步执行 renderer 传来的 SQL；
  - 主进程中 `readFileSync` 15 处、`writeFileSync` 11 处，其中模型下载完成后会把十几 MB 的 buffer 同步写盘；
  - Win 启动时 `execSync("reg query …")`（L51@190918）会同步阻塞。
- 影响 [推断]：大查询（例如会话列表、全文搜索）会阻塞主进程事件循环，表现为所有窗口一起卡顿和 IPC 积压。
- Tauri 重构：数据库放在独立线程或 actor 中（`rusqlite` 配合专用线程，或 `sqlx`），命令异步化，查询设置超时和分页上限。

#### STA-05 · 每账号持久分区的 BrowserView 无上限（P2，官方，两端，复核一致）

- 证据 [事实]：
  - L87@254133 `createBrowserView` 为每个 `pageType` 创建 `new BrowserView({session: fromPartition("persist:"+buid)})` 并放入 `viewList`；
  - 静态检索只找到两处清理：`viewList.length=0`（窗口关闭时）和移除账号时 `splice` 后逐个销毁（L87@256151），没有发现 LRU 或数量上限；
  - 本机 `Partitions/` 有 3 个分区，合计 476 MB。
- 影响 [推断]：账号数与打开过的菜单页数相乘，renderer 数量和内存随之增长。实际增长幅度 [未知]，需要运行时对照。
- Tauri 重构：远程页面 WebView 按需创建并设上限（LRU），后台页面主动卸载。

#### STA-06 · 渲染降级为粘性状态（P2，官方，两端/Win，复核一致并补充）

- 证据 [事实]：
  - Win：`Tc()`（L51@190175）只在 win32 下检测 `NUL` 设备、`null.sys` 和注册表；失败时执行 `disableHardwareAcceleration`，加上 `disable-gpu`、`disable-gpu-sandbox`、`disable-software-rasterizer`（L87@274295）。Win7 或用户设置 `disableGPUAcceleration` 时也会关闭硬件加速。
  - 补充：`child-process-gone` 中，如果 GPU 进程在同一个 5 分钟桶内崩溃 2 次，就**把 `disableGPUAcceleration:true` 写入用户偏好**并重启（L87@276597）；已经禁用时阈值为 6 次，达到后直接退出。之后没有任何自动恢复路径。
- 影响 [推断]：一次偶发的驱动问题就会让用户永久处于 CPU 渲染状态，IM 滚动和动画性能会长期下降。
- Tauri 重构：硬件加速交给系统 WebView 管理；如需降级，只对本次会话生效，并带自动复检。

#### STA-07 · 包体臃肿与依赖重复（P2，官方，两端，复核一致并更新数值）

- 证据 [事实]：

  | 指标 | Mac 1.2.13 | Win 1.2.12 |
  | --- | --- | --- |
  | `app.asar` | 364 139 989 B | 350 903 096 B（插件版；原件 350 848 347 B） |
  | `node_modules` 顶层条目 | 656 | 617 |
  | `node_modules` 体积 | 639 MB | 605 MB |
  | `.map` 文件数 | 4524（100.7 MB） | 4472 |

  - Mac 的包实例 1380 个、唯一包 960 个，其中 **113 个包有多个版本**。例如 `axios` 有 0.19.2、0.27.2、0.28.1、1.13.6 四个版本；`lru-cache` 有 5 个版本；`semver` 有 4 个版本；`ws` 有 7.5.10 和 8.21.0。
  - 同时带了 `sqlite3@5.1.7` 和 `better-sqlite3@11.1.2` **两套 SQLite 引擎**，主进程只 require 后者。
  - 以下包没有被主进程或 preload require：`@npmcli`（22 MB，npm 自身）、`@larksuiteoapi/node-sdk`（13 MB）、`jimp`、`sharp`、`xlsx`、`heapdump`、`node-screenshots`（通过 `createRequire` 动态加载，见 L51@144520）。主要体积来自 `onnxruntime-web` 133 MB、`@ctrip` 112 MB、`antd` 53 MB（渲染层已经单独打包进 dist）。
- Tauri 重构：前端按入口 tree-shake 后整体嵌入；Rust 侧做依赖审计；安装包体积作为发布门禁（例如 ≤ 80 MB）。

#### STA-08 · Mac 仅 x86_64（P2，官方，Mac，复核一致）

- 证据 [事实]：
  - `inspect-macho`（`ev_8a2669b8…`）显示主程序只有一个 x86_64 架构，`architectures.total=1`；
  - fuses 证据显示 `Electron Framework` 为 x86_64；
  - `package.json` 的 `config.arch` 却写的是 `"arm64"`，两者不一致；
  - 代码中有 `ArchGuideWindow`（L87@244239），会引导用户下载其他架构的包，并监测其安装。
- 影响：在 Apple Silicon 上整个客户端（包括 onnxruntime 推理）都要经过 Rosetta 转译。
- Tauri 重构：发布 universal2 或两套原生架构的包，CI 中断言 `lipo -archs` 的结果。

#### STA-09 · 关窗即隐藏（P3，官方，两端，复核一致）

- 证据 [事实]：主窗口 L87@252451、更新窗口 L51@163982 等处的 `close` 回调都是：如果没有设置 `isQuiting`，就 `preventDefault()` 后 `hide()`。这是代码层面的证据，不再只依赖插件 README。
- Tauri 重构：保留托盘常驻，但首次关闭时明确提示「已最小化到托盘」，并提供「关闭即退出」的选项。

#### STA-10 · userData 残留与模型占用（P3，官方，Mac 实测，新发现）

- 证据 [事实]：本机 `vbk-electron/` 目录下：

  | 内容 | 大小 |
  | --- | --- |
  | `dist`（旧版 1.2.6 热更新包，当前不会被使用） | 17 MB |
  | `csc-models` | 114 MB |
  | `paddleocr-models` | 20 MB |
  | `tesseract-langs` | 11 MB |
  | `tesseract-cache` | 12 MB |
  | `Cache` | 39 MB |

  当前代码里已经没有 `tesseract` 的 require，但目录仍然保留。
- Tauri 重构：缓存目录按版本管理，升级时迁移或清理旧版本缓存，并在设置页提供「清理缓存」入口。

### 3.5 可维护性

#### MNT-01 · 产物压缩、无 source map（P3，官方，两端，新发现）

- 证据 [事实]：
  - `dist-electron/main/index.js` 压缩后只有 87 行、276 969 B，preload 大多只有 1 行；
  - `dist-electron` 和 `app.asar.unpacked/dist` 下都没有 `.map` 文件；
  - 但 `node_modules` 中有 4524 个 `.map`（100.7 MB）。
- 影响：现场崩溃栈无法回溯到源码，问题定位只能逆向；第三方 map 又白白增加体积。
- Tauri 重构：source map 只上传到符号服务器，不随包分发。

#### MNT-02 · 过时或已弃用的依赖（P2，官方，两端，新发现）

- 证据 [事实]（版本取自 node_modules 实际安装的 package.json）：
  - `request@2.88.2`：上游已宣布弃用；
  - `xlsx@0.18.5`：npm 渠道早已停止更新；
  - `axios@0.19.2/0.27.2`；
  - `electron-updater@6.3.9`；
  - `redux@4.0.4`、`redux-devtools-extension@2.13.9`；
  - `moment@2.30.1`；
  - `antd@4.24.8`。
- 影响：按「版本过旧」判断存在已知问题的风险，这里不列举具体 CVE。依赖之间相互牵制，也提高了升级成本。
- Tauri 重构：Rust 侧依赖用 `cargo deny`，前端用 `pnpm audit` 加 renovate 做持续更新。

#### MNT-03 · 平台与版本漂移（P3，官方，两端，新发现）

- 证据 [事实]：
  - 版本：Mac 为 1.2.13（`aresVersion 1.2.18`），Win 为 1.2.12（`aresVersion 1.2.15`）；
  - 签名：Mac 已公证，Win 完全没有签名；
  - Mac 的 `package.json` 声明 arm64，实际交付 x86_64；
  - `index.js` 中有 win32 专属的 NUL 检测、Win7 判断和 `execSync reg`，有 darwin 专属的 dock badge 和 `x-apple.systempreferences` 跳转。
  - 好的一面：主进程以外的 preload 和 worker 共 9 个文件，两端逐字节一致。
- Tauri 重构：一份代码、同一条 CI 发布线；两平台的签名和公证都作为发布门禁。

#### MNT-04 · 调试依赖进入生产包（P3，官方，两端，复核一致）

- 证据 [事实]：
  - `package.json` dependencies 里有 `heapdump@^0.3.15`，`node_modules/heapdump` 两端都存在，主进程却从不 require；
  - 生产依赖中还有 `redux-devtools-extension`；
  - `package.json` 的 `debug.env.VITE_DEV_SERVER_URL=http://127.0.0.1:7777/` 也被打进了包。
- Tauri 重构：区分 dev-dependencies，发布构建禁用 dev 端点。

### 3.6 插件注入带来的问题

#### PLG-01 · 无鉴权 CDP 调试端口（P1，插件，Win；Mac 有历史痕迹，复核一致）

- 证据 [事实]：
  - Win `app.asar` 入口 `trip-vendor-bootstrap.cjs`：L318–321 先 `removeSwitch` 再追加 `remote-debugging-address=127.0.0.1` 和 `remote-debugging-port=0`（随机端口）；L445 以 `--vendor-debug-port=auto` 启动 `resources/TripVendorCompanion/旅游商家助手.exe`，并清空 `ELECTRON_RUN_AS_NODE` 和 `NODE_OPTIONS`；
  - Mac：`~/Library/Application Support/vbk-electron/DevToolsActivePort` 存在，修改时间为 2026-10-31 02:06；另有 `~/Library/Application Support/CrashReporter/TripVendorLauncher_*.plist`，说明此前 Mac 上也开启过 CDP。
- 影响 [推断]：
  - Chromium 的 DevTools HTTP/WebSocket 端点没有鉴权。本机任意进程（包括其他用户会话的进程，loopback 对所有本地用户开放）读取 `DevToolsActivePort` 或扫描端口后，就能对所有已登录页面执行任意 JS、导出 Cookie。
  - 叠加 SEC-01 的 `webSecurity:false`，能读取的范围会跨越所有源。
  - 插件自己的 helper 有身份、loopback、握手校验，但这些只保护 helper，不保护 Chromium 端口。
- Tauri 重构：翻译、套餐速览、订单查询作为内置功能，通过 IPC 实现，彻底去掉调试端口（这也是历史文档的既定方向）。

#### PLG-02 · 改写 app.asar，与官方更新冲突（P2，插件/两者交互，Win，新发现）

- 证据 [事实]：`resources/TripVendorCompanion.Install/receipt.json` 中：
  - `kind=trip-vendor-windows-injection-v1`、`version=0.5.41`；
  - `originalAsarSha256=e1cd32d3…`，与 `original.asar` 实测一致；
  - `patchedAsarSha256=f3f60007…`，与当前 `app.asar` 实测一致；
  - `vendorFiles` 记录的 5 个渲染层文件哈希与实测一致；
  - **`rebaseOfficialUpdate=false`**；
  - 备份的 `original.asar` 有 350 848 347 B，安装目录额外占用 335 MB。
- 影响 [推断]：
  - 官方 NSIS 更新会覆盖 `app.asar`，插件随之失效，需要重新注入；
  - 官方热更新（SUP-01）只替换 `userData/dist`，可能与插件依赖的页面结构不一致，导致面板挂载失败；
  - 双份 asar 浪费磁盘空间。
- Tauri 重构：新客户端内置这些能力，不再存在外部注入。

#### PLG-03 · 伴随程序的供应链风险（P2，插件，Win，新发现）

- 证据 [事实]：
  - `旅游商家助手.exe` 的 sha256 为 `bb9cf9ae…`，大小 245 590 016 B，`inspect-pe-certificates` 结果 `ev_9e8e3253…` 显示**无签名**；
  - 内置 `Chrome/152.0.7977.149 Electron/44.7.2`；
  - fuses（`ev_1c992daf…`）为 RunAsNode、NODE_OPTIONS、inspect 全开，asar 完整性关闭，`GrantFileProtocolExtraPrivileges` 开启；
  - 带有 `default_app.asar`；
  - 整个目录 496 MB。
- 影响 [推断]：第二个 Electron 运行时常驻，资源占用翻倍；无签名加上 fuse 未加固，存在被同目录劫持的风险。
- Tauri 重构：不再需要伴随进程。

#### PLG-04 · 当前 Mac 包没有被注入（P3，事实更正，Mac，与前提冲突）

- 证据 [事实]：
  - `/Applications/旅游商家桌面版.app` 执行 `codesign --verify --deep --strict` 通过，`spctl` 显示 `Notarized Developer ID`；
  - `Contents/MacOS/旅游商家桌面版` 只有 36 656 B，是官方的 x86_64 Electron 启动桩：LLD 17、SDK 13.3，签名者为 Ctrip；
  - `Resources/` 下没有 `companion/`，`mdfind` 也没有找到 TripVendorLauncher.app；
  - 只留下了 CrashReporter 记录和 `DevToolsActivePort`（PLG-01）。
- 结论：任务前提中「Mac 包被 TripVendorLauncher/companion 注入」**不适用于本次检测的安装包**，Mac 上的所有结论都属于纯官方 1.2.13。插件的 Mac 注入是历史状态，后来已经被官方重装覆盖 [推断]。

## 4. 与历史缺陷文档复核对照

对照对象：`docs/02-current-client-defects.md`（2026-10-30 版）。

| # | 历史结论 | 本次结果 | 对应 ID / 证据 |
| --- | --- | --- | --- |
| 1 | 无条件 `disable-site-isolation-trials` | **复核一致**。补充：Win 插件追加了 `site-per-process`，把它抵消了 | SEC-02；index.js L87@273818；bootstrap L313 |
| 2 | 无条件 `disable-http2`，并对携程域开 `ignore-connections-limit` | **复核一致**（PROD 和非 PROD 的域名清单不同） | SEC-10；L87@273770/@273882 |
| 3 | 7 处 `webSecurity:false` | **复核一致**（7 处字面量）。**补充** 1 处条件式：所有非设置页的 BrowserView 实际都是 false | SEC-01；L87@254551 |
| 4 | 每账号一套 BrowserView 加持久分区 | **复核一致**，未见上限或 LRU | STA-05 |
| 5 | 主进程负担重（better-sqlite3、窗口、IPC） | **复核一致**。补充：IPC 直接执行 renderer 传入的 SQL，同时有同步 IO | STA-04 |
| 6 | 包体臃肿：351 MB、617 个包、带 heapdump | **复核一致**。Win 原件 350 848 347 B，617 个顶层条目；Mac 1.2.13 增长到 364 MB、656 个。heapdump 存在但未被引用 | STA-07、MNT-04 |
| 7 | 官方页面长任务（123 s 内 130 个） | **静态无法复核** [未知]：属于运行时性能样本 | — |
| 8 | Electron 27.3.11 / Chromium 118 | **复核一致** | SEC-11 |
| 9 | Win NUL 检测失败时进入降级模式 | **复核一致**（只在 win32 下执行）。补充：GPU 崩溃后的降级是永久的 | STA-06 |
| 10 | Win7 或用户设置关闭硬件加速 | **复核一致**（`os.release().startsWith("6.1")||disableGPUAcceleration`） | STA-06；L87@272967 段 |
| 11 | 托盘 500 ms、提示窗 1 s 轮询 | **复核一致**。补充：autoLogin 200 ms 轮询没有超时；安装监测 1 s 一次 readFileSync | STA-03 |
| 12 | 关窗只是隐藏（原证据为插件 README） | **复核一致**，已有代码证据，Mac 同样如此 | STA-09 |
| 13 | Mac x64 走 Rosetta，有 ArchGuideWindow | **复核一致**。补充：`config.arch=arm64` 与实际不符 | STA-08 |
| 14 | Mac 内存压力 8–9 GB | **静态无法复核** [未知] | — |
| 15 | BrowserView 挂载与后台节流问题 | **静态无法复核** [未知]。代码中只有 1 处 `backgroundThrottling:false`（L52@204721） | — |
| 16 | Mac 的 `TripVendorLauncher` 和 `Resources/companion/` 属于插件注入 | **与已有结论冲突**：当前 Mac 包签名和公证有效，没有 companion，只留下历史痕迹 | PLG-04 |
| 17 | Win `trip-vendor-bootstrap.cjs` 和 `companion-vendor-original-main.json` 属于插件 | **复核一致**（rea facts 中 electron-main 的 `declared_path=trip-vendor-bootstrap.cjs`） | ev_e339a25b…；PLG-02 |
| 18 | `--remote-debugging-port` 和 CDP 注入属于插件 | **复核一致**（Mac 也有 DevToolsActivePort 痕迹） | PLG-01 |

- 统计：一致 14 条，冲突 1 条，静态无法复核 3 条。
- **新发现 30 条**：
  - SEC：03、04、05、06、07、08、09、12、13、14；
  - SUP：01、02、03、04、05、06；
  - PRI：01、02、03、04、05、06；
  - STA：01、02、10；
  - MNT：01、02、03；
  - PLG：02、03。
- 另一处「冲突」不属于历史文档，而是针对 rea summary：它把 4 处 integrity contradiction 记为「observed bytes are untrusted」，本报告认定这 4 个文件是官方构建后 codesign 改写的结果（SUP-04）。

## 5. 重构「必须根除」清单

按优先级排列。每条都对应可验证的门禁，可以并入 G0 或发布验收。

| 优先级 | 根除项 | 对应 | 验收门禁（可自动化） |
| --- | --- | --- | --- |
| 1 | 不做运行时远程替换前端资源；如有热更新，必须 HTTPS 加 ed25519 验签，迁移 SQL 只用内嵌资源 | SUP-01 | 代码中不存在 `http://` 下载；更新包必须带 `.sig` 并通过二进制内置公钥校验 |
| 2 | 任何场景都不关闭 TLS 校验，也没有「忽略证书」的代码路径 | SUP-02、SEC-06 | grep/clippy 规则禁止 `danger_accept_invalid_certs`；发布包不含测试环境开关 |
| 3 | 凭据只放系统密钥库，配置和日志中不出现密码或 ticket | PRI-01、PRI-05 | 启动后扫描配置目录，不能出现口令或 ticket 字段；日志中 secret 类型强制打码 |
| 4 | WebView 安全默认值不得放开：同源策略、站点隔离、严格 CSP，不剥离服务端安全头 | SEC-01、SEC-02、SEC-03 | 配置快照测试：CSP 中不含 `*` 和 `unsafe-eval`；不存在禁用隔离的参数 |
| 5 | 远程页面零 IPC 能力；本地 command 逐个校验调用窗口；敏感能力不暴露给 WebView | SEC-07、SEC-08 | Tauri capability 清单审查：remote URL 的 capability 为空 |
| 6 | 去掉调试端口和生产 DevTools，不接受 Node/调试类启动参数 | PLG-01、SEC-04、SEC-12 | 发布构建 `devtools` feature 关闭；启动参数白名单测试 |
| 7 | 两平台全量签名：Win Authenticode 覆盖所有 PE，Mac 公证且不加 cs 例外 entitlements；updater 必须验签 | SUP-03、SEC-05、SUP-06 | CI 中 `signtool verify /pa`、`codesign -d --entitlements`、`spctl` 全部通过才允许发布 |
| 8 | 子进程/连接监管：指数退避、外部熔断计数、单一重连状态机 | STA-01、STA-02 | 故障注入测试：子任务连续崩溃 20 次时，重启间隔单调递增，并在上限处熔断 |
| 9 | 主线程零同步 IO：数据库放专用线程，查询分页并设超时；轮询改为事件驱动 | STA-04、STA-03 | 主线程阻塞检测：任何 IPC 处理 >50 ms 告警；定时器清单评审 |
| 10 | 依赖与产物最小化：去掉死依赖和不被调用的可执行文件，单一 SQLite 引擎，原生双架构 | SUP-05、STA-07、STA-08、MNT-02 | `cargo udeps`/knip 结果为 0；安装包体积门禁；`lipo -archs` 断言 |

另外建议同步处理，但不进入 Top 10：

- 权限请求默认拒绝（SEC-09）；
- 深链参数白名单（SEC-14）；
- 崩溃上报征得同意并剥离 PII（PRI-03）；
- 本地缓存加密并设 TTL（PRI-02）；
- 硬件加速降级不持久化（STA-06）；
- 缓存目录按版本清理（STA-10）；
- source map 只上传到符号服务器（MNT-01）；
- 生产包不出现内网域名（PRI-04）。

## 附录 A · rea 命令原文

运行环境：rea 6.8.0，`export NODE_OPTIONS=--max-old-space-size=14000`（投影 500 MB 以上的 evidence 时需要大约 9.2 GB 堆来做认证）。输出文件都在 `~/tools/rea-work/defects/`。

```bash
R=~/tools/rea/rea
E_MAC=~/tools/rea-work/mac/main-graph.evidence.json
E_WIN=~/tools/rea-work/win/main-graph.evidence.json

# 1) Electron 事实投影（IPC / contextBridge / native-addon / endpoint / electron-main）
for p in mac win; do
  $R inspect-analysis-view --format json "{\"source\":{\"kind\":\"evidence-file\",\"path\":\"$HOME/tools/rea-work/$p/main-graph.evidence.json\"},\"view\":{\"kind\":\"javascript-facts\",\"where\":{\"kinds\":[\"ipc-channel\",\"ipc-handler\",\"context-bridge-api\",\"native-addon\",\"endpoint\",\"package\",\"electron-main\",\"browser-window\",\"worker\",\"storage\",\"electron-utility\"]},\"property_keys\":[\"channel\",\"channel_expression\",\"invocation_location\",\"mode\",\"operation\",\"resolution\",\"side\",\"handler_kind\",\"handler_location\",\"api_key\",\"api_key_expression\",\"api_status\",\"members\",\"resolution_basis\",\"unknown_members\",\"world\",\"endpoint_kind\",\"interpretation\",\"mechanism\",\"value\",\"path\",\"file_kind\",\"vendor_markers\",\"bytes\",\"unpacked\",\"main\",\"name\",\"version\",\"declared_path\",\"resolved_path\",\"resolution_status\"],\"limit\":3000}}" > $p-facts-full.json
done
# 结果：mac ev_09aad3bebababe9a52a4b86572c8af7f34e2129eb4b222bd84d425ce96587b00
#       win ev_e339a25b40f434f392ad09d42ffb5a8e59db2dfc20f59fa8d44c85819a21e276（各 149 行，exhausted）

# 2) Fuses
$R inspect-electron-fuses "/Applications/旅游商家桌面版.app"                                     # ev_a4a3c4a69d2380802fea038f13e7b045a249063a0bfde4b4f00943a4b05338f1（已有 fuses.json）
$R inspect-electron-fuses "$HOME/Downloads/vbk-electron/旅游商家桌面版.exe" --format json          # ev_c7820928d68d1fd8cdbab5452913e1a40bfdec84e0715660be2f010801dc53b2
$R inspect-electron-fuses "$HOME/Downloads/vbk-electron/resources/TripVendorCompanion/旅游商家助手.exe" --format json  # ev_1c992daf94236fcaf38c7413b83d70fe94ec76e2027de13de90da6adf342671a

# 3) Mac 签名 / plist / Mach-O
$R inspect-signature "/Applications/旅游商家桌面版.app" --format json                              # ev_530ea95461004d6880bbc87d5b2108e140da6733aa2126de6c51abec2c63e5d3
$R inspect-plist "/Applications/旅游商家桌面版.app" --format json                                  # ev_88f380cff8171fe1001dbf5e2eedbb39aef30999fc6a8e3ef73b4b58a2cd67cb
$R inspect-macho "/Applications/旅游商家桌面版.app/Contents/MacOS/旅游商家桌面版" --format json      # ev_8a2669b81558088c45c0f879a236ee0ef2f8021da0230b1ecacf00501d84e537

# 4) Windows PE 证书与加载配置
$R inspect-pe-certificates "$HOME/Downloads/vbk-electron/旅游商家桌面版.exe" --max-file-bytes 400000000 --format json   # ev_d43a0daaed0f90c16e914e32df90554b532d9be675afd4584567ecb1b813091d
$R inspect-pe-certificates "$HOME/Downloads/vbk-electron/resources/elevate.exe" --format json                         # ev_e08584740b0641bb0d6f0f13f04a4e789e9f1b479d2b6f9ad7130113cae78ecb
$R inspect-pe-certificates "$HOME/Downloads/vbk-electron/Uninstall 旅游商家桌面版.exe" --format json                   # ev_8ef03f922270d7bcea1505a3c0596e7d117a26dc2a818d15bca76a1af6e40feb
$R inspect-pe-certificates "$HOME/Downloads/vbk-electron/resources/TripVendorCompanion/旅游商家助手.exe" --max-file-bytes 400000000 --format json  # ev_9e8e32531cce8f9c6dedce36a14cb81c55d48dffdc3420c43e921c69c351a514
$R inspect-pe-load-config "$HOME/Downloads/vbk-electron/旅游商家桌面版.exe" --max-file-bytes 400000000 --format json    # ev_fb32c6d4722c5bafbec2bf0c76edf81eb493ad465fcf4f21677414216108f1b4
$R inspect-pe-load-config "$HOME/Downloads/vbk-electron/resources/elevate.exe" --format json                          # ev_aa8d817b462554dbda677753befe461a9ca957474fd7b8814f3991215232bd3b

# 5) 本地数据库（只取 schema inventory，不读行）
$R inspect-sqlite-database "$HOME/Library/Application Support/vbk-electron/vbk.db" --format json   # ev_a47d77ecb0d7d136061c48e3a75124dd4c96a89a9ed2415022a88b80c75a4734
```

已有证据（本轮直接引用，未重新生成）：

| 证据 | ID |
| --- | --- |
| Mac 主进程 | parent `ev_0d0218b400a7a5608f4e0404916eac9a042467676ca7d8f08190389648ba3467`，summary `ev_9b907b375d4bccb288c074382f2a90fc96a8e468fc848e11713a8c6909c275b6` |
| Win 主进程 | parent `ev_a689526ad568cd57810466e4bf9c3ce0c5d4b8a98020f13ebac3eaec238166c5`，summary `ev_4b66bb9d909672d0a8429fbfb263585e98f0d72caf34d8f2b01e30f745eed343` |
| Mac 桌面清单 | `ev_6cd119e440ba0bfe0fedb50051710db9c13d479e741b954cc7fd44c306d66bcf` |

非 rea 的只读辅助命令：

- 系统工具：
  - `codesign --verify --deep --strict --verbose=2 <app>`
  - `spctl -a -vv -t exec <app>`
  - `codesign -dv <4 个原生文件>`
  - `shasum -a 256`
  - `plutil -extract CFBundleVersion raw`
- 字节检索脚本：`python3 -I ~/tools/rea-work/defects/scripts/anchors.py <index.js>`，生成锚点表 `defects/anchors.txt`；`python3 -I ~/tools/rea-work/defects/scripts/g.py <正则> <上下文> <文件…>`。两个脚本都只读取目标文件。
- 本机数据只统计结构和计数，例如 `config.json` 的键名、类型和长度，`main.log` 中的关键字计数，不输出任何值。

### 已知局限

- 主进程的语义图已经触及 rea 的节点和 unknown 上限（各 100 000），而且 `trace-*` 系列需要内联完整的 evidence（500 MB 以上），所以没有使用。调用链和定时器结论依据字节检索加人工阅读。
- 渲染层（`dist/js/*.js`）只做了 CSP 检查和密钥扫描，前端结构由另一份报告负责。
- 所有「影响」都是静态推断，没有做中间人、崩溃注入等动态复现；每个问题都给出了复现方法，可以在隔离环境中执行。
