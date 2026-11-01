# Windows 客服网页会话复用

2026-10-31 用户明确要求沿用旧插件的客服系统登录态复用方式。来源为 `C:/Develop/trip_vendor_im_companion/electron/chromium-tsim-storage.ts` 和 `browser-profile-session.ts`，本次读取旧项目源码，不修改旧插件或浏览器文件。

## 使用与边界

设置 → 商家助手 · TSim 登录 → **复用 Edge / Chrome 客服登录态** → 选择浏览器配置。只支持 Windows 默认数据目录下的 Edge/Chrome `Default`、`Profile N`；不支持隐身、自定义数据目录或 macOS。始终展示来源供选择，不因某个配置暂不可读而自动切换账号。

宿主只读精确 origin `https://csagent.tsim.tech` 的 `agent_token`；不打开 LevelDB 数据库、不占数据库锁、不复制数据库、不读浏览器密码。校验 CURRENT/MANIFEST、WAL、SST、CRC、Snappy、序号、删除标记和全量稳定读回；拒绝 reparse/junction、损坏、变化及不支持的格式。单文件64 MiB、单次读取预算256 MiB、最多3次尝试，最多64配置；全局单许可后台扫描不占用异步网络线程。

连接仅通过固定 `/agent/profile`、`/agent/auth/session-status` 核验；令牌留在宿主内存，不进入 renderer、偏好、日志或新持久文件。既有手动登录与手动令牌导入仍保留各自行为。

浏览器绑定在请求边界和4秒维护周期复核。网页退出、令牌轮转、换账号、读取失败或过期会阻止继续使用旧结果；用户需重新连接。不会自动选择其他配置。浏览器绑定不执行 token refresh 或服务端 logout；本地断开不注销网页。客户端重启后需再次选择复用来源，本轮未实现旧插件的启动自动重连偏好。

## 验证

- 真实本地存储与生产只读接口：Chrome Default 无会话，Edge Default 有会话；`browser_login_confirmed=true`、`local_disconnect_ok=true`、`browser_session_still_active=true`。由 `examples/tsim_browser_probe.rs` 执行，未打印或落盘令牌，未发送客户消息。
- 18项设置专项、614项完整前端测试、175项完整宿主测试、typecheck、UI bundle、Windows dev构建通过。包含12项存储合成测试、凭据内存存储、断开无远端logout和settings专属ACL回归。
- Sol/xhigh 独立源码评审发现同步扫描阻塞和部分发现自动选错来源两项P2；已改为限流后台扫描与明确选择来源，复核未发现剩余P1/P2。
- 新设置按钮仅完成入口测试；新预览未启动进行桌面点击验收。当前另有正在运行的预览，未主动替换。未进行浏览器GUI操作，也未将其计为浏览器验收通过。

## 独立开发预览

`vbk/release/windows-browser-session-20261031/vbk-host.exe`，开发构建，不是正式安装包。

SHA-256：`BEE2169F16AF48CA100FA5F97FB580300D5AC073F03A4260FB50717DF3A3B836`。

从当前工作树构建；未提交、推送或运行安装器。现有运行版本不含此按钮，退出旧预览后再启动此文件。不要把旧版本手动登录成功当作本预览完整桌面验收。
