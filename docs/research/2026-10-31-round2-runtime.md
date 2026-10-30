# 第 2 轮新包运行记录

2026-10-31，Asia/Singapore。当前结论：离线门禁、构建、新进程及账号恢复通过；客户端出站C已在官方读回同服务端ID，官方反向W在历史加载后读回同ID，自动到达未通过。整轮仍未验收通过。

## 构建对应关系

- 源码 HEAD `18c0ed3a07df4ea6e249b81b19045b8b1ff27138` 加既有未提交工作树；不是仅凭 HEAD 可复现的干净发布。
- 273 文件冻结清单 `/tmp/vbk-goal-20261031/round2-source-manifest.json`，SHA256 `2926be1e038d249ab43c45e2f51065f9626660266feeb9ffe0a27b1ec7164619`；构建后逐文件复核无变化。
- 实际启动 app：`vbk/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/VBooking 商家客户端.app`；PID48183，进程命令路径经 ps 读回一致。已退出首轮 PID33871。
- app 内 `Contents/MacOS/vbk-host` SHA256：`1e5281fc5d73be72de8e9c9f30e3abed2378fa3493264f021aa4ac0806e79528`。
- DMG：`vbk/src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/VBooking 商家客户端_0.1.0_aarch64.dmg`；SHA256 `df2941402323ed71d039b63acb81d055e42d89d3f5305c20606343d9725b0b6a`。
- 原始记录：同一临时目录的 `round2-artifact-hashes.json`、`round2-process-path.txt`、`round2-build.log`。产物及日志不进入 Git。

## 实际门禁

按要求在 vbk/ 执行 typecheck、Node strip-types 全部 TS 测试、cargo workspace、cargo 宿主、bundle:ui、Tauri aarch64 build 与 diff 检查，均退出 0。TS323、核心Rust300、宿主63，失败/跳过/ignored均0。TS TAP 位于 `round2-ts.tap`；Rust完整输出保留在本轮工具执行记录。构建结果 app17.56MiB、DMG6.45MiB。

SDK块 `18c0ed3` 提交前另导出仅暂存内容的独立副本，typecheck、TS284、bundle通过。独立评审专项67/67并重放旧连接/销毁排队事件与SDK内部HTTP回退竞争，未见剩余可证P1/P2。此结论仅限该块代码及离线契约；媒体发送明确不支持，不能推广为全项目验收通过。

## 03:26账号恢复前观察

- 官方网页由 ego-browser 在既有 TaskSpace1/p1 操作：当前客服Meru，受控客户与订单两项均匹配；随后从实际订单侧栏 iframe 提取真实gid，与首轮一致。原始值只保存在 `round2-controlled-frame.json`，不以别名作为会话ID。
- 03:26新包显示无账号欢迎页。03:26:32再次读取原生截图仍未恢复账号；未点击添加账号或改变登录态。
- 进程采样 `round2-startup-sample.txt` 显示 `vbk-account-restore → login::restore → recover_credentials → KeychainStore::contains → SecKeychainFindGenericPassword` 等待。此前应用工具明确拒绝操作 SecurityAgent，因此请求用户处理本次新二进制钥匙串提示。首轮用户已处理的授权不等于系统对本轮新二进制已放行。
- 当时尚未新发送。首轮 C 保留unknown，禁止盲重发；W仍需跨端服务端消息ID核对。网页已核准不替代新包本轮客户/订单双核。

当时恢复计划：先核账号，再原生受控客户与订单双核；执行新包单次发送与官方读回、反向发送与原生实时读回，核对服务端ID/发送者/状态。继续媒体、引用撤回、历史及连接失败分支；已知官方桌面工具与助手认证阻塞见 BLOCKED.md。


## 用户解除提示后的受控实机（03:31–03:37）

用户回复本次钥匙串提示已处理。原生显示Meru、12个处理中会话及受控客户/正确订单。账号恢复后原生已有一条03:30:54短消息，本代理没有执行该次提交，因此不拿它作为本轮发送操作证据。

- 03:31:44：原生编辑器对受控目标单次Enter提交合成C；随即显示已确认。官方页面收到同正文、Meru、03:31:44、客户未读。官方stanza包含服务端ID；03:34:28点击原生“消息ID”，两端字符串逐字相等，见临时 `round2-C-id-comparison.json`。原生初始回显昵称为账号备注Meru，后续历史/资料补全为官方完整客服昵称，尚有身份资料展示时序差异。
- 03:35:27：官方页面单次提交合成W。此前两次ego语义点击被div拦截而未分发；核对编辑器仍有草稿且observer零W后，依据截图按钮坐标改用鼠标点击，成功清空编辑器并出现消息。官方显示Meru、客户未读。
- 03:35:31及03:36:08：原生仍无W，显示已连接。未点击重试或历史，没有自动到达证据。
- 03:36后：点击“加载更早消息”，W出现，正文/Meru/03:35:27对应并显示已确认；此时连接提示断开。03:36:59原生消息ID与官方stanza逐字相等，见 `round2-W-id-comparison.json`。因此可证明数据入库及历史可读，不能判实时到达通过，也不能将断线归因于该次历史请求。
- 新离线提示已实际显示“发送结果请核对，不会自动重发”。历史视频仍Invalid，来源在旧页读取后补全。未完成媒体、引用撤回、重连或客户侧已读验收。
- 官方只读stanza observer仅保留本轮合成标记，已移除。原始数据存于 `round2-official-stanzas.json`，不进Git。两次新消息均不重发，首轮C继续人工保留unknown。

独立恢复边界审计新发现：宿主实际发送链未接持久intent，RPC/显示缓存只在内存。同local_id在同一RPC中再调用保持一次SDK，重建RPC后显式重提变为两次；未观察自动重发。该P1与无ID unknown专用核验入口P2已列BLOCKED，下一轮优先修复。现有“消息ID”按钮只显示已知ID，不是未知发送reconciler。
