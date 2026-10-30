# 历史读取与未读计数

2026-10-31。未读来源是同一账号页面会话中的 `UnreadBook`，由 `getConversationInfoByGidList.conversationInfoList[].unreadCount` 更新。任何会话展示投影（列表、成员补全、历史补全）在 `createPageSession` 的 `pushDisplay` 出口使用该来源覆盖派生值；未获取过计数时保持输入值。

读取 `getMessageList` 只读取历史，不代表本客服发送了已读回执，更不代表客户已读。`im.mark_read` 通过官方 SDK 发送回执；SDK 返回成功也不在本地直接清零。服务端确认零值后正常传播。

最小脱敏序列：`unread=3 → im.messages → unread=3 → 相同值轮询 changed=[] → im.mark_read → unread=3 → 服务端 unread=0 → unread=0`。

回归文件：`vbk/ui/packages/web-adapter/src/history-unread.test.ts`。它使用真实页面 session、RPC、history 和 unread 逻辑，仅 SOA/SDK 传输由仓库已有 fake 模拟；验证历史确实返回消息、读取本身零回执、UI 的未读门槛仍会触发回执及服务端零值可更新。

本轮继承的未提交 `rpc.ts` 历史补全会重投影会话，缺少 unread lookup 时产生零值；修复前该测试实际失败 `0 !== 3`，修复后 1/1 通过。原始输出仅存本机 `/tmp/vbk-history-unread-red.tap`、`/tmp/vbk-history-unread-green.tap`，不将日志入 Git。此行为提交是统一出口的不变量防护，不包含继承的分页/身份/订单功能，亦不把离线回归等同于三端实机验收。
