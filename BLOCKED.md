# 待验证项（2026-10-31）

## 第1轮新包实机状态（优先）
- 新包实际运行 PID33871，路径 src-tauri/target/aarch64-apple-darwin/release/bundle/macos，二进制SHA256 `6c5da79b2ffbdac5fbe8301277fef804eb300397f5777fed3613bd27693a811b`。
- 钥匙串阻塞已由用户在本机处理；账号恢复成功，原生显示Meru及12个处理中会话。未清登录态或修改钥匙串；CUA此前对SecurityAgent的安全拒绝保留为历史证据。
- 本轮网页与新包均核对受控客户/订单；真实iframe gid与先前一致。02:52:16操作者在新包仅提交一次合成测试标记C，随后网络不可用；02:53:02已转结果未知，刷新连接后仍保留unknown，未重发。官方刷新后历史无C，出站未确认。
- 官方02:55:05发送合成标记W，原生02:55:38加载旧页后已见同正文/发送者/时间，显示已确认；尚未跨端核验服务端ID，不能证明实时到达时延。旧页加载后订单来源/产品/日期/总额已补全；历史视频仍Invalid。完整双向、媒体、引用撤回、重连尚未通过。

## 本次任务 0 差异与有效阻塞
- 已核实SDK契约错配：sendMessageInSocket使用messageType/content/裸gid及成功失败回调；当前桥误用msgType/messageBody/完整roomJID且不传回调。已读回执也是回调式，await undefined不能视为服务端成功。第2轮优先修复，暂停新出站。
- 新包transport状态反复离线/在线，根因调查中；列表离线文案声称消息排队，但实际链路无自动队列，需修正。
- 成员实机不一致：native4条包含公司，官方详情3人仅Meru/客户/机器人；机器人原始key未翻译。官方源码已核实公司按rolesv2=[0,3,5]排除，不能按status4过滤，待修。
- 周边UI保守限制：unknown/accepted按账号认证代次+room+动作锁写；缺service session identity时，同room新服务会话不能靠只读刷新解锁。confirmed后允许明确新意图，后端同session+target去重。
- 第1轮静态/离线门禁TS242、核心300、宿主63已通过；构建已通过；新包实机/受控双向与媒体收发仍未通过。
- 未读伪清零离线修复已提交 c806ad7/ab0b751；页面+host缓存/实际diff独立评审通过，原生真实未读变更仍待验。
- 回执缺ID/不安全数字误confirmed已提交3a9dcda/263ad0b/2b4ee14，真实联合红绿通过；保留3a9dcda门禁误报更正记录。
- 新确认缺口：UI附件发送仍把附件名拼文本，不能算媒体出站；TSim助手认证仍失败；非空话术响应没有字段证据，必须unsupported，不能造话术。
- 助手本轮原生复核为 `timeoutReached`；旧客户端可原生读取，非所有应用工具失效。
- 本轮官方原生连接准确报错：NSCocoaErrorDomain Code=256，底层 NSOSStatusErrorDomain Code=-1712 `errAETimeout: the AppleEvent timed out`。桌面视觉验收暂停；网页与离线实现继续。
- 助手当前日志末态仍 attached=true / auth=failed / phase=failed / composerSource=verified-editor，错误“暂时无法连接 TSIM 服务，请检查网络后重试。”不能当作 TSim 登录成功。
- 当前已运行本轮新包；三端数据/显示对齐与受控双向尚未验收。
- 任务0时分支、HEAD、版本、hash 与基线一致；后续提交与产物见PROGRESS，已有未提交成果不覆盖。


- 官方桌面版原生连接超时：当前进程和签名可确认，尚未取得本轮官方桌面消息面板视觉证据。
- 原有自制插件缺载荷问题已由用户重新布置环境解决：安装器0.7.5、助手0.3.2，载荷及编辑器挂载有效。TSim认证日志最新失败，需重新核对，不可混称插件未安装。
- 真实收发、最新打包与最终独立评审仍在执行，未计为通过。
- 新app/dmg已经构建并实际启动，完整实机验收未通过。
- 历史未读伪清零已离线修复并提交；真实未读回执验收仍待完成。
