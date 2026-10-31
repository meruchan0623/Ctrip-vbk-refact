# 服务端时钟锚点闭环（2026-10-31）

基线 864c54f8661c40fa5e1861a06b84cee3d0d4fcdf。此前 ClockService::anchor_from_server 在生产中无调用；SOA 的可选 onServerTime 未被 session 接入。因而在线、收消息与时钟 unanchored 可同时成立，不能把“服务器时间锚点失效”单独当作断流证据。

实现复用宿主发出的 adapter://request / adapter_reply(req_id) 绑定通道，新增内部操作 clock.sample，未开放新 Tauri 命令、ACL 或网页全局时钟设置接口。只有已发布身份的 acct-* 页面参与；现有 request/reply 再校验账号、环境、session_generation 及来源页面。一个宿主任务维护全部账号的登记，轮转固定只读 https://m.ctrip.com/restapi/soa2/11679/GetMyInfo.json，成功后等待60秒，失败5秒后重试；新登记/撤销会唤醒，全部无效或退出后任务结束。重复身份登记更新UUID而不创建并行计时任务；book→cores双锁内核当前账号，较旧generation的延迟登记不得覆盖新登记。

clock.sample 不接受请求指定的URL、时间或用户身份。它使用 SDK head，禁止HTTP重定向；仅接受HTTP/SOA成功、jid与捕获self UID相符且adapter生命周期未改变的响应，解析 ResponseStatus.Timestamp 的 /Date(ms+0800)/ 中毫秒部分。返回严格 {server_ms}，范围为2000-01-01（含）至2100-01-01（不含）的安全整数；不解析 Date 响应头，不使用客户端 Date.now 作为服务端值，不返回profile/消息/凭据。

宿主在请求前记录自身单调时钟，收到回包后记录自身wall/monotonic，RTT必须不超过15000ms；请求等待上限20秒，超过RTT限的成功也不形成锚点。回包必须仍属于相同完整账号代次及页面登记UUID；全局递增probe序号阻止旧请求覆盖较新可信锚点。账号校验与ClockService更新共用cores锁；独立book锁按book→cores顺序获取，调用start/stop的identity/logout接口已释放cores锁。退出、失效、重登清理沿adapter::on_account_removed撤登记；迟到旧代次不得删除新登记。无新消息发送、已读、工作状态写入或发送门禁变化。

核心时钟原有模型保持：接收时估计server+RTT/2，误差界RTT/2+50ms，锚点有效期30分钟、休眠/墙钟跳变降级。失败不制造可信时间；保留尚有效锚点直到既有失效规则触发。1Hz scheduler仍发布NET_CLOCK，通知及待核对逻辑沿原有ClockQuality读取。单独的时间校准不替代接收补偿/列表完整性证明。

合成验证：原session对clock.sample返回unknown-op的真实红；删除真实anchor调用后HostState检查真实红。还原后TS专项9、完整TS617、host172均通过，typecheck/bundle通过，无skip/ignored。首次host全量误复用故障注入旧二进制而红，已明确刷新还原源码mtime强制重编并取得171绿；独立评审发现的旧身份延迟登记覆盖新身份已新增真实红→绿，最终host172绿，不计前一次为通过。日志在%TEMP%/vbk-windows-20261031/r7-clock-*.log。本轮未做真实网络、真实登录态读取或桌面验收；安装包首次校准与持续运行由主代理后续验收。
