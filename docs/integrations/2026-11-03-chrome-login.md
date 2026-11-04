# Chrome 登录态复用

本轮修改对象是 `Ctrip-vbk-refact/vbk`；`trip_vendor_im_companion` 仅作为查询 iframe 和卡片 UI 的参考，未修改或安装该插件。

## 携程

macOS 打开添加账号窗口后优先寻找稳定版 Chrome 的 `Default` / `Profile N` 配置。只有一个配置时自动尝试；多个配置时由用户选择。只接受当前用户标准 Chrome 目录，拒绝符号链接和任意外部路径。Windows 继续使用官方登录页，此次未实现 Windows 应用绑定 Cookie 解密。

宿主以只读 SQLite 查询 `.ctrip.com` 和 `vbooking.ctrip.com` 的 `bticket`、`vbkticket`、`BDUID`，仅 `/` 路径、未过期、未分区记录。没有候选 Cookie 时不访问钥匙串。支持 Chrome Cookie 数据库 20–24 与 macOS `v10` 加密；未知格式拒绝导入。第一次读取可能触发 Chrome Safe Storage 的系统钥匙串授权；拒绝后仍可使用官方登录页。

解密遵循 Chromium 的 [macOS OSCrypt 格式](https://chromium.googlesource.com/chromium/src/+/ec82d4ab8/components/os_crypt/os_crypt_mac.mm)，版本 24 核验 [Cookie 域名 SHA-256 前缀](https://chromium.googlesource.com/chromium/src/net/+/master/extras/sqlite/sqlite_persistent_cookie_store.cc)。密钥和解密临时缓冲区用后清理，不输出凭据。仅 Cookie 进入本次独立的 WebKit 登录 profile，IPC 只传配置 ID 与尝试 ID。

写入后核验存储内容，再由官方 IM 页面发布身份，不能仅凭找到 Cookie 或页面跳转宣告登录成功。导入与验证期间的取消、过期或失败不会切换到另一 Chrome 配置；写入失败或官方身份核验失败时销毁该次 profile，打开全新官方登录页，并停止自动重试。应用不修改 Chrome Cookie，也不向 Chrome 会话主动发送退出请求。

这三项 Cookie 来自已有接口观察记录，是否足以恢复某个真实账号仍以官方页面验证为准；若站点要求其他上下文，会回退官方登录。本轮不宣称真实账号免登录验收已通过。

## TSIM

设置 → 商家助手使用「从 Chrome 登录」。macOS 新增标准 Chrome 配置读取；Windows 保留 Chrome / Edge，Chrome 优先。只有一个含 TSIM token 的配置时直接连接，多个时选择。只读取 `https://csagent.tsim.tech` 的 `agent_token`，沿用现有服务端身份及权限核验，绑定期间检查浏览器 token 是否变化。断开借用的会话不注销 Chrome 账号。

TSIM 的 Cookie 与携程相互独立；此链路不需要 Chrome Safe Storage 解密。页面查询接管的配套发布依赖见 [iframe 接入说明](2026-11-03-tsim-iframe.md)。

## 验证边界

使用合成 Cookie、内存数据库和模拟 IPC 验证解密、域绑定、过期/分区过滤、多配置选择、取消与错误回退；浏览器页面验收通过 ego-browser 的本地模拟数据进行。没有读取真实 Chrome 凭据，没有替换已安装客户端，没有提交、推送或部署。

完成验证：宿主 Rust 225 项及安全集成 3 项通过；前端全量测试曾通过，最终登录/iframe/命令权限相关 26 项回归通过；类型检查、193 个安全门禁夹具及真实代码门禁通过；最终 UI bundle 成功。ego-browser 检查了无 Chrome 配置回退、iframe 打开/关闭和加载超时提示；1280×820 下实际卡片右边及底边对齐，上方订单区不被遮挡。iframe 检查阻断了远端 TSIM 请求，未拿演示订单访问真实业务数据。
