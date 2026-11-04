# VBK 浏览器登录连接

同一份 Manifest V3 扩展适用于 macOS / Windows 的 Chrome / Edge。此目录是开发版扩展；首次安装需要用户在浏览器中授权，客户端无法静默安装或枚举未安装扩展的浏览器账号。

## 本地安装

在 `vbk` 目录执行：

```sh
cargo build --manifest-path src-tauri/Cargo.toml --bin vbk-browser-bridge
node tools/browser-bridge-install.mjs
```

脚本将本机桥接和扩展复制到当前用户的 `VBK/browser-bridge` 目录，为 Chrome、Edge 注册 Native Messaging host。macOS 使用 Application Support，Windows 使用 LOCALAPPDATA 与 HKCU 注册表。无需管理员权限。脚本依赖 Node，仅用于开发安装；正式安装包应执行同等注册并使用浏览器商店分发扩展。

在 `chrome://extensions` 或 `edge://extensions` 开启开发者模式，选择“加载已解压的扩展”，选择脚本输出的扩展目录。固定开发扩展 ID：`dhfnfakligkclahdpejdeoocanjbmkco`。每个要连接的浏览器配置均需安装。此 ID 通过 manifest 的公开 key 固定；不存在仓库内的扩展签名私钥。

## 使用

1. 在当前浏览器配置中登录携程商家平台。
2. 首次使用时点击浏览器工具栏的 VBK 扩展，填写方便识别的配置名称，点击“授权此配置自动连接”。授权偏好持久保存，但不保存凭据；可在扩展中“停止自动连接”。
3. 在 VBK 客户端点击 ＋ 打开添加账号窗口。扩展每 2 秒检查是否有新的添加操作，仅在有操作时读取当前携程登录态。
4. 回客户端刷新列表，选择 `Chrome · 名称` 或 `Edge · 名称`，连接。名称只标识来源，真实账号由官方页面核验。

授权只在本次添加操作内有效，120 秒过期；使用一次后消费。失败后需要重新授权。不会修改或退出浏览器账号。无可用登录态时会明确提示在浏览器登录。

## 数据边界

权限仅包括 `cookies`、`nativeMessaging`、`storage` 和 `https://vbooking.ctrip.com/*`。仅查询此 URL 可用的 Cookie，再筛选 `.ctrip.com` 域 Cookie / `vbooking.ctrip.com` host-only Cookie 中 `/` 路径的 `bticket`、`vbkticket`、`BDUID`；排除过期、不安全、分区 Cookie。客户端再次验证同样边界。是否足以建立真实 IM 会话仍由客户端的官方页面身份与连接检查确定。

扩展先取得用户对当前配置自动连接的明确授权，之后仅向本机客户端当前添加账号操作提供登录态。无网页 content script、外部消息接口或浏览器凭据数据库读取。Native Messaging 仅允许固定扩展 ID；本机连接限定 127.0.0.1、随机端口、每次启动随机密钥、4 字节长度帧与 128 KiB 上限。本次添加操作的 challenge 在客户端内生成。凭据只在进程内暂存；磁盘仅保存端口和本机连接密钥，macOS 目录 0700 / 文件 0600，Windows 目录收紧为当前用户 ACL。

开发扩展安装和浏览器明确授权是首次使用的必要步骤。Windows 编译/真实浏览器验收须在 Windows 完成；macOS 构建通过不能替代。
