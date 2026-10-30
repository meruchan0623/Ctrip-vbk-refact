# 历史群聊地址与本地会话路由

官方群聊历史可能只有 `fromJid=room@domain/sender` 和 `toJid=self@domain`，没有 partner。此时房间在 fromJid，toJid是接收账号；客户昵称不参与ID解析。

HTTP事实与展示适配优先显式gid，其次partner，再取带resource的fromJid房间，最后才使用toJid。`roomJidFromMessage(gid,msg)`同时检查partner/toJid/fromJid，只接受local part严格等于既有gid的地址并移除resource；不把其它聊天室或客户别名作为发送目标。SDK facade最终如何使用裸gid见其独立契约，不能直接将完整roomJID作为facade toJid。

合成回归覆盖事实、展示、room查找三个实际调用边界，以及不同room/客户别名拒绝和显式gid优先。反向验证在独立快照恢复旧三处实现后必须失败；不访问网络或发送真实消息。
