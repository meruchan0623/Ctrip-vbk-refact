# Chrome / Edge 携程登录态连接

2026-11-03。本次实现对象是 `vbk` 客户端，覆盖 macOS / Windows 的 Chrome / Edge 源码路径。真实携程账号导入和 IM 连接尚未完成验收；Windows 分支尚未完成目标平台编译、安装及实机验收。

## 登录流程

点击客户端「＋」打开添加账号窗口。客户端为本次操作生成短时 challenge；Chrome / Edge 中已安装的 VBK 扩展首次由用户点击「授权此配置自动连接」。之后只有客户端存在添加操作时，扩展才读取当前配置的携程会话，经 Native Messaging 提供来源。客户端每 2 秒刷新来源列表，用户选择后连接。

列表中的 `Chrome · 名称` / `Edge · 名称` 是浏览器来源标签，名称由用户填写，并非已核实的携程账号名称。当前实现不能静默枚举尚未安装扩展的浏览器配置，也不能免除首次扩展安装与浏览器授权。每个需要连接的浏览器配置都需安装扩展。

客户端将选中的会话写入本次新建的独立 WebView profile，先读回核验 Cookie，再打开官方 IM 页面，沿用官方页面身份上报和既有 IM 状态处理。找到 Cookie、桥接成功或页面跳转都不能代替真实身份和 IM 连接验收。取消、Cookie 应用失败、身份核验失败或超时会清理本次未发布的 profile；不会主动注销或修改浏览器中的原账号。

本次授权在 120 秒内有效，一次使用后消费。刷新账号列表会为已过期的添加操作续建 challenge；扩展的自动连接授权持续保存在本机，可随时在扩展中停止；会话凭据不随授权持久保存。

## 开发安装

在仓库 `vbk` 目录中构建桥接程序并运行当前用户安装脚本：

```sh
cargo build --manifest-path src-tauri/Cargo.toml --bin vbk-browser-bridge
node tools/browser-bridge-install.mjs
```

以上两条命令同样适用于 Windows PowerShell。安装已构建的桥接文件时，将其路径作为脚本第一个参数传入。桥接程序必须在目标操作系统构建；macOS 二进制不能作为 Windows 安装输入。

安装脚本复制桥接二进制及扩展到当前用户目录，并注册两个浏览器：

| 平台 | 安装与注册位置 |
| --- | --- |
| macOS | `~/Library/Application Support/VBK/browser-bridge`；Chrome / Edge 各自的 `NativeMessagingHosts` 目录 |
| Windows | `%LOCALAPPDATA%\VBK\browser-bridge`；`HKCU\Software\Google\Chrome\NativeMessagingHosts` 和 `HKCU\Software\Microsoft\Edge\NativeMessagingHosts` |

脚本依赖 Node.js；这是开发安装路径，尚未接入正式安装包。正式分发仍需客户端安装包注册 native host，并完成 Chrome / Edge 扩展商店发布或受管理分发。

用户在 `chrome://extensions` 或 `edge://extensions` 开启开发者模式，选择「加载已解压的扩展」，选择脚本输出的扩展目录。开发扩展 ID 由 manifest 公钥固定为 `dhfnfakligkclahdpejdeoocanjbmkco`；本机 host 仅允许该 ID。浏览器的安装确认和扩展「授权连接」必须由用户完成，不能以客户端已有授权代替浏览器自身的权限确认。

完成安装后，先在浏览器中登录携程商家平台，再启动包含本次修改的客户端，点击「＋」，首次点击扩展「授权此配置自动连接」，回客户端选择并连接。只构建或安装 bridge 不会更新现有运行客户端。

## 数据与平台实现

扩展权限为 `cookies`、`nativeMessaging`、`storage` 与 `https://vbooking.ctrip.com/*`，没有网页 content script 或外部网页消息入口。仅读取该官方 URL 可用的 Cookie，再限定 `.ctrip.com` 域记录 / `vbooking.ctrip.com` host-only 记录、根路径、未过期、未分区、Secure 的 `bticket`、`vbkticket`、`BDUID`。宿主再次校验域、字段、数量与大小，并拒绝重复键。

桥接端口仅监听 `127.0.0.1`，使用随机端口、每次启动随机连接密钥、当前添加操作 challenge、最大 128 KiB 的长度帧。Cookie 仅在扩展、native host、客户端进程内传递和短时暂存，不写入桥接配置、日志、剪贴板或 URL。磁盘 rendezvous 文件只保存本机端口和连接密钥，macOS 目录 / 文件权限为 0700 / 0600；Windows 由当前用户 ACL 限定。成功导入后，客户端独立 WebView profile 按现有账号登录机制持有会话数据；这不等于 Cookie 永远不被 WebView 持久化。

macOS 使用原生 WKHTTPCookieStore 写入及读回，Windows 使用原生 WebView2 CookieManager 写入，再异步读回核验。两者均保留 `.ctrip.com` 父域范围，避免通用 Cookie 转换去除前导点导致子域登录失败。应用 Cookie 有 15 秒超时，取消会停止后续写入并销毁未发布 profile。没有读取 Chrome / Edge 的凭据数据库或尝试绕过 Windows 应用绑定加密。

## 验收记录与待办

| 项目 | 当前证据 |
| --- | --- |
| macOS Rust 宿主 | `cargo check --lib` 与 `cargo build --bins` 通过 |
| macOS 原生 Cookie 转换 / 读回 | 3 项合成测试通过，包含域、SameSite、HttpOnly、过期时间、缺失 / 改变 / 多余 Cookie |
| 桥接协议及扩展 | Rust 桥接 5 项、native helper 1 项、扩展 4 项、登录 UI 9 项测试通过；193 项安全门禁夹具及源码门禁通过。独立评审发现的 4 项问题修复并复核，无剩余 P1/P2；不能替代真实账号验收 |
| Windows Chrome / Edge | 已实现注册与导入源码；未完成 Windows 编译和实机验收 |
| 真实携程登录态导入 | 尚未通过；需要真实浏览器安装授权、导入与官方身份核验的完整证据 |
| 真实 IM 连接 | 尚未通过；应观察官方 IM 的实际连接与账号身份，不能以 Cookie 写入成功代替 |

下一步真实验收应分别记录来源浏览器 / 配置、客户端确认的携程身份、IM 连接状态、取消与过期回退，以及浏览器原会话仍可使用。证据仅记录结果和必要脱敏标识，不记录 Cookie 值。没有完成的矩阵项继续保持未验收。

相关实现：`vbk/browser-extension/`、`vbk/src-tauri/src/browser_bridge.rs`、`vbk/src-tauri/src/bin/vbk-browser-bridge.rs`、`vbk/src-tauri/src/login.rs`、`vbk/src-tauri/src/chrome_cookie_store.rs`、`vbk/tools/browser-bridge-install.mjs`。
