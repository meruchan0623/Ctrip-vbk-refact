# 隐藏账号页的后台调度

2026-10-31。每个账号使用独立的隐藏WKWebView运行官方页面/SDK。第4轮发现接收计数长时间不前进，诊断RPC后补偿恢复，详见round4-runtime。此观察提示后台调度受限，尚不能认定唯一根因。

`profiles::open_profile_window`仅对带非空boot脚本的acct-*页面设置`BackgroundThrottlingPolicy::Disabled`，保持入站SDK、补偿与会话轮询运行。登录页及详情页保留系统默认策略；不更改凭据、数据隔离、导航或IPC权限。

本仓库锁定Tauri2.12.5/Wry0.57.1，本机macOS27.2。对应[官方API文档](https://docs.rs/tauri/2.12.5/tauri/webview/struct.WebviewWindowBuilder.html#method.background_throttling)说明macOS14+支持该策略，默认隐藏页面可暂停任务；Windows/Linux/Android不支持，不能宣称本改动跨平台解决接收。代价是保持已登录账号页面活动，可能增加后台资源消耗。

策略选择回归先保留系统默认None失败，再设置Disabled通过；同时检查详情、登录、无boot与空boot均不获得例外。它只验证策略选择和真实builder调用，不能代替实机自然接收。第5轮须不刷新诊断、不加载历史、不重连，观察官方受控消息是否自行进入，再读计数核对。
