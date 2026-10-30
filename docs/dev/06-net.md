# 06 网络（core-net）

> **范围已变更（2026-10-30）**：以[网页版范围决定](../decisions/2026-10-30-web-only-scope.md)为准。只做目标网页已有的消息、通知和订单联系入口；网页没有的功能不做。本文超出该范围的桌面对齐、扩展功能与验收要求均作为历史参考，不再执行。

2026-10-30

本文是 [开发总纲](00-architecture.md) 下的模块文档，负责 Rust 核心模块 core-net。命名、通道、权限、错误码规则以总纲为准。

出处约定：`main/index.js` 指官方 1.2.12 解包后的 `dist-electron/main/index.js`，`preload/*.js` 指 `dist-electron/preload/`，`js/*.js` 指渲染进程产物 `renderer-dist/js/`。文件是压缩代码，出处写的是可以 grep 到的关键字。

## 一、结论与定位

- **core-net 是 Rust 业务请求的统一 HTTP 客户端**。Rust 侧所有出站请求（业务接口、Shark 词条、qconfig、更新检查、上传下载、助手接口）都经过它，共用一套连接池、代理、TLS 配置、超时与日志脱敏。
- **WebView 里的请求不归 core-net 管**。远程 vbooking 页面和本地页面自己发的 `fetch` 走 WebView2 的网络栈，用 WebView 自己的 Cookie。core-net 只负责“需要 Rust 带账号 Cookie 代发”的请求，以及让 WebView 与 Rust 的代理、环境设置保持一致。
- **Cookie 的真相源分两层**：WebView Profile 是浏览器 Cookie 的真相源；core-account 是登录凭据（bticket 等）的真相源；core-net 每账号持有一个内存 Cookie Jar，只是二者的镜像，不落盘。
- **官方的三个启动参数不照搬**：`disable-http2` 默认不再加，`ignore-certificate-errors` 所有构建都不加；测试环境通过受限测试 CA 信任配置解决，`disable-site-isolation-trials` 归 core-shell 处理（不加）。
- **给前端的 `fetch` 命令是受限代理**：只给明确授权的可信本地 WebView，按端点注册表限制只读业务请求；前端不能自带 URL、登录 Cookie 或任意头，响应里的 `Set-Cookie` 由 Rust 吸收，不回传。
- **TLS 默认用 native-tls（Windows SChannel）**，原因是企业代理和自签证书装在系统证书库里，SChannel 天然信任；rustls 作为可选特性保留，需要时配合系统证书验证器。

### IM SDK 的现存例外（2026-10-30 核对）

若一期保留 Node SDK，SDK 自带 HTTP 客户端，Node 分支以 `head.auth` 携带 token、`withCredentials:false`，负责 `/11679/SendMessage.json` 等请求，不能由业务 Cookie Jar 表解释。此时全应用并非只有一个 HTTP 实现。选型时须二选一：保留 SDK HTTP 并统一下发代理、超时、TLS 校验与脱敏策略；或实现显式请求转发适配，将请求交给 core-net，验证响应/重试语义一致后再宣称统一。不能直接给 SDK 套 Cookie 请求。参见 [静态证据](../research/2026-10-30-client-im-static-evidence.md) 与 [选型决策](../decisions/2026-10-30-im-transport.md)。

## 二、承接范围

### 2.1 官方 IPC 与相关代码

| 官方接口或代码 | 现状（出处） | 新设计中的去向 |
| --- | --- | --- |
| `netFetch`（`net_fetch`） | `main/index.js` 中 `f.ipcMain.handle(y.netFetch,…)`。校验发送方是本地页面（`Rt(n,"netFetch")`，名单 `bu`），URL 必须是 http/https 且命中域名白名单 `eu`（`Ot(e)`）。用 `n.session.cookies.get({url})` 取发送方会话的 Cookie，再合并调用方传入的 `cookies`；其中 `bticket/bduid/vbkticket/ticket`（集合 `Eu`）只有 login、launch、main 三个页面（`Ri`，名单 `Cu`）可以覆盖。用 `electron.net.request({useSessionCookies:false})` 发出，失败或非 2xx 一律返回 `null`；响应的 `Set-Cookie` 由 `_u` 写回发送方窗口会话（域 `.ctrip.com`，有效期一个月）。结果按 JSON 解析返回 | `plugin:net\|fetch`（受限，见 4.6）+ Rust 内部 `NetService` |
| 公共请求头 | `Tu()`：`Content-Type: application/json`、`x-ctx-locale`（当前语言）、`x-tour-auth-from: vbk_online` | 由 core-net 统一注入，见 4.5 |
| 主进程内部请求 | `Ou()`（GET，超时 1500 ms，用于读 `static.tripcdn.com/packages/…/packageVersion.json` 检查热更新）、`Mu()`（POST，用于 Shark `getLangDump`） | 改为调用 `NetService`，由 core-update、core-telemetry 使用 |
| `changeEnv`（`change_env`） | 只在非 production 构建生效；取值限 `FAT/UAT/PROD`，写入 electron-store 键 `ENV_STORE_KEY` 后 `app.relaunch()`。开发菜单“运行环境”也是同一逻辑（`["FAT","UAT","PROD"].map`）。production 构建固定 `PROD` | `plugin:net\|set_env`，仅开发构建开放 |
| `commonWebOption`（`common_web_option`） | **与网络无关**。实为对发送方 `webContents` 执行 copy、cut、paste、undo、redo、selectAll、findInPage 等编辑操作 | 不归 core-net；建议总纲把它划给 core-shell（编辑菜单与页内查找） |
| 系统代理 | 偏好项 `useSystemProxy`，**默认 `false`**。启动时 `defaultSession.setProxy({mode: rm?"system":"direct"})`；偏好变化时 `syncSessionProxy()` 对默认会话和每个账号 BrowserView 的会话设置代理并 `closeAllConnections()`（`syncProxyMode`） | 默认跟随系统代理，见 4.3 |
| 网关选择 | 偏好项 `gateway`，候选 `GATEWAY_DOMAIN_LIST = ["m.ctrip.com","online.ctrip.com","sec-m.ctrip.com"]`（`constant-*.js`）。登录窗口“网络设置”弹窗会对每个网关请求 `/restapi/soa2/12405/checkhealth` 显示在线状态（`js/loginWindow-*.js`） | 网关作为 `EnvProfile` 的一部分，运行时可切换 |
| `networkOptimization` | 偏好默认 `true`，设置弹窗有开关，但主进程中**没有找到使用点** | 不承接，待确认（见第十一节） |
| 启动参数 | `appendSwitch("disable-http2")`、`appendSwitch("ignore-connections-limit", ".ctrip.com,.c-ctrip.com,.tripcdn.com,.trip.cn")`（测试环境把 `.trip.cn` 换成 `.qa.nt.ctripcorp.com`）、非 PROD 时 `appendSwitch("ignore-certificate-errors")` | 见 4.8 与第八节 |

### 2.2 session.webRequest 与 Cookie 写入点

| 位置（`main/index.js`） | 做了什么 | 新设计 |
| --- | --- | --- |
| 账号会话 `m.webRequest.onBeforeRequest`（登录成功创建 `persist:<buid>` 分区之后） | 1. 把 `file://webresource.c-ctrip.com/*`、`file://static.tripcdn.com/*` 等 6 个静态资源域的请求重定向为 `https://`；2. 若用户选了 `gateway`，把发往 `https://<GATEWAY_DOMAIN_LIST>/restapi/soa2/` 的请求重定向到所选网关 | 1 是本地页面用协议相对地址 `//` 时在 `file://` 下被解析错的补丁，新客户端本地页面走 `tauri://`，统一写 `https://`，不再需要；2 见 4.4 |
| BrowserView `webRequest.onHeadersReceived`（每账号业务视图） | 对 `IFRAME_WHITE_DOMAINS = [".ctrip.com",".qa.nt.ctripcorp.com",".trip.com"]` 的响应删除 `X-Frame-Options` 与 `Content-Security-Policy` | 归 [04 业务页承载](04-business-pages.md) 决定；core-net 不改写远程页面响应头。如确需嵌入，优先改为顶层子 WebView 而不是 iframe |
| 登录成功处理 | 读取 `defaultSession` 的全部 Cookie，加上 `bticket`、`vbkticket`（同值）、`BDUID`，用 `zt()` 写入 `persist:<buid>` | core-account 负责，core-net 镜像，见 4.2 |
| `zt()` | 把给定 Cookie 同时写到 soa2 网关域与 trip 域：PROD 为 `.ctrip.com`、`.trip.com`，测试为 `.qa.nt.ctripcorp.com`、`.qa.nt.tripqate.com`；`httpOnly:false`、`sameSite:no_restriction`、有效期一个月 | 仅按实际服务契约保留 Cookie scope，不能继承官方跨 `.ctrip.com/.trip.com` 扩域；网页登录已观测 ticket 为 HttpOnly |
| `initUbt` | 生成 `clientId` 后写 Cookie `GUID` 到默认会话和每个账号分区 | `GUID` 由 core-telemetry 生成，core-net 注入每账号 Jar |
| Shark 切换语言 | 写 Cookie `vbk-locale-lang` 到所有分区 | 同上，由 core-net 注入 |

### 2.3 环境与域名（能查到的）

| 用途 | FAT | UAT | PROD | 出处 |
| --- | --- | --- | --- | --- |
| soa2 网关（携程） | `gateway.m.fws.qa.nt.ctripcorp.com` | `gateway.m.uat.qa.nt.ctripcorp.com` | `m.ctrip.com` | `main/index.js` 常量 `Vo`；`js/ubt-*.js` 常量 `Pe` |
| soa2 网关（Trip） | `www.fws.qa.nt.tripqate.com` | `www.uat.tripqate.com` | `cbooking.trip.com` | 常量 `ou` |
| vbooking 站点 | `vbooking.ctrip.fat29/fat30/fws.qa.nt.ctripcorp.com` | `vbooking.ctrip.uat.qa.nt.ctripcorp.com` | `vbooking.ctrip.com` | `mp`（Shark）、`No`（qconfig）、`yp`（vbkChat 正则） |
| IM 页面 | `imvendor.fat44.qa.nt.ctripcorp.com` | `imvendor.uat.qa.nt.ctripcorp.com` | `imvendor.ctrip.com` | 常量 `Lo` |
| 热更新静态资源 | `static.fws.qa.nt.ctripcorp.com` | 同 FAT | `static.tripcdn.com` | 常量 `wo` |
| Cookie 域 | `.qa.nt.ctripcorp.com`、`.qa.nt.tripqate.com` | 同 FAT | `.ctrip.com`、`.trip.com` | `_u`、`zt` |

FAT 环境还有按服务号追加 `subEnv` 的规则（`js/ubt-*.js` 中 `M={21028:"fat29",12405:"fws",17264:"fat29",15529:"fat29",35240:"fat30"}`），URL 形如 `/restapi/soa2/<服务号>/<方法>?subEnv=fat29`。

## 三、Tauri / Rust 分工

| 能力 | 放 Rust（core-net） | 放 WebView 前端 |
| --- | --- | --- |
| 带账号 Cookie 的业务请求 | 统一策略、按目标域/用途分池、Cookie Jar、端点级请求/响应适配、重试 | 只调用 `plugin:net\|fetch` 或各业务模块命令 |
| 远程页面自己的请求 | 不参与，只保证 WebView 与 Rust 使用一致的代理与环境 | WebView2 网络栈 |
| 代理与 PAC | 读取系统设置、解析 PAC、监听变化、给 reqwest 下发 | 网络设置页展示与修改 |
| 环境与网关 | `EnvProfile` 计算与持久化、广播 | 开发菜单、网络设置页 |
| 网络状态 | 系统网络事件 + 主动探测，发 `net://online-changed` | 横幅提示“网络已断开” |
| 上传下载 | 提供共享客户端给 core-media | 进度条 UI |
| 日志 | 请求日志脱敏后交给 core-telemetry | 无 |

## 四、Rust 核心设计

### 4.1 结构与状态

core-net 按总纲 4.5 的 actor 写法组织：一个状态任务持有配置，读多写少的部分用 `watch` 通道发布。

```rust
pub struct NetState {
    env: EnvProfile,                         // 环境 + 网关 + 域名表，watch 发布
    proxy: ProxyMode,                        // System | Direct | Manual(url) | Pac(url)
    clients: HashMap<AccountContext, AccountClient>, // 账号代次独立 Jar；按网络策略复用连接池
    online: OnlineState,                     // Online | Offline | Degraded，带 seq
    seq: u64,
}
pub trait NetService: Send + Sync {
    fn client(&self, scope: RequestScope, policy: EndpointPolicyId) -> Result<AccountClient, AppError>; // 禁止默认当前账号；匿名更新与带账号业务明确分开
    fn env(&self) -> watch::Receiver<EnvProfile>;
    fn online(&self) -> watch::Receiver<OnlineState>;
}
```

连接池按 TLS/代理/重定向策略复用，不以“全应用只能有一个 Client”为硬约束。账号 Jar 按完整 AccountContext 隔离；Cookie 在每一跳发送前按目标 URL 的 domain/host-only/path/secure/expiry 过滤。匿名更新、CDN 与助手服务不得继承携程 Cookie/鉴权头。切换 UI 当前账号不会改变任何在途请求的 scope。

### 4.2 Cookie Jar 与 WebView Cookie 的同步

| Cookie | 真相源 | 同步方向 | 说明 |
| --- | --- | --- | --- |
| `bticket`、`vbkticket`、`BDUID`（登录凭据） | core-account（系统凭据库） | 登录：WebView → core-account → core-net Jar；续期：Rust 响应 `Set-Cookie` → core-net → core-account → WebView | 应用侧写入统一经 core-account；远程服务器/浏览器也会更新 Profile，不能声称核心是浏览器的唯一写者 |
| `GUID`（clientId）、`vbk-locale-lang` | core-telemetry、偏好 | Rust → Jar 与 WebView | 启动时与切换语言时下发 |
| 其他站点 Cookie（风控、AB、埋点等） | WebView Profile | 按需：Rust 发请求前从该 scope 的 Profile 读取该精确 URL 可见的 Cookie 合并（只读） | 官方 `netFetch` 也是先读会话 Cookie 再合并 |

规则：

1. core-net 的 Jar **不落盘**。重启后先由 core-account 校验存储的凭据/Profile 归属和状态；凭据库与 Profile 冲突时进入验证，不能盲目用旧 keyring 值覆盖浏览器的新值。
2. Rust 收到的 `Set-Cookie` 只吸收白名单内的名字（上表前两行 + 配置项），其他丢弃并仅计数；不扩大原响应 host/domain/path/expiry 属性。删除 Cookie（Max-Age=0/过期）也需同步。未知 Cookie 依赖必须通过端点验证后显式加入。
3. 写 WebView Cookie 依赖 Tauri 2 的 `Webview::set_cookie` / `cookies_for_url`（以锁定版本 API 为准）；不可用时退回 `with_webview` 取 `ICoreWebView2CookieManager`。Tauri 文档提示在 Windows 上于同步命令中调用 Cookie 接口可能死锁，必须在异步任务里调用。
4. 每次 Set-Cookie、认证失败与校验返回都带请求 scope/credential_revision；core-account 比较后更新，旧代次不得写回凭据或作废新登录。
5. 每个账号对应一个 WebView2 Profile 或独立目录（总纲第六节），core-net 按 `(environment, account_id, session_generation) → Profile` 定位要读写的 Cookie 存储。

### 4.3 TLS、代理与 PAC

**TLS 取舍**

| 方案 | 企业 MITM 代理、自签根证书 | HTTP/2 | 体积与维护 | 结论 |
| --- | --- | --- | --- | --- |
| reqwest + `native-tls`（SChannel） | 使用系统证书库；与 WebView2 的代理/验证细节仍需实际对照 | 需开 `native-tls-alpn` 特性（需验证 SChannel ALPN 在 1809 上可用） | 使用系统 TLS；最终包体须测量 | **默认** |
| reqwest + `rustls` + `rustls-platform-verifier` | 通过平台验证器使用系统证书库，效果接近 SChannel | 原生支持 ALPN h2 | 增加约 1–2 MB，需跟进 rustls 版本 | 可选特性，macOS 阶段再评估 |
| reqwest + `rustls` + `webpki-roots` | 不信任企业根证书，企业网络会全部失败 | 支持 | — | 不采用 |

测试环境证书：所有构建禁止 `danger_accept_invalid_certs`、关闭主机名校验与全局 Chromium 证书绕过。显式测试 CA 仅加载到测试域专用客户端，并仍校验主机名/证书链；生产策略不加载测试根。证书失败就是可诊断失败，不自动降级。

**代理**

| 模式 | 行为 | 实现 |
| --- | --- | --- |
| `System`（新默认） | 读当前用户的 IE/WinINet 代理设置，含自动检测（WPAD）和 PAC 脚本 | `windows` crate 的 `Win32_Networking_WinHttp`：`WinHttpGetIEProxyConfigForCurrentUser` 取配置，`WinHttpGetProxyForUrl` 按 URL 解析 PAC；按完整目标 URL、网络代次与代理配置代次解析；缓存不得仅按主机（PAC 可依据 URL 路径返回不同结果）。解析在有界阻塞任务中执行，再选择匹配路由的 Client |
| `Direct` | 不走代理（官方默认就是这个） | `Client::builder().no_proxy()` |
| `Manual(url)` | 用户手填 | `Proxy::all(url)`，支持 Basic 认证（凭据进凭据库） |

说明与需验证项：

- reqwest 0.12 自带读取 Windows 注册表代理（`ProxyServer`/`ProxyEnable`），但**不支持 PAC 与 WPAD**，所以 `System` 模式要自己接 WinHTTP。也可评估现成 crate（如 `sysproxy`、`proxy_cfg`），它们大多只读静态代理，PAC 支持需验证。
- WebView2 默认使用系统代理（含 PAC），但不保证与 WinHTTP PAC、认证、失败回退一致，需按 URL/代理失败场景核验。`Direct` 或 `Manual` 时需要给 WebView2 传浏览器参数 `--no-proxy-server` 或 `--proxy-server=…`（Tauri 2 `WebviewWindowBuilder::additional_browser_args`，或 `proxy_url`，需验证 Windows 上是否映射为同一参数）。浏览器参数只在创建 WebView2 环境时生效，**改代理模式需要重启应用**，设置页要明确提示。
- 代理变化监听：订阅注册表 `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings` 变化（`RegNotifyChangeKeyValue`），变化后清 PAC 缓存并重建连接。
- SDK HTTP 与 WSS 是不同路径；给 sidecar 设置 `HTTP(S)_PROXY` 不证明 WSS 或 PAC 生效。必须验证各路径的 agent/proxy、系统 CA、认证、超时和证书拒绝；PAC 需要逐 URL 适配或明确不支持，不能静默直连。敏感代理凭据不放命令行或诊断输出。

### 4.4 环境切换与广播

`EnvProfile` 是第 2.3 节表格的结构化版本，所有模块通过 `NetService::env()` 读取域名，**禁止在其他模块里硬编码携程域名**。

```rust
pub struct EnvProfile {
    pub env: Env,                 // Fat | Uat | Prod
    pub gateway: Option<String>,  // 用户选择的 soa2 网关，None 表示默认
    pub soa_base: Url, pub trip_soa_base: Url, pub vbooking: Url,
    pub im_page: Url, pub static_base: Url,
    pub cookie_domains: Vec<String>,
    pub fat_sub_env: HashMap<u32, String>, // 服务号 → subEnv
}
```

| 变化 | 是否需要重启 | 广播 |
| --- | --- | --- |
| 环境（FAT/UAT/PROD） | 需要。Cookie 域、登录态、IM 地址全部不同，热切换收益小、风险高；沿用官方“写配置后重启” | 内部总线 `EnvChanging` 让各模块落盘，随后重启 |
| 网关 | 不需要 | `watch` 更新 + 事件 `net://env-changed`；Rust 请求立刻用新网关 |
| 代理模式 | 为避免 Rust/WebView/SDK 临时分流，一期统一保存 pending 配置后受控重启；重启前仍用旧策略 | `net://proxy-changed`，带 pending/restart_required |

远程页面的网关重定向：官方用 `onBeforeRequest` 把业务页发往默认网关的请求改到所选网关。Tauri 没有通用的请求拦截 API，要做只能 `with_webview` 注册 WebView2 的 `WebResourceRequested` 并返回重定向响应（需验证对 `fetch` 的 POST 是否可行）。建议一期**只对 Rust 请求生效**，远程页面保持默认网关，等确认网关选择的真实使用率后再决定。

### 4.5 公共头、请求体 head 与签名

源码中没有发现请求签名（HMAC 等），业务 HTTP 中已见 Cookie 鉴权；IM SDK 另有 head.auth/SASL 分支。以下是原客户端模板，不可统一套给所有接口；core-net 按注册的端点/版本使用明确模板：

| 项 | 值 | 出处 |
| --- | --- | --- |
| `Content-Type` | `application/json` | `Tu()` |
| `x-ctx-locale` | 当前语言，如 `zh-CN` | `Tu()`、`js/BaseController-*.js` 的 `post()` |
| `x-tour-auth-from` | `vbk_online`；取用户信息接口用 `merchants_online` | 同上，`getUserInfo` |
| 请求体 `head`（soa2） | `{cid: GUID, ctok:"", cver:"1.0", lang:"01", sid:"8888", syscode:"09", auth:"", extension:[]}` | `js/ubt-*.js` 函数 `gr`，`getVBKHead()` |
| 请求体 `head`（IM 类接口） | `{cver:"2", appId:"900004", extension:[cpc=pc, protocal=https, amp-product-type=IM, amp-account-source=VBK, client-source=pc-900004, locale]}` | `js/ubt-*.js` 函数 `pr`，`getHead()` |
| `User-Agent` | 建议与 WebView2 UA 保持同一产品标识并加 `vbk-desktop/<版本>` | 官方未设置（推断用 Electron 默认） |

响应按端点解析 HTTP 状态、`ResponseStatus.Ack`、完整 Errors、success/isSuccess、status/code 与必要字段；HTTP 200 或 Ack 成功不单独等于业务成功。`AccountsMobileRequestFilterException` 仅为现有客户端候选鉴权错误规则，实测确认后由对应端点适配器报告；不得把所有服务错误都当成账号过期。报告包含请求 scope 与 credential_revision，由 core-account 决定是否仍有效。

**ClockService（唯一跨模块计时源）**

core-net 的 ClockService 提供 `{server_epoch_ms, monotonic_anchor, uncertainty_ms, valid_until, quality}`，用请求往返时间与受信响应时间估计锚点。core-im 只按有效时间锚点与单调时钟驱动首次 T1，core-notify 驱动后续升级；修改墙钟、睡眠恢复、网络/时间源变化后将旧锚点标为待校准。时间字段的时区/单位与服务覆盖必须在端点层验证。离线保留估计和不确定度，不用“旧 offset + 新 Date.now”触发强提醒；恢复对账屏障由 core-im 负责。前端快照只展示质量与必要时值，不成为新的计时权威。

### 4.6 命令

| 命令 | 参数 | 返回 | 可用窗口 | 说明 |
| --- | --- | --- | --- | --- |
| `plugin:net\|fetch` | `{endpoint_id, scope, params}` | 端点声明的有限 DTO（不返回凭据字段/任意原始 body） | shell、im、login | 受限代理，规则见下 |
| `plugin:net\|status_snapshot` | — | `{scope, stream, epoch, seq, data:{connectivity, env, gateway, proxy_mode, clock_quality}}` | shell、im、login、setting | 快照 |
| `plugin:net\|set_gateway` | `{gateway: Option<String>}` | `()` | shell（setting） | 只能取 `GATEWAY_DOMAIN_LIST` 中的值 |
| `plugin:net\|probe_gateways` | — | `[{gateway, ok, rtt_ms}]` | shell、login | 调 `/restapi/soa2/12405/checkhealth` |
| `plugin:net\|set_proxy` | `{mode, manual_url?}` | `{restart_required}` | shell（setting） | |
| `plugin:net\|set_env` | `{env}` | `()` | 仅开发构建的 shell | 写配置并重启 |

`plugin:net|fetch` 的限制，防止它变成任意请求代理：

1. 仅可信本地 WebView 可调用，授权检查包含核心登记的 view_generation 与账号绑定；不能仅凭可伪造的 account 参数或窗口 label。
2. 前端只提交登记的只读 `endpoint_id`、scope 与参数；端点描述固定 HTTPS 精确主机/端口/路径/方法、参数 schema、身份模板、响应 DTO、限额。未知默认拒绝；写操作走对应业务模块专用命令。
3. 不采用 `.ctrip.com`/`.tripcdn.com` 整个后缀作为带凭据授权边界；CDN、更新与第三方分别是匿名或独立凭据策略。禁止 URL 内嵌用户名/密码（userinfo）、非预期端口、IP 字面量和任意头/超时覆盖。
4. 禁用自动重定向；必要重定向每一跳重新校验 URL/方法/Cookie scope，拒绝 HTTPS 降级和未登记跨源。POST 不自动在跳转时重放，重定向 hop 数有界。
5. 请求 ≤1 MB、解压后的响应 ≤5 MB，流式执行上限；仅检查 Content-Length 不足。端点 DTO 过滤 Set-Cookie、token、ticket 以及未声明敏感字段，不能仅过滤响应头。
6. 核心创建任务时冻结 scope，不默认“当前账号”；注销/重登后关闭 Jar 并拒绝所有旧代次响应。取消传输只是优化，不代替代次校验。

### 4.7 事件

| 事件 | 载荷 | 接收方 |
| --- | --- | --- |
| `net://online-changed` | `{online: "online"\|"offline"\|"degraded", since}` | 所有本地窗口 |
| `net://env-changed` | `{env, gateway}` | shell、im、setting |
| `net://proxy-changed` | `{mode, restart_required}` | shell、setting |

上表事件使用总纲 EventEnvelope；全局网络状态不含账号秘密，账号结果只能进入对应 scope 的内部/定向流。

内部总线（不出 Rust）：`NetEvent::Online(bool)`、`AuthExpired{scope, credential_revision}`、`CookieRenewed{scope, credential_revision, names}`、`EnvChanging`。

### 4.8 超时、重试、退避与 HTTP/2

| 类别 | 连接超时 | 总超时 | 重试 |
| --- | --- | --- | --- |
| 业务查询（幂等 GET、soa2 查询类 POST） | 5 s | 15 s | 最多 2 次，指数退避 300 ms × 2ⁿ，加 ±20% 抖动 |
| 写操作（提交、发送） | 5 s | 15 s | 不自动重试；超时/断连可能已执行，返回 outcome_unknown。调用方仅在已证实幂等或业务查询明确未执行时重试 |
| 健康检查、热更新元数据 | 3 s | 3 s（官方 `Ou` 是 1.5 s） | 不重试 |
| 上传下载 | 10 s | 无总超时，按 30 s 无进度判定超时 | 断点续传由 core-media 处理 |

- 仅表内已登记幂等查询对连接错误、超时、HTTP 502/503/504 重试；该规则不适用于写操作或 SDK 内部重试；4xx 不重试。系统“离线”仅为提示；允许用户触发有界探测/请求，避免 VPN 或 NLM 误判导致永远无法恢复。普通查询不离线排队；发送意图由 core-im outbox 管理。
- 重试用 `backon` 或 `reqwest-middleware` + `reqwest-retry` 实现（选型时比较依赖体积）。
- **HTTP/2 恢复**：reqwest 对 HTTPS 通过 ALPN 自动协商 h2。WebView2 默认启用 HTTP/2，不加 `--disable-http2`，也不需要 `ignore-connections-limit`（HTTP/2 单连接多路复用）。

`disable-http2` 原因推断（源码无注释）：

1. 企业或运营商代理、部分安全软件对 HTTP/2 支持差，出现 `ERR_HTTP2_PROTOCOL_ERROR`，一刀切关掉最省事；
2. 同时加了 `ignore-connections-limit`，说明关掉后遇到了 HTTP/1.1 每主机 6 连接上限造成的排队，印证 1 中的问题出现在携程自家域名上；
3. 测试环境网关对 h2 的支持不完整（推断）。

### 4.9 网络状态检测

| 信号 | 来源 | 用途 |
| --- | --- | --- |
| 系统连通性 | Windows Network List Manager（`windows` crate `Win32_Networking_NetworkListManager`，`INetworkListManagerEvents::ConnectivityChanged`）。`NotifyNetworkConnectivityHintChange` 需要较新的 Windows 10，不满足 1809 下限，不用 | 提供网络提示；不单凭该信号否定实际请求可达性 |
| 主动探测 | 系统报告在线后，请求当前网关 `/restapi/soa2/12405/checkhealth`；连续 3 次业务请求连接失败也触发一次 | 区分“连上了 Wi-Fi 但到不了携程”（`degraded`） |
| 防抖 | 状态需稳定 2 s 才广播 | 避免网卡切换时抖动 |

恢复在线时内部总线发 `NetEvent::Online(true)`，core-im 据此立即重连而不是等退避计时器。

### 4.10 日志脱敏

| 内容 | 处理 |
| --- | --- |
| URL | 保留主机与路径；查询串只保留键名，值替换为 `***`（`subEnv` 除外） |
| 请求头 | `Cookie`、`Authorization`、`Proxy-Authorization` 只记 Cookie 名列表 |
| 响应头 | `Set-Cookie` 只记名字与过期时间 |
| ticket 类值 | 不记录任何片段或稳定哈希；仅记录内部请求 ID 和 credential_revision |
| 请求与响应体 | 默认不记；调试只允许字段白名单的合成/脱敏 DTO，不能靠字段名黑名单保证客户正文/凭据安全 |
| 每条记录 | 方法、主机、路径、状态码、耗时、重试次数、`CLOGGING_TRACE_ID`（如果响应带） |

脱敏在 core-net 写日志前完成，用 `tracing` 字段级处理，core-telemetry 拿到的已经是脱敏数据。

## 五、前端设计

core-net 没有独立窗口，前端只涉及三处：

| 位置 | 内容 | 要求 |
| --- | --- | --- |
| setting 窗口“网络”页 | 网关下拉（显示探测结果）、代理模式（跟随系统 / 不使用 / 手动）、环境（仅开发构建） | 打开时调 `status_snapshot` 和 `probe_gateways`，探测并发、整体 ≤ 3 s；改代理时如需重启给出明确提示 |
| login 窗口 | 保留官方“网络设置”入口（登录失败时用户最需要） | 与 setting 共用组件 |
| 所有本地窗口 | 订阅 `net://online-changed`，离线时顶部横幅 | 横幅组件放 `ui-kit`，不阻塞页面；不再各自读 `navigator.onLine` |

前端 `netFetch(endpoint_id, scope, params)` 只包装已登记查询，不接受任意 URL/headers，不做重试。已有文档中的 URL 版 netFetch 仅是旧接口背景，不得按该签名实施。

## 六、与其他模块的联动

```mermaid
flowchart LR
  Acc[core-account] -- "登录凭据、账号增删" --> Net[core-net]
  Net -- "AuthExpired、CookieRenewed" --> Acc
  Tel[core-telemetry] -- "GUID" --> Net
  Net -- "脱敏日志" --> Tel
  Net -- "共享客户端" --> Media[core-media]
  Net -- "共享客户端、EnvProfile" --> Upd[core-update]
  Net -- "共享客户端" --> Asst[core-assistant]
  Net -- "Online、代理、EnvProfile" --> Im[core-im]
  Shell[core-shell] -- "WebView2 浏览器参数（代理）" --> WV[(WebView2)]
  Net -- "ProxyMode" --> Shell
```

| 模块 | 关系 |
| --- | --- |
| core-account | 启动顺序 net 在 account 之前（总纲 4.5）。account 就绪后调用 `NetService` 注册账号 Jar；切换账号只改“当前账号”指针，不重建客户端 |
| core-shell | 创建 WebView2 环境时向 core-net 取代理模式，转为浏览器参数 |
| core-media | 上传下载用创建时绑定 scope 与 media EndpointPolicy 的客户端，进度走 media 自己的 Channel |
| core-im | SDK HTTP/WSS 分别验证代理/TLS适配；恢复信号触发有界重连及对账 |
| core-update | 热更新元数据、安装包下载用共享客户端；更新签名校验不依赖 TLS 放宽 |
| core-telemetry | 提供 `GUID`；接收脱敏后的请求日志与成功率指标（对应官方 `o_vbk_desktop_req_success/fail`） |

## 七、关键流程

**带账号 Cookie 的请求**

1. 调用方提交端点 ID、创建时捕获的 AccountContext 与参数；匿名任务使用显式 Anonymous 策略。
2. core-net 校验来源授权与端点 schema，按 `EnvProfile` 构造精确 URL（相对路径拼网关，FAT 追加 `subEnv`）。
3. 验证 scope 仍有效，从该账号 Jar/Profile 取对目标 URL 有效的 Cookie，按最小凭据策略合并。
4. 按端点模板注入必要头/head，先解析代理再发送；重定向逐跳审查。
5. 重新核对 scope/revision 后才吸收候选 Set-Cookie；解析完整业务成功条件及必要字段，鉴权失败交 account 裁定。
6. 写脱敏日志，返回结果。

**登录后同步**

1. ui-login 中的网页登录完成，core-account 从该账号 Profile 读出 `bticket` 等并存入凭据库。
2. core-account 调 core-net 注册账号 Jar；core-net 写入 `GUID`、`vbk-locale-lang`。
3. core-net 按 02 第 4.1 节网页 `getCurrentUserInfo` 契约取 response.user，验证身份与 attempt；原客户端 main 的 getUserInfo 只作差异参考。account 完成跨存储提交后才发 ready/changed。

## 八、注意事项（Windows 优先）

- **SChannel 与 TLS 1.3**：Windows 10 的 SChannel 默认不启用 TLS 1.3，只到 1.2。携程网关支持 1.2，不影响，但要在 1809 上实测。
- **企业代理认证**：NTLM/Kerberos 代理认证 reqwest 不支持。WebView2 支持（走系统）。若客户现场有此类代理，Rust 请求会失败而网页正常，需准备排查话术，并评估改用 WinHTTP 发请求的兜底实现（需验证必要性）。
- **PAC 解析耗时**：`WinHttpGetProxyForUrl` 首次可能要下载 PAC 并执行，最长数秒；必须在阻塞线程池执行并缓存，不能放在命令同步路径上。
- **Cookie 接口死锁**：见 4.2 第 3 条。
- **官方默认直连**：官方 `useSystemProxy` 默认 `false`。新客户端改为跟随系统，可能让原本“绕过代理才能用”的用户受影响。迁移时读取旧偏好：旧值为 `false` 的用户保留 `Direct`。
- **不加全局证书放宽**：官方非 PROD 时全局 `ignore-certificate-errors`，新客户端不放宽验证，测试环境使用受限测试 CA。
- **时钟偏差**：回复倒计时使用 4.5 ClockService 的单调锚点与质量；Cookie 绝对到期时间与服务端实际有效性分开，不能靠旧 offset 判断 ticket 仍有效。

## 九、原型验证项与验收标准

| 编号 | 验证项 | 方法 | 验收标准 |
| --- | --- | --- | --- |
| N1 | HTTP/2 恢复 | WebView2 中打开业务页，DevTools Network 面板显示 Protocol 列；Rust 侧开启 `RUST_LOG=hyper=debug` 或打印 `Response::version()`；对照组为官方客户端（h1.1） | 携程主要域名协议为 `h2`；首页资源加载总时长较官方缩短；连续使用 1 天无 `ERR_HTTP2_*` 错误 |
| N2 | 企业代理与自签证书 | 搭 mitmproxy 或 Fiddler，根证书装入“受信任的根证书颁发机构”，系统代理指向它 | native-tls 下 Rust 与 WebView 请求全部成功；rustls + webpki-roots 对照组失败（证明取舍正确） |
| N3 | PAC 与 WPAD | 系统设置中配置 PAC 地址，脚本对 `*.ctrip.com` 返回代理、其他直连 | 同 host 不同 path 的 PAC 分流正确；网络/配置变化使缓存失效；代理拒绝时不静默直连；Rust、WebView、SDK HTTP/WSS逐项核验 |
| N4 | Cookie 同步 | 网页登录后，Rust 用该账号请求 `getUserInfo`；服务端续期 `Set-Cookie` 后刷新业务页 | Rust 请求成功；续期后 WebView 与凭据库中的值一致；两个账号互不串号 |
| N5 | 受限 fetch | 从远程页尝试 invoke；本地调用未知 endpoint、伪造 scope/代次；允许域返回跨域重定向或含恶意身份字段 | 远程页无权限，越权与未登记端点拒绝；重定向不带出凭据，响应不泄漏凭据 |
| N6 | 离线事件 | 拔网线、断 Wi-Fi、连上无外网的热点 | 2–3 s 内收到 `offline` 或 `degraded`；恢复后 IM 立即重连 |
| N7 | 日志脱敏 | 跑一遍登录、切账号、发消息后检查日志目录 | 搜不到完整 ticket、Cookie 值、密码 |

## 十、开发步骤与工作量估计

| 步骤 | 内容 | 人日 |
| --- | --- | --- |
| 1 | `NetService` 骨架、共享 `reqwest::Client`、`EnvProfile`、错误码映射 | 2 |
| 2 | 公共头与 `head` 注入、soa2 URL 拼装（网关、subEnv）、响应解析与服务器时间差 | 1.5 |
| 3 | 每账号 Cookie Jar、与 core-account 的接口、WebView Cookie 读写（含 Tauri API 验证） | 3 |
| 4 | 系统代理与 PAC（WinHTTP 封装放 `platform-win`）、注册表监听、WebView2 浏览器参数联动 | 3 |
| 5 | 超时、重试、退避；上传下载接口给 core-media | 1.5 |
| 6 | `plugin:net\|fetch` 受限命令与 capability 配置 | 1 |
| 7 | 网络状态检测（NLM + 主动探测）与事件 | 1.5 |
| 8 | 日志脱敏 | 1 |
| 9 | setting / login 网络设置页 | 1.5 |
| 10 | 原型验证 N1–N7 | 2 |
| 合计 | | **约 18 人日** |

依赖：步骤 3 需要 core-account 的账号模型先定；步骤 4 的浏览器参数需要 core-shell 创建 WebView2 环境的入口。属于里程碑 M1。

## 十一、待确认问题

1. `networkOptimization` 偏好在官方代码中没有使用点，是废弃项还是在远程页面或热更新组件中使用？
2. 网关选择（`online.ctrip.com`、`sec-m.ctrip.com`）的使用率与场景：是否必须对远程业务页也生效？这决定要不要做 WebView2 请求拦截。
3. 网页已观测 ticket Cookie 为 HttpOnly；新客户端保持该属性，仍须验证 WebView2 与旧数据恢复，不以兼容理由降级为 JS 可读。
4. 现场是否存在需要 NTLM/Kerberos 认证的企业代理？若有，Rust 请求需要 WinHTTP 兜底。
5. 测试环境须提供可验证的 CA；无可信证书时不放宽校验。
6. `disable-http2` 的真实原因能否从携程客户端团队得到确认（例如某代理或某网关的问题单）？
7. 官方 33 个白名单域名中，除携程、Trip 主域外，是否还有业务实际调用（如 `regmerchant.occpay.com` 支付注册）需要保留在 `plugin:net|fetch` 白名单内？

## 十二、开发前追加验收与官方依据

- N8：A 请求挂起后退出/重登 A 或切到 B，再释放旧 Set-Cookie/鉴权错误；旧凭据不能复活，新登录不被作废，B 不受影响。
- N9：允许端点跳转到未登记域/HTTP/不同端口、超大解压响应、伪造 scope、过期 view_generation；均拒绝且日志无凭据。
- N10：写操作在服务端接受后断开连接；必须返回结果未知，网络层不重试，UI 不误报“未发送”。
- N11：墙钟 ±5 分钟、睡眠唤醒、过期锚点和离线恢复；等待时长不随墙钟跳变，未完成消息对账不补响过时提醒。
- N12：PAC 同 host 不同 URL 分流、代理凭据、代理失败、证书链失败；对 Rust/WebView/SDK HTTP/WSS 分别记录结果，不能以 HTTP 成功推断 WSS 成功。

[Tauri Cookie API](https://docs.rs/tauri/latest/tauri/webview/struct.Webview.html) 明确 Windows 同步命令/事件内读取的死锁限制；原型须锁定实际版本并验证取消/关闭并发。[WinHttpGetProxyForUrl](https://learn.microsoft.com/windows/win32/api/winhttp/nf-winhttp-winhttpgetproxyforurl) 按 URL 求代理；[reqwest Proxy::custom](https://docs.rs/reqwest/latest/reqwest/struct.Proxy.html) 是同步回调，不能在回调中执行阻塞 PAC 下载/脚本解析。本轮仅修订契约，未把任何未完成的 Windows 网络原型标为通过。
