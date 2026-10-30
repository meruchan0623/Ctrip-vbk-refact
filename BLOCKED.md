# 待验证项（2026-10-31）

## 本次任务 0 差异与有效阻塞
- 周边UI保守限制：unknown/accepted按账号认证代次+room+动作锁写；缺service session identity时，同room新服务会话不能靠只读刷新解锁。confirmed后允许明确新意图，后端同session+target去重。
- 第1轮静态/离线门禁TS242、核心300、宿主63已通过；构建/新包实机/受控双向与媒体收发仍未通过。
- 未读伪清零离线修复已提交 c806ad7/ab0b751；页面+host缓存/实际diff独立评审通过，原生真实未读变更仍待验。
- 回执缺ID/不安全数字误confirmed已提交3a9dcda/263ad0b/2b4ee14，真实联合红绿通过；保留3a9dcda门禁误报更正记录。
- 新确认缺口：UI附件发送仍把附件名拼文本，不能算媒体出站；TSim助手认证仍失败；非空话术响应没有字段证据，必须unsupported，不能造话术。
- 助手本轮原生复核为 `timeoutReached`；旧客户端可原生读取，非所有应用工具失效。
- 本轮官方原生连接准确报错：NSCocoaErrorDomain Code=256，底层 NSOSStatusErrorDomain Code=-1712 `errAETimeout: the AppleEvent timed out`。桌面视觉验收暂停；网页与离线实现继续。
- 助手当前日志末态仍 attached=true / auth=failed / phase=failed / composerSource=verified-editor，错误“暂时无法连接 TSIM 服务，请检查网络后重试。”不能当作 TSim 登录成功。
- 当前运行依旧旧包，三端数据/显示对齐、受控双向收发与新包实机均未验收。
- 分支、HEAD、版本、hash 与基线一致，已有未提交成果不覆盖。


- 官方桌面版原生连接超时：当前进程和签名可确认，尚未取得本轮官方桌面消息面板视觉证据。
- 原有自制插件缺载荷问题已由用户重新布置环境解决：安装器0.7.5、助手0.3.2，载荷及编辑器挂载有效。TSim认证日志最新失败，需重新核对，不可混称插件未安装。
- 真实收发、最新打包与最终独立评审仍在执行，未计为通过。
- 新app/dmg已经构建，但尚未替换实际运行的旧app，未通过新包实机验收。
- 已确认代码缺陷：历史加载把会话未读数伪清零，并可能跳过已读回执。具体复现见最新环境重勘文档。
