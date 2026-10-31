# 第5轮 Windows 构建与启动记录（未通过整体验收）

2026-10-31，Asia/Shanghai。延续原4轮，本次已进入第5轮；没有重置6轮上限。新程序已在用户操作后登录并核对受控身份，Edge官方页仍回到登录，真实双向验收尚未执行。第6轮媒体工作不属于此包。

## 冻结源码与产物

- 分支 `feat/prototype-restore-macos`，源码 `a3fbb22f1586b62beb411432c10c7640a540027d`。
- 从index导出独立快照 `%TEMP%\vbk-windows-20261031\round5-source`，dirty文件清单 `[]`。635文件manifest（含source-sha.txt）SHA256 `07596ea75643c053b6937551961fd5ddb5f158c829fdf135cf62f858eb675c17`；独立评审重新逐一核对635文件，零不匹配。构建不读取根工作树随后媒体改动。
- 可运行程序 `vbk/release/windows-round5-a3fbb22/vbk-host.exe`，20,212,736 bytes，SHA256 `6150ef537ad7f08fac68c79227e87063f1330b76a4ccd4cf0e83b1ffd12c2654`。
- 本机NSIS安装包 `vbk/release/windows-round5-a3fbb22/VBooking 商家客户端_0.1.0_x64-setup.exe`，6,521,129 bytes，SHA256 `d818f35d0b414a65e1ca3074f8c140d3676f518da07c97837e74fddc9fd456ff`。已生成安装包；本轮运行复制的独立exe，尚未执行NSIS安装/升级验收。生成物在ignored release中，不进Git。
- 11:37:57实际启动PID14828，进程路径 `C:\Develop\Ctrip-vbk-refact\vbk\release\windows-round5-a3fbb22\vbk-host.exe`；启动前无同名旧程序，启动后再次读回路径及exe hash一致。

## 本轮实际门禁

所有命令在独立快照的vbk目录执行，逐条核对退出码。日志实际stdout/stderr经Tee持续返回；界面截断部分的完整本机日志在 `%TEMP%\vbk-windows-20261031\round5-*.log`。

| 命令 | 实际结果 |
|---|---|
| npm ci | 退出0，锁定开发依赖 |
| npm run typecheck | 退出0 |
| node --experimental-strip-types --test 'ui/**/*.test.ts' | 493 passed，0 failed/cancelled/skipped/todo，退出0 |
| cargo test --workspace --quiet | 304 passed，0 failed/ignored，退出0 |
| cargo test --manifest-path src-tauri/Cargo.toml --quiet（首次） | 退出101；generate_context!发现frontendDist不存在，未执行宿主测试 |
| npm run bundle:ui（补全前置） | 退出0，5 HTML entries/79 files、adapter33 modules |
| cargo test --manifest-path src-tauri/Cargo.toml --quiet（重跑） | 115 passed，0 failed/ignored，退出0；跨进程子测试也通过，不重复计数 |
| npm run bundle:ui | 退出0 |
| npx tauri build --config src-tauri/tauri.windows.conf.json | 退出0，x64 release及NSIS包生成；工具自动校验下载的NSIS组件hash |
| git diff --check（指向冻结work-tree） | 退出0 |

宿主Windows交接基线114，因原macOS限定keychain测试少1项；本轮新增跨进程unknown测试成为115，没有删除、skip或ignored。核心301+3=304，UI483+4译文+6锚点=493。保留构建中的既有Windows data_store_id dead-code及bin/lib PDB同名警告，未将警告隐藏为已修。

## 原生与网页实际状态

新程序原生UI显示无已登录账号的欢迎页，“添加账号”可操作；unknown核验禁用、网络不可用/时间锚点待核对与未登录状态相符。点击添加账号后出现“登录 VBooking”独立窗口，内嵌官方 `https://vbooking.ctrip.com/ivbk/accountV2/login`；用户名/密码为空，扫码与协议控件可见。已真实显示并保留等待用户登录，没有复制官方Cookie、Mac钥匙串或密码。

原生工具首次索引点击返回coordinate input geometry is unavailable；读取截图并用窗口Raise后坐标点击成功。官方置顶提醒曾遮住新程序左上角，不能把遮挡截图当新程序完整视觉通过。原生AX及截图由本轮CUA工具输出留证；未把客户截图或原始业务数据放进仓库。

Edge唯一任务专用页仍停在官方登录，桌面授权此前提示唤起失败；已请求用户同时完成Edge与新程序登录。官方Windows桌面与助手本机读证见[Windows重核](2026-10-31-windows-resurvey.md)，不能代替网页/新包当轮订单客户双核与真实iframe gid解析。本轮出站消息为0。

## 登录后实机与独立评审

11:55后用户回复登录，新包已实际显示Meru账号、本人/列表/消息头像及11个处理中会话；主代理只读筛选授权客户，标题与右侧订单匹配，加载旧页后Trip-App来源、产品、日期与金额已显示。本人/商户消息在右侧，撤回行没有原文。Edge原专用页面重新导航工作台仍重定向登录，不因用户回复推断网页登录有效；已请求用户在该页看到会话列表后再继续。本轮仍零出站。

11:58历史实机发现未通过项：顶部第一条18:33:52撤回系统行约y166，点击加载更早后视图显示18:21订单卡/18:22系统行，原可见锚点未保持；这里只记录真实视觉差异，不从截图断言算法根因。另同一时点官方Windows Meru为11处理中/24已完成，新包为11/9，完整列表/计数差异正只读定位。旧页订单补全不证明全历史无漏重。以上新实机结果优先于下方构建前源码评审，不将离线绿态扩大为分页通过。

列表只读调查：本库`conversationList.ts`的poller用lastUpdateTime增量，没有haveRest专用续拉；`session.ts`只将haveRest用于完整快照删除判断。`display.rs`容量2000，`im_conversations`返回整份账号缓存，`viewmodel.ts::tabCounts`计全部已加载行，没有20条展示截断。历史17-full-list-exact-replay等模板20行/haveRest=false不能代替本轮HTTP。

官方安装源码`%APPDATA%/vbk-electron/dist/js/BaseController-P4oncDAK.js`（SHA256 `54f29fb93e0ea5f1db906033e2bd70697a0dc555f640bd3065f635b53ecc183f`）UTF-16偏移213673的`yy.read`按buid读全部本地缓存，无LIMIT。`imWindow-C3Pt24cG.js`（SHA256 `c4fedb4f97bb8755946c326e228b947b8078dd91e994fde3e76ddc2180737f35`）偏移2751435的getConversationList先读DB再server；26164的yCe保留server未返回但近30天的本地行，再读DB；2625425的QOt按BC业务/FINISH状态计合并数组。仅源码只读，未读取或复制官方DB。可以确认官方另有历史来源，不能断言多出的15条全部来自缓存。本轮同账号HTTP行数、状态分布、haveRest和游标仍缺，数量差异保持未关闭。

Sol/xhigh独立审阅冻结快照，复用译文请求实例、分页锚点、Windows持久化评审并补查Rust display的sender/role/server隔离；以内存脚本调用实际UI合并/渲染函数的5个身份与撤回引用组合通过，属于离线函数验证。输出只在本聊天工具记录 `ROUND5_FROZEN_COMBINED_IDENTITY_RECALL_REVIEW 5 cases passed`，未创建独立脚本/日志文件。其审查范围内无未修P1/P2，不代表整个目标范围无缺口。运行证据另由该评审者重算两份产物hash并读回PID路径/创建时间一致；其未独立操作原生或浏览器，UI依据仍是主代理CUA结果。

本轮尚无受控C/W双向和服务端ID对照，自然实时、客户已读、真实unknown重启、媒体发送、引用撤回、历史精确滚动、重连/切账号、强提醒、三端完整字段/按钮对齐未验。当前媒体仍阻断，推荐/完整来源轨迹等实现缺口仍保留；隐藏/禁用不是完成。后续断点以[PROGRESS](../../PROGRESS.md)、[BLOCKED](../../BLOCKED.md)及[能力矩阵](2026-10-31-message-panel-matrix.md)为准。
