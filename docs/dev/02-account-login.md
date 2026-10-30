# 02 登录与多账号

2026-10-30。沿用目标网页的登录、验证和失效流程。

用户已明确指定登录入口为 `https://vbooking.ctrip.com/ivbk/accountV2/login`：直接复用该官方网页，不自建密码表单，不逆向重写 `pwdLogin`、验证码、风控和内部 `authToken` 接口。登录凭据由该账号隔离的浏览器 Profile 承载；具体鉴权与接入边界见[接口鉴权说明](../api/authentication.md)。

1. 网页登录在受隔离的浏览器会话中完成，不提取密码，不把 Cookie 复制到普通业务库。
2. **多账号保留**：标题栏账号标签、添加/切换/排序/备注名；每账号独立 WebView2 Profile 与凭据，消息与提醒按账号隔离。
3. 登出区分“退出在线（保留免密）”“退出登录”“彻底移除”；免密凭据存系统凭据库，启动时在线校验，不只凭本地票据。
4. 读取服务端用户与客服身份后建立 `AccountContext`；登录失效、注销或身份替换推进 `session_generation`，拒绝旧代次回调。
5. 客服在线/挂起/离开/下班属于网页业务状态，与登录和网络状态分开；切换后回读，不因断线自行改为下班。
6. 旧 Electron 数据只读导入票据，不迁移密码。

2026-10-30 落盘：`vbk/crates/core-account` 实现登录 attempt 隔离、`(environment,buid)→AccountId` 稳定索引（同身份重登不产生新 ID）、`session_generation` 推进与迟到回调拒绝、三种退出模式、凭据 `Prepared→SecretStaged→IndexCommitted` 账本与崩溃恢复、客服工作状态只按服务端回读更新（断线不改）；`SecretStore` 为抽象接口，系统凭据库适配未做。宿主 `account_start_login` 只返回官方登录页 URL，隔离 Profile 的 WebView2 承载与登录完成后的身份读取（`publish_identity` 的触发）尚未原型化。

详细设计沿用[归档正文](../archive/desktop-baseline/dev/02-account-login.md)。网页证据：[网页调查](../research/2026-10-30-web-im-observation.md)、[客服状态](../research/2026-10-30-agent-status-and-settings.md)。
