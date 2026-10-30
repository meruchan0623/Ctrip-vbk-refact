# 接收链路只读诊断

2026-10-31。连续三轮官方发出的合成消息未在49秒观察窗内自动进入新客户端、加载历史后却能同ID读回。此模块用于定位断点，不将“已连接”当作入站健康，也不修饰既有失败结果。

## 调用边界

正常 `net_status` 仍只读缓存，不拉诊断。显式请求 `net_status {include_diagnostics:true, account}` 时，宿主校验账号及认证代次，向该账号已存在的页面桥发只读 `adapter.diagnostics`，限时2秒。它不请求上游HTTP、不创建连接、不读历史、不发送消息或已读，不重试unknown。页面不可用时返回固定availability，原网络状态不因诊断失败改写。

`UiNetStatus.diagnostics` 使用version=1、采样时间、availability和page/host两段。只有固定枚举、布尔、安全整数及null；拒绝额外字段与任意错误字符串。没有客服/客户/房间/订单/消息ID，没有正文、URL、凭据或散列关联值。计数在内存，按账号认证代次隔离，不作为服务端可靠水位。

## 如何判断断点

1. 固定同一账号和认证代次，显式取发送前快照；检查page.running、SDK绑定状态与listener_health。绑定verified仅表示监听器存在。
2. 在重新双核的受控会话单次发送合成消息，等待观察窗；不要加载历史或重连，以免改变入站路径。
3. 再取快照，对比SDK callbacks/messages/ignored，session received/ui_mapped/ui_dropped，display批次及resolved/rejected，host message_items/changed_messages/main_emit_attempts，以及UI接收/校验/账号过滤/入库计数。
4. SDK callbacks没有增长只证明这一监听入口没有看到帧，不能直接断言服务端未发；有帧但映射为ignore与无帧必须分开。display_resolved只证明宿主命令返回成功，main_emit_attempts只证明尝试发事件，不能替代UI或视觉到达。
5. 补偿循环单列running、normal/frequent/stopped、cursor_ms、各固定outcome计数和rows/mapped/dropped。connected不保证补偿仍在轮询；水位不包含消息ID，不用于重发决策。

任何前后run_generation或绑定代次变化都须另记，不能把跨重建计数差当丢帧数。显式刷新诊断只改变诊断视图，不修复连接，不自动发送。

主界面显式入口已接线；upserted表示写入已加载会话缓存，不表示该消息当前可见。资料专用patch也可能增加host changed_messages，但不增加message_items，因此这些计数不能简单相减认定漏消息。计数随PageSession/SDK对象存活累计，run_generation用于识别重启边界，并非保证每次start清零。

独立暂存副本typecheck与全TS391项通过；SDK/session真实入口故障回归、宿主边界及UI入口/完整schema/复制回归均有红→绿。独立评审发现诊断账号校验误写宿主focus的P2，已改纯验证；真实A/B均有效且focus=B的回归红→绿，诊断6/6复审通过。独立暂存宿主全量100项、bundle和diff检查通过，最终独立评审无该块未修P1/P2。另反向禁用真实UI账号过滤后新回归确实失败，恢复后全绿。原生诊断采样待第4轮。原始运行证据仍按本地临时目录管理；允许复制的固定schema不等于允许复制业务原文。
