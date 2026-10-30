# 第3轮新包运行记录

日期2026-10-31，Asia/Singapore。第3轮静态与构建门禁通过，整体实机验收未通过。原始证据目录 `/tmp/vbk-goal-20261031/`，包含客户资料的截图、AX、网络响应不进入Git。

## 源码、门禁、产物与运行

- 源码HEAD `5db15cc7f4cc5fb48e3a2525dafc418f607cc954` 加保留的未提交工作树；不能把HEAD单独当可复现发布。302文件manifest SHA256 `6cd2ac56dfd89b7e3a393e7270cf62ad1c9314ffc1f1e7233eff93a275181072`，文件 `round3-source-manifest.json`，构建后核对无变化。
- 依次执行 typecheck、Node strip-types全TS、cargo workspace、cargo host、bundle:ui、Tauri aarch64 macOS build及diff检查，均退出0。TS387 / 核心301 / 宿主95，0失败、skip、ignored。输出 `round3-ts.tap`、`round3-core.log`、`round3-host.log`、`round3-build.log`。
- 新app `vbk/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/VBooking 商家客户端.app`；旧PID48183已退出，新PID80117进程路径经ps对应上述app。
- 二进制 `Contents/MacOS/vbk-host` SHA256 `0e5a391588e81d60aeb9a425513df5b2aa8731c92f8b5c7c16be010f265f56c8`；18567136 bytes。产物与实际运行hash相同。
- DMG `vbk/src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/VBooking 商家客户端_0.1.0_aarch64.dmg`，SHA256 `1e43f751e3cefaa4809b479a79157c827f882a01c8b58d9ac631b7d64e6bf59a`；6863110 bytes。元数据 `round3-artifacts.json`。
- 04:53启动自动恢复Meru和12个会话；本次未再需要用户处理钥匙串提示。元数据探测优化在这一次启动有效，不表示所有未来签名/授权情形均免提示。

## 真实受控收发

网页沿用ego TaskSpace1/p1，原生用应用工具。两端重新核对用户指定客户和订单，再由真实订单iframe解析gid，匹配既有值；原值仅 `round3-controlled-frame.json`。所有出站只在此会话，其他会话没有发送；首轮unknown没有重发。

- 04:56:10原生Enter仅提交一次合成C，随即confirmed；官方消息行显示同正文、完整Meru客服姓名、时间及未读。官方只读getMessageList返回HTTP200；原生只读消息ID入口与API的字符串ID逐字一致，`round3-C-id-comparison.json`。不能由confirmed推断客户已读。
- 05:02:03官方仅点击一次发送合成W，编辑器清空、官方行显示成功。05:02:08、05:02:41、05:02:52原生均无W，状态仍已连接；这49秒期间无历史加载或重试。
- 05:05点击原生加载旧页后W出现，正文/客服/时间相同，confirmed；05:07只读消息ID与官方API字符串ID逐字一致，`round3-W-id-comparison.json`。因此历史可读，实时不通过。加载后同时看到网络不可用，不把时间相关当因果。
- 第三轮同项失败已达到换路线条件：下一轮先读SDK原始帧、映射、展示投递、宿主与UI的固定schema脱敏计数，再用单次受控消息测增量，停止无运行证据的猜测性修复。

## 头像、角色与历史媒体

- 账号、列表、标题、消息和侧卡均仍文字占位，接口头像显示未通过。代码检查发现main/index.html的meta CSP仍仅允许self/data图片、无media-src，无法被Tauri的较宽策略覆盖。
- ego p2在真实应用HTML中加载p1已成功显示的同一API头像，得到loaded=false与securitypolicyviolation img-src / https://dimg04.c-ctrip.com。原始 `round3-ego-resource-red.json`；没有将原始头像URL提交。修复和新包回验尚未完成。
- 原生历史视频显示Invalid；官方同资源用ego实测readyState4、error=null、duration0.8秒。资源策略冲突待修，不能归咎于源资源失效。
- 本人C/W靠右；历史Sara商户同事消息也靠右，客户订单卡靠左，原生截图 `round3-merchant-other.png`。这是已观察到的角色样本，不代表所有类型三端均已验。
- 05:10原生成员3条，与官方本人/客户/机器人3条一致；原生机器人仍显示国际化key，官方显示“游游机器人”。官方三人头像均loaded=true，原始DOM记录`round3-official-members-dom.json`；原生头像仍未通过。
- 加载旧页未跳到底部，但视口移至新增旧页顶部，尚未证明原消息锚点稳定；继续核验此细节。未完成媒体发送、引用撤回全流程、未知发送只读核验和可靠重连。

## 独立评审与边界

本轮前各代码块已分别独立评审和暂存副本验证。Sol/xhigh独立只读复核产物hash/大小、PID路径、manifest、门禁日志、双方ID、AX及角色截图通过；C比较文件native_id原为单元素数组，评审取唯一字符串再次与official_id逐字匹配。三端工具/认证阻塞及未实现项仍见BLOCKED，不能以离线全绿宣称目标完成。
