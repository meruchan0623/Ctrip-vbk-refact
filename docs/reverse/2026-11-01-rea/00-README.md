# 旅游商家桌面版 rea 逆向分析与 Tauri 重构计划（总览）

2026-11-02。工具：[rea](https://github.com/morluto/rea) 6.8.0（`rea-agents`，Node 24.22.2，本机未安装 Hopper/Ghidra，只用静态分析与只读检查）。分析对象：

| 对象 | 版本 | 位置 | 说明 |
| --- | --- | --- | --- |
| 官方 Mac 版 | 1.2.13（Electron 27.3.11 / Chromium 118，仅 x86_64） | `/Applications/旅游商家桌面版.app` | 携程签名并已公证，**未被插件注入**（03 PLG-04） |
| 官方 Windows 版 | 1.2.12（同上运行时） | `~/Downloads/vbk-electron/` | 被第三方插件「旅游商家助手」注入（替换 asar、开调试端口、植入 Companion） |
| 本项目实现 | `vbk/`（Tauri 2 + std-only Rust 核心 + 无依赖 TS） | 本仓库 | 盘点到 2026-11-01 的 `a34a007` |

全程没有执行目标包里的任何脚本或二进制，没有改动 `vbk/` 代码。rea 的原始证据与中间产物在本机 `~/tools/rea-work/`（不入库，单个证据 200~590 MB）。

## 1. 交付文档

| 文档 | 内容 | 规模 |
| --- | --- | --- |
| [01 前端（渲染层）](01-frontend.md) | 技术栈、25 个页面入口（保留 16 / 删除 9）、88 个功能点（FE-01~88）、渲染层与主进程边界、双端差异、前端问题 F-01~16 | 364 行 |
| [02 后端（主进程）架构](02-backend-main-process.md) | 进程与窗口拓扑（14 个 BrowserWindow + 2 个 BrowserView + 3 个 utilityProcess）、24 个主进程模块、IPC 与桥接总表、36 个后端域名、Tauri/Rust 映射 | 352 行 |
| [03 缺陷专项](03-defects.md) | 44 个问题（P0 1 / P1 11 / P2 18 / P3 14），每条带证据偏移、复现方法、根除方式；与历史缺陷文档逐条复核 | 745 行 |
| [04 目标定位 vs vbk 实现差距](04-target-vs-vbk-gap.md) | 目标范围提炼、vbk 每个模块的状态（A/B/C/D）、实测测试结果、差距矩阵、风险 | 401 行 |
| [05 原生层、签名、打包与更新](05-native-packaging.md) | 两版原生文件清单与签名、fuses 对比、更新链路、体积与依赖、问题 N-01~13 | 254 行 |
| [06 Tauri + Rust 实施计划](06-tauri-rust-implementation-plan.md) | **模块级实施计划**：30 个模块（M01~10、H01~11、U01~07、R01~02）的职责、依赖、波次、交付物、验收标准；全局不变量；关键风险 R1~R11；外部决策点 X1~X8 | 625 行 |

## 2. 关键结论

1. **最大的安全问题在更新链路**：官方渲染层热更新把下载地址从 https 强制改成 http，zip 不校验直接解压到 `userData/dist`，之后以带特权的本地页面加载（SUP-01 / N-01，唯一的 P0）。
2. **桥接层等于没有授权**：preload 向渲染层（**包括远程页面**）暴露任意 SQL（`dbQuery`）、全部账号 cookie（`getAllLoginCookies`）、主进程代发请求（`netFetch`）、任意下载；70 个 IPC 处理器中约 15 个读取 sender，明确据此拒绝调用的只有 3 个（SEC-07、F-01、F-02）。
3. **安全基线被全局关闭**：8 处 `webSecurity:false`、关闭站点隔离、本地页 CSP 全通配，还会剥离携程域响应的 CSP 与防嵌套头；fuses 全是默认值；Mac entitlements 关闭库验证（SEC-01~05）。
4. **凭据明文**：账号密码与 bticket 明文写在 electron-store 的 `config.json`（PRI-01）。
5. **稳定性**：IM utilityProcess 崩溃守护计数每次清零，变成每秒无限重启；三套重连机制叠加且没有退避；会话列表 5 秒增量轮询（另有 3 秒共情话术轮询），隐藏窗口也不停（STA-01/02、F-06）。
6. **本项目 vbk/ 的状态**：离线门禁基本全绿（Rust 321、TS 751、宿主 192/195，3 个失败是 macOS 临时目录符号链接导致的夹具问题），安装包 19 MB（官方 744 MB），已在架构上避开上述大部分问题；但 **G1–G5 没有一个关口整体通过**：消息实时可靠性、会话计数一致性、历史分页、强提醒实机都还是 P0 缺口，签名、更新、截图标注、OCR 等尚未开始。
7. **新发现的产品风险**：官方 IM 发送前有客户端反自动化输入检测（FE-29 / F-11）。如果目标网页有同类检测，适配器的程序化发送和出站翻译回填都可能被拦截。计划要求**不做任何规避**，并把是否调整产品形态交给用户决定（R11 / X7）。

## 3. 功能清单（汇总）

完整清单见 [01 §3](01-frontend.md) 与 [02 §3](02-backend-main-process.md)；迁移去向见 [06 §6](06-tauri-rust-implementation-plan.md)。

| 类别 | 功能点（编号） | 范围 | 目标模块 |
| --- | --- | --- | --- |
| 会话 | 会话列表与轮询、心跳、置顶/标记、草稿、群聊、上下班状态、未读上报、通知弹窗、虚拟列表（FE-01~09） | 保留 | M06、U02、U03、H05 |
| 消息类型 | 文本、图片、语音、视频、文件、位置、卡片/订单卡、SDUI 卡（仅 Mac）、问答与机器人、系统/撤回/关键词预警、评价、兜底（FE-10~21） | 保留（SDUI 不迁移） | U03、H04 |
| 编辑与发送 | 富文本输入、发送状态、拖拽发文件、上传域名、截图粘贴、敏感信息拦截、反自动化检测、正在输入、错别字修正、频率限制（FE-22~32） | 保留（反自动化见 R11） | U03、U02、H04、M09 |
| 消息操作 | 复制/引用/转发、撤回与重新编辑、已读回执、历史分页、聊天记录搜索、本地缓存天数、打码信息解码（FE-33~39） | 保留 | U03、U02、M06、M03 |
| 群与服务 | 邀请客服、转接、移除成员/改群名、结束会话、转人工排队、邀请评价、按订单号开会话、跳转会话（FE-40~47） | 保留 | H04、U02、U03 |
| 翻译 | 入站逐条/整段翻译、边写边译（出站）、翻译请求结构（FE-48~50） | 保留 | U02、M08、H08 |
| 表情与话术 | 内置表情、游游动图、自定义表情（含 Excel 导入导出）、快捷回复、提示音、推荐回复、产品/线路推荐、AI 总结（FE-51~58） | 保留（AI 总结待定 X8） | U03、H05 |
| 账号状态 | 登录态过期、会话断开、下线提示；浏览器登录授权；远程资源（FE-59~61） | 保留 | H02、H03 |
| 登录 | 手机号短信、账号密码、扫码、滑块验证、注册与重置、协议勾选、网络设置、多账号、错误码（FE-62~70） | 保留 | H02、U06、M05 |
| 设置 | 通用、IM 通知、系统通知、快捷键、帮助、个人、关于、调试工具（FE-71~78） | 保留（调试工具不进生产包） | H09、U05 |
| 其他窗口 | 通知中心（notice）、alarm、图片查看/OCR、视频、截图、更新、web 容器、主壳（FE-79~88） | 保留；web 只留订单详情 | H05、U04、H07、U07、H10、U03 |
| 主进程能力 | 启动与生命周期、窗口管理、托盘/Dock/菜单、通知、IM SDK 宿主与连接、账号/Cookie/Session、请求拦截、网络代理、本地数据库、KV、截图、OCR、拼写、热更新、整包更新、架构引导、崩溃与日志、UBT/clientid、协议唤起、多语言与 qconfig、环境切换与堡垒、DAL 解密/7za（02 §3，24 个模块） | 热更新、UBT、clientid、DAL、7za、请求拦截、堡垒**不迁移** | 见 02 §7.1 与 06 §6.1 |
| 已删除的业务页 | 首页、事件、公告、产品、数据 BI、点评、完整订单管理、课程、架构引导；工作台、商服（主壳菜单项） | 删除 | — |

## 4. 技术架构说明（对照）

| 关注点 | 官方客户端（02、05） | 本项目目标（06） |
| --- | --- | --- |
| 运行时 | Electron 27.3.11 / Chromium 118，已停止维护；Mac 只有 x86_64 | 系统 WebView（WebView2 / WKWebView），arm64 + x86_64 |
| 进程 | 主进程 + 14 个 BrowserWindow + 2 个 BrowserView + IM/OCR/拼写 3 个 utilityProcess；IM 消息经 MessagePort 在三方之间转三次 | 单 Rust 宿主 + 按窗口 WebView；IM 由隐藏的官方页 WebView 承载 Web SDK，事实事件进入 Rust 核心 |
| 本地 UI | 25 个 Vite 多页面（React 18 + antd 4 + redux + 携程私有包），vendor 约 3.3 MB，小窗口也全量预取 | 无依赖 TS（`ui/apps/*`），随包发布，禁止运行时替换 |
| 桥接 | `appBridge` 45 个成员，含通用 SQL、cookie、代发请求；远程页同样注入 | 69 条冻结命令，按窗口 capability 授权；远程页只开放 adapter 7 条 |
| 存储 | `config.json` 明文凭据 + `vbk.db`（两套 SQLite 驱动，迁移 SQL 可被热更新替换） | 系统密钥库 + 按身份隔离的 JSON 文档；SQLite 是否引入由 M03 决策门决定 |
| 网络 | 关 HTTP/2、放开连接数；非 PROD 忽略证书；OCR 下载关闭证书校验 | rustls 默认配置，发布构建只含生产端点 |
| 更新 | electron-updater（Windows 不验签）+ ares 热更新（http、不校验） | `tauri-plugin-updater`（minisign）+ 平台代码签名 |
| 签名 | Mac Developer ID + 公证（但放宽 entitlements）；Windows 全部未签名 | 两平台全量签名，entitlements 无例外 |

## 5. 问题清单（合并）

编号体系：SEC/SUP/PRI/STA/MNT/PLG 见 [03](03-defects.md)；F 见 [01 §6](01-frontend.md)；N 见 [05](05-native-packaging.md)；D/V/E 见 [04](04-target-vs-vbk-gap.md)。同一问题在多份报告里出现时，以 03 的编号为主。

### 5.1 官方客户端：P0 / P1

| 主编号 | 关联编号 | 问题 | 严重度 | 计划中的根除模块 |
| --- | --- | --- | --- | --- |
| SUP-01 | N-01 | 渲染层热更新强制 http、无签名或哈希校验，解压后作为特权页加载 | P0 | H10、G-SEC-1 |
| SEC-07 | F-01、F-02 | 通用 SQL、全账号 cookie、代发请求暴露给渲染层与远程页；sender 校验几乎没有 | P0（F）/P2（03） | H01、M02、G-SEC-5 |
| SEC-01 | — | 8 处关闭 webSecurity | P1 | H01 |
| SEC-02 | — | 无条件关闭站点隔离 | P1 | H01 |
| SEC-03 | F-12 | 本地页 CSP 全通配，剥离服务端 CSP 与 X-Frame-Options；`eval` 迫使放开 | P1 | H01 |
| SEC-04 | N-04 | fuses 未加固（RunAsNode、NODE_OPTIONS、inspect 开，asar 校验关，Cookie 不加密） | P1 | H01、R01 |
| SEC-05 | N-05 | Mac entitlements 关闭库验证、允许 DYLD 变量；17 处 rpath 可抢占 | P1 | R01 |
| SEC-11 | — | Electron 27 / Chromium 118 过旧 | P1 | 整体替换 |
| SUP-02 | — | OCR/拼写模型下载关闭证书校验，来自个人 GitHub 仓库，无哈希 | P1 | M09 |
| SUP-03 | N-03 | Windows 全包无 Authenticode，更新不验签 | P1 | R01、H10 |
| PRI-01 | — | 账号密码与 ticket 明文存储 | P1 | H02、G-SEC-3 |
| STA-01 | — | IM 子进程崩溃后每秒无限重启 | P1 | H03、M06、G-STA-1 |
| PLG-01 | N-06 | 插件开启无鉴权的本机调试端口，改写官方包 | P1（插件） | H08（不开调试端口） |
| — | N-02 | 整包更新源由远端动态下发 | P1 | H10 |
| — | F-03 | IM 渲染 25 处 `dangerouslySetInnerHTML` | P1 | U03 |
| — | F-04、F-05 | 小窗口全量预取 vendor；imWindow 2.78 MB 单 chunk | P1 | U01 |
| STA-03 | F-06 | 5 秒增量会话轮询、3 秒共情话术轮询（`getSessionEmpathyPhraseInfo`），无退避，不随可见性暂停 | P1（F）/P3（03） | U02、H03 |

### 5.2 官方客户端：P2 / P3（编号索引）

- **P2**：SEC-06、SEC-08、SEC-09、SEC-10、SUP-04、SUP-05、PRI-02、PRI-03、STA-02、STA-04、STA-05、STA-06、STA-07、STA-08、MNT-02、PLG-02、PLG-03；F-07、F-08、F-09、F-10、F-11；N-07~N-11。
- **P3**：SEC-12、SEC-13、SEC-14、SUP-06、PRI-04、PRI-05、PRI-06、STA-09、STA-10、MNT-01、MNT-03、MNT-04、PLG-04；F-13~F-16；N-12、N-13。

### 5.3 本项目 vbk/：P0 / P1 差距（04 §6）

| 编号 | 差距 | 严重度 | 计划模块 |
| --- | --- | --- | --- |
| D3 | 实时收消息不可靠（曾 49 秒未到达），丢失与延迟未量化 | P0 | H03、U02、R02 |
| D2 | 会话计数与官方不一致（例：0/921 vs 20/1959），口径未定 | P0 | M06、X1 |
| D1 | 历史分页位置保持只有 2 次样本 | P0 | M06、U03 |
| V4 | 独立强提醒零实机验收 | P0 | M07、H05、U04 |
| V1、D6 | 媒体真实上传→发送→读回 0 次；大视频分片缺失 | P1 | H04、U03 |
| V5 | 出站翻译真实调用 0 次 | P1 | M08、H08 |
| E7 等 | 无更新器、adhoc 签名、安装器未执行 | P1 | R01、H10 |
| D7 | macOS 不能复用 TSim 浏览器会话 | P1 | H08 |
| — | Windows 截图不支持；Windows 任务栏数字缺失 | P1 | H07、H05 |
| D8 | macOS 上宿主测试 3 项因临时目录符号链接失败 | P2（W0 修） | R01 |

## 6. 复核与更正

| 事项 | 原说法 | 复核结论 | 来源 |
| --- | --- | --- | --- |
| Mac 包是否被插件注入 | 历史文档认为两个安装包都被注入 | 当前 Mac 1.2.13 未被注入（签名与公证校验通过），只残留 TripVendorLauncher 崩溃记录 | 03 PLG-04、05 |
| 4 个 asar 完整性不符的原生文件 | 疑似篡改 | 是官方构建顺序问题：先写 asar 元数据、后签名改写字节；Windows 版没有签名步骤，781 个文件全部一致，可反证 | 03 SUP-04、05 N-09 |
| `ignore-certificate-errors` | 无条件开启 | 只在非 PROD 环境开启，但环境判定来自 asar 外的 JSON 与用户配置，可被切换（SEC-06，P2） | 02、03 |
| sender 校验数量 | 03 记为 15 个，02 记为 3 个 | 70 个处理器中约 15 个读取 sender（窗口 ID 或 URL），用于定位账号或做弱校验；明确据此拒绝调用的只有 3 个（`execute_db`、`toggle_baolei`、`change_env`） | 本总览 grep 核对 |
| notice 页面 | 被当作公告 | notice 是通知中心（保留），公告是 bulletin（删除） | 01 |
| rea 的 Electron 计数 | rea 报告 0 个窗口、5 个主进程处理器 | 打包后 electron 被重命名，rea 识别不到；实际为 14 个窗口、70 个处理器。报告中窗口与 IPC 数量都以字节检索为准 | 02、03 |

## 7. 方法与局限

- **rea 用法**：整包 asar（含 600 MB node_modules）会超出 rea 的结果预算，所以按子集分析：主进程只选 `dist-electron/**` 与 `package.json`（Windows 另含插件 bootstrap），渲染层排除 vendor chunk 并把单文件超时放宽到 1500 秒。其余用 `inspect-electron-fuses`、`inspect-desktop-application`、`inspect-plist`、`inspect-signature`、`inspect-macho`、`trace-dylib-resolution`、`inspect-pe-*`、`inspect-rust-binary` 等静态命令；每份报告的附录都有命令原文。
- **只做了静态分析**：没有做中间人、崩溃注入或运行时抓包。所有「影响」都是根据代码推断的，每条问题都给了隔离环境下的复现方法。
- **未覆盖的部分**：minify 后可能存在别名调用（`getImPortStatus`、`postPortMessage` 的使用可能有遗漏）；`dangerouslySetInnerHTML` 是否做了净化；`web.js` 向远程页注入的具体内容；alarm 窗口隐藏后计时器是否停止。这些需要动态验证。
- **敏感信息**：报告中的密钥类值只保留前 4 位；读取本机 `config.json` 时只看结构，没有读取值。

## 8. 复现

```bash
# 安装 rea（需要 Node ≥ 22.23.4 或 ≥ 24.22.1）
npm install rea-agents@6.8.0
export NODE_OPTIONS=--max-old-space-size=8192
# 主进程（选取自有代码子集）
rea analyze-javascript-application "/Applications/旅游商家桌面版.app/Contents/Resources/app.asar" \
  --source-paths-json main-sources.json --detail summary --evidence_output mac/main-graph.evidence.json \
  --integrity-policy record-and-continue --max-heap-mb 4096 --format json
# 渲染层（排除 vendor，放宽超时）
rea analyze-javascript-application "/Applications/旅游商家桌面版.app/Contents/Resources/app.asar.unpacked/dist" \
  --artifact-format directory --source-paths-json dist-sources.json --analysis-timeout-ms 1500000 \
  --detail summary --evidence_output mac/dist-graph.evidence.json --integrity-policy record-and-continue --format json
rea inspect-electron-fuses "/Applications/旅游商家桌面版.app" --format json
```
